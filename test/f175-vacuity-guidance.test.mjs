// F175: spec skill and builder prompt guide criteria that avoid vacuity.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';

const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const rules = () => {
  const s = read('skills/spec/SKILL.md');
  const i = s.indexOf('## 3. Rules that make a criterion decidable');
  assert.ok(i >= 0);
  return s.slice(i, s.indexOf('\n## 4.', i)).replace(/\s+/g, ' ');
};

test('F175 AC-1 the rules section says regression guards use new: false and new_reason', () => {
  const r = rules();
  assert.match(r, /regression guard/i);
  assert.match(r, /"new": false` and a `new_reason`/);
});

test('F175 AC-2 the rules section asks for a contrast assertion in the same test', () => {
  const r = rules();
  assert.match(r, /does not happen/);
  assert.match(r, /passes on the base branch/);
  assert.match(r, /contrast assertion in the same test/);
});

test('F175 AC-3 the builder test step asks for a contrast assertion', () => {
  const s = read('agents/builder.md').replace(/\s+/g, ' ');
  const i = s.indexOf('write the test first');
  const j = s.indexOf('3. Write the smallest change');
  assert.ok(i >= 0 && j > i);
  assert.match(s.slice(i, j), /only asserts that something does not happen, add a contrast assertion in the same test/);
});
