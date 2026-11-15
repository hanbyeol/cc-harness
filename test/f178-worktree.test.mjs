import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { harness, realTmpdir, readJson, BIN, REPO } from './helpers.mjs';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';

const real = (p) => fs.realpathSync.native(p);
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

// An initialized project at the top of a git repository; the main worktree is on `head`.
function project({ config = {}, head = 'main' } = {}) {
  const dir = gitRepo({
    '.harness/config.json': {
      profile: 'sdlc', base_branch: 'main', integration_branch: 'harness/integration',
      protected_branches: ['main', 'release'], verify: { commands: [] }, ...config,
    },
    '.harness/features.json': { features: [] },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n',
    '.gitignore': '.claude/\n',
    'a.txt': 'a\n',
  }, { branch: head === 'main' ? null : head });
  return dir;
}

// A linked worktree at `dir` on a new branch `branch` from main; `commit` adds a commit on it.
function addWt(repo, dir, branch, { commit = false } = {}) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', branch, dir, 'main');
  if (commit) {
    writeFiles(dir, { [`${branch.replace(/\W/g, '_')}.txt`]: 'x\n' });
    commitAll(dir, `on ${branch}`);
  }
  return dir;
}

const branches = (repo) => git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean).sort();
const registered = (repo) => git(repo, 'worktree', 'list', '--porcelain').split('\n')
  .filter((l) => l.startsWith('worktree ')).map((l) => path.resolve(l.slice('worktree '.length)));
const same = (a, b) => {
  const r = (p) => { try { return real(p); } catch { return path.resolve(p); } };
  return r(a) === r(b);
};

// `worktree list` lines split into [path, branch, state, outside?].
function listed(repo) {
  const r = harness(['worktree', 'list'], { cwd: repo });
  assert.equal(r.code, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean).map((l) => l.split(/ {2,}/));
}
const rowOf = (rows, dir) => rows.find((r) => same(r[0], dir));

