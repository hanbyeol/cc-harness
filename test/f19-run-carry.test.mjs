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

const SCRIPTS = {
  'scripts/ok.mjs': 'process.exit(0);\n',
  'scripts/fail.mjs': 'process.exit(3);\n',
};

function contract(version = 1) {
  const c = {
    id: 'F9', title: 'fixture feature', security_tier: 'standard', version,
    acceptance_criteria: [
      { id: 'AC-1', criterion: `one (v${version})`, check: 'node scripts/ok.mjs', new: false },
      { id: 'AC-2', criterion: 'two', check: 'node scripts/ok.mjs', new: false },
    ],
    security_criteria: [{ id: 'SC-1', criterion: 'three', check: 'node scripts/ok.mjs', new: false }],
    error_scenarios: [],
    out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-24T00:00:00.000Z', hash: hashContract(c) };
  return c;
}
const HASH = hashContract(contract(1));
const OTHER_HASH = hashContract(contract(0));

// An interactive-eval verdict of the current contract (or `hash`).
const evalVerdict = (round, ids, { hash = HASH, contractRound = round } = {}) => ({
  feature: 'F9', round, verdict: 'fail', score: 3, verify_pass: true, origin: 'eval',
  contract_hash: hash, contract_round: contractRound,
  blocking: ids.map((id) => ({ criterion_id: id, summary: `${id} broken`, repro: 'node scripts/fail.mjs', exit: 3 })),
  backlogged: [],
});

function runFixture({ status = 'in_progress', verdicts = {} } = {}) {
  const files = {};
  for (const [k, v] of Object.entries(verdicts)) files[`.harness/verdicts/F9-r${k}.json`] = v;
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, max_rounds: 3 },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status, depends_on: [] }] },
    '.harness/contracts/F9.json': contract(1),
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    ...files,
    ...SCRIPTS,
  }, { branch: null });
}

const PASS_VERIFY = {
  pass: true, commands: [], warnings: [],
  integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } },
  criteria: [{ id: 'AC-1', pass: true }, { id: 'AC-2', pass: true }, { id: 'SC-1', pass: true }],
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

async function runOnce(dir, runAdapter, { maxRounds = 3 } = {}) {
  const build = async (a) => {
    build.calls += 1;
    writeFiles(a.cwd, { 'F9.txt': `built ${build.calls}\n` });
    return { ok: true, costUsd: 0 };
  };
  build.calls = 0;
  const r = await runFeatures({
    root: dir,
    deps: { build, runAdapter, evaluate, verify: async () => PASS_VERIFY },
    config: resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, max_rounds: maxRounds }),
  });
  return { ...r, builds: build.calls };
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const vfile = (dir, k) => path.join(dir, '.harness', 'verdicts', `F9-r${k}.json`);
const statusOf = (dir) => readJson(path.join(dir, '.harness', 'features.json')).features.find((f) => f.id === 'F9').status;
const verdictFiles = (dir) => {
  try { return fs.readdirSync(path.join(dir, '.harness', 'verdicts')).filter((n) => /^F9-r\d+\.json$/.test(n)).sort(); } catch { return []; }
};
// Two interactive fail verdicts of the current contract: {AC-1, AC-2, SC-1} then {AC-1, AC-2}.
const TWO_FAILS = { 1: evalVerdict(1, ['AC-1', 'AC-2', 'SC-1']), 2: evalVerdict(2, ['AC-1', 'AC-2']) };

