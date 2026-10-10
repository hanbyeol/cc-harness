// F83: the base test-count cache also matches by the base commit's tree outside .harness/, so a
// base that only changed .harness/ (a contract approval, a status record) reuses the count, and a
// passed post-merge verify of `harness run` caches its head count under the merged commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, fakeExecutableLink, tmpdir, readJson, writeJson } from './helpers.mjs';
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

// Prints the number of lines of tests.txt (a plain test_count command) and logs its cwd.
const COUNT_SCRIPT = [
  "import fs from 'node:fs';",
  "fs.appendFileSync(process.argv[2], JSON.stringify(process.cwd()) + '\\n');",
  "console.log(fs.readFileSync('tests.txt', 'utf8').split('\\n').filter(Boolean).length);",
  '',
].join('\n');

// Prints a TAP summary with the number of lines of tests.txt, or no count with 'none'.
const TESTS_SCRIPT = [
  "import fs from 'node:fs';",
  "const n = fs.readFileSync('tests.txt', 'utf8').split('\\n').filter(Boolean).length;",
  "console.log(process.argv[2] === 'none' ? 'all good' : `TAP version 13\\nok 1 - x\\n# tests ${n}`);",
  '',
].join('\n');

const FILES = {
  'scripts/count.mjs': COUNT_SCRIPT,
  'scripts/tests.mjs': TESTS_SCRIPT,
  'tests.txt': 'a\nb\nc\nd\ne\n',
  'lib/app.mjs': 'export const x = 1;\n',
  'test/app.test.mjs': '// app tests\n',
};

// Base branch `main` (B1) holds .harness state, the scripts and five tests; HEAD is `feature`
// with an untracked check.mjs that makes AC-1 pass.
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

const newLog = () => path.join(tmpdir('harness-f83-log-'), 'runs.log');
const countCmd = (log) => `node scripts/count.mjs "${log}"`;
const cfg = (verifyCfg) => resolveConfig({ base_branch: 'main', verify: { commands: [], ...verifyCfg }, budget: { step_timeout_sec: 60 } });
const run = (dir, verifyCfg, extra = {}) => verify({ root: dir, featureId: 'F9', base: 'main', config: cfg(verifyCfg), ...extra });

const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
// Runs of the count script outside the repo itself, i.e. on base.
function baseRuns(log, dir) {
  const cwds = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return cwds.filter((c) => real(c) !== real(dir)).length;
}

const cacheFile = (dir) => path.join(dir, '.harness', 'runs', 'test-count-cache.json');
const mergeBaseOf = (dir) => git(dir, 'merge-base', 'main', 'HEAD');
const phasesEvents = (dir) => {
  const d = path.join(dir, '.harness', 'events');
  let names = [];
  try { names = fs.readdirSync(d).sort(); } catch { return []; }
  return names.flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    .filter((e) => e.stage === 'verify' && e.type === 'phases');
};

// Commits `files` on main (only those paths are staged: the cache and events stay untracked)
// and merges main into feature, so the merge-base becomes that commit (B2).
function advanceMain(dir, files) {
  git(dir, 'checkout', '-q', 'main');
  writeFiles(dir, files);
  git(dir, 'add', '--', ...Object.keys(files));
  git(dir, 'commit', '-q', '-m', 'main moves');
  git(dir, 'checkout', '-q', 'feature');
  git(dir, 'merge', '-q', '--no-edit', 'main');
}
const HARNESS_ONLY = { '.harness/contracts/F10.json': { id: 'F10', approval: { hash: 'x' } } };

// ---------- AC-1 ----------
test('F83 AC-1: a base that changed only .harness/ from a cached base reuses its count without running base', async () => {
  const dir = fixture();
  const log = newLog();
  const r1 = await run(dir, { test_count: countCmd(log) });
  assert.equal(r1.integrity.testCount.source.base, 'ran');
  assert.equal(baseRuns(log, dir), 1);
  const b1 = mergeBaseOf(dir);
  advanceMain(dir, HARNESS_ONLY);
  assert.notEqual(mergeBaseOf(dir), b1, 'the merge-base moved to B2');
  const r2 = await run(dir, { test_count: countCmd(log) });
  assert.equal(baseRuns(log, dir), 1, 'no base count ran for B2');
  assert.equal(r2.integrity.testCount.source.base, 'cache');
  assert.equal(r2.integrity.testCount.base, 5);
  assert.equal(r2.integrity.testCount.status, 'ok');
  assert.equal(phasesEvents(dir).at(-1).data.test_count_source.base, 'cache');
});

