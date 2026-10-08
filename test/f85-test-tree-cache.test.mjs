// F85: with verify.test_paths set, the base test-count cache is also looked up by `test_tree`, a
// digest of the base commit's test_paths files only — so a base that changed nothing but files
// outside them (a version bump, lib code) reuses the count of a commit with the same test files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpdir, readJson, writeJson } from './helpers.mjs';
import { git, gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { verify } from '../lib/verify.mjs';
import { runFeatures } from '../lib/run.mjs';

const CONTRACT = {
  id: 'F9', title: 'fixture', security_tier: 'standard', version: 1,
  acceptance_criteria: [{ id: 'AC-1', criterion: 'check exists', check: 'node check.mjs', new: true }],
  security_criteria: [], error_scenarios: [], out_of_scope: [],
};

// Prints the number of test/*.test.mjs files (a plain test_count command) and logs its cwd.
const COUNT_SCRIPT = [
  "import fs from 'node:fs';",
  "fs.appendFileSync(process.argv[2], JSON.stringify(process.cwd()) + '\\n');",
  "console.log(fs.readdirSync('test').filter((f) => f.endsWith('.test.mjs')).length);",
  '',
].join('\n');

// Two test files; package.json, lib/ and scripts/ are outside verify.test_paths (the sdlc
// profile's default, which every verify here uses unless it sets test_paths itself).
const FILES = {
  'package.json': { name: 'app', version: '1.0.0' },
  'scripts/count.mjs': COUNT_SCRIPT,
  'lib/a.mjs': 'export const a = 1;\n',
  'test/a.test.mjs': '// a tests\n',
  'test/b.test.mjs': '// b tests\n',
};

// A release: a version bump and a lib change, no test file touched.
const RELEASE = { 'package.json': { name: 'app', version: '1.1.0' }, 'lib/a.mjs': 'export const a = 2;\n' };

// Base branch `main` (B1) holds .harness state and FILES; HEAD is `feature` with an untracked
// check.mjs that makes AC-1 pass.
function fixture() {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', budget: { step_timeout_sec: 60 } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': CONTRACT,
    ...FILES,
  });
  writeFiles(dir, { 'check.mjs': 'process.exit(0);\n' });
  return dir;
}

const newLog = () => path.join(tmpdir('harness-f85-log-'), 'runs.log');
const countCmd = (log) => `node scripts/count.mjs "${log}"`;
const slash = (p) => p.split(path.sep).join('/');
const quoted = (p) => JSON.stringify(slash(p));
// The verify result cache (F87) is off: these tests verify one tree more than once to see what
// the test count cache does on the second run.
const cfg = (verifyCfg) => resolveConfig({ base_branch: 'main', verify: { commands: [], cache: 'off', ...verifyCfg }, budget: { step_timeout_sec: 60 } });
const run = (dir, verifyCfg, extra = {}) => verify({ root: dir, featureId: 'F9', base: 'main', config: cfg(verifyCfg), ...extra });

const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
// Runs of the count script outside the repo itself, i.e. on base.
function baseRuns(log, dir) {
  const cwds = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return cwds.filter((c) => real(c) !== real(dir)).length;
}

const cacheFile = (dir) => path.join(dir, '.harness', 'runs', 'test-count-cache.json');
const mergeBaseOf = (dir) => git(dir, 'merge-base', 'main', 'HEAD');
const entryOf = (dir, base) => readJson(cacheFile(dir)).entries.find((e) => e.base === base);
const treeWarnings = (r) => r.warnings.filter((w) => w.includes('test count cache: cannot compute the tree key'));
const phasesEvents = (dir) => {
  const d = path.join(dir, '.harness', 'events');
  let names = [];
  try { names = fs.readdirSync(d).sort(); } catch { return []; }
  return names.flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    .filter((e) => e.stage === 'verify' && e.type === 'phases');
};

