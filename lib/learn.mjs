// `harness learn` (SPEC §2 하네스 자기 개선): reads every project bundle of the field data hub,
// aggregates metrics per harness version, derives improvement candidates from fixed rules with
// their evidence (projects, events, versions), and compares two versions. The candidates only
// suggest: `--propose` records them in the backlog, a human turns one into a contract.
import fs from 'node:fs';
import path from 'node:path';
import { readHubLine } from './telemetry.mjs';
import { readBacklog, writeBacklog, isOpen } from './backlog.mjs';
import { isObj, median } from './util.mjs';

// A candidate is made only on enough evidence: this many projects, or this many events.
export const THRESHOLDS = Object.freeze({ projects: 2, events: 10 });
export const TOP_N = 3;
export const SOURCE = 'field-data';
export const NO_DATA = 'no field data';
export const UNKNOWN_VERSION = 'unknown';

// Metrics compared by --compare, and whether a lower value is the better one.
export const COMPARED = Object.freeze([
  { metric: 'build_duration_ms', lowerIsBetter: true },
  { metric: 'build_turns', lowerIsBetter: true },
  { metric: 'build_cost_usd', lowerIsBetter: true },
  { metric: 'first_round_pass_rate', lowerIsBetter: false },
  { metric: 'blocked_rate', lowerIsBetter: true },
  { metric: 'interventions', lowerIsBetter: true },
  { metric: 'reproduction_rate', lowerIsBetter: false },
]);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v ? v : null);
const round2 = (v) => Math.round(v * 100) / 100;
const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function ranked(counts, key, valueKey = 'count') {
  return [...counts.entries()]
    .sort(([a, x], [b, y]) => y - x || byName(a, b))
    .map(([name, n]) => ({ [key]: name, [valueKey]: n }));
}

// The median with the mean of the two middle values rounded to 2 decimals.
const median2 = (values) => {
  const m = median(values);
  return m === null || values.length % 2 ? m : round2(m);
};

// Versions in release order (x.y.z numerically, a pre-release before its release), unknown last.
function compareVersions(a, b) {
  if (a === b) return 0;
  if (a === UNKNOWN_VERSION) return 1;
  if (b === UNKNOWN_VERSION) return -1;
  const [ca, pa] = a.split('-', 2);
  const [cb, pb] = b.split('-', 2);
  const na = ca.split('.').map(Number);
  const nb = cb.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (na[i] !== nb[i]) return na[i] - nb[i];
  if (pa === undefined) return pb === undefined ? 0 : 1;
  if (pb === undefined) return -1;
  return byName(pa, pb);
}

/**
 * Reads the hub: <hub>/<project>/*.jsonl. The project is the directory name. Lines that are not
 * a JSON object with a valid ts and stage are skipped; keys outside the export allowlist are
 * dropped. One warning per file for each. `since` (YYYY-MM-DD, UTC) keeps lines from that day on.
 * @returns {{lines: object[], warnings: string[]}} lines carry `project` and `version`
 */
export function readHub(hub, { since = null } = {}) {
  const from = since ? Date.parse(`${since}T00:00:00.000Z`) : -Infinity;
  const lines = [];
  const warnings = [];
  let projects = [];
  try {
    projects = fs.readdirSync(hub, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return { lines, warnings };
  }
  for (const project of projects) {
    const dir = path.join(hub, project);
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort(); } catch { continue; }
    for (const name of names) {
      const file = path.join(dir, name);
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
        warnings.push(`${file}: unreadable (${e.code || e.message}) — skipped`);
        continue;
      }
      const ignored = new Set();
      let skipped = 0;
      for (const raw of text.split('\n')) {
        if (!raw.trim()) continue;
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = null; }
        const line = readHubLine(parsed, ignored);
        if (!line) { skipped += 1; continue; }
        if (Date.parse(line.ts) < from) continue;
        lines.push({ ...line, project, version: line.harness_version ?? UNKNOWN_VERSION });
      }
      if (ignored.size) warnings.push(`${file}: ignored keys outside the allowlist: ${[...ignored].join(', ')}`);
      if (skipped) warnings.push(`${file}: ${skipped} line${skipped === 1 ? '' : 's'} skipped (not a JSON object with a valid ts and stage)`);
    }
  }
  return { lines, warnings };
}

