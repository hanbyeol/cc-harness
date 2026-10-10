// Step metrics (SPEC §8.11): one JSON line per finished step in .harness/runs/*.metrics.jsonl,
// and the aggregation behind `harness stats`. A line carries only METRIC_FIELDS — never a
// prompt, diff, adapter output or environment value (F27 SC-1).
import fs from 'node:fs';
import path from 'node:path';
import { redactDeep } from './failures.mjs';
import { usageOf } from './usage.mjs';
import { finite, median } from './util.mjs';

export const METRIC_FIELDS = Object.freeze(['feature', 'round', 'step', 'started_at', 'ended_at', 'duration_ms',
  'queue_ms', 'cost_usd', 'role', 'adapter', 'model', 'served_model', 'effort', 'outcome', 'cached', 'turns', 'tokens', 'session_id']);
// Fields the metrics are grouped by: never redacted.
const METRIC_KEEP = new Set(['feature', 'step', 'started_at', 'ended_at']);
export const METRIC_SUFFIX = '.metrics.jsonl';
export const EVAL_METRICS = `eval${METRIC_SUFFIX}`;
export const STEP_ORDER = Object.freeze(['build', 'verify', 'eval', 'pre_merge_verify', 'merge', 'post_merge_verify', 'conflict_resolve', 'post_merge_recovery']);

const str = (v) => (typeof v === 'string' && v ? v : null);

/** A metrics line with exactly METRIC_FIELDS; unknown input keys are dropped. */
export function metricLine({ feature, round, step, startedAt, endedAt, queueMs, costUsd, role, adapter, model, servedModel, effort, outcome, cached, usage }) {
  const u = usageOf(usage);
  const start = new Date(startedAt);
  const end = new Date(endedAt);
  return {
    feature: str(feature),
    round: Number.isInteger(round) ? round : null,
    step: str(step),
    started_at: start.toISOString(),
    ended_at: end.toISOString(),
    duration_ms: Math.max(0, end.getTime() - start.getTime()),
    // Time a verify step waited for a slot of the run's verify pool; null for other steps.
    queue_ms: Number.isInteger(queueMs) && queueMs >= 0 ? queueMs : null,
    cost_usd: finite(costUsd),
    role: str(role),
    adapter: str(adapter),
    model: str(model),
    served_model: str(servedModel),
    effort: str(effort),
    outcome: str(outcome),
    // Whether a verify step returned a stored result (§6.4); null for other steps.
    cached: typeof cached === 'boolean' ? cached : null,
    turns: u.turns,
    tokens: u.tokens,
    session_id: u.session_id,
  };
}

/** Appends one line to `file` (creating its directory), its strings passed through `redact` (SR-8). */
export function appendMetric(file, fields, redact = null) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = metricLine(fields);
  fs.appendFileSync(file, `${JSON.stringify(redact ? redactDeep(line, redact, METRIC_KEEP, { keys: false }) : line)}\n`);
}

/**
 * Reads one metrics file (missing = empty). A line that is not a JSON object is skipped with
 * a warning naming the file and line number (F27 ES-1).
 * @returns {{rows:object[], warnings:string[]}}
 */
export function readMetricsFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { rows: [], warnings: [] };
    throw e;
  }
  const name = path.basename(file);
  const rows = [];
  const warnings = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let v;
    try { v = JSON.parse(line); } catch { v = undefined; }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      warnings.push(`${name}:${i + 1}: not a JSON object — line skipped`);
      return;
    }
    rows.push(v);
  });
  return { rows, warnings };
}

/** Reads every *.metrics.jsonl in `dir`. @returns {{files:string[], rows:object[], warnings:string[]}} */
export function readMetrics(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((n) => n.endsWith(METRIC_SUFFIX)).sort();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const rows = [];
  const warnings = [];
  for (const name of files) {
    const r = readMetricsFile(path.join(dir, name));
    rows.push(...r.rows);
    warnings.push(...r.warnings);
  }
  return { files, rows, warnings };
}

// ------------------------------------------------------------------ aggregation (pure)

const round2 = (n) => Math.round(n * 100) / 100;
const round6 = (n) => Math.round(n * 1e6) / 1e6;

/** 90th percentile by nearest rank: the ceil(0.9·n)-th smallest value. */
export function p90(values) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.max(0, Math.ceil(0.9 * s.length) - 1)];
}

const ms = (r) => finite(r.duration_ms) ?? 0;
const cost = (r) => finite(r.cost_usd) ?? 0;
const queue = (r) => finite(r.queue_ms) ?? 0;
const time = (r) => Date.parse(r.ended_at);

/** Rows whose ended_at is on or after `since` (YYYY-MM-DD, UTC). */
export function sinceFilter(rows, since) {
  if (!since) return rows;
  const t = Date.parse(`${since}T00:00:00.000Z`);
  return rows.filter((r) => time(r) >= t);
}

