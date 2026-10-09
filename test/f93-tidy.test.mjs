import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, REPO } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { runFeatures } from '../lib/run.mjs';
import { exportLine } from '../lib/telemetry.mjs';
import * as util from '../lib/util.mjs';

// ------------------------------------------------------------------ fixtures

const SCRIPTS = {
  'scripts/ok.mjs': 'process.exit(0);\n',
  'scripts/fail.mjs': 'process.exit(3);\n',
};

function contract() {
  const c = {
    id: 'F9', title: 'fixture feature', security_tier: 'standard', version: 1,
    acceptance_criteria: [
      { id: 'AC-1', criterion: 'one', check: 'node scripts/ok.mjs', new: false },
      { id: 'AC-2', criterion: 'two', check: 'node scripts/ok.mjs', new: false },
    ],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-09T00:00:00.000Z', hash: hashContract(c) };
  return c;
}
const HASH = hashContract(contract());

const failVerdict = (round, ids) => ({
  feature: 'F9', round, verdict: 'fail', score: 3, verify_pass: true, origin: 'eval', contract_hash: HASH, contract_round: round,
  blocking: ids.map((id) => ({ criterion_id: id, summary: `${id} broken`, repro: 'node scripts/fail.mjs', exit: 3 })),
  backlogged: [],
});
const USED_UP = { 1: failVerdict(1, ['AC-1', 'AC-2']), 2: failVerdict(2, ['AC-1']), 3: failVerdict(3, ['AC-1']) };

function fixture({ status = 'approved', verdicts = {}, feature = {} } = {}) {
  const files = {};
  for (const [k, v] of Object.entries(verdicts)) files[`.harness/verdicts/F9-r${k}.json`] = v;
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status, depends_on: [], ...feature }] },
    '.harness/contracts/F9.json': contract(),
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    ...files,
    ...SCRIPTS,
  }, { branch: null });
}

const PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const build = async (a) => { writeFiles(a.cwd, { 'F9.txt': `built r${a.round}\n` }); return { ok: true, costUsd: 0 }; };
const finding = (id) => ({ criterion_id: id, dimension: 'functionality', summary: `${id} broken`, repro: 'node scripts/fail.mjs' });
// Scripted evaluator: one verdict per call — 'needs-human' or [blocking ids] (fail).
function evaluateAs(script) {
  let n = 0;
  return async (a) => {
    const s = script[n++];
    const base = { feature: a.featureId, round: a.round, score: 8, scores: {}, backlogged: [], independence: 'cross-model', costUsd: 0, file: null };
    return Array.isArray(s) ? { ...base, verdict: 'fail', score: 4, blocking: s.map(finding) } : { ...base, verdict: s, blocking: [] };
  };
}
const run = (dir, evaluate) => runFeatures({
  root: dir,
  config: resolveConfig({ base_branch: 'main', run: { max_parallel: 1 }, verify: { commands: [] }, budget: { step_timeout_sec: 60 } }),
  deps: { build, verify: async () => PASSING, evaluate },
});

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const feature = (dir) => readJson(path.join(dir, '.harness', 'features.json')).features.find((f) => f.id === 'F9');
const statusEvents = (dir) => {
  const d = path.join(dir, '.harness', 'events');
  const names = fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith('.jsonl')).sort() : [];
  return names.flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    .filter((e) => e.type === 'status');
};
const reportRow = (r) => fs.readFileSync(r.report, 'utf8').split('\n').find((l) => l.startsWith('| F9 '));

function assertBlocked(dir, r, reason) {
  assert.deepEqual([r.results[0].status, r.results[0].reason], ['blocked', reason], JSON.stringify(r.results));
  assert.equal(feature(dir).blocked_reason, reason);
  const blocked = statusEvents(dir).filter((e) => e.data.to === 'blocked');
  assert.equal(blocked.length, 1, JSON.stringify(blocked));
  assert.equal(blocked[0].data.reason, reason);
  const row = reportRow(r);
  assert.ok(row, 'report row for F9');
  assert.ok(row.includes(`| ${reason}: `), row);
  assert.doesNotMatch(row, /max_rounds|needs-human/);
}

// ------------------------------------------------------------------ AC-1

test('F93 AC-1 run: the round limit blocks with reason rounds (features.json, status event, report)', async () => {
  const dir = fixture();
  const r = await run(dir, evaluateAs([['AC-1', 'AC-2', 'SC-1'], ['AC-1', 'AC-2'], ['AC-1']]));
  assertBlocked(dir, r, 'rounds');
});

test('F93 AC-1 run: rounds of the contract already used before the run block with reason rounds', async () => {
  const dir = fixture({ status: 'in_progress', verdicts: USED_UP });
  const r = await run(dir, evaluateAs([]));
  assertBlocked(dir, r, 'rounds');
});

test('F93 AC-1 run: a needs-human verdict blocks with reason needs_human (features.json, status event, report)', async () => {
  const dir = fixture();
  const r = await run(dir, evaluateAs(['needs-human']));
  assertBlocked(dir, r, 'needs_human');
});

// ------------------------------------------------------------------ AC-2

const approve = (dir, ...extra) => harness(['approve', 'F9', '--by', 'test', ...extra], { cwd: dir });