// The kinds of events learn reads, by what they say.
const isLint = (l) => l.stage === 'plan' && l.type === 'lint';
const isFinding = (l) => (l.stage === 'eval' || l.stage === 'security') && l.type === 'finding';
const isIntervention = (l) => l.stage === 'feedback' && l.type === 'intervention';
const isCi = (l) => l.stage === 'feedback' && l.type === 'ci';
// A feature finished: its status became passed or blocked.
const isEnd = (l) => l.type === 'status' && (l.data.to === 'passed' || l.data.to === 'blocked');
const lintRules = (l) => [...new Set((Array.isArray(l.data.errors) ? l.data.errors : []).map((x) => (isObj(x) ? str(x.rule) : null)).filter(Boolean))];
const ciTests = (l) => [...new Set((Array.isArray(l.data.tests) ? l.data.tests : []).filter((t) => str(t)))];

/** The metrics of one version's lines. */
export function versionMetrics(version, lines) {
  const ends = lines.filter(isEnd);
  const passed = ends.filter((l) => l.data.to === 'passed');
  const blocked = ends.filter((l) => l.data.to === 'blocked');
  const reasons = new Map();
  for (const l of blocked) bump(reasons, str(l.data.reason) ?? 'unknown');
  const rules = new Map();
  for (const l of lines.filter(isLint)) for (const r of lintRules(l)) bump(rules, r);
  const findings = lines.filter(isFinding);
  const reproduced = findings.filter((l) => l.data.outcome === 'blocking').length;
  const tests = new Map();
  for (const l of lines.filter(isCi)) for (const t of ciTests(l)) bump(tests, t);
  const values = (key) => ends.map((l) => num(l.data[key])).filter((v) => v !== null);
  return {
    version,
    projects: new Set(lines.map((l) => l.project)).size,
    events: lines.length,
    features: ends.length,
    build: { duration_ms: median2(values('build_duration_ms')), turns: median2(values('build_turns')), cost_usd: median2(values('build_cost_usd')) },
    first_round_pass_rate: ends.length ? round2(passed.filter((l) => l.round === 1).length / ends.length) : null,
    blocked_rate: ends.length ? round2(blocked.length / ends.length) : null,
    blocked_reasons: ranked(reasons, 'reason'),
    interventions: lines.filter(isIntervention).length,
    lint_rejections: ranked(rules, 'rule').slice(0, TOP_N),
    reproduction_rate: findings.length ? round2(reproduced / findings.length) : null,
    ci_repeated: ranked(tests, 'test', 'failures').filter((t) => t.failures >= 2).slice(0, TOP_N),
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const priorityOf = (projects) => (projects >= 3 ? 'high' : projects === 2 ? 'medium' : 'low');

// Evidence of a group of lines: how many projects and events, and in which versions.
function evidence(lines) {
  return {
    projects: new Set(lines.map((l) => l.project)).size,
    events: lines.length,
    versions: [...new Set(lines.map((l) => l.version))].sort(compareVersions),
  };
}

const enough = (ev) => ev.projects >= THRESHOLDS.projects || ev.events >= THRESHOLDS.events;

// Lines grouped by a subject, largest group first, then by name.
function groups(lines, subjectsOf) {
  const m = new Map();
  for (const l of lines) for (const s of subjectsOf(l)) { if (!m.has(s)) m.set(s, []); m.get(s).push(l); }
  return [...m.entries()].sort(([a, x], [b, y]) => y.length - x.length || byName(a, b));
}

/**
 * Improvement candidates from the fixed rules, in rule order. Each has its evidence, and only
 * those with evidence from THRESHOLDS.projects projects or THRESHOLDS.events events are kept.
 */
export function candidates(lines) {
  const out = [];
  const add = (rule, subject, group, title) => {
    const ev = evidence(group);
    if (enough(ev)) out.push({ rule, subject, key: `${rule}:${subject}`, priority: priorityOf(ev.projects), title: title(group.length), evidence: ev });
  };
  for (const [rule, group] of groups(lines.filter(isLint), lintRules)) {
    add('lint_rule', rule, group, (n) => `lint rule '${rule}' rejected ${plural(n, 'contract')} — add guidance and an example for it to the spec skill`);
  }
  const findings = lines.filter(isFinding);
  const backlogged = findings.filter((l) => l.data.outcome === 'backlogged');
  for (const [reason, group] of groups(backlogged, (l) => [str(l.data.reason) ?? 'unknown'])) {
    add('backlog_reason', reason, group, (n) => `${plural(n, 'finding')} were backlogged as '${reason}' — tighten the evaluator's guidance for that case`);
  }
  const rate = findings.length ? findings.filter((l) => l.data.outcome === 'blocking').length / findings.length : null;
  if (rate !== null && rate < 0.5) {
    add('low_reproduction', 'findings', findings,
      (n) => `only ${Math.round(rate * 100)}% of ${plural(n, 'finding')} reproduced — ask evaluators for a repro that fails on the current tree`);
  }
  const blocked = lines.filter((l) => isEnd(l) && l.data.to === 'blocked');
  for (const [reason, group] of groups(blocked, (l) => [str(l.data.reason) ?? 'unknown'])) {
    add('blocked_reason', reason, group, (n) => `${plural(n, 'feature')} were blocked with '${reason}' — look at what kept those rounds from converging`);
  }
  for (const [kind, group] of groups(lines.filter(isIntervention), (l) => [str(l.data.kind) ?? 'other'])) {
    add('intervention', kind, group, (n) => `${n} '${kind}' interventions — find the step that needed the human and automate or document it`);
  }
  for (const [test, group] of groups(lines.filter(isCi), ciTests)) {
    if (group.length < 2) continue;
    add('ci_repeated', test, group, (n) => `CI test ${test} failed in ${n} runs — stabilize it (see test/stress.mjs) or fix the platform difference`);
  }
  return out;
}

/** The empty report: what `--json` prints when the hub has no field data. */
export const emptyLearn = (since = null) => ({ since, projects: 0, events: 0, versions: [], candidates: [], message: NO_DATA });

/** The learn report of the hub lines (at least one). */
export function learn(lines, { since = null } = {}) {
  const byVersion = new Map();
  for (const l of lines) { if (!byVersion.has(l.version)) byVersion.set(l.version, []); byVersion.get(l.version).push(l); }
  return {
    since,
    projects: new Set(lines.map((l) => l.project)).size,
    events: lines.length,
    versions: [...byVersion.keys()].sort(compareVersions).map((v) => versionMetrics(v, byVersion.get(v))),
    candidates: candidates(lines),
  };
}

const flat = (m) => ({
  build_duration_ms: m.build.duration_ms, build_turns: m.build.turns, build_cost_usd: m.build.cost_usd,
  first_round_pass_rate: m.first_round_pass_rate, blocked_rate: m.blocked_rate, interventions: m.interventions,
  reproduction_rate: m.reproduction_rate,
});

/** Two versions side by side: each compared metric with its change (v2 − v1) and direction. */
export function compare(lines, v1, v2, { since = null } = {}) {
  const of = (v) => {
    const own = lines.filter((l) => l.version === v);
    return own.length ? flat(versionMetrics(v, own)) : null;
  };
  const a = of(v1);
  const b = of(v2);
  return {
    since, v1, v2,
    metrics: COMPARED.map(({ metric, lowerIsBetter }) => {
      const x = a ? a[metric] : null;
      const y = b ? b[metric] : null;
      if (x === null || y === null) return { metric, v1: x, v2: y, delta: null, direction: 'n/a' };
      const delta = round2(y - x);
      const direction = delta === 0 ? 'same' : (delta < 0) === lowerIsBetter ? 'improved' : 'worse';
      return { metric, v1: x, v2: y, delta, direction };
    }),
  };
}

const pct = (v) => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);
const or = (v, fmt = (x) => `${x}`) => (v === null ? 'n/a' : fmt(v));
const pairs = (list, key, valueKey = 'count') => (list.length ? list.map((x) => `${x[key]} ${x[valueKey]}`).join(' · ') : 'none');

/** The text report (lines). */
export function renderLearn(r) {
  const lines = [`learn: ${plural(r.projects, 'project')}, ${r.events} events${r.since ? ` since ${r.since}` : ''}`];
  for (const v of r.versions) {
    lines.push(`version ${v.version}: ${plural(v.projects, 'project')}, ${v.events} events, ${plural(v.features, 'feature')}`);
    lines.push(`  build per feature (median): ${or(v.build.duration_ms, (x) => `${x} ms`)} · ${or(v.build.turns, (x) => `${x} turns`)} · ${or(v.build.cost_usd, (x) => `$${x}`)}`);
    lines.push(`  first-round pass rate ${pct(v.first_round_pass_rate)} · blocked ${pct(v.blocked_rate)}${v.blocked_reasons.length ? ` (${pairs(v.blocked_reasons, 'reason')})` : ''}`);
    lines.push(`  interventions: ${v.interventions}`);
    lines.push(`  lint rejections: ${pairs(v.lint_rejections, 'rule')}`);
    lines.push(`  finding reproduction rate: ${pct(v.reproduction_rate)}`);
    lines.push(`  ci repeated failures: ${pairs(v.ci_repeated, 'test', 'failures')}`);
  }
  if (!r.candidates.length) lines.push('candidates: none');
  else {
    lines.push('candidates:');
    for (const c of r.candidates) {
      lines.push(`  [${c.priority}] ${c.key} — ${c.title} (${plural(c.evidence.projects, 'project')}, ${c.evidence.events} events, ${c.evidence.versions.join(', ')})`);
    }
  }
  return lines;
}

/** The text comparison (lines). */
export function renderCompare(c) {
  const lines = [`compare ${c.v1} → ${c.v2}${c.since ? ` since ${c.since}` : ''}`];
  for (const m of c.metrics) {
    const change = m.delta === null ? 'n/a' : `${m.delta > 0 ? '+' : ''}${m.delta}, ${m.direction}`;
    lines.push(`  ${m.metric}: ${or(m.v1)} → ${or(m.v2)} (${change})`);
  }
  return lines;
}

/**
 * Records the candidates in backlog.json. An open field-data item with the same learn_rule gets
 * `seen` + 1 and the new evidence; any other candidate becomes a new item.
 * @returns {{added: object[], updated: object[]}}
 */
export function propose(file, list, { at = new Date().toISOString() } = {}) {
  const data = readBacklog(file);
  const open = new Map();
  for (const item of data.items) {
    if (isOpen(item) && item.source === SOURCE && typeof item.learn_rule === 'string' && !open.has(item.learn_rule)) open.set(item.learn_rule, item);
  }
  const added = [];
  const updated = [];
  for (const c of list) {
    const hit = open.get(c.key);
    if (hit) {
      hit.seen = (Number.isInteger(hit.seen) && hit.seen > 0 ? hit.seen : 1) + 1;
      hit.evidence = c.evidence;
      updated.push(hit);
      continue;
    }
    const item = { source: SOURCE, learn_rule: c.key, summary: c.title, priority: c.priority, evidence: c.evidence, seen: 1, at };
    data.items.push(item);
    open.set(c.key, item);
    added.push(item);
  }
  if (list.length) writeBacklog(file, data);
  return { added, updated };
}