/**
 * `harness stats` aggregation.
 * @param {object[]} rows metrics lines
 * @param {{stepTimeoutSec:number, standardFeature:boolean}} ctx config.budget.step_timeout_sec and
 *   whether features.json has a standard-tier feature (rule c)
 */
export function computeStats(rows, { stepTimeoutSec = 1800, standardFeature = false } = {}) {
  const steps = [];
  const names = [...new Set(rows.map((r) => r.step).filter((s) => typeof s === 'string'))]
    .sort((a, b) => (STEP_ORDER.indexOf(a) + 1 || 99) - (STEP_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  for (const step of names) {
    const list = rows.filter((r) => r.step === step);
    const total = list.reduce((a, r) => a + cost(r), 0);
    steps.push({
      step, count: list.length,
      median_ms: median(list.map(ms)), p90_ms: p90(list.map(ms)),
      cost_total_usd: round6(total), cost_avg_usd: round6(total / list.length),
    });
  }

  // Grouped by role, model and effort; a line written before effort existed counts as null.
  const pairs = new Map();
  for (const r of rows) {
    const effort = str(r.effort);
    const key = `${r.role ?? '-'}\u0000${r.model ?? '-'}\u0000${effort ?? '-'}`;
    const p = pairs.get(key) ?? { role: r.role ?? null, model: r.model ?? null, effort, count: 0, cost_usd: 0 };
    p.count += 1;
    p.cost_usd = round6(p.cost_usd + cost(r));
    pairs.set(key, p);
  }
  const costByRoleModel = [...pairs.values()].sort((a, b) => b.cost_usd - a.cost_usd
    || String(a.role).localeCompare(String(b.role)) || String(a.model).localeCompare(String(b.model))
    || String(a.effort).localeCompare(String(b.effort)));

  // Features with an evaluated round (an eval line whose outcome is a verdict).
  const verdicts = rows.filter((r) => r.step === 'eval' && (r.outcome === 'pass' || r.outcome === 'fail')
    && typeof r.feature === 'string' && Number.isInteger(r.round));
  const byFeature = new Map();
  for (const r of verdicts) {
    const f = byFeature.get(r.feature) ?? { feature: r.feature, rounds: 0, first_round_pass: false };
    f.rounds = Math.max(f.rounds, r.round);
    if (r.round === 1 && r.outcome === 'pass') f.first_round_pass = true;
    byFeature.set(r.feature, f);
  }
  const feats = [...byFeature.values()].sort((a, b) => a.feature.localeCompare(b.feature, undefined, { numeric: true }));
  const features = {
    count: feats.length,
    first_round_pass_rate: feats.length ? round2(feats.filter((f) => f.first_round_pass).length / feats.length) : null,
    avg_rounds: feats.length ? round2(feats.reduce((a, f) => a + f.rounds, 0) / feats.length) : null,
    list: feats,
  };

  // Time spent waiting for a verify pool slot, per step. A line without queue_ms (written
  // before it existed, or not a verify step) counts as 0.
  const queueMs = Object.fromEntries(names.map((step) => [step, rows.filter((r) => r.step === step).reduce((a, r) => a + queue(r), 0)]));

  const totalCost = rows.reduce((a, r) => a + cost(r), 0);
  return {
    lines: rows.length,
    total_cost_usd: round6(totalCost),
    total_duration_ms: rows.reduce((a, r) => a + ms(r), 0),
    steps, queue_ms: queueMs, cost_by_role_model: costByRoleModel, features,
    suggestions: suggest(rows, { stepTimeoutSec, standardFeature }),
  };
}

export const SUGGEST = Object.freeze({ LATEST: 10, NEAR_TIMEOUT: 0.9, NEAR_TIMEOUT_MIN: 2, VERIFY_SHARE: 0.3, BUILDER_SHARE: 0.7, MIN_BUILDS: 5 });

// Model price order by a word in the name, cheapest first; a model with none of them is not ranked.
const PRICE_WORDS = Object.freeze(['haiku', 'sonnet', 'opus']);
const priceRank = (model) => PRICE_WORDS.findIndex((w) => model.toLowerCase().includes(w));
const TIMEOUT_OUTCOMES = new Set(['timeout', 'timeout-continued']);
const pct = (rate) => `${Math.round(rate * 100)}%`;

// A cheaper builder model with at least MIN_BUILDS build lines whose build timeout rate is at
// most that of the current builder model (the model of the latest build line), or null. Lines
// without a string model or outcome are left out.
function cheaperBuilder(rows) {
  const builds = rows.filter((r) => r.step === 'build' && typeof r.model === 'string' && typeof r.outcome === 'string');
  if (!builds.length) return null;
  const current = builds.reduce((a, r) => ((time(r) || 0) >= (time(a) || 0) ? r : a)).model;
  const stats = new Map();
  for (const r of builds) {
    const s = stats.get(r.model) ?? { model: r.model, count: 0, timeouts: 0 };
    s.count += 1;
    if (TIMEOUT_OUTCOMES.has(r.outcome)) s.timeouts += 1;
    stats.set(r.model, s);
  }
  const rate = (s) => s.timeouts / s.count;
  const cur = stats.get(current);
  const curRank = priceRank(current);
  if (curRank < 0) return null;
  const pick = [...stats.values()]
    .filter((s) => { const k = priceRank(s.model); return k >= 0 && k < curRank && s.count >= SUGGEST.MIN_BUILDS && rate(s) <= rate(cur); })
    .sort((a, b) => priceRank(a.model) - priceRank(b.model) || rate(a) - rate(b) || a.model.localeCompare(b.model))[0];
  return pick ? { model: pick.model, timeout_rate: round2(rate(pick)), current_model: current, current_timeout_rate: round2(rate(cur)) } : null;
}

/** Rule-based suggestions (SPEC §8.11). Never applied automatically. */
export function suggest(rows, { stepTimeoutSec = 1800, standardFeature = false } = {}) {
  const out = [];
  // (a) steps close to the step timeout among the latest ones
  const latest = [...rows].sort((a, b) => (time(a) || 0) - (time(b) || 0)).slice(-SUGGEST.LATEST);
  const limitMs = stepTimeoutSec * 1000;
  const near = latest.filter((r) => ms(r) >= SUGGEST.NEAR_TIMEOUT * limitMs);
  if (near.length >= SUGGEST.NEAR_TIMEOUT_MIN) {
    out.push({
      rule: 'step_timeout',
      message: `${near.length} of the latest ${latest.length} steps took at least 90% of budget.step_timeout_sec (${stepTimeoutSec}s) — consider raising budget.step_timeout_sec`,
    });
  }
  // (b) verification dominates the time
  const totalMs = rows.reduce((a, r) => a + ms(r), 0);
  const verifyMs = rows.filter((r) => r.step === 'verify' || r.step === 'post_merge_verify').reduce((a, r) => a + ms(r), 0);
  if (totalMs > 0 && verifyMs / totalMs > SUGGEST.VERIFY_SHARE) {
    out.push({
      rule: 'verify.check_parallel',
      message: `verify and post_merge_verify take ${Math.round((100 * verifyMs) / totalMs)}% of step time (over 30%) — consider raising verify.check_parallel`,
    });
  }
  // (c) the builder dominates the cost and a cheaper model timed out no more often
  const totalCost = rows.reduce((a, r) => a + cost(r), 0);
  const builderCost = rows.filter((r) => r.role === 'builder').reduce((a, r) => a + cost(r), 0);
  const cheaper = totalCost > 0 && builderCost / totalCost > SUGGEST.BUILDER_SHARE && standardFeature ? cheaperBuilder(rows) : null;
  if (cheaper) {
    out.push({
      rule: 'builder_model',
      message: `builder is ${Math.round((100 * builderCost) / totalCost)}% of the cost (over 70%) — consider builder model ${cheaper.model} for standard-tier features: its build timeout rate is ${pct(cheaper.timeout_rate)}, ${cheaper.current_model} ${pct(cheaper.current_timeout_rate)}`,
      ...cheaper,
    });
  }
  return out;
}

// ------------------------------------------------------------------ text

const sec = (v) => (v === null ? '-' : `${(v / 1000).toFixed(1)}s`);
const usd = (v) => `$${(v ?? 0).toFixed(2)}`;

export function renderStats(s, { since } = {}) {
  const lines = [`metrics: ${s.lines} steps${since ? ` since ${since}` : ''}, total cost ${usd(s.total_cost_usd)}, total time ${sec(s.total_duration_ms)}`, '',
    'steps:', `  ${'step'.padEnd(18)} ${'count'.padStart(5)} ${'median'.padStart(9)} ${'p90'.padStart(9)} ${'cost'.padStart(9)} ${'avg cost'.padStart(9)} ${'queue'.padStart(9)}`];
  for (const x of s.steps) {
    lines.push(`  ${x.step.padEnd(18)} ${String(x.count).padStart(5)} ${sec(x.median_ms).padStart(9)} ${sec(x.p90_ms).padStart(9)} ${usd(x.cost_total_usd).padStart(9)} ${usd(x.cost_avg_usd).padStart(9)} ${sec(s.queue_ms?.[x.step] ?? 0).padStart(9)}`);
  }
  lines.push('', 'cost by role, model and effort:');
  for (const x of s.cost_by_role_model) lines.push(`  ${(x.role ?? '-').padEnd(18)} ${(x.model ?? '-').padEnd(24)} ${(x.effort ?? '-').padEnd(6)} ${usd(x.cost_usd).padStart(9)} (${x.count} steps)`);
  const f = s.features;
  lines.push('', `features: ${f.count} evaluated, first-round pass rate ${f.first_round_pass_rate === null ? '-' : `${Math.round(f.first_round_pass_rate * 100)}%`}, average rounds ${f.avg_rounds ?? '-'}`);
  lines.push('', 'suggestions:');
  if (!s.suggestions.length) lines.push('  (none)');
  for (const x of s.suggestions) lines.push(`  - [${x.rule}] ${x.message}`);
  return lines.join('\n');
}
