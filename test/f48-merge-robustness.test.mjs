import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import * as run from '../lib/run.mjs';

// ------------------------------------------------------------------ fixtures

function contract(id, tier = 'standard') {
  const c = {
    id, title: `feature ${id}`, security_tier: tier, version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: tier === 'critical' ? [{ id: 'SC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }] : [],
    error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-27T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

// A repo on `main` with independent approved features. `tiers`: {id: {features, contract}}.
function fixture(ids = ['F1'], { tiers = {}, config = {} } = {}) {
  const tierOf = (id) => ({ features: 'standard', contract: 'standard', ...tiers[id] });
  const state = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...config },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': {
      features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: tierOf(id).features, depends_on: [], status: 'approved' })),
    },
    'scripts/ok.mjs': 'process.exit(0);\n',
    'doc.md': 'original\n',
  };
  for (const id of ids) state[`.harness/contracts/${id}.json`] = contract(id, tierOf(id).contract);
  return gitRepo(state, { branch: null });
}

const cfg = (extra = {}) => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, ...extra });
const real = (p) => fs.realpathSync.native(p);
const intWt = (dir) => path.join(dir, '.harness', 'wt', '_integration');
const featureWt = (dir, id = 'F1') => path.join(dir, '.harness', 'wt', id);
const isIntegration = (cwd) => real(cwd).endsWith(`${path.sep}_integration`);
const isWt = (cwd, dir, id) => fs.existsSync(cwd) && fs.existsSync(featureWt(dir, id)) && real(cwd) === real(featureWt(dir, id));
const integ = (dir) => git(dir, 'rev-parse', 'harness/integration');
const resultOf = (r, id = 'F1') => r.results.find((x) => x.feature === id);
const branches = (dir) => git(dir, 'for-each-ref', '--format=%(refname)', 'refs/heads/').split(/\r?\n/).filter(Boolean).sort();

const OK_INTEGRITY = { markers: [], harnessPaths: [], testCount: { status: 'unset' } };
const PASSING = { pass: true, commands: [], criteria: [{ id: 'AC-1', pass: true }], integrity: OK_INTEGRITY, warnings: [] };

const evaluate = async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });

// Each feature writes <id>.txt: independent features merge cleanly.
function ownFileBuild() {
  const calls = [];
  const fn = async (a) => {
    calls.push(a.featureId);
    writeFiles(a.cwd, { [`${a.featureId}.txt`]: 'built\n' });
    return { ok: true, costUsd: 0 };
  };
  fn.calls = calls;
  return fn;
}

const runF = (dir, deps, opts = {}) => run.runFeatures({
  root: dir, config: cfg(), parallel: 1, ...opts,
  deps: { evaluate, verify: async () => PASSING, cpus: 8, ...deps },
});

// ------------------------------------------------------------------ AC-1 / ES-1

// A post-merge verify that leaves an untracked file and a changed tracked file in the integration worktree.
const dirtyingVerify = async (a) => {
  if (isIntegration(a.cwd)) writeFiles(a.cwd, { 'artifact.log': `verify of ${a.featureId}\n`, 'doc.md': 'changed by verify\n' });
  return PASSING;
};

test('F48 AC-1: files a post-merge verify leaves in the integration worktree are cleaned before the next merge', async () => {
  const dir = fixture(['F1', 'F2']);
  const r = await runF(dir, { build: ownFileBuild(), verify: dirtyingVerify });
  assert.equal(resultOf(r, 'F1').status, 'passed', JSON.stringify(r.results));
  assert.equal(resultOf(r, 'F2').status, 'passed', JSON.stringify(r.results));
  // Neither the verify artifact nor the verify's change was merged into integration.
  assert.equal(git(dir, 'show', 'harness/integration:doc.md'), 'original');
  const tracked = git(dir, 'ls-tree', '-r', '--name-only', 'harness/integration').split('\n');
  assert.ok(!tracked.includes('artifact.log'), tracked.join(', '));
  assert.ok(tracked.includes('F1.txt') && tracked.includes('F2.txt'), tracked.join(', '));
  assert.ok(fs.existsSync(r.report));
});

