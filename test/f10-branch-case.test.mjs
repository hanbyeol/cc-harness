// F10: an integration_branch that differs from an existing local branch only by case is
// refused. On case-insensitive filesystems both names are the same loose ref, so the run
// would advance the user's branch. The fixtures create 'work' and configure 'Work' so the
// tests behave the same on case-sensitive filesystems (Linux CI), where both can coexist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { git, gitRepo } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { runFeatures } from '../lib/run.mjs';
import { HarnessError } from '../lib/errors.mjs';

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id}.txt exists`, check: `node -e "process.exit(require('fs').existsSync('${id}.txt')?0:1)"`, new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-23T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture() {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract('F1'),
  }, { branch: null });
}

const cfg = (integration_branch) => resolveConfig({ base_branch: 'main', integration_branch, verify: { commands: [] }, budget: { step_timeout_sec: 60 } });

const PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };

function fakeBuild() {
  const calls = [];
  const fn = async (a) => {
    calls.push(a.featureId);
    fs.writeFileSync(path.join(a.cwd, `${a.featureId}.txt`), 'built\n');
    git(a.cwd, 'add', '-A');
    git(a.cwd, 'commit', '-q', '-m', `builder ${a.featureId}`);
    return { ok: true, costUsd: 0 };
  };
  fn.calls = calls;
  return fn;
}

const deps = (extra = {}) => ({
  build: fakeBuild(),
  verify: async () => PASSING,
  evaluate: async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null }),
  ...extra,
});

const branches = (dir) => git(dir, 'for-each-ref', '--format=%(refname)', 'refs/heads/').split('\n').filter(Boolean);
const statePath = (dir) => path.join(dir, '.harness', 'runs', 'current.json');
const intWt = (dir) => path.join(dir, '.harness', 'wt', '_integration');

// A user's own branch 'work' that already carries a commit of its own.
function withUserBranch(dir, name = 'work') {
  git(dir, 'branch', name, 'main');
  return git(dir, 'rev-parse', `refs/heads/${name}`);
}

test('F10 AC-1: an integration_branch differing only by case from a local branch stops the run with exit 2 naming both', async () => {
  const dir = fixture();
  withUserBranch(dir, 'work');
  const refsBefore = branches(dir);
  const build = fakeBuild();
  await assert.rejects(
    runFeatures({ root: dir, config: cfg('Work'), deps: deps({ build }) }),
    (e) => {
      assert.ok(e instanceof HarnessError, String(e));
      assert.equal(e.exit, 2);
      assert.match(e.message, /'Work'/);
      assert.match(e.message, /'work'/);
      return true;
    });
  assert.deepEqual(build.calls, [], 'no build ran');
  assert.deepEqual(branches(dir), refsBefore, 'no branch was created');
  assert.equal(fs.existsSync(intWt(dir)), false, 'no integration worktree was added');
  assert.equal(fs.existsSync(statePath(dir)), false, 'the run did not start');
});

test('F10 AC-1 other spellings: WORK and wOrK are refused against work too', async () => {
  for (const integ of ['WORK', 'wOrK', 'harness/Work']) {
    const dir = fixture();
    withUserBranch(dir, integ.startsWith('harness/') ? 'harness/work' : 'work');
    await assert.rejects(runFeatures({ root: dir, config: cfg(integ), deps: deps() }),
      (e) => e instanceof HarnessError && e.exit === 2 && e.message.includes(integ), integ);
  }
});

test('F10 AC-2: an existing branch with exactly the integration_branch spelling is still used', async () => {
  const dir = fixture();
  const before = withUserBranch(dir, 'work');
  const r = await runFeatures({ root: dir, config: cfg('work'), deps: deps() });
  assert.equal(r.results.find((x) => x.feature === 'F1')?.status, 'passed', JSON.stringify(r.results));
  const after = git(dir, 'rev-parse', 'refs/heads/work');
  assert.notEqual(after, before, 'the integration branch advanced');
  assert.equal(git(dir, 'merge-base', '--is-ancestor', before, after), '', 'it advanced from its own tip');
  // a repeated run on the same branch is allowed too
  await runFeatures({ root: dir, config: cfg('work'), deps: deps() });
});

test('F10 AC-3: a missing integration_branch is created from base', async () => {
  const dir = fixture();
  const base = git(dir, 'rev-parse', 'main');
  const build = fakeBuild();
  const r = await runFeatures({ root: dir, config: cfg('Work'), deps: deps({ build }) });
  assert.deepEqual(build.calls, ['F1']);
  assert.equal(r.results.find((x) => x.feature === 'F1')?.status, 'passed');
  assert.ok(branches(dir).includes('refs/heads/Work'), branches(dir).join(','));
  assert.equal(git(dir, 'merge-base', '--is-ancestor', base, 'refs/heads/Work'), '');
  assert.equal(git(dir, 'rev-parse', 'main'), base, 'main did not move');
});

test('F10 SC-1: the user branch work keeps its commit after a refused run on Work', async () => {
  const dir = fixture();
  const before = withUserBranch(dir, 'work');
  const mainBefore = git(dir, 'rev-parse', 'main');
  await assert.rejects(runFeatures({ root: dir, config: cfg('Work'), deps: deps() }), (e) => e instanceof HarnessError && e.exit === 2);
  assert.equal(git(dir, 'rev-parse', 'refs/heads/work'), before, 'work did not move');
  assert.equal(git(dir, 'rev-parse', 'main'), mainBefore, 'main did not move');
});

// Delegates to the real git, except that `for-each-ref` fails.
function brokenForEachRef() {
  const calls = [];
  const fn = async (args, cwd) => {
    calls.push(args);
    if (args.includes('for-each-ref')) return { code: 128, stdout: '', stderr: 'fatal: simulated for-each-ref failure', timedOut: false };
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, timedOut: false };
  };
  fn.calls = calls;
  return fn;
}

test('F10 ES-1: when for-each-ref fails the run does not start and exits 2', async () => {
  const dir = fixture();
  const refsBefore = branches(dir);
  const runGit = brokenForEachRef();
  const build = fakeBuild();
  await assert.rejects(
    runFeatures({ root: dir, config: cfg('Work'), deps: deps({ build, git: runGit }) }),
    (e) => e instanceof HarnessError && e.exit === 2 && /for-each-ref|local branches/.test(e.message));
  assert.ok(runGit.calls.some((a) => a.includes('for-each-ref')), 'the seam was used');
  assert.deepEqual(build.calls, []);
  assert.deepEqual(branches(dir), refsBefore, 'no branch was created');
  assert.equal(fs.existsSync(intWt(dir)), false);
  assert.equal(fs.existsSync(statePath(dir)), false);
});