// Commits `files` and the removal of `removed` on main (only those paths are staged: the cache
// and events stay untracked) and merges main into feature, so the merge-base becomes that commit (B2).
function advanceMain(dir, files, removed = []) {
  git(dir, 'checkout', '-q', 'main');
  writeFiles(dir, files);
  if (Object.keys(files).length) git(dir, 'add', '--', ...Object.keys(files));
  if (removed.length) git(dir, 'rm', '-q', '--', ...removed);
  git(dir, 'commit', '-q', '-m', 'main moves');
  git(dir, 'checkout', '-q', 'feature');
  git(dir, 'merge', '-q', '--no-edit', 'main');
}

// ---------- AC-1 ----------
test('F85 AC-1: a base that changed only package.json and lib/ from a cached base reuses its count by test_tree', async () => {
  assert.ok(cfg({}).verify.test_paths.length > 0, 'the default verify.test_paths is not empty');
  const dir = fixture();
  const log = newLog();
  const r1 = await run(dir, { test_count: countCmd(log) });
  assert.equal(r1.integrity.testCount.source.base, 'ran');
  assert.equal(r1.integrity.testCount.base, 2);
  assert.equal(baseRuns(log, dir), 1);
  const b1 = mergeBaseOf(dir);
  advanceMain(dir, RELEASE);
  assert.notEqual(mergeBaseOf(dir), b1, 'the merge-base moved to B2');
  const r2 = await run(dir, { test_count: countCmd(log) });
  assert.equal(baseRuns(log, dir), 1, 'no base count ran for B2');
  assert.equal(r2.integrity.testCount.source.base, 'cache');
  assert.equal(r2.integrity.testCount.base, 2);
  assert.equal(r2.integrity.testCount.status, 'ok');
  assert.equal(phasesEvents(dir).at(-1).data.test_count_source.base, 'cache');
});

test('F85 AC-1: a test_paths-shaped file under .harness/ is left out of test_tree', async () => {
  const dir = fixture();
  const log = newLog();
  await run(dir, { test_count: countCmd(log) });
  advanceMain(dir, { ...RELEASE, '.harness/notes/plan.test.json': { note: 1 } });
  const r = await run(dir, { test_count: countCmd(log) });
  assert.equal(baseRuns(log, dir), 1);
  assert.equal(r.integrity.testCount.source.base, 'cache');
});

test('F85 AC-1: test_paths are matched by the path inside a project below the repository top', async () => {
  const dir = gitRepo({
    'app/.harness/config.json': { profile: 'sdlc', base_branch: 'main', budget: { step_timeout_sec: 60 } },
    'app/.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    'app/.harness/contracts/F9.json': CONTRACT,
    ...Object.fromEntries(Object.entries(FILES).map(([k, v]) => [`app/${k}`, v])),
  });
  const root = path.join(dir, 'app');
  writeFiles(root, { 'check.mjs': 'process.exit(0);\n' });
  const log = newLog();
  // An absolute script: the base side runs the test_count command from the base worktree's top.
  const script = path.join(path.dirname(log), 'count.mjs');
  fs.writeFileSync(script, "import fs from 'node:fs';\nfs.appendFileSync(process.argv[2], JSON.stringify(process.cwd()) + '\\n');\nconsole.log(2);\n");
  const go = () => verify({ root, featureId: 'F9', base: 'main', config: cfg({ test_count: `node ${quoted(script)} ${quoted(log)}` }) });
  await go();
  advanceMain(dir, Object.fromEntries(Object.entries(RELEASE).map(([k, v]) => [`app/${k}`, v])));
  const hit = await go();
  assert.equal(hit.integrity.testCount.source.base, 'cache', 'a release inside the project hits by test_tree');
  assert.equal(baseRuns(log, root), 1);
  // app/test/a.test.mjs is test/a.test.mjs in the project: a change to it is a change to test_tree.
  advanceMain(dir, { 'app/test/a.test.mjs': '// a tests, changed\n' });
  const miss = await go();
  assert.equal(miss.integrity.testCount.source.base, 'ran');
  assert.equal(baseRuns(log, root), 2);
});

