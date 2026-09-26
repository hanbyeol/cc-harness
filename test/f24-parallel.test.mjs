import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BIN, REPO } from './helpers.mjs';
import { git, gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { evaluate } from '../lib/eval.mjs';
import { runFeatures } from '../lib/run.mjs';
import { parseArgs } from '../lib/commands/run.mjs';

// ------------------------------------------------------------------ fixtures

const SCRIPTS = {
  'scripts/has.mjs': "import fs from 'node:fs';\nprocess.exit(process.argv.slice(2).every((f) => fs.existsSync(f)) ? 0 : 1);\n",
  'scripts/ok.mjs': 'process.exit(0);\n',
  'scripts/fail.mjs': 'process.exit(3);\n',
};

function contract(id, tier = 'standard') {
  const c = {
    id, title: `feature ${id}`, security_tier: tier, version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id}.txt exists`, check: `node scripts/has.mjs ${id}.txt`, new: true }],
    security_criteria: tier === 'critical' ? [{ id: 'SC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }] : [],
    error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-26T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

// A repo on `main` with initialized .harness state. features: [{id, deps?, tier?}]
function fixture(features, { config = {}, files = {} } = {}) {
  const state = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...config },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': {
      features: features.map((f) => ({ id: f.id, title: `feature ${f.id}`, security_tier: f.tier || 'standard', depends_on: f.deps || [], status: 'approved' })),
    },
  };
  for (const f of features) state[`.harness/contracts/${f.id}.json`] = contract(f.id, f.tier);
  return gitRepo({ ...state, ...SCRIPTS, ...files }, { branch: null });
}

const cfg = (over = {}) => resolveConfig({
  base_branch: 'main', ...over,
  verify: { commands: [] },
  budget: { step_timeout_sec: 60, ...(over.budget || {}) },
});

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const statuses = (dir) => Object.fromEntries(readJson(path.join(dir, '.harness/features.json')).features.map((f) => [f.id, f.status]));
const statePath = (dir) => path.join(dir, '.harness/runs/current.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
// realpath of the parent: the path itself may be gone (worktrees are removed after a merge)
const real = (p) => path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
const isIntegration = (cwd) => real(cwd).endsWith(`${path.sep}_integration`);
const overlap = (a, b) => a.start < b.end && b.start < a.end;

const PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };

// Fake builder: waits `delay(a)` ms, writes files (default <id>.txt), records the interval.
// onCall hook: the first builds of `ids` wait until all of them have started (up to 30 s), so
// "these builds overlap" holds by construction instead of by timing — on a slow machine a
// fixed delay let the first build end before the second began (windows-latest).
const startTogether = (ids) => async (a, calls) => {
  if (!ids.includes(a.featureId) || calls.filter((c) => c.featureId === a.featureId).length > 1) return;
  for (const t0 = Date.now(); !ids.every((id) => calls.some((c) => c.featureId === id)) && Date.now() - t0 < 30_000;) await sleep(20);
};

function slowBuild({ delay = () => 0, files, cost = () => 0, onCall } = {}) {
  const calls = [];
  const fn = async (a) => {
    const c = { featureId: a.featureId, round: a.round, cwd: a.cwd, signal: a.signal, start: now(), end: null };
    calls.push(c);
    if (onCall) await onCall(a, calls);
    await sleep(delay(a));
    writeFiles(a.cwd, files ? files(a) : { [`${a.featureId}.txt`]: `built r${a.round}\n` });
    c.end = now();
    return { ok: true, costUsd: cost(a) };
  };
  fn.calls = calls;
  return fn;
}

// Scripted evaluator: script[id] = list of verdicts per call ('pass' | 'needs-human' | [ids]).
function fakeEvaluate(script = {}, { delay = () => 0 } = {}) {
  const calls = [];
  const fn = async (a) => {
    const n = calls.filter((c) => c.featureId === a.featureId).length;
    const c = { featureId: a.featureId, cwd: a.cwd, start: now(), end: null };
    calls.push(c);
    await sleep(delay(a));
    c.end = now();
    const s = (script[a.featureId] || [])[n] ?? 'pass';
    const base = { feature: a.featureId, round: a.round, score: 8, scores: {}, backlogged: [], independence: 'cross-model', costUsd: 0, file: null };
    if (Array.isArray(s)) return { ...base, verdict: 'fail', score: 4, blocking: s.map((id) => ({ criterion_id: id, summary: `${id} broken`, repro: 'node scripts/fail.mjs' })) };
    return { ...base, verdict: s, blocking: [] };
  };
  fn.calls = calls;
  return fn;
}

function fakeVerify({ onIntegration } = {}) {
  const calls = [];
  const fn = async (a) => {
    calls.push({ featureId: a.featureId, cwd: a.cwd });
    if (onIntegration && isIntegration(a.cwd)) await onIntegration(a);
    return PASSING;
  };
  fn.calls = calls;
  return fn;
}

const run = (dir, deps, { config, ...opts } = {}) => runFeatures({ root: dir, config: cfg(config), deps: { verify: fakeVerify(), evaluate: fakeEvaluate(), ...deps }, ...opts });
const cli = (dir, args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8' });
const branchExists = (dir, b) => spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { cwd: dir }).status === 0;
const buildsOf = (build, id) => build.calls.filter((c) => c.featureId === id);

// ------------------------------------------------------------------ AC-1
// The 0.75 bound applies to the build window (first build start → last build end): the part of
// the run the builds occupy. The fixed git cost around it (worktrees, serial merges) varies a lot
// by machine (~13 s on windows-latest) and measuring it separately left ~1% noise at the bound.
// Serial builds span 2 × DELAY and fail the bound; parallel ones span about DELAY.
const buildWindow = (build) => {
  const firsts = ['F1', 'F2'].map((id) => buildsOf(build, id)[0]);
  return Math.max(...firsts.map((c) => c.end)) - Math.min(...firsts.map((c) => c.start));
};

for (const [label, opts] of [['--parallel 2', { parallel: 2 }], ['config run.max_parallel 2', { config: { run: { max_parallel: 2 } } }]]) {
  test(`F24 AC-1: ${label} builds two independent features at the same time`, async () => {
    const dir = fixture([{ id: 'F1' }, { id: 'F2' }]);
    const DELAY = 12000;
    const build = slowBuild({ delay: () => DELAY });
    const r = await run(dir, { build }, opts);
    assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed' });
    const [a, b] = [buildsOf(build, 'F1')[0], buildsOf(build, 'F2')[0]];
    assert.ok(overlap(a, b), `build intervals overlap: ${JSON.stringify([a, b].map((x) => [x.start, x.end]))}`);
    const window = buildWindow(build);
    assert.ok(window < 0.75 * 2 * DELAY, `builds spanned ${Math.round(window)}ms, expected < ${0.75 * 2 * DELAY}ms`);
    assert.equal(r.results.length, 2);
  });
}

test('F24 AC-1: harness run --parallel 2 reaches the run (CLI)', () => {
  assert.equal(parseArgs(['--parallel', '2']).parallel, 2);
  assert.equal(parseArgs(['F1', '--parallel', '3']).parallel, 3);
  assert.equal(parseArgs([]).parallel, undefined);
});

// ------------------------------------------------------------------ AC-2
test('F24 AC-2: a dependent starts only after its (direct and transitive) dependency passed, even with free slots', async () => {
  const dir = fixture([{ id: 'F1' }, { id: 'F2' }, { id: 'F3', deps: ['F1'] }, { id: 'F4', deps: ['F3'] }]);
  const passedAt = {};
  const log = (m) => { const x = /^(F\d+): passed$/.exec(m); if (x) passedAt[x[1]] = now(); };
  const build = slowBuild({ delay: (a) => (a.featureId === 'F1' ? 800 : 50), onCall: startTogether(['F1', 'F2']) });
  await run(dir, { build, log }, { parallel: 3 });
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed', F3: 'passed', F4: 'passed' });
  const [f1, f2, f3, f4] = ['F1', 'F2', 'F3', 'F4'].map((id) => buildsOf(build, id)[0]);
  assert.ok(overlap(f1, f2), 'F2 ran next to F1: slots were free');
  assert.ok(f2.end < f1.end, 'F2 finished while F1 was still building');
  assert.ok(f3.start > passedAt.F1, 'F3 started after F1 passed');
  assert.ok(f4.start > passedAt.F3, 'F4 (transitive on F1) started after F3 passed');
});

// ------------------------------------------------------------------ AC-3
test('F24 AC-3: merges are serial — no merge or post-merge verify overlaps another', async () => {
  const dir = fixture([{ id: 'F1' }, { id: 'F2' }]);
  const intervals = [];
  const onIntegration = async (a) => {
    const x = { featureId: a.featureId, start: now(), headStart: git(a.cwd, 'rev-parse', 'HEAD') };
    await sleep(400);
    Object.assign(x, { end: now(), headEnd: git(a.cwd, 'rev-parse', 'HEAD') });
    intervals.push(x);
  };
  const build = slowBuild({ delay: () => 1500, onCall: startTogether(['F1', 'F2']) });
  await run(dir, { build, verify: fakeVerify({ onIntegration }) }, { parallel: 2 });
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed' });
  assert.ok(overlap(buildsOf(build, 'F1')[0], buildsOf(build, 'F2')[0]), 'the features themselves ran in parallel');
  assert.equal(intervals.length, 2);
  assert.ok(!overlap(intervals[0], intervals[1]), 'post-merge verifies do not overlap');
  for (const x of intervals) assert.equal(x.headStart, x.headEnd, `no merge happened during ${x.featureId}'s post-merge verify`);
  const [first, second] = intervals.sort((p, q) => p.start - q.start);
  assert.equal(git(dir, 'rev-parse', `${second.headStart}^1`), first.headStart, 'the second merge is on top of the verified first');
});

