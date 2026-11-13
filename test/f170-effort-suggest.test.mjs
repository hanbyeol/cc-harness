// F170: `harness stats` suggests a per-tier effort (roles.<role>.effort_by_tier.<tier>) that is
// no worse in cost and time per passed feature (builder) or per review (evaluator) and better in
// one, without a lower first-round pass rate (builder) or fail-verdict rate (evaluator).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, harness, project, readJson, writeJson } from './helpers.mjs';
import { computeStats } from '../lib/metrics.mjs';

// ------------------------------------------------------------------ fixtures

let n = 0;
const at = () => new Date(Date.UTC(2026, 10, 1) + (n += 1) * 60_000).toISOString();
const line = (o) => ({ feature: 'F0', round: 1, step: 'build', started_at: at(), ended_at: at(), duration_ms: 1000, cost_usd: 0,
  role: 'builder', adapter: 'claude', model: 'sonnet', effort: null, outcome: 'ok', ...o });

// One feature's lines: a round 1 build with `effort` costing `cost` and taking `ms`, an eval
// line (verdict `verdict`). Extra rounds may be added by the caller.
function feature(id, { effort = 'high', model = 'sonnet', cost = 2, ms = 90_000, verdict = 'pass', evalEffort = null, evalModel = 'opus', evalCost = 0, evalMs = 0 } = {}) {
  return [
    line({ feature: id, step: 'build', effort, model, cost_usd: cost, duration_ms: ms }),
    line({ feature: id, step: 'eval', role: 'evaluator', model: evalModel, effort: evalEffort, outcome: verdict, cost_usd: evalCost, duration_ms: evalMs }),
  ];
}

// `count` features named <prefix>1.. with the same options.
const group = (prefix, count, opts) => Array.from({ length: count }, (_, i) => feature(`${prefix}${i + 1}`, opts)).flat();
const tiersOf = (rows, tier = 'standard') => new Map([...new Set(rows.map((r) => r.feature))].map((id) => [id, tier]));
const CURRENT = (effort = 'high', evaluatorEffort = 'high') => ({
  builder: { standard: { model: 'sonnet', effort }, critical: { model: 'sonnet', effort } },
  evaluator: { standard: { model: 'opus', effort: evaluatorEffort }, critical: { model: 'opus', effort: evaluatorEffort } },
});
const effortSuggestions = (rows, { tiers = tiersOf(rows), current = CURRENT() } = {}) =>
  computeStats(rows, { tiers, current }).suggestions.filter((s) => s.rule === 'effort');

// ------------------------------------------------------------------ AC-1

test('F170 AC-1 a builder effort no worse in cost and time per passed feature, better in one, with a pass rate not lower is suggested', () => {
  const rows = [...group('H', 5, { effort: 'high', cost: 2, ms: 90_000 }), ...group('M', 5, { effort: 'medium', cost: 1, ms: 60_000 })];
  const s = effortSuggestions(rows);
  assert.equal(s.length, 1, JSON.stringify(s));
  assert.equal(s[0].role, 'builder');
  assert.equal(s[0].tier, 'standard');
  assert.equal(s[0].effort, 'medium');
  assert.equal(s[0].current_effort, 'high');
  // Equal cost but faster is enough too.
  const faster = [...group('H', 5, { effort: 'high', cost: 1, ms: 90_000 }), ...group('M', 5, { effort: 'medium', cost: 1, ms: 60_000 })];
  assert.equal(effortSuggestions(faster)[0]?.effort, 'medium');
});

// Round 2 finding: rates rounded to 2 decimals made 22/31 (0.7097) look equal to 5/7 (0.714).
// `firstPass` of the `count` features pass in round 1; the rest fail it and pass in round 2.
function passGroup(prefix, count, firstPass, opts) {
  return Array.from({ length: count }, (_, i) => {
    const id = `${prefix}${i + 1}`;
    const rows = feature(id, { ...opts, verdict: i < firstPass ? 'pass' : 'fail' });
    if (i >= firstPass) rows.push(line({ feature: id, round: 2, step: 'eval', role: 'evaluator', model: 'opus', outcome: 'pass' }));
    return rows;
  }).flat();
}

