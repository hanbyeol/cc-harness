import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, project, readJson, writeJson } from './helpers.mjs';
import {
  FORBIDDEN_PATTERNS, executableFeatures, hashContract, isApprovalValid, lintContract, loadContract, parseContract,
} from '../lib/contract.mjs';

const crit = (id, extra = {}) => ({ id, criterion: `criterion ${id}`, check: `node test/t.mjs "X ${id}"`, ...extra });

function contract(over = {}) {
  return {
    id: 'F3',
    title: 'sample',
    security_tier: 'standard',
    version: 1,
    acceptance_criteria: [crit('AC-1'), crit('AC-2')],
    security_criteria: [],
    error_scenarios: [crit('ES-1')],
    out_of_scope: [],
    ...over,
  };
}

const errors = (c, opts) => lintContract(c, opts).filter((p) => p.level === 'error');
const errorFor = (c, id, re, opts) => errors(c, opts).find((p) => p.id === id && re.test(p.message));

function contractPath(dir, id) {
  return path.join(dir, '.harness', 'contracts', `${id}.json`);
}

// Project with features F1 (passed) and the given contracts as F2.. (status todo).
function projectWith(contracts, { featureStatus = 'todo' } = {}) {
  const dir = project([
    { id: 'F1', title: 'base', security_tier: 'standard', depends_on: [], status: 'passed' },
    ...contracts.map((c) => ({ id: c.id, title: c.title, security_tier: c.security_tier, depends_on: ['F1'], status: featureStatus })),
  ]);
  for (const c of contracts) writeJson(contractPath(dir, c.id), c);
  return dir;
}

// Every file under .harness with its content, to prove nothing was written.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(path.join(dir, '.harness'));
  return out;
}

test('F2 AC-1: a criterion with a missing or empty check is an error naming its id', () => {
  assert.deepEqual(errors(contract()), []);
  const c = contract({
    acceptance_criteria: [crit('AC-1'), { id: 'AC-2', criterion: 'x' }, crit('AC-3', { check: '   ' })],
    security_criteria: [crit('SC-1', { check: '' })],
  });
  for (const id of ['AC-2', 'AC-3', 'SC-1']) assert.ok(errorFor(c, id, /check/), id);
  assert.equal(errorFor(c, 'AC-1', /check/), undefined);
});

test('F2 AC-1: lint-contract CLI prints the contract and criterion id and exits 1', () => {
  const dir = projectWith([contract({ acceptance_criteria: [crit('AC-1'), { id: 'AC-2', criterion: 'x', check: '' }] })]);
  const r = harness(['lint-contract'], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^F3 AC-2: error: .*check/m);
  assert.equal(harness(['lint-contract'], { cwd: projectWith([contract()]) }).code, 0);
});

test('F2 AC-2: duplicate criterion ids are an error', () => {
  const c = contract({ acceptance_criteria: [crit('AC-1'), crit('AC-1')] });
  assert.ok(errorFor(c, 'AC-1', /duplicate/));
});

test('F2 AC-2: ids outside the AC-n|SC-n|ES-n form, or in the wrong section, are errors', () => {
  const bad = ['AC1', 'ac-1', 'AC-', 'AC-0', 'AC-1a', 'XX-1', ' AC-1'];
  for (const id of bad) {
    const c = contract({ acceptance_criteria: [crit(id)] });
    assert.ok(errors(c).some((p) => /invalid id/.test(p.message)), id);
  }
  assert.ok(errors(contract({ acceptance_criteria: [{ criterion: 'x', check: 'true' }] })).some((p) => /invalid id/.test(p.message)));
  assert.ok(errorFor(contract({ security_criteria: [crit('AC-9')] }), 'AC-9', /security_criteria/));
  assert.deepEqual(errors(contract({ acceptance_criteria: [crit('AC-1'), crit('AC-12')] })), []);
});

// One test per forbidden pattern (SPEC §5 rule 3).
const SAMPLES = {
  '어떤 .*도': ['ko-1', '어떤 입력에서도 크래시하지 않는다'],
  '모든 .*에 대해': ['ko-2', '모든 경로에 대해 검증한다'],
  '우회 불가': ['ko-3', '게이트는 우회 불가하다'],
  '절대': ['ko-4', '절대 main 에 push 하지 않는다'],
  'any possible': ['en-1', 'handles Any Possible input'],
  'cannot be bypassed': ['en-2', 'the gate cannot be bypassed'],
  'no way to': ['en-3', 'there is No way to skip verify'],
  never: ['en-4', 'the core NEVER writes status'],
};

