import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpdir, realTmpdir } from './helpers.mjs';
import { violations, mjsFiles } from '../tools/f134-realpath.mjs';

const CALL = 'real' + 'pathSync';

test('F134 AC-1: realTmpdir returns the native real path of a tmpdir directory', () => {
  const d = realTmpdir('harness-f134-');
  assert.equal(d, fs.realpathSync.native(d));
  assert.ok(fs.statSync(d).isDirectory());
  assert.ok(path.basename(d).startsWith('harness-f134-'));
  const plain = tmpdir('harness-f134-plain-');
  assert.ok(fs.statSync(plain).isDirectory());
});

test('F134 AC-2: no plain realpathSync call under test/ or lib/', () => {
  const bad = [];
  for (const root of ['test', 'lib']) {
    for (const f of mjsFiles(path.join(REPO, root))) {
      for (const n of violations(fs.readFileSync(f, 'utf8'))) bad.push(`${path.relative(REPO, f)}:${n}`);
    }
  }
  assert.deepEqual(bad, [], `use realpathSync.native at: ${bad.join(', ')}`);
});

test('F134 AC-3: the static check on fixture strings', () => {
  assert.deepEqual(violations(`const a = fs.${CALL}(x);`), [1]);
  assert.deepEqual(violations(`x\nconst a = fs.${CALL}(x);`), [2]);
  assert.deepEqual(violations(`const a = fs.${CALL}.native(x);`), []);
  assert.deepEqual(violations(`// fs.${CALL}(x)`), []);
  assert.deepEqual(violations(`  // fs.${CALL}(x)`), []);
});

test('F134 AC-4: builder.md names realTmpdir and the static check', () => {
  const doc = fs.readFileSync(path.join(REPO, 'CLAUDE.md'), 'utf8');
  const tail = doc.slice(doc.indexOf('This block is managed by'));
  assert.match(tail, /realTmpdir/);
  assert.match(tail, /realpathSync\.native/);
  assert.match(tail, /F134 AC-2/);
});
