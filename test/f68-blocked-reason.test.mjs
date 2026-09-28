import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, REPO } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { HarnessError } from '../lib/errors.mjs';
import { runFeatures } from '../lib/run.mjs';
import { evaluate } from '../lib/eval.mjs';
import evalCommand from '../lib/commands/eval.mjs';

const FAKE_CLI = path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs');

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
    security_criteria: [],
    error_scenarios: [],
    out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-23T00:00:00.000Z', hash: hashContract(c) };
  return c;
}
const HASH = hashContract(contract());

// Nothing here reaches a real model CLI.
const FAILING_CLI = {
  roles: { builder: 'claude', evaluator: 'generic', 'security-reviewer': 'generic' },
  adapters: { generic: { read_only_command: [process.execPath, FAKE_CLI, 'exit', '1'] } },
};

const failVerdict = (round, ids) => ({
  feature: 'F9', round, verdict: 'fail', score: 3, verify_pass: true, origin: 'eval', contract_hash: HASH, contract_round: round,
  blocking: ids.map((id) => ({ criterion_id: id, summary: `${id} broken`, repro: 'node scripts/fail.mjs', exit: 3 })),
  backlogged: [],
});
const needsHumanVerdict = (round) => ({
  feature: 'F9', round, verdict: 'needs-human', score: 2, verify_pass: true, origin: 'eval', contract_hash: HASH, contract_round: round,
  blocking: [], backlogged: [],
});
// B411: fail, fail, needs-human — three verdicts of the same contract hash.
const B411 = { 1: failVerdict(1, ['AC-1', 'AC-2']), 2: failVerdict(2, ['AC-1']), 3: needsHumanVerdict(3) };
const USED_UP = { 1: failVerdict(1, ['AC-1', 'AC-2']), 2: failVerdict(2, ['AC-1']), 3: failVerdict(3, ['AC-1']) };

function fixture({ status = 'blocked', verdicts = {}, feature = {} } = {}) {
  const files = {};
  for (const [k, v] of Object.entries(verdicts)) files[`.harness/verdicts/F9-r${k}.json`] = v;
  const last = Math.max(0, ...Object.keys(verdicts).map(Number));
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...FAILING_CLI },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status, depends_on: [], ...(last ? { eval_round: last } : {}), ...feature }] },
    '.harness/contracts/F9.json': contract(),
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
const lowReply = () => reply({ scores: scores({ quality: 2 }), findings: [], out_of_scope: [] });

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

async function evalCmd(dir, runAdapter) {
  const out = [];
  const err = [];
  try {
    const code = await evalCommand({
      root: dir, args: ['F9'], out: (s) => out.push(s), err: (s) => err.push(s),
      deps: { runAdapter, verifyResult: PASS_VERIFY },
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  } catch (e) {
    if (!(e instanceof HarnessError)) throw e;
    return { code: e.exit, out: out.join('\n'), err: [...err, e.message].join('\n') };
  }
}

const approve = (dir, ...args) => harness(['approve', 'F9', '--by', 'test', ...args], { cwd: dir });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const featuresFile = (dir) => path.join(dir, '.harness', 'features.json');
const contractFile = (dir) => path.join(dir, '.harness', 'contracts', 'F9.json');
const feature = (dir) => readJson(featuresFile(dir)).features.find((f) => f.id === 'F9');

// ---------- AC-1 ----------
test('F68 AC-1 eval: a needs-human verdict records blocked_reason needs_human; re-approval clears it', async () => {
  const dir = fixture({ status: 'approved' });
  const r = await evalCmd(dir, adapter(lowReply(), lowReply()));
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(feature(dir).status, 'blocked');
  assert.equal(feature(dir).blocked_reason, 'needs_human');
  const ap = approve(dir);
  assert.equal(ap.code, 0, ap.stdout + ap.stderr);
  assert.equal(feature(dir).status, 'approved');
  assert.equal('blocked_reason' in feature(dir), false, JSON.stringify(feature(dir)));
});

test('F68 AC-1 eval: the last allowed round failing records blocked_reason rounds; --extra-round clears it', async () => {
  // Round 3 shrinks the blocking set (converges), so only the round limit blocks it.
  const dir = fixture({ status: 'in_progress', verdicts: { 1: failVerdict(1, ['AC-1', 'AC-2', 'REGRESSION']), 2: failVerdict(2, ['AC-1', 'AC-2']) } });
  const r = await evalCmd(dir, adapter(failReply('AC-1')));
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(feature(dir).status, 'blocked');
  assert.equal(feature(dir).blocked_reason, 'rounds');
  const ap = approve(dir, '--extra-round');
  assert.equal(ap.code, 0, ap.stdout + ap.stderr);
  assert.equal('blocked_reason' in feature(dir), false, JSON.stringify(feature(dir)));
});

test('F68 AC-1 eval: a pass after a stale blocked_reason leaves no blocked_reason', async () => {
  const dir = fixture({ status: 'approved', feature: { blocked_reason: 'needs_human' } });
  const r = await evalCmd(dir, adapter(passReply()));
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(feature(dir).status, 'passed');
  assert.equal('blocked_reason' in feature(dir), false);
});

test('F68 AC-1 run: a step reaching budget.step_usd records blocked_reason budget', async () => {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': contract(),
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    ...SCRIPTS,
  }, { branch: null });
  const r = await runFeatures({
    root: dir,
    deps: {
      build: async (a) => { writeFiles(a.cwd, { 'F9.txt': 'built\n' }); return { ok: true, costUsd: 2 }; },
      runAdapter: adapter(),
      evaluate,
      verify: async () => PASS_VERIFY,
    },
    config: resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60, step_usd: 1 }, max_rounds: 3 }),
  });
  assert.equal(r.results[0].status, 'blocked', JSON.stringify(r.results));
  assert.equal(r.results[0].reason, 'budget', JSON.stringify(r.results));
  assert.equal(feature(dir).status, 'blocked');
  assert.equal(feature(dir).blocked_reason, 'budget');
});

