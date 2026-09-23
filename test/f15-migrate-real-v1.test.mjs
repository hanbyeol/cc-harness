// F15: migrate-v1 on real v1 data — v1 lists that use `title` instead of `name`, ids that
// are not F<n>, and free-text statuses for features taken out of scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, tmpdir, readJson, writeJson } from './helpers.mjs';

// Shaped like a real v1 project (inno-infra): title field, non-F<n> ids, mixed statuses.
const V1 = [
  { id: 'F-APP-TCS', title: '[REMOVED 2026-04-29] internal site', status: 'removed', passes: false, dependencies: [] },
  { id: 'F-GITEA', title: 'Gitea', status: 'planned', passes: false, dependencies: ['F-ORG'] },
  { id: 'F-ORG', title: 'Org setup', status: 'done', passes: true, dependencies: [] },
  { id: 'F2', title: 'Already v2-shaped', status: 'implemented', passes: true, dependencies: ['F-ORG', 'F-NOPE'] },
  { id: 'F-OLD', title: 'Old', status: 'Archived (2026-04-28)', passes: true, dependencies: [] },
  { id: 'F-X', title: 'Cancelled thing', status: 'CANCELLED', passes: false, dependencies: [] },
  { id: 'F-NAMED', name: 'name wins', title: 'title loses', status: 'verified', passes: true, dependencies: [] },
  { id: 'F-BARE', status: 'in_progress', passes: false },
];

function project(features = V1) {
  const dir = tmpdir('harness-v1real-');
  writeJson(path.join(dir, 'progress', 'feature_list.json'), { features });
  return dir;
}

function migrate(features) {
  const dir = project(features);
  const r = harness(['migrate-v1'], { cwd: dir });
  const out = r.code === 0 ? readJson(path.join(dir, '.harness', 'features.json')).features : null;
  return { dir, r, out, byV1: out && Object.fromEntries(out.map((f) => [f.v1.id ?? f.id, f])) };
}

test('F15 AC-1 title comes from v1 title when name is absent; name wins; id is the last resort', () => {
  const { r, byV1 } = migrate();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(byV1['F-GITEA'].title, 'Gitea');
  assert.equal(byV1['F-NAMED'].title, 'name wins');
  assert.equal(byV1['F-BARE'].title, 'F-BARE');
});

test('F15 AC-2 non-F<n> ids get the smallest unused F<n> in order; F<n> ids stay; dependencies follow', () => {
  const { r, out, byV1 } = migrate();
  assert.equal(r.code, 0, r.stderr);
  // F2 is taken by the v2-shaped entry, so the others get F1, F3, F4, ...
  assert.deepEqual(out.map((f) => f.id), ['F1', 'F3', 'F4', 'F2', 'F5', 'F6', 'F7', 'F8']);
  assert.equal(byV1['F2'].id, 'F2');
  assert.equal(byV1['F2'].v1.id, undefined);
  assert.equal(byV1['F-APP-TCS'].v1.id, 'F-APP-TCS');
  assert.deepEqual(byV1['F-GITEA'].depends_on, ['F4']); // F-ORG → F4
  assert.deepEqual(byV1['F2'].depends_on, ['F4']); // unknown F-NOPE dropped
  assert.match(r.stderr, /F-NOPE/);
});

test('F15 AC-3 removed / cancelled / archived statuses become skipped whatever passes says', () => {
  const { r, byV1 } = migrate();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(byV1['F-APP-TCS'].status, 'skipped');
  assert.equal(byV1['F-OLD'].status, 'skipped'); // passes:true but archived
  assert.equal(byV1['F-X'].status, 'skipped'); // upper case
});

test('F15 AC-4 other statuses map passes to passed/todo and keep the v1 status', () => {
  const { r, byV1 } = migrate();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(byV1['F-ORG'].status, 'passed');
  assert.equal(byV1['F-GITEA'].status, 'todo');
  assert.equal(byV1['F-BARE'].status, 'todo');
  assert.equal(byV1['F-GITEA'].v1.status, 'planned');
  assert.equal(byV1['F-OLD'].v1.status, 'Archived (2026-04-28)');
});

test('F15 AC-5 the summary counts passed, todo, skipped and renumbered features', () => {
  const { r } = migrate();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /migrated 8 feature\(s\).*\(3 passed, 2 todo, 3 skipped\)/);
  assert.match(r.stdout, /7 feature\(s\) had v1 ids that are not F<n>/);
});

test('F15 AC-6 the migrated project reads cleanly with harness status and every id is F<n>', () => {
  const { dir, r, out } = migrate();
  assert.equal(r.code, 0, r.stderr);
  assert.ok(out.every((f) => /^F\d+$/.test(f.id)), out.map((f) => f.id).join(','));
  const s = harness(['status'], { cwd: dir });
  assert.equal(s.code, 0, s.stderr);
  assert.match(s.stdout, /3 passed/);
});

test('F15 ES-1 duplicate v1 ids: nothing written, exit 2 naming the id', () => {
  const dir = project([{ id: 'F-A', title: 'a', passes: false }, { id: 'F-A', title: 'b', passes: true }]);
  const r = harness(['migrate-v1'], { cwd: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /duplicate feature id 'F-A'/);
  assert.equal(fs.existsSync(path.join(dir, '.harness')), false);
});
