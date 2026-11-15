import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, REPO } from './helpers.mjs';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { pruneWorktrees } from '../lib/commands/worktree.mjs';
import { loadConfig } from '../lib/config.mjs';
import { git as coreGit } from '../lib/run/worktree.mjs';

const real = (p) => fs.realpathSync.native(p);

// An initialized project at the top of a git repository; the main worktree is on main.
function project() {
  return gitRepo({
    '.harness/config.json': {
      profile: 'sdlc', base_branch: 'main', integration_branch: 'harness/integration',
      protected_branches: ['main'], verify: { commands: [] },
    },
    '.harness/features.json': { features: [] },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n',
    'a.txt': 'a\n',
  }, { branch: null });
}

const wtDir = (repo, name) => path.join(repo, '.harness', 'wt', name);

// A linked worktree on a new branch from `from` with one commit on it; `merge` fast-forwards
// (or merges) main to it in the main worktree.
function workedWt(repo, name, { merge = true, from = 'main' } = {}) {
  const dir = wtDir(repo, name);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', name, dir, from);
  writeFiles(dir, { [`${name}.txt`]: 'x\n' });
  commitAll(dir, `on ${name}`);
  if (merge) git(repo, 'merge', '-q', '--no-edit', name);
  return dir;
}

const hasBranch = (repo, b) => git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')
  .split('\n').includes(b);

// pruneWorktrees run at `root` with the real git runner, recording every call as {args, cwd}.
async function recordedPrune(root) {
  const calls = [];
  const lines = { out: [], err: [] };
  const run = (args, cwd) => { calls.push({ args, cwd }); return coreGit(args, cwd, { timeoutSec: 60 }); };
  const code = await pruneWorktrees({
    root, cfg: loadConfig(root), run, out: (l) => lines.out.push(l), err: (l) => lines.err.push(l),
  });
  return { code, calls, ...lines };
}
const deleteCalls = (calls) => calls.filter((c) => c.args[0] === 'branch' && c.args[1] === '-d');

test('F183 AC-1 prune run inside a linked worktree removes a merged clean worktree and its branch, exit 0', () => {
  const repo = project();
  // The worktree prune runs in has its own commit; `done` is merged into main, not into it.
  const runner = workedWt(repo, 'runner', { merge: false });
  const done = workedWt(repo, 'done');
  assert.notEqual(
    coreGitSync(runner, ['merge-base', '--is-ancestor', 'refs/heads/done', 'HEAD']), 0,
    'done is not merged into the runner HEAD',
  );
  const r = harness(['worktree', 'prune'], { cwd: runner });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stderr.includes('harness: warning:'), r.stderr);
  assert.ok(!fs.existsSync(done), 'merged worktree removed');
  assert.equal(hasBranch(repo, 'done'), false, 'merged branch deleted');
  // The worktree prune runs in (unmerged) and its branch stay.
  assert.ok(fs.existsSync(runner));
  assert.equal(hasBranch(repo, 'runner'), true);
});

function coreGitSync(cwd, args) {
  try {
    git(cwd, ...args);
    return 0;
  } catch {
    return 1;
  }
}

test('F183 AC-2 branch deletion runs in the worktree with base_branch checked out, else in the root', async () => {
  // Main worktree on main: git branch -d runs there, not in the linked worktree prune runs in.
  const repo = project();
  const runner = workedWt(repo, 'runner', { merge: false });
  workedWt(repo, 'done');
  const a = await recordedPrune(runner);
  assert.equal(a.code, 0, a.err.join('\n'));
  assert.deepEqual(deleteCalls(a.calls).map((c) => [c.args, real(c.cwd)]), [[['branch', '-d', 'done'], real(repo)]]);
  assert.equal(hasBranch(repo, 'done'), false);

  // base_branch checked out in a linked worktree (main worktree detached): deletion runs there.
  const repo2 = project();
  const runner2 = workedWt(repo2, 'runner', { merge: false });
  workedWt(repo2, 'done');
  git(repo2, 'checkout', '-q', '--detach');
  const baseWt = wtDir(repo2, 'base');
  git(repo2, 'worktree', 'add', '-q', baseWt, 'main');
  const b = await recordedPrune(runner2);
  assert.equal(b.code, 0, b.err.join('\n'));
  assert.deepEqual(deleteCalls(b.calls).map((c) => [c.args, real(c.cwd)]), [[['branch', '-d', 'done'], real(baseWt)]]);
  assert.equal(hasBranch(repo2, 'done'), false);

  // No worktree has base_branch checked out: deletion runs in the root, as before.
  const repo3 = project();
  workedWt(repo3, 'done');
  git(repo3, 'checkout', '-q', '--detach');
  const c = await recordedPrune(repo3);
  assert.equal(c.code, 0, c.err.join('\n'));
  assert.deepEqual(deleteCalls(c.calls).map((x) => [x.args, real(x.cwd)]), [[['branch', '-d', 'done'], real(repo3)]]);
  assert.equal(hasBranch(repo3, 'done'), false);
});

