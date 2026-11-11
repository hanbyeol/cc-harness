// F156: the builder_model suggestion ranks fable above opus (fable > opus > sonnet > haiku).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { suggest } from '../lib/metrics.mjs';

const at = (i) => new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString();
let clock = 0;
const build = (model, outcome = 'ok') => ({ step: 'build', role: 'builder', model, outcome, cost_usd: 0, duration_ms: 1_000, ended_at: at(clock++) });
// `n` builds of `model`, `timeouts` of them timed out.
const builds = (model, n, timeouts) => Array.from({ length: n }, (_, i) => build(model, i < timeouts ? 'timeout' : 'ok'));
// The builder is 90% of the cost; the current model's builds come last.
const costly = (current) => [
  { step: 'eval', role: 'evaluator', cost_usd: 1, duration_ms: 1_000, ended_at: at(clock++) },
  ...current.slice(0, -1), { ...current.at(-1), cost_usd: 9 },
];
const builderSuggestion = (rows) => suggest(rows, { stepTimeoutSec: 1800, standardFeature: true }).find((s) => s.rule === 'builder_model');

test('F156 AC-1: a fable builder gets an opus suggestion', () => {
  const s = builderSuggestion([...builds('claude-opus-5-5', 5, 0), ...costly(builds('claude-fable-5-2', 5, 1))]);
  assert.ok(s, 'a builder_model suggestion');
  assert.equal(s.model, 'claude-opus-5-5');
  assert.equal(s.current_model, 'claude-fable-5-2');
});

test('F156 AC-2: with fable current, the cheapest qualifying model (haiku) is suggested', () => {
  const rows = [
    ...builds('claude-haiku-5-5', 5, 0), ...builds('claude-sonnet-5-5', 5, 0), ...builds('claude-opus-5-5', 5, 0),
    ...costly(builds('claude-fable-5-2', 5, 2)),
  ];
  assert.equal(builderSuggestion(rows)?.model, 'claude-haiku-5-5');
});

test('F156 AC-3: fable is not cheaper than opus', () => {
  const rows = [...builds('claude-fable-5-2', 5, 0), ...costly(builds('claude-opus-5-5', 5, 3))];
  assert.equal(builderSuggestion(rows), undefined);
});

test('F156 AC-4: docs/SPEC.md gives the price order fable > opus > sonnet > haiku', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const para = spec.split('\n').find((l) => l.includes('builder_model'));
  assert.ok(para, 'the builder_model paragraph');
  assert.ok(para.includes('fable > opus > sonnet > haiku'), 'the new order');
  assert.ok(!spec.includes('opus > sonnet > haiku 이고'), 'the old order sentence is gone');
});

test('F156 ES-1: an unranked current model gets no suggestion', () => {
  const rows = [...builds('claude-haiku-5-5', 5, 0), ...costly(builds('gpt-5', 5, 3))];
  assert.equal(builderSuggestion(rows), undefined);
});
