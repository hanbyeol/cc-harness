// F84: a base test-count cache entry stored before the tree key, hit by its commit, gets the
// commit's tree key filled in — so a later base that changed only .harness/ finds it by tree —
// and a tree key git cannot compute is warned about once per verify.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpdir, readJson, writeJson } from './helpers.mjs';
import { git, gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { verify } from '../lib/verify.mjs';

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

// Base branch `main` holds .harness state, the count script and five tests; HEAD is `feature`
// with an untracked check.mjs that makes AC-1 pass.
function fixture() {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', budget: { step_timeout_sec: 60 } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': CONTRACT,
    'scripts/count.mjs': COUNT_SCRIPT,
    'tests.txt': 'a\nb\nc\nd\ne\n',
    'lib/app.mjs': 'export const x = 1;\n',
  });
  writeFiles(dir, { 'check.mjs': 'process.exit(0);\n' });
  return dir;
}

const newLog = () => path.join(tmpdir('harness-f84-log-'), 'runs.log');
const countCmd = (log) => `node scripts/count.mjs "${log}"`;
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
// An entry as stored before the tree key existed: commit, command, rule and count only.
const oldEntry = (dir, log, count = 4) => ({ base: mergeBaseOf(dir), command: countCmd(log), rule: 'stdout-integer', count });
// A modification time well in the past, so any rewrite of the file shows in its mtime.
const PAST = new Date('2020-01-01T00:00:00Z');
const snapshot = (file) => ({ text: fs.readFileSync(file, 'utf8'), mtimeMs: fs.statSync(file).mtimeMs });
const treeWarnings = (r) => r.warnings.filter((w) => w.includes('test count cache: cannot compute the tree key'));

// Commits `files` on main (only those paths are staged: the cache stays untracked) and merges
// main into feature, so the merge-base becomes that commit.
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
test('F84 AC-1: an old entry hit by its commit gets the tree key, so a base that changed only .harness/ reads it from the cache', async () => {
  const dir = fixture();
  const log = newLog();
  writeJson(cacheFile(dir), { entries: [oldEntry(dir, log)] });
  const r1 = await run(dir, { test_count: countCmd(log) });
  assert.equal(r1.integrity.testCount.source.base, 'cache');
  assert.equal(r1.integrity.testCount.base, 4);
  assert.equal(typeof readJson(cacheFile(dir)).entries[0].tree, 'string', 'the entry has a tree now');
  advanceMain(dir, HARNESS_ONLY);
  const r2 = await run(dir, { test_count: countCmd(log) });
  assert.equal(baseRuns(log, dir), 0, 'no base count ran');
  assert.equal(r2.integrity.testCount.source.base, 'cache');
  assert.equal(r2.integrity.testCount.base, 4);
  assert.equal(r2.pass, true, JSON.stringify(r2));
});

// ---------- AC-2 ----------
test('F84 AC-2: the filled entry keeps its count, command, rule and base and gets the tree a fresh count stores', async () => {
  const dir = fixture();
  const log = newLog();
  // The tree key the cache stores for this commit when its count is run.
  await run(dir, { test_count: countCmd(log) });
  const fresh = readJson(cacheFile(dir)).entries[0];
  assert.equal(typeof fresh.tree, 'string');
  const before = oldEntry(dir, log);
  writeJson(cacheFile(dir), { entries: [before] });
  await run(dir, { test_count: countCmd(log) });
  assert.equal(baseRuns(log, dir), 1, 'only the first verify ran base');
  const entries = readJson(cacheFile(dir)).entries;
  assert.equal(entries.length, 1);
  const { tree, ...rest } = entries[0];
  assert.equal(tree, fresh.tree);
  assert.deepEqual(rest, before);
});

test('F84 AC-2: an entry that already has a tree is not rewritten when its commit is hit', async () => {
  const dir = fixture();
  const log = newLog();
  await run(dir, { test_count: countCmd(log) });
  assert.equal(typeof readJson(cacheFile(dir)).entries[0].tree, 'string');
  fs.utimesSync(cacheFile(dir), PAST, PAST);
  const before = snapshot(cacheFile(dir));
  const r = await run(dir, { test_count: countCmd(log) });
  assert.equal(r.integrity.testCount.source.base, 'cache');
  assert.deepEqual(snapshot(cacheFile(dir)), before);
});

