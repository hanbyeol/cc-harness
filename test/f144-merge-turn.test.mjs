// F144: the merge turn. A feature that passed eval takes the turn before it reads integration
// for the pre-merge verify and gives it up when its integration merge attempt is over (before
// the post-merge verify), so no other feature's merge makes the pre-merge verify obsolete.
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

const HARNESS_IGNORE = 'wt/\n*.tmp-*\nruns/test-count-cache.json\nruns/verify-cache.json\n';
const slash = (p) => p.split(path.sep).join('/');
const quoted = (p) => JSON.stringify(slash(p));

function contract(id, log) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id}.txt exists`, check: `node scripts/rec.mjs ${quoted(log)} ${id}.txt`, new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-18T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture(ids) {
  const log = path.join(tmpdir('harness-f144-log-'), 'log.txt');
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
const real = (p) => {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
};
const intWt = (dir) => path.join(dir, '.harness', 'wt', '_integration');
const featureWt = (dir, id) => path.join(dir, '.harness', 'wt', id);
const isIntegration = (cwd) => real(cwd).endsWith(`${path.sep}_integration`);
const integ = (dir) => git(dir, 'rev-parse', 'harness/integration');
const hasMergeHead = (wt) => spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: wt }).status === 0;
const isAncestor = (wt, a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: wt }).status === 0;
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const statuses = (dir) => Object.fromEntries(readJson(path.join(dir, '.harness/features.json')).features.map((f) => [f.id, f.status]));
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 30_000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  return cond();
}

function landOnIntegration(dir, files, message = 'meanwhile on integration') {
  writeFiles(intWt(dir), files);
  return commitAll(intWt(dir), message);
}

// Once every listed feature worktree exists (their bases are fixed), one commit lands on integration.
function landOnce(dir, ids, files = { 'other.txt': 'other\n' }) {
  let landed = null;
  return async () => {
    landed ??= (async () => {
      await waitFor(() => ids.every((id) => fs.existsSync(featureWt(dir, id))));
      return landOnIntegration(dir, files);
    })();
    await landed;
  };
}

function fakeBuild({ edit = {}, onBuild, onResolve, recover = { 'fixed.txt': 'fixed\n' } } = {}) {
  const calls = [];
  const fn = async (a) => {
    const kind = a.postMergeFailures ? 'recover' : a.conflicts ? 'resolve' : 'build';
    calls.push({ kind, feature: a.featureId });
    if (kind === 'build' && onBuild) await onBuild(a);
    if (kind === 'resolve' && onResolve) await onResolve(a);
    writeFiles(a.cwd, kind === 'recover' ? recover : kind === 'resolve' ? { 'shared.txt': 'both\n' } : { [`${a.featureId}.txt`]: 'built\n', ...(a.featureId === 'F1' ? edit : {}) });
    return { ok: true, costUsd: 0 };
  };
  fn.calls = calls;
  fn.of = (kind) => calls.filter((c) => c.kind === kind);
  return fn;
}

// A core git that records every call in order.
function recordingGit(override) {
  const calls = [];
  const fn = async (args, cwd, opts) => {
    const c = { args, cwd: real(cwd), integration: isIntegration(cwd), code: null };
    calls.push(c);
    if (override) {
      const r = await override(args, cwd);
      if (r) { c.code = r.code; return r; }
    }
    const r = await run.git(args, cwd, opts);
    c.code = r.code;
    return r;
  };
  fn.calls = calls;
  return fn;
}
const wtMerges = (g, dir, id) => g.calls.filter((c) => c.args[0] === 'merge' && c.args.some((x) => String(x).endsWith('(pre-merge verify)')) && c.cwd === real(featureWt(dir, id)));
// Index of the integration merge of a feature in the recorded calls (-1 when none).
const lockMergeIndex = (g, id) => g.calls.findIndex((c) => c.integration && c.args[0] === 'merge' && c.args[1] === '--no-ff' && c.args[5] === `harness/${id}`);
const preMergeIndex = (g, dir, id) => g.calls.findIndex((c) => c.args[0] === 'merge' && c.cwd === real(featureWt(dir, id)) && c.args.some((x) => String(x).endsWith('(pre-merge verify)')));

const runF = (dir, deps, config) => run.runFeatures({ root: dir, config, deps: { evaluate, cpus: 8, ...deps } });
const PAR2 = () => cfg({ run: { max_parallel: 2, verify_parallel: 2 } });

// F1 and F2 both need a pre_merge_verify; F2's eval ends only after F1's pre_merge_verify started.
// `hold(a)` is the F1 pre_merge_verify wait: until F2 merged integration into its worktree or 10 s.
async function twoNeedingPre({ realVerifyToo = false } = {}) {
  const { dir } = fixture(['F1', 'F2']);
  const g = recordingGit();
  const seen = {};
  let f1PreStarted = false;
  const verify = async (a) => {
    if (a.step === 'pre_merge_verify') {
      seen[a.featureId] = {
        cwd: real(a.cwd), base: a.base, integAt: integ(dir),
        containsF1Merge: seen.F1Merge ? isAncestor(a.cwd, seen.F1Merge, 'HEAD') : null,
      };
      if (a.featureId === 'F1') {
        f1PreStarted = true;
        await waitFor(() => preMergeIndex(g, dir, 'F2') >= 0, 10_000);
        seen.F1WaitedForF2 = preMergeIndex(g, dir, 'F2') >= 0;
      }
    }
    if (a.featureId === 'F1' && a.step === 'post_merge_verify') seen.F1Merge = integ(dir);
    return realVerifyToo ? realVerify(a) : PASSING;
  };
  const evalF2Later = async (a) => {
    if (a.featureId === 'F2') await waitFor(() => f1PreStarted, 120_000);
    return evaluate(a);
  };
  const build = fakeBuild({ onBuild: landOnce(dir, ['F1', 'F2']) });
  const r = await runF(dir, { build, verify, evaluate: evalF2Later, git: g }, PAR2());
  return { dir, g, r, seen };
}

// ------------------------------------------------------------------ AC-1
test('F144 AC-1: the feature that waits for the merge turn reads integration only after the earlier feature merged', async () => {
  const { dir, g, r, seen } = await twoNeedingPre();
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed' }, JSON.stringify(r.results));
  assert.ok(seen.F1 && seen.F2, JSON.stringify(seen));
  assert.equal(seen.F1WaitedForF2, false, 'F2 could not merge integration into its worktree while F1 held the turn');
  const f1Merge = lockMergeIndex(g, 'F1');
  const f2Pre = preMergeIndex(g, dir, 'F2');
  assert.ok(f1Merge >= 0 && f2Pre >= 0, JSON.stringify(g.calls.map((c) => c.args.join(' '))));
  assert.ok(f1Merge < f2Pre, 'F2 merged integration into its worktree after F1 merged into integration');
  assert.equal(wtMerges(g, dir, 'F2').length, 1);
  assert.equal(seen.F2.base, seen.F1Merge, 'F2 pre_merge_verify base is the F1 merge commit');
  assert.equal(seen.F2.containsF1Merge, true);
});

// ------------------------------------------------------------------ AC-2
test('F144 AC-2: with real verify both features are passed, one pre_merge_verify line each, both post_merge_verify lines cached', async () => {
  const { dir, r } = await twoNeedingPre({ realVerifyToo: true });
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed' }, JSON.stringify(r.results));
  for (const id of ['F1', 'F2']) {
    const pre = stepsOf(dir, id, 'pre_merge_verify');
    assert.equal(pre.length, 1, `${id}: ${JSON.stringify(metrics(dir))}`);
    assert.equal(pre[0].outcome, 'pass');
    assert.equal(pre[0].cached, false);
    const post = stepsOf(dir, id, 'post_merge_verify');
    assert.equal(post.length, 1);
    assert.equal(post[0].cached, true, `${id}: ${JSON.stringify(post)}`);
  }
});

// ------------------------------------------------------------------ AC-3
test('F144 AC-3: a feature that would not need a pre_merge_verify still waits its turn and verifies against the earlier merge', async () => {
  const { dir } = fixture(['F1', 'F2', 'F3']);
  const g = recordingGit();
  const seen = {};
  let f1PostStarted = false;
  let f3Evaluated = false;
  const verify = async (a) => {
    if (a.featureId === 'F1' && a.step === 'post_merge_verify') f1PostStarted = true;
    if (a.step === 'pre_merge_verify') {
      seen[a.featureId] = { base: a.base, integAt: integ(dir), cwd: a.cwd };
      if (a.featureId === 'F2') {
        await waitFor(() => f3Evaluated, 120_000);
        await waitFor(() => preMergeIndex(g, dir, 'F3') >= 0, 10_000);
        seen.F3MergedWhileF2Held = preMergeIndex(g, dir, 'F3') >= 0;
      }
    }
    return PASSING;
  };
  const evalLater = async (a) => {
    // F2 is evaluated once F1 is merged; F3 passes eval while F2 verifies.
    if (a.featureId === 'F2') await waitFor(() => f1PostStarted, 120_000);
    const v = await evaluate(a);
    if (a.featureId === 'F3') f3Evaluated = true;
    return v;
  };
  // F2's base is older than the F1 merge; F1 lands nothing, so it needs no pre-merge verify.
  const r = await runF(dir, { build: fakeBuild(), verify, evaluate: evalLater, git: g }, PAR2());
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed', F3: 'passed' }, JSON.stringify(r.results));
  assert.equal(seen.F3MergedWhileF2Held, false, 'F3 waited for the turn');
  assert.ok(lockMergeIndex(g, 'F2') >= 0 && lockMergeIndex(g, 'F3') >= 0);
  assert.ok(lockMergeIndex(g, 'F2') < preMergeIndex(g, dir, 'F3'), 'F3 read integration after the F2 merge');
  assert.ok(lockMergeIndex(g, 'F2') < lockMergeIndex(g, 'F3'));
  assert.equal(stepsOf(dir, 'F3', 'pre_merge_verify').length, 1);
  assert.ok(seen.F3, JSON.stringify(seen));
  assert.equal(seen.F3.base, seen.F3.integAt, 'F3 verifies against the integration commit it merged');
  assert.notEqual(seen.F3.base, seen.F2.base);
  assert.ok(isAncestor(dir, seen.F3.base, 'harness/integration'));
});

// ------------------------------------------------------------------ AC-4
test('F144 AC-4: the turn is released before the post-merge verify: it overlaps the next pre_merge_verify', async () => {
  const { dir } = fixture(['F1', 'F2']);
  const spans = {};
  const started = (k) => Boolean(spans[k]);
  let f1Merge = null;
  const seen = {};
  const verify = async (a) => {
    const k = `${a.featureId} ${a.step}`;
    if (k === 'F1 post_merge_verify' || k === 'F2 pre_merge_verify') {
      spans[k] = { start: performance.now(), end: null };
      if (k === 'F1 post_merge_verify') f1Merge = integ(dir);
      else seen.base = a.base;
      await waitFor(() => started(k === 'F1 post_merge_verify' ? 'F2 pre_merge_verify' : 'F1 post_merge_verify'));
      spans[k].end = performance.now();
    }
    return PASSING;
  };
  const evalF2Later = async (a) => {
    if (a.featureId === 'F2') await waitFor(() => started('F1 post_merge_verify'));
    return evaluate(a);
  };
  const r = await runF(dir, { build: fakeBuild(), verify, evaluate: evalF2Later }, PAR2());
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed' }, JSON.stringify(r.results));
  const post = spans['F1 post_merge_verify'];
  const pre = spans['F2 pre_merge_verify'];
  assert.ok(post && pre, JSON.stringify(spans));
  assert.ok(pre.start < post.end && post.start < pre.end, `the intervals overlap: ${JSON.stringify(spans)}`);
  assert.equal(seen.base, f1Merge, 'F2 pre_merge_verify base is the F1 merge commit');
});

// ------------------------------------------------------------------ AC-5
test('F144 AC-5: SPEC §8.10 pre-merge verify rule describes the merge turn', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s810 = spec.slice(spec.indexOf('**병렬 실행**'), spec.indexOf('**실행 지표와'));
  const rule = s810.split('\n').find((l) => l.startsWith('- **병합 전 verify**'));
  assert.ok(rule, 'a §8.10 rule for the pre-merge verify');
  for (const re of [/병합 순번/, /순번을 잡/, /병합 후 verify 전에/, /풀/, /충돌/, /blocked/, /다른 기능의 integration 병합은 없/, /되돌려지면/, /모두 실행/]) {
    assert.match(rule, re);
  }
});

// ------------------------------------------------------------------ ES-1
test('F144 ES-1: a conflict gives up the turn; another feature merges during the resolution, then the first merges again', async () => {
  const { dir } = fixture(['F1', 'F2']);
  let resolving = false;
  let f2Merged = false;
  let f2MergedDuringResolve = false;
  const verify = async (a) => {
    if (a.featureId === 'F2' && a.step === 'post_merge_verify') f2Merged = true;
    return PASSING;
  };
  const evalF2Later = async (a) => {
    if (a.featureId === 'F2') await waitFor(() => resolving, 120_000);
    return evaluate(a);
  };
  const build = fakeBuild({
    edit: { 'shared.txt': 'changed by F1\n' },
    onBuild: async (a) => {
      if (a.featureId === 'F1') {
        await waitFor(() => fs.existsSync(featureWt(dir, 'F2')));
        landOnIntegration(dir, { 'shared.txt': 'changed on integration\n' });
      }
    },
    onResolve: async () => {
      resolving = true;
      f2MergedDuringResolve = await waitFor(() => f2Merged);
    },
  });
  const r = await runF(dir, { build, verify, evaluate: evalF2Later }, PAR2());
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed' }, JSON.stringify(r.results));
  assert.equal(f2MergedDuringResolve, true, 'F2 merged while F1 resolved its conflict');
  assert.equal(r.results.find((x) => x.feature === 'F1').conflictResolution, 'resolved');
  assert.equal(build.of('resolve').length, 1);
});

// ------------------------------------------------------------------ ES-2
test('F144 ES-2: a feature blocked after its pre_merge_verify gives up the turn; the other feature passes and the run reports', async () => {
  const { dir } = fixture(['F1', 'F2']);
  let f1PreStarted = false;
  const verify = async (a) => {
    if (a.featureId === 'F1' && a.step === 'pre_merge_verify') f1PreStarted = true;
    return PASSING;
  };
  const evalF2Later = async (a) => {
    if (a.featureId === 'F2') await waitFor(() => f1PreStarted, 120_000);
    return evaluate(a);
  };
  const f1Wt = real(featureWt(dir, 'F1'));
  const g = recordingGit(async (args, cwd) => {
    if (args.join(' ') === 'checkout -q -f harness/F1' && real(cwd) === f1Wt) return { code: 1, stdout: '', stderr: 'cannot checkout' };
    return null;
  });
  const build = fakeBuild({ onBuild: landOnce(dir, ['F1', 'F2']) });
  const r = await runF(dir, { build, verify, evaluate: evalF2Later, git: g }, PAR2());
  const f1 = r.results.find((x) => x.feature === 'F1');
  assert.equal(f1.status, 'blocked', JSON.stringify(r.results));
  assert.equal(f1.reason, 'merge_conflict');
  assert.equal(r.results.find((x) => x.feature === 'F2').status, 'passed', JSON.stringify(r.results));
  assert.ok(r.report && fs.existsSync(r.report), 'the run wrote its report');
});

// ------------------------------------------------------------------ ES-3
test('F144 ES-3: SIGINT while a feature waits for the turn saves it at stage merge; --resume finishes both without build or eval', async () => {
  const { dir } = fixture(['F1', 'F2']);
  const controller = new AbortController();
  let builds = 0;
  let evals = 0;
  const base = fakeBuild({ onBuild: landOnce(dir, ['F1', 'F2']) });
  const build = async (a) => { builds += 1; return base(a); };
  let f1PreStarted = false;
  const countEval = async (a) => {
    if (a.featureId === 'F2') await waitFor(() => f1PreStarted, 120_000);
    evals += 1;
    return evaluate(a);
  };
  const stageOf = (id) => {
    try { return readJson(path.join(runsDir(dir), 'current.json')).active.find((x) => x.feature === id)?.stage; } catch { return null; }
  };
  const interrupt = async (a) => {
    if (a.featureId === 'F1' && a.step === 'pre_merge_verify') {
      f1PreStarted = true;
      // F2 passed eval and sits in the turn queue (saved stage merge, no pre_merge_verify of its own).
      await waitFor(() => evals >= 2 && stageOf('F2') === 'merge');
      await sleep(300);
      controller.abort();
      await sleep(3000); // the run stops on the signal, not on this verify
    }
    return PASSING;
  };
  const r1 = await run.runFeatures({ root: dir, config: PAR2(), signal: controller.signal, deps: { build, verify: interrupt, evaluate: countEval, cpus: 8 } });
  assert.equal(r1.interrupted, true, JSON.stringify(r1));
  const e = readJson(path.join(runsDir(dir), 'current.json')).active.find((x) => x.feature === 'F2');
  assert.ok(e, 'F2 is saved');
  assert.equal(e.stage, 'merge');
  const wt = featureWt(dir, 'F2');
  assert.equal(git(wt, 'symbolic-ref', '--short', 'HEAD'), 'harness/F2');
  assert.equal(hasMergeHead(wt), false);
  const calls = { builds, evals };

  const r2 = await run.runFeatures({ root: dir, resume: true, deps: { build, verify: async () => PASSING, evaluate: countEval, cpus: 8 } });
  assert.equal(r2.interrupted, false, JSON.stringify(r2));
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed' }, JSON.stringify(r2.results));
  assert.deepEqual({ builds, evals }, calls, 'no build or eval after the resume');
});

// ------------------------------------------------------------------ ES-4
test('F144 ES-4: when the earlier merge is rolled back after the next feature pre-verified on it, the post-merge verify runs everything', async () => {
  const { dir } = fixture(['F1', 'F2']);
  let f1PostStarted = false;
  let f2PreDone = false;
  let f1Merge = null;
  let failedOnce = false;
  const seen = {};
  const verify = async (a) => {
    if (a.featureId === 'F1' && a.step === 'post_merge_verify' && !failedOnce) {
      failedOnce = true;
      f1PostStarted = true;
      f1Merge = integ(dir);
      await waitFor(() => f2PreDone);
      return FAILING;
    }
    const v = await realVerify(a);
    if (a.featureId === 'F2' && a.step === 'pre_merge_verify') f2PreDone = true;
    if (a.featureId === 'F2' && a.step === 'post_merge_verify') {
      seen.cache = v.cache?.status;
      seen.hasRolledBack = f1Merge ? isAncestor(intWt(dir), f1Merge, 'HEAD') : null;
    }
    return v;
  };
  const evalF2Later = async (a) => {
    if (a.featureId === 'F2') await waitFor(() => f1PostStarted, 120_000);
    return evaluate(a);
  };
  const r = await runF(dir, { build: fakeBuild({ onBuild: landOnce(dir, ['F1', 'F2']) }), verify, evaluate: evalF2Later }, PAR2());
  const f2 = r.results.find((x) => x.feature === 'F2');
  assert.equal(f2.status, 'passed', JSON.stringify(r.results));
  const post = stepsOf(dir, 'F2', 'post_merge_verify');
  assert.equal(post.length, 1);
  assert.equal(post[0].cached, false, JSON.stringify(seen));
  assert.equal(seen.cache, 'miss');
  assert.equal(seen.hasRolledBack, false, 'the rolled back F1 merge commit is not on integration');
  assert.ok(f1Merge);
  assert.equal(isAncestor(dir, f1Merge, 'harness/integration'), false);
});