test('F170 AC-1 the first-round pass rate is compared unrounded: 22/31 is lower than 5/7', () => {
  const rows = [...passGroup('H', 7, 5, { effort: 'high', cost: 2, ms: 90_000 }), ...passGroup('M', 31, 22, { effort: 'medium', cost: 1, ms: 60_000 })];
  assert.deepEqual(effortSuggestions(rows).filter((x) => x.role === 'builder'), []);
  // At an equal rate (5/7 vs 15/21) it is suggested.
  const equal = [...passGroup('H', 7, 5, { effort: 'high', cost: 2, ms: 90_000 }), ...passGroup('M', 21, 15, { effort: 'medium', cost: 1, ms: 60_000 })];
  assert.equal(effortSuggestions(equal).find((x) => x.role === 'builder')?.effort, 'medium');
});

test('F170 AC-1 cost is compared unrounded: a group dearer by less than the shown precision is not cheaper', () => {
  // medium costs $1.0000001 per passed feature, high $1 — equal after rounding to 6 decimals —
  // and medium is faster: it is not "no worse in cost", so it is not suggested.
  const rows = [...group('H', 5, { effort: 'high', cost: 1, ms: 90_000 }), ...group('M', 5, { effort: 'medium', cost: 1.0000001, ms: 60_000 })];
  assert.deepEqual(effortSuggestions(rows).filter((x) => x.role === 'builder'), []);
});

// ------------------------------------------------------------------ AC-2

test('F170 AC-2 no builder suggestion when slower, more expensive, a lower pass rate, under 5 features, or the current effort', () => {
  const H = (o = {}) => group('H', 5, { effort: 'high', cost: 2, ms: 90_000, ...o });
  // Control: the same groups with medium cheaper and faster do give a suggestion.
  assert.equal(effortSuggestions([...H(), ...group('M', 5, { effort: 'medium', cost: 1, ms: 60_000 })]).length, 1, 'control');
  const cases = {
    'cheaper but slower': [...H(), ...group('M', 5, { effort: 'medium', cost: 1, ms: 120_000 })],
    'faster but more expensive': [...H(), ...group('M', 5, { effort: 'medium', cost: 3, ms: 60_000 })],
    'lower first-round pass rate': [...H(), ...group('M', 4, { effort: 'medium', cost: 1, ms: 60_000 }),
      ...feature('M5', { effort: 'medium', cost: 1, ms: 60_000, verdict: 'fail' }),
      line({ feature: 'M5', round: 2, step: 'eval', role: 'evaluator', model: 'opus', outcome: 'pass' })],
    'under 5 candidate features': [...H(), ...group('M', 4, { effort: 'medium', cost: 1, ms: 60_000 })],
    'under 5 current features': [...group('H', 4, { effort: 'high', cost: 2, ms: 90_000 }), ...group('M', 5, { effort: 'medium', cost: 1, ms: 60_000 })],
    'only the current effort': [...H(), ...group('X', 5, { effort: 'high', cost: 1, ms: 60_000 })],
  };
  for (const [what, rows] of Object.entries(cases)) assert.deepEqual(effortSuggestions(rows), [], what);
});

// ------------------------------------------------------------------ AC-3

test('F170 AC-3 the cost of features that did not pass counts in the cost per passed feature', () => {
  // medium: 5 passed at $1 plus 3 failed at $4 → $17 / 5 = $3.40 per passed feature, above high's $2.
  const rows = [...group('H', 5, { effort: 'high', cost: 2, ms: 90_000 }),
    ...group('M', 5, { effort: 'medium', cost: 1, ms: 10_000 }),
    ...group('B', 3, { effort: 'medium', cost: 4, ms: 1_000, verdict: 'fail' })];
  assert.deepEqual(effortSuggestions(rows), []);
  // Without the failed ones it would have been suggested.
  assert.equal(effortSuggestions(rows.filter((r) => !r.feature.startsWith('B')))[0]?.effort, 'medium');
});

