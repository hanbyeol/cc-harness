// F30: verify.test_count 'from:commands[i]' reads the head count from a verify command's
// output (no extra run), runs that command once on base, and base counts of every kind are
// cached per (base commit, command) in .harness/runs/test-count-cache.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpdir, harness, readJson, writeJson } from './helpers.mjs';
import { git, gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { verify } from '../lib/verify.mjs';
import { HarnessError } from '../lib/errors.mjs';
import { parseSummaryCount, fromIndex } from '../lib/testcount.mjs';
import { spawnSync } from 'node:child_process';

const CONTRACT = {
  id: 'F9', title: 'fixture', security_tier: 'standard', version: 1,
  acceptance_criteria: [{ id: 'AC-1', criterion: 'check exists', check: 'node check.mjs', new: true }],
  security_criteria: [], error_scenarios: [], out_of_scope: [],
};

// Prints a TAP-like summary with the number in count.txt (a `format` argument selects the
// spec form or no count at all) and appends its working directory to the log file.
const TESTS_SCRIPT = [
  "import fs from 'node:fs';",
  'const [log, format = "tap"] = process.argv.slice(2);',
  "fs.appendFileSync(log, JSON.stringify(process.cwd()) + '\\n');",
  "const n = fs.readFileSync('count.txt', 'utf8').trim();",
  "if (format === 'tap') console.log(`TAP version 13\\n# tests 99\\nok 1 - x\\n# tests ${n}\\n# pass ${n}`);",
  "if (format === 'spec') console.log(`\\u2714 x\\n\\u2139 tests ${n}\\n\\u2139 pass ${n}`);",
  "if (format === 'none') console.log('all good');",
  '',
].join('\n');

// Prints the number in count.txt as its last line (a plain test_count command) and logs its cwd.
const COUNT_SCRIPT = [
  "import fs from 'node:fs';",
  "fs.appendFileSync(process.argv[2], JSON.stringify(process.cwd()) + '\\n');",
  "console.log(fs.readFileSync('count.txt', 'utf8').trim());",
  '',
].join('\n');

// Base branch `main` holds .harness state, the scripts and count.txt = `baseCount`; HEAD is
// `feature` with an untracked check.mjs that makes AC-1 pass (and fail on base).
function fixture(baseCount = 5, files = {}, config = { verify: { commands: [] } }) {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', budget: { step_timeout_sec: 60 }, ...config },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': CONTRACT,
    'scripts/tests.mjs': TESTS_SCRIPT,
    'scripts/count.mjs': COUNT_SCRIPT,
    'count.txt': `${baseCount}\n`,
    ...files,
  });
  writeFiles(dir, { 'check.mjs': 'process.exit(0);\n' });
  return dir;
}

const newLog = () => path.join(tmpdir('harness-f30-log-'), 'runs.log');
const testsCmd = (log, format = 'tap') => `node scripts/tests.mjs "${log}" ${format}`;
const cfg = (verifyCfg) => resolveConfig({ base_branch: 'main', verify: { commands: [], ...verifyCfg }, budget: { step_timeout_sec: 60 } });
const run = (dir, verifyCfg) => verify({ root: dir, featureId: 'F9', base: 'main', config: cfg(verifyCfg) });

// The base worktree is removed after verify, so a directory that no longer exists is not the repo.
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
// Logged working directories: [head runs, base runs] (base = any directory but the repo).
function logged(log, dir) {
  const cwds = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const head = cwds.filter((c) => real(c) === real(dir));
  return { head: head.length, base: cwds.length - head.length };
}

const cacheFile = (dir) => path.join(dir, '.harness', 'runs', 'test-count-cache.json');
const mergeBaseOf = (dir) => git(dir, 'merge-base', 'main', 'HEAD');

// ---------- AC-1 ----------
test('F30 AC-1: from:commands[0] reads head from the verify command output without running it again', async () => {
  const dir = fixture(5);
  const log = newLog();
  const r = await run(dir, { commands: [testsCmd(log)], test_count: 'from:commands[0]' });
  assert.equal(r.integrity.testCount.head, 5);
  assert.equal(r.integrity.testCount.status, 'ok');
  assert.deepEqual(logged(log, dir), { head: 1, base: 1 }, 'the command runs once on head (as a verify command) and once on base');
  assert.equal(r.pass, true, JSON.stringify(r, null, 2));
});

test("F30 AC-1: the spec reporter's 'ℹ tests N' line is read the same way", async () => {
  const dir = fixture(4);
  const log = newLog();
  const r = await run(dir, { commands: [testsCmd(log, 'spec')], test_count: 'from:commands[0]' });
  assert.equal(r.integrity.testCount.head, 4);
  assert.equal(r.integrity.testCount.base, 4);
  assert.deepEqual(logged(log, dir), { head: 1, base: 1 });
});

