// F143: harness run deletes feature branches with `git update-ref -d` (never `branch -D`), so a run
// does not rewrite .git/config (lock file + rename), which fails concurrent unlocked git reads on Windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from './helpers.mjs';
import { git, gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import * as run from '../lib/run.mjs';

const quoted = (p) => JSON.stringify(p.split(path.sep).join('/'));

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id}.txt exists`, check: `node scripts/has.mjs ${quoted(`${id}.txt`)}`, new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-18T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture(ids = ['F1']) {
  const files = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\nruns/test-count-cache.json\nruns/verify-cache.json\n',
    '.harness/features.json': { features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: 'standard', depends_on: [], status: 'approved' })) },
    'scripts/has.mjs': "import fs from 'node:fs';\nprocess.exit(process.argv.slice(2).every((f) => fs.existsSync(f)) ? 0 : 1);\n",
    'shared.txt': 'original\n',
  };
  for (const id of ids) files[`.harness/contracts/${id}.json`] = contract(id);
  return gitRepo(files, { branch: null });
}

const cfg = (over = {}) => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, ...over });
const evaluate = async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });
const build = async (a) => { writeFiles(a.cwd, { [`${a.featureId}.txt`]: 'built\n' }); return { ok: true, costUsd: 0 }; };
const failBuild = async () => { throw new Error('builder must not be called'); };
const runF = (dir, deps = {}, extra = {}) => run.runFeatures({ root: dir, config: cfg(extra.config), ids: extra.ids, fresh: extra.fresh, deps: { evaluate, build, cpus: 8, ...deps } });
const statusOf = (dir, id = 'F1') => JSON.parse(fs.readFileSync(path.join(dir, '.harness/features.json'), 'utf8')).features.find((f) => f.id === id).status;
const resultOf = (r, id = 'F1') => r.results.find((x) => x.feature === id);
const hasRef = (dir, ref) => spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: dir }).status === 0;
const configFile = (dir) => path.join(dir, '.git', 'config');
const snap = (dir) => {
  const f = configFile(dir);
  const st = fs.statSync(f, { bigint: true });
  return { ino: st.ino, mtimeMs: st.mtimeMs, text: fs.readFileSync(f, 'utf8') };
};
const wtDir = (dir, id) => path.join(dir, '.harness', 'wt', id);

function recordingGit(override) {
  const calls = [];
  const fn = async (args, cwd, opts) => {
    calls.push(args);
    const o = override?.(args, cwd);
    if (o) return o;
    return run.git(args, cwd, opts);
  };
  fn.calls = calls;
  return fn;
}

test('F143 AC-1: a two-feature run leaves .git/config untouched (ino, mtime, text) and removes branches and worktrees', async () => {
  const dir = fixture(['F1', 'F2']);
  const before = snap(dir);
  const r = await runF(dir, {}, { config: { run: { max_parallel: 2 } } });
  assert.equal(resultOf(r, 'F1').status, 'passed');
  assert.equal(resultOf(r, 'F2').status, 'passed');
  for (const id of ['F1', 'F2']) {
    assert.equal(hasRef(dir, `refs/heads/harness/${id}`), false);
    assert.equal(fs.existsSync(wtDir(dir, id)), false);
  }
  assert.deepEqual(snap(dir), before);
});

test('F143 AC-2: the only branch deletion is update-ref -d with the merged sha; no branch -D/-d/--delete/-m/-M', async () => {
  const dir = fixture();
  const g = recordingGit();
  let tip = null;
  const g2 = async (args, cwd, opts) => {
    if (args[0] === 'update-ref') tip = git(dir, 'rev-parse', 'refs/heads/harness/F1');
    return g(args, cwd, opts);
  };
  g2.calls = g.calls;
  const r = await runF(dir, { git: g2 });
  assert.equal(resultOf(r).status, 'passed');
  const bad = g.calls.filter((a) => a[0] === 'branch' && a.some((x) => ['-D', '-d', '--delete', '-m', '-M'].includes(x)));
  assert.deepEqual(bad, []);
  const del = g.calls.filter((a) => a[0] === 'update-ref' && a.includes('-d'));
  assert.deepEqual(del, [['update-ref', '-d', 'refs/heads/harness/F1', tip]]);
  assert.match(tip, /^[0-9a-f]{40,64}$/);
});

test('F143 AC-3: --fresh with a leftover worktree and branch removes both and leaves .git/config untouched', async () => {
  const dir = fixture();
  git(dir, 'worktree', 'add', '-q', '-b', 'harness/F1', wtDir(dir, 'F1'), 'main');
  const before = snap(dir);
  const r = await runF(dir, {}, { ids: ['F1'], fresh: true });
  assert.equal(resultOf(r).status, 'passed');
  assert.equal(hasRef(dir, 'refs/heads/harness/F1'), false);
  assert.equal(fs.existsSync(wtDir(dir, 'F1')), false);
  assert.deepEqual(snap(dir), before);
});

test('F143 AC-4: the branch.harness/F1 config section is removed with the branch', async () => {
  const dir = fixture();
  git(dir, 'config', 'branch.harness/F1.description', 'x');
  const r = await runF(dir);
  assert.equal(resultOf(r).status, 'passed');
  assert.equal(hasRef(dir, 'refs/heads/harness/F1'), false);
  assert.equal(spawnSync('git', ['config', '--get-regexp', '^branch\\.harness/F1\\.'], { cwd: dir }).status, 1);
});

test('F143 AC-5: isSerializedGit covers update-ref -d and config --remove-section, not reads', () => {
  assert.equal(run.isSerializedGit(['update-ref', '-d', 'refs/heads/x', 'abc']), true);
  assert.equal(run.isSerializedGit(['config', '--remove-section', 'branch.x']), true);
  assert.equal(run.isSerializedGit(['config', '--get-regexp', '^branch\\.x\\.']), false);
  assert.equal(run.isSerializedGit(['status', '--porcelain']), false);
});

test('F143 AC-7: SPEC §8.10 and the --fresh paragraph name git update-ref -d', () => {
  const spec = fs.readFileSync(new URL('../docs/SPEC.md', import.meta.url), 'utf8');
  const line = spec.split('\n').find((l) => l.startsWith('- **git 직렬화**'));
  assert.ok(line.includes('git update-ref -d') && line.includes('.git/config') && line.includes('Windows'));
  const fresh = spec.split('\n').find((l) => l.startsWith('**`harness run --fresh'));
  assert.ok(fresh.includes('git update-ref -d') && !fresh.includes('git branch -D'));
});

