import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpdir } from './helpers.mjs';
import { git, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import * as run from '../lib/run.mjs';

// ------------------------------------------------------------------ fixtures
// The repository lives in <box>/repo so that "../x" is a directory of the test's own.

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id}.txt exists`, check: `node scripts/has.mjs ${id}.txt`, new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-23T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function initRepo(dir, ids, runCfg) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(dir, 'config', 'user.name', 'Harness Test');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.hooksPath', path.join(dir, '.git', 'no-hooks'));
  git(dir, 'config', 'core.autocrlf', 'false');
  const files = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, run: runCfg },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: 'standard', depends_on: [], status: 'approved' })) },
    'scripts/has.mjs': "import fs from 'node:fs';\nprocess.exit(process.argv.slice(2).every((f) => fs.existsSync(f)) ? 0 : 1);\n",
  };
  for (const id of ids) files[`.harness/contracts/${id}.json`] = contract(id);
  writeFiles(dir, files);
  commitAll(dir, 'base');
}

function fixture(value, { ids = ['F1'] } = {}) {
  // .native: on Windows only the native realpath expands an 8.3 short temp path, as the core does.
  const box = fs.realpathSync.native(tmpdir('harness-f131-'));
  const repo = path.join(box, 'repo');
  initRepo(repo, ids, value === undefined ? undefined : { worktree_dir: value, max_parallel: 1 });
  return { box, repo };
}

const cfgOf = (repo) => resolveConfig(JSON.parse(fs.readFileSync(path.join(repo, '.harness/config.json'), 'utf8')), { label: 'config' });
const PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const verify = async () => PASSING;
const verdict = (v) => async (a) => ({ feature: a.featureId, round: a.round, verdict: v, score: v === 'pass' ? 8 : 5, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });

function fakeBuild() {
  const calls = [];
  const fn = async (a) => {
    calls.push({ featureId: a.featureId, real: fs.realpathSync.native(a.cwd) });
    writeFiles(a.cwd, { [`${a.featureId}.txt`]: 'done\n' });
    return { ok: true, costUsd: 0 };
  };
  fn.calls = calls;
  return fn;
}

const runIn = (repo, deps = {}, opts = {}) => run.runFeatures({
  root: repo, config: cfgOf(repo), ...opts,
  deps: { verify, evaluate: verdict('pass'), cpus: 8, build: fakeBuild(), ...deps },
});
const setValue = (repo, value) => {
  const f = path.join(repo, '.harness/config.json');
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  c.run = { ...c.run, worktree_dir: value };
  fs.writeFileSync(f, JSON.stringify(c));
};
const worktrees = (repo) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => fs.realpathSync.native(l.slice(9)));
const refused = async (repo, value, re) => {
  setValue(repo, value);
  const branches = git(repo, 'branch', '--list');
  await assert.rejects(() => runIn(repo), (e) => {
    assert.equal(e.code, 'worktree_dir', e.message);
    assert.equal(e.exit, 2);
    assert.match(e.message, /run\.worktree_dir/);
    if (re) assert.match(e.message, re);
    return true;
  });
  assert.equal(git(repo, 'branch', '--list'), branches, 'no integration branch');
  assert.ok(!fs.existsSync(path.join(repo, '.harness/runs/current.json')), 'no current.json');
  assert.deepEqual(worktrees(repo), [repo]);
};

// ------------------------------------------------------------------ AC-1 .. AC-5
test('F131 AC-2: "../wt-x" is resolved against the project root; the default location stays unused', async () => {
  const { box, repo } = fixture('../wt-x');
  const build = fakeBuild();
  const r = await runIn(repo, { build });
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results[0]));
  assert.equal(build.calls[0].real, path.join(box, 'wt-x', 'F1'));
  assert.ok(!fs.existsSync(path.join(repo, '.harness/wt')));
});

test('F131 AC-2: the integration worktree is <dir>/_integration while the run is going', async () => {
  const { box, repo } = fixture('../wt-x');
  let listed;
  const build = async (a) => { listed = worktrees(repo); writeFiles(a.cwd, { 'F1.txt': 'x\n' }); return { ok: true, costUsd: 0 }; };
  await runIn(repo, { build });
  assert.ok(listed.includes(path.join(box, 'wt-x', '_integration')), listed.join('\n'));
});

test('F131 AC-3: the owner mark is written on first use, and an absolute value works the same', async () => {
  const { box, repo } = fixture('../wt-x');
  let mark;
  const build = async (a) => { mark = JSON.parse(fs.readFileSync(path.join(box, 'wt-x', '.harness-worktrees.json'), 'utf8')); writeFiles(a.cwd, { 'F1.txt': 'x\n' }); return { ok: true, costUsd: 0 }; };
  await runIn(repo, { build });
  assert.deepEqual(mark, { project: repo });

  const abs = path.join(box, 'abs-wt');
  setValue(repo, abs);
  git(repo, 'branch', '-D', 'harness/integration');
  writeFiles(repo, { '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] } });
  const b2 = fakeBuild();
  const r = await runIn(repo, { build: b2 });
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results[0]));
  assert.equal(b2.calls[0].real, path.join(abs, 'F1'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(abs, '.harness-worktrees.json'), 'utf8')), { project: repo });
});

test('F131 AC-4: the run records its worktree directory; --resume ignores a changed config value', async () => {
  const { box, repo } = fixture('../wt-a');
  const ac = new AbortController();
  const first = async (a) => { ac.abort(); writeFiles(a.cwd, { 'F1.txt': 'x\n' }); return { ok: true, costUsd: 0 }; };
  const r1 = await runIn(repo, { build: first }, { signal: ac.signal });
  assert.equal(r1.interrupted, true);
  const state = JSON.parse(fs.readFileSync(path.join(repo, '.harness/runs/current.json'), 'utf8'));
  assert.equal(state.worktreeDir, path.join(box, 'wt-a'));
  setValue(repo, '../wt-b');
  const build = fakeBuild();
  const r2 = await runIn(repo, { build }, { resume: true });
  assert.equal(r2.results[0].status, 'passed', JSON.stringify(r2.results[0]));
  assert.ok(build.calls.every((c) => c.real.startsWith(path.join(box, 'wt-a'))), JSON.stringify(build.calls));
  assert.ok(!fs.existsSync(path.join(box, 'wt-b')));
  assert.ok(!fs.existsSync(path.join(repo, '.harness/wt')));
});

test('F131 AC-5: a finished run removes merged and integration worktrees, keeps user files and a blocked worktree', async () => {
  const { box, repo } = fixture('../wt-x', { ids: ['F1', 'F2'] });
  const dir = path.join(box, 'wt-x');
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'k');
  fs.writeFileSync(path.join(dir, 'notes', 'n.md'), 'n');
  fs.writeFileSync(path.join(dir, '.harness-worktrees.json'), JSON.stringify({ project: repo }));
  const evaluate = async (a) => verdict(a.featureId === 'F2' ? 'needs-human' : 'pass')(a);
  const r = await runIn(repo, { evaluate });
  assert.deepEqual(r.results.map((x) => [x.feature, x.status]).sort(), [['F1', 'passed'], ['F2', 'blocked']]);
  assert.ok(!fs.existsSync(path.join(dir, 'F1')));
  assert.ok(!fs.existsSync(path.join(dir, '_integration')));
  assert.ok(fs.existsSync(path.join(dir, 'F2')));
  assert.ok(fs.existsSync(path.join(dir, 'keep.txt')) && fs.existsSync(path.join(dir, 'notes', 'n.md')));
  assert.deepEqual(worktrees(repo).sort(), [repo, path.join(dir, 'F2')].sort());
});

// ------------------------------------------------------------------ SC
test('F131 SC-1: a value inside the working tree other than .harness/wt is refused before anything is created', async () => {
  const { repo } = fixture('wt');
  for (const v of ['wt', '.harness/wt2', '.harness', '.', 'src/wt', '.git/wt', path.join(repo, 'wt'), '../repo/wt']) {
    await refused(repo, v, new RegExp(path.join(repo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('F131 SC-1: .harness/wt and ./.harness/wt are accepted', async () => {
  for (const v of ['.harness/wt', './.harness/wt']) {
    const { repo } = fixture(v);
    const r = await runIn(repo);
    assert.equal(r.results[0].status, 'passed');
    assert.ok(!fs.existsSync(path.join(repo, '.harness/wt', '.harness-worktrees.json')));
  }
});

test('F131 SC-2: a symlink outside the repository that points into it is refused', { skip: process.platform === 'win32' }, async () => {
  const { box, repo } = fixture('../link');
  fs.mkdirSync(path.join(repo, 'sub'));
  fs.symlinkSync(path.join(repo, 'sub'), path.join(box, 'link'), 'dir');
  for (const v of ['../link', '../link/wt']) {
    await refused(repo, v);
    assert.deepEqual(fs.readdirSync(path.join(repo, 'sub')), []);
  }
});

test('F131 SC-3: a non-empty directory without this project\'s owner mark is refused and left alone', async () => {
  const { box, repo } = fixture('../plain');
  const plain = path.join(box, 'plain');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'a.txt'), 'a');
  await refused(repo, '../plain');
  assert.deepEqual(fs.readdirSync(plain), ['a.txt']);

  const before = fs.readdirSync(box).sort();
  await refused(repo, '..');
  assert.deepEqual(fs.readdirSync(box).sort(), before);

  const other = path.join(box, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, '.harness-worktrees.json'), JSON.stringify({ project: path.join(box, 'elsewhere') }));
  await refused(repo, '../other');
  assert.deepEqual(fs.readdirSync(other), ['.harness-worktrees.json']);
});

test('F131 SC-4: a plain directory at <dir>/F1 is not removed by --fresh', async () => {
  const { box, repo } = fixture('../wt-x');
  const dir = path.join(box, 'wt-x');
  fs.mkdirSync(path.join(dir, 'F1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'F1', 'mine.txt'), 'm');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'k');
  fs.writeFileSync(path.join(dir, '.harness-worktrees.json'), JSON.stringify({ project: repo }));
  const r = await runIn(repo, {}, { ids: ['F1'], fresh: true });
  assert.equal(r.results[0].status, 'blocked');
  assert.equal(r.results[0].reason, 'worktree');
  assert.ok(JSON.stringify(r.results[0]).includes(path.join(dir, 'F1')), JSON.stringify(r.results[0]));
  assert.ok(fs.existsSync(path.join(dir, 'F1', 'mine.txt')));
  assert.ok(fs.existsSync(path.join(dir, 'keep.txt')));
});

// ------------------------------------------------------------------ ES
test('F131 ES-1: a value that is not a non-empty string is config_invalid and nothing is done', async () => {
  for (const v of ['', 5, [], {}]) {
    const { repo } = fixture(v);
    await assert.rejects(() => run.runFeatures({ root: repo, deps: { verify, evaluate: verdict('pass'), cpus: 8, build: fakeBuild() } }), (e) => {
      assert.equal(e.code, 'config_invalid');
      assert.equal(e.exit, 2);
      assert.match(e.message, /run\.worktree_dir/);
      return true;
    });
  }
});

test('F131 ES-1: harness run exits 2 with run.worktree_dir in the message', () => {
  for (const v of ['', 5, [], {}]) {
    const { repo } = fixture(v);
    const r = spawnSync(process.execPath, [path.join(REPO, 'bin/harness.mjs'), 'run'], { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /run\.worktree_dir/);
    assert.deepEqual(worktrees(repo), [repo]);
  }
});

test('F131 ES-2: a missing parent directory is refused and not created', async () => {
  const { box, repo } = fixture('../missing/wt');
  await refused(repo, '../missing/wt', /missing/);
  assert.ok(!fs.existsSync(path.join(box, 'missing')));
});

test('F131 ES-3: a current.json without worktreeDir resumes in <project>/.harness/wt', async () => {
  const { box, repo } = fixture(undefined);
  const ac = new AbortController();
  const first = async (a) => { ac.abort(); writeFiles(a.cwd, { 'F1.txt': 'x\n' }); return { ok: true, costUsd: 0 }; };
  await runIn(repo, { build: first }, { signal: ac.signal });
  const f = path.join(repo, '.harness/runs/current.json');
  const state = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(state.worktreeDir, fs.realpathSync.native(path.join(repo, '.harness', 'wt')));
  delete state.worktreeDir;
  state.config.run = { ...state.config.run, worktree_dir: '../wt-a' };
  fs.writeFileSync(f, JSON.stringify(state));
  const build = fakeBuild();
  const r = await runIn(repo, { build }, { resume: true });
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results[0]));
  assert.ok(build.calls.length > 0 && build.calls.every((c) => c.real.startsWith(path.join(repo, '.harness', 'wt'))), JSON.stringify(build.calls));
  assert.ok(!fs.existsSync(path.join(box, 'wt-a')));
});

// ------------------------------------------------------------------ AC-6
test('F131 AC-6: SPEC §4 and §8 describe run.worktree_dir', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs/SPEC.md'), 'utf8');
  const s4 = spec.slice(spec.indexOf('## 4.'), spec.indexOf('\n## 5.'));
  const s8 = spec.slice(spec.indexOf('## 8.'), spec.indexOf('\n## 9.'));
  assert.ok(s4.includes('run.worktree_dir') && s4.includes('.harness/wt'));
  for (const w of ['run.worktree_dir', '.harness/wt', '.harness-worktrees.json', 'worktreeDir', 'worktree_dir', '프로젝트 루트']) {
    assert.ok(s8.includes(w), `§8 names ${w}`);
  }
});

// A root whose real path differs from the path given (a symbolic link here; on Windows an 8.3
// short temp path does the same): the default worktree directory is the given path, unchanged.
test('F131 AC-1 regression: the default worktree directory is not rewritten to the real path', { skip: process.platform === 'win32' && 'symlink fixture' }, async () => {
  const { resolveWorktreeDir } = await import('../lib/run/wtdir.mjs');
  const box = tmpdir('harness-f131-');
  const realRoot = path.join(box, 'real');
  fs.mkdirSync(path.join(realRoot, '.harness'), { recursive: true });
  fs.symlinkSync(realRoot, path.join(box, 'via'), 'dir');
  const root = path.join(box, 'via');
  const defaultDir = path.join(root, '.harness', 'wt');
  for (const value of [undefined, '.harness/wt']) {
    const r = resolveWorktreeDir({ root, top: root, value, defaultDir });
    assert.deepEqual(r, { dir: defaultDir, external: false }, String(value));
  }
});