// ------------------------------------------------------------------ AC-4

test('F170 AC-4 tier from features.json, effort and model from round 1 build lines; mixed, missing or other-model features are left out', () => {
  const base = [...group('H', 5, { effort: 'high', cost: 2, ms: 90_000 }), ...group('M', 5, { effort: 'medium', cost: 1, ms: 60_000 })];
  // A critical tier for every feature: the suggestion is for the critical key.
  const crit = effortSuggestions(base, { tiers: tiersOf(base, 'critical') });
  assert.equal(crit[0]?.tier, 'critical');
  // One medium feature with a second round 1 build at high: mixed, left out → 4 medium features.
  const mixed = [...base, line({ feature: 'M1', step: 'build', effort: 'high', cost_usd: 0 })];
  assert.deepEqual(effortSuggestions(mixed), [], 'mixed efforts');
  // A medium feature whose round 1 build used another model is left out → 4.
  const other = base.map((r) => (r.feature === 'M2' && r.step === 'build' ? { ...r, model: 'haiku' } : r));
  assert.deepEqual(effortSuggestions(other), [], 'other model');
  // A medium feature without a round 1 build line is left out → 4.
  const nobuild = base.filter((r) => !(r.feature === 'M3' && r.step === 'build'));
  assert.deepEqual(effortSuggestions(nobuild), [], 'no round 1 build');
  // Lines without effort form the 'not set' group, compared like any other.
  const notSet = [...group('H', 5, { effort: 'high', cost: 2, ms: 90_000 }), ...group('N', 5, { effort: null, cost: 1, ms: 60_000 })];
  assert.equal(effortSuggestions(notSet)[0]?.effort, 'not set');
  const fromNotSet = [...group('N', 5, { effort: null, cost: 2, ms: 90_000 }), ...group('M', 5, { effort: 'medium', cost: 1, ms: 60_000 })];
  assert.equal(effortSuggestions(fromNotSet, { current: CURRENT(null) })[0]?.current_effort, 'not set');
});

// ------------------------------------------------------------------ AC-5

test('F170 AC-5 an evaluator effort cheaper and not slower per review is suggested only when its fail-verdict rate is not lower', () => {
  // Builders are all at the current effort (no builder suggestion); reviews differ by effort.
  const reviews = (prefix, count, effort, opts = {}) => group(prefix, count, { effort: 'high', evalEffort: effort, evalCost: 0.5, evalMs: 30_000, ...opts });
  const same = [...reviews('A', 4, 'high'), ...reviews('A5', 1, 'high', { verdict: 'fail' }),
    ...reviews('B', 4, 'medium', { evalCost: 0.2, evalMs: 20_000 }), ...reviews('B5', 1, 'medium', { evalCost: 0.2, evalMs: 20_000, verdict: 'fail' })];
  const s = effortSuggestions(same);
  assert.deepEqual(s.map((x) => [x.role, x.tier, x.effort, x.current_effort]), [['evaluator', 'standard', 'medium', 'high']]);
  const lower = [...reviews('A', 4, 'high'), ...reviews('A5', 1, 'high', { verdict: 'fail' }),
    ...reviews('B', 5, 'medium', { evalCost: 0.2, evalMs: 20_000 })];
  assert.deepEqual(effortSuggestions(lower).filter((x) => x.role === 'evaluator'), [], 'fail rate dropped from 20% to 0%');
});

