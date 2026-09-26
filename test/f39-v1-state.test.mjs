import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, harness, tmpdir, readJson, writeJson, project } from './helpers.mjs';

// A v1 project whose feature_list.json holds one not-passed feature per given status.
function v1WithStatuses(statuses) {
  const dir = tmpdir('harness-v1state-');
  writeJson(path.join(dir, 'progress', 'feature_list.json'), {
    features: statuses.map((status, i) => ({
      id: `F${i + 1}`, name: `feature ${i + 1}`, security_tier: 'standard', status, passes: false, dependencies: [],
    })),
  });
  return dir;
}

function migrated(statuses) {
  const dir = v1WithStatuses(statuses);
  const r = harness(['migrate-v1'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  return { dir, features: readJson(path.join(dir, '.harness', 'features.json')).features };
}

const CASES = [
  ['PARTIAL', 'partial'],
  ['partial — F38 only', 'partial'],
  ['Partial (docs left)', 'partial'],
  ['in_progress', 'in_progress'],
  ['IN_PROGRESS: sprint 3', 'in_progress'],
  ['in-progress', 'in_progress'],
  ['In-Progress since Monday', 'in_progress'],
  ['blocked', 'blocked'],
  ['BLOCKED on infra', 'blocked'],
  ['deferred', 'deferred'],
  ['Deferred to v3', 'deferred'],
  ['hold', 'deferred'],
  ['HOLD until review', 'deferred'],
];

for (const [status, state] of CASES) {
  test(`F39 AC-1: v1 status '${status}' stays todo with v1.state ${state}`, () => {
    const { features } = migrated([status]);
    assert.equal(features[0].status, 'todo');
    assert.equal(features[0].v1.state, state);
    assert.equal(features[0].v1.status, status);
  });
}

test('F39 AC-1: statuses that are not in-flight states get no v1.state', () => {
  const { features } = migrated(['pending', 'superseded', 'unpartial', null, 42, 'removed']);
  assert.deepEqual(features.map((f) => f.v1.state), [undefined, undefined, undefined, undefined, undefined, undefined]);
  assert.deepEqual(features.map((f) => f.status), ['todo', 'todo', 'todo', 'todo', 'todo', 'skipped']);
});

test('F39 AC-1: a passed v1 feature stays passed and gets no v1.state', () => {
  const dir = tmpdir('harness-v1state-');
  writeJson(path.join(dir, 'progress', 'feature_list.json'), {
    features: [{ id: 'F1', name: 'a', status: 'partial', passes: true }],
  });
  assert.equal(harness(['migrate-v1'], { cwd: dir }).code, 0);
  const [f] = readJson(path.join(dir, '.harness', 'features.json')).features;
  assert.equal(f.status, 'passed');
  assert.equal(f.v1.state, undefined);
});

function v1Features() {
  return [
    { id: 'F1', title: 'done one', status: 'passed', depends_on: [], v1: { status: 'passed', passes: true } },
    { id: 'F2', title: 'half done', status: 'todo', depends_on: [], v1: { status: 'PARTIAL — only the parser landed', passes: false, state: 'partial' } },
    { id: 'F3', title: 'stuck', status: 'todo', depends_on: [], v1: { status: 'blocked on infra', passes: false, state: 'blocked' } },
    { id: 'F4', title: 'plain v1', status: 'todo', depends_on: [], v1: { status: 'pending', passes: false } },
    { id: 'F5', title: 'made in v2', status: 'todo', depends_on: [] },
    { id: 'F6', title: 'long', status: 'todo', depends_on: [], v1: { status: 'partial ' + 'x'.repeat(200), passes: false, state: 'partial' } },
    { id: 'F7', title: 'later', status: 'todo', depends_on: [], v1: { status: 'deferred to v3', passes: false, state: 'deferred' } },
  ];
}

test('F39 AC-2: status appends (v1: <first 60 chars of v1.status>) to v1-origin todo features', () => {
  const dir = project(v1Features());
  const r = harness(['status'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.split('\n');
  const line = (id) => lines.find((l) => l.startsWith(`  ${id}`));
  assert.match(line('F2'), /half done \(v1: PARTIAL — only the parser landed\)$/);
  assert.match(line('F3'), /stuck \(v1: blocked on infra\)$/);
  assert.match(line('F4'), /plain v1 \(v1: pending\)$/);
  assert.match(line('F6'), new RegExp(`long \\(v1: partial ${'x'.repeat(60 - 'partial '.length)}\\)$`));
  assert.ok(!line('F1').includes('(v1:'), line('F1')); // only todo features
  assert.ok(!line('F5').includes('(v1:'), line('F5'));
});

test('F39 AC-2: status --brief splits the todo count into v1 partial and blocked', () => {
  const dir = project(v1Features());
  const r = harness(['status', '--brief'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /1 passed · 6 todo \(v1 partial 2 · blocked 1\)/);
});

test('F39 AC-2: status --brief keeps the plain todo count when no v1 partial or blocked features exist', () => {
  const dir = project([
    { id: 'F1', title: 'a', status: 'todo', depends_on: [], v1: { status: 'pending', passes: false } },
    { id: 'F2', title: 'b', status: 'todo', depends_on: [] },
  ]);
  const r = harness(['status', '--brief'], { cwd: dir });
  assert.match(r.stdout, /harness: 2 todo(?! \()/);
});

test('F39 AC-3: status --todo-v1 lists v1-origin todo features grouped by v1.state', () => {
  const dir = project(v1Features());
  const r = harness(['status', '--todo-v1'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  const out = r.stdout;
  const at = (s) => { const i = out.indexOf(s); assert.ok(i >= 0, `${s}\n${out}`); return i; };
  // group order: partial, blocked, deferred, then features with no v1.state
  assert.ok(at('partial') < at('F2') && at('F2') < at('F6'));
  assert.ok(at('F6') < at('blocked') && at('blocked') < at('F3'));
  assert.ok(at('F3') < at('deferred') && at('deferred') < at('F7'));
  assert.ok(at('F7') < at('F4'));
  assert.match(out, /F2 .*half done.*PARTIAL — only the parser landed/);
  assert.match(out, /F3 .*stuck.*blocked on infra/);
  assert.match(out, new RegExp(`F6 .*long.*partial ${'x'.repeat(120 - 'partial '.length)}(?!x)`));
  assert.ok(!out.includes('x'.repeat(120 - 'partial '.length + 1)));
  // not v1-origin todo features
  assert.ok(!/\bF1\b/.test(out), out);
  assert.ok(!/\bF5\b/.test(out), out);
  assert.ok(!/features:|backlog:/.test(out), out);
});

test('F39 AC-3: status --todo-v1 in a project without v1 features prints a none line and exits 0', () => {
  const dir = project([{ id: 'F1', title: 'a', status: 'todo', depends_on: [] }]);
  const r = harness(['status', '--todo-v1'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /none/);
});

test('F39 AC-4: status output for features without v1 fields is unchanged', () => {
  const dir = project([
    { id: 'F1', title: 'a', status: 'passed', depends_on: [] },
    { id: 'F2', title: 'b', status: 'todo', depends_on: [] },
    { id: 'F3', title: 'c', status: 'blocked', depends_on: [] },
  ]);
  const r = harness(['status'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.split('\n').slice(0, 4).join('\n'),
    ['features: 1 passed · 1 todo · 1 blocked',
      '  F1    passed      a',
      '  F2    todo        b',
      '  F3    blocked     c'].join('\n'));
  assert.ok(!r.stdout.includes('(v1'));
  assert.match(harness(['status', '--brief'], { cwd: dir }).stdout, /^harness: 1 passed · 1 todo · 1 blocked(?! \()/);
});

test('F39 AC-4: a v1 passed feature and a v1 todo with no state show as before apart from the suffix', () => {
  const dir = project([{ id: 'F1', title: 'a', status: 'passed', depends_on: [], v1: { status: 'passed', passes: true } }]);
  const r = harness(['status'], { cwd: dir });
  assert.match(r.stdout, /^ {2}F1 {4}passed {6}a$/m);
});

test('F39 AC-5: SPEC §13 and README migration section describe v1.state and the display rules', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s13 = spec.slice(spec.indexOf('## 13.'));
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  const migration = readme.slice(readme.indexOf('## v1에서 마이그레이션'), readme.indexOf('### 무엇이 왜 바뀌었나'));
  for (const [name, text] of [['SPEC §13', s13], ['README', migration]]) {
    for (const needle of ['v1.state', 'partial', 'in_progress', 'blocked', 'deferred', '--todo-v1', '(v1:']) {
      assert.ok(text.includes(needle), `${name} should mention ${needle}`);
    }
  }
});

test('F39 ES-1: a non-string v1.status is shown without a v1 suffix and status exits 0', () => {
  const dir = project([
    { id: 'F1', title: 'num', status: 'todo', depends_on: [], v1: { status: 42, passes: false } },
    { id: 'F2', title: 'obj', status: 'todo', depends_on: [], v1: { status: { a: 1 }, passes: false } },
    { id: 'F3', title: 'nul', status: 'todo', depends_on: [], v1: { status: null, passes: false } },
    { id: 'F4', title: 'state only', status: 'todo', depends_on: [], v1: { status: 7, state: 'partial' } },
  ]);
  for (const args of [[], ['--brief'], ['--todo-v1']]) {
    const r = harness(['status', ...args], { cwd: dir });
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.ok(!r.stdout.includes('(v1:'), r.stdout);
    assert.ok(!r.stdout.includes('[object Object]'), r.stdout);
  }
  const r = harness(['status'], { cwd: dir });
  assert.match(r.stdout, /^ {2}F1 {4}todo {8}num$/m);
  assert.match(r.stdout, /^ {2}F2 {4}todo {8}obj$/m);
  // The v1.state is still honoured when v1.status is unusable: the feature is listed
  // under its state, without a status text, and counted in the brief split.
  const list = harness(['status', '--todo-v1'], { cwd: dir });
  assert.match(list.stdout, /^partial \(1\)$/m, list.stdout);
  assert.match(list.stdout, /^ {2}F4 {4}state only$/m, list.stdout);
  assert.match(list.stdout, /^no state \(3\)$/m, list.stdout);
  const brief = harness(['status', '--brief'], { cwd: dir });
  assert.match(brief.stdout, /4 todo \(v1 partial 1 · blocked 0\)/, brief.stdout);
});
