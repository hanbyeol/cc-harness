// F91: in a parallel run a feature that passed eval, while integration moved past its base,
// merges integration into its worktree and verifies that before it takes the merge lock
// (pre_merge_verify, outside the lock). The merge in the lock then makes the same tree, so its
// post-merge verify is a result-cache hit unless integration moved again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpdir } from './helpers.mjs';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { verify as realVerify } from '../lib/verify.mjs';
import * as run from '../lib/run.mjs';

// ------------------------------------------------------------------ fixtures

// What `harness init` writes, so the core's own ignored records are as in a real project.
const HARNESS_IGNORE = 'wt/\n*.tmp-*\nruns/test-count-cache.json\nruns/verify-cache.json\n';
const slash = (p) => p.split(path.sep).join('/');
const quoted = (p) => JSON.stringify(slash(p));

// rec.mjs appends its cwd to the log named by its first argument and exits 0 iff every further
// argument names an existing file. AC-1 (<id>.txt exists) is new.
function contract(id, log) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id}.txt exists`, check: `node scripts/rec.mjs ${quoted(log)} ${id}.txt`, new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-09T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture(ids = ['F1']) {
  const log = path.join(tmpdir('harness-f91-log-'), 'log.txt');
  const files = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': HARNESS_IGNORE,
    '.harness/features.json': {
      features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: 'standard', depends_on: [], status: 'approved' })),
    },
    'scripts/rec.mjs': "import fs from 'node:fs';\nconst [log, ...need] = process.argv.slice(2);\n"
      + "fs.appendFileSync(log, `${fs.realpathSync.native(process.cwd())}\\n`);\n"
      + 'process.exit(need.every((f) => fs.existsSync(f)) ? 0 : 1);\n',
    'shared.txt': 'original\n',
  };
  for (const id of ids) files[`.harness/contracts/${id}.json`] = contract(id, log);
  return { dir: gitRepo(files, { branch: null }), log };
}

const cfg = (over = {}) => resolveConfig({
  base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, ...over,
});
const real = (p) => fs.realpathSync.native(p);
const intWt = (dir) => path.join(dir, '.harness', 'wt', '_integration');
const featureWt = (dir, id = 'F1') => path.join(dir, '.harness', 'wt', id);
// The real path of a worktree that may be gone: the repo dir is already a real path.
const realWt = (dir, id) => path.join(fs.realpathSync.native(dir), '.harness', 'wt', id);
const isIntegration = (cwd) => real(cwd).endsWith(`${path.sep}_integration`);
const integ = (dir) => git(dir, 'rev-parse', 'harness/integration');
const hasMergeHead = (wt) => spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: wt }).status === 0;
const isAncestor = (wt, a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: wt }).status === 0;
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const statuses = (dir) => Object.fromEntries(readJson(path.join(dir, '.harness/features.json')).features.map((f) => [f.id, f.status]));
const resultOf = (r, id = 'F1') => r.results.find((x) => x.feature === id);
const runsDir = (dir) => path.join(dir, '.harness', 'runs');
const metrics = (dir) => fs.readdirSync(runsDir(dir)).filter((n) => n.endsWith('.metrics.jsonl'))
  .flatMap((n) => fs.readFileSync(path.join(runsDir(dir), n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const stepsOf = (dir, feature, step) => metrics(dir).filter((m) => m.feature === feature && m.step === step);

const OK_INTEGRITY = { markers: [], harnessPaths: [], testCount: { status: 'unset' } };
const PASSING = { pass: true, commands: [], criteria: [{ id: 'AC-1', pass: true }], integrity: OK_INTEGRITY, warnings: [] };
const FAILING = {
  pass: false, commands: [{ cmd: 'npm test', pass: false, message: 'exit 1', output: 'boom' }],
  criteria: [{ id: 'AC-1', pass: true }], integrity: OK_INTEGRITY, warnings: [],
};
const evaluate = async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });

// A commit lands on integration while F1 builds: F1's base is no longer integration's tip.
const landOnIntegration = (dir, files, message = 'meanwhile on integration') => {
  writeFiles(intWt(dir), files);
  return commitAll(intWt(dir), message);
};

// A builder that writes <id>.txt (plus `edit`); `onBuild` runs first, `onRecover` for a recovery.
function fakeBuild({ edit = {}, onBuild, recover = { 'fixed.txt': 'fixed\n' } } = {}) {
  const calls = [];
  const fn = async (a) => {
    const kind = a.postMergeFailures ? 'recover' : a.conflicts ? 'resolve' : 'build';
    calls.push({ kind, feature: a.featureId, round: a.round, attempt: a.attempt });
    if (kind === 'build' && onBuild) await onBuild(a);
    writeFiles(a.cwd, kind === 'recover' ? recover : kind === 'resolve' ? { 'shared.txt': 'both\n' } : { [`${a.featureId}.txt`]: 'built\n', ...edit });
    return { ok: true, costUsd: 0 };
  };
  fn.calls = calls;
  fn.of = (kind) => calls.filter((c) => c.kind === kind);
  return fn;
}

// A core git that records every call (and its cwd) on the way through.
function recordingGit() {
  const calls = [];
  const fn = async (args, cwd, opts) => {
    // Real paths now: worktrees are removed when the run ends.
    const c = { args, cwd: real(cwd), integration: isIntegration(cwd), code: null };
    calls.push(c);
    const r = await run.git(args, cwd, opts);
    c.code = r.code;
    return r;
  };
  fn.calls = calls;
  return fn;
}
const preMergeMerges = (g) => g.calls.filter((c) => c.args[0] === 'merge' && c.args.some((x) => String(x).endsWith('(pre-merge verify)')));
const lockMerges = (g) => g.calls.filter((c) => c.args[0] === 'merge' && c.args[1] === '--no-ff' && c.integration);

// Waits until `cond()` holds, at most `ms`.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 30_000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  return cond();
}

const runF = (dir, deps, config = cfg()) => run.runFeatures({ root: dir, config, deps: { evaluate, cpus: 8, ...deps } });

// ------------------------------------------------------------------ AC-1
test('F91 AC-1: integration ahead of the feature base → integration merged into the feature worktree and verified there (pre_merge_verify) before the merge lock', async () => {
  const { dir } = fixture();
  let intTip = null;
  const build = fakeBuild({ onBuild: () => { intTip = landOnIntegration(dir, { 'other.txt': 'other\n' }); } });
  const seen = [];
  const verify = async (a) => {
    if (a.step === 'pre_merge_verify') {
      seen.push({
        cwd: real(a.cwd), base: a.base,
        containsIntegration: isAncestor(a.cwd, intTip, 'HEAD'),
        files: ['F1.txt', 'other.txt'].filter((f) => fs.existsSync(path.join(a.cwd, f))),
        integrationAt: integ(dir),
      });
    }
    return PASSING;
  };
  const g = recordingGit();
  const r = await runF(dir, { build, verify, git: g });
  assert.equal(resultOf(r).status, 'passed', JSON.stringify(r.results));
  assert.equal(seen.length, 1, 'one pre-merge verify');
  assert.equal(seen[0].cwd, realWt(dir, 'F1'), 'in the feature worktree');
  assert.equal(seen[0].base, intTip, 'judged against the integration commit it contains');
  assert.equal(seen[0].containsIntegration, true);
  assert.deepEqual(seen[0].files, ['F1.txt', 'other.txt']);
  assert.equal(seen[0].integrationAt, intTip, 'before the merge into integration');
  const merges = preMergeMerges(g);
  assert.equal(merges.length, 1, 'integration merged into the feature worktree once');
  assert.equal(merges[0].cwd, realWt(dir, 'F1'));
  assert.equal(merges[0].code, 0);
  const pre = stepsOf(dir, 'F1', 'pre_merge_verify');
  assert.equal(pre.length, 1, JSON.stringify(metrics(dir)));
  assert.equal(pre[0].outcome, 'pass');
  assert.equal(pre[0].role, 'core');
  assert.equal(pre[0].round, 1);
  assert.ok(Number.isInteger(pre[0].queue_ms) && pre[0].queue_ms >= 0, JSON.stringify(pre[0]));
  assert.equal(pre[0].cached, false);
  const merge = stepsOf(dir, 'F1', 'merge');
  assert.equal(merge.length, 1);
  assert.ok(pre[0].ended_at <= merge[0].started_at, 'the pre-merge verify ended before the merge');
  for (const f of ['F1.txt', 'other.txt']) git(dir, 'cat-file', '-e', `harness/integration:${f}`);
});

// ------------------------------------------------------------------ AC-2
test('F91 AC-2: one feature\'s pre_merge_verify overlaps the other feature\'s post-merge verify (outside the merge lock)', async () => {
  const { dir } = fixture(['F1', 'F2']);
  const spans = {};
  const started = (k) => Boolean(spans[k]);
  const verify = async (a) => {
    const k = `${a.featureId} ${a.step}`;
    if (k === 'F1 post_merge_verify' || k === 'F2 pre_merge_verify') {
      spans[k] = { start: performance.now(), end: null };
      // Each waits until the other has started, at most 30 seconds.
      await waitFor(() => started(k === 'F1 post_merge_verify' ? 'F2 pre_merge_verify' : 'F1 post_merge_verify'));
      spans[k].end = performance.now();
    }
    return PASSING;
  };
  // F2 is evaluated only once F1 is merged: integration is then ahead of F2's base.
  const evalF2Later = async (a) => {
    if (a.featureId === 'F2') await waitFor(() => started('F1 post_merge_verify'));
    return evaluate(a);
  };
  const config = cfg({ run: { max_parallel: 2, verify_parallel: 2 } });
  const r = await runF(dir, { build: fakeBuild(), verify, evaluate: evalF2Later }, config);
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed' }, JSON.stringify(r.results));
  const post = spans['F1 post_merge_verify'];
  const pre = spans['F2 pre_merge_verify'];
  assert.ok(post && pre, JSON.stringify(spans));
  assert.ok(pre.start < post.end && post.start < pre.end, `the intervals overlap: ${JSON.stringify(spans)}`);
  assert.equal(stepsOf(dir, 'F2', 'pre_merge_verify').length, 1);
  assert.equal(stepsOf(dir, 'F1', 'pre_merge_verify').length, 0, 'F1 merged first, on its own base');
});

// ------------------------------------------------------------------ AC-3
test('F91 AC-3: with real verify, the second feature\'s post-merge verify after its passed pre_merge_verify is a cache hit', async () => {
  const { dir, log } = fixture(['F1', 'F2']);
  let f1Done = false;
  const steps = [];
  const verify = async (a) => {
    const v = await realVerify(a);
    steps.push({ feature: a.featureId, step: a.step, status: v.cache?.status, pass: v.pass });
    if (a.featureId === 'F1' && a.step === 'post_merge_verify') f1Done = true;
    return v;
  };
  const evalF2Later = async (a) => {
    if (a.featureId === 'F2') await waitFor(() => f1Done, 120_000);
    return evaluate(a);
  };
  const config = cfg({ run: { max_parallel: 2 } });
  const r = await runF(dir, { build: fakeBuild(), verify, evaluate: evalF2Later }, config);
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed' }, JSON.stringify(r.results));
  const pre = stepsOf(dir, 'F2', 'pre_merge_verify');
  assert.equal(pre.length, 1, JSON.stringify(steps));
  assert.equal(pre[0].outcome, 'pass');
  assert.equal(pre[0].cached, false);
  const post = stepsOf(dir, 'F2', 'post_merge_verify');
  assert.equal(post.length, 1);
  assert.equal(post[0].outcome, 'pass');
  assert.equal(post[0].cached, true, JSON.stringify(steps));
  // Control: F1 merged on its own base — its post-merge verify ran (no pre-merge verify, F87/F92 path).
  assert.equal(stepsOf(dir, 'F1', 'pre_merge_verify').length, 0);
  assert.ok(fs.readFileSync(log, 'utf8').length > 0);
});

// ------------------------------------------------------------------ AC-4
test('F91 AC-4: integration moved again after the pre_merge_verify → the post-merge verify runs everything (cached false)', async () => {
  const { dir, log } = fixture();
  let moved = null;
  const steps = [];
  const verify = async (a) => {
    const v = await realVerify(a);
    steps.push({ step: a.step, status: v.cache?.status });
    // Another feature merges first, right after this feature's pre-merge verify.
    if (a.step === 'pre_merge_verify') moved = landOnIntegration(dir, { 'later.txt': 'later\n' }, 'merged first');
    return v;
  };
  const build = fakeBuild({ onBuild: () => landOnIntegration(dir, { 'other.txt': 'other\n' }) });
  const r = await runF(dir, { build, verify });
  assert.equal(resultOf(r).status, 'passed', JSON.stringify(r.results));
  const post = stepsOf(dir, 'F1', 'post_merge_verify');
  assert.equal(post.length, 1);
  assert.equal(post[0].cached, false, JSON.stringify(steps));
  assert.equal(steps.find((s) => s.step === 'post_merge_verify').status, 'miss');
  // The criterion check ran in the integration worktree.
  const ranOn = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.ok(ranOn.includes(realWt(dir, '_integration')), ranOn.join('\n'));
  assert.ok(moved);
  git(dir, 'cat-file', '-e', 'harness/integration:later.txt');
});

// ------------------------------------------------------------------ AC-5
test('F91 AC-5: integration equal to the feature base → no pre_merge_verify, merged as before', async () => {
  const { dir } = fixture();
  const verifies = [];
  const verify = async (a) => {
    verifies.push(a.step);
    return PASSING;
  };
  const g = recordingGit();
  const r = await runF(dir, { build: fakeBuild(), verify, git: g });
  assert.equal(resultOf(r).status, 'passed', JSON.stringify(r.results));
  assert.deepEqual(verifies, ['verify', 'post_merge_verify']);
  assert.equal(stepsOf(dir, 'F1', 'pre_merge_verify').length, 0);
  assert.equal(preMergeMerges(g).length, 0);
  assert.equal(lockMerges(g).length, 1);
});

// ------------------------------------------------------------------ AC-6
test('F91 AC-6: integration conflicting with the feature worktree → that merge is undone, no pre_merge_verify, then the conflict flow as before', async () => {
  const { dir } = fixture();
  const build = fakeBuild({
    edit: { 'shared.txt': 'changed by F1\n' },
    onBuild: () => landOnIntegration(dir, { 'shared.txt': 'changed on integration\n' }),
  });
  const verifies = [];
  const verify = async (a) => {
    verifies.push(a.step);
    return PASSING;
  };
  const g = recordingGit();
  let atLockMerge = null;
  const watch = async (args, cwd, opts) => {
    if (args[0] === 'merge' && args[1] === '--no-ff' && isIntegration(cwd) && !atLockMerge) {
      const wt = featureWt(dir);
      atLockMerge = {
        head: git(wt, 'rev-parse', 'HEAD'),
        branchHead: git(wt, 'rev-parse', 'harness/F1'),
        branch: git(wt, 'symbolic-ref', '--short', 'HEAD'),
        mergeHead: hasMergeHead(wt),
        status: git(wt, 'status', '--porcelain'),
        shared: fs.readFileSync(path.join(wt, 'shared.txt'), 'utf8'),
      };
    }
    return g(args, cwd, opts);
  };
  const r = await runF(dir, { build, verify, git: watch });
  const merges = preMergeMerges(g);
  assert.equal(merges.length, 1, 'the pre-merge merge was tried');
  assert.notEqual(merges[0].code, 0, 'and conflicted');
  assert.equal(stepsOf(dir, 'F1', 'pre_merge_verify').length, 0);
  assert.ok(!verifies.includes('pre_merge_verify'), verifies.join(','));
  assert.ok(atLockMerge, 'the merge into integration followed');
  assert.equal(atLockMerge.branch, 'harness/F1');
  assert.equal(atLockMerge.head, atLockMerge.branchHead);
  assert.equal(git(dir, 'log', '-1', '--format=%s', atLockMerge.head), 'harness: F1 round 1 builder changes', 'the commit before the merge');
  assert.equal(atLockMerge.mergeHead, false, 'no MERGE_HEAD');
  assert.equal(atLockMerge.status, '');
  assert.equal(atLockMerge.shared, 'changed by F1\n');
  // The conflict flow of before: one resolution by the builder, then passed.
  assert.equal(build.of('resolve').length, 1);
  assert.equal(resultOf(r).status, 'passed', JSON.stringify(r.results));
  assert.equal(resultOf(r).conflictResolution, 'resolved');
  assert.equal(resultOf(r).rounds, 1);
});

// ------------------------------------------------------------------ AC-7
async function failedPreMergeRun({ postMergeFailsOnce }) {
  const { dir } = fixture();
  const build = fakeBuild({ onBuild: () => landOnIntegration(dir, { 'other.txt': 'other\n' }) });
  let postFailed = false;
  const verifies = [];
  const verify = async (a) => {
    verifies.push(a.step);
    if (a.step === 'pre_merge_verify') return FAILING;
    if (a.step === 'post_merge_verify' && postMergeFailsOnce && !postFailed) {
      postFailed = true;
      return FAILING;
    }
    return PASSING;
  };
  const g = recordingGit();
  const r = await runF(dir, { build, verify, git: g });
  return { dir, r, build, verifies, g };
}

test('F91 AC-7: a failed pre_merge_verify does not block; lock, merge and post-merge verify follow, no round or build attempt used', async () => {
  const { dir, r, build, verifies, g } = await failedPreMergeRun({ postMergeFailsOnce: false });
  assert.equal(stepsOf(dir, 'F1', 'pre_merge_verify')[0]?.outcome, 'fail', JSON.stringify(metrics(dir)));
  assert.equal(resultOf(r).status, 'passed', JSON.stringify(r.results));
  assert.equal(resultOf(r).rounds, 1);
  assert.deepEqual(build.calls.map((c) => [c.kind, c.round, c.attempt]), [['build', 1, 1]]);
  assert.deepEqual(verifies, ['verify', 'pre_merge_verify', 'post_merge_verify']);
  assert.equal(lockMerges(g).length, 1);
  assert.deepEqual(stepsOf(dir, 'F1', 'build').length, 1);
});

test('F91 AC-7: after a failed pre_merge_verify a failed post-merge verify gets its one recovery as before', async () => {
  const { dir, r, build, verifies } = await failedPreMergeRun({ postMergeFailsOnce: true });
  assert.equal(stepsOf(dir, 'F1', 'pre_merge_verify')[0]?.outcome, 'fail', JSON.stringify(metrics(dir)));
  assert.equal(resultOf(r).status, 'passed', JSON.stringify(r.results));
  assert.deepEqual(resultOf(r).mergeRecovery, { kind: 'post_merge_verify', result: 'passed' });
  assert.equal(resultOf(r).rounds, 1);
  assert.deepEqual(build.calls.map((c) => c.kind), ['build', 'recover']);
  assert.equal(verifies.filter((s) => s === 'post_merge_verify').length, 2, verifies.join(','));
});

// ------------------------------------------------------------------ AC-8
test('F91 AC-8: the run report Steps table has a pre_merge_verify row', async () => {
  const { dir } = fixture();
  const build = fakeBuild({ onBuild: () => landOnIntegration(dir, { 'other.txt': 'other\n' }) });
  const r = await runF(dir, { build, verify: async () => PASSING });
  assert.equal(resultOf(r).status, 'passed', JSON.stringify(r.results));
  const report = fs.readFileSync(r.report, 'utf8');
  const steps = report.slice(report.indexOf('## Steps'));
  assert.match(steps, /^\| 1 \| pre_merge_verify \| [\d.]+s \| - \| - \| pass \|$/m);
  const rows = steps.split('\n').filter((l) => /^\| 1 \| /.test(l)).map((l) => l.split('|')[2].trim());
  assert.ok(rows.indexOf('pre_merge_verify') < rows.indexOf('merge'), rows.join(','));
});

test('F91 AC-8: SPEC §8.10 describes pre_merge_verify: condition, outside the lock, the result cache, conflict and failure', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s810 = spec.slice(spec.indexOf('**병렬 실행**'), spec.indexOf('**실행 지표와'));
  assert.ok(s810.length > 0);
  const rule = s810.split('\n').find((l) => l.startsWith('- **병합 전 verify**'));
  assert.ok(rule, 'a §8.10 rule for the pre-merge verify');
  for (const re of [/`pre_merge_verify`/, /base/, /병합 잠금 밖/, /결과 캐시/, /§6\.4/, /cached/, /충돌/, /실패/, /라운드/, /--resume/]) {
    assert.match(rule, re);
  }
  // The metrics step list names it too (§8.11).
  assert.match(spec, /`pre_merge_verify`\(/);
});

// ------------------------------------------------------------------ ES-1
test('F91 ES-1: SIGINT during pre_merge_verify saves the run; --resume redoes the pre_merge_verify without using a round or build attempt', async () => {
  const { dir } = fixture();
  const controller = new AbortController();
  const build = fakeBuild({ onBuild: () => landOnIntegration(dir, { 'other.txt': 'other\n' }) });
  let evals = 0;
  const countEval = async (a) => {
    evals += 1;
    return evaluate(a);
  };
  const first = [];
  const interrupt = async (a) => {
    first.push(a.step);
    if (a.step === 'pre_merge_verify') {
      controller.abort();
      // Ends a few seconds later: the run stops on the signal, not on this verify.
      await sleep(3000);
    }
    return PASSING;
  };
  const r1 = await run.runFeatures({ root: dir, config: cfg(), signal: controller.signal, deps: { build, verify: interrupt, evaluate: countEval, cpus: 8 } });
  assert.equal(r1.interrupted, true, JSON.stringify(r1));
  assert.deepEqual(first, ['verify', 'pre_merge_verify']);
  const saved = readJson(path.join(runsDir(dir), 'current.json'));
  const e = saved.active.find((x) => x.feature === 'F1');
  assert.ok(e, JSON.stringify(saved));
  assert.equal(e.stage, 'merge');
  const wt = featureWt(dir);
  assert.equal(git(wt, 'symbolic-ref', '--short', 'HEAD'), 'harness/F1', 'the feature worktree is back on its branch');
  assert.equal(hasMergeHead(wt), false);

  const second = [];
  const verify = async (a) => {
    second.push(a.step);
    return PASSING;
  };
  const r2 = await run.runFeatures({ root: dir, resume: true, deps: { build, verify, evaluate: countEval, cpus: 8 } });
  assert.equal(r2.interrupted, false, JSON.stringify(r2));
  assert.deepEqual(second, ['pre_merge_verify', 'post_merge_verify'], 'resume starts at the pre-merge verify');
  assert.equal(resultOf(r2).status, 'passed', JSON.stringify(r2.results));
  assert.equal(resultOf(r2).rounds, 1);
  assert.equal(build.calls.length, 1, 'no build attempt used');
  assert.equal(evals, 1, 'not evaluated again');
  assert.equal(stepsOf(dir, 'F1', 'pre_merge_verify').at(-1)?.outcome, 'pass');
});
