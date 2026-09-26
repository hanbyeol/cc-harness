import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BIN, REPO } from './helpers.mjs';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { runFeatures, verifyParallelFor, isSerializedGit, git as coreGit } from '../lib/run.mjs';

// ------------------------------------------------------------------ fixtures

const SCRIPTS = {
  'scripts/has.mjs': "import fs from 'node:fs';\nprocess.exit(process.argv.slice(2).every((f) => fs.existsSync(f)) ? 0 : 1);\n",
  'scripts/ok.mjs': 'process.exit(0);\n',
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

// A repo on `main` with initialized .harness state; `run` is written to config.json as given.
function fixture(ids, { run, files = {} } = {}) {
  const state = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...(run ? { run } : {}) },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': {
      features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: 'standard', depends_on: [], status: 'approved' })),
    },
  };
  for (const id of ids) state[`.harness/contracts/${id}.json`] = contract(id);
  return gitRepo({ ...state, ...SCRIPTS, ...files }, { branch: null });
}

// No run.max_parallel / run.verify_parallel unless given: the defaults are what is tested.
const cfg = (run) => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, ...(run ? { run } : {}) });

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const statuses = (dir) => Object.fromEntries(readJson(path.join(dir, '.harness/features.json')).features.map((f) => [f.id, f.status]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const real = (p) => path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
const isIntegration = (cwd) => real(cwd).endsWith(`${path.sep}_integration`);
const overlap = (a, b) => a.start < b.end && b.start < a.end;
const IDS4 = ['F1', 'F2', 'F3', 'F4'];

// Highest number of intervals open at the same time.
function maxConcurrent(intervals) {
  const ev = intervals.flatMap((x) => [[x.start, 1], [x.end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0;
  let max = 0;
  for (const [, d] of ev) { open += d; max = Math.max(max, open); }
  return max;
}

const PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };

// Fake builder: waits `delay(a)` ms, writes files (default <id>.txt), records the call.
function slowBuild({ delay = () => 0, files, onCall, result } = {}) {
  const calls = [];
  const fn = async (a) => {
    const c = { featureId: a.featureId, round: a.round, cwd: a.cwd, conflicts: a.conflicts, start: now(), end: null };
    calls.push(c);
    if (onCall) await onCall(a, c);
    await sleep(delay(a));
    writeFiles(a.cwd, files ? files(a) : { [`${a.featureId}.txt`]: `built r${a.round}\n` });
    c.end = now();
    return result ? result(a) : { ok: true, costUsd: 0 };
  };
  fn.calls = calls;
  return fn;
}

function fakeEvaluate() {
  const calls = [];
  const fn = async (a) => {
    calls.push({ featureId: a.featureId, round: a.round, cwd: a.cwd, base: a.base });
    return { feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null };
  };
  fn.calls = calls;
  return fn;
}

// Fake verify: every call is an interval of `delay` ms (feature and post-merge verifies alike).
function timedVerify({ delay = 0 } = {}) {
  const calls = [];
  const fn = async (a) => {
    const c = { featureId: a.featureId, cwd: a.cwd, integration: isIntegration(a.cwd), start: now(), end: null };
    calls.push(c);
    await sleep(delay);
    c.end = now();
    return PASSING;
  };
  fn.calls = calls;
  return fn;
}

const run = (dir, deps, { run: runCfg, ...opts } = {}) => runFeatures({
  root: dir, config: cfg(runCfg),
  deps: { verify: timedVerify(), evaluate: fakeEvaluate(), cpus: 8, ...deps }, ...opts,
});
const cli = (dir, args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8' });
const branchExists = (dir, b) => spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { cwd: dir }).status === 0;
const builds = (build, id) => build.calls.filter((c) => c.featureId === id && !c.conflicts);

// ------------------------------------------------------------------ AC-1
for (const [name, runCfg] of [['unset', undefined], ["'auto'", { max_parallel: 'auto' }]]) {
  test(`F25 AC-1: run.max_parallel ${name} and no --parallel starts all four ready features at once`, async () => {
    const dir = fixture(IDS4);
    const build = slowBuild({ delay: () => 1500 });
    const r = await run(dir, { build }, { run: runCfg });
    assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed', F3: 'passed', F4: 'passed' });
    const first = IDS4.map((id) => builds(build, id)[0]);
    const lastStart = Math.max(...first.map((c) => c.start));
    const firstEnd = Math.min(...first.map((c) => c.end));
    assert.ok(lastStart < firstEnd, `all four builds are open at one instant: ${JSON.stringify(first.map((c) => [c.start, c.end]))}`);
    assert.match(fs.readFileSync(r.report, 'utf8'), /max parallel: auto/);
  });
}

// ------------------------------------------------------------------ AC-2
test('F25 AC-2: run.max_parallel 2 caps concurrent features at 2', async () => {
  const dir = fixture(IDS4);
  const build = slowBuild({ delay: () => 600 });
  await run(dir, { build }, { run: { max_parallel: 2 } });
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed', F3: 'passed', F4: 'passed' });
  assert.equal(maxConcurrent(build.calls), 2);
});

test('F25 AC-2: --parallel 1 overrides auto and runs features one at a time', async () => {
  const dir = fixture(['F1', 'F2', 'F3']);
  const build = slowBuild({ delay: () => 200 });
  const r = await run(dir, { build }, { run: { max_parallel: 'auto' }, parallel: 1 });
  assert.equal(maxConcurrent(build.calls), 1);
  assert.match(fs.readFileSync(r.report, 'utf8'), /max parallel: 1\n/);
});

test('F25 AC-2: --parallel 3 caps four features at 3', async () => {
  const dir = fixture(IDS4);
  const build = slowBuild({ delay: () => 600 });
  await run(dir, { build }, { parallel: 3 });
  assert.equal(maxConcurrent(build.calls), 3);
});

// ------------------------------------------------------------------ AC-3
test('F25 AC-3: verify_parallel auto is max(1, floor(cpus / 8)); an integer is used as is', () => {
  assert.equal(verifyParallelFor('auto', 8), 1);
  assert.equal(verifyParallelFor('auto', 16), 2);
  assert.equal(verifyParallelFor('auto', 4), 1);
  assert.equal(verifyParallelFor(undefined, 24), 3);
  assert.equal(verifyParallelFor(5, 4), 5);
});

for (const [cpus, pool] of [[8, 1], [16, 2], [4, 1]]) {
  test(`F25 AC-3: with ${cpus} CPUs (auto) at most ${pool} verify runs at a time; builds are not limited by the pool`, async () => {
    const dir = fixture(IDS4);
    const build = slowBuild({ delay: () => 800 });
    // Verify outlasts the spread of build ends (worktree adds are serialized), so all four queue up.
    const verify = timedVerify({ delay: 1500 });
    await run(dir, { build, verify, cpus });
    assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed', F3: 'passed', F4: 'passed' });
    assert.equal(verify.calls.filter((c) => c.integration).length, 4, 'post-merge verifies are in the pool too');
    assert.equal(maxConcurrent(verify.calls), pool, 'verify concurrency equals the pool size');
    assert.equal(maxConcurrent(build.calls), 4, 'build runs outside the verify pool');
  });
}

test('F25 AC-3: run.verify_parallel 3 caps verify at 3 regardless of the CPU count', async () => {
  const dir = fixture(IDS4);
  const verify = timedVerify({ delay: 2000 });
  await run(dir, { build: slowBuild({ delay: () => 300 }), verify, cpus: 64 }, { run: { verify_parallel: 3 } });
  assert.equal(maxConcurrent(verify.calls), 3);
});

// ------------------------------------------------------------------ AC-4
test('F25 AC-4: worktree add/remove, branch create/delete and merge calls never overlap across four parallel features', async () => {
  const dir = fixture(IDS4);
  const calls = [];
  const recorder = async (args, cwd) => {
    const c = { args, start: now(), end: null };
    if (isSerializedGit(args)) calls.push(c);
    // Long enough that two unserialized calls would overlap.
    if (isSerializedGit(args)) await sleep(60);
    const r = await coreGit(args, cwd);
    c.end = now();
    return r;
  };
  const build = slowBuild({ delay: (a) => ({ F1: 0, F2: 30, F3: 60, F4: 90 })[a.featureId] });
  await run(dir, { build, git: recorder });
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed', F3: 'passed', F4: 'passed' });
  const kinds = (pred) => calls.filter((c) => pred(c.args)).length;
  assert.equal(kinds((a) => a[0] === 'worktree' && a[1] === 'add'), 5, 'integration + four feature worktrees');
  assert.equal(kinds((a) => a[0] === 'worktree' && a[1] === 'remove'), 5);
  assert.equal(kinds((a) => a[0] === 'merge'), 4);
  assert.ok(kinds((a) => a[0] === 'branch') >= 5, 'integration branch created, four feature branches deleted');
  for (let i = 0; i < calls.length; i += 1) {
    for (let j = i + 1; j < calls.length; j += 1) {
      assert.ok(!overlap(calls[i], calls[j]), `git ${calls[i].args.join(' ')} overlaps git ${calls[j].args.join(' ')}`);
    }
  }
});

// ------------------------------------------------------------------ AC-5 / AC-6 / SC-1 fixtures

// F1 and F2 change the same line of shared.txt; F1 finishes first, so F2's merge conflicts.
function conflictFixture() {
  return fixture(['F1', 'F2'], { files: { 'shared.txt': 'original\n' } });
}
const sharedEdit = (a) => ({ [`${a.featureId}.txt`]: 'x\n', 'shared.txt': `changed by ${a.featureId}\n` });

test('F25 AC-5: a merge conflict goes to the builder once with the files, then verify, eval and merge → passed', async () => {
  const dir = conflictFixture();
  let seen = null;
  const build = slowBuild({
    delay: (a) => (a.featureId === 'F1' ? 0 : 1500),
    onCall: async (a) => {
      if (!a.conflicts) return;
      const wt = path.join(dir, '.harness', 'wt', 'F2');
      seen = {
        conflicts: a.conflicts,
        mergeHead: spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: wt }).status === 0,
        markers: fs.readFileSync(path.join(wt, 'shared.txt'), 'utf8').includes('<<<<<<<'),
      };
    },
    files: (a) => (a.conflicts ? { 'shared.txt': 'changed by F1 and F2\n' } : sharedEdit(a)),
  });
  const evaluate = fakeEvaluate();
  const verify = timedVerify();
  const r = await run(dir, { build, evaluate, verify });
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed' });
  assert.deepEqual(seen, { conflicts: ['shared.txt'], mergeHead: true, markers: true }, 'the core left F2 in the conflicted merge');
  assert.equal(build.calls.filter((c) => c.conflicts).length, 1, 'one resolution call');
  assert.equal(evaluate.calls.filter((c) => c.featureId === 'F2').length, 2, 'F2 evaluated again after the resolution');
  const f2Verifies = verify.calls.filter((c) => c.featureId === 'F2' && !c.integration);
  assert.equal(f2Verifies.length, 2, 'F2 verified again after the resolution');
  assert.equal(git(dir, 'show', 'harness/integration:shared.txt'), 'changed by F1 and F2');
  assert.equal(git(dir, 'show', 'harness/integration:F2.txt'), 'x');
  const f2 = r.results.find((x) => x.feature === 'F2');
  assert.equal(f2.conflictResolution, 'resolved');
  assert.equal(f2.rounds, 1);
});

async function blockedAfterResolution(files, { result, onCall } = {}) {
  const dir = conflictFixture();
  let afterF1 = null;
  const log = (m) => { if (m === 'F1: passed') afterF1 = git(dir, 'rev-parse', 'harness/integration'); };
  const build = slowBuild({
    delay: (a) => (a.featureId === 'F1' ? 0 : 1500),
    files: (a) => (a.conflicts ? files(a, dir) : sharedEdit(a)),
    result: (a) => (a.conflicts && result ? result : { ok: true, costUsd: 0 }),
    onCall: onCall ? (a) => onCall(a, dir) : undefined,
  });
  const evaluate = fakeEvaluate();
  const r = await run(dir, { build, evaluate, log });
  return { dir, r, build, evaluate, afterF1, f2: r.results.find((x) => x.feature === 'F2') };
}

test('F25 AC-6: the resolving builder fails → blocked(merge_conflict), integration is the pre-merge commit', async () => {
  const x = await blockedAfterResolution(() => ({}), { result: { ok: false, error: 'exit_nonzero', costUsd: 0 } });
  assert.deepEqual(statuses(x.dir), { F1: 'passed', F2: 'blocked' });
  assert.equal(x.f2.reason, 'merge_conflict');
  assert.equal(x.f2.conflictResolution, 'failed');
  assert.equal(git(x.dir, 'rev-parse', 'harness/integration'), x.afterF1);
});

test('F25 AC-6: conflict markers left after the resolution → blocked(merge_conflict), integration unchanged', async () => {
  const x = await blockedAfterResolution(() => ({})); // writes nothing: the markers stay
  assert.deepEqual(statuses(x.dir), { F1: 'passed', F2: 'blocked' });
  assert.equal(x.f2.reason, 'merge_conflict');
  assert.match(x.f2.detail, /marker/);
  assert.equal(git(x.dir, 'rev-parse', 'harness/integration'), x.afterF1);
  assert.equal(x.evaluate.calls.filter((c) => c.featureId === 'F2').length, 1, 'no evaluation of an unresolved merge');
});

test('F25 AC-6: the merge conflicts again after the resolution → blocked(merge_conflict); resolution is once per feature and uses no round', async () => {
  let intTip = null;
  const x = await blockedAfterResolution(() => ({ 'shared.txt': 'changed by F1 and F2\n' }), {
    onCall: (a, dir) => {
      if (!a.conflicts) return;
      // someone lands another conflicting change on integration while the builder resolves
      const intWt = path.join(dir, '.harness', 'wt', '_integration');
      writeFiles(intWt, { 'shared.txt': 'human\n' });
      intTip = commitAll(intWt, 'conflicting change');
    },
  });
  assert.deepEqual(statuses(x.dir), { F1: 'passed', F2: 'blocked' });
  assert.equal(x.f2.reason, 'merge_conflict');
  assert.equal(x.build.calls.filter((c) => c.conflicts).length, 1, 'one resolution only');
  assert.equal(x.f2.rounds, 1, 'no round consumed');
  assert.deepEqual(x.build.calls.filter((c) => c.featureId === 'F2').map((c) => c.round), [1, 1]);
  assert.equal(git(x.dir, 'rev-parse', 'harness/integration'), intTip, 'integration is the commit before F2\'s merge');
});

// ------------------------------------------------------------------ AC-7
test('F25 AC-7: the report shows the applied max_parallel and verify_parallel and conflict resolution per feature', async () => {
  const dir = conflictFixture();
  const build = slowBuild({
    delay: (a) => (a.featureId === 'F1' ? 0 : 1500),
    files: (a) => (a.conflicts ? { 'shared.txt': 'both\n' } : sharedEdit(a)),
  });
  const r = await run(dir, { build, cpus: 16 });
  const md = fs.readFileSync(r.report, 'utf8');
  assert.match(md, /- max parallel: auto \(no limit\)/);
  assert.match(md, /- verify parallel: 2 \(auto: 16 CPUs \/ 8\)/);
  assert.match(md, /Conflict resolution/);
  assert.match(md, /\| F1 feature F1 \| passed \|.*\| no \|$/m);
  assert.match(md, /\| F2 feature F2 \| passed \|.*\| resolved \|$/m);
});

test('F25 AC-7: the report shows explicit max_parallel and verify_parallel values', async () => {
  const dir = fixture(['F1']);
  const r = await run(dir, { build: slowBuild() }, { run: { max_parallel: 3, verify_parallel: 2 } });
  const md = fs.readFileSync(r.report, 'utf8');
  assert.match(md, /- max parallel: 3\n/);
  assert.match(md, /- verify parallel: 2\n/);
});

test('F25 AC-7: SPEC §8 and README describe auto parallel, the verify pool and automatic conflict resolution', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s8 = spec.slice(spec.indexOf('## 8.'), spec.indexOf('## 9.'));
  for (const re of [/run\.max_parallel.*'auto'/, /run\.verify_parallel/, /floor\(CPU 수 \/ 8\)/, /잠금/, /충돌 해결/, /<<<<<<</, /라운드를 소모하지 않는다/]) {
    assert.match(s8, re);
  }
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  for (const re of [/max_parallel/, /'auto'/, /verify_parallel/, /충돌/]) assert.match(readme, re);
});

// ------------------------------------------------------------------ SC-1
test('F25 SC-1: the resolving builder runs only in the feature worktree; integration does not move until the resolution passed', async () => {
  const dir = conflictFixture();
  let atConflict = null;
  let duringResolve = null;
  let resolveCwd = null;
  const log = (m) => { if (/^F2: merge conflict/.test(m)) atConflict = git(dir, 'rev-parse', 'harness/integration'); };
  const evaluate = fakeEvaluate();
  const evalWrap = async (a) => {
    if (a.featureId === 'F2' && duringResolve) assert.equal(git(dir, 'rev-parse', 'harness/integration'), atConflict, 'unchanged during the re-evaluation');
    return evaluate(a);
  };
  const build = slowBuild({
    delay: (a) => (a.featureId === 'F1' ? 0 : 1500),
    onCall: async (a) => {
      if (!a.conflicts) return;
      resolveCwd = a.cwd;
      duringResolve = git(dir, 'rev-parse', 'harness/integration');
    },
    files: (a) => (a.conflicts ? { 'shared.txt': 'both\n' } : sharedEdit(a)),
  });
  await run(dir, { build, evaluate: evalWrap, log });
  assert.ok(atConflict);
  assert.equal(real(resolveCwd), real(path.join(dir, '.harness', 'wt', 'F2')));
  assert.equal(duringResolve, atConflict, 'integration unchanged while the builder resolves');
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed' });
  assert.notEqual(git(dir, 'rev-parse', 'harness/integration'), atConflict, 'it moves only with the final merge');
  assert.equal(git(dir, 'rev-parse', 'harness/integration^1'), atConflict);
});

// ------------------------------------------------------------------ ES-1
const INVALID = [
  ['max_parallel', 'string', 'fast'], ['max_parallel', '0', 0], ['max_parallel', 'fraction', 1.5],
  ['verify_parallel', 'string', 'fast'], ['verify_parallel', '0', 0], ['verify_parallel', 'fraction', 1.5],
  ['verify_parallel', 'negative', -1], ['verify_parallel', 'numeric string', '2'], ['verify_parallel', 'null', null],
];
for (const [key, name, value] of INVALID) {
  test(`F25 ES-1: run.${key} ${name} (${JSON.stringify(value)}) → exit 2 config_invalid naming the key, nothing done`, () => {
    const dir = fixture(['F1'], { run: { [key]: value } });
    const r = cli(dir, ['run']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, new RegExp(`run\\.${key}`));
    assert.ok(!branchExists(dir, 'harness/integration'), 'no integration branch');
    assert.ok(!fs.existsSync(path.join(dir, '.harness', 'runs')), 'no run state');
    assert.equal(statuses(dir).F1, 'approved');
  });
}

// ------------------------------------------------------------------ ES-2
test('F25 ES-2: in an auto parallel run a failing git worktree add blocks only that feature (worktree)', async () => {
  const dir = fixture(['F1', 'F2', 'F3']);
  writeFiles(dir, { '.harness/wt/F2/occupied.txt': 'in the way\n' }); // gitignored: worktree add fails
  // Long enough to outlast the serialized worktree adds of the other features.
  const build = slowBuild({ delay: () => 1500 });
  const r = await run(dir, { build });
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'blocked', F3: 'passed' });
  assert.equal(r.results.find((x) => x.feature === 'F2').reason, 'worktree');
  assert.equal(builds(build, 'F2').length, 0);
  assert.ok(overlap(builds(build, 'F1')[0], builds(build, 'F3')[0]), 'the others ran in parallel');
});