test('F2 AC-3: the sample table covers exactly the 8 SPEC patterns', () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), FORBIDDEN_PATTERNS.map(([n]) => n).sort());
  assert.equal(FORBIDDEN_PATTERNS.length, 8);
});

for (const [pattern, [tag, sentence]] of Object.entries(SAMPLES)) {
  test(`F2 AC-3 ${tag}: "${pattern}" without cases is an error, with checked cases passes`, () => {
    const without = contract({ acceptance_criteria: [crit('AC-1', { criterion: sentence })] });
    const e = errorFor(without, 'AC-1', /universal statement/);
    assert.ok(e, sentence);
    assert.ok(e.message.includes(`"${pattern}"`), e.message);

    const withCases = contract({
      acceptance_criteria: [crit('AC-1', { criterion: sentence, cases: [{ name: 'a', check: 'node a.mjs' }, { name: 'b', check: 'node b.mjs' }] })],
    });
    assert.deepEqual(errors(withCases), []);
  });
}

test('F2 AC-3 cases: cases must be non-empty and every case needs a non-empty check', () => {
  const s = 'the gate cannot be bypassed';
  for (const cases of [[], [{ check: 'true' }, { name: 'no check' }], [{ check: '' }], ['true'], 'true']) {
    const c = contract({ acceptance_criteria: [crit('AC-1', { criterion: s, cases })] });
    assert.ok(errorFor(c, 'AC-1', /universal statement/), JSON.stringify(cases));
  }
  const ok = contract({ acceptance_criteria: [crit('AC-1', { criterion: s, cases: [{ check: 'true' }] })] });
  assert.deepEqual(errors(ok), []);
});

test('F2 AC-3 boundary: "never" is word-bounded; unrelated text passes', () => {
  for (const s of ['works nevertheless', 'stops at the first error', '모든 파일을 읽는다', '절대경로로 변환한다']) {
    assert.deepEqual(errors(contract({ acceptance_criteria: [crit('AC-1', { criterion: s })] })), [], s);
  }
});

test('F2 AC-4: more than 12 AC, 8 SC, 8 ES or a file over 20KB are each errors', () => {
  const many = (p, n) => Array.from({ length: n }, (_, i) => crit(`${p}-${i + 1}`));
  assert.deepEqual(errors(contract({ acceptance_criteria: many('AC', 12), security_criteria: many('SC', 8), error_scenarios: many('ES', 8) }), { bytes: 20480 }), []);
  assert.ok(errors(contract({ acceptance_criteria: many('AC', 13) })).some((p) => /13 AC criteria exceed the limit of 12/.test(p.message)));
  assert.ok(errors(contract({ security_criteria: many('SC', 9) })).some((p) => /9 SC criteria exceed the limit of 8/.test(p.message)));
  assert.ok(errors(contract({ error_scenarios: many('ES', 9) })).some((p) => /9 ES criteria exceed the limit of 8/.test(p.message)));
  assert.ok(errors(contract(), { bytes: 20481 }).some((p) => /20481 bytes, over the limit of 20480/.test(p.message)));
});

test('F2 AC-4: limits come from config (CLI measures the real file size)', () => {
  const many = (p, n) => Array.from({ length: n }, (_, i) => crit(`${p}-${i + 1}`));
  assert.ok(errors(contract(), { limits: { ac: 1 } }).some((p) => /2 AC criteria exceed the limit of 1/.test(p.message)));
  assert.deepEqual(errors(contract({ acceptance_criteria: many('AC', 13) }), { limits: { ac: 20 } }), []);

  const dir = projectWith([contract({ title: 'x'.repeat(3000) })]);
  assert.equal(harness(['lint-contract', 'F3'], { cwd: dir }).code, 0);
  const cfg = path.join(dir, '.harness', 'config.json');
  writeJson(cfg, { ...readJson(cfg), limits: { bytes: 1024, ac: 1 } });
  const r = harness(['lint-contract', 'F3'], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^F3: error: file is \d+ bytes, over the limit of 1024/m);
  assert.match(r.stdout, /^F3: error: 2 AC criteria exceed the limit of 1/m);
});