// ---------- AC-3 / ES-1: a git that cannot list a tree ----------
const POSIX = process.platform !== 'win32'; // the fake git is a shebang script
const REAL_GIT = spawnSync(POSIX ? 'which' : 'where', ['git'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim();
const pathKey = () => Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

// A fake git, first on PATH, that fails `ls-tree` and hands every other call to the real git.
async function withFailingLsTree(fn) {
  const bin = fs.realpathSync(tmpdir('harness-f84-git-'));
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

// The feature committed on top of main, verified as `harness run`'s post-merge verify.
function postMergeFixture() {
  const dir = fixture();
  git(dir, 'add', 'check.mjs');
  git(dir, 'commit', '-q', '-m', 'merged feature');
  return { dir, base: git(dir, 'rev-parse', 'main') };
}
const postMerge = (dir, base, log) => run(dir, { test_count: countCmd(log) }, { base, step: 'post_merge_verify', vacuityBase: base });

test('F84 AC-3: a post-merge verify that fails the tree key for the base lookup and the head store warns once', async () => {
  if (!POSIX) return; // the fake git is a shebang script
  const { dir, base } = postMergeFixture();
  const log = newLog();
  const r = await withFailingLsTree(() => postMerge(dir, base, log));
  assert.equal(r.pass, true, JSON.stringify(r));
  assert.equal(r.integrity.testCount.source.base, 'ran', 'the base lookup needed the tree key');
  const head = git(dir, 'rev-parse', 'HEAD');
  assert.ok(readJson(cacheFile(dir)).entries.some((e) => e.base === head), 'the head store ran');
  const w = treeWarnings(r);
  assert.equal(w.length, 1, JSON.stringify(r.warnings));
  assert.match(w[0], /injected ls-tree failure/);
});

test('F84 AC-3: a post-merge verify that fails the tree key for an old entry and the head store warns once', async () => {
  if (!POSIX) return; // the fake git is a shebang script
  const { dir, base } = postMergeFixture();
  const log = newLog();
  writeJson(cacheFile(dir), { entries: [{ ...oldEntry(dir, log), base, count: 5 }] });
  const r = await withFailingLsTree(() => postMerge(dir, base, log));
  assert.equal(r.pass, true, JSON.stringify(r));
  assert.equal(r.integrity.testCount.source.base, 'cache');
  assert.equal(treeWarnings(r).length, 1, JSON.stringify(r.warnings));
});

// ---------- AC-4 ----------
test('F84 AC-4: SPEC §6.2 describes filling the tree of old entries and one tree key warning per verify', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const start = spec.indexOf('### 6.2');
  const sec = spec.slice(start, spec.indexOf('### 6.3', start));
  for (const s of ['`tree` 를 채워', '같은 항목', '이미 `tree` 가 있는 항목', 'verify 당 한 번']) {
    assert.ok(sec.includes(s), `SPEC §6.2 mentions ${s}`);
  }
});

// ---------- ES-1 ----------
test('F84 ES-1: when the tree key of an old entry cannot be computed, the entry is left as is and its count used', async () => {
  if (!POSIX) return; // the fake git is a shebang script
  const dir = fixture();
  const log = newLog();
  writeJson(cacheFile(dir), { entries: [oldEntry(dir, log)] });
  fs.utimesSync(cacheFile(dir), PAST, PAST);
  const before = snapshot(cacheFile(dir));
  const r = await withFailingLsTree(() => run(dir, { test_count: countCmd(log) }));
  assert.equal(r.pass, true, JSON.stringify(r));
  assert.equal(r.integrity.testCount.source.base, 'cache');
  assert.equal(r.integrity.testCount.base, 4);
  assert.equal(baseRuns(log, dir), 0);
  assert.deepEqual(snapshot(cacheFile(dir)), before);
  assert.equal(treeWarnings(r).length, 1, JSON.stringify(r.warnings));
});

// ---------- ES-2 ----------
test('F84 ES-2: a cache that cannot be written leaves a warning and the verify goes on with the hit count', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.diagnostic('directory permissions do not apply here'); return; }
  const dir = fixture();
  const log = newLog();
  writeJson(cacheFile(dir), { entries: [oldEntry(dir, log)] });
  const runs = path.dirname(cacheFile(dir));
  fs.chmodSync(runs, 0o555);
  try {
    const r = await run(dir, { test_count: countCmd(log) });
    assert.equal(r.pass, true, JSON.stringify(r));
    assert.ok(r.warnings.some((w) => w.startsWith('cannot write test count cache')), JSON.stringify(r.warnings));
    assert.equal(r.integrity.testCount.source.base, 'cache');
    assert.equal(r.integrity.testCount.base, 4);
    assert.equal(baseRuns(log, dir), 0);
    assert.equal('tree' in readJson(cacheFile(dir)).entries[0], false);
  } finally {
    fs.chmodSync(runs, 0o755);
  }
});