test('F83 AC-1: a .harness/ change in a project below the repository top is left out of the tree key too', async () => {
  const dir = gitRepo({
    'app/.harness/config.json': { profile: 'sdlc', base_branch: 'main', budget: { step_timeout_sec: 60 } },
    'app/.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    'app/.harness/contracts/F9.json': CONTRACT,
    ...Object.fromEntries(Object.entries(FILES).map(([k, v]) => [`app/${k}`, v])),
  });
  const root = path.join(dir, 'app');
  writeFiles(root, { 'check.mjs': 'process.exit(0);\n' });
  const log = newLog();
  // An absolute script that prints a constant: the base side runs it from the base worktree's top.
  const script = path.join(path.dirname(log), 'count.mjs');
  fs.writeFileSync(script, "import fs from 'node:fs';\nfs.appendFileSync(process.argv[2], JSON.stringify(process.cwd()) + '\\n');\nconsole.log(5);\n");
  const go = () => verify({ root, featureId: 'F9', base: 'main', config: cfg({ test_count: `node ${quoted(script)} ${quoted(log)}` }) });
  await go();
  advanceMain(dir, { 'app/.harness/contracts/F10.json': { id: 'F10' } });
  const r = await go();
  assert.equal(r.integrity.testCount.source.base, 'cache');
  assert.equal(baseRuns(log, root), 1);
});

// ---------- AC-2 ----------
// With verify.test_paths set, a base that changed no test file is found by its test files
// (F85, test_tree); the lib case empties test_paths so the tree key alone decides, as here
// the count comes from tests.txt, a file outside test_paths.
for (const [label, files, extra] of [
  ['a test file', { 'test/app.test.mjs': '// app tests, changed\n' }, {}],
  ['a lib file', { 'lib/app.mjs': 'export const x = 2;\n' }, { test_paths: [] }],
]) {
  test(`F83 AC-2: a base that also changed ${label} outside .harness/ runs the base count again`, async () => {
    const dir = fixture();
    const log = newLog();
    await run(dir, { test_count: countCmd(log), ...extra });
    advanceMain(dir, { ...HARNESS_ONLY, ...files });
    const r = await run(dir, { test_count: countCmd(log), ...extra });
    assert.equal(baseRuns(log, dir), 2, 'the base count ran for B2');
    assert.equal(r.integrity.testCount.source.base, 'ran');
    assert.equal(r.integrity.testCount.base, 5);
  });
}

// ---------- AC-3 ----------
const slash = (p) => p.split(path.sep).join('/');
const quoted = (p) => JSON.stringify(slash(p));

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

// Run 1 passes F1, whose build adds a test (six). Then main gets only .harness/ commits — F1's
// status and F2's approved contract — and run 2 syncs them into integration before F2 starts,
// so F2's base is F1's merged commit plus a .harness/-only change.
test('F83 AC-3: a passed post-merge verify caches its head count, and the next feature verify reads its base from it', async () => {
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
    if (a.featureId === 'F1') fs.appendFileSync(path.join(a.cwd, 'tests.txt'), 'f\n');
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
  assert.equal(post1.v.pass, true);
  assert.equal(post1.v.integrity.testCount.head, 6);

  const features = readJson(path.join(dir, '.harness/features.json'));
  features.features.push(...harnessState(['F2']).features);
  writeFiles(dir, { '.harness/features.json': features, '.harness/contracts/F2.json': runContract('F2') });
  git(dir, 'add', '--', '.harness/features.json', '.harness/contracts/F2.json');
  git(dir, 'commit', '-q', '-m', 'F1 passed; F2 contract approved');

  const r2 = await runFeatures({ root: dir, config, deps });
  assert.deepEqual(statuses(), { F1: 'passed', F2: 'passed' }, JSON.stringify(r2.results));
  const f2 = results.find((x) => x.feature === 'F2' && x.step === 'verify');
  assert.equal(f2.v.integrity.testCount.source.base, 'cache', JSON.stringify(f2.v.integrity.testCount));
  assert.equal(f2.v.integrity.testCount.base, 6);
  assert.notEqual(f2.v.mergeBase, post1.v.mergeBase);
  // F2's base is a commit on top of F1's merged one, found by its tree and not by its commit.
  const merged = readJson(cacheFile(dir)).entries.find((e) => e.count === 6 && e.tree);
  assert.ok(merged, 'the merged commit has an entry with a tree');
  assert.notEqual(merged.base, f2.v.mergeBase);
  assert.equal(git(dir, 'merge-base', '--is-ancestor', merged.base, f2.v.mergeBase), '');
  // No base count ran in run 2: F2's verify and its post-merge verify (same base) read the cache.
  assert.deepEqual(results.filter((x) => x.feature === 'F2').map((x) => [x.step, x.v.integrity.testCount.source.base]),
    [['verify', 'cache'], ['post_merge_verify', 'cache']]);
});