// ---------- AC-2 ----------
for (const [label, files, removed, count] of [
  ['adds a test file', { 'test/c.test.mjs': '// c tests\n' }, [], 3],
  ['modifies a test file', { 'test/a.test.mjs': '// a tests, changed\n' }, [], 2],
  ['deletes a test file', {}, ['test/b.test.mjs'], 1],
]) {
  test(`F85 AC-2: a base that also ${label} under test_paths runs the base count again`, async () => {
    const dir = fixture();
    const log = newLog();
    await run(dir, { test_count: countCmd(log) });
    advanceMain(dir, { ...RELEASE, ...files }, removed);
    const r = await run(dir, { test_count: countCmd(log) });
    assert.equal(baseRuns(log, dir), 2, 'the base count ran for B2');
    assert.equal(r.integrity.testCount.source.base, 'ran');
    assert.equal(r.integrity.testCount.base, count);
  });
}

// ---------- AC-3 ----------
test('F85 AC-3: base and post-merge head entries carry test_tree; the head count serves a release commit on top', async () => {
  const dir = fixture();
  const log = newLog();
  writeFiles(dir, { 'test/c.test.mjs': '// c tests\n' });
  git(dir, 'add', 'test/c.test.mjs', 'check.mjs');
  git(dir, 'commit', '-q', '-m', 'merged feature');
  const base = git(dir, 'rev-parse', 'main');
  const v = await run(dir, { test_count: countCmd(log) }, { base, step: 'post_merge_verify', vacuityBase: base });
  assert.equal(v.pass, true, JSON.stringify(v));
  const baseEntry = entryOf(dir, base);
  assert.equal(baseEntry?.count, 2);
  assert.equal(typeof baseEntry.test_tree, 'string', 'the base run stored test_tree');
  const headEntry = entryOf(dir, git(dir, 'rev-parse', 'HEAD'));
  assert.equal(headEntry?.count, 3);
  assert.equal(typeof headEntry.test_tree, 'string', 'the post-merge head count stored test_tree');
  assert.notEqual(headEntry.test_tree, baseEntry.test_tree);
  // The next feature's base: a release commit that only bumps the version of the merged commit.
  writeFiles(dir, { 'package.json': RELEASE['package.json'] });
  git(dir, 'add', 'package.json');
  git(dir, 'commit', '-q', '-m', 'release 1.1.0');
  git(dir, 'branch', '-f', 'main', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'next');
  const before = baseRuns(log, dir);
  const r = await run(dir, { test_count: countCmd(log) });
  assert.equal(baseRuns(log, dir), before, 'no base count ran for the release commit');
  assert.equal(r.integrity.testCount.source.base, 'cache');
  assert.equal(r.integrity.testCount.base, 3);
});

