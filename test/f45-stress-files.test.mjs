// F45: `node test/stress.mjs N --files <glob>` stresses only the matching test files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpdir } from './helpers.mjs';
import { writeFiles } from './gitfixture.mjs';

const STRESS = path.join(REPO, 'test', 'stress.mjs');
const stress = (args) => {
  const r = spawnSync(process.execPath, [STRESS, ...args], { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '', stderr: r.stderr || '' };
};

const HEAD = "import test from 'node:test';\nimport fs from 'node:fs';\n";
// A test file that appends its own name to a log, so the fixture shows which files ran.
const logging = (log, name) => `${HEAD}test('fake ${name}', () => { fs.appendFileSync(${JSON.stringify(log)}, '${name}\\n'); });\n`;

test('F45 AC-1: --files runs only the matching file, in every concurrent run', () => {
  const dir = fs.realpathSync(tmpdir('harness-f45-suite-'));
  const log = path.join(dir, 'ran.log');
  writeFiles(dir, {
    'test/one.test.mjs': logging(log, 'one'),
    'test/two.test.mjs': logging(log, 'two'),
  });
  const r = stress(['2', '--root', dir, '--files', 'test/one.test.mjs']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /all 2 runs passed/);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['one', 'one'], 'two runs of the one matching file');
});

test('F45 AC-1: --files takes a glob and reports a failing test of a matched file', () => {
  const dir = fs.realpathSync(tmpdir('harness-f45-suite-'));
  const log = path.join(dir, 'ran.log');
  writeFiles(dir, {
    'test/a1.test.mjs': logging(log, 'a1'),
    'test/a2.test.mjs': `${HEAD}test('fake failing a2', () => { throw new Error('boom'); });\n`,
    'test/b1.test.mjs': logging(log, 'b1'),
  });
  const r = stress(['1', '--root', dir, '--files', 'test/a[12].test.mjs']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /FAILED fake failing a2 .*1\/1 runs/);
  assert.equal(fs.readFileSync(log, 'utf8').trim(), 'a1', 'b1 does not match the glob and did not run');
});

test('F45 ES-1: a glob that matches no file → "no test files match" and exit 2, nothing runs', () => {
  const dir = fs.realpathSync(tmpdir('harness-f45-suite-'));
  writeFiles(dir, { 'test/one.test.mjs': `${HEAD}test('fake one', () => {});\n` });
  const r = stress(['2', '--root', dir, '--files', 'test/none-*.test.mjs']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /no test files match/);
  assert.ok(!/concurrent/.test(r.stdout), 'no run was started');
});