test('F143 SC-1: when worktree remove fails after the merge the branch is kept', async () => {
  const dir = fixture();
  const g = recordingGit((args) => (args[0] === 'worktree' && args[1] === 'remove' ? { code: 1, stdout: '', stderr: 'fatal: locked' } : null));
  const r = await runF(dir, { git: g });
  assert.equal(resultOf(r).status, 'passed');
  assert.equal(hasRef(dir, 'refs/heads/harness/F1'), true);
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', 'harness/F1', 'harness/integration'], { cwd: dir }).status, 0);
});

test('F143 SC-2: --fresh with harness/F1 checked out in a user worktree blocks and keeps both', async () => {
  const dir = fixture();
  const other = path.join(tmpdir('harness-f143-other-'), 'user-wt');
  git(dir, 'worktree', 'add', '-q', '-b', 'harness/F1', other, 'main');
  const sha = git(dir, 'rev-parse', 'refs/heads/harness/F1');
  const r = await runF(dir, { build: failBuild }, { ids: ['F1'], fresh: true });
  const res = resultOf(r);
  assert.equal(res.status, 'blocked');
  assert.match(String(res.detail ?? res.reason ?? JSON.stringify(res)), /harness\/F1/);
  assert.equal(statusOf(dir), 'blocked');
  assert.equal(git(dir, 'rev-parse', 'refs/heads/harness/F1'), sha);
  assert.ok(fs.existsSync(other));
});

test('F143 SC-3: a branch moved just before update-ref -d is not deleted', async () => {
  const dir = fixture();
  let moved = null;
  const g = recordingGit();
  const g2 = async (args, cwd, opts) => {
    if (args[0] === 'update-ref' && args[1] === '-d') {
      moved = git(dir, 'rev-parse', 'main');
      git(dir, 'update-ref', 'refs/heads/harness/F1', moved);
    }
    return g(args, cwd, opts);
  };
  const r = await runF(dir, { git: g2 });
  assert.equal(resultOf(r).status, 'passed');
  assert.equal(git(dir, 'rev-parse', 'refs/heads/harness/F1'), moved);
});

test('F143 ES-1: --fresh update-ref -d failing blocks the feature with the git message and no build', async () => {
  const dir = fixture();
  git(dir, 'branch', 'harness/F1', 'main');
  const g = recordingGit((args) => (args[0] === 'update-ref' && args[1] === '-d' ? { code: 1, stdout: '', stderr: 'fatal: boom' } : null));
  const r = await runF(dir, { git: g, build: failBuild }, { ids: ['F1'], fresh: true });
  const res = resultOf(r);
  assert.equal(res.status, 'blocked');
  assert.ok(JSON.stringify(res).includes('--fresh could not delete the branch harness/F1: fatal: boom'));
});

test('F143 ES-2: update-ref -d failing after the merge is ignored; F1 passed and the branch stays', async () => {
  const dir = fixture();
  const g = recordingGit((args) => (args[0] === 'update-ref' && args[1] === '-d' ? { code: 1, stdout: '', stderr: 'fatal: boom' } : null));
  const r = await runF(dir, { git: g });
  assert.equal(resultOf(r).status, 'passed');
  assert.equal(hasRef(dir, 'refs/heads/harness/F1'), true);
});
