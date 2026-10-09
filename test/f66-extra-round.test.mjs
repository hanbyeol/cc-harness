import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, REPO } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { HarnessError } from '../lib/errors.mjs';
import { readEvents } from '../lib/events.mjs';
import { runFeatures } from '../lib/run.mjs';
import { evaluate } from '../lib/eval.mjs';
import evalCommand from '../lib/commands/eval.mjs';
import approveCommand from '../lib/commands/approve.mjs';

const FAKE_CLI = path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs');

const SCRIPTS = {
  'scripts/ok.mjs': 'process.exit(0);\n',
  'scripts/fail.mjs': 'process.exit(3);\n',
};

function contract(version = 1, { approve = true } = {}) {
  const c = {
    id: 'F9', title: 'fixture feature', security_tier: 'standard', version,
    acceptance_criteria: [
      { id: 'AC-1', criterion: `one (v${version})`, check: 'node scripts/ok.mjs', new: false },
      { id: 'AC-2', criterion: 'two', check: 'node scripts/ok.mjs', new: false },
    ],
    security_criteria: [],
    error_scenarios: [],
    out_of_scope: [],
  };
  if (approve) c.approval = { by: 'test', at: '2026-09-23T00:00:00.000Z', hash: hashContract(c) };
  return c;
}
const HASH = hashContract(contract(1));

// Nothing here reaches a real model CLI.
const FAILING_CLI = {
  roles: { builder: 'claude', evaluator: 'generic', 'security-reviewer': 'generic' },
  adapters: { generic: { read_only_command: [process.execPath, FAKE_CLI, 'exit', '1'] } },
};

const verdict = (round, ids, { hash = HASH, contractRound = round } = {}) => ({
  feature: 'F9', round, verdict: 'fail', score: 3, verify_pass: true, origin: 'eval', contract_hash: hash, contract_round: contractRound,
  blocking: ids.map((id) => ({ criterion_id: id, summary: `${id} broken`, repro: 'node scripts/fail.mjs', exit: 3 })),
  backlogged: [],
});
// Three rounds of the current contract, the last one blocked with reason rounds.
const USED_UP = { 1: verdict(1, ['AC-1', 'AC-2', 'REGRESSION']), 2: verdict(2, ['AC-1', 'AC-2']), 3: verdict(3, ['AC-1']) };

function fixture({ status = 'blocked', verdicts = USED_UP, config = {}, c = contract(1), feature = {} } = {}) {
  const files = {};
  for (const [k, v] of Object.entries(verdicts)) files[`.harness/verdicts/F9-r${k}.json`] = v;
  const last = Math.max(0, ...Object.keys(verdicts).map(Number));
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...FAILING_CLI, ...config },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status, depends_on: [], ...(last ? { eval_round: last } : {}), ...feature }] },
    '.harness/contracts/F9.json': c,
    '.harness/backlog.json': { items: [] },
    ...files,
    ...SCRIPTS,
  });
}

const PASS_VERIFY = {
  pass: true, commands: [], warnings: [],
  integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } },
  criteria: [{ id: 'AC-1', pass: true }, { id: 'AC-2', pass: true }],
};

const scores = (o = {}) => ({ functionality: 9, quality: 9, security: 9, errors: 9, tests: 9, ...o });
const reply = (json) => ({ ok: true, error: null, text: JSON.stringify(json), json, costUsd: 0, exitCode: 0 });
const finding = (id) => ({ criterion_id: id, dimension: 'functionality', summary: `${id} broken`, repro: 'node scripts/fail.mjs' });
const passReply = () => reply({ scores: scores(), findings: [], out_of_scope: [] });
const failReply = (...ids) => reply({ scores: scores({ functionality: 3 }), findings: ids.map(finding), out_of_scope: [] });

function adapter(...replies) {
  const q = [...replies];
  const fn = async () => {
    fn.calls += 1;
    if (!q.length) throw new Error('unexpected adapter call');
    return q.shift();
  };
  fn.calls = 0;
  return fn;
}