// ------------------------------------------------------------------ AC-4
function evalFixture() {
  const c = {
    id: 'F9', title: 'fixture', security_tier: 'critical', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [{ id: 'SC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }],
    error_scenarios: [], out_of_scope: [],
  };
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': c,
    '.harness/backlog.json': { items: [] },
    ...SCRIPTS,
  });
  writeFiles(dir, { 'src/x.mjs': 'export const x = 1;\n' });
  return dir;
}
const scores = (o = {}) => ({ functionality: 9, quality: 9, security: 9, errors: 9, tests: 9, ...o });
const reply = (json) => ({ ok: true, error: null, text: JSON.stringify(json), json, costUsd: 0.01, exitCode: 0 });

function timedAdapter(replies) {
  const calls = [];
  const fn = async (role, opts) => {
    const c = { role, start: now(), end: null, readOnly: opts.readOnly };
    calls.push(c);
    await sleep(400);
    c.end = now();
    return replies[role];
  };
  fn.calls = calls;
  return fn;
}
const evalRun = (dir, ra) => evaluate({ root: dir, featureId: 'F9', base: 'main', config: cfg(), verifyResult: PASSING, runAdapter: ra });

test('F24 AC-4: critical evaluator and security-reviewer run at the same time', async () => {
  const dir = evalFixture();
  const ra = timedAdapter({ evaluator: reply({ scores: scores(), findings: [], out_of_scope: [] }), 'security-reviewer': reply({ scores: scores({ security: 8 }), findings: [], out_of_scope: [] }) });
  const r = await evalRun(dir, ra);
  const ev = ra.calls.find((c) => c.role === 'evaluator');
  const sr = ra.calls.find((c) => c.role === 'security-reviewer');
  assert.ok(overlap(ev, sr), `evaluator ${ev.start}-${ev.end}, reviewer ${sr.start}-${sr.end}`);
  assert.equal(r.verdict, 'pass');
  assert.equal(r.scores.security, 8, 'the reviewer still counts for security when used');
});