function runContract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id}.txt exists`, check: `node -e "process.exit(require('fs').existsSync('${id}.txt') ? 0 : 1)"`, new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-08T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

const PASS_EVAL = async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });

// Run 1 passes F1, whose build adds a test file (three). Then main gets a release commit — a
// version bump with F2's approved contract — and run 2 syncs it into integration before F2
// starts, so F2's base differs from F1's merged commit outside .harness/ but not in its tests.
test('F85 AC-3: in harness run, the feature after a release commit reads its base from the post-merge head count', async () => {
  const harnessState = (ids) => ({
    features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: 'standard', depends_on: [], status: 'approved' })),
  });
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\nruns/\nevents/\n',
    '.harness/features.json': harnessState(['F1']),
    '.harness/contracts/F1.json': runContract('F1'),
    ...FILES,
  }, { branch: null });
  const log = newLog();
  const results = [];
  const recording = async (a) => {
    const v = await verify(a);
    results.push({ feature: a.featureId, step: a.step, v });
    return v;
  };
  const build = async (a) => {
    writeFiles(a.cwd, { [`${a.featureId}.txt`]: 'built\n' });
    if (a.featureId === 'F1') writeFiles(a.cwd, { 'test/f1.test.mjs': '// F1 tests\n' });
    return { ok: true, costUsd: 0 };
  };
  const config = resolveConfig({
    base_branch: 'main', run: { max_parallel: 1 },
    verify: { commands: [], test_count: `node scripts/count.mjs ${quoted(log)}` }, budget: { step_timeout_sec: 60 },
  });
  const deps = { build, evaluate: PASS_EVAL, verify: recording, cpus: 8 };
  const statuses = () => Object.fromEntries(readJson(path.join(dir, '.harness/features.json')).features.map((f) => [f.id, f.status]));
  const r1 = await runFeatures({ root: dir, config, deps });
  assert.deepEqual(statuses(), { F1: 'passed' }, JSON.stringify(r1.results));
  const post1 = results.find((x) => x.feature === 'F1' && x.step === 'post_merge_verify');
  assert.equal(post1.v.integrity.testCount.head, 3);

  const features = readJson(path.join(dir, '.harness/features.json'));
  features.features.push(...harnessState(['F2']).features);
  writeFiles(dir, { 'package.json': RELEASE['package.json'], '.harness/features.json': features, '.harness/contracts/F2.json': runContract('F2') });
  git(dir, 'add', '--', 'package.json', '.harness/features.json', '.harness/contracts/F2.json');
  git(dir, 'commit', '-q', '-m', 'release 1.1.0; F2 contract approved');

  const r2 = await runFeatures({ root: dir, config, deps });
  assert.deepEqual(statuses(), { F1: 'passed', F2: 'passed' }, JSON.stringify(r2.results));
  const f2 = results.find((x) => x.feature === 'F2' && x.step === 'verify');
  assert.equal(f2.v.integrity.testCount.source.base, 'cache', JSON.stringify(f2.v.integrity.testCount));
  assert.equal(f2.v.integrity.testCount.base, 3);
  // F2's base differs from F1's merged commit outside .harness/: it is found by test_tree only.
  const merged = readJson(cacheFile(dir)).entries.find((e) => e.count === 3 && typeof e.test_tree === 'string');
  assert.ok(merged, 'the merged commit has an entry with a test_tree');
  assert.notEqual(merged.base, f2.v.mergeBase);
  assert.ok(git(dir, 'diff', '--name-only', merged.base, f2.v.mergeBase).split('\n').includes('package.json'));
  // No base count ran in run 2: F2's verify and its post-merge verify (same base) read the cache.
  assert.deepEqual(results.filter((x) => x.feature === 'F2').map((x) => [x.step, x.v.integrity.testCount.source.base]),
    [['verify', 'cache'], ['post_merge_verify', 'cache']]);
});

// ---------- AC-4 ----------
test('F85 AC-4: the cache is looked up by commit first, then by tree, then by test_tree', async () => {
  const dir = fixture();
  const log = newLog();
  await run(dir, { test_count: countCmd(log) });
  const [fresh] = readJson(cacheFile(dir)).entries;
  assert.equal(typeof fresh.tree, 'string');
  assert.equal(typeof fresh.test_tree, 'string');
  // Each entry matches this base by one key only; the later keys come first in the file.
  const byTestTree = { ...fresh, base: 'a'.repeat(40), tree: 'b'.repeat(64), count: 7 };
  const byTree = { ...fresh, base: 'c'.repeat(40), test_tree: 'd'.repeat(64), count: 8 };
  const byCommit = { ...fresh, tree: 'e'.repeat(64), test_tree: 'f'.repeat(64), count: 9 };
  for (const [entries, count] of [[[byTestTree, byTree, byCommit], 9], [[byTestTree, byTree], 8], [[byTestTree], 7]]) {
    writeJson(cacheFile(dir), { entries });
    const r = await run(dir, { test_count: countCmd(log) });
    assert.equal(r.integrity.testCount.source.base, 'cache');
    assert.equal(r.integrity.testCount.base, count, `${entries.length} entries`);
  }
  assert.equal(baseRuns(log, dir), 1, 'only the first verify ran base');
});

test('F85 AC-4: with verify.test_paths empty no test_tree is looked up or stored', async () => {
  const dir = fixture();
  const log = newLog();
  await run(dir, { test_count: countCmd(log) });
  assert.equal(typeof readJson(cacheFile(dir)).entries[0].test_tree, 'string');
  advanceMain(dir, RELEASE);
  const r = await run(dir, { test_count: countCmd(log), test_paths: [] });
  assert.equal(r.integrity.testCount.source.base, 'ran', 'B1 has the same test files but is not looked up by them');
  assert.equal(baseRuns(log, dir), 2);
  const entry = entryOf(dir, mergeBaseOf(dir));
  assert.equal(entry.count, 2);
  assert.equal(typeof entry.tree, 'string');
  assert.equal('test_tree' in entry, false);
});

// ---------- AC-5 ----------
test('F85 AC-5: SPEC §6.2 describes the test_tree key, the lookup order and the test_paths caveat', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const start = spec.indexOf('### 6.2');
  const sec = spec.slice(start, spec.indexOf('### 6.3', start));
  for (const s of ['`test_tree`', '`verify.test_paths` 에 걸리는 파일', '커밋(`base`) → `tree` → `test_tree`',
    '`test_paths` 밖 파일', '실제와 다를 수 있다', '`verify.test_paths` 를 비우면']) {
    assert.ok(sec.includes(s), `SPEC §6.2 mentions ${s}`);
  }
});

// ---------- ES-1 ----------
const POSIX = process.platform !== 'win32'; // the fake git is a shebang script
const REAL_GIT = spawnSync(POSIX ? 'which' : 'where', ['git'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim();
const pathKey = () => Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

// A fake git, first on PATH, that fails `ls-tree` and hands every other call to the real git.
async function withFailingLsTree(fn) {
  const bin = fs.realpathSync(tmpdir('harness-f85-git-'));
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
case " $* " in *" ls-tree "*) echo "fatal: injected ls-tree failure" >&2; exit 128 ;; esac
exec "${REAL_GIT}" "$@"
`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const key = pathKey();
  const saved = process.env[key];
  process.env[key] = `${bin}${path.delimiter}${saved}`;
  try { return await fn(); } finally { process.env[key] = saved; }
}

