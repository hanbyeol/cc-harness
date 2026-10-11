import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, REPO, readJson } from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';

// F57: feedback stage events of `harness decide`.

function fixture({ features = ['F1', 'F2', 'F3'], status = 'blocked', backlog = { items: [] }, files = {} } = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: features.map((id) => ({ id, title: `feature ${id}`, status, depends_on: [] })) },
    '.harness/backlog.json': backlog,
    ...files,
  }, { branch: null });
}

const eventsDir = (dir) => path.join(dir, '.harness', 'events');
const eventsText = (dir) => {
  let names = [];
  try { names = fs.readdirSync(eventsDir(dir)).sort(); } catch { return ''; }
  return names.map((n) => fs.readFileSync(path.join(eventsDir(dir), n), 'utf8')).join('');
};
const events = (dir) => eventsText(dir).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const of = (dir, stage, type) => events(dir).filter((e) => e.stage === stage && e.type === type);
const backlogOf = (dir) => readJson(path.join(dir, '.harness', 'backlog.json'));
const featuresText = (dir) => fs.readFileSync(path.join(dir, '.harness', 'features.json'), 'utf8');

// ---------- AC-1 ----------
test('F57 AC-1: decide records feedback/decision and a kind: decision backlog item, status unchanged', () => {
  const dir = fixture({ backlog: { items: [{ id: 'B1', summary: 'old' }] } });
  const before = featuresText(dir);
  const cases = [['--accept-risk', 'accept-risk', 'F1'], ['--split', 'split', 'F2'], ['--rewrite', 'rewrite', 'F3']];
  for (const [flag, decision, id] of cases) {
    const r = harness(['decide', id, flag, `because ${decision}`], { cwd: dir });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`${id}.*${decision}`));
  }
  const ev = of(dir, 'feedback', 'decision');
  assert.deepEqual(ev.map((e) => [e.feature, e.data.decision, e.data.reason]), cases.map(([, d, id]) => [id, d, `because ${d}`]));
  const items = backlogOf(dir).items;
  assert.equal(items.length, 4);
  assert.deepEqual(items.slice(1).map((i) => [i.id, i.kind, i.feature, i.decision, i.reason]),
    cases.map(([, d, id], k) => [`B${k + 2}`, 'decision', id, d, `because ${d}`]));
  assert.ok(items.slice(1).every((i) => !Number.isNaN(Date.parse(i.at))));
  assert.deepEqual(ev.map((e) => e.data.backlog_id), ['B2', 'B3', 'B4']);
  assert.equal(featuresText(dir), before);
  assert.deepEqual(events(dir).filter((e) => e.type === 'status'), []);
});

test('F57 AC-1: decide takes exactly one decision flag and a known feature', () => {
  const dir = fixture();
  for (const args of [['F1', 'why'], ['F1', '--split', '--rewrite', 'why'], ['F9', '--split', 'why'], ['nope', '--split', 'why'], ['F1', '--split', 'a', 'b']]) {
    const r = harness(['decide', ...args], { cwd: dir });
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  }
  assert.equal(eventsText(dir), '');
  assert.deepEqual(backlogOf(dir).items, []);
});