test('F24 AC-4: an evaluator blocking finding makes the reviewer result unused; the verdict stays fail', async () => {
  const dir = evalFixture();
  const evFinding = { criterion_id: 'AC-1', dimension: 'functionality', summary: 'broken', repro: 'node scripts/fail.mjs' };
  const srFinding = { criterion_id: 'SC-1', dimension: 'security', summary: 'leak', repro: 'node scripts/fail.mjs' };
  const ra = timedAdapter({
    evaluator: reply({ scores: scores({ functionality: 3 }), findings: [evFinding], out_of_scope: [] }),
    'security-reviewer': reply({ scores: scores({ security: 2 }), findings: [srFinding], out_of_scope: [{ summary: 'reviewer note' }] }),
  });
  const r = await evalRun(dir, ra);
  assert.ok(overlap(...ra.calls), 'both ran concurrently');
  assert.equal(r.verdict, 'fail', 'same verdict as a sequential evaluation');
  assert.equal(r.reviews['security-reviewer'], 'unused');
  assert.deepEqual(r.blocking.map((b) => [b.criterion_id, b.source]), [['AC-1', 'evaluator']]);
  assert.equal(r.scores.security, 9, 'the unused reviewer score does not enter the verdict');
  assert.ok(!r.backlogged.some((b) => b.source === 'security-reviewer'));
  const saved = readJson(r.file);
  assert.equal(saved.reviews['security-reviewer'], 'unused');
});

