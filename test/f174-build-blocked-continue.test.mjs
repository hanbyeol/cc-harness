// F174: the build skill's blocked paragraph says how a blocked feature continues.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';

const text = fs.readFileSync(path.join(REPO, 'skills/build/SKILL.md'), 'utf8');
const at = text.indexOf('When the feature is `blocked`');
assert.notEqual(at, -1);
const para = text.slice(at).split(/\n\s*\n/)[0].replace(/\s+/g, ' ');

test('F174 AC-1 divergence/stall with rounds left continues by same-hash approve', () => {
  assert.match(para, /`divergence` or `stall`/);
  assert.match(para, /rounds left/);
  assert.match(para, /same contract/);
  assert.match(para, /`harness approve F\{n\}`/);
  assert.match(para, /same hash/);
  assert.match(para, /`approved` again/);
});

test('F174 AC-2 exhausted rounds need --extra-round', () => {
  assert.match(para, /`max_rounds`/);
  assert.match(para, /extra round/);
  assert.match(para, /refused/);
  assert.match(para, /`harness approve F\{n\} --extra-round`/);
});

test('F174 AC-3 only after the user decides; old guidance stays', () => {
  assert.match(para, /only after the user has decided/);
  assert.match(para, /Never re-approve or add a round before the user's decision/);
  for (const w of ['split', 'rewrite', 'accept the risk', '`harness decide F{n}`', '`--split`', '`--rewrite`', '`--accept-risk`'])
    assert.ok(para.includes(w), w);
});