test('F30 AC-1: from:commands[i] picks the i-th command; other commands run once each', async () => {
  const dir = fixture(6);
  const log = newLog();
  const other = newLog();
  const r = await run(dir, { commands: [`node scripts/count.mjs "${other}"`, testsCmd(log)], test_count: 'from:commands[1]' });
  assert.equal(r.integrity.testCount.head, 6);
  assert.deepEqual(logged(log, dir), { head: 1, base: 1 });
  assert.deepEqual(logged(other, dir), { head: 1, base: 0 });
});

test('F30 AC-1: the summary parser takes the last "# tests N" or "ℹ tests N" line', () => {
  assert.equal(parseSummaryCount('# tests 3\n# pass 3\n# tests 7\n'), 7);
  assert.equal(parseSummaryCount('ℹ tests 12\r\nℹ pass 12\r\n'), 12);
  assert.equal(parseSummaryCount('    # tests 9\nok\n'), null);
  assert.equal(parseSummaryCount('tests 4\n'), null);
  assert.equal(fromIndex('from:commands[0]'), 0);
  assert.equal(fromIndex('from:commands[12]'), 12);
  for (const bad of ['from:commands[01]', 'from:commands[-1]', 'from:commands[x]', 'from:commands', 'from:cmd[0]', ' from:commands[0]']) {
    assert.equal(fromIndex(bad), null, bad);
  }
});

// ---------- AC-2 ----------
const NODE_TESTS = {
  'test/a.test.mjs': "import test from 'node:test';\ntest('one', () => {});\ntest('two', () => {});\n",
  'test/b.test.mjs': "import test from 'node:test';\ntest('three', () => {});\n",
};

test('F30 AC-2: a feature deleting a node:test file makes from:commands[0] decrease (base counted from the same command on base)', async () => {
  const dir = fixture(5, NODE_TESTS);
  fs.rmSync(path.join(dir, 'test', 'b.test.mjs'));
  const r = await run(dir, { commands: ['node --test --test-reporter=tap'], test_count: 'from:commands[0]' });
  assert.equal(r.integrity.testCount.base, 3);
  assert.equal(r.integrity.testCount.head, 2);
  assert.equal(r.integrity.testCount.status, 'decreased');
  assert.equal(r.pass, false);
});

test('F30 AC-2: a fewer count in the command output than on base is decreased; more is ok', async () => {
  const dir = fixture(5);
  writeFiles(dir, { 'count.txt': '4\n' });
  const r = await run(dir, { commands: [testsCmd(newLog())], test_count: 'from:commands[0]' });
  assert.equal(r.integrity.testCount.status, 'decreased');
  assert.equal(r.pass, false);
  const up = fixture(5);
  writeFiles(up, { 'count.txt': '8\n' });
  const r2 = await run(up, { commands: [testsCmd(newLog())], test_count: 'from:commands[0]' });
  assert.equal(r2.integrity.testCount.status, 'ok');
  assert.equal(r2.integrity.testCount.base, 5);
  assert.equal(r2.integrity.testCount.head, 8);
});

// ---------- AC-3 ----------
test('F30 AC-3: the same (base commit, command) is not run on base again — the cached count is used', async () => {
  const dir = fixture(5);
  const log = newLog();
  const vc = { commands: [testsCmd(log)], test_count: 'from:commands[0]' };
  await run(dir, vc);
  const entries = readJson(cacheFile(dir)).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].base, mergeBaseOf(dir));
  assert.equal(entries[0].command, testsCmd(log));
  assert.equal(entries[0].count, 5);
  const r = await run(dir, vc);
  assert.deepEqual(logged(log, dir), { head: 2, base: 1 }, 'second verify: head again, base from cache');
  assert.equal(r.integrity.testCount.base, 5);
  assert.equal(r.integrity.testCount.status, 'ok');
});

test('F30 AC-3: a different base commit runs the command on base again', async () => {
  const dir = fixture(5);
  const log = newLog();
  const vc = { commands: [testsCmd(log)], test_count: 'from:commands[0]' };
  await run(dir, vc);
  const first = mergeBaseOf(dir);
  git(dir, 'checkout', '-q', 'main');
  writeFiles(dir, { 'count.txt': '7\n' });
  git(dir, 'commit', '-q', '-am', 'more tests on main');
  git(dir, 'checkout', '-q', 'feature');
  git(dir, 'merge', '-q', '--ff-only', 'main');
  assert.notEqual(mergeBaseOf(dir), first);
  const r = await run(dir, vc);
  assert.deepEqual(logged(log, dir), { head: 2, base: 2 });
  assert.equal(r.integrity.testCount.base, 7);
  assert.equal(readJson(cacheFile(dir)).entries.length, 2);
});