test('F48 AC-1: an integration worktree still dirty after the cleanup blocks the feature (merge_conflict) and the run writes its report', async () => {
  const dir = fixture(['F1', 'F2']);
  // A nested repository is left alone by `git clean -fd` and stays untracked.
  const verify = async (a) => {
    if (isIntegration(a.cwd) && !fs.existsSync(path.join(a.cwd, 'nested'))) {
      fs.mkdirSync(path.join(a.cwd, 'nested'));
      git(path.join(a.cwd, 'nested'), 'init', '-q');
      writeFiles(path.join(a.cwd, 'nested'), { 'x.txt': 'x\n' });
    }
    return PASSING;
  };
  const r = await runF(dir, { build: ownFileBuild(), verify });
  assert.equal(resultOf(r, 'F1').status, 'passed', JSON.stringify(r.results));
  const f2 = resultOf(r, 'F2');
  assert.equal(f2.status, 'blocked', JSON.stringify(f2));
  assert.equal(f2.reason, 'merge_conflict');
  assert.match(f2.detail, /integration worktree/);
  assert.match(f2.detail, /nested/);
  assert.ok(fs.existsSync(r.report), 'report written');
  assert.match(fs.readFileSync(r.report, 'utf8'), /F2 — merge_conflict/);
  const tracked = git(dir, 'ls-tree', '-r', '--name-only', 'harness/integration').split('\n');
  assert.ok(!tracked.includes('F2.txt'), 'F2 was not merged');
});

test('F48 ES-1: a failing cleanup command blocks that feature with the git error and the other features go on', async () => {
  const dir = fixture(['F1', 'F2', 'F3']);
  let failed = 0;
  const gitFn = async (args, cwd, opts) => {
    if (args[0] === 'clean' && isIntegration(cwd) && failed === 0) {
      failed += 1;
      return { code: 1, stdout: '', stderr: 'fatal: simulated clean failure\n' };
    }
    return run.git(args, cwd, opts);
  };
  const r = await runF(dir, { build: ownFileBuild(), verify: dirtyingVerify, git: gitFn });
  assert.equal(failed, 1, 'the cleanup ran and failed once');
  assert.equal(resultOf(r, 'F1').status, 'passed', JSON.stringify(r.results));
  const f2 = resultOf(r, 'F2');
  assert.equal(f2.status, 'blocked', JSON.stringify(f2));
  assert.match(f2.detail, /simulated clean failure/);
  assert.equal(resultOf(r, 'F3').status, 'passed', JSON.stringify(r.results));
  assert.equal(r.stopped, null);
  assert.ok(fs.existsSync(r.report));
});

// ------------------------------------------------------------------ AC-2 / SC-1

// F1's merge conflicts on doc.md; the resolving builder commits the merge itself with the
// conflict markers still in it.
async function committedMarkerRun() {
  const dir = fixture(['F1']);
  const seen = {};
  const build = async (a) => {
    if (!a.conflicts) {
      writeFiles(intWt(dir), { 'doc.md': 'changed on integration\n' });
      commitAll(intWt(dir), 'meanwhile on integration');
      writeFiles(a.cwd, { 'F1.txt': 'built\n', 'doc.md': 'changed by F1\n' });
    } else {
      seen.integration = integ(dir);
      seen.head = git(a.cwd, 'rev-parse', 'HEAD');
      writeFiles(a.cwd, { 'doc.md': '<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> x\n' });
      git(a.cwd, 'add', '-A');
      git(a.cwd, 'commit', '-q', '--no-edit');
      seen.committed = git(a.cwd, 'rev-parse', 'HEAD');
    }
    return { ok: true, costUsd: 0 };
  };
  const calls = [];
  const gitFn = async (args, cwd, opts) => {
    calls.push({ args, cwd });
    return run.git(args, cwd, opts);
  };
  const r = await runF(dir, { build, git: gitFn });
  return { dir, r, seen, calls };
}

test('F48 AC-2: a failed resolution the builder committed resets the feature branch to the pre-resolution commit', async () => {
  const { dir, r, seen } = await committedMarkerRun();
  const f1 = resultOf(r);
  assert.equal(f1.status, 'blocked', JSON.stringify(f1));
  assert.equal(f1.reason, 'merge_conflict');
  assert.match(f1.detail, /conflict markers left in doc\.md/);
  assert.ok(seen.committed && seen.committed !== seen.head, 'the builder committed the merge');
  assert.equal(git(dir, 'rev-parse', 'harness/F1'), seen.head);
  assert.equal(git(featureWt(dir), 'rev-parse', 'HEAD'), seen.head);
  assert.equal(git(featureWt(dir), 'status', '--porcelain'), '');
});

test('F48 SC-1: the reset of a failed committed resolution runs only in the feature worktree and integration is unchanged', async () => {
  const { dir, r, seen, calls } = await committedMarkerRun();
  assert.equal(resultOf(r).status, 'blocked');
  const resets = calls.filter((c) => c.args[0] === 'reset' && c.args.includes('--hard'));
  assert.ok(resets.some((c) => c.args.includes(seen.head)), JSON.stringify(resets.map((c) => c.args)));
  for (const c of resets) assert.ok(isWt(c.cwd, dir, 'F1'), `reset --hard ran in ${c.cwd}`);
  assert.equal(integ(dir), seen.integration);
});