test('F170 AC-5 the fail-verdict rate is compared unrounded: 22/31 is lower than 5/7', () => {
  // Reviews only (each feature's build at the current effort): current high fails 5 of 7,
  // medium fails 22 of 31 — 0.7097 < 0.714, a weaker gate even though both round to 0.71.
  const reviews = (prefix, count, fails, effort, cost, ms) => Array.from({ length: count }, (_, i) =>
    feature(`${prefix}${i + 1}`, { effort: 'high', evalEffort: effort, evalCost: cost, evalMs: ms, verdict: i < fails ? 'fail' : 'pass' })).flat();
  const rows = [...reviews('A', 7, 5, 'high', 0.5, 30_000), ...reviews('B', 31, 22, 'medium', 0.2, 20_000)];
  assert.deepEqual(effortSuggestions(rows).filter((x) => x.role === 'evaluator'), []);
  // At an equal fail rate (5/7 vs 15/21) it is suggested.
  const equal = [...reviews('A', 7, 5, 'high', 0.5, 30_000), ...reviews('B', 21, 15, 'medium', 0.2, 20_000)];
  assert.equal(effortSuggestions(equal).find((x) => x.role === 'evaluator')?.effort, 'medium');
});

// ------------------------------------------------------------------ AC-6

test('F170 AC-6 no effort suggestion for critical-tier reviews or the security-reviewer', () => {
  const reviews = (prefix, effort, cost, ms) => group(prefix, 5, { effort: 'high', evalEffort: effort, evalCost: cost, evalMs: ms });
  const rows = [...reviews('A', 'high', 0.5, 30_000), ...reviews('B', 'medium', 0.2, 20_000)];
  // Control: on the standard tier the evaluator suggestion is made.
  assert.deepEqual(effortSuggestions(rows).filter((x) => x.role === 'evaluator').map((x) => x.effort), ['medium'], 'control');
  assert.deepEqual(effortSuggestions(rows, { tiers: tiersOf(rows, 'critical') }).filter((x) => x.role !== 'builder'), []);
  const sr = rows.map((r) => (r.step === 'eval' ? { ...r, role: 'security-reviewer' } : r));
  assert.deepEqual(effortSuggestions(sr).filter((x) => x.role !== 'builder'), []);
});

// ------------------------------------------------------------------ AC-7