test('F85 ES-1: when test_tree cannot be computed, one warning is left, the cache is read by commit and base runs', async () => {
  if (!POSIX) return; // the fake git is a shebang script
  const dir = fixture();
  const log = newLog();
  await run(dir, { test_count: countCmd(log) });
  advanceMain(dir, RELEASE);
  const r = await withFailingLsTree(() => run(dir, { test_count: countCmd(log) }));
  assert.equal(r.pass, true, JSON.stringify(r));
  const w = treeWarnings(r);
  assert.equal(w.length, 1, JSON.stringify(r.warnings));
  assert.match(w[0], /injected ls-tree failure/);
  assert.equal(r.integrity.testCount.source.base, 'ran');
  assert.equal(r.integrity.testCount.base, 2);
  assert.equal(baseRuns(log, dir), 2);
  const entry = entryOf(dir, mergeBaseOf(dir));
  assert.equal(entry.count, 2);
  assert.equal('test_tree' in entry, false);
  // Found by its commit on the next verify, as before this feature.
  const again = await withFailingLsTree(() => run(dir, { test_count: countCmd(log) }));
  assert.equal(again.integrity.testCount.source.base, 'cache');
  assert.equal(baseRuns(log, dir), 2);
});

test('F85 ES-1: a post-merge verify that cannot compute test_tree for the base lookup and the head store warns once', async () => {
  if (!POSIX) return; // the fake git is a shebang script
  const dir = fixture();
  const log = newLog();
  git(dir, 'add', 'check.mjs');
  git(dir, 'commit', '-q', '-m', 'merged feature');
  const base = git(dir, 'rev-parse', 'main');
  const r = await withFailingLsTree(() => run(dir, { test_count: countCmd(log) }, { base, step: 'post_merge_verify', vacuityBase: base }));
  assert.equal(r.pass, true, JSON.stringify(r));
  assert.equal(treeWarnings(r).length, 1, JSON.stringify(r.warnings));
  const head = entryOf(dir, git(dir, 'rev-parse', 'HEAD'));
  assert.equal(head?.count, 2, 'the head count is stored by commit');
  assert.equal('test_tree' in head, false);
});
