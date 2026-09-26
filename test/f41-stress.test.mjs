// F41: `node test/stress.mjs N` runs the whole suite N times at once (the load several
// features put on one machine); test/assert-count.mjs guards the tests fixed for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpdir } from './helpers.mjs';
import { gitRepo, writeFiles, commitAll } from './gitfixture.mjs';

const STRESS = path.join(REPO, 'test', 'stress.mjs');
const ASSERT_COUNT = path.join(REPO, 'test', 'assert-count.mjs');
const node = (args, opts = {}) => {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', ...opts, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '', stderr: r.stderr || '' };
};
const stress = (args) => node([STRESS, ...args]);

// A checkout-shaped directory holding only test files: `files` = { 'name.test.mjs': body }.
function suite(files) {
  const dir = fs.realpathSync(tmpdir('harness-f41-suite-'));
  writeFiles(dir, Object.fromEntries(Object.entries(files).map(([n, body]) => [`test/${n}`, body])));
  return dir;
}
const HEAD = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\n";
const PASSING = `${HEAD}test('fake passing test', () => { assert.equal(1, 1); });\n`;

// ---------- AC-1 ----------
test('F41 AC-1: all runs pass → exit 0 and a summary', () => {
  const dir = suite({ 'ok.test.mjs': PASSING });
  const r = stress(['3', '--root', dir]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /all 3 runs passed/);
});

test('F41 AC-1: a failing test → exit 1 with its name and the number of runs it failed in', () => {
  const dir = suite({
    'ok.test.mjs': PASSING,
    'bad.test.mjs': `${HEAD}test('fake failing test', () => { assert.equal(1, 2); });\n`,
  });
  const r = stress(['2', '--root', dir]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /2 of 2 runs failed/);
  assert.match(r.stdout, /FAILED fake failing test .*2\/2 runs/);
  assert.ok(!r.stdout.includes('fake passing test'), r.stdout);
});

test('F41 AC-1: a test that fails in only one of the runs is reported with 1/2', () => {
  // The first run to create the marker fails, the other one passes: exactly one failure.
  const marker = path.join(fs.realpathSync(tmpdir('harness-f41-marker-')), 'first');
  const dir = suite({
    'once.test.mjs': `${HEAD}test('fake failing once', () => {\n`
      + `  assert.doesNotThrow(() => fs.writeFileSync(${JSON.stringify(marker)}, '', { flag: 'wx' }));\n});\n`,
  });
  const r = stress(['2', '--root', dir]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /1 of 2 runs failed/);
  assert.match(r.stdout, /FAILED fake failing once .*1\/2 runs/);
});

test('F41 AC-1: a failed subtest is named, not its parent test or file', () => {
  const dir = suite({
    'sub.test.mjs': `${HEAD}test('fake parent', async (t) => {\n  await t.test('fake child', () => { assert.ok(false); });\n});\n`,
  });
  const r = stress(['1', '--root', dir]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /FAILED fake child /);
  assert.ok(!/FAILED fake parent/.test(r.stdout), r.stdout);
});

test('F41 AC-1: a test file that crashes fails the run and is named', () => {
  const dir = suite({ 'crash.test.mjs': 'throw new Error("boom");\n' });
  const r = stress(['1', '--root', dir]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /FAILED .*crash\.test\.mjs/);
});

// ---------- AC-2 ----------
test('F41 AC-2: stress.mjs targets this repository by default and runs the suite as a node test run', () => {
  // The real check (`node test/stress.mjs 3`) takes minutes and cannot run inside the suite.
  const src = fs.readFileSync(STRESS, 'utf8');
  assert.match(src, /node:child_process/);
  assert.ok(src.includes("'test/**/*.test.mjs'"), 'runs the same glob as `npm test`');
  assert.ok(src.includes("'--test'"));
});

// ---------- AC-3 ----------
const BASE_TEST = `${HEAD}test('F9 AC-1 one', () => {\n  assert.equal(1, 1);\n  assert.ok(true);\n});\ntest('F9 AC-2 two', () => { assert.equal(2, 2); });\n`;

function countRepo(edit) {
  const dir = gitRepo({ 'test/a.test.mjs': BASE_TEST, 'test/b.test.mjs': PASSING });
  edit?.(dir);
  return dir;
}
const assertCount = (dir) => node([ASSERT_COUNT, '--base', 'main', '--root', dir], { cwd: dir });