function guard(input, cwd = process.cwd()) {
  const r = spawnSync(process.execPath, [BIN, 'guard-worktree'], { cwd, input, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const hookInput = (command, cwd) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });
function assertDeny(r, what) {
  assert.equal(r.code, 0, `${what}: ${r.stderr}`);
  const o = JSON.parse(r.stdout);
  assert.equal(o.hookSpecificOutput.hookEventName, 'PreToolUse', what);
  assert.equal(o.hookSpecificOutput.permissionDecision, 'deny', what);
  assert.match(o.hookSpecificOutput.permissionDecisionReason, /harness worktree add/, what);
}
function assertSilent(r, what) {
  assert.equal(r.code, 0, `${what}: ${r.stderr}`);
  assert.equal(r.stdout, '', what);
}

// A repository with one worktree of every kind; returns the paths by kind.
function everyKind() {
  const repo = project();
  const out = realTmpdir('f178-out-');
  const wt = (n) => path.join(repo, '.harness', 'wt', n);
  const k = {
    repo,
    prunable: addWt(repo, wt('merged'), 'merged'),
    dirty: addWt(repo, path.join(repo, '.claude', 'worktrees', 'dirty'), 'dirty'),
    untracked: addWt(repo, wt('untracked'), 'untracked'),
    locked: addWt(repo, wt('locked'), 'locked'),
    unmerged: addWt(repo, wt('unmerged'), 'unmerged', { commit: true }),
    detached: wt('detached'),
    integration: addWt(repo, wt('integration'), 'harness/integration'),
    release: addWt(repo, wt('release'), 'release'),
    outside: addWt(repo, path.join(out, 'repo-f210'), 'f210'),
  };
  fs.mkdirSync(path.dirname(k.detached), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '--detach', k.detached, 'main');
  fs.writeFileSync(path.join(k.dirty, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(k.untracked, 'new.txt'), 'new\n');
  git(repo, 'worktree', 'lock', k.locked);
  return k;
}

test('F178 AC-1 worktree add creates .harness/wt/<name> on a new branch and refuses existing names', () => {
  const repo = project();
  const head = git(repo, 'rev-parse', 'HEAD');
  const r = harness(['worktree', 'add', 'feat-x'], { cwd: repo });
  assert.equal(r.code, 0, r.stderr);
  const dir = path.join(repo, '.harness', 'wt', 'feat-x');
  const printed = r.stdout.trim();
  assert.ok(path.isAbsolute(printed), printed);
  assert.equal(real(printed), real(dir));
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat-x');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.ok(registered(repo).some((p) => same(p, dir)));

  const b = harness(['worktree', 'add', 'other', '--branch', 'topic/y'], { cwd: repo });
  assert.equal(b.code, 0, b.stderr);
  assert.equal(git(path.join(repo, '.harness', 'wt', 'other'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'topic/y');

  // The same name again (directory and branch exist): exit 1, nothing new.
  const before = { b: branches(repo), w: registered(repo) };
  const again = harness(['worktree', 'add', 'feat-x'], { cwd: repo });
  assert.equal(again.code, 1, again.stderr);
  // A branch with the name exists but no directory: exit 1, no directory.
  git(repo, 'branch', 'taken');
  const taken = harness(['worktree', 'add', 'taken'], { cwd: repo });
  assert.equal(taken.code, 1, taken.stderr);
  assert.equal(fs.existsSync(path.join(repo, '.harness', 'wt', 'taken')), false);
  // A directory with the name exists but no branch: exit 1, no branch.
  fs.mkdirSync(path.join(repo, '.harness', 'wt', 'leftover'));
  const left = harness(['worktree', 'add', 'leftover'], { cwd: repo });
  assert.equal(left.code, 1, left.stderr);
  assert.deepEqual(branches(repo), [...before.b, 'taken'].sort());
  assert.deepEqual(registered(repo), before.w);
});

test('F178 AC-2 worktree list prints path, branch and state of every worktree, marking outside paths', () => {
  const k = everyKind();
  const rows = listed(k.repo);
  assert.equal(rows.length, 10, JSON.stringify(rows));
  const expect = [
    [k.repo, 'main', 'main'], [k.prunable, 'merged', 'prunable'], [k.dirty, 'dirty', 'dirty'],
    [k.untracked, 'untracked', 'dirty'], [k.locked, 'locked', 'locked'], [k.unmerged, 'unmerged', 'unmerged'],
    [k.detached, '(detached)', 'detached'], [k.integration, 'harness/integration', 'protected'],
    [k.release, 'release', 'protected'], [k.outside, 'f210', 'prunable'],
  ];
  for (const [dir, branch, state] of expect) {
    const row = rowOf(rows, dir);
    assert.ok(row, `no row for ${dir}: ${JSON.stringify(rows)}`);
    assert.equal(row[1], branch, dir);
    assert.equal(row[2], state, dir);
    assert.equal(row[3], dir === k.outside ? 'outside' : undefined, dir);
  }
});

test('F178 AC-3 worktree prune removes merged clean worktrees inside and outside the project and stale registrations', () => {
  const repo = project();
  const out = realTmpdir('f178-out-');
  const a = addWt(repo, path.join(repo, '.harness', 'wt', 'a'), 'a');
  const b = addWt(repo, path.join(repo, '.claude', 'worktrees', 'agent-b'), 'agent-b');
  const c = addWt(repo, path.join(out, 'repo-f210'), 'f210');
  const gone = addWt(repo, path.join(out, 'gone'), 'gone');
  const keep = addWt(repo, path.join(repo, '.harness', 'wt', 'keep'), 'keep', { commit: true });
  fs.rmSync(gone, { recursive: true, force: true });
  const r = harness(['worktree', 'prune'], { cwd: repo });
  assert.equal(r.code, 0, r.stderr);
  for (const d of [a, b, c]) {
    assert.equal(fs.existsSync(d), false, d);
    assert.ok(r.stdout.split('\n').some((l) => l.includes(d)), `${d} not printed: ${r.stdout}`);
  }
  assert.deepEqual(registered(repo).map((p) => real(p)).sort(), [real(repo), real(keep)].sort());
  assert.deepEqual(branches(repo), ['keep', 'main']);
  assert.ok(fs.existsSync(keep));
});

test('F178 AC-4 worktree prune --dry-run prints would remove for the same targets and changes nothing', () => {
  const repo = project();
  const out = realTmpdir('f178-out-');
  const a = addWt(repo, path.join(repo, '.harness', 'wt', 'a'), 'a');
  const b = addWt(repo, path.join(repo, '.claude', 'worktrees', 'agent-b'), 'agent-b');
  const c = addWt(repo, path.join(out, 'repo-f210'), 'f210');
  addWt(repo, path.join(repo, '.harness', 'wt', 'keep'), 'keep', { commit: true });
  const before = { b: branches(repo), w: registered(repo) };
  const r = harness(['worktree', 'prune', '--dry-run'], { cwd: repo });
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 3, r.stdout);
  for (const d of [a, b, c]) {
    assert.ok(lines.some((l) => l.startsWith('would remove ') && same(l.slice('would remove '.length), d)), `${d}: ${r.stdout}`);
    assert.ok(fs.existsSync(d), d);
  }
  assert.deepEqual(branches(repo), before.b);
  assert.deepEqual(registered(repo), before.w);
});

test('F178 AC-5 status --brief adds the worktrees line only when there is something to prune or outside', () => {
  const repo = project();
  const line = (r) => r.stdout.split('\n').filter((l) => l.startsWith('worktrees:'));
  const zero = harness(['status', '--brief'], { cwd: repo });
  assert.equal(zero.code, 0, zero.stderr);
  assert.deepEqual(line(zero), []);
  // An unmerged worktree inside the project counts for neither.
  addWt(repo, path.join(repo, '.harness', 'wt', 'busy'), 'busy', { commit: true });
  assert.deepEqual(line(harness(['status', '--brief'], { cwd: repo })), []);
  addWt(repo, path.join(repo, '.harness', 'wt', 'done'), 'done');
  addWt(repo, path.join(realTmpdir('f178-out-'), 'repo-f210'), 'f210', { commit: true });
  const r = harness(['status', '--brief'], { cwd: repo });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(line(r), ['worktrees: 1 to prune (harness worktree prune) · 1 outside the project']);
});

test('F178 AC-6 the PreToolUse Bash hook runs guard-worktree, which denies worktrees outside the repository', () => {
  const hooks = readJson(path.join(REPO, 'hooks', 'hooks.json')).hooks;
  const entry = hooks.PreToolUse.find((e) => e.matcher === 'Bash');
  assert.ok(entry, JSON.stringify(hooks));
  assert.ok(entry.hooks.some((h) => h.type === 'command' && h.command === 'node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" guard-worktree'));
  // A repository without .harness/: the guard needs no initialization.
  const repo = gitRepo({ 'a.txt': 'a\n' }, { branch: null });
  const elsewhere = realTmpdir('f178-else-');
  assertDeny(guard(hookInput('git worktree add ../x', repo)), '../x');
  assertDeny(guard(hookInput('git worktree add -b br ../x', repo)), '-b br ../x');
  assertDeny(guard(hookInput(`git worktree add '${path.join(elsewhere, 'x')}'`, repo)), 'absolute');
  assertDeny(guard(hookInput(`git -C '${repo}' worktree add ../x main`, elsewhere)), '-C repo');
});

test('F178 AC-7 guard-worktree is silent for in-repo paths, other commands, non-git cwd and invalid JSON', () => {
  const repo = gitRepo({ 'a.txt': 'a\n' }, { branch: null });
  const plain = realTmpdir('f178-plain-');
  assertSilent(guard(hookInput('git worktree add .harness/wt/x', repo)), '.harness/wt/x');
  assertSilent(guard(hookInput('git worktree add -b x .claude/worktrees/x', repo)), '.claude/worktrees/x');
  assertSilent(guard(hookInput('git status && ls ../x', repo)), 'other command');
  assertSilent(guard(hookInput('git worktree list', repo)), 'worktree list');
  assertSilent(guard(hookInput('git worktree add ../x', plain)), 'non-git cwd');
  assertSilent(guard('not json', repo), 'invalid json');
  assertSilent(guard('', repo), 'empty stdin');
  // Contrast: the same command outside the repository is denied.
  assertDeny(guard(hookInput('git worktree add ../x', repo)), '../x');
});

test('F178 AC-8 docs say to use harness run or harness worktree add and to prune after merge and push', () => {
  for (const f of ['skills/build/SKILL.md', 'skills/fix/SKILL.md', 'agents/builder.md', 'AGENTS.md']) {
    const t = read(f);
    assert.match(t, /`harness run`[^.]*`harness worktree add/, `${f}: parallel work`);
    assert.match(t, /merg[^.]*push[^.]*`harness worktree prune`/i, `${f}: prune after merge and push`);
  }
  const spec = read('docs/SPEC.md');
  const at = spec.search(/^#{2,3} .*`harness worktree add\|list\|prune`/m);
  assert.ok(at >= 0, 'no SPEC section for harness worktree');
  const section = spec.slice(at, spec.indexOf('\n## ', at + 1));
  for (const s of ['.harness/wt/<name>', 'guard-worktree', 'PreToolUse', '--dry-run', 'prunable', 'outside']) {
    assert.ok(section.includes(s), `SPEC section lacks ${s}`);
  }
});

test('F178 SC-1 prune keeps dirty, untracked, locked, unmerged, detached, protected and main worktrees', () => {
  // The main worktree is on `dev` (merged, clean): only its being the main worktree keeps it.
  const repo = project({ head: 'dev' });
  const wt = (n) => path.join(repo, '.harness', 'wt', n);
  const keep = {
    dirty: addWt(repo, wt('dirty'), 'dirty'),
    untracked: addWt(repo, wt('untracked'), 'untracked'),
    locked: addWt(repo, wt('locked'), 'locked'),
    unmerged: addWt(repo, wt('unmerged'), 'unmerged', { commit: true }),
    integration: addWt(repo, wt('integration'), 'harness/integration'),
    release: addWt(repo, wt('release'), 'release'),
  };
  fs.mkdirSync(wt(''), { recursive: true });
  git(repo, 'worktree', 'add', '-q', wt('base'), 'main');
  keep.base = wt('base');
  git(repo, 'worktree', 'add', '-q', '--detach', wt('detached'), 'main');
  keep.detached = wt('detached');
  fs.writeFileSync(path.join(keep.dirty, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(keep.untracked, 'new.txt'), 'new\n');
  git(repo, 'worktree', 'lock', keep.locked);
  const ok = addWt(repo, wt('ok'), 'ok');
  const before = branches(repo);
  const r = harness(['worktree', 'prune'], { cwd: repo });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.existsSync(ok), false, 'merged clean worktree is removed');
  assert.ok(!branches(repo).includes('ok'));
  for (const [kind, dir] of Object.entries(keep)) assert.ok(fs.existsSync(dir), kind);
  assert.ok(fs.existsSync(path.join(repo, 'a.txt')), 'main worktree');
  assert.deepEqual(branches(repo), before.filter((b) => b !== 'ok'));
  assert.deepEqual(registered(repo).map((p) => real(p)).sort(), [repo, ...Object.values(keep)].map((p) => real(p)).sort());
});

test('F178 SC-2 worktree add rejects unsafe names with exit 2 and creates nothing', () => {
  const repo = project();
  fs.mkdirSync(path.join(repo, '.harness', 'wt'), { recursive: true });
  const before = { b: branches(repo), w: registered(repo), d: fs.readdirSync(path.join(repo, '.harness', 'wt')) };
  const names = ['', '..', '../x', 'a/b', 'a\\b', '/abs', '-x', '.', 'a b', 'a:b', 'café', 'x;y'];
  for (const name of names) {
    const r = harness(['worktree', 'add', name], { cwd: repo });
    assert.equal(r.code, 2, `${JSON.stringify(name)}: ${r.stdout} ${r.stderr}`);
  }
  assert.deepEqual(branches(repo), before.b);
  assert.deepEqual(registered(repo), before.w);
  assert.deepEqual(fs.readdirSync(path.join(repo, '.harness', 'wt')), before.d);
  assert.equal(fs.existsSync(path.join(path.dirname(repo), 'x')), false);
  const ok = harness(['worktree', 'add', 'ok-1'], { cwd: repo });
  assert.equal(ok.code, 0, ok.stderr);
  assert.ok(fs.existsSync(path.join(repo, '.harness', 'wt', 'ok-1')));
  assert.ok(branches(repo).includes('ok-1'));
});

test('F178 SC-3 prune deletes branches with branch -d and never uses branch -D or worktree remove --force', async () => {
  const { pruneWorktrees } = await import('../lib/commands/worktree.mjs');
  const { git: coreGit } = await import('../lib/run/worktree.mjs');
  const { loadConfig } = await import('../lib/config.mjs');
  const repo = project();
  const a = addWt(repo, path.join(repo, '.harness', 'wt', 'a'), 'a');
  const b = addWt(repo, path.join(repo, '.claude', 'worktrees', 'b'), 'b');
  const calls = [];
  const run = (args, cwd) => { calls.push(args); return coreGit(args, cwd); };
  const code = await pruneWorktrees({ root: repo, cfg: loadConfig(repo), run, out: () => {}, err: () => {} });
  assert.equal(code, 0);
  assert.ok(!fs.existsSync(a) && !fs.existsSync(b));
  const removes = calls.filter((c) => c[0] === 'worktree' && c[1] === 'remove');
  assert.equal(removes.length, 2, JSON.stringify(calls));
  for (const c of removes) assert.ok(!c.includes('--force') && !c.includes('-f'), c.join(' '));
  const deletes = calls.filter((c) => c[0] === 'branch').sort((x, y) => (x[2] < y[2] ? -1 : 1));
  assert.deepEqual(deletes, [['branch', '-d', 'a'], ['branch', '-d', 'b']]);
  for (const c of calls) {
    assert.ok(!(c[0] === 'branch' && c.some((x) => x === '-D' || x === '--force' || x === '-f')), c.join(' '));
    assert.ok(!(c[0] === 'update-ref' && c.includes('-d')), c.join(' '));
  }
});

test('F178 ES-1 worktree commands outside an initialized project report not initialized', () => {
  const dir = gitRepo({ 'a.txt': 'a\n' }, { branch: null });
  const ref = harness(['verify', 'F1'], { cwd: dir });
  assert.equal(ref.code, 2);
  for (const args of [['worktree', 'list'], ['worktree', 'prune'], ['worktree', 'add', 'x']]) {
    const r = harness(args, { cwd: dir });
    assert.equal(r.code, ref.code, args.join(' '));
    assert.equal(r.stderr, ref.stderr, args.join(' '));
    assert.match(r.stderr, /not initialized/);
  }
  assert.equal(fs.existsSync(path.join(dir, '.harness')), false);
});

test('F178 ES-2 a failing worktree remove is reported, keeps its branch and the rest continues', async () => {
  const { pruneWorktrees } = await import('../lib/commands/worktree.mjs');
  const { git: coreGit } = await import('../lib/run/worktree.mjs');
  const { loadConfig } = await import('../lib/config.mjs');
  const repo = project();
  const a = addWt(repo, path.join(repo, '.harness', 'wt', 'a'), 'a');
  const b = addWt(repo, path.join(repo, '.harness', 'wt', 'b'), 'b');
  // A file appears in `a` after it was classified: git refuses the remove without --force.
  const run = (args, cwd) => {
    if (args[0] === 'worktree' && args[1] === 'remove' && same(args.at(-1), a)) fs.writeFileSync(path.join(a, 'late.txt'), 'late\n');
    return coreGit(args, cwd);
  };
  const outs = [];
  const errs = [];
  const code = await pruneWorktrees({ root: repo, cfg: loadConfig(repo), run, out: (s) => outs.push(s), err: (s) => errs.push(s) });
  assert.equal(code, 1);
  const warning = errs.join('\n');
  assert.ok(warning.includes(a), warning);
  assert.match(warning, /untracked|modified/, warning);
  assert.ok(fs.existsSync(path.join(a, 'late.txt')));
  assert.ok(branches(repo).includes('a'));
  assert.equal(fs.existsSync(b), false);
  assert.ok(!branches(repo).includes('b'));
  assert.ok(outs.some((l) => l.includes(b)));
});

test('F178 ES-3 prune without the local base branch exits 1 and removes nothing', () => {
  const repo = project({ config: { base_branch: 'trunk' } });
  const a = addWt(repo, path.join(repo, '.harness', 'wt', 'a'), 'a');
  const before = { b: branches(repo), w: registered(repo) };
  for (const args of [['worktree', 'prune'], ['worktree', 'prune', '--dry-run']]) {
    const r = harness(args, { cwd: repo });
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, /base branch trunk not found/);
  }
  assert.ok(fs.existsSync(a));
  assert.deepEqual(branches(repo), before.b);
  assert.deepEqual(registered(repo), before.w);
});