// ------------------------------------------------------------------ AC-5
test('F24 AC-5: parallel costs add up to one run total; over max-usd no new feature or step starts', async () => {
  const dir = fixture([{ id: 'F1' }, { id: 'F2' }, { id: 'F3' }]);
  const build = slowBuild({ delay: (a) => (a.featureId === 'F1' ? 100 : 300), cost: () => 1 });
  const evaluate = fakeEvaluate({}, { delay: () => 600 });
  const r = await run(dir, { build, evaluate }, { parallel: 2, maxUsd: 1.5 });
  assert.equal(r.costUsd, 2, 'both builds are counted in the run total');
  assert.equal(r.stopped?.reason, 'budget');
  assert.deepEqual(statuses(dir), { F1: 'blocked', F2: 'blocked', F3: 'approved' });
  assert.deepEqual(r.results.map((x) => [x.feature, x.reason]).sort(), [['F1', 'budget'], ['F2', 'budget']]);
  assert.deepEqual(build.calls.map((c) => c.featureId).sort(), ['F1', 'F2'], 'F3 never started');
  assert.deepEqual(evaluate.calls.map((c) => c.featureId), ['F1'], 'F2 started no eval after the budget stop');
  assert.equal(git(dir, 'rev-parse', 'harness/integration'), git(dir, 'rev-parse', 'main'), 'F1 was not merged after the stop');
});

// ------------------------------------------------------------------ AC-6
test('F24 AC-6: a blocked critical feature stops new starts; the other feature finishes its round and merges', async () => {
  const dir = fixture([{ id: 'F1', tier: 'critical' }, { id: 'F2' }, { id: 'F3' }]);
  const build = slowBuild({ delay: (a) => (a.featureId === 'F1' ? 50 : 700) });
  const evaluate = fakeEvaluate({ F1: ['needs-human'] });
  const r = await run(dir, { build, evaluate }, { parallel: 2 });
  assert.equal(r.stopped?.reason, 'critical_blocked');
  assert.deepEqual(statuses(dir), { F1: 'blocked', F2: 'passed', F3: 'approved' });
  assert.equal(buildsOf(build, 'F3').length, 0);
  assert.match(git(dir, 'log', '-1', '--format=%s', 'harness/integration'), /merge F2/);
});

test('F24 AC-6: after a critical block, a failing round of another feature ends without a next round', async () => {
  const dir = fixture([{ id: 'F1', tier: 'critical' }, { id: 'F2' }]);
  const build = slowBuild({ delay: (a) => (a.featureId === 'F1' ? 50 : 700) });
  const evaluate = fakeEvaluate({ F1: ['needs-human'], F2: [['AC-1']] });
  const r = await run(dir, { build, evaluate }, { parallel: 2, config: { max_rounds: 3 } });
  assert.equal(r.stopped?.reason, 'critical_blocked');
  assert.deepEqual(buildsOf(build, 'F2').map((c) => c.round), [1], 'no round 2');
  const f2 = r.results.find((x) => x.feature === 'F2');
  assert.equal(f2.status, 'blocked');
  assert.equal(f2.reason, 'run_stopped');
});