test('F41 AC-3: no change → exit 0', () => {
  const r = assertCount(countRepo());
  assert.equal(r.code, 0, r.out);
});

test('F41 AC-3: more asserts, more tests and a new file are fine → exit 0', () => {
  const dir = countRepo((d) => {
    writeFiles(d, {
      'test/a.test.mjs': `${BASE_TEST}test('F9 AC-3 three', () => { assert.ok(1); assert.ok(2); });\n`,
      'test/c.test.mjs': PASSING,
    });
    commitAll(d, 'more');
  });
  const r = assertCount(dir);
  assert.equal(r.code, 0, r.out);
});

test('F41 AC-3: a removed assert (committed) → exit 1 naming the file and both counts', () => {
  const dir = countRepo((d) => {
    writeFiles(d, { 'test/a.test.mjs': BASE_TEST.replace('  assert.ok(true);\n', '') });
    commitAll(d, 'weaken');
  });
  const r = assertCount(dir);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stderr, /test\/a\.test\.mjs: asserts 3 -> 2/);
});

test('F41 AC-3: a removed assert (uncommitted working tree) → exit 1', () => {
  const dir = countRepo((d) => writeFiles(d, { 'test/a.test.mjs': BASE_TEST.replace('  assert.ok(true);\n', '') }));
  const r = assertCount(dir);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stderr, /asserts 3 -> 2/);
});

test('F41 AC-3: a renamed test → exit 1 naming the old name', () => {
  const dir = countRepo((d) => {
    writeFiles(d, { 'test/a.test.mjs': BASE_TEST.replace("'F9 AC-2 two'", "'F9 AC-2 second'") });
    commitAll(d, 'rename');
  });
  const r = assertCount(dir);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stderr, /test name removed or renamed: "F9 AC-2 two"/);
});

test('F41 AC-3: a deleted test file → exit 1', () => {
  const dir = countRepo((d) => {
    fs.rmSync(path.join(d, 'test', 'b.test.mjs'));
    commitAll(d, 'delete');
  });
  const r = assertCount(dir);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stderr, /test\/b\.test\.mjs: deleted/);
});

test('F41 AC-3: an unknown base ref → exit 2', () => {
  const dir = countRepo();
  const r = node([ASSERT_COUNT, '--base', 'no-such-branch', '--root', dir], { cwd: dir });
  assert.equal(r.code, 2, r.out);
});

test('F41 AC-3: the tests of this repository are not weaker than at the base', () => {
  const r = node([ASSERT_COUNT], { cwd: REPO });
  // 2: the base branch is not available here (a CI checkout without it) — nothing to compare.
  if (r.code === 2 && /cannot resolve a merge base/.test(r.stderr)) return;
  assert.equal(r.code, 0, r.out);
});

// ---------- AC-4 ----------
test('F41 AC-4: CLAUDE.md explains test/stress.mjs usage and when to run it', () => {
  const doc = fs.readFileSync(path.join(REPO, 'CLAUDE.md'), 'utf8');
  const start = doc.indexOf('## Running the core from this checkout');
  assert.ok(start >= 0, 'development commands section exists');
  const end = doc.indexOf('\n## ', start);
  const section = doc.slice(start, end === -1 ? undefined : end);
  assert.ok(section.includes('node test/stress.mjs 3'), 'usage with an example');
  assert.match(section, /concurrent/i, 'says the suites run concurrently');
  assert.match(section, /before (you )?(finish|hand|commit|merge)|when you (add|change|write)|whenever/i, 'says when to run it');
  assert.match(section, /timing|wall-clock|load/i, 'ties it to timing under load');
  assert.ok(section.includes('assert-count'), 'mentions the guard against weakened tests');
});

// ---------- ES-1 ----------
for (const [label, args] of [['no argument', []], ['0', ['0']], ['a negative number', ['-3']], ['a word', ['abc']], ['a decimal', ['2.5']], ['two arguments', ['2', '3']], ['an empty string', ['']]]) {
  test(`F41 ES-1: ${label} → usage and exit 2`, () => {
    const r = stress(args);
    assert.equal(r.code, 2, r.out);
    assert.match(r.stderr, /usage: node test\/stress\.mjs/);
    assert.ok(!/concurrent test suite/.test(r.stdout), 'no suite was started');
  });
}
