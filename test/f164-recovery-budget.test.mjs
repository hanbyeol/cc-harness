import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './helpers.mjs';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import * as run from '../lib/run.mjs';

// ------------------------------------------------------------------ fixtures

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-11-12T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture() {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract('F1'),
    'scripts/ok.mjs': 'process.exit(0);\n',
    'shared.txt': 'original\n',
  }, { branch: null });
}

const cfg = (budget = {}) => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60, ...budget } });
const real = (p) => fs.realpathSync.native(p);
const isIntegration = (cwd) => real(cwd).endsWith(`${path.sep}_integration`);
const intWt = (dir) => path.join(dir, '.harness', 'wt', '_integration');
const featureWt = (dir) => path.join(dir, '.harness', 'wt', 'F1');
const integ = (dir) => git(dir, 'rev-parse', 'harness/integration');
const blockedReason = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.harness/features.json'), 'utf8')).features.find((f) => f.id === 'F1').blocked_reason;

const OK_INTEGRITY = { markers: [], harnessPaths: [], testCount: { status: 'unset' } };
const PASSING = { pass: true, commands: [], criteria: [{ id: 'AC-1', pass: true }], integrity: OK_INTEGRITY, warnings: [] };
const FAILING = {
  pass: false, commands: [{ cmd: 'npm test', pass: false, message: 'exit 1', output: 'boom' }],
  criteria: [{ id: 'AC-1', pass: false, message: 'exit 1' }], integrity: OK_INTEGRITY, warnings: [],
};

// `postMergeFails`: the integration worktree fails until fixed.txt is there.
function fakeVerify({ postMergeFails = false } = {}) {
  const calls = [];
  const fn = async (a) => {
    const onInt = isIntegration(a.cwd);
    calls.push({ integration: onInt, step: a.step });
    if (onInt && postMergeFails) return fs.existsSync(path.join(a.cwd, 'fixed.txt')) ? PASSING : FAILING;
    return PASSING;
  };
  fn.calls = calls;
  return fn;
}

// A normal build writes F1.txt (plus `edit`); a conflict resolution writes shared.txt; a
// post-merge recovery writes fixed.txt. `result(kind)` overrides the builder result.
function fakeBuild({ edit = {}, result, onCall } = {}) {
  const calls = [];
  const fn = async (a) => {
    const kind = a.postMergeFailures ? 'recover' : a.conflicts ? 'resolve' : 'build';
    calls.push(kind);
    if (onCall) await onCall(kind);
    writeFiles(a.cwd, kind === 'recover' ? { 'fixed.txt': 'fixed\n' } : kind === 'resolve' ? { 'shared.txt': 'both\n' } : { 'F1.txt': 'built\n', ...edit });
    return (result && result(kind)) || { ok: true, costUsd: 0 };
  };
  fn.calls = calls;
  fn.of = (kind) => calls.filter((k) => k === kind);
  return fn;
}

const evaluate = async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });
const f1 = (r) => r.results.find((x) => x.feature === 'F1');
const BUDGET_DETAIL = 'error_max_budget_usd: Reached maximum budget ($0.40)';
const EXHAUSTED = { ok: false, error: 'exit_nonzero', budgetExhausted: true, costUsd: 0.4, detail: BUDGET_DETAIL };

// A run where F1's merge conflicts: a commit lands on integration while F1 builds.
async function conflictRun(resolveResult, budget) {
  const dir = fixture();
  let before = null;
  let verifiesAtResolve = null;
  const verify = fakeVerify();
  const build = fakeBuild({
    edit: { 'shared.txt': 'changed by F1\n' },
    result: (k) => (k === 'resolve' ? resolveResult : null),
    onCall: (k) => {
      if (k === 'build') {
        writeFiles(intWt(dir), { 'shared.txt': 'changed on integration\n' });
        before = commitAll(intWt(dir), 'meanwhile on integration');
      }
      if (k === 'resolve') verifiesAtResolve = verify.calls.length;
    },
  });
  const r = await run.runFeatures({ root: dir, config: cfg(budget), deps: { build, verify, evaluate, cpus: 8 } });
  return { dir, r, build, verify, before, verifiesAtResolve };
}

// A run where F1's post-merge verify fails, so the recovery builder is called.
async function recoveryRun(recoverResult, budget) {
  const dir = fixture();
  const before = git(dir, 'rev-parse', 'main');
  const verify = fakeVerify({ postMergeFails: true });
  const build = fakeBuild({ result: (k) => (k === 'recover' ? recoverResult : null) });
  const r = await run.runFeatures({ root: dir, config: cfg(budget), deps: { build, verify, evaluate, cpus: 8 } });
  return { dir, r, build, verify, before };
}

const noMergeHead = (wt) => spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: wt, encoding: 'utf8' }).status !== 0;

// ------------------------------------------------------------------ AC-1