// ---------- AC-2 ----------
test('F68 AC-2 B411: fail, fail, needs-human on the same hash — blocked needs_human is re-approved (exit 0)', () => {
  const dir = fixture({ verdicts: B411, feature: { blocked_reason: 'needs_human' } });
  const r = approve(dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(feature(dir).status, 'approved');
  assert.equal('blocked_reason' in feature(dir), false);
});

for (const reason of ['needs_human', 'needs-human', 'eval_error', 'budget', 'merge_conflict', 'post_merge_verify', 'worktree', 'adapter_unavailable', 'verify_error', 'run_stopped', 'dependency_blocked']) {
  test(`F68 AC-2 blocked_reason ${reason} with max_rounds verdicts of the same hash: approve exits 0`, () => {
    const dir = fixture({ verdicts: USED_UP, feature: { blocked_reason: reason } });
    const r = approve(dir);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(feature(dir).status, 'approved');
    assert.equal('blocked_reason' in feature(dir), false);
  });
}

// ---------- AC-3 ----------
for (const reason of ['rounds', 'stall', 'divergence', 'max_rounds']) {
  test(`F68 AC-3 blocked_reason ${reason} with max_rounds verdicts of the same hash: refused (rounds_exhausted), --extra-round adds one`, () => {
    const dir = fixture({ verdicts: USED_UP, feature: { blocked_reason: reason } });
    const before = fs.readFileSync(featuresFile(dir));
    const contractBefore = fs.readFileSync(contractFile(dir));
    const r = approve(dir);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /blocked after max_rounds with this contract/);
    assert.ok(fs.readFileSync(featuresFile(dir)).equals(before), 'features.json changed');
    assert.ok(fs.readFileSync(contractFile(dir)).equals(contractBefore), 'contract changed');
    const ap = approve(dir, '--extra-round');
    assert.equal(ap.code, 0, ap.stdout + ap.stderr);
    assert.deepEqual(feature(dir).extra_rounds, { hash: HASH, count: 1 });
    assert.equal(feature(dir).status, 'approved');
  });
}

// ---------- AC-4 ----------
test('F68 AC-4 a blocked feature without blocked_reason and max_rounds verdicts: refused as before', () => {
  const dir = fixture({ verdicts: B411 });
  const r = approve(dir);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /blocked after max_rounds with this contract/);
  assert.equal(feature(dir).status, 'blocked');
});

test('F68 AC-4 a blocked feature without blocked_reason before max_rounds: re-approved as before', () => {
  const dir = fixture({ verdicts: { 1: USED_UP[1], 2: USED_UP[2] } });
  const r = approve(dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(feature(dir).status, 'approved');
});

// ---------- AC-5 ----------
test('F68 AC-5 harness status shows the blocked reason in parentheses', () => {
  const dir = fixture({ feature: { blocked_reason: 'needs_human' } });
  const r = harness(['status'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /F9\s+blocked \(needs_human\) fixture/);
});

test('F68 AC-5 a blocked feature without a reason and other statuses print as before', () => {
  const dir = fixture();
  const r = harness(['status'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /F9\s+blocked\s+fixture/);
  assert.doesNotMatch(r.stdout, /blocked \(/);
});

test('F68 AC-5 SPEC §7.6 describes the re-approval rule by blocked reason', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s76 = spec.slice(spec.indexOf('6. **대화형 eval 의 상태 기록**'), spec.indexOf('7. **backlog 정리 루프**'));
  assert.ok(s76.length > 0);
  assert.match(s76, /blocked_reason/);
  for (const r of ['rounds', 'stall', 'divergence', 'needs_human', 'eval_error', 'budget', 'merge_conflict', 'post_merge_verify', 'worktree', 'adapter_unavailable', 'verify_error', 'run_stopped', 'dependency_blocked']) {
    assert.match(s76, new RegExp(`\`${r}\``), r);
  }
  assert.match(s76, /blocked \(needs_human\)/);
});

// ---------- ES-1 ----------
for (const bad of [42, null, ['needs_human'], { reason: 'x' }, true]) {
  test(`F68 ES-1 blocked_reason ${JSON.stringify(bad)}: approve exits 2 (state_corrupt) and writes nothing`, () => {
    const dir = fixture({ verdicts: B411, feature: { blocked_reason: bad } });
    const before = fs.readFileSync(featuresFile(dir));
    const contractBefore = fs.readFileSync(contractFile(dir));
    const r = approve(dir);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /blocked_reason/);
    assert.match(r.stderr, /state_corrupt|Fix or restore the file/);
    assert.ok(fs.readFileSync(featuresFile(dir)).equals(before), 'features.json changed');
    assert.ok(fs.readFileSync(contractFile(dir)).equals(contractBefore), 'contract changed');
    assert.equal(fs.existsSync(path.join(dir, '.harness', 'events.jsonl')), false);
  });
}