async function evalCmd(dir, runAdapter, args = []) {
  const out = [];
  const err = [];
  try {
    const code = await evalCommand({
      root: dir, args: ['F9', ...args], out: (s) => out.push(s), err: (s) => err.push(s),
      deps: { runAdapter, verifyResult: PASS_VERIFY },
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  } catch (e) {
    if (!(e instanceof HarnessError)) throw e;
    return { code: e.exit, out: out.join('\n'), err: [...err, e.message].join('\n'), error: e };
  }
}

const approve = (dir, ...args) => harness(['approve', 'F9', '--by', 'test', ...args], { cwd: dir });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const featuresFile = (dir) => path.join(dir, '.harness', 'features.json');
const contractFile = (dir) => path.join(dir, '.harness', 'contracts', 'F9.json');
const vfile = (dir, k) => path.join(dir, '.harness', 'verdicts', `F9-r${k}.json`);
const feature = (dir) => readJson(featuresFile(dir)).features.find((f) => f.id === 'F9');
const verdictFiles = (dir) => {
  try { return fs.readdirSync(path.join(dir, '.harness', 'verdicts')).filter((n) => /^F9-r\d+\.json$/.test(n)).sort(); } catch { return []; }
};
const rescopeReasons = (dir) => readJson(path.join(dir, '.harness', 'backlog.json')).items.filter((i) => i.source === 'F9-blocked').map((i) => i.reason);

// ---------- AC-1 ----------
test('F66 AC-1 re-approving the unchanged contract of a feature blocked after max_rounds: exit 2, message, nothing written', () => {
  const dir = fixture();
  const featuresBefore = fs.readFileSync(featuresFile(dir));
  const contractBefore = fs.readFileSync(contractFile(dir));
  const r = approve(dir);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.ok(r.stderr.includes('F9 is blocked after max_rounds with this contract — change the contract, or pass --extra-round to allow one more round'), r.stderr);
  assert.ok(fs.readFileSync(featuresFile(dir)).equals(featuresBefore), 'features.json changed');
  assert.ok(fs.readFileSync(contractFile(dir)).equals(contractBefore), 'contract changed');
});

test('F66 AC-1 the same refusal when the approval was dropped but the content (hash) is unchanged', () => {
  const dir = fixture({ c: contract(1, { approve: false }) });
  const r = approve(dir);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /blocked after max_rounds with this contract/);
  assert.equal(feature(dir).status, 'blocked');
});

test('F66 AC-1 a feature blocked before max_rounds (at round 2) is re-approved as before', () => {
  const dir = fixture({ verdicts: { 1: USED_UP[1], 2: USED_UP[2] } });
  const r = approve(dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(feature(dir).status, 'approved');
});

// ---------- AC-2 ----------
test('F66 AC-2 --extra-round approves the feature, allows one more round, and a failing eval blocks it with rounds again', async () => {
  const dir = fixture();
  const ap = approve(dir, '--extra-round');
  assert.equal(ap.code, 0, ap.stdout + ap.stderr);
  assert.equal(feature(dir).status, 'approved');
  assert.deepEqual(feature(dir).extra_rounds, { hash: HASH, count: 1 });

  const ra = adapter(failReply('AC-1'));
  const r = await evalCmd(dir, ra);
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(ra.calls, 1);
  assert.ok(r.out.includes('contract round 4/3 (+1 extra round approved by a human)'), r.out);
  assert.equal(readJson(vfile(dir, 4)).contract_round, 4);
  assert.equal(feature(dir).status, 'blocked');
  assert.deepEqual(rescopeReasons(dir), ['rounds']);
});

test('F66 AC-2 the extra round blocks with rounds even when the blocking set did not shrink', async () => {
  const dir = fixture();
  assert.equal(approve(dir, '--extra-round').code, 0);
  const r = await evalCmd(dir, adapter(failReply('AC-2')));
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(feature(dir).status, 'blocked');
  assert.deepEqual(rescopeReasons(dir), ['rounds']);
});

test('F66 AC-2 a passing extra round records passed', async () => {
  const dir = fixture();
  assert.equal(approve(dir, '--extra-round').code, 0);
  const r = await evalCmd(dir, adapter(passReply()));
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(feature(dir).status, 'passed');
});

test('F66 AC-2 a second --extra-round after the extra round failed allows round 5', async () => {
  const dir = fixture();
  assert.equal(approve(dir, '--extra-round').code, 0);
  await evalCmd(dir, adapter(failReply('AC-1')));
  assert.equal(approve(dir).code, 2, 'plain re-approval is refused again');
  const ap = approve(dir, '--extra-round');
  assert.equal(ap.code, 0, ap.stdout + ap.stderr);
  assert.deepEqual(feature(dir).extra_rounds, { hash: HASH, count: 2 });
  const r = await evalCmd(dir, adapter(failReply('AC-1')));
  assert.ok(r.out.includes('contract round 5/3 (+2 extra rounds approved by a human)'), r.out);
  assert.equal(feature(dir).status, 'blocked');
});

test('F66 AC-2 harness run takes the extra round: one build and one evaluation, then blocked max_rounds', async () => {
  const files = {};
  for (const [k, v] of Object.entries(USED_UP)) files[`.harness/verdicts/F9-r${k}.json`] = v;
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [], extra_rounds: { hash: HASH, count: 1 } }] },
    '.harness/contracts/F9.json': contract(1),
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    ...files,
    ...SCRIPTS,
  }, { branch: null });
  let builds = 0;
  const r = await runFeatures({
    root: dir,
    deps: {
      build: async (a) => { builds += 1; writeFiles(a.cwd, { 'F9.txt': 'built\n' }); return { ok: true, costUsd: 0 }; },
      runAdapter: adapter(failReply('AC-1')),
      evaluate,
      verify: async () => PASS_VERIFY,
    },
    config: resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, max_rounds: 3 }),
  });
  assert.equal(builds, 1, JSON.stringify(r.results));
  assert.equal(r.results[0].status, 'blocked', JSON.stringify(r.results));
  assert.equal(r.results[0].reason, 'rounds', JSON.stringify(r.results));
  assert.equal(readJson(vfile(dir, 4)).contract_round, 4);
});