test('F30 AC-3: a different command string runs on base again', async () => {
  const dir = fixture(5);
  const log = newLog();
  await run(dir, { commands: [testsCmd(log)], test_count: 'from:commands[0]' });
  await run(dir, { commands: [`${testsCmd(log)} extra`], test_count: 'from:commands[0]' });
  assert.deepEqual(logged(log, dir), { head: 2, base: 2 });
});

// ---------- AC-4 ----------
test('F30 AC-4: a plain test_count command uses the cache for base on the next verify', async () => {
  const dir = fixture(5);
  const log = newLog();
  const vc = { test_count: `node scripts/count.mjs "${log}"` };
  const r1 = await run(dir, vc);
  assert.deepEqual(logged(log, dir), { head: 1, base: 1 });
  const r2 = await run(dir, vc);
  assert.deepEqual(logged(log, dir), { head: 2, base: 1 });
  assert.equal(r1.integrity.testCount.base, 5);
  assert.equal(r2.integrity.testCount.base, 5);
  assert.equal(r2.integrity.testCount.status, 'ok');
});

test('F30 AC-4: a preset test_count uses the cache for base on the next verify', async () => {
  const dir = fixture(5, NODE_TESTS);
  const r1 = await run(dir, { test_count: 'preset:node-test' });
  assert.equal(r1.integrity.testCount.base, 3);
  assert.equal(r1.integrity.testCount.source.base, 'ran');
  const entry = readJson(cacheFile(dir)).entries.find((e) => e.command === 'preset:node-test');
  assert.equal(entry?.count, 3);
  assert.equal(entry.base, mergeBaseOf(dir));
  const r2 = await run(dir, { test_count: 'preset:node-test' });
  assert.equal(r2.integrity.testCount.base, 3);
  assert.equal(r2.integrity.testCount.source.base, 'cache');
});

// ---------- AC-5 ----------
test('F30 AC-5: testCount records the source of head and base (parsed/ran/cache)', async () => {
  const dir = fixture(5);
  const vc = { commands: [testsCmd(newLog())], test_count: 'from:commands[0]' };
  const r1 = await run(dir, vc);
  assert.deepEqual(r1.integrity.testCount.source, { head: 'parsed', base: 'ran' });
  const r2 = await run(dir, vc);
  assert.deepEqual(r2.integrity.testCount.source, { head: 'parsed', base: 'cache' });
  const other = fixture(5);
  const r3 = await run(other, { test_count: `node scripts/count.mjs "${newLog()}"` });
  assert.deepEqual(r3.integrity.testCount.source, { head: 'ran', base: 'ran' });
});

test('F30 AC-5: harness verify prints the sources next to the counts', () => {
  const dir = fixture(5, {}, { verify: { commands: [testsCmd(newLog())], test_count: 'from:commands[0]' } });
  const first = harness(['verify', 'F9'], { cwd: dir });
  assert.match(first.stdout, /test count: ok \(base 5 \[ran\], head 5 \[parsed\]\)/, first.stdout + first.stderr);
  const second = harness(['verify', 'F9'], { cwd: dir });
  assert.match(second.stdout, /test count: ok \(base 5 \[cache\], head 5 \[parsed\]\)/, second.stdout + second.stderr);
  const json = JSON.parse(harness(['verify', 'F9', '--json'], { cwd: dir }).stdout);
  assert.deepEqual(json.integrity.testCount.source, { head: 'parsed', base: 'cache' });
});

// ---------- AC-6 ----------
test('F30 AC-6: SPEC §6.2 and README describe from:commands[i], the output format and the base cache', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const section = spec.slice(spec.indexOf('### 6.2'), spec.indexOf('### 6.3'));
  for (const s of ['from:commands[i]', '# tests N', 'ℹ tests N', 'test-count-cache.json', 'no test count in output', 'parsed', 'cache']) {
    assert.ok(section.includes(s), `SPEC §6.2 lacks ${s}`);
  }
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  for (const s of ['from:commands[i]', '# tests N', 'ℹ tests N', 'test-count-cache.json']) {
    assert.ok(readme.includes(s), `README lacks ${s}`);
  }
  assert.ok(readme.split('\n').length <= 200, 'README longer than 200 lines');
});

