import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { verify } from '../lib/verify.mjs';
import { hashContract } from '../lib/contract.mjs';

// F171: the .harness integrity check allows only the changes the core writes to the entry of the
// feature under verify in features.json (SPEC §6.2); everything else stays protected.

const contract = {
  id: 'F9', title: 'fixture', security_tier: 'standard', version: 1,
  acceptance_criteria: [{ id: 'AC-1', criterion: 'check exists', check: 'node check.mjs', new: true }],
  security_criteria: [], error_scenarios: [], out_of_scope: [],
};
const HASH = hashContract(contract);
const entry = (extra = {}) => ({ id: 'F9', title: 'fixture', security_tier: 'standard', status: 'approved', depends_on: [], ...extra });
const FEATURES = { features: [entry(), { id: 'F8', title: 'other', status: 'todo', depends_on: [] }] };

function fixture(features = FEATURES) {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': features,
    '.harness/contracts/F9.json': contract,
  });
  writeFiles(dir, { 'check.mjs': 'process.exit(0);\n' });
  return dir;
}
const cfg = () => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 30 } });
const run = (root) => verify({ root, featureId: 'F9', base: 'main', config: cfg() });
// features.json with F9's entry replaced by entry(extra) (undefined values drop the key) and verdict r1..rk written.
const withEntry = (e, rest = {}) => ({ ...rest, features: [e, FEATURES.features[1]] });
const write = (root, features, verdicts = [1]) => {
  writeFiles(root, { '.harness/features.json': features });
  for (const k of verdicts) writeFiles(root, { [`.harness/verdicts/F9-r${k}.json`]: { verdict: 'fail', round: k } });
};
const changed = async (root) => (await run(root)).integrity.harnessPaths;

test('F171 AC-1: status in_progress and eval_round = highest verdict round pass integrity', async () => {
  const root = fixture();
  write(root, withEntry(entry({ status: 'in_progress', eval_round: 2 })), [1, 2]);
  const r = await run(root);
  assert.deepEqual(r.integrity.harnessPaths, []);
  assert.equal(r.pass, true, JSON.stringify(r, null, 2));
});

test('F171 AC-1: status approved with eval_round set passes; the base may already have eval_round', async () => {
  const root = fixture(withEntry(entry({ status: 'in_progress', eval_round: 1 })));
  write(root, withEntry(entry({ status: 'approved', eval_round: 2 })), [1, 2]);
  assert.deepEqual(await changed(root), []);
});

test('F171 AC-2: blocked_reason removed and extra_rounds {hash, count} pass', async () => {
  const root = fixture(withEntry(entry({ status: 'blocked', blocked_reason: 'rounds exhausted', eval_round: 3 })));
  write(root, withEntry(entry({ status: 'in_progress', eval_round: 4, extra_rounds: { hash: HASH, count: 1 } })), [1, 2, 3, 4]);
  assert.deepEqual(await changed(root), []);
});

test('F171 AC-3: round 2 verify passes after round 1 eval recorded fail (uncommitted and committed)', async () => {
  for (const commit of [false, true]) {
    const root = fixture();
    write(root, withEntry(entry({ status: 'in_progress', eval_round: 1 })), [1]);
    if (commit) commitAll(root, 'record round 1');
    const r = await run(root);
    assert.deepEqual(r.integrity.harnessPaths, [], `commit=${commit}`);
    assert.equal(r.pass, true, JSON.stringify(r, null, 2));
  }
});

test('F171 AC-4: SPEC §6.2 describes the allowed core field changes', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs/SPEC.md'), 'utf8');
  const at = spec.indexOf('### 6.2');
  const sec = spec.slice(at, spec.indexOf('### 6.3', at));
  assert.match(sec, /F171/);
  for (const w of ['status', 'in_progress', 'eval_round', 'blocked_reason', 'extra_rounds', 'hashContract']) assert.ok(sec.includes(w), w);
});

test('F171 SC-1: status passed, blocked, todo or skipped fails and features.json is listed', async () => {
  for (const status of ['passed', 'blocked', 'todo', 'skipped']) {
    const root = fixture();
    write(root, withEntry(entry({ status, eval_round: 1 })), [1]);
    assert.deepEqual(await changed(root), ['.harness/features.json'], status);
  }
});

