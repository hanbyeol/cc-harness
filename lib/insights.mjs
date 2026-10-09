// `harness insights` (SPEC §2 피드백 단계): aggregates the event log into counts per lint rule,
// step time/cost/turns per stage, finding reproduction, human interventions and CI failures,
// and derives improvement candidates from fixed rules. The rules only suggest; nothing is applied.

import { isObj } from './util.mjs';

export const TOP_N = 3;
// Thresholds of the suggestion rules (SPEC §2 insights 규칙).
export const THRESHOLDS = Object.freeze({
  lint_rule: 3, // errors of one lint rule
  backlog_reason: 3, // findings backlogged for one reason
  low_reproduction: { findings: 5, rate: 0.5 }, // at least 5 findings, less than half reproduced
  intervention: 2, // interventions of one kind
  rescope: 2, // split + rewrite decisions
  ci_repeated: 2, // CI runs one test failed in
  reask: 3, // evaluator re-asks
});

// Events that describe one executed step, by stage.
const STEP_TYPES = { build: ['step'], verify: ['command', 'check'], eval: ['step'], security: ['step'] };
const STEP_METRICS = ['duration_ms', 'cost_usd', 'turns'];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v ? v : null);
const round2 = (v) => Math.round(v * 100) / 100;

/** [{[key]: name, [valueKey]: n}] sorted by count (descending), then name. */
function ranked(counts, key, valueKey = 'count') {
  return [...counts.entries()]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, n]) => ({ [key]: name, [valueKey]: n }));
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

/** The empty report: what `--json` prints when there are no events. */
export function emptyInsights(since = null) {
  return {
    since,
    events: 0,
    lint: { checked: 0, rejected: 0, rules: [] },
    steps: {},
    findings: { total: 0, blocking: 0, backlogged: 0, reproduction_rate: null, reasons: [], reasks: 0 },
    interventions: { total: 0, kinds: [] },
    decisions: { total: 0, kinds: [] },
    ci: { runs: 0, failures: 0, repeated: [] },
    suggestions: [],
  };
}

/** Aggregates `events` (already filtered) into the insights report. */
export function insights(events, { since = null } = {}) {
  const r = emptyInsights(since);
  r.events = events.length;
  const lintRules = new Map();
  const steps = new Map();
  const reasons = new Map();
  const kinds = new Map();
  const decisions = new Map();
  const tests = new Map();

  for (const e of events) {
    const data = isObj(e.data) ? e.data : {};
    if (e.stage === 'plan' && e.type === 'lint') {
      r.lint.checked += 1;
      const errors = Array.isArray(data.errors) ? data.errors : [];
      if (errors.length || num(data.error_count) > 0) r.lint.rejected += 1;
      for (const x of errors) if (isObj(x) && str(x.rule)) bump(lintRules, x.rule);
    } else if (STEP_TYPES[e.stage]?.includes(e.type)) {
      if (!steps.has(e.stage)) steps.set(e.stage, []);
      steps.get(e.stage).push(e);
    } else if ((e.stage === 'eval' || e.stage === 'security') && e.type === 'finding') {
      r.findings.total += 1;
      const outcome = str(data.outcome) ?? str(data.result);
      if (outcome === 'blocking') r.findings.blocking += 1;
      else if (outcome === 'backlogged') {
        r.findings.backlogged += 1;
        bump(reasons, str(data.reason) ?? 'unknown');
      }
    } else if (e.stage === 'eval' && e.type === 'reask') {
      r.findings.reasks += 1;
    } else if (e.stage === 'feedback' && e.type === 'intervention') {
      r.interventions.total += 1;
      bump(kinds, str(data.kind) ?? 'other');
    } else if (e.stage === 'feedback' && e.type === 'decision') {
      r.decisions.total += 1;
      bump(decisions, str(data.decision) ?? 'unknown');
    } else if (e.stage === 'feedback' && e.type === 'ci') {
      r.ci.runs += 1;
      if (data.result === 'failure') r.ci.failures += 1;
      // A test counts once per recorded run.
      const names = new Set((Array.isArray(data.tests) ? data.tests : []).filter((t) => str(t)));
      for (const t of names) bump(tests, t);
    }
  }

  r.lint.rules = ranked(lintRules, 'rule');
  for (const stage of Object.keys(STEP_TYPES)) {
    const list = steps.get(stage);
    if (!list) continue;
    const s = { count: list.length };
    const top = {};
    for (const m of STEP_METRICS) {
      const withValue = list.map((e, i) => ({ e, i, v: num(e.data?.[m]) })).filter((x) => x.v !== null);
      const total = withValue.reduce((a, x) => a + x.v, 0);
      s[m] = withValue.length ? (m === 'cost_usd' ? round2(total) : total) : null;
      top[m] = withValue
        .sort((a, b) => b.v - a.v || a.i - b.i)
        .slice(0, TOP_N)
        .map(({ e, v }) => ({ feature: str(e.feature), round: Number.isInteger(e.round) ? e.round : null, type: e.type, value: v }));
    }
    s.top = top;
    r.steps[stage] = s;
  }
  if (r.findings.total) r.findings.reproduction_rate = round2(r.findings.blocking / r.findings.total);
  r.findings.reasons = ranked(reasons, 'reason');
  r.interventions.kinds = ranked(kinds, 'kind');
  r.decisions.kinds = ranked(decisions, 'kind');
  r.ci.repeated = ranked(tests, 'test', 'failures').filter((t) => t.failures >= THRESHOLDS.ci_repeated);
  r.suggestions = suggest(r);
  return r;
}