// ---------- AC-3 ----------
test('F66 AC-3 eval of a round past max_rounds (same contract re-approved) is refused before any adapter call, no verdict file', async () => {
  const dir = fixture({ status: 'approved' });
  const ra = adapter(passReply());
  const r = await evalCmd(dir, ra);
  assert.equal(r.code, 2, r.out + r.err);
  assert.equal(ra.calls, 0);
  assert.match(r.err, /round 4 exceeds the rounds allowed for this contract/);
  assert.deepEqual(verdictFiles(dir), ['F9-r1.json', 'F9-r2.json', 'F9-r3.json']);
  assert.equal(feature(dir).status, 'approved');
});

test('F66 AC-3 with one extra round allowed, round 5 is refused', async () => {
  const dir = fixture({
    status: 'approved', feature: { extra_rounds: { hash: HASH, count: 1 } },
    verdicts: { ...USED_UP, 4: verdict(4, ['AC-1']) },
  });
  const ra = adapter(passReply());
  const r = await evalCmd(dir, ra);
  assert.equal(r.code, 2, r.out + r.err);
  assert.equal(ra.calls, 0);
  assert.match(r.err, /round 5 exceeds the rounds allowed for this contract/);
  assert.equal(verdictFiles(dir).length, 4);
});

test('F66 AC-3 max_rounds from config counts: with max_rounds 4 round 4 is evaluated', async () => {
  const dir = fixture({ status: 'approved', config: { max_rounds: 4 } });
  const r = await evalCmd(dir, adapter(failReply('AC-1')));
  assert.equal(r.code, 1, r.out + r.err);
  assert.ok(fs.existsSync(vfile(dir, 4)));
});

// ---------- AC-4 ----------
test('F66 AC-4 --extra-round records a plan/decision event with decision extra_round and contract_round', () => {
  const dir = fixture();
  assert.equal(approve(dir, '--extra-round').code, 0);
  const events = readEvents(dir).events.filter((e) => e.stage === 'plan' && e.type === 'decision' && e.feature === 'F9');
  assert.equal(events.length, 1, JSON.stringify(events));
  assert.equal(events[0].data.decision, 'extra_round');
  assert.equal(events[0].data.contract_round, 4);
  const status = readEvents(dir).events.filter((e) => e.stage === 'plan' && e.type === 'status' && e.feature === 'F9');
  assert.deepEqual(status.map((e) => [e.data.from, e.data.to]), [['blocked', 'approved']]);
});

test('F66 AC-4 a changed contract starts again at round 1 of the new hash, without the extra round', async () => {
  const dir = fixture({ feature: { extra_rounds: { hash: HASH, count: 1 } }, verdicts: { ...USED_UP, 4: verdict(4, ['AC-1']) } });
  writeFiles(dir, { '.harness/contracts/F9.json': contract(2, { approve: false }) });
  const ap = approve(dir);
  assert.equal(ap.code, 0, ap.stdout + ap.stderr);
  const r = await evalCmd(dir, adapter(failReply('AC-1')));
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(readJson(vfile(dir, 5)).contract_round, 1);
  assert.match(r.out, /contract round 1\/3 \(this contract version; verdict r5\)/);
  assert.doesNotMatch(r.out, /extra round/);
  assert.match(r.out, /rounds left: 2\b/);
});