test('F2 AC-5: security_tier critical with zero SC is an error', () => {
  assert.ok(errors(contract({ security_tier: 'critical' })).some((p) => /critical requires at least one SC/.test(p.message)));
  assert.deepEqual(errors(contract({ security_tier: 'critical', security_criteria: [crit('SC-1')] })), []);
  assert.deepEqual(errors(contract({ security_tier: 'standard' })), []);
});

test('F7 SC-1: a contract with "rollout" in run_steps is rejected (SR-7)', () => {
  assert.ok(errors(contract({ run_steps: ['build', 'rollout'] })).some((p) => /rollout/.test(p.message)));
  assert.deepEqual(errors(contract({ run_steps: ['build', 'verify', 'eval'] })), []);
  const r = harness(['lint-contract'], { cwd: projectWith([contract({ run_steps: ['rollout'] })]) });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^F3: error: .*rollout/m);
});

test('F2 AC-6: approve records approval{by,at,hash} and sets status approved', () => {
  const c3 = contract();
  const c4 = contract({ id: 'F4', title: 'second' });
  const dir = projectWith([c3, c4]);
  const r = harness(['approve', 'F3', 'F4', '--by', 'alice@example.com'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  for (const [id, orig] of [['F3', c3], ['F4', c4]]) {
    const saved = readJson(contractPath(dir, id));
    assert.deepEqual(Object.keys(saved.approval).sort(), ['at', 'by', 'hash']);
    assert.equal(saved.approval.by, 'alice@example.com');
    assert.ok(!Number.isNaN(Date.parse(saved.approval.at)) && saved.approval.at === new Date(saved.approval.at).toISOString());
    assert.equal(saved.approval.hash, hashContract(orig));
    assert.ok(isApprovalValid(saved));
  }
  const status = Object.fromEntries(readJson(path.join(dir, '.harness', 'features.json')).features.map((f) => [f.id, f.status]));
  assert.deepEqual(status, { F1: 'passed', F3: 'approved', F4: 'approved' });
  assert.equal(harness(['lint-contract'], { cwd: dir }).code, 0);
});

test('F2 AC-6: approve without --by still records a non-empty approver', () => {
  const dir = projectWith([contract()]);
  assert.equal(harness(['approve', 'F3'], { cwd: dir }).code, 0);
  assert.ok(readJson(contractPath(dir, 'F3')).approval.by.trim());
});

test('F2 AC-6: approve refuses when any named contract fails lint and writes nothing', () => {
  const dir = projectWith([contract(), contract({ id: 'F4', acceptance_criteria: [{ id: 'AC-1', criterion: 'no check' }] })]);
  const before = snapshot(dir);
  const r = harness(['approve', 'F3', 'F4', '--by', 'a'], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^F4 AC-1: error: .*check/m);
  assert.match(r.stderr, /nothing approved/);
  assert.deepEqual(snapshot(dir), before);
});

test('F2 AC-6: hash is sha256 of the contract without approval, in parsed key order', () => {
  const c = contract();
  const withApproval = { ...c, approval: { by: 'x', at: 'y', hash: 'z' } };
  assert.equal(hashContract(withApproval), hashContract(c));
  assert.match(hashContract(c), /^[0-9a-f]{64}$/);
  const reordered = { title: c.title, ...c };
  assert.notEqual(hashContract(reordered), hashContract(c));
});

test('F2 AC-7: editing an approved contract gives a hash mismatch error and drops it from the runnable set', () => {
  const dir = projectWith([contract(), contract({ id: 'F4', title: 'other' })]);
  assert.equal(harness(['approve', 'F3', 'F4', '--by', 'a'], { cwd: dir }).code, 0);
  assert.deepEqual(executableFeatures(dir).map((f) => f.id), ['F3', 'F4']);

  const file = contractPath(dir, 'F3');
  const edited = readJson(file);
  edited.acceptance_criteria[0].criterion = 'weakened after approval';
  writeJson(file, edited);

  const r = harness(['lint-contract'], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^F3: error: approval hash does not match/m);
  assert.doesNotMatch(r.stdout, /^F4/m);
  assert.deepEqual(executableFeatures(dir).map((f) => f.id), ['F4']);
  // features.json still says approved — the hash, not the status, decides.
  assert.equal(readJson(path.join(dir, '.harness', 'features.json')).features.find((f) => f.id === 'F3').status, 'approved');

  // Re-approval re-freezes the new content.
  assert.equal(harness(['approve', 'F3', '--by', 'a'], { cwd: dir }).code, 0);
  assert.deepEqual(executableFeatures(dir).map((f) => f.id), ['F3', 'F4']);
});

test('F2 AC-7: an approved feature without an approval hash, or without a contract, is not runnable', () => {
  const dir = projectWith([contract(), contract({ id: 'F4' })], { featureStatus: 'approved' });
  fs.rmSync(contractPath(dir, 'F4'));
  assert.deepEqual(executableFeatures(dir), []);
  assert.equal(isApprovalValid(contract()), false);
  assert.equal(isApprovalValid({ ...contract(), approval: { by: 'a', at: 'b' } }), false);
});

test('F2 ES-1: approve with an unknown contract id exits 2 and writes no file', () => {
  const dir = projectWith([contract()]);
  const before = snapshot(dir);
  for (const args of [['F3', 'F99'], ['F99'], ['nope']]) {
    const r = harness(['approve', ...args, '--by', 'a'], { cwd: dir });
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, /F99|nope/);
    assert.deepEqual(snapshot(dir), before, args.join(' '));
  }
  // Listed in features.json but no contract file: also exit 2, nothing written.
  fs.rmSync(contractPath(dir, 'F3'));
  const before2 = snapshot(dir);
  const r = harness(['approve', 'F3', '--by', 'a'], { cwd: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no such contract 'F3'/);
  assert.deepEqual(snapshot(dir), before2);
  assert.equal(harness(['lint-contract', 'F99'], { cwd: dir }).code, 2);
});

test('F2 ES-2: unparsable contract JSON reports the file path and position', () => {
  const dir = projectWith([contract()]);
  const file = contractPath(dir, 'F3');
  fs.writeFileSync(file, '{\n  "id": "F3",\n  oops\n}\n');
  assert.throws(() => loadContract(dir, 'F3'), (e) => e.message.includes(file) && /line 3 column 3/.test(e.message));

  const r = harness(['lint-contract'], { cwd: dir });
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes(file), r.stderr);
  assert.match(r.stderr, /invalid JSON at line 3 column 3/);

  fs.writeFileSync(file, '{"id": "F3"');
  assert.match(harness(['lint-contract', 'F3'], { cwd: dir }).stderr, /invalid JSON at line 1 column \d+/);

  const before = snapshot(dir);
  const a = harness(['approve', 'F3', '--by', 'a'], { cwd: dir });
  assert.equal(a.code, 2);
  assert.ok(a.stderr.includes(file));
  assert.deepEqual(snapshot(dir), before);
});

test('F2 AC-7 status: an approved contract edited afterwards is not reported as runnable', async () => {
  const { harness, project } = await import('./helpers.mjs');
  const dir = project([{ id: 'F3', title: 't', security_tier: 'standard', depends_on: [], status: 'todo' }]);
  const file = path.join(dir, '.harness', 'contracts', 'F3.json');
  fs.writeFileSync(file, JSON.stringify({ id: 'F3', title: 't', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'x', check: 'true' }], security_criteria: [], error_scenarios: [] }));
  assert.equal(harness(['approve', 'F3', '--by', 'a'], { cwd: dir }).code, 0);
  assert.match(harness(['status', '--brief'], { cwd: dir }).stdout, /next: F3/);
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  c.acceptance_criteria[0].criterion = 'weakened';
  fs.writeFileSync(file, JSON.stringify(c));
  const full = harness(['status'], { cwd: dir }).stdout;
  const brief = harness(['status', '--brief'], { cwd: dir }).stdout;
  assert.doesNotMatch(full + brief, /runnable: F3|next: F3/);
  assert.match(brief, /re-approve: F3/);
});

test('F2 ES-2 positionless errors: bare values, BOM and bad literals still get line and column', () => {
  for (const text of ['{\n  "title": x\n}\n', '﻿{"a": 1}', '{"a": tru}', '{"a": 1,}']) {
    assert.throws(() => parseContract(text, 'F3.json'), /F3\.json: invalid JSON at line \d+ column \d+/, JSON.stringify(text));
  }
});