// ---------- AC-1 ----------
test('F19 AC-1 two interactive fails of the current hash, max_rounds 3: one builder round, blocked by the round limit, contract_round 3', async () => {
  const dir = runFixture({ verdicts: TWO_FAILS });
  const ra = adapter(failReply('AC-1'), failReply('AC-1'), failReply('AC-1'));
  const r = await runOnce(dir, ra);
  assert.equal(r.builds, 1, JSON.stringify(r.results));
  assert.equal(ra.calls, 1);
  assert.equal(r.results[0].status, 'blocked');
  assert.equal(r.results[0].reason, 'max_rounds', 'the run’s round-limit reason');
  assert.equal(statusOf(dir), 'blocked');
  assert.deepEqual(verdictFiles(dir), ['F9-r1.json', 'F9-r2.json', 'F9-r3.json']);
  const v3 = readJson(vfile(dir, 3));
  assert.equal(v3.origin, 'run');
  assert.equal(v3.contract_round, 3);
});

// ---------- AC-2 ----------
test('F19 AC-2 the first run fail is compared with the previous same-hash verdict: {AC-1} then {AC-2} → blocked(divergence)', async () => {
  const dir = runFixture({ verdicts: { 1: evalVerdict(1, ['AC-1']) } });
  const ra = adapter(failReply('AC-2'), failReply('AC-2'), failReply('AC-2'));
  const r = await runOnce(dir, ra);
  assert.equal(r.builds, 1, JSON.stringify(r.results));
  assert.equal(r.results[0].status, 'blocked');
  assert.equal(r.results[0].reason, 'divergence', JSON.stringify(r.results));
  assert.equal(statusOf(dir), 'blocked');
});

test('F19 AC-2 the first run fail shrinking the previous same-hash set ({AC-1, AC-2} → {AC-1}) goes on to the next round', async () => {
  const dir = runFixture({ verdicts: { 1: evalVerdict(1, ['AC-1', 'AC-2']) } });
  const ra = adapter(failReply('AC-1'), passReply());
  const r = await runOnce(dir, ra);
  assert.equal(r.builds, 2, JSON.stringify(r.results));
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results));
  assert.equal(readJson(vfile(dir, 2)).contract_round, 2);
  assert.equal(readJson(vfile(dir, 3)).contract_round, 3);
});

test('F19 AC-2 the first run fail with the same set as the previous same-hash verdict stalls', async () => {
  const dir = runFixture({ verdicts: { 1: evalVerdict(1, ['AC-1']) } });
  const r = await runOnce(dir, adapter(failReply('AC-1'), passReply()));
  assert.equal(r.builds, 1, JSON.stringify(r.results));
  assert.equal(r.results[0].reason, 'stall', JSON.stringify(r.results));
});

// ---------- AC-3 ----------
test('F19 AC-3 no verdicts: run gets all max_rounds rounds', async () => {
  const dir = runFixture({ status: 'approved' });
  const ra = adapter(failReply('AC-1', 'AC-2', 'SC-1'), failReply('AC-1', 'AC-2'), failReply('AC-1'));
  const r = await runOnce(dir, ra);
  assert.equal(r.builds, 3, JSON.stringify(r.results));
  assert.equal(r.results[0].reason, 'max_rounds');
  assert.equal(r.results[0].rounds, 3);
});

test('F19 AC-3 verdicts of another contract hash only: run gets all max_rounds rounds, contract_round 1..3', async () => {
  const dir = runFixture({
    status: 'approved',
    verdicts: { 1: evalVerdict(1, ['AC-1'], { hash: OTHER_HASH }), 2: evalVerdict(2, ['AC-1'], { hash: OTHER_HASH }) },
  });
  const ra = adapter(failReply('AC-2', 'SC-1'), failReply('AC-2'), failReply('AC-2'));
  const r = await runOnce(dir, ra);
  // {AC-2, SC-1} after the other contract's {AC-1} is not divergence; {AC-2} twice then stalls.
  assert.equal(r.builds, 3, JSON.stringify(r.results));
  assert.equal(r.results[0].reason, 'stall');
  assert.deepEqual([3, 4, 5].map((k) => readJson(vfile(dir, k)).contract_round), [1, 2, 3]);
});

