import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { runFeatures } from '../lib/run.mjs';

// F132: run.max_parallel 'auto' is 3 features at once; run_usd is split over the builder calls.

const SCRIPTS = {
  'scripts/has.mjs': "import fs from 'node:fs';\nprocess.exit(process.argv.slice(2).every((f) => fs.existsSync(f)) ? 0 : 1);\n",
};

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id}.txt exists`, check: `node scripts/has.mjs ${id}.txt`, new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-26T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture(ids) {
  const state = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': {
      features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: 'standard', depends_on: [], status: 'approved' })),
    },
  };
  for (const id of ids) state[`.harness/contracts/${id}.json`] = contract(id);
  return gitRepo({ ...state, ...SCRIPTS }, { branch: null });
}

const cfg = ({ run, budget } = {}) => resolveConfig({
  base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60, ...budget }, ...(run ? { run } : {}),
});
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const statuses = (dir) => Object.fromEntries(readJson(path.join(dir, '.harness/features.json')).features.map((f) => [f.id, f.status]));
const statePath = (dir) => path.join(dir, '.harness', 'runs', 'current.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, what) => {
  for (const t0 = Date.now(); !cond();) {
    if (Date.now() - t0 > 30_000) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
};
const IDS5 = ['F1', 'F2', 'F3', 'F4', 'F5'];
const PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const FAILING = { pass: false, commands: [{ command: 'x', exit_code: 1, pass: false, output: 'boom' }], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };

// Fake builder: records each call; `hold(a, call)` may wait; `cost(a, call)` is the call's costUsd.
function fakeBuild({ hold, cost = () => 0 } = {}) {
  const calls = [];
  const fn = async (a) => {
    const c = { featureId: a.featureId, budgetUsd: a.budgetUsd, conflicts: a.conflicts, open: true, n: calls.length };
    calls.push(c);
    if (hold) await hold(a, c);
    writeFiles(a.cwd, { [`${a.featureId}.txt`]: `built ${calls.length}\n` });
    c.open = false;
    return { ok: true, costUsd: cost(a, c) };
  };
  fn.calls = calls;
  fn.peak = 0;
  return fn;
}
const evaluator = () => async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });
const run = (dir, deps, opts = {}) => runFeatures({ root: dir, config: cfg(opts.cfg), deps: { verify: async () => PASSING, evaluate: evaluator(), cpus: 8, ...deps }, ...opts.run });

// Counts the builds open at once; every build waits for `want` open ones (or 30 s), so the
// maximum is reached when the scheduler allows `want`.
function barrier(want) {
  const state = { open: 0, peak: 0 };
  const hold = async (a, c) => {
    state.open += 1;
    state.peak = Math.max(state.peak, state.open);
    await until(() => state.open >= want, `${want} open builds`);
    await sleep(100);
    state.open -= 1;
  };
  return { state, hold };
}

for (const [name, runCfg] of [['unset', undefined], ["'auto'", { max_parallel: 'auto' }]]) {
  test(`F132 AC-1: run.max_parallel ${name} and no --parallel runs at most 3 of 5 features at once`, async () => {
    const dir = fixture(IDS5);
    const b = barrier(3);
    const build = fakeBuild({ hold: b.hold });
    await run(dir, { build }, { cfg: { run: runCfg } });
    assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed', F3: 'passed', F4: 'passed', F5: 'passed' });
    assert.equal(b.state.peak, 3);
  });
}

test('F132 AC-2: run.max_parallel 5 overlaps five builds', async () => {
  const dir = fixture(IDS5);
  const b = barrier(5);
  await run(dir, { build: fakeBuild({ hold: b.hold }) }, { cfg: { run: { max_parallel: 5 } } });
  assert.equal(b.state.peak, 5);
});

test('F132 AC-2: --parallel 5 overlaps five builds', async () => {
  const dir = fixture(IDS5);
  const b = barrier(5);
  await run(dir, { build: fakeBuild({ hold: b.hold }) }, { run: { parallel: 5 } });
  assert.equal(b.state.peak, 5);
});

test('F132 AC-3: the report says auto (3)', async () => {
  const dir = fixture(['F1']);
  const r = await run(dir, { build: fakeBuild() });
  assert.match(fs.readFileSync(r.report, 'utf8'), /^- max parallel: auto \(3\)$/m);
});

test('F132 AC-3: --resume with maxParallel auto in the state file continues at most 3 of 5 active features', async () => {
  const dir = fixture(IDS5);
  const controller = new AbortController();
  const b1 = barrier(5);
  const build1 = fakeBuild({ hold: async (a, c) => { await b1.hold(a, c); await new Promise((r) => a.signal.addEventListener('abort', r, { once: true })); } });
  const first = runFeatures({ root: dir, config: cfg(), parallel: 5, signal: controller.signal, deps: { build: build1, verify: async () => PASSING, evaluate: evaluator(), cpus: 8 } });
  await until(() => build1.calls.length === 5, 'five builds');
  controller.abort();
  assert.equal((await first).interrupted, true);
  const saved = readJson(statePath(dir));
  assert.equal(saved.active.length, 5);
  saved.maxParallel = 'auto';
  fs.writeFileSync(statePath(dir), JSON.stringify(saved));
  const b2 = barrier(3);
  const r = await runFeatures({ root: dir, resume: true, deps: { build: fakeBuild({ hold: b2.hold }), verify: async () => PASSING, evaluate: evaluator(), cpus: 8 } });
  assert.equal(r.interrupted, false);
  assert.equal(b2.state.peak, 3);
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed', F3: 'passed', F4: 'passed', F5: 'passed' });
});

test('F132 AC-4: run_usd 3 and three features starting together give each first builder budgetUsd 1', async () => {
  const dir = fixture(['F1', 'F2', 'F3']);
  const b = barrier(3);
  const build = fakeBuild({ hold: b.hold });
  await run(dir, { build }, { cfg: { budget: { run_usd: 3 } } });
  assert.equal(build.calls.length, 3);
  for (const c of build.calls) assert.ok(Math.abs(c.budgetUsd - 1) < 1e-9, `${c.featureId} got ${c.budgetUsd}`);
});

const near = (x, y) => Math.abs(x - y) < 1e-9;
const callsOf = (build, id) => build.calls.filter((c) => c.featureId === id);

test('F132 AC-5: the next build after a failed verify gets 0.5 while F2 and F3 hold 1 each; assignments never exceed run_usd', async () => {
  const dir = fixture(['F1', 'F2', 'F3']);
  const build = fakeBuild({
    // F2 and F3 keep their builders open until F1's second build has started.
    hold: async (a) => {
      if (a.featureId === 'F1') await until(() => build.calls.length >= 3, 'F2 and F3 builders');
      else await until(() => callsOf(build, 'F1').length >= 2, 'F1 second build');
    },
    cost: (a, c) => (a.featureId === 'F1' && c.n === 0 ? 0.5 : 0),
  });
  let f1Verifies = 0;
  const verify = async (a) => (a.featureId === 'F1' && (f1Verifies += 1) === 1 ? FAILING : PASSING);
  await run(dir, { build, verify }, { cfg: { budget: { run_usd: 3 } } });
  const f1 = callsOf(build, 'F1');
  assert.ok(near(f1[0].budgetUsd, 1), `first F1 build got ${f1[0].budgetUsd}`);
  assert.ok(near(f1[1].budgetUsd, 0.5), `second F1 build got ${f1[1].budgetUsd}`);
  assert.ok(near(callsOf(build, 'F2')[0].budgetUsd, 1) && near(callsOf(build, 'F3')[0].budgetUsd, 1));
});

test('F132 AC-5: at every builder call, cost so far plus the assignments of the calls running is at most run_usd', async () => {
  const dir = fixture(['F1', 'F2', 'F3']);
  let cost = 0;
  const live = new Map();
  const seen = [];
  const build = async (a) => {
    live.set(a.featureId, a.budgetUsd);
    seen.push(cost + [...live.values()].reduce((x, y) => x + y, 0));
    await sleep(30);
    writeFiles(a.cwd, { [`${a.featureId}.txt`]: 'x\n' });
    live.delete(a.featureId);
    const c = a.featureId === 'F1' ? 0.7 : 0.2;
    cost += c;
    return { ok: true, costUsd: c };
  };
  let n = 0;
  await run(dir, { build, verify: async () => (n++ < 2 ? FAILING : PASSING) }, { cfg: { budget: { run_usd: 3 } } });
  assert.ok(seen.length >= 4);
  for (const t of seen) assert.ok(t <= 3 + 1e-9, `reserved ${t}`);
});

test('F132 AC-6: the conflict-resolution builder gets 1 (= 3 - 1 - 1) while another builder holds 1', async () => {
  const ids = ['F1', 'F2', 'F3'];
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: 'standard', depends_on: [], status: 'approved' })) },
    ...Object.fromEntries(ids.map((id) => [`.harness/contracts/${id}.json`, contract(id)])),
    'shared.txt': 'base\n',
    ...SCRIPTS,
  }, { branch: null });
  const calls = [];
  const build = async (a) => {
    calls.push({ featureId: a.featureId, budgetUsd: a.budgetUsd, conflicts: a.conflicts });
    if (a.conflicts) {
      writeFiles(a.cwd, { 'shared.txt': 'both\n' });
      return { ok: true, costUsd: 0 };
    }
    // F3 stays open until the resolution call starts; F2 builds after F1 has merged; F1 waits for both to hold.
    if (a.featureId === 'F1') await until(() => calls.length >= 3, 'F2 and F3 builders');
    if (a.featureId === 'F3') await until(() => calls.some((c) => c.conflicts), 'the conflict resolution call');
    if (a.featureId === 'F2') await until(() => statuses(dir).F1 === 'passed', 'F1 passed');
    if (a.featureId !== 'F3') writeFiles(a.cwd, { [`${a.featureId}.txt`]: 'x\n', 'shared.txt': `changed by ${a.featureId}\n` });
    else writeFiles(a.cwd, { 'F3.txt': 'x\n' });
    return { ok: true, costUsd: a.featureId === 'F1' ? 1 : 0 };
  };
  await run(dir, { build }, { cfg: { budget: { run_usd: 3 } } });
  const res = calls.filter((c) => c.conflicts);
  assert.equal(res.length, 1);
  assert.equal(res[0].featureId, 'F2');
  assert.ok(near(res[0].budgetUsd, 1), `resolution got ${res[0].budgetUsd}`);
});

test('F132 AC-7: one feature at a time gets min(step_usd, run_usd - cost), step_usd alone, or nothing', async () => {
  const runOne = async (budget) => {
    const dir = fixture(['F1']);
    let v = 0;
    const build = fakeBuild({ cost: () => 1.5 });
    await run(dir, { build, verify: async () => (v++ === 0 ? FAILING : PASSING) }, { cfg: { run: { max_parallel: 1 }, budget } });
    return build.calls.map((c) => c.budgetUsd);
  };
  const [a, b] = await runOne({ run_usd: 3, step_usd: 2 });
  assert.ok(near(a, 2) && near(b, 1.5), `${a} ${b}`);
  assert.deepEqual(await runOne({ step_usd: 2 }), [2, 2]);
  const none = await runOne({});
  assert.ok(none.every((x) => x == null));
});

test('F132 ES-1: with nothing left and another builder running, the next builder waits and then gets 0.3, never 0', async () => {
  const dir = fixture(['F1', 'F2']);
  let f1Verified = false;
  const build = fakeBuild({
    hold: async (a) => {
      if (a.featureId === 'F1') await until(() => build.calls.length >= 2, 'F2 builder');
      if (a.featureId === 'F2') await until(() => f1Verified, 'F1 verify');
      if (a.featureId === 'F2') await sleep(300); // F1 reaches its wait
    },
    cost: (a) => (a.featureId === 'F1' ? 1 : 0.4),
  });
  let v = 0;
  const verify = async (a) => {
    if (a.featureId === 'F1' && v++ === 0) { f1Verified = true; return FAILING; }
    return PASSING;
  };
  await run(dir, { build, verify }, { cfg: { run: { max_parallel: 2 }, budget: { run_usd: 2 } } });
  assert.ok(build.calls.every((c) => c.budgetUsd > 0), JSON.stringify(build.calls));
  const f1 = callsOf(build, 'F1');
  assert.equal(f1.length, 2);
  assert.ok(near(f1[1].budgetUsd, 0.3), `second F1 build got ${f1[1].budgetUsd}`);
});

test('F132 ES-2: cost equal to run_usd with nothing running makes no builder call, blocks the feature (budget) and stops the run', async () => {
  const dir = fixture(['F1']);
  const build = fakeBuild({ cost: () => 1 });
  const r = await run(dir, { build, verify: async () => FAILING }, { cfg: { run: { max_parallel: 1 }, budget: { run_usd: 1 } } });
  assert.equal(build.calls.length, 1);
  assert.equal(statuses(dir).F1, 'blocked');
  assert.equal(r.stopped?.reason, 'budget');
  assert.equal(r.results.find((x) => x.feature === 'F1').reason, 'budget');
});

test('F132 AC-8: SPEC §8 and README describe the auto cap of 3 and the builder budget split', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s8 = spec.slice(spec.indexOf('## 8.'), spec.indexOf('## 9.'));
  for (const re of [
    /'auto'`\(기본\).*최대 3/, /명시한 정수는 그대로/,
    /min\(step_usd, \(run_usd−누적 비용−실행 중 배정 합계\) \/ 배정 없는 진행 기능 수\)/,
    /풀릴 때까지 기다린 뒤/, /`blocked`\(`budget`\)/,
  ]) assert.match(s8, re);
  assert.doesNotMatch(s8, /개수 제한 없이 모두 동시에/);
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  const line = readme.split('\n').find((l) => l.includes('**병렬**'));
  assert.ok(line && !line.includes('제한 없이') && /3/.test(line), line);
});