// ------------------------------------------------------------------ AC-7
test('F24 AC-7: SIGINT stops every step in flight, saves all in-flight features, and --resume passes them all', async () => {
  const dir = fixture([{ id: 'F1' }, { id: 'F2' }]);
  const controller = new AbortController();
  const build1 = slowBuild({
    delay: () => 5000,
    onCall: async (a, calls) => { if (calls.length === 2) setTimeout(() => controller.abort(), 50); },
  });
  const first = await run(dir, { build: build1 }, { parallel: 2, signal: controller.signal });
  assert.equal(first.interrupted, true);
  assert.equal(build1.calls.length, 2);
  for (const c of build1.calls) assert.equal(c.signal.aborted, true, `${c.featureId}'s build step was told to stop`);
  const saved = readJson(statePath(dir));
  assert.deepEqual(saved.active.map((e) => [e.feature, e.round, e.stage]).sort(), [['F1', 1, 'build'], ['F2', 1, 'build']]);
  assert.deepEqual(statuses(dir), { F1: 'in_progress', F2: 'in_progress' });

  const build2 = slowBuild();
  const r = await runFeatures({ root: dir, resume: true, deps: { build: build2, verify: fakeVerify(), evaluate: fakeEvaluate() } });
  assert.equal(r.interrupted, false);
  assert.deepEqual(build2.calls.map((c) => c.featureId).sort(), ['F1', 'F2']);
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed' });
  assert.ok(!fs.existsSync(statePath(dir)));
});

// ------------------------------------------------------------------ AC-8
test('F24 AC-8: with max_parallel 1 features run one at a time', async () => {
  const dir = fixture([{ id: 'F1' }, { id: 'F2' }]);
  const build = slowBuild({ delay: () => 200 });
  // The default became 'auto' in F25; 1 still means one feature at a time.
  const r = await run(dir, { build }, { config: { run: { max_parallel: 1 } } });
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed' });
  assert.ok(!overlap(buildsOf(build, 'F1')[0], buildsOf(build, 'F2')[0]), 'build intervals do not overlap');
  assert.match(fs.readFileSync(r.report, 'utf8'), /max parallel: 1/);
});

// ------------------------------------------------------------------ AC-9
test('F24 AC-9: the report lists every parallel feature and the max_parallel value', async () => {
  const dir = fixture([{ id: 'F1' }, { id: 'F2' }]);
  const r = await run(dir, { build: slowBuild({ delay: () => 200 }) }, { parallel: 2 });
  const md = fs.readFileSync(r.report, 'utf8');
  assert.match(md, /max parallel: 2/);
  assert.match(md, /\| F1 feature F1 \| passed \|/);
  assert.match(md, /\| F2 feature F2 \| passed \|/);
});

test('F24 AC-9: SPEC §8 describes parallel runs, serial merges and concurrent reviews', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s8 = spec.slice(spec.indexOf('## 8.'), spec.indexOf('## 9.'));
  for (const re of [/run\.max_parallel/, /--parallel/, /병합은 한 번에 하나/, /동시에 실행/, /unused/, /critical_blocked/]) assert.match(s8, re);
  const s7 = spec.slice(spec.indexOf('## 7.'), spec.indexOf('## 8.'));
  assert.match(s7, /동시에/);
});

// ------------------------------------------------------------------ SC-1
test('F24 SC-1: each parallel feature builds, verifies and evaluates only in its own worktree; no state write is lost', async () => {
  const dir = fixture([{ id: 'F1' }, { id: 'F2' }, { id: 'F3', deps: ['F1', 'F2'] }]);
  let seenByF3 = null;
  const build = slowBuild({
    delay: (a) => (a.featureId === 'F3' ? 0 : 300),
    onCall: async (a, calls) => {
      if (a.featureId === 'F3') seenByF3 = readJson(statePath(dir));
      await startTogether(['F1', 'F2'])(a, calls);
    },
  });
  const verify = fakeVerify();
  const evaluate = fakeEvaluate({}, { delay: () => 100 });
  await run(dir, { build, verify, evaluate }, { parallel: 2 });
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed', F3: 'passed' });
  assert.ok(overlap(buildsOf(build, 'F1')[0], buildsOf(build, 'F2')[0]));
  const own = (id) => real(path.join(dir, '.harness', 'wt', id));
  for (const c of build.calls) assert.equal(real(c.cwd), own(c.featureId), `builder cwd of ${c.featureId}`);
  for (const c of evaluate.calls) assert.equal(real(c.cwd), own(c.featureId), `evaluator cwd of ${c.featureId}`);
  for (const c of verify.calls.filter((x) => !isIntegration(x.cwd))) assert.equal(real(c.cwd), own(c.featureId), `verify cwd of ${c.featureId}`);
  assert.deepEqual(seenByF3.results.map((x) => [x.feature, x.status]).sort(), [['F1', 'passed'], ['F2', 'passed']], 'both parallel results are in the state file');
});