// features.json holds the features of `rows` with a string id, except those in `unknown`.
function statsProject(rows, roles, { unknown = [] } = {}) {
  const ids = [...new Set(rows.map((r) => r.feature))].filter((id) => typeof id === 'string' && id && !unknown.includes(id));
  const dir = project(ids.map((id) => ({ id, title: id, security_tier: 'standard', depends_on: [], status: 'passed' })));
  const cfgFile = path.join(dir, '.harness', 'config.json');
  writeJson(cfgFile, { ...readJson(cfgFile), roles });
  fs.mkdirSync(path.join(dir, '.harness', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.harness', 'runs', '2026-11-01T00-00-00-000Z.metrics.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { dir, cfgFile };
}
const ROLES = { builder: { adapter: 'claude', model: 'sonnet', effort_by_tier: { standard: 'high' } }, evaluator: { adapter: 'claude', model: 'opus' } };

test('F170 AC-7 harness stats prints the suggestion with the config key and both groups; --json has the fields; config.json is unchanged', () => {
  const rows = [...group('H', 5, { effort: 'high', cost: 2, ms: 90_000 }), ...group('M', 5, { effort: 'medium', cost: 1, ms: 60_000 })];
  const { dir, cfgFile } = statsProject(rows, ROLES);
  const before = fs.readFileSync(cfgFile, 'utf8');
  const text = harness(['stats'], { cwd: dir });
  assert.equal(text.code, 0, text.stderr);
  const lineOf = text.stdout.split('\n').find((l) => l.includes('[effort]'));
  assert.ok(lineOf, text.stdout);
  for (const part of ['roles.builder.effort_by_tier.standard', 'medium', 'high', '$1.00', '$2.00', '60.0s', '90.0s']) assert.ok(lineOf.includes(part), `${part}: ${lineOf}`);
  const json = harness(['stats', '--json'], { cwd: dir });
  const s = JSON.parse(json.stdout).suggestions.find((x) => x.rule === 'effort');
  for (const k of ['role', 'tier', 'effort', 'current_effort', 'count', 'current_count', 'cost_usd', 'current_cost_usd', 'duration_ms', 'current_duration_ms', 'rate', 'current_rate']) {
    assert.ok(Object.hasOwn(s, k), `json has ${k}: ${JSON.stringify(s)}`);
  }
  assert.deepEqual([s.count, s.current_count, s.cost_usd, s.current_cost_usd, s.duration_ms, s.current_duration_ms, s.rate, s.current_rate], [5, 5, 1, 2, 60_000, 90_000, 1, 1]);
  assert.equal(fs.readFileSync(cfgFile, 'utf8'), before, 'config.json unchanged');
});

// ------------------------------------------------------------------ AC-8

test('F170 AC-8 SPEC §8.11 describes the effort suggestion rule', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const start = spec.indexOf('**실행 지표와 `harness stats`** (§8.11)');
  assert.ok(start !== -1, '§8.11');
  const s811 = spec.slice(start, spec.indexOf('\n## ', start));
  const lines = s811.split('\n').filter((l) => l.includes('F170'));
  assert.ok(lines.length > 0, '§8.11 mentions F170');
  const t = lines.join(' ');
  for (const word of ['effort_by_tier', '통과', '1라운드 통과율', 'fail', '5', 'security-reviewer', 'critical', '자동']) assert.ok(t.includes(word), `names ${word}`);
});

// ------------------------------------------------------------------ ES-2

test('F170 ES-2 lines of unknown features or with missing numbers are left out without an error', () => {
  const good = [...group('H', 5, { effort: 'high', cost: 2, ms: 90_000 }), ...group('M', 5, { effort: 'medium', cost: 1, ms: 60_000 })];
  const bad = [
    line({ feature: 'ZZ', step: 'build', effort: 'low', cost_usd: 0.01, duration_ms: 1 }),
    line({ feature: null, step: 'build', effort: 'low' }),
    line({ feature: 'M1', round: 'one', step: 'build', effort: 'low' }),
    line({ feature: 'M2', step: 'eval', role: 'evaluator', duration_ms: 'x', cost_usd: null, outcome: 'pass' }),
  ];
  const tiers = tiersOf(good); // ZZ is not in features.json
  const s = computeStats([...good, ...bad], { tiers, current: CURRENT() }).suggestions.filter((x) => x.rule === 'effort');
  assert.equal(s.length, 1, JSON.stringify(s));
  assert.equal(s[0].effort, 'medium');
  const { dir } = statsProject([...good, ...bad], ROLES, { unknown: ['ZZ'] });
  const r = harness(['stats'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('[effort] builder standard-tier: effort medium'), r.stdout);
});

test('F170 ES-2 a build line without a cost is left out, so its feature has no round 1 build and no $0 group is suggested', () => {
  // Round 1 finding: medium builds with cost_usd null counted as $0 and were suggested.
  const rows = [...group('H', 5, { effort: 'high', cost: 2, ms: 90_000 }),
    ...group('M', 5, { effort: 'medium', ms: 90_000 }).map((r) => (r.step === 'build' ? { ...r, cost_usd: null } : r))];
  assert.deepEqual(effortSuggestions(rows), []);
  // Same for a duration that is not a number.
  const noMs = [...group('H', 5, { effort: 'high', cost: 2, ms: 90_000 }),
    ...group('M', 5, { effort: 'medium', cost: 1 }).map((r) => (r.step === 'build' ? { ...r, duration_ms: 'x' } : r))];
  assert.deepEqual(effortSuggestions(noMs), []);
});

test('F170 ES-2 an evaluator line without a cost is left out of the review groups', () => {
  const reviews = (prefix, count, effort, opts = {}) => group(prefix, count, { effort: 'high', evalEffort: effort, evalCost: 0.5, evalMs: 30_000, ...opts });
  const rows = [...reviews('A', 5, 'high'), ...reviews('B', 5, 'medium', { evalMs: 20_000 })]
    .map((r) => (r.step === 'eval' && r.effort === 'medium' ? { ...r, cost_usd: null } : r));
  assert.deepEqual(effortSuggestions(rows).filter((x) => x.role === 'evaluator'), []);
});