test('F183 AC-3 SPEC section 8.12 says branch deletion runs in the worktree with base_branch checked out', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const at = spec.search(/^### 8\.12 /m);
  assert.ok(at >= 0, 'no SPEC section 8.12');
  const section = spec.slice(at, spec.indexOf('\n### ', at + 1));
  assert.ok(section.includes('checked out'), 'SPEC 8.12 lacks "checked out"');
  assert.match(section, /`base_branch`[^\n]*checked out/, 'SPEC 8.12 ties the deletion to base_branch checked out');
});

test('F183 SC-1 prune from a linked worktree keeps unmerged worktrees and branches, removes the merged one, never forces', async () => {
  const repo = project();
  const runner = workedWt(repo, 'runner', { merge: false });
  const unmerged = workedWt(repo, 'unmerged-one', { merge: false });
  git(repo, 'branch', 'loose-unmerged', 'unmerged-one');
  const done = workedWt(repo, 'done');
  const r = await recordedPrune(runner);
  assert.equal(r.code, 0, r.err.join('\n'));
  // Merged: removed with its branch.
  assert.ok(!fs.existsSync(done));
  assert.equal(hasBranch(repo, 'done'), false);
  // Unmerged: worktrees and branches kept.
  for (const d of [runner, unmerged]) assert.ok(fs.existsSync(d), `${d} kept`);
  for (const b of ['runner', 'unmerged-one', 'loose-unmerged']) assert.equal(hasBranch(repo, b), true, `${b} kept`);
  // Never a forcing call.
  for (const { args } of r.calls) {
    assert.ok(!(args[0] === 'branch' && args.some((x) => x === '-D' || x === '--force' || x === '-f')), args.join(' '));
    assert.ok(!(args[0] === 'update-ref' && args.includes('-d')), args.join(' '));
    assert.ok(!(args[0] === 'worktree' && args[1] === 'remove' && args.some((x) => x === '--force' || x === '-f')), args.join(' '));
  }
  assert.deepEqual(deleteCalls(r.calls).map((c) => c.args), [['branch', '-d', 'done']]);
});

test('F183 ES-1 no worktree has base_branch checked out and git branch -d refuses: warning, branch kept, exit 1', () => {
  const repo = project();
  const runner = workedWt(repo, 'runner', { merge: false });
  // Contrast: with main checked out in the main worktree, prune from the runner deletes the branch.
  const first = workedWt(repo, 'first');
  const ok = harness(['worktree', 'prune'], { cwd: runner });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(hasBranch(repo, 'first'), false);
  // Now no worktree has main checked out, and `second` is not merged into the runner HEAD.
  const second = workedWt(repo, 'second');
  git(repo, 'checkout', '-q', '--detach');
  const r = harness(['worktree', 'prune'], { cwd: runner });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const warn = r.stderr.split('\n').find((l) => l.startsWith('harness: warning:') && l.includes('second'));
  assert.ok(warn, r.stderr);
  assert.ok(warn.includes(path.basename(second)) && warn.includes(`${path.sep}wt${path.sep}`), warn);
  assert.match(warn, /not fully merged|merged/i, warn);
  assert.equal(hasBranch(repo, 'second'), true, 'branch kept');
  assert.ok(!fs.existsSync(first));
});