test('F171 SC-2: other entries, id/title/security_tier/depends_on, added/removed entries, other top-level keys fail', async () => {
  const f8 = FEATURES.features[1];
  const ok = entry({ status: 'in_progress', eval_round: 1 });
  const cases = {
    'other feature status': { features: [ok, { ...f8, status: 'passed' }] },
    'other feature title': { features: [ok, { ...f8, title: 'x' }] },
    id: { features: [{ ...ok, id: 'F10' }, f8] },
    title: { features: [{ ...ok, title: 'changed' }, f8] },
    security_tier: { features: [{ ...ok, security_tier: 'critical' }, f8] },
    depends_on: { features: [{ ...ok, depends_on: ['F8'] }, f8] },
    'extra key': { features: [{ ...ok, note: 'x' }, f8] },
    added: { features: [ok, f8, { id: 'F7', title: 't', status: 'todo', depends_on: [] }] },
    removed: { features: [ok] },
    'top-level key': { version: 2, features: [ok, f8] },
  };
  for (const [name, features] of Object.entries(cases)) {
    const root = fixture();
    write(root, features, [1]);
    assert.deepEqual(await changed(root), ['.harness/features.json'], name);
  }
});

test('F171 SC-3: eval_round, extra_rounds hash and count conditions', async () => {
  const bad = {
    'eval_round below highest': [entry({ status: 'in_progress', eval_round: 1 }), [1, 2]],
    'eval_round above highest': [entry({ status: 'in_progress', eval_round: 3 }), [1, 2]],
    'eval_round without verdict': [entry({ status: 'in_progress', eval_round: 1 }), []],
    'eval_round string': [entry({ status: 'in_progress', eval_round: '1' }), [1]],
    'hash differs': [entry({ status: 'in_progress', eval_round: 1, extra_rounds: { hash: 'abc', count: 1 } }), [1]],
    'count 0': [entry({ status: 'in_progress', eval_round: 1, extra_rounds: { hash: HASH, count: 0 } }), [1]],
    'count fraction': [entry({ status: 'in_progress', eval_round: 1, extra_rounds: { hash: HASH, count: 1.5 } }), [1]],
    'count string': [entry({ status: 'in_progress', eval_round: 1, extra_rounds: { hash: HASH, count: '1' } }), [1]],
    'extra key': [entry({ status: 'in_progress', eval_round: 1, extra_rounds: { hash: HASH, count: 1, more: 1 } }), [1]],
    'blocked_reason added': [entry({ status: 'in_progress', eval_round: 1, blocked_reason: 'x' }), [1]],
  };
  for (const [name, [e, verdicts]] of Object.entries(bad)) {
    const root = fixture();
    write(root, withEntry(e), verdicts);
    assert.deepEqual(await changed(root), ['.harness/features.json'], name);
  }
});

test('F171 SC-4: unparsable or malformed features.json (head or merge-base) and other .harness paths fail', async () => {
  const ok = entry({ status: 'in_progress', eval_round: 1 });
  let root = fixture();
  write(root, withEntry(ok), [1]);
  fs.writeFileSync(path.join(root, '.harness/features.json'), '{ not json');
  assert.deepEqual(await changed(root), ['.harness/features.json'], 'head not JSON');

  root = fixture();
  write(root, { features: 'x' }, [1]);
  assert.deepEqual(await changed(root), ['.harness/features.json'], 'head without features array');

  root = fixture();
  fs.rmSync(path.join(root, '.harness/features.json'));
  assert.deepEqual(await changed(root), ['.harness/features.json'], 'head missing');

  for (const [name, base] of [['base not JSON', '{ nope'], ['base without features', { other: 1 }]]) {
    root = fixture(base);
    write(root, withEntry(ok), [1]);
    assert.deepEqual(await changed(root), ['.harness/features.json'], name);
  }

  root = fixture();
  write(root, withEntry(ok), [1]);
  writeFiles(root, { '.harness/contracts/F9.json': { ...contract, title: 'edited' } });
  assert.deepEqual((await changed(root)).sort(), ['.harness/contracts/F9.json', '.harness/features.json']);

  root = fixture();
  writeFiles(root, { '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, x: 1 } });
  assert.deepEqual(await changed(root), ['.harness/config.json']);
});
