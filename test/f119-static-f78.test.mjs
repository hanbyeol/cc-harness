// F119: F78 AC-5 checks the F70–F77 t.mjs ids statically instead of running each check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpdir } from './helpers.mjs';
import { t78CheckIds, hasTestFor } from '../tools/f78-static.mjs';

test('F119 AC-1 the F78 AC-5 test block starts no child process', () => {
  const src = fs.readFileSync(path.join(REPO, 'test', 'f78-scoped-runner.test.mjs'), 'utf8');
  const start = src.indexOf("test('F78 AC-5 every t.mjs check of the F70–F77 contracts still exits 0'");
  assert.ok(start >= 0, 'F78 AC-5 test exists under its name');
  const next = src.indexOf('\ntest(', start + 1);
  const block = src.slice(start, next === -1 ? undefined : next);
  assert.doesNotMatch(block, /runAsync|spawn|spawnSync|execFile/);
});

test('F119 AC-2 a check id needs a matching test in the files t.mjs selects', () => {
  const ids = t78CheckIds(REPO);
  assert.ok(ids.length >= 60, `found ${ids.length} ids`);
  assert.ok(hasTestFor(REPO, ids[0]), `${ids[0]} has a test`);
  // Fixture: the id appears in a file only as a string, not as a test name.
  const dir = tmpdir('harness-f119-');
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'test', 'a.test.mjs'), "test('Z1 AC-1 ok', () => {});\n// Z1 AC-2 mentioned only\n");
  assert.equal(hasTestFor(dir, 'Z1 AC-1'), true);
  assert.equal(hasTestFor(dir, 'Z1 AC-2'), false);
  assert.equal(hasTestFor(dir, 'Z1 AC-3'), false);
});

test('F119 ES-1 an unreadable contract fails with its path', () => {
  const read = (f, enc) => {
    if (String(f).endsWith('F73.json')) throw new Error('ENOENT');
    return fs.readFileSync(f, enc);
  };
  assert.throws(() => t78CheckIds(REPO, read), (e) => e.message.includes(path.join('contracts', 'F73.json')));
});
