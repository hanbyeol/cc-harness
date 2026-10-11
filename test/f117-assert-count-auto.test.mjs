// F117: assert-count collects the approved removes_tests of contracts added or changed since the merge base.
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
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  if (removes !== undefined) c.removes_tests = removes;
  if (approve) c.approval = { by: 'test', at: '2026-10-11T00:00:00.000Z', hash: hashContract(c) };
  return c;
};

const base = (extra = {}) => gitRepo({
  '.harness/config.json': { base_branch: 'main' },
  'test/a.test.mjs': tests('F9 AC-1', 'F8 AC-1'),
  ...extra,
});
// Removes the F9 test on the branch and adds the given contract files.
function drop(dir, files, kept = ['F8 AC-1']) {
  writeFiles(dir, { 'test/a.test.mjs': tests(...kept), ...files });
  commitAll(dir, 'feature');
}

test('F117 AC-1 an approved contract added after the merge base lets its removes_tests vanish', () => {
  const dir = base();
  drop(dir, { '.harness/contracts/F9.json': contract('F9', ['F9']) });
  const r = run(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(run(dir, '--removes', 'F9').code, 0, 'the explicit form agrees');
});

test('F117 AC-1 an approved contract whose content changed after the merge base counts too', () => {
  const dir = base({ '.harness/contracts/F9.json': contract('F9', ['F7']) });
  drop(dir, { '.harness/contracts/F9.json': contract('F9', ['F9']) });
  assert.equal(run(dir).code, 0);
});

test('F117 AC-2 prints the approving contracts in ascending id order', () => {
  const dir = base({ 'test/b.test.mjs': tests('F10 AC-1') });
  fs.rmSync(path.join(dir, 'test/b.test.mjs'));
  drop(dir, {
    '.harness/contracts/F10.json': contract('F10', ['F10']),
    '.harness/contracts/F9.json': contract('F9', ['F9']),
  });
  const r = run(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.split('\n').includes('assert-count: removes_tests approved by F9, F10'), r.stdout);
});

test('F117 AC-2 prints no approval line when nothing is approved', () => {
  const r = run(base());
  assert.equal(r.code, 0);
  assert.ok(!r.stdout.includes('removes_tests approved by'), r.stdout);
});

test('F117 AC-4 the call the repository test makes (no arguments, cwd the repository) passes after an approved removal', () => {
  const dir = base();
  drop(dir, { '.harness/contracts/F9.json': contract('F9', ['F9']) });
  const r = spawnSync(process.execPath, [ASSERT_COUNT, '--base', 'main', '--root', dir], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('F117 AC-5 SPEC §6.2 describes the automatic collection', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s62 = spec.slice(spec.indexOf('### 6.2'), spec.indexOf('### 6.3'));
  for (const text of ['--removes', 'merge-base', 'approval.hash', 'assert-count: removes_tests approved by']) assert.ok(s62.includes(text), `§6.2 lacks ${text}`);
  assert.ok(s62.includes('자동'), '§6.2 lacks the automatic collection');
});

test('F117 SC-1 an unapproved contract or one edited after approval does not approve its removal', () => {
  const edited = contract('F9', ['F7']);
  edited.removes_tests = ['F9'];
  for (const c of [contract('F9', ['F9'], { approve: false }), edited]) {
    const dir = base();
    drop(dir, { '.harness/contracts/F9.json': c });
    const r = run(dir);
    assert.equal(r.code, 1, r.stdout);
    assert.ok(r.stderr.includes('F9 AC-1'), r.stderr);
  }
});

test('F117 SC-2 a contract already at the merge base and unchanged is not used', () => {
  const dir = base({ '.harness/contracts/F8.json': contract('F8', ['F8']) });
  drop(dir, {}, ['F9 AC-1']);
  const r = run(dir);
  assert.equal(r.code, 1, r.stdout);
  assert.ok(r.stderr.includes('F8 AC-1'), r.stderr);
});

test('F117 ES-1 a contract that is not JSON or has a non-array removes_tests is skipped with a stderr line', () => {
  const bad = contract('F9', ['F9']);
  bad.removes_tests = 'F9';
  const dir = base();
  drop(dir, {
    '.harness/contracts/F9.json': bad,
    '.harness/contracts/F10.json': '{ not json',
  });
  const r = run(dir);
  assert.equal(r.code, 1, 'the vanished test is not approved');
  assert.match(r.stderr, /^assert-count: skipped \.harness\/contracts\/F9\.json: .+$/m);
  assert.match(r.stderr, /^assert-count: skipped \.harness\/contracts\/F10\.json: .+$/m);
  assert.ok(r.stderr.includes('F9 AC-1'), r.stderr);
});