test('F66 AC-4 the old hash’s extra round does not carry: the new hash blocks at max_rounds', async () => {
  const h2 = hashContract(contract(2));
  const dir = fixture({
    c: contract(2), feature: { extra_rounds: { hash: HASH, count: 1 } },
    verdicts: { ...USED_UP, 4: verdict(4, ['AC-1', 'AC-2'], { hash: h2, contractRound: 1 }), 5: verdict(5, ['AC-1'], { hash: h2, contractRound: 2 }), 6: verdict(6, ['AC-1'], { hash: h2, contractRound: 3 }) },
  });
  const r = approve(dir);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /blocked after max_rounds with this contract/);
  const ap = approve(dir, '--extra-round');
  assert.equal(ap.code, 0, ap.stdout + ap.stderr);
  assert.deepEqual(feature(dir).extra_rounds, { hash: h2, count: 1 });
});

// ---------- AC-5 ----------
test('F66 AC-5 --extra-round on a feature that is not blocked: exit 2, nothing written', () => {
  const dir = fixture({ status: 'approved', verdicts: {} });
  const before = fs.readFileSync(featuresFile(dir));
  const r = approve(dir, '--extra-round');
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.ok(r.stderr.includes('F9 is not blocked after max_rounds'), r.stderr);
  assert.ok(fs.readFileSync(featuresFile(dir)).equals(before));
});

test('F66 AC-5 --extra-round on a feature blocked before max_rounds (at round 2): exit 2', () => {
  const dir = fixture({ verdicts: { 1: USED_UP[1], 2: USED_UP[2] } });
  const r = approve(dir, '--extra-round');
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.ok(r.stderr.includes('F9 is not blocked after max_rounds'), r.stderr);
  assert.equal(feature(dir).status, 'blocked');
});

test('F66 AC-5 --extra-round on a blocked feature whose contract changed: exit 2', () => {
  const dir = fixture();
  writeFiles(dir, { '.harness/contracts/F9.json': contract(2, { approve: false }) });
  const r = approve(dir, '--extra-round');
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.ok(r.stderr.includes('F9 is not blocked after max_rounds'), r.stderr);
});

// ---------- AC-6 ----------
test('F66 AC-6 SPEC §7.6 and README describe the same-hash re-approval rule and --extra-round', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s76 = spec.slice(spec.indexOf('6. **대화형 eval 의 상태 기록**'), spec.indexOf('7. **backlog 정리 루프**'));
  assert.ok(s76.length > 0);
  assert.match(s76, /--extra-round/);
  assert.match(s76, /같은 해시/);
  assert.match(s76, /is blocked after max_rounds with this contract/);
  assert.match(s76, /exceeds the rounds allowed for this contract/);
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  assert.match(readme, /harness approve F\S* --extra-round/);
  assert.match(readme, /같은 계약/);
});

// ---------- ES-1 ----------
test('F66 ES-1 features.json write failure on --extra-round: exit 2, status stays blocked, no decision event', async () => {
  const dir = fixture();
  const out = [];
  const err = [];
  const failingSave = () => { throw new HarnessError('features.json: write failed (ENOSPC); previous content kept', { code: 'io' }); };
  await assert.rejects(
    approveCommand({ root: dir, args: ['F9', '--by', 'test', '--extra-round'], out: (s) => out.push(s), err: (s) => err.push(s), deps: { saveFeatures: failingSave } }),
    // The refusal is the write failure, not an unknown option.
    (e) => e instanceof HarnessError && e.exit === 2 && e.code === 'io' && /write failed/.test(e.message),
  );
  assert.equal(feature(dir).status, 'blocked');
  assert.equal(feature(dir).extra_rounds, undefined);
  let events = [];
  try { events = readEvents(dir).events; } catch { /* no events */ }
  assert.deepEqual(events.filter((e) => e.type === 'decision'), []);
  const r = await evalCmd(dir, adapter(passReply()));
  assert.equal(r.code, 2, 'still blocked: nothing evaluated');
});