// ------------------------------------------------------------------ AC-3

for (const name of ['refs/heads/work', 'heads/work']) {
  test(`F48 AC-3: integration_branch '${name}' stops the run with exit 2 before any build`, async () => {
    const dir = fixture(['F1']);
    const before = branches(dir);
    const build = ownFileBuild();
    const err = await runF(dir, { build }, { config: cfg({ integration_branch: name }) }).then(() => null, (e) => e);
    assert.ok(err, 'the run was refused');
    assert.equal(err.exit, 2);
    assert.ok(['config_invalid', 'usage'].includes(err.code), err.code);
    assert.match(err.message, /integration_branch/);
    assert.deepEqual(build.calls, []);
    assert.deepEqual(branches(dir), before);
    assert.ok(!fs.existsSync(featureWt(dir)));
  });
}

// ------------------------------------------------------------------ AC-4

// A doctor report where security-reviewer is not usable.
const noReviewer = (calls) => async () => {
  calls.diagnose += 1;
  const roles = ['builder', 'evaluator', 'security-reviewer'].map((role) => ({
    role, adapter: 'gemini', model: null, readOnly: role !== 'builder',
    usable: role !== 'security-reviewer', reason: role === 'security-reviewer' ? 'codex not installed' : null, missing: [],
  }));
  return { clis: [], roles, independence: 'cross-model', warnings: [], ok: false };
};

test('F48 AC-4: the preflight checks security-reviewer when the contract is critical though features.json says standard', async () => {
  const dir = fixture(['F1'], { tiers: { F1: { features: 'standard', contract: 'critical' } } });
  const calls = { diagnose: 0 };
  const build = ownFileBuild();
  const err = await runF(dir, { build, diagnose: noReviewer(calls) }).then(() => null, (e) => e);
  assert.equal(calls.diagnose, 1);
  assert.ok(err, 'preflight refused the run');
  assert.equal(err.code, 'preflight');
  assert.match(err.message, /security-reviewer/);
  assert.deepEqual(build.calls, []);
});

test('F48 AC-4: the preflight skips security-reviewer when the contract is standard though features.json says critical, and warns', async () => {
  const dir = fixture(['F1'], { tiers: { F1: { features: 'critical', contract: 'standard' } } });
  const calls = { diagnose: 0 };
  const logs = [];
  const r = await runF(dir, { build: ownFileBuild(), diagnose: noReviewer(calls), log: (m) => logs.push(m) });
  assert.equal(calls.diagnose, 1);
  assert.equal(resultOf(r).status, 'passed', JSON.stringify(r.results));
  const warn = logs.find((l) => /warning/i.test(l) && l.includes('F1') && l.includes('security_tier'));
  assert.ok(warn, logs.join('\n'));
  assert.match(warn, /critical/);
  assert.match(warn, /standard/);
  const report = fs.readFileSync(r.report, 'utf8');
  assert.match(report, /## Warnings/);
  assert.match(report, /F1.*security_tier/);
});

test('F48 AC-4: a blocked feature whose contract is critical stops the run though features.json says standard, with a warning', async () => {
  const dir = fixture(['F1', 'F2'], { tiers: { F1: { features: 'standard', contract: 'critical' } } });
  const logs = [];
  const build = async (a) => (a.featureId === 'F1'
    ? { ok: false, error: 'adapter_unavailable', detail: 'simulated', costUsd: 0 }
    : ownFileBuild()(a));
  const r = await runF(dir, { build, log: (m) => logs.push(m) });
  assert.equal(resultOf(r).status, 'blocked', JSON.stringify(r.results));
  assert.equal(r.stopped?.reason, 'critical_blocked', JSON.stringify(r.stopped));
  assert.equal(resultOf(r, 'F2'), undefined, 'F2 did not start');
  assert.ok(logs.some((l) => /warning/i.test(l) && l.includes('F1') && l.includes('security_tier')), logs.join('\n'));
  assert.match(fs.readFileSync(r.report, 'utf8'), /## Warnings[\s\S]*F1.*security_tier/);
});

test('F48 AC-4: no tier warning when features.json and the contract agree', async () => {
  const dir = fixture(['F1'], { tiers: { F1: { features: 'critical', contract: 'critical' } } });
  const logs = [];
  const r = await runF(dir, { build: ownFileBuild(), log: (m) => logs.push(m) });
  assert.equal(resultOf(r).status, 'passed');
  assert.ok(!logs.some((l) => l.includes('security_tier')), logs.join('\n'));
  assert.doesNotMatch(fs.readFileSync(r.report, 'utf8'), /## Warnings/);
});