test('F83 AC-3: a passed post_merge_verify stores the head count under the merged commit and its tree', async () => {
  const dir = fixture();
  const log = newLog();
  fs.appendFileSync(path.join(dir, 'tests.txt'), 'f\n');
  git(dir, 'add', 'tests.txt', 'check.mjs');
  git(dir, 'commit', '-q', '-m', 'merged feature');
  const base = git(dir, 'rev-parse', 'main');
  const v = await run(dir, { test_count: countCmd(log) }, { base, step: 'post_merge_verify', vacuityBase: base });
  assert.equal(v.pass, true, JSON.stringify(v));
  const head = git(dir, 'rev-parse', 'HEAD');
  const entry = readJson(cacheFile(dir)).entries.find((e) => e.base === head);
  assert.equal(entry?.count, 6);
  assert.equal(typeof entry.tree, 'string');
  // The next feature's base: the merged commit plus a .harness/ record.
  writeFiles(dir, HARNESS_ONLY);
  git(dir, 'add', '.harness/contracts/F10.json');
  git(dir, 'commit', '-q', '-m', 'harness: F9 passed');
  git(dir, 'branch', '-f', 'main', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'next');
  writeFiles(dir, { 'check.mjs': 'process.exit(0);\n' });
  const before = baseRuns(log, dir);
  const r = await run(dir, { test_count: countCmd(log) });
  assert.equal(r.integrity.testCount.source.base, 'cache');
  assert.equal(r.integrity.testCount.base, 6);
  assert.equal(baseRuns(log, dir), before);
});

// ---------- AC-4 ----------
test('F83 AC-4: an entry stored by commit only (before the tree key) still matches the same base commit', async () => {
  const dir = fixture();
  const log = newLog();
  writeJson(cacheFile(dir), { entries: [{ base: mergeBaseOf(dir), command: countCmd(log), rule: 'stdout-integer', count: 4 }] });
  const r = await run(dir, { test_count: countCmd(log) });
  assert.equal(baseRuns(log, dir), 0);
  assert.equal(r.integrity.testCount.source.base, 'cache');
  assert.equal(r.integrity.testCount.base, 4);
});

// ---------- AC-5 ----------
test('F83 AC-5: another test_count command does not match the same tree', async () => {
  const dir = fixture();
  const log = newLog();
  await run(dir, { test_count: countCmd(log) });
  advanceMain(dir, HARNESS_ONLY);
  const r = await run(dir, { test_count: `${countCmd(log)} other` });
  assert.equal(baseRuns(log, dir), 2);
  assert.equal(r.integrity.testCount.source.base, 'ran');
});

test('F83 AC-5: the same command under another counting rule does not match the same tree', async () => {
  const dir = fixture();
  const log = newLog();
  await run(dir, { test_count: countCmd(log) });
  const [entry] = readJson(cacheFile(dir)).entries;
  assert.equal(typeof entry.tree, 'string');
  // Same tree and command, but stored for 'from:commands[0]' (summary) with another count.
  writeJson(cacheFile(dir), { entries: [{ ...entry, base: 'f'.repeat(40), rule: 'summary', count: 1 }] });
  advanceMain(dir, HARNESS_ONLY);
  const r = await run(dir, { test_count: countCmd(log) });
  assert.equal(baseRuns(log, dir), 2);
  assert.equal(r.integrity.testCount.source.base, 'ran');
  assert.equal(r.integrity.testCount.base, 5);
});

