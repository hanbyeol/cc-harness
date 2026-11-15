import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, REPO } from './helpers.mjs';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';

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

// A linked worktree on a new branch from main with no commits on it (fresh).
function freshWt(repo, name) {
  const dir = wtDir(repo, name);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', name, dir, 'main');
  return dir;
}

// A linked worktree whose branch has one commit; `merge` fast-forwards main to it.
function workedWt(repo, name, { merge = true } = {}) {
  const dir = freshWt(repo, name);
  writeFiles(dir, { [`${name}.txt`]: 'x\n' });
  commitAll(dir, `on ${name}`);
  if (merge) git(repo, 'merge', '-q', '--ff-only', name);
  return dir;
}

const branches = (repo) => git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean).sort();
const same = (a, b) => {
  const r = (p) => { try { return real(p); } catch { return path.resolve(p); } };
  return r(a) === r(b);
};

// The state column of `worktree list` (run from `cwd`) for the worktree at `dir`.
function stateOf(cwd, dir) {
  const r = harness(['worktree', 'list'], { cwd });
  assert.equal(r.code, 0, r.stderr);
  const row = r.stdout.split('\n').filter(Boolean).map((l) => l.split(/ {2,}/)).find((x) => same(x[0], dir));
  assert.ok(row, `no row for ${dir}: ${r.stdout}`);
  return row[2];
}

const wouldRemove = (stdout) => stdout.split('\n').filter((l) => l.startsWith('would remove '))
  .map((l) => l.slice('would remove '.length));
const pruneLine = (r) => r.stdout.split('\n').filter((l) => l.startsWith('worktrees:'));

test('F181 AC-1 worktree list shows a branch with at most one reflog entry as fresh, a worked and merged one as prunable', () => {
  const repo = project();
  const add = harness(['worktree', 'add', 'new-one'], { cwd: repo });
  assert.equal(add.code, 0, add.stderr);
  const created = wtDir(repo, 'new-one');
  assert.equal(git(repo, 'reflog', 'show', '--format=%H', 'refs/heads/new-one', '--').split('\n').filter(Boolean).length, 1);
  const plain = freshWt(repo, 'plain');
  const done = workedWt(repo, 'done');
  assert.equal(stateOf(repo, created), 'fresh');
  assert.equal(stateOf(repo, plain), 'fresh');
  assert.equal(stateOf(repo, done), 'prunable');
  // Contrast: once the fresh branch gets a commit merged into main it is prunable too.
  writeFiles(plain, { 'p.txt': 'p\n' });
  commitAll(plain, 'on plain');
  git(repo, 'merge', '-q', '--no-edit', 'plain');
  assert.equal(stateOf(repo, plain), 'prunable');
});

test('F181 AC-2 worktree list shows the worktree containing the cwd as current only when it would be prunable', async () => {
  const repo = project();
  const here = workedWt(repo, 'here');
  const sub = path.join(here, 'sub', 'deeper');
  fs.mkdirSync(sub, { recursive: true });
  const fresh = freshWt(repo, 'fresh-one');
  const unmerged = workedWt(repo, 'unmerged-one', { merge: false });
  const locked = workedWt(repo, 'locked-one');
  git(repo, 'worktree', 'lock', locked);
  const dirty = workedWt(repo, 'dirty-one');
  fs.writeFileSync(path.join(dirty, 'a.txt'), 'changed\n');
  // Contrast: from the main worktree, `here` is prunable.
  assert.equal(stateOf(repo, here), 'prunable');
  assert.equal(stateOf(here, here), 'current');
  // The core command runs at a project root; a cwd deeper inside the worktree is current too.
  const { inspectWorktrees } = await import('../lib/commands/worktree.mjs');
  const { loadConfig } = await import('../lib/config.mjs');
  const stateIn = async (cwd, dir) => (await inspectWorktrees({ root: repo, cfg: loadConfig(repo), cwd }))
    .worktrees.find((w) => same(w.path, dir)).state;
  assert.equal(await stateIn(sub, here), 'current');
  assert.equal(await stateIn(repo, here), 'prunable');
  // From inside `here`, the other worktrees keep their states.
  assert.equal(stateOf(here, fresh), 'fresh');
  // The cwd inside a worktree that is not prunable leaves its state as it is.
  assert.equal(stateOf(fresh, fresh), 'fresh');
  assert.equal(stateOf(unmerged, unmerged), 'unmerged');
  assert.equal(stateOf(locked, locked), 'locked');
  assert.equal(stateOf(dirty, dirty), 'dirty');
  // The main worktree stays main when the cwd is in it.
  assert.equal(stateOf(repo, repo), 'main');
});

