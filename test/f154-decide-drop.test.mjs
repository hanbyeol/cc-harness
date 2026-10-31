import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, project, readJson } from './helpers.mjs';

// F154: `harness decide F<n> --drop` closes a feature as skipped.

const feats = (statuses) => statuses.map((status, i) => ({ id: `F${i + 1}`, title: `feature ${i + 1}`, status, depends_on: [] }));
const featuresFile = (dir) => path.join(dir, '.harness', 'features.json');
const backlog = (dir) => readJson(path.join(dir, '.harness', 'backlog.json')).items;
const eventsText = (dir) => {
  const d = path.join(dir, '.harness', 'events');
  let names = [];
  try { names = fs.readdirSync(d).sort(); } catch { return ''; }
  return names.map((n) => fs.readFileSync(path.join(d, n), 'utf8')).join('');
};
const statusOf = (dir, id) => readJson(featuresFile(dir)).features.find((f) => f.id === id).status;

test('F154 AC-1 --drop turns a blocked feature into skipped', () => {
  const dir = project(feats(['blocked']));
  const r = harness(['decide', 'F1', '--drop', 'obsolete'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(statusOf(dir, 'F1'), 'skipped');
  assert.match(r.stdout, /^F1: decision drop recorded \(backlog B/);
  assert.match(r.stdout, /status blocked -> skipped/);
});

test('F154 AC-2 --drop records a backlog decision item and a feedback/decision event', () => {
  const dir = project(feats(['blocked']));
  harness(['decide', 'F1', '--drop', 'obsolete'], { cwd: dir });
  const items = backlog(dir);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'decision');
  assert.equal(items[0].decision, 'drop');
  assert.equal(items[0].reason, 'obsolete');
  const ev = eventsText(dir).split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .find((e) => e.stage === 'feedback' && e.type === 'decision');
  assert.ok(ev);
  assert.equal(ev.data.decision, 'drop');
});

test('F154 AC-3 --drop works on todo and approved features', () => {
  const dir = project(feats(['todo', 'approved']));
  for (const id of ['F1', 'F2']) {
    const r = harness(['decide', id, '--drop', 'not needed'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(statusOf(dir, id), 'skipped');
  }
});

test('F154 AC-4 status --brief counts skipped and not blocked', () => {
  const dir = project(feats(['passed', 'skipped']));
  const r = harness(['status', '--brief'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /skipped/);
  assert.doesNotMatch(r.stdout, /blocked/);
});

test('F154 AC-5 help and SPEC name --drop', () => {
  const help = harness(['decide', '--help']);
  assert.match(help.stdout, /--drop/);
  const spec = fs.readFileSync(path.join(import.meta.dirname, '..', 'docs', 'SPEC.md'), 'utf8');
  const decideLine = spec.split('\n').filter((l) => l.includes('decide'));
  assert.ok(decideLine.some((l) => l.includes('--drop')));
  const sentences = spec.split(/(?<=[.。])\s|\n/);
  assert.ok(sentences.some((s) => s.includes('--drop') && s.includes('skipped')));
});

test('F154 ES-1 --drop on a passed feature is a usage error and changes nothing', () => {
  const dir = project(feats(['passed']));
  const before = fs.readFileSync(featuresFile(dir), 'utf8');
  const r = harness(['decide', 'F1', '--drop', 'x'], { cwd: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /passed/);
  assert.equal(fs.readFileSync(featuresFile(dir), 'utf8'), before);
  assert.deepEqual(backlog(dir), []);
  assert.equal(eventsText(dir).includes('"decision"'), false);
});

test('F154 ES-2 other decisions keep the status', () => {
  const dir = project(feats(['blocked', 'blocked', 'blocked']));
  ['--accept-risk', '--split', '--rewrite'].forEach((flag, i) => {
    const r = harness(['decide', `F${i + 1}`, flag, 'why'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(statusOf(dir, `F${i + 1}`), 'blocked');
  });
});

test('F154 ES-3 --drop with --accept-risk is a usage error and records nothing', () => {
  const dir = project(feats(['blocked']));
  const r = harness(['decide', 'F1', '--drop', '--accept-risk', 'x'], { cwd: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /give one decision, not --drop and --accept-risk/);
  assert.equal(statusOf(dir, 'F1'), 'blocked');
  assert.deepEqual(backlog(dir), []);
  assert.equal(eventsText(dir).includes('"decision"'), false);
});