// ------------------------------------------------------------------ ES-1
const INVALID_CONFIG = [['0', 0], ['negative', -1], ['fraction', 1.5], ['string', '2']];
for (const [name, value] of INVALID_CONFIG) {
  test(`F24 ES-1: run.max_parallel ${name} (${JSON.stringify(value)}) → exit 2 config_invalid, nothing done`, () => {
    const dir = fixture([{ id: 'F1' }], { config: { run: { max_parallel: value } } });
    const r = cli(dir, ['run']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /max_parallel/);
    assert.ok(!branchExists(dir, 'harness/integration'), 'no integration branch');
    assert.ok(!fs.existsSync(path.join(dir, '.harness', 'runs')), 'no run state');
    assert.equal(statuses(dir).F1, 'approved');
  });
}

const INVALID_FLAG = [['0', ['--parallel', '0']], ['negative', ['--parallel', '-1']], ['fraction', ['--parallel', '1.5']],
  ['string', ['--parallel', 'two']], ['missing', ['--parallel']]];
for (const [name, args] of INVALID_FLAG) {
  test(`F24 ES-1: --parallel ${name} → exit 2 usage, nothing done`, () => {
    const dir = fixture([{ id: 'F1' }]);
    const r = cli(dir, ['run', ...args]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--parallel/);
    assert.ok(!branchExists(dir, 'harness/integration'), 'no integration branch');
    assert.ok(!fs.existsSync(path.join(dir, '.harness', 'runs')), 'no run state');
  });
}

test('F24 ES-1: runFeatures rejects a non-positive-integer parallel before any work', async () => {
  const dir = fixture([{ id: 'F1' }]);
  for (const bad of [0, -1, 1.5, '2']) {
    await assert.rejects(run(dir, { build: slowBuild() }, { parallel: bad }), (e) => e.exit === 2 && /--parallel/.test(e.message));
  }
  assert.ok(!branchExists(dir, 'harness/integration'));
});

// ------------------------------------------------------------------ ES-2
test('F24 ES-2: two parallel features changing the same line — the second merge conflicts and only it is blocked', async () => {
  const dir = fixture([{ id: 'F1' }, { id: 'F2' }], { files: { 'shared.txt': 'original\n' } });
  let afterF1 = null;
  const log = (m) => { if (m === 'F1: passed') afterF1 = git(dir, 'rev-parse', 'harness/integration'); };
  const build = slowBuild({
    delay: (a) => (a.featureId === 'F1' ? 1000 : 2000),
    onCall: startTogether(['F1', 'F2']),
    // The one automatic resolution (F25) leaves the conflict markers: the feature stays blocked.
    files: (a) => (a.conflicts ? {} : { [`${a.featureId}.txt`]: 'x\n', 'shared.txt': `changed by ${a.featureId}\n` }),
  });
  const r = await run(dir, { build, log }, { parallel: 2 });
  assert.ok(overlap(buildsOf(build, 'F1')[0], buildsOf(build, 'F2')[0]));
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'blocked' });
  assert.equal(r.results.find((x) => x.feature === 'F2').reason, 'merge_conflict');
  assert.ok(afterF1);
  assert.equal(git(dir, 'rev-parse', 'harness/integration'), afterF1, 'integration is the commit before the failed merge');
  assert.equal(git(dir, 'show', 'harness/integration:shared.txt'), 'changed by F1');
});