// ---------- AC-4 ----------
test('F19 AC-4 the result and the report count contract rounds: Rounds 3 after two interactive fails', async () => {
  const dir = runFixture({ verdicts: TWO_FAILS });
  const r = await runOnce(dir, adapter(failReply('AC-1')));
  assert.equal(r.results[0].rounds, 3, JSON.stringify(r.results));
  const md = fs.readFileSync(r.report, 'utf8');
  assert.match(md, /\| F9 fixture \| blocked \| 3 \|/);
  assert.match(md, /- round 1 blocking: AC-1, AC-2, SC-1\n- round 2 blocking: AC-1, AC-2\n- round 3 blocking: AC-1\n/);
});

// ---------- AC-5 ----------
const SPEC = () => fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
const section = (s, from, to) => s.slice(s.indexOf(from), s.indexOf(to));

test('F19 AC-5 SPEC §8 says run carries earlier verdicts of the same contract hash (interactive too) into the round limit and convergence', () => {
  const s = section(SPEC(), '## 8.', '## 9.');
  const line = s.split('\n').find((l) => /같은 계약 해시의 이전 판정/.test(l));
  assert.ok(line, 'no line about earlier verdicts of the same contract hash');
  assert.match(line, /대화형/);
  assert.match(line, /이어받/);
  assert.match(line, /라운드 상한/);
  assert.match(line, /수렴 비교/);
});

// ---------- SC-1 ----------
test('F19 SC-1 max_rounds verdicts of the current hash already: no builder, no evaluator, blocked by the round limit', async () => {
  const dir = runFixture({ verdicts: { ...TWO_FAILS, 3: evalVerdict(3, ['AC-1']) } });
  const ra = adapter(passReply());
  const r = await runOnce(dir, ra);
  assert.equal(r.builds, 0);
  assert.equal(ra.calls, 0);
  assert.equal(r.results[0].status, 'blocked');
  assert.equal(r.results[0].reason, 'max_rounds');
  assert.equal(r.results[0].rounds, 3);
  assert.equal(statusOf(dir), 'blocked');
  assert.deepEqual(verdictFiles(dir), ['F9-r1.json', 'F9-r2.json', 'F9-r3.json']);
});

// ---------- ES-1 ----------
test('F19 ES-1 an unreadable previous verdict: no builder, exit 2 state_corrupt, path in message, no stack', async () => {
  const dir = runFixture({ verdicts: { 1: evalVerdict(1, ['AC-1', 'AC-2']), 2: '{ not json' } });
  const ra = adapter(passReply());
  const build = async () => { build.calls += 1; return { ok: true, costUsd: 0 }; };
  build.calls = 0;
  const err = await runFeatures({
    root: dir,
    deps: { build, runAdapter: ra, evaluate, verify: async () => PASS_VERIFY },
    config: resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, max_rounds: 3 }),
  }).then(() => null, (e) => e);
  assert.ok(err instanceof HarnessError, String(err));
  assert.equal(err.code, 'state_corrupt');
  assert.equal(err.exit, 2);
  assert.ok(err.message.includes(vfile(dir, 2)), err.message);
  assert.ok(!err.message.includes('    at '), err.message);
  assert.equal(build.calls, 0);
  assert.equal(ra.calls, 0);
  assert.equal(statusOf(dir), 'in_progress');
});

test('F19 ES-1 harness run CLI: exit 2 with the verdict path and no stack trace', () => {
  const dir = runFixture({ verdicts: { 1: evalVerdict(1, ['AC-1', 'AC-2']), 2: '{ not json' } });
  const cli = harness(['run'], { cwd: dir });
  assert.equal(cli.code, 2, cli.stdout + cli.stderr);
  assert.ok(cli.stderr.includes('F9-r2.json'), cli.stderr);
  assert.ok(!cli.stderr.includes('    at '), cli.stderr);
  assert.ok(!fs.existsSync(path.join(dir, '.harness', 'wt', 'F9')), 'no worktree for F9');
});
