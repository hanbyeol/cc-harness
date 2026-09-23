import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { BIN, REPO, tmpdir } from './helpers.mjs';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { verify as realVerify } from '../lib/verify.mjs';
import { runFeatures, convergence } from '../lib/run.mjs';
import { HarnessError } from '../lib/errors.mjs';

const FAKE_CLI = path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs');

// ------------------------------------------------------------------ fixtures

const SCRIPTS = {
  // exit 0 iff every named file exists (a criterion that fails on base, passes after build)
  'scripts/has.mjs': "import fs from 'node:fs';\nprocess.exit(process.argv.slice(2).every((f) => fs.existsSync(f)) ? 0 : 1);\n",
  'scripts/ok.mjs': 'process.exit(0);\n',
};

function contract(id, tier = 'standard') {
  const c = {
    id, title: `feature ${id}`, security_tier: tier, version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id}.txt exists`, check: `node scripts/has.mjs ${id}.txt`, new: true }],
    security_criteria: tier === 'critical' ? [{ id: 'SC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }] : [],
    error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-23T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

/**
 * A repo on `main` (the user's worktree stays there) with initialized .harness state.
 * features: [{id, deps?, tier?, status?, badHash?}]
 */
function fixture(features, { files = {} } = {}) {
  const state = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': {
      features: features.map((f) => ({ id: f.id, title: `feature ${f.id}`, security_tier: f.tier || 'standard', depends_on: f.deps || [], status: f.status || 'approved' })),
    },
  };
  for (const f of features) {
    const c = contract(f.id, f.tier);
    if (f.badHash) c.approval.hash = 'deadbeef';
    state[`.harness/contracts/${f.id}.json`] = c;
  }
  return gitRepo({ ...state, ...SCRIPTS, ...files }, { branch: null });
}

const cfg = (over = {}) => resolveConfig({
  base_branch: 'main', ...over,
  verify: { commands: [], ...(over.verify || {}) },
  budget: { step_timeout_sec: 60, ...(over.budget || {}) },
});

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const statuses = (dir) => Object.fromEntries(readJson(path.join(dir, '.harness/features.json')).features.map((f) => [f.id, f.status]));
const backlog = (dir) => readJson(path.join(dir, '.harness/backlog.json')).items;
const statePath = (dir) => path.join(dir, '.harness/runs/current.json');

// Fake builder: writes <id>.txt in the worktree; commits it when `commit` is set.
function fakeBuild({ commit = false, files, cost = 0, onCall } = {}) {
  const calls = [];
  const fn = async (a) => {
    calls.push({ featureId: a.featureId, round: a.round, attempt: a.attempt, cwd: a.cwd, findings: a.findings });
    if (onCall) {
      const r = await onCall(a, calls);
      if (r) return r;
    }
    writeFiles(a.cwd, files ? files(a) : { [`${a.featureId}.txt`]: `built r${a.round}\n` });
    if (commit) commitAll(a.cwd, `builder ${a.featureId}`);
    return { ok: true, costUsd: cost };
  };
  fn.calls = calls;
  return fn;
}

const finding = (id) => ({ criterion_id: id, dimension: 'functionality', summary: `${id} broken`, repro: 'node scripts/has.mjs nope' });

// Scripted evaluator: script[featureId] = list of verdicts per call; a verdict is
// 'pass' | 'needs-human' | 'eval_error' | [blocking ids] (fail) | full object.
function fakeEvaluate(script = {}, { cost = 0, independence = 'cross-model' } = {}) {
  const calls = [];
  const fn = async (a) => {
    const n = calls.filter((c) => c.featureId === a.featureId).length;
    calls.push({ featureId: a.featureId, round: a.round, base: a.base, cwd: a.cwd, verifyPass: a.verifyResult?.pass });
    const s = (script[a.featureId] || [])[n] ?? 'pass';
    const base = { feature: a.featureId, round: a.round, score: 8, scores: {}, backlogged: [], independence, costUsd: cost, file: null };
    if (Array.isArray(s)) return { ...base, verdict: 'fail', score: 4, blocking: s.map(finding) };
    if (typeof s === 'string') return { ...base, verdict: s, blocking: [] };
    return { ...base, ...s };
  };
  fn.calls = calls;
  return fn;
}

const PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const failing = (ids = ['AC-1']) => ({ ...PASSING, pass: false, criteria: ids.map((id) => ({ id, check: 'x', pass: false, message: 'exit 1' })) });

// Scripted verify: seq is consumed per call (true/false/result); afterwards always passes.
function fakeVerify(seq = []) {
  const calls = [];
  const fn = async (a) => {
    calls.push({ featureId: a.featureId, cwd: a.cwd, base: a.base });
    const s = seq[calls.length - 1];
    if (s === undefined || s === true) return PASSING;
    if (s === false) return failing();
    return s;
  };
  fn.calls = calls;
  return fn;
}

const run = (dir, deps, { config, ...opts } = {}) => runFeatures({ root: dir, config: cfg(config), deps: { verify: fakeVerify(), ...deps }, ...opts });
const sha = (dir, ref) => git(dir, 'rev-parse', ref);
// realpath of the parent: the path itself may be gone (worktrees are removed after the run)
const real = (p) => path.join(fs.realpathSync(path.dirname(p)), path.basename(p));

// ------------------------------------------------------------------ AC-1
test('F6 AC-1: only approved features with a frozen contract run, in depends_on order', async () => {
  const dir = fixture([
    { id: 'F2', deps: ['F1'] },
    { id: 'F1' },
    { id: 'F3', status: 'todo' },
    { id: 'F4', badHash: true },
    { id: 'F5', deps: ['F3'] },
  ]);
  const build = fakeBuild();
  const r = await run(dir, { build, evaluate: fakeEvaluate() });
  assert.deepEqual([...new Set(build.calls.map((c) => c.featureId))], ['F1', 'F2']);
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed', F3: 'todo', F4: 'approved', F5: 'approved' });
  assert.deepEqual(r.notRun.map((n) => n.id).sort(), ['F4', 'F5']);
});

test('F6 AC-1: an explicit id list limits the run to those features', async () => {
  const dir = fixture([{ id: 'F1' }, { id: 'F2' }]);
  const build = fakeBuild();
  await run(dir, { build, evaluate: fakeEvaluate() }, { ids: ['F2'] });
  assert.deepEqual(build.calls.map((c) => c.featureId), ['F2']);
  assert.deepEqual(statuses(dir), { F1: 'approved', F2: 'passed' });
  await assert.rejects(run(dir, { build, evaluate: fakeEvaluate() }, { ids: ['F9'] }), (e) => e instanceof HarnessError && e.code === 'usage');
});

// ------------------------------------------------------------------ AC-2
test('F6 AC-2: worktree .harness/wt/F{n} on branch harness/F{n} from integration (created from base if missing)', async () => {
  const dir = fixture([{ id: 'F1' }]);
  const mainSha = sha(dir, 'main');
  let seen;
  const build = fakeBuild({
    onCall: async (a) => {
      seen = { cwd: real(a.cwd), branch: git(a.cwd, 'symbolic-ref', '--short', 'HEAD'), head: git(a.cwd, 'rev-parse', 'HEAD'), integ: sha(dir, 'harness/integration') };
    },
  });
  await run(dir, { build, evaluate: fakeEvaluate() });
  assert.equal(seen.cwd, real(path.join(dir, '.harness', 'wt', 'F1')));
  assert.equal(seen.branch, 'harness/F1');
  assert.equal(seen.head, mainSha, 'integration was created from main');
  assert.equal(seen.integ, mainSha);
  assert.equal(git(dir, 'symbolic-ref', '--short', 'HEAD'), 'main', "the user's worktree never switches branch");
});

test('F6 AC-2: an existing integration branch is the base, not main', async () => {
  const dir = fixture([{ id: 'F1' }]);
  git(dir, 'checkout', '-q', '-b', 'harness/integration');
  writeFiles(dir, { 'integ.txt': 'x\n' });
  const integSha = commitAll(dir, 'integration work');
  git(dir, 'checkout', '-q', 'main');
  let head;
  const build = fakeBuild({ onCall: async (a) => { head = git(a.cwd, 'rev-parse', 'HEAD'); } });
  await run(dir, { build, evaluate: fakeEvaluate() });
  assert.equal(head, integSha);
});

// ------------------------------------------------------------------ AC-3
test('F6 AC-3: verify failure retries build at most 3 times per round, then the round fails', async () => {
  const dir = fixture([{ id: 'F1' }]);
  const build = fakeBuild();
  const verify = fakeVerify([false, false, false, true, true]); // r1: 3 fails; r2: pass; post-merge: pass
  const evaluate = fakeEvaluate();
  await run(dir, { build, verify, evaluate });
  assert.deepEqual(build.calls.map((c) => [c.round, c.attempt]), [[1, 1], [1, 2], [1, 3], [2, 1]]);
  assert.deepEqual(evaluate.calls.map((c) => c.round), [2], 'no eval for a round whose verify never passed');
  assert.deepEqual(build.calls[3].findings.map((f) => f.criterion_id), ['AC-1'], 'the next round gets the failing criteria');
  assert.equal(statuses(dir).F1, 'passed');
});

test('F6 AC-3: a verify failure followed by a pass evaluates the same round', async () => {
  const dir = fixture([{ id: 'F1' }]);
  const build = fakeBuild();
  const evaluate = fakeEvaluate();
  await run(dir, { build, verify: fakeVerify([false, true, true]), evaluate });
  assert.deepEqual(build.calls.map((c) => [c.round, c.attempt]), [[1, 1], [1, 2]]);
  assert.deepEqual(evaluate.calls.map((c) => [c.round, c.verifyPass]), [[1, true]]);
});

// ------------------------------------------------------------------ AC-4
test('F6 AC-4 divergence: pure rule — a criterion not blocking in k-1 that blocks in k diverges', () => {
  assert.deepEqual(convergence(['AC-1', 'AC-2'], ['AC-2', 'AC-3']), { blocked: 'divergence', ids: ['AC-3'] });
  // fewer findings does not excuse a new one
  assert.deepEqual(convergence(['AC-1', 'AC-2'], ['AC-3']), { blocked: 'divergence', ids: ['AC-3'] });
  assert.deepEqual(convergence({ blocking: [finding('AC-1')] }, { blocking: [finding('REGRESSION')] }), { blocked: 'divergence', ids: ['REGRESSION'] });
  assert.deepEqual(convergence(null, ['AC-1']), { ok: true }, 'round 1 has nothing to compare');
});

test('F6 AC-4 divergence: the run blocks the feature as soon as a new criterion blocks', async () => {
  const dir = fixture([{ id: 'F1' }]);
  const build = fakeBuild();
  const evaluate = fakeEvaluate({ F1: [['AC-1', 'AC-2'], ['AC-2', 'AC-3'], 'pass'] });
  const r = await run(dir, { build, evaluate }, { config: { max_rounds: 5 } });
  assert.equal(statuses(dir).F1, 'blocked');
  assert.equal(r.results[0].reason, 'divergence');
  assert.match(r.results[0].detail, /AC-3/);
  assert.equal(evaluate.calls.length, 2, 'no round 3');
  assert.deepEqual(r.results[0].history, [['AC-1', 'AC-2'], ['AC-2', 'AC-3']]);
});

// ------------------------------------------------------------------ AC-5
test('F6 AC-5 stall: pure rule — a blocking set that does not shrink stalls; a proper subset converges', () => {
  assert.deepEqual(convergence(['AC-1', 'AC-2'], ['AC-1', 'AC-2']), { blocked: 'stall', ids: ['AC-1', 'AC-2'] });
  assert.deepEqual(convergence(['AC-1'], [finding('AC-1'), finding('AC-1')]), { blocked: 'stall', ids: ['AC-1'] }, 'counted by distinct criterion');
  assert.deepEqual(convergence([], []), { blocked: 'stall', ids: [] });
  assert.deepEqual(convergence(['AC-1', 'AC-2'], ['AC-2']), { ok: true });
  assert.deepEqual(convergence(['AC-1'], []), { ok: true });
});

test('F6 AC-5 stall: the run blocks the feature when round k blocks as much as k-1', async () => {
  const dir = fixture([{ id: 'F1' }]);
  const evaluate = fakeEvaluate({ F1: [['AC-1', 'AC-2'], ['AC-1', 'AC-2']] });
  const r = await run(dir, { build: fakeBuild(), evaluate }, { config: { max_rounds: 5 } });
  assert.equal(statuses(dir).F1, 'blocked');
  assert.equal(r.results[0].reason, 'stall');
  assert.equal(evaluate.calls.length, 2);
});

// ------------------------------------------------------------------ AC-6
test('F6 AC-6: max_rounds exhausted blocks the feature and records a re-scope proposal in backlog', async () => {
  const dir = fixture([{ id: 'F1' }]);
  const build = fakeBuild();
  const evaluate = fakeEvaluate({ F1: [['AC-1', 'AC-2', 'SC-1'], ['AC-1', 'AC-2'], ['AC-1'], 'pass'] });
  const r = await run(dir, { build, evaluate });
  assert.equal(statuses(dir).F1, 'blocked');
  assert.equal(r.results[0].reason, 'max_rounds');
  assert.equal(evaluate.calls.length, 3, 'default max_rounds is 3');
  assert.deepEqual([...new Set(build.calls.map((c) => c.round))], [1, 2, 3]);
  const items = backlog(dir);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'rescope');
  assert.equal(items[0].feature, 'F1');
  assert.equal(items[0].reason, 'max_rounds');
  assert.deepEqual(items[0].blocking, ['AC-1']);
  assert.deepEqual(items[0].options.map((o) => o.kind), ['split', 'rewrite', 'accept-risk']);
});

test('F6 AC-6: max_rounds comes from config', async () => {
  const dir = fixture([{ id: 'F1' }]);
  const evaluate = fakeEvaluate({ F1: [['AC-1', 'AC-2'], ['AC-1']] });
  const r = await run(dir, { build: fakeBuild(), evaluate }, { config: { max_rounds: 2 } });
  assert.equal(r.results[0].reason, 'max_rounds');
  assert.equal(evaluate.calls.length, 2);
});

// ------------------------------------------------------------------ eval verdicts (SPEC §7.3)
test('F6 eval: eval_error does not consume a round; two in a row block the feature', async () => {
  const dir = fixture([{ id: 'F1' }, { id: 'F2' }]);
  const build = fakeBuild();
  const evaluate = fakeEvaluate({ F1: ['eval_error', 'pass'], F2: ['eval_error', 'eval_error'] });
  const r = await run(dir, { build, evaluate });
  assert.deepEqual(evaluate.calls.filter((c) => c.featureId === 'F1').map((c) => c.round), [1, 1]);
  assert.equal(build.calls.filter((c) => c.featureId === 'F1').length, 1, 'no rebuild after eval_error');
  assert.deepEqual(r.results.map((x) => [x.feature, x.status, x.reason]), [['F1', 'passed', null], ['F2', 'blocked', 'eval_error']]);
});

test('F6 eval: needs-human blocks the feature at once', async () => {
  const dir = fixture([{ id: 'F1' }]);
  const r = await run(dir, { build: fakeBuild(), evaluate: fakeEvaluate({ F1: ['needs-human'] }) });
  assert.deepEqual([r.results[0].status, r.results[0].reason], ['blocked', 'needs-human']);
});

// ------------------------------------------------------------------ AC-7
test('F6 AC-7: dependents of a blocked feature are skipped (transitively); independent features continue', async () => {
  const dir = fixture([{ id: 'F1' }, { id: 'F2', deps: ['F1'] }, { id: 'F3', deps: ['F2'] }, { id: 'F4' }]);
  const build = fakeBuild();
  const evaluate = fakeEvaluate({ F1: [['AC-1'], ['AC-1']] });
  const r = await run(dir, { build, evaluate });
  assert.deepEqual(statuses(dir), { F1: 'blocked', F2: 'skipped', F3: 'skipped', F4: 'passed' });
  assert.equal(r.stopped, null);
  assert.deepEqual(r.results.filter((x) => x.status === 'skipped').map((x) => x.reason), ['depends on F1 (blocked)', 'depends on F1 (blocked)']);
  assert.ok(!build.calls.some((c) => c.featureId === 'F2' || c.featureId === 'F3'));
});

// ------------------------------------------------------------------ AC-8
test('F6 AC-8: a blocked critical feature stops the whole run', async () => {
  const dir = fixture([{ id: 'F1', tier: 'critical' }, { id: 'F2' }, { id: 'F3', deps: ['F1'] }]);
  const build = fakeBuild();
  const evaluate = fakeEvaluate({ F1: [['AC-1'], ['AC-1']] });
  const r = await run(dir, { build, evaluate });
  assert.deepEqual(statuses(dir), { F1: 'blocked', F2: 'approved', F3: 'skipped' });
  assert.deepEqual(r.stopped && [r.stopped.reason, r.stopped.feature], ['critical_blocked', 'F1']);
  assert.deepEqual([...new Set(build.calls.map((c) => c.featureId))], ['F1'], 'independent F2 never started');
  assert.match(fs.readFileSync(r.report, 'utf8'), /stopped: critical_blocked \(F1\)/);
});

// ------------------------------------------------------------------ AC-9
test('F6 AC-9: pass merges --no-ff into integration, re-verifies there against the pre-merge commit, then passed', async () => {
  const dir = fixture([{ id: 'F1' }]);
  const calls = [];
  const verify = async (a) => { calls.push({ cwd: real(a.cwd), base: a.base }); return realVerify(a); };
  const r = await runFeatures({ root: dir, config: cfg(), deps: { build: fakeBuild(), evaluate: fakeEvaluate(), verify } });
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results));
  const integ = 'harness/integration';
  const parents = git(dir, 'rev-list', '--parents', '-n', '1', integ).split(' ');
  assert.equal(parents.length, 3, 'a merge commit (--no-ff)');
  assert.equal(parents[1], sha(dir, 'main'), 'first parent is the pre-merge integration tip');
  assert.equal(git(dir, 'show', `${integ}:F1.txt`), 'built r1', 'builder output (uncommitted) was committed and merged');
  assert.equal(git(dir, 'log', '-1', '--format=%an', parents[2]), 'cc-harness');
  const post = calls[calls.length - 1];
  assert.equal(post.cwd, real(path.join(dir, '.harness', 'wt', '_integration')));
  assert.equal(post.base, parents[1]);
  assert.equal(statuses(dir).F1, 'passed');
  assert.ok(!fs.existsSync(path.join(dir, '.harness', 'wt', 'F1')), 'feature worktree removed after merge');
});

test('F6 AC-9: a failing post-merge verify is not passed and the merge is rolled back', async () => {
  const dir = fixture([{ id: 'F1' }]);
  const verify = async (a) => (real(a.cwd).endsWith(`${path.sep}_integration`) ? failing() : PASSING);
  const r = await runFeatures({ root: dir, config: cfg(), deps: { build: fakeBuild({ commit: true }), evaluate: fakeEvaluate(), verify } });
  assert.equal(statuses(dir).F1, 'blocked');
  assert.equal(r.results[0].reason, 'post_merge_verify');
  assert.equal(sha(dir, 'harness/integration'), sha(dir, 'main'), 'integration rolled back to the pre-merge commit');
});

// ------------------------------------------------------------------ AC-10
test('F6 AC-10: runs/{ts}.md records per-feature result, rounds, independence, cost and blocked reason', async () => {
  const dir = fixture([{ id: 'F1' }, { id: 'F2' }]);
  const build = fakeBuild({ cost: 0.5 });
  const evaluate = fakeEvaluate({ F1: [['AC-1', 'AC-2'], 'pass'], F2: [['AC-1'], ['AC-1']] }, { cost: 0.25, independence: 'cross-model' });
  const now = () => new Date('2026-09-23T10:20:30.000Z');
  const r = await runFeatures({ root: dir, config: cfg(), deps: { build, evaluate, verify: fakeVerify(), now } });
  assert.equal(r.report, path.join(dir, '.harness', 'runs', '2026-09-23T10-20-30-000Z.md'));
  const md = fs.readFileSync(r.report, 'utf8');
  assert.match(md, /\| F1 feature F1 \| passed \| 2 \| cross-model \| 1\.50 \| {2}\|/);
  assert.match(md, /\| F2 feature F2 \| blocked \| 2 \| cross-model \| 1\.50 \| stall: still blocking: AC-1 \|/);
  assert.match(md, /total cost: \$3\.00/);
  assert.match(md, /round 1 blocking: AC-1/);
  assert.match(md, /gh pr create --base main --head harness\/integration/);
  assert.ok(!fs.existsSync(statePath(dir)), 'resumable state is dropped after a completed run');
});

// ------------------------------------------------------------------ AC-11
test('F6 AC-11: --resume continues from the state file alone (round, stage, history)', async () => {
  const dir = fixture([{ id: 'F1' }, { id: 'F2' }]);
  const controller = new AbortController();
  const build1 = fakeBuild({ onCall: async (a) => { if (a.round === 2) controller.abort(); } });
  const eval1 = fakeEvaluate({ F1: [['AC-1', 'AC-2']] });
  const first = await runFeatures({ root: dir, config: cfg({ max_rounds: 3 }), ids: ['F1', 'F2'], signal: controller.signal, deps: { build: build1, evaluate: eval1, verify: fakeVerify() } });
  assert.equal(first.interrupted, true);
  const saved = readJson(statePath(dir));
  assert.deepEqual([saved.current.feature, saved.current.round, saved.current.stage], ['F1', 2, 'build']);
  assert.deepEqual(saved.current.history, [['AC-1', 'AC-2']]);
  assert.equal(statuses(dir).F1, 'in_progress');

  // New process: no config, no ids — only the state file. Round 2 brings AC-3 → divergence
  // proves the round-1 history came from the file.
  const build2 = fakeBuild();
  const eval2 = fakeEvaluate({ F1: [['AC-2', 'AC-3']] });
  const r = await runFeatures({ root: dir, resume: true, deps: { build: build2, evaluate: eval2, verify: fakeVerify() } });
  assert.deepEqual(build2.calls.filter((c) => c.featureId === 'F1').map((c) => c.round), [2]);
  assert.deepEqual(eval2.calls.filter((c) => c.featureId === 'F1').map((c) => c.round), [2]);
  assert.equal(r.results.find((x) => x.feature === 'F1').reason, 'divergence');
  assert.deepEqual(statuses(dir), { F1: 'blocked', F2: 'passed' }, 'the saved scope (F1, F2) continues');
  assert.ok(!fs.existsSync(statePath(dir)));
});

test('F6 AC-11: resume without a state file fails; a saved run blocks a fresh start', async () => {
  const dir = fixture([{ id: 'F1' }]);
  await assert.rejects(runFeatures({ root: dir, resume: true, deps: {} }), (e) => e.code === 'no_run');
  writeFiles(dir, { '.harness/runs/current.json': '{ broken' });
  await assert.rejects(runFeatures({ root: dir, resume: true, deps: {} }), (e) => e.code === 'state_corrupt');
  await assert.rejects(run(dir, { build: fakeBuild(), evaluate: fakeEvaluate() }), (e) => e.code === 'run_in_progress');
});

// ------------------------------------------------------------------ SC-1
test('F6 SC-1: a full fake run never moves main, the user branch or the remote (SR-5)', async () => {
  const dir = fixture([{ id: 'F1' }, { id: 'F2', deps: ['F1'] }, { id: 'F3' }]);
  const remote = tmpdir('harness-remote-');
  git(remote, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', 'origin', 'main');
  const before = { main: sha(dir, 'main'), head: git(dir, 'symbolic-ref', 'HEAD'), remote: git(remote, 'for-each-ref') };
  const evaluate = fakeEvaluate({ F3: [['AC-1'], ['AC-1']] });
  const r = await runFeatures({ root: dir, config: cfg(), deps: { build: fakeBuild(), evaluate, verify: realVerify } });
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed', F3: 'blocked' }, JSON.stringify(r.results));
  assert.equal(sha(dir, 'main'), before.main, 'main commit hash unchanged');
  assert.equal(git(dir, 'symbolic-ref', 'HEAD'), before.head);
  assert.equal(git(remote, 'for-each-ref'), before.remote, 'nothing pushed');
  const branches = git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort();
  assert.deepEqual(branches, ['harness/F3', 'harness/integration', 'main']);
  assert.notEqual(sha(dir, 'harness/integration'), before.main);
});

test('F6 SC-1: refuses an integration branch that is protected or is the protected base', async () => {
  const dir = fixture([{ id: 'F1' }]);
  const build = fakeBuild();
  const mainSha = sha(dir, 'main');
  for (const over of [{ integration_branch: 'main' }, { integration_branch: 'release', protected_branches: ['release'] }, { integration_branch: 'main', protected_branches: [] }]) {
    await assert.rejects(runFeatures({ root: dir, config: cfg(over), deps: { build, evaluate: fakeEvaluate(), verify: fakeVerify() } }), (e) => e.code === 'protected_branch', JSON.stringify(over));
  }
  assert.equal(build.calls.length, 0);
  assert.equal(sha(dir, 'main'), mainSha);
  assert.equal(statuses(dir).F1, 'approved');
});

// ------------------------------------------------------------------ ES-1
test('F6 ES-1: a merge conflict aborts the merge, blocks the feature (merge_conflict), and leaves integration clean', async () => {
  const dir = fixture([{ id: 'F1' }, { id: 'F2' }], { files: { 'shared.txt': 'base\n' } });
  const intWt = path.join(dir, '.harness', 'wt', '_integration');
  let integTip;
  let afterAbort;
  const build = fakeBuild({
    commit: true,
    files: (a) => ({ [`${a.featureId}.txt`]: 'x\n', 'shared.txt': `${a.featureId}\n` }),
    onCall: async (a) => {
      if (a.featureId === 'F2') { // runs right after F1's aborted merge
        const gitDir = path.resolve(intWt, git(intWt, 'rev-parse', '--git-dir'));
        afterAbort = { status: git(intWt, 'status', '--porcelain'), mergeHead: fs.existsSync(path.join(gitDir, 'MERGE_HEAD')), tip: git(intWt, 'rev-parse', 'HEAD') };
        return;
      }
      // someone else lands a conflicting change on integration meanwhile
      writeFiles(intWt, { 'shared.txt': 'human\n' });
      integTip = commitAll(intWt, 'conflicting change');
    },
  });
  const r = await runFeatures({ root: dir, config: cfg(), deps: { build, evaluate: fakeEvaluate(), verify: fakeVerify() } });
  const f1 = r.results.find((x) => x.feature === 'F1');
  assert.equal(f1.status, 'blocked');
  assert.equal(f1.reason, 'merge_conflict');
  assert.match(f1.detail, /shared\.txt/);
  assert.equal(statuses(dir).F2, 'passed', 'an independent feature still runs');
  assert.equal(sha(dir, 'harness/integration^1'), integTip, "F1's merge never landed: F2 merged straight onto the other change");
  assert.deepEqual(afterAbort, { status: '', mergeHead: false, tip: integTip }, 'integration worktree clean after --abort, tip unchanged');
  assert.equal(backlog(dir)[0].reason, 'merge_conflict');
});

// ------------------------------------------------------------------ ES-2
test('F6 ES-2: a step timeout blocks the feature with reason budget', async () => {
  const dir = fixture([{ id: 'F1' }, { id: 'F2' }]);
  const build = fakeBuild({ onCall: async (a) => (a.featureId === 'F1' ? { ok: false, error: 'timeout', costUsd: null } : null) });
  const r = await run(dir, { build, evaluate: fakeEvaluate() });
  assert.deepEqual(r.results.map((x) => [x.feature, x.status, x.reason]), [['F1', 'blocked', 'budget'], ['F2', 'passed', null]]);
  assert.equal(build.calls.filter((c) => c.featureId === 'F1').length, 1, 'no retry after a timeout');
});

test('F6 ES-2: a step reaching budget.step_usd blocks the feature with reason budget', async () => {
  const dir = fixture([{ id: 'F1' }]);
  const build = fakeBuild({ cost: 2 });
  const r = await run(dir, { build, evaluate: fakeEvaluate() }, { config: { budget: { step_usd: 1.5 } } });
  assert.deepEqual([r.results[0].status, r.results[0].reason], ['blocked', 'budget']);
});

test('F6 ES-2: exceeding the run budget (--max-usd) stops the whole run', async () => {
  const dir = fixture([{ id: 'F1' }, { id: 'F2' }]);
  const build = fakeBuild({ cost: 3 });
  const evaluate = fakeEvaluate({}, { cost: 2 });
  const budgets = [];
  const spy = async (a) => { budgets.push(a.budgetUsd); return build(a); };
  const r = await run(dir, { build: spy, evaluate }, { maxUsd: 4 });
  assert.deepEqual(budgets, [4], 'the builder gets the remaining run budget');
  assert.deepEqual(statuses(dir), { F1: 'blocked', F2: 'approved' });
  assert.equal(r.stopped.reason, 'budget');
  assert.equal(r.costUsd, 5);
  assert.match(fs.readFileSync(r.report, 'utf8'), /stopped: budget/);
});

// ------------------------------------------------------------------ ES-3
test('F6 ES-3: SIGINT during a slow build saves state, prints the --resume hint and exits 130', { timeout: 60000 }, async () => {
  if (process.platform === 'win32') return; // no POSIX signal delivery to a child on Windows
  const dir = fixture([{ id: 'F1' }]);
  const pidFile = path.join(tmpdir('harness-pid-'), 'builder.pid');
  writeFiles(dir, {
    '.harness/config.json': {
      profile: 'sdlc', base_branch: 'main', verify: { commands: [] },
      roles: { builder: 'generic', evaluator: 'generic', 'security-reviewer': 'generic' },
      adapters: { generic: { command: [process.execPath, FAKE_CLI, 'sleep', pidFile] } },
    },
  });
  commitAll(dir, 'slow builder config');
  const child = spawn(process.execPath, [BIN, 'run'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b) => { stdout += b; });
  child.stderr.on('data', (b) => { stderr += b; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  let builderPid = null;
  try {
    for (let i = 0; i < 300 && !builderPid; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      if (fs.existsSync(pidFile)) builderPid = Number(fs.readFileSync(pidFile, 'utf8')) || null;
    }
    assert.ok(builderPid, `slow builder never started: ${stdout}${stderr}`);
    child.kill('SIGINT');
    const { code } = await exited;
    assert.equal(code, 130, stdout + stderr);
    assert.match(stderr, /harness run --resume/);
    const saved = readJson(statePath(dir));
    assert.deepEqual([saved.current.feature, saved.current.round, saved.current.stage], ['F1', 1, 'build']);
    assert.equal(statuses(dir).F1, 'in_progress');
  } finally {
    child.kill('SIGKILL');
    if (builderPid) { try { process.kill(builderPid, 'SIGKILL'); } catch { /* gone */ } }
  }
});

test('F6 ES-3: run rejects bad arguments (usage)', () => {
  const dir = fixture([{ id: 'F1' }]);
  for (const args of [['run', '--resume', 'F1'], ['run', '--max-usd'], ['run', '--max-usd', '-1'], ['run', 'nope']]) {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /usage: harness run/);
  }
});

// ------------------------------------------------------------------ ES-4
test('F6 ES-4: worktree creation failure blocks that feature; the others continue', async () => {
  const dir = fixture([{ id: 'F1' }, { id: 'F2' }]);
  writeFiles(dir, { '.harness/wt/F1': 'a file where the worktree should go\n' });
  const build = fakeBuild();
  const r = await run(dir, { build, evaluate: fakeEvaluate() });
  assert.deepEqual(r.results.map((x) => [x.feature, x.status, x.reason]), [['F1', 'blocked', 'worktree'], ['F2', 'passed', null]]);
  assert.deepEqual(build.calls.map((c) => c.featureId), ['F2']);
  assert.equal(backlog(dir)[0].reason, 'worktree');
});

test('F6 ES-3 abort kills the step: an aborted runCommand leaves no process behind', async () => {
  const { runCommand } = await import('../lib/exec.mjs');
  const ac = new AbortController();
  const pidfile = path.join(tmpdir(), 'pid');
  const p = runCommand({ file: process.execPath, args: [path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs'), 'sleep', pidfile] }, { cwd: REPO, timeoutSec: 60, signal: ac.signal });
  for (let i = 0; i < 50 && !fs.existsSync(pidfile); i += 1) await new Promise((r) => setTimeout(r, 100));
  const started = Date.now();
  ac.abort();
  const r = await p;
  assert.equal(r.aborted, true);
  assert.ok(Date.now() - started < 5000);
  const pid = Number(fs.readFileSync(pidfile, 'utf8'));
  let alive = true;
  for (let i = 0; i < 30 && alive; i += 1) { try { process.kill(pid, 0); await new Promise((res) => setTimeout(res, 100)); } catch { alive = false; } }
  assert.equal(alive, false, `step process ${pid} survived the abort`);
});

// ------------------------------------------------------------------ round-1 review regressions

const PASS_VERIFY = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } } };

test('F6 SC-1 case variants: an integration branch that differs from a protected one only by case is refused', async () => {
  for (const [integration_branch, protected_branches] of [['Main', []], ['MAIN', []], ['Release', ['release']]]) {
    const dir = fixture([{ id: 'F1' }]);
    if (protected_branches.length) git(dir, 'branch', protected_branches[0]);
    const before = git(dir, 'rev-parse', 'main');
    await assert.rejects(
      runFeatures({ root: dir, config: cfg({ integration_branch, protected_branches }), deps: { build: fakeBuild(), verify: async () => PASS_VERIFY, evaluate: async () => ({ verdict: 'pass', blocking: [], costUsd: 0 }) } }),
      (e) => e instanceof HarnessError && e.code === 'protected_branch', integration_branch);
    assert.equal(git(dir, 'rev-parse', 'main'), before, integration_branch);
  }
});

test('F6 AC-11 resume mid-round: completed build attempts are not repeated', async () => {
  const dir = fixture([{ id: 'F1' }]);
  const ac = new AbortController();
  const builds = [];
  const build = async (a) => { builds.push(`${a.round}.${a.attempt}`); if (builds.length === 3) ac.abort(); writeFiles(a.cwd, { 'F1.txt': 'x' }); return { ok: true, costUsd: 0 }; };
  const failVerify = async () => ({ pass: false, commands: [], criteria: [{ id: 'AC-1', check: 'x', pass: false, message: 'exit 1' }], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } } });
  const evaluate = async () => ({ verdict: 'pass', blocking: [], costUsd: 0 });
  await runFeatures({ root: dir, config: cfg({ max_rounds: 1 }), signal: ac.signal, deps: { build, verify: failVerify, evaluate } });
  await runFeatures({ root: dir, resume: true, deps: { build, verify: failVerify, evaluate } });
  // attempt 3 was interrupted mid-build, so only it is redone: 1.1 1.2 1.3 | 1.3
  assert.deepEqual(builds, ['1.1', '1.2', '1.3', '1.3']);
});

test('F6 ES-3 abort reaches verify and eval: both receive the run signal', async () => {
  const dir = fixture([{ id: 'F1' }]);
  const ac = new AbortController();
  const seen = {};
  await runFeatures({ root: dir, config: cfg(), signal: ac.signal, deps: {
    build: fakeBuild(),
    verify: async (a) => { seen.verify = a.signal; return PASS_VERIFY; },
    evaluate: async (a) => { seen.evaluate = a.signal; return { verdict: 'pass', blocking: [], costUsd: 0 }; },
  } });
  assert.equal(seen.verify, ac.signal);
  assert.equal(seen.evaluate, ac.signal);
});
