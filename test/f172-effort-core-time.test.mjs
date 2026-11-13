// F172: the builder effort rule counts core step lines (role core) as $0 with their duration.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { computeStats } from '../lib/metrics.mjs';

let n = 0;
const at = () => new Date(Date.UTC(2026, 10, 1) + (n += 1) * 60_000).toISOString();
const line = (o) => ({ feature: 'F0', round: 1, step: 'build', started_at: at(), ended_at: at(), duration_ms: 1000, cost_usd: 0,
  role: 'builder', adapter: 'claude', model: 'sonnet', effort: null, outcome: 'ok', ...o });
function feature(id, { effort, cost, ms, core = [] }) {
  return [
    line({ feature: id, step: 'build', effort, cost_usd: cost, duration_ms: ms }),
    ...core.map((c) => line({ feature: id, step: 'verify', role: 'core', model: null, adapter: null, cost_usd: null, ...c })),
    line({ feature: id, step: 'eval', role: 'evaluator', model: 'opus', outcome: 'pass', cost_usd: 0, duration_ms: 0 }),
  ];
}
const group = (p, count, o) => Array.from({ length: count }, (_, i) => feature(`${p}${i + 1}`, o)).flat();
const CURRENT = { builder: { standard: { model: 'sonnet', effort: 'high' } }, evaluator: { standard: { model: 'opus', effort: 'high' } } };
const stats = (rows) => computeStats(rows, { tiers: new Map(rows.map((r) => [r.feature, 'standard'])), current: CURRENT });
const sugg = (rows) => stats(rows).suggestions.filter((s) => s.rule === 'effort');
const without = (rows) => rows.filter((r) => r.role !== 'core');

test('F172 AC-1 a core line counts as $0 and its duration in the builder group time', () => {
  const rows = [...group('H', 5, { effort: 'high', cost: 2, ms: 90_000 }), ...group('M', 5, { effort: 'medium', cost: 1, ms: 60_000, core: [{ duration_ms: 10_000, round: 1 }] })];
  const s = sugg(rows);
  assert.equal(s.length, 1);
  assert.equal(s[0].effort, 'medium');
  assert.equal(s[0].duration_ms, 70_000);
  assert.equal(s[0].cost_usd, 1);
});

test('F172 AC-2 a lower effort whose verify time makes it slower overall is not suggested', () => {
  const m = { effort: 'medium', cost: 1, ms: 60_000 };
  const rows = [...group('H', 5, { effort: 'high', cost: 2, ms: 90_000 }), ...group('M', 5, { ...m, core: [{ duration_ms: 60_000 }] })];
  assert.equal(sugg(without(rows)).length, 1);
  assert.equal(sugg(rows).length, 0);
});

test('F172 AC-3 role lines keep the F170 rules; a core line with a non-numeric duration is dropped alone', () => {
  const base = [...group('H', 5, { effort: 'high', cost: 2, ms: 90_000 }), ...group('M', 5, { effort: 'medium', cost: 1, ms: 60_000, core: [{ duration_ms: 5_000 }, { duration_ms: 'x' }, { duration_ms: null }] })];
  assert.equal(sugg(base)[0].duration_ms, 65_000);
  // a role line without a numeric cost is left out, so the feature has no round 1 build line and no group
  const noCost = group('M', 5, { effort: 'medium', cost: null, ms: 60_000, core: [{ duration_ms: 5 }] });
  assert.equal(sugg([...group('H', 5, { effort: 'high', cost: 2, ms: 90_000 }), ...noCost]).length, 0);
  // a role line with a non-numeric duration is left out
  const noMs = group('M', 5, { effort: 'medium', cost: 1, ms: 'x' });
  assert.equal(sugg([...group('H', 5, { effort: 'high', cost: 2, ms: 90_000 }), ...noMs]).length, 0);
});

test('F172 AC-4 the evaluator comparison ignores core lines', () => {
  const ev = (id, effort, ms, core) => [
    line({ feature: id, step: 'build', effort: 'high', cost_usd: 1, duration_ms: 1000 }),
    ...(core ? [line({ feature: id, step: 'verify', role: 'core', cost_usd: null, duration_ms: 999_999 })] : []),
    line({ feature: id, step: 'eval', role: 'evaluator', model: 'opus', effort, outcome: 'pass', cost_usd: 1, duration_ms: ms }),
  ];
  const mk = (core) => [...Array.from({ length: 5 }, (_, i) => ev(`H${i}`, 'high', 90_000, core)), ...Array.from({ length: 5 }, (_, i) => ev(`M${i}`, 'medium', 60_000, core))].flat();
  const pick = (rows) => sugg(rows).filter((s) => s.role === 'evaluator').map((s) => [s.effort, s.duration_ms, s.current_duration_ms]);
  assert.deepEqual(pick(mk(true)), pick(mk(false)));
  assert.equal(pick(mk(true)).length, 1);
});

test('F172 AC-5 SPEC §8.11 (d) describes core step time and drops the F170 sentence', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  assert.match(spec, /F172/);
  assert.match(spec, /코어 단계 줄\(role `core`/);
  assert.ok(!spec.includes('통과 기능당 시간은 비용이 기록된 역할 단계(build·eval 등) 줄의 시간 합이다'));
});