// ---------- SC-1 ----------
for (const [label, bad] of [['string', '999'], ['negative', -1], ['fraction', 2.5], ['null', null]]) {
  test(`F30 SC-1: a ${label} cached base count is not used — base runs and the decrease is judged on the real count`, async () => {
    const dir = fixture(5);
    writeFiles(dir, { 'count.txt': '4\n' });
    const log = newLog();
    const cmd = testsCmd(log);
    writeJson(cacheFile(dir), { entries: [{ base: mergeBaseOf(dir), command: cmd, rule: 'summary', count: bad }] });
    const r = await run(dir, { commands: [cmd], test_count: 'from:commands[0]' });
    assert.equal(r.integrity.testCount.base, 5);
    assert.equal(r.integrity.testCount.source.base, 'ran');
    assert.equal(r.integrity.testCount.status, 'decreased');
    assert.deepEqual(logged(log, dir), { head: 1, base: 1 });
    assert.deepEqual(readJson(cacheFile(dir)).entries.map((e) => e.count), [5], 'the bad entry is replaced by the real count');
  });
}

test('F30 SC-1: the cache is written only to .harness/runs/test-count-cache.json', async () => {
  const dir = fixture(5);
  const cwdBefore = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' }).stdout;
  await run(dir, { commands: [testsCmd(newLog())], test_count: 'from:commands[0]' });
  await run(dir, { test_count: 'preset:node-test' });
  const after = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' }).stdout;
  const added = after.split('\n').filter((l) => l && !cwdBefore.split('\n').includes(l));
  assert.deepEqual(added, ['?? .harness/runs/test-count-cache.json']);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.harness', 'runs')), ['test-count-cache.json']);
});

// ---------- ES-1 ----------
test('F30 ES-1: from:commands[i] past the end of verify.commands exits 2 (config_invalid) naming verify.test_count', () => {
  const dir = fixture(5);
  writeJson(path.join(dir, '.harness', 'config.json'), {
    profile: 'sdlc', base_branch: 'main', verify: { commands: ['node scripts/ok.mjs'], test_count: 'from:commands[1]' },
  });
  const r = harness(['verify', 'F9'], { cwd: dir });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /verify\.test_count/);
});

test('F30 ES-1: the range is checked against the commands after the profile merge, and malformed values are rejected', () => {
  const invalid = (user) => assert.throws(() => resolveConfig(user),
    (e) => e instanceof HarnessError && e.code === 'config_invalid' && e.message.includes('verify.test_count'), JSON.stringify(user));
  invalid({ verify: { commands: [], test_count: 'from:commands[0]' } });
  invalid({ verify: { test_count: 'from:commands[1]' } }); // sdlc supplies one command
  invalid({ verify: { test_count: 'from:commands[x]' } });
  invalid({ verify: { commands: ['a'], test_count: 'from:commands[01]' } });
  assert.equal(resolveConfig({ verify: { test_count: 'from:commands[0]' } }).verify.test_count, 'from:commands[0]');
  assert.equal(resolveConfig({ verify: { commands: ['a', 'b'], test_count: 'from:commands[1]' } }).verify.test_count, 'from:commands[1]');
});

// ---------- ES-2 ----------
test("F30 ES-2: output without a test count is an error naming 'no test count in output' and the command index", async () => {
  const dir = fixture(5);
  const r = await run(dir, { commands: ['node scripts/count.mjs "' + newLog() + '"', testsCmd(newLog(), 'none')], test_count: 'from:commands[1]' });
  assert.equal(r.integrity.testCount.status, 'error');
  assert.match(r.integrity.testCount.message, /no test count in output/);
  assert.match(r.integrity.testCount.message, /commands\[1\]/);
  assert.equal(r.pass, false);
  assert.equal(fs.existsSync(cacheFile(dir)), false, 'a failed base count is not cached');
});

// ---------- ES-3 ----------
test('F30 ES-3: an unreadable cache file is ignored with a warning naming it; base runs and verify does not fail for it', async () => {
  const dir = fixture(5);
  fs.mkdirSync(path.dirname(cacheFile(dir)), { recursive: true });
  fs.writeFileSync(cacheFile(dir), '{ not json');
  const log = newLog();
  const r = await run(dir, { commands: [testsCmd(log)], test_count: 'from:commands[0]' });
  assert.equal(r.pass, true, JSON.stringify(r, null, 2));
  assert.equal(r.integrity.testCount.status, 'ok');
  assert.equal(r.integrity.testCount.source.base, 'ran');
  assert.deepEqual(logged(log, dir), { head: 1, base: 1 });
  assert.ok(r.warnings.some((w) => w.includes(cacheFile(dir))), JSON.stringify(r.warnings));
  assert.equal(readJson(cacheFile(dir)).entries[0].count, 5, 'the file is rewritten with the fresh count');
});
