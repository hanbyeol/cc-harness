import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpdir, realTmpdir } from './helpers.mjs';

// Built from parts so this file does not contain the forbidden spelling itself.
const CALL = 'real' + 'pathSync';

// Lines (1-based numbers) of `text` that call the non-native realpath and are not comments.
function violations(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    if (line.includes(CALL + '(')) out.push(i + 1);
  });
  return out;
}

function mjsFiles(dir) {
  const files = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...mjsFiles(p));
    else if (e.name.endsWith('.mjs')) files.push(p);
  }
  return files;
}

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
  const doc = fs.readFileSync(path.join(REPO, 'agents', 'builder.md'), 'utf8');
  const item = doc.slice(doc.indexOf('**Path spelling**'), doc.indexOf('**Process ids'));
  assert.match(item, /realTmpdir/);
  assert.match(item, /AC-2/);
});
