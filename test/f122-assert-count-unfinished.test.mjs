// F122: assert-count also reads the approved removes_tests of contracts at the merge base whose feature was unfinished there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './helpers.mjs';
import { gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { hashContract } from '../lib/contract.mjs';

const ASSERT_COUNT = path.join(REPO, 'test', 'assert-count.mjs');
const run = (dir, ...args) => {
  const r = spawnSync(process.execPath, [ASSERT_COUNT, '--base', 'main', '--root', dir, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};
const tests = (...names) => names.map((n) => `test('${n}', () => { assert.ok(true); });\n`).join('');
const contract = (id, removes, { approve = true } = {}) => {
  const c = {
    id, title: 'fixture', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node -e 0', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [], removes_tests: removes,
  };
  if (approve) c.approval = { by: 'test', at: '2026-10-12T00:00:00.000Z', hash: hashContract(c) };
  return c;
};
// Base commit holds the contract, features.json (any value) and two tests; the branch drops 'F9 AC-1'.
const fixture = ({ features, c = contract('F9', ['F9']), extra = {} }) => {
  const dir = gitRepo({
    '.harness/config.json': { base_branch: 'main' },
    '.harness/contracts/F9.json': c,
    '.harness/features.json': features,
    'test/a.test.mjs': tests('F9 AC-1', 'F8 AC-1'),
    ...extra,
  });
  writeFiles(dir, { 'test/a.test.mjs': tests('F8 AC-1') });
  commitAll(dir, 'feature');
  return dir;
};
const feat = (status) => ({ features: [{ id: 'F9', status }] });

test('F122 AC-1 an approved contract at the merge base of an unfinished feature lets its tests vanish', () => {
  for (const status of ['todo', 'in_progress', 'blocked']) {
    const r = run(fixture({ features: feat(status) }));
    assert.equal(r.code, 0, `${status}: ${r.stderr}`);
  }
});

test('F122 AC-2 contracts from both sources are listed once in ascending id order', () => {
  const dir = fixture({
    features: { features: [{ id: 'F9', status: 'todo' }] },
    extra: { 'test/b.test.mjs': tests('F10 AC-1') },
  });
  fs.rmSync(path.join(dir, 'test/b.test.mjs'));
  writeFiles(dir, { '.harness/contracts/F10.json': contract('F10', ['F10']) });
  commitAll(dir, 'add F10');
  // F9 comes from the merge base source, F10 from the added source; the base is main so both are present.
  const r = run(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.split('\n').includes('assert-count: removes_tests approved by F9, F10'), r.stdout);
});

test('F122 AC-4 SPEC §6.2 names the unfinished statuses', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s62 = spec.slice(spec.indexOf('### 6.2'), spec.indexOf('### 6.3'));
  for (const text of ['features.json', '`todo`', '`in_progress`', '`blocked`']) assert.ok(s62.includes(text), `§6.2 lacks ${text}`);
});

test('F122 SC-1 a passed, missing or unreadable feature entry does not approve the removal', () => {
  const cases = [feat('passed'), { features: [{ id: 'F8', status: 'todo' }] }, 'not json {'];
  for (const features of cases) {
    const dir = fixture({ features });
    const r = run(dir);
    assert.equal(r.code, 1, JSON.stringify(features));
    assert.ok(r.stderr.includes('F9 AC-1'), r.stderr);
  }
  // features.json absent at the merge base.
  const bare = gitRepo({
    '.harness/config.json': { base_branch: 'main' },
    '.harness/contracts/F9.json': contract('F9', ['F9']),
    'test/a.test.mjs': tests('F9 AC-1', 'F8 AC-1'),
  });
  writeFiles(bare, { 'test/a.test.mjs': tests('F8 AC-1') });
  commitAll(bare, 'feature');
  const r = run(bare);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes('F9 AC-1'), r.stderr);
});

test('F122 SC-2 an unapproved or edited contract of an unfinished feature does not approve the removal', () => {
  const unapproved = fixture({ features: feat('todo'), c: contract('F9', ['F9'], { approve: false }) });
  assert.equal(run(unapproved).code, 1);
  const edited = { ...contract('F9', ['F9']), title: 'edited after approval' };
  assert.equal(run(fixture({ features: feat('todo'), c: edited })).code, 1);
});

test('F122 ES-1 a features.json that is not JSON is reported and only the extra collection is skipped', () => {
  const dir = fixture({ features: 'not json {' });
  writeFiles(dir, { '.harness/contracts/F10.json': contract('F10', ['F8']) });
  commitAll(dir, 'add F10');
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /assert-count: skipped \.harness\/features\.json: .+/);
  // F8 AC-1 is the test an added approved contract removes; it still counts as before.
  writeFiles(dir, { 'test/a.test.mjs': '' });
  commitAll(dir, 'drop F8');
  assert.equal(run(dir).code, 1, 'F9 AC-1 is still not approved');
  assert.ok(!run(dir).stdout.includes('approved by F9'));
});