// ---------- AC-6 ----------
test('F83 AC-6: SPEC §6.2 describes the tree key, the post-merge head count and commit-only entries', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const start = spec.indexOf('### 6.2');
  const sec = spec.slice(start, spec.indexOf('### 6.3', start));
  for (const s of ['tree', '`.harness/` 밖', '병합 후 verify', 'head 수', '`tree` 가 없는', 'git ls-tree']) {
    assert.ok(sec.includes(s), `SPEC §6.2 mentions ${s}`);
  }
});

// ---------- ES-1 ----------
const POSIX = process.platform !== 'win32'; // the fake git is a shebang script
const REAL_GIT = spawnSync(POSIX ? 'which' : 'where', ['git'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim();
const pathKey = () => Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

// A fake git, first on PATH, that fails `ls-tree` and hands every other call to the real git.
// Each call puts a new directory on PATH, as the verify result cache keys on PATH (§6.4).
async function withFailingLsTree(fn) {
  const bin = fakeExecutableLink('git', `#!/bin/sh
case " $* " in *" ls-tree "*) echo "fatal: injected ls-tree failure" >&2; exit 128 ;; esac
exec "${REAL_GIT}" "$@"
`, 'harness-f83-git-');
  const key = pathKey();
  const saved = process.env[key];
  process.env[key] = `${bin}${path.delimiter}${saved}`;
  try { return await fn(); } finally { process.env[key] = saved; }
}

test('F83 ES-1: when git cannot list the tree, one warning is left, the cache is read by commit and base runs', async () => {
  if (!POSIX) return; // the fake git is a shebang script
  const dir = fixture();
  const log = newLog();
  await run(dir, { test_count: countCmd(log) });
  advanceMain(dir, HARNESS_ONLY);
  const r = await withFailingLsTree(() => run(dir, { test_count: countCmd(log) }));
  assert.equal(r.pass, true, JSON.stringify(r));
  const w = r.warnings.filter((x) => x.includes('tree key'));
  assert.equal(w.length, 1, JSON.stringify(r.warnings));
  assert.match(w[0], /injected ls-tree failure/);
  assert.equal(r.integrity.testCount.source.base, 'ran');
  assert.equal(baseRuns(log, dir), 2);
  // The new entry is written by commit only and is found by commit on the next verify.
  const entry = readJson(cacheFile(dir)).entries.find((e) => e.base === mergeBaseOf(dir));
  assert.equal(entry.count, 5);
  assert.equal('tree' in entry, false);
  const again = await withFailingLsTree(() => run(dir, { test_count: countCmd(log) }));
  assert.equal(again.integrity.testCount.source.base, 'cache');
  assert.equal(baseRuns(log, dir), 2);
});

// ---------- ES-2 ----------
test('F83 ES-2: a failed post_merge_verify caches nothing under the merged commit', async () => {
  const dir = fixture();
  const log = newLog();
  fs.writeFileSync(path.join(dir, 'check.mjs'), 'process.exit(1);\n');
  git(dir, 'add', 'check.mjs');
  git(dir, 'commit', '-q', '-m', 'merged feature');
  const base = git(dir, 'rev-parse', 'main');
  const v = await run(dir, { test_count: countCmd(log) }, { base, step: 'post_merge_verify', vacuityBase: base });
  assert.equal(v.pass, false);
  const head = git(dir, 'rev-parse', 'HEAD');
  assert.ok(!readJson(cacheFile(dir)).entries.some((e) => e.base === head));
});

test('F83 ES-2: a post_merge_verify whose head count cannot be read caches nothing under the merged commit', async () => {
  const dir = fixture();
  git(dir, 'add', 'check.mjs');
  git(dir, 'commit', '-q', '-m', 'merged feature');
  const base = git(dir, 'rev-parse', 'main');
  const v = await run(dir, { commands: ['node scripts/tests.mjs none'], test_count: 'from:commands[0]' }, { base, step: 'post_merge_verify', vacuityBase: base });
  assert.equal(v.integrity.testCount.status, 'error');
  const head = git(dir, 'rev-parse', 'HEAD');
  const entries = fs.existsSync(cacheFile(dir)) ? readJson(cacheFile(dir)).entries : [];
  assert.ok(!entries.some((e) => e.base === head));
});
