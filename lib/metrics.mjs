// Step metrics (SPEC §8.11): one JSON line per finished step in .harness/runs/*.metrics.jsonl,
// and the aggregation behind `harness stats`. A line carries only METRIC_FIELDS — never a
// prompt, diff, adapter output or environment value (F27 SC-1).
import fs from 'node:fs';
import path from 'node:path';

export const METRIC_FIELDS = Object.freeze(['feature', 'round', 'step', 'started_at', 'ended_at', 'duration_ms',
  'cost_usd', 'role', 'adapter', 'model', 'outcome']);
export const METRIC_SUFFIX = '.metrics.jsonl';
export const EVAL_METRICS = `eval${METRIC_SUFFIX}`;
export const STEP_ORDER = Object.freeze(['build', 'verify', 'eval', 'merge', 'post_merge_verify', 'conflict_resolve']);

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v ? v : null);

/** A metrics line with exactly METRIC_FIELDS; unknown input keys are dropped. */
export function metricLine({ feature, round, step, startedAt, endedAt, costUsd, role, adapter, model, outcome }) {
  const start = new Date(startedAt);
  const end = new Date(endedAt);
  return {
    feature: str(feature),
    round: Number.isInteger(round) ? round : null,
    step: str(step),
    started_at: start.toISOString(),
    ended_at: end.toISOString(),
    duration_ms: Math.max(0, end.getTime() - start.getTime()),
    cost_usd: finite(costUsd),
    role: str(role),
    adapter: str(adapter),
    model: str(model),
    outcome: str(outcome),
  };
}

/** Appends one line to `file` (creating its directory). */
export function appendMetric(file, fields) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(metricLine(fields))}\n`);
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

/** Median of numbers: the middle value, or the mean of the two middle values. */
export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 90th percentile by nearest rank: the ceil(0.9·n)-th smallest value. */
export function p90(values) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.max(0, Math.ceil(0.9 * s.length) - 1)];
}

const ms = (r) => finite(r.duration_ms) ?? 0;
const cost = (r) => finite(r.cost_usd) ?? 0;
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

  const pairs = new Map();
  for (const r of rows) {
    const key = `${r.role ?? '-'}\u0000${r.model ?? '-'}`;
    const p = pairs.get(key) ?? { role: r.role ?? null, model: r.model ?? null, count: 0, cost_usd: 0 };
    p.count += 1;
    p.cost_usd = round6(p.cost_usd + cost(r));
    pairs.set(key, p);
  }
  const costByRoleModel = [...pairs.values()].sort((a, b) => b.cost_usd - a.cost_usd
    || String(a.role).localeCompare(String(b.role)) || String(a.model).localeCompare(String(b.model)));

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

  const totalCost = rows.reduce((a, r) => a + cost(r), 0);
  return {
    lines: rows.length,
    total_cost_usd: round6(totalCost),
    total_duration_ms: rows.reduce((a, r) => a + ms(r), 0),
    steps, cost_by_role_model: costByRoleModel, features,
    suggestions: suggest(rows, { stepTimeoutSec, standardFeature }),
  };
}

export const SUGGEST = Object.freeze({ LATEST: 10, NEAR_TIMEOUT: 0.9, NEAR_TIMEOUT_MIN: 2, VERIFY_SHARE: 0.3, BUILDER_SHARE: 0.7 });

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
  // (c) the builder dominates the cost
  const totalCost = rows.reduce((a, r) => a + cost(r), 0);
  const builderCost = rows.filter((r) => r.role === 'builder').reduce((a, r) => a + cost(r), 0);
  if (totalCost > 0 && builderCost / totalCost > SUGGEST.BUILDER_SHARE && standardFeature) {
    out.push({
      rule: 'builder_model',
      message: `builder is ${Math.round((100 * builderCost) / totalCost)}% of the cost (over 70%) — consider a cheaper builder model for standard-tier features`,
    });
  }
  return out;
}

// ------------------------------------------------------------------ text

const sec = (v) => (v === null ? '-' : `${(v / 1000).toFixed(1)}s`);
const usd = (v) => `$${(v ?? 0).toFixed(2)}`;

export function renderStats(s, { since } = {}) {
  const lines = [`metrics: ${s.lines} steps${since ? ` since ${since}` : ''}, total cost ${usd(s.total_cost_usd)}, total time ${sec(s.total_duration_ms)}`, '',
    'steps:', `  ${'step'.padEnd(18)} ${'count'.padStart(5)} ${'median'.padStart(9)} ${'p90'.padStart(9)} ${'cost'.padStart(9)} ${'avg cost'.padStart(9)}`];
  for (const x of s.steps) {
    lines.push(`  ${x.step.padEnd(18)} ${String(x.count).padStart(5)} ${sec(x.median_ms).padStart(9)} ${sec(x.p90_ms).padStart(9)} ${usd(x.cost_total_usd).padStart(9)} ${usd(x.cost_avg_usd).padStart(9)}`);
  }
  lines.push('', 'cost by role and model:');
  for (const x of s.cost_by_role_model) lines.push(`  ${(x.role ?? '-').padEnd(18)} ${(x.model ?? '-').padEnd(24)} ${usd(x.cost_usd).padStart(9)} (${x.count} steps)`);
  const f = s.features;
  lines.push('', `features: ${f.count} evaluated, first-round pass rate ${f.first_round_pass_rate === null ? '-' : `${Math.round(f.first_round_pass_rate * 100)}%`}, average rounds ${f.avg_rounds ?? '-'}`);
  lines.push('', 'suggestions:');
  if (!s.suggestions.length) lines.push('  (none)');
  for (const x of s.suggestions) lines.push(`  - [${x.rule}] ${x.message}`);
  return lines.join('\n');
}