for (const reason of ['rounds', 'max_rounds']) {
  test(`F93 AC-2 blocked_reason ${reason} with the rounds of the same hash used: approve refuses (rounds_exhausted)`, () => {
    const dir = fixture({ status: 'blocked', verdicts: USED_UP, feature: { blocked_reason: reason, eval_round: 3 } });
    const r = approve(dir);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /blocked after max_rounds with this contract/);
    assert.equal(feature(dir).status, 'blocked');
  });
}

for (const reason of ['needs_human', 'needs-human']) {
  test(`F93 AC-2 blocked_reason ${reason} with the rounds of the same hash used: approve re-approves`, () => {
    const dir = fixture({ status: 'blocked', verdicts: USED_UP, feature: { blocked_reason: reason, eval_round: 3 } });
    const r = approve(dir);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(feature(dir).status, 'approved');
  });
}

for (const reason of ['rounds', 'max_rounds', 'needs_human', 'needs-human']) {
  test(`F93 AC-2 harness status shows blocked (${reason})`, () => {
    const dir = fixture({ status: 'blocked', feature: { blocked_reason: reason } });
    const r = harness(['status'], { cwd: dir });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.split('\n').some((l) => /^\s*F9\s+blocked \(/.test(l) && l.includes(`blocked (${reason}) fixture`)), r.stdout);
  });
}

// ------------------------------------------------------------------ AC-3

const DEFINITIONS = ['const isObj =', 'const isObject =', 'const isPlainObject =', 'const sha16 =', 'function median', 'const escapeRe ='];

function libFiles(dir = path.join(REPO, 'lib')) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? libFiles(p) : e.name.endsWith('.mjs') ? [p] : [];
  });
}

test('F93 AC-3 lib/util.mjs exports isObj, sha16, median and escapeRe', () => {
  for (const name of ['isObj', 'sha16', 'median', 'escapeRe']) assert.equal(typeof util[name], 'function', name);
});

test('F93 AC-3 the helper definitions appear in lib/util.mjs only', () => {
  const utilFile = path.join(REPO, 'lib', 'util.mjs');
  const found = [];
  for (const f of libFiles()) {
    const src = fs.readFileSync(f, 'utf8');
    for (const d of DEFINITIONS) if (src.includes(d) && f !== utilFile) found.push(`${path.relative(REPO, f)}: ${d}`);
  }
  assert.deepEqual(found, []);
  const src = fs.readFileSync(utilFile, 'utf8');
  for (const d of ['const isObj =', 'const sha16 =', 'function median', 'const escapeRe =']) assert.ok(src.includes(d), d);
});

// ------------------------------------------------------------------ AC-4

test('F93 AC-4 isObj: true for a plain object only', () => {
  assert.equal(util.isObj(null), false);
  assert.equal(util.isObj([]), false);
  assert.equal(util.isObj({}), true);
  assert.equal(util.isObj('x'), false);
});

test('F93 AC-4 sha16: the first 16 hex characters of sha256', () => {
  assert.equal(util.sha16('abc'), 'ba7816bf8f01cfea');
  assert.match(util.sha16('abc'), /^[0-9a-f]{16}$/);
});

test('F93 AC-4 median: null when empty, the middle value, or the mean of the two middle values', () => {
  assert.equal(util.median([]), null);
  assert.equal(util.median([1]), 1);
  assert.equal(util.median([1, 2]), 1.5);
  assert.equal(util.median([3, 1, 2]), 2);
});

test('F93 AC-4 escapeRe: regular-expression metacharacters are escaped', () => {
  assert.equal(util.escapeRe('a.b*c'), 'a\\.b\\*c');
  assert.ok(new RegExp(`^${util.escapeRe('a.b*c')}$`).test('a.b*c'));
  assert.equal(new RegExp(`^${util.escapeRe('a.b*c')}$`).test('axbbc'), false);
});

// ------------------------------------------------------------------ AC-6

test('F93 AC-6 docs/SPEC.md: run and eval write rounds and needs_human; the earlier spellings are only read', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  for (const old of ['run 의 `max_rounds`', '`blocked`(`max_rounds`)', 'blocked(needs-human)', '`blocked`(`needs-human`)', '마지막 fail 은 `max_rounds`']) {
    assert.equal(spec.includes(old), false, old);
  }
  const para = spec.split('\n').find((l) => l.includes('**blocked 사유와 재승인**'));
  assert.ok(para, 'the blocked reason paragraph');
  assert.match(para, /`run`·`eval` 모두/);
  assert.match(para, /이전 철자 `max_rounds`·`needs-human`/);
  assert.match(para, /읽기만/);
});

// ------------------------------------------------------------------ ES-1

for (const reason of ['max_rounds', 'needs-human', 'rounds', 'needs_human']) {
  test(`F93 ES-1 telemetry export keeps a status event with reason ${reason}`, () => {
    const line = exportLine(
      { ts: '2026-10-01T00:00:00.000Z', stage: 'eval', type: 'status', data: { from: 'in_progress', to: 'blocked', reason } },
      { project: '0123456789abcdef', profiles: ['sdlc'] },
    );
    assert.equal(line.data.reason, reason, JSON.stringify(line));
  });
}