test('F181 AC-3 prune --dry-run and status --brief leave out fresh and current worktrees', () => {
  const repo = project();
  const done = workedWt(repo, 'done');
  const cur = workedWt(repo, 'cur');
  const fresh = freshWt(repo, 'fresh-one');
  // From the main worktree: done and cur would be removed, fresh not.
  const fromMain = harness(['worktree', 'prune', '--dry-run'], { cwd: repo });
  assert.equal(fromMain.code, 0, fromMain.stderr);
  const mainTargets = wouldRemove(fromMain.stdout);
  assert.equal(mainTargets.length, 2, fromMain.stdout);
  assert.ok(mainTargets.some((p) => same(p, done)) && mainTargets.some((p) => same(p, cur)), fromMain.stdout);
  assert.ok(!mainTargets.some((p) => same(p, fresh)), fromMain.stdout);
  const briefMain = harness(['status', '--brief'], { cwd: repo });
  assert.equal(briefMain.code, 0, briefMain.stderr);
  assert.equal(pruneLine(briefMain).length, 1, briefMain.stdout);
  assert.match(pruneLine(briefMain)[0], /^worktrees: 2 to prune /);
  // From inside cur: only done.
  const fromCur = harness(['worktree', 'prune', '--dry-run'], { cwd: cur });
  assert.equal(fromCur.code, 0, fromCur.stderr);
  const curTargets = wouldRemove(fromCur.stdout);
  assert.equal(curTargets.length, 1, fromCur.stdout);
  assert.ok(same(curTargets[0], done), fromCur.stdout);
  const briefCur = harness(['status', '--brief'], { cwd: cur });
  assert.equal(briefCur.code, 0, briefCur.stderr);
  // From cur, the other worktrees lie outside its top; only the prune count matters here.
  assert.equal(pruneLine(briefCur).length, 1, briefCur.stdout);
  assert.match(pruneLine(briefCur)[0], /^worktrees: 1 to prune /);
  for (const d of [done, cur, fresh]) assert.ok(fs.existsSync(d), d);
});

test('F181 AC-4 SPEC section 8.12 describes the fresh and current states and that prune keeps them', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const at = spec.search(/^### 8\.12 /m);
  assert.ok(at >= 0, 'no SPEC section 8.12');
  const section = spec.slice(at, spec.indexOf('\n### ', at + 1));
  for (const s of ['`fresh`', '`current`', 'reflog', 'cwd']) assert.ok(section.includes(s), `SPEC 8.12 lacks ${s}`);
  assert.match(section, /`fresh`[^\n]*`current`[^\n]*(지우지 않|남긴)/, 'prune keeps fresh and current');
});

test('F181 SC-1 prune keeps fresh and current worktrees and their branches, removes another merged clean one', () => {
  const repo = project();
  // done is merged before cur, so cur's HEAD contains it and `git branch -d done` run there succeeds.
  const done = workedWt(repo, 'done');
  const cur = workedWt(repo, 'cur');
  const fresh = freshWt(repo, 'fresh-one');
  const r = harness(['worktree', 'prune'], { cwd: cur });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.existsSync(done), false, 'merged clean worktree is removed');
  assert.ok(!branches(repo).includes('done'), 'its branch is deleted');
  assert.ok(r.stdout.split('\n').some((l) => l.startsWith('removed ') && same(l.slice('removed '.length), done)), r.stdout);
  for (const d of [cur, fresh]) assert.ok(fs.existsSync(d), d);
  assert.deepEqual(branches(repo), ['cur', 'fresh-one', 'main']);
  assert.ok(!r.stdout.includes(cur) && !r.stdout.includes(fresh), r.stdout);
});

test('F181 ES-1 a branch whose reflog cannot be read is fresh and kept by prune', () => {
  const repo = project();
  const nolog = workedWt(repo, 'nolog');
  const done = workedWt(repo, 'done');
  const common = path.resolve(repo, git(repo, 'rev-parse', '--git-common-dir'));
  const log = path.join(common, 'logs', 'refs', 'heads', 'nolog');
  assert.ok(fs.existsSync(log), log);
  // Contrast: with its reflog, nolog is prunable.
  assert.equal(stateOf(repo, nolog), 'prunable');
  fs.rmSync(log);
  assert.equal(stateOf(repo, nolog), 'fresh');
  const r = harness(['worktree', 'prune'], { cwd: repo });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(nolog), 'worktree without a reflog is kept');
  assert.ok(branches(repo).includes('nolog'));
  assert.equal(fs.existsSync(done), false, 'merged worktree with a reflog is removed');
  assert.ok(!branches(repo).includes('done'));
});
