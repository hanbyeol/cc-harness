import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { hashContract, lintContract } from '../lib/contract.mjs';

const ac = (n, over = {}) => ({ id: `AC-${n}`, criterion: 'x', check: 'true', new: true, ...over });
const make = (acs, extra = {}) => ({
  id: 'F1', title: 't', security_tier: 'standard', version: 1,
  acceptance_criteria: acs, security_criteria: [], error_scenarios: [], out_of_scope: [], ...extra,
});
const many = (n) => Array.from({ length: n }, (_, i) => ac(i + 1));
const rules = (c, o) => lintContract(c, o).filter((p) => p.level === 'warning').map((p) => p.rule);
const approve = (c) => ({ ...c, approval: { by: 't', at: 'x', hash: hashContract(c) } });

test('F133 AC-1 new: false needs a new_reason string', () => {
  const c = make([ac(1, { new: false }), ac(2, { new: false, new_reason: 'covered by F1' }), ac(3), ac(4, { new: undefined })]);
  const w = lintContract(c).filter((p) => p.rule === 'new_reason');
  assert.deepEqual(w.map((p) => [p.level, p.id]), [['warning', 'AC-1']]);
});

test('F133 AC-2 criterion over 300 characters warns', () => {
  const c = make([ac(1, { criterion: 'a'.repeat(300) }), ac(2, { criterion: 'a'.repeat(301) })]);
  const w = lintContract(c).filter((p) => p.rule === 'criterion_length');
  assert.equal(w.length, 1);
  assert.equal(w[0].id, 'AC-2');
  assert.match(w[0].message, /301/);
});

test('F133 AC-3 split_suggested for 9-12 acceptance criteria', () => {
  assert.ok(!rules(make(many(8))).includes('split_suggested'));
  const w = lintContract(make(many(9))).filter((p) => p.rule === 'split_suggested');
  assert.equal(w.length, 1);
  assert.match(w[0].message, /9/);
  assert.match(w[0].message, /split/);
  assert.equal(lintContract(make(many(12))).filter((p) => p.rule === 'split_suggested').length, 1);
  const p13 = lintContract(make(many(13)));
  assert.ok(!p13.some((p) => p.rule === 'split_suggested'));
  assert.ok(p13.some((p) => p.level === 'error' && p.rule === 'size'));
});

test('F133 AC-4 approved contracts skip the quality warnings', () => {
  const bad = make(many(9).map((a, i) => (i === 0 ? { ...a, new: false, criterion: 'a'.repeat(301) } : a)));
  const Q = ['new_reason', 'criterion_length', 'split_suggested'];
  assert.deepEqual(Q.filter((r) => !rules(bad).includes(r)), []);
  const ok = approve(bad);
  assert.deepEqual(rules(ok).filter((r) => Q.includes(r)), []);
  const edited = { ...ok, title: 'changed' };
  assert.deepEqual(Q.filter((r) => !rules(edited).includes(r)), []);
  assert.deepEqual(Q.filter((r) => !rules(ok, { ignoreApproval: true }).includes(r)), []);
});

test('F133 AC-5 own resolved_by does not warn', () => {
  const c = make([ac(1)], { resolves: ['B1'] });
  const own = lintContract(c, { backlog: [{ id: 'B1', resolved_by: 'F1' }] });
  assert.ok(!own.some((p) => p.rule === 'resolves'));
  const other = lintContract(c, { backlog: [{ id: 'B1', resolved_by: 'F2' }] });
  assert.ok(other.some((p) => p.rule === 'resolves' && /already resolved/.test(p.message)));
});

test('F133 AC-6 docs describe the warnings and the spec rule', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs/SPEC.md'), 'utf8');
  for (const w of ['new_reason', 'criterion_length', 'split_suggested']) assert.ok(spec.includes(w), w);
  assert.match(spec, /승인 계약/);
  assert.match(spec, /already resolved/);
  const skill = fs.readFileSync(path.join(REPO, 'skills/spec/SKILL.md'), 'utf8');
  assert.match(skill, /new_reason/);
  assert.match(skill, /baseline/);
  assert.match(skill, /speed or cost/);
});

test('F133 ES-1 invalid new_reason values warn, not error', () => {
  for (const v of [5, '', '   ']) {
    const p = lintContract(make([ac(1, { new: false, new_reason: v })]));
    assert.ok(p.some((x) => x.rule === 'new_reason' && x.level === 'warning' && x.id === 'AC-1'), String(v));
    assert.ok(!p.some((x) => x.level === 'error'));
  }
});