/** Improvement candidates from the fixed rules, each with the number of events behind it. */
export function suggest(r) {
  const out = [];
  const add = (rule, subject, evidence, title) => out.push({ rule, subject, evidence, title });
  for (const { rule, count } of r.lint.rules) {
    if (count >= THRESHOLDS.lint_rule) {
      add('lint_rule', rule, count, `lint rule '${rule}' rejected ${count} criteria — add guidance and an example for it to the spec skill`);
    }
  }
  for (const { reason, count } of r.findings.reasons) {
    if (count >= THRESHOLDS.backlog_reason) {
      add('backlog_reason', reason, count, `${count} findings were backlogged as '${reason}' — tighten the evaluator's guidance for that case`);
    }
  }
  const { findings: minFindings, rate } = THRESHOLDS.low_reproduction;
  if (r.findings.total >= minFindings && r.findings.reproduction_rate < rate) {
    add('low_reproduction', 'findings', r.findings.total,
      `only ${Math.round(r.findings.reproduction_rate * 100)}% of ${r.findings.total} findings reproduced — ask evaluators for a repro that fails on the current tree`);
  }
  if (r.findings.reasks >= THRESHOLDS.reask) {
    add('reask', 'evaluator', r.findings.reasks, `${r.findings.reasks} evaluator re-asks — make the output schema and the scoring evidence rule clearer in the evaluator prompt`);
  }
  for (const { kind, count } of r.interventions.kinds) {
    if (count >= THRESHOLDS.intervention) {
      add('intervention', kind, count, `${count} '${kind}' interventions — find the step that needed the human and automate or document it`);
    }
  }
  const rescoped = r.decisions.kinds.filter((k) => k.kind === 'split' || k.kind === 'rewrite').reduce((a, k) => a + k.count, 0);
  if (rescoped >= THRESHOLDS.rescope) {
    add('rescope', 'decisions', rescoped, `${rescoped} blocked features were split or rewritten — contracts may be too large or their criteria unclear at plan time`);
  }
  for (const { test, failures } of r.ci.repeated) {
    add('ci_repeated', test, failures, `CI test '${test}' failed in ${failures} runs — stabilize it (see test/stress.mjs) or fix the platform difference`);
  }
  return out;
}

const pairs = (list, key, valueKey = 'count') => list.map((x) => `${x[key]} ${x[valueKey]}`).join(' · ');
const where = (x) => [x.feature, x.round !== null ? `r${x.round}` : null, x.type].filter(Boolean).join(' ');
const FORMAT = {
  duration_ms: ['duration', (v) => `${v} ms`],
  cost_usd: ['cost', (v) => `$${v}`],
  turns: ['turns', (v) => `${v}`],
};

/** The text report (lines). */
export function renderInsights(r) {
  const lines = [`insights: ${r.events} events${r.since ? ` since ${r.since}` : ''}`];
  lines.push(`lint: ${r.lint.checked} contracts checked, ${r.lint.rejected} rejected`);
  if (r.lint.rules.length) lines.push(`  ${pairs(r.lint.rules, 'rule')}`);
  const stages = Object.keys(r.steps);
  lines.push(stages.length ? 'steps:' : 'steps: none');
  for (const stage of stages) {
    const s = r.steps[stage];
    lines.push(`  ${stage}: ${s.count} · ${s.duration_ms === null ? 'duration n/a' : `${s.duration_ms} ms`} · `
      + `${s.cost_usd === null ? 'cost n/a' : `$${s.cost_usd}`} · ${s.turns === null ? 'turns n/a' : `${s.turns} turns`}`);
    for (const m of STEP_METRICS) {
      const [label, fmt] = FORMAT[m];
      if (s.top[m].length) lines.push(`    top ${label}: ${s.top[m].map((x) => `${where(x)} ${fmt(x.value)}`).join(' · ')}`);
    }
  }
  const f = r.findings;
  lines.push(`findings: ${f.total} (blocking ${f.blocking}, backlogged ${f.backlogged})`
    + `${f.reproduction_rate === null ? '' : `, reproduction rate ${Math.round(f.reproduction_rate * 100)}%`}`);
  if (f.reasons.length) lines.push(`  backlog reasons: ${pairs(f.reasons, 'reason')}`);
  if (f.reasks) lines.push(`  reasks: ${f.reasks}`);
  lines.push(`interventions: ${r.interventions.total}`);
  if (r.interventions.kinds.length) lines.push(`  ${pairs(r.interventions.kinds, 'kind')}`);
  lines.push(`decisions: ${r.decisions.total}`);
  if (r.decisions.kinds.length) lines.push(`  ${pairs(r.decisions.kinds, 'kind')}`);
  lines.push(`ci: ${r.ci.runs} runs, ${r.ci.failures} failures`);
  if (r.ci.repeated.length) lines.push(`  repeated failures: ${pairs(r.ci.repeated, 'test', 'failures')}`);
  if (!r.suggestions.length) lines.push('suggestions: none');
  else {
    lines.push('suggestions:');
    for (const s of r.suggestions) lines.push(`  [${s.rule}] ${s.title} (${s.evidence} events)`);
  }
  return lines;
}