test('F164 AC-1: a conflict resolution builder stopped at its budget blocks the feature (budget), integration unchanged, no verify', async () => {
  const x = await conflictRun(EXHAUSTED);
  const f = f1(x.r);
  assert.equal(x.build.of('resolve').length, 1, JSON.stringify(x.build.calls));
  assert.equal(f?.status, 'blocked', JSON.stringify(f));
  assert.equal(f.reason, 'budget');
  assert.ok(f.detail.includes('conflict resolution build stopped at its budget'), f.detail);
  assert.ok(f.detail.includes('error_max_budget_usd'), f.detail);
  assert.equal(blockedReason(x.dir), 'budget');
  assert.equal(integ(x.dir), x.before, 'integration is the commit before F1\'s merge');
  assert.ok(noMergeHead(featureWt(x.dir)), 'no merge left in progress in the feature worktree');
  assert.equal(x.verify.calls.length, x.verifiesAtResolve, 'no verify after the resolution');
});

// ------------------------------------------------------------------ AC-2

test('F164 AC-2: a post-merge recovery builder stopped at its budget blocks the feature (budget), one recovery, integration unchanged', async () => {
  const x = await recoveryRun(EXHAUSTED);
  const f = f1(x.r);
  assert.equal(x.build.of('recover').length, 1, JSON.stringify(x.build.calls));
  assert.equal(f?.status, 'blocked', JSON.stringify(f));
  assert.equal(f.reason, 'budget');
  assert.ok(f.detail.includes('post-merge verify recovery build stopped at its budget'), f.detail);
  assert.ok(f.detail.includes('error_max_budget_usd'), f.detail);
  assert.equal(blockedReason(x.dir), 'budget');
  assert.equal(integ(x.dir), x.before, 'integration is the commit before F1\'s merge');
});

// ------------------------------------------------------------------ AC-3

test('F164 AC-3: a conflict resolution build that reaches step_usd blocks the feature (budget) without a verify', async () => {
  const x = await conflictRun({ ok: true, costUsd: 0.6 }, { step_usd: 0.5 });
  const f = f1(x.r);
  assert.equal(x.build.of('resolve').length, 1, JSON.stringify(x.build.calls));
  assert.equal(f?.status, 'blocked', JSON.stringify(f));
  assert.equal(f.reason, 'budget');
  assert.ok(f.detail.includes('reached the step budget'), f.detail);
  assert.equal(integ(x.dir), x.before);
  assert.equal(x.verify.calls.length, x.verifiesAtResolve, 'no verify after the resolution');
});

test('F164 AC-3: a post-merge recovery build that reaches step_usd blocks the feature (budget) without a verify', async () => {
  const x = await recoveryRun({ ok: true, costUsd: 0.6 }, { step_usd: 0.5 });
  const f = f1(x.r);
  assert.equal(x.build.of('recover').length, 1, JSON.stringify(x.build.calls));
  assert.equal(f?.status, 'blocked', JSON.stringify(f));
  assert.equal(f.reason, 'budget');
  assert.ok(f.detail.includes('reached the step budget'), f.detail);
  assert.equal(integ(x.dir), x.before);
  const pm = x.verify.calls.filter((c) => c.step === 'post_merge_verify').length;
  assert.equal(pm, 1, 'no post-merge verify after the recovery');
});

// ------------------------------------------------------------------ AC-4

test('F164 AC-4: SPEC §8 budget paragraph applies blocked(budget) to the conflict resolution and post-merge recovery builders', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s8 = spec.slice(spec.indexOf('\n## 8.'), spec.indexOf('\n## 9.'));
  const para = s8.split('\n').find((l) => l.includes('error_max_budget_usd') && l.includes('blocked(`budget`)'));
  assert.ok(para, 'no §8 paragraph with error_max_budget_usd and blocked(`budget`)');
  assert.ok(para.includes('병합 충돌 해결'), para);
  assert.ok(para.includes('병합 후 verify 복구'), para);
});

// ------------------------------------------------------------------ ES-1

test('F164 ES-1: a conflict resolution builder failing without budgetExhausted is still blocked(merge_conflict)', async () => {
  const x = await conflictRun({ ok: false, error: 'exit_nonzero', costUsd: 0, detail: 'boom' });
  assert.equal(f1(x.r)?.status, 'blocked');
  assert.equal(f1(x.r).reason, 'merge_conflict');
});

test('F164 ES-1: a post-merge recovery builder failing without budgetExhausted is still blocked(post_merge_verify)', async () => {
  const x = await recoveryRun({ ok: false, error: 'exit_nonzero', costUsd: 0, detail: 'boom' });
  assert.equal(f1(x.r)?.status, 'blocked');
  assert.equal(f1(x.r).reason, 'post_merge_verify');
});

test('F164 ES-1: successful conflict resolution and recovery builders without step_usd still pass', async () => {
  const c = await conflictRun({ ok: true, costUsd: 0.6 });
  assert.equal(f1(c.r)?.status, 'passed', JSON.stringify(f1(c.r)));
  const p = await recoveryRun({ ok: true, costUsd: 0.6 });
  assert.equal(f1(p.r)?.status, 'passed', JSON.stringify(f1(p.r)));
});
