// The run report and its step tables (SPEC §8.11).
import fs from 'node:fs';
import path from 'node:path';
import { loadFeatures } from '../state.mjs';
import { redactDeep } from '../failures.mjs';
import { readMetricsFile } from '../metrics.mjs';
import { RUN_STATUSES, KEEP_UNREDACTED, VALUES_ONLY, num } from './common.mjs';

export function mdCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

// Merge recovery of a feature (SPEC §8.10): none, or `<conflict|post_merge_verify> → passed|failed`.
export const recoveryCell = (x) => (x?.kind ? `${x.kind} → ${x.result}` : 'none');

export const STEP_TIME = (ms) => `${(num(ms) / 1000).toFixed(1)}s`;

// The Model cell of a step (SPEC §8.11): the requested model, or `<requested> → <served>` when
// the run found that pair mismatched (`mismatches`, keys `<requested>\0<served>`).
export function modelCell(m, mismatches) {
  const model = m.model ?? '-';
  return m.model && m.served_model && mismatches.has(`${m.model}\u0000${m.served_model}`) ? `${model} → ${m.served_model}` : model;
}

// Per-feature step table from the run's metrics lines (SPEC §8.11).
export function stepTables(metrics, mismatches = new Set()) {
  const lines = [];
  const features = [...new Set(metrics.map((m) => m.feature).filter(Boolean))];
  if (!features.length) return lines;
  lines.push('', '## Steps', '');
  for (const f of features) {
    lines.push(`### ${f}`, '', '| Round | Step | Time | Cost (USD) | Model | Outcome |', '|-------|------|------|------------|-------|---------|');
    for (const m of metrics.filter((x) => x.feature === f)) {
      // A verify that returned a stored result (§6.4) shows as '<outcome> (cached)'.
      const outcome = `${m.outcome ?? '-'}${m.cached === true ? ' (cached)' : ''}`;
      lines.push(`| ${m.round ?? '-'} | ${mdCell(m.step)} | ${STEP_TIME(m.duration_ms)} | ${m.cost_usd === null || m.cost_usd === undefined ? '-' : num(m.cost_usd).toFixed(2)} | ${mdCell(modelCell(m, mismatches))} | ${mdCell(outcome)} |`);
    }
    lines.push('');
  }
  lines.pop();
  return lines;
}

// One list item per line: no line breaks, no `|`, no backticks from a reason or detail.
export const oneLine = (s) => mdCell(s).replace(/[\r\n]|\u2028|\u2029/gu, ' ').replace(/`/g, "'");

// '## Needs you' (SPEC §8): what the human decides, first — blocked → run stopped → merge.
export function needsYou(state, cfg) {
  const lines = ['', '## Needs you', ''];
  for (const r of state.results.filter((x) => x.status === 'blocked')) {
    lines.push(`- ${oneLine(r.feature)} blocked (${oneLine(r.reason)}): split · rewrite criteria · accept risk — see Blocked — decisions needed`);
  }
  if (state.stopped) lines.push(`- run stopped (${oneLine(state.stopped.reason)}): ${oneLine(state.stopped.detail ?? '-')}`);
  if (state.results.some((x) => x.status === 'passed')) {
    lines.push(`- merge: review \`${cfg.integration_branch}\` and merge into \`${cfg.base_branch}\` (gh pr create --base ${cfg.base_branch} --head ${cfg.integration_branch})`);
  }
  if (lines.length === 3) lines.push('- nothing — no decision needed');
  return lines;
}

export function renderReport(state, { finishedAt, notRun = [], metrics = [] }) {
  const cfg = state.config;
  const lines = [`# harness run ${state.runId}`, '',
    `- started: ${state.startedAt}`, `- finished: ${finishedAt}`,
    `- scope: ${state.scope ? state.scope.join(', ') : 'all approved features'}`,
    `- max parallel: ${state.maxParallel === 'auto' ? 'auto (no limit)' : (state.maxParallel ?? 1)}`,
    `- verify parallel: ${state.verifyParallel?.value ?? 1}${state.verifyParallel?.auto ? ` (auto: ${state.verifyParallel.cpus} CPUs / 8)` : ''}`,
    `- integration branch: \`${cfg.integration_branch}\` (from \`${cfg.base_branch}\`)`,
    ...(state.baseSync ? [`- base sync: ${state.baseSync}`] : []),
    ...(state.worktreeSetups ?? []).map((s) => `- worktree setup ${mdCell(s.worktree)}: ${s.commands} command${s.commands === 1 ? '' : 's'}, ${s.outcome}`),
    `- total cost: $${num(state.costUsd).toFixed(2)}${state.maxUsd != null ? ` of $${state.maxUsd} run budget` : ''}`,
    `- ${state.sleepInhibitor?.ok ? `sleep inhibitor: ${state.sleepInhibitor.label}` : `sleep inhibitor unavailable: ${state.sleepInhibitor?.label ?? 'not started'}`}`,
    `- stopped: ${state.stopped ? `${state.stopped.reason}${state.stopped.feature ? ` (${state.stopped.feature})` : ''}${state.stopped.detail ? ` — ${state.stopped.detail}` : ''}`.replace(/\r?\n/g, ' ') : 'no — ran to completion'}`,
    ...needsYou(state, cfg),
    '', '## Features', '',
    '| Feature | Result | Rounds | Independence | Cost (USD) | Blocked reason | Merge recovery | Conflict resolution |',
    '|---------|--------|--------|--------------|------------|----------------|----------------|---------------------|'];
  for (const r of state.results) {
    lines.push(`| ${mdCell(r.feature)} ${mdCell(r.title)} | ${r.status} | ${r.rounds ?? 0} | ${mdCell(r.independence ?? '-')} | ${num(r.costUsd).toFixed(2)} | ${mdCell(r.status === 'blocked' ? `${r.reason}${r.detail ? `: ${r.detail}` : ''}` : r.status === 'skipped' ? r.reason : '')} | ${recoveryCell(r.mergeRecovery)} | ${r.conflictResolution ?? 'no'} |`);
  }
  if (state.results.length === 0) lines.push('| (none) | | | | | | | |');
  const carried = state.results.filter((r) => r.carried);
  if (carried.length) {
    lines.push('', '## Carried work', '');
    for (const r of carried) {
      lines.push(`- ${r.feature}: carried: true — continued the work left in \`.harness/wt/${r.feature}\` (branch \`harness/${r.feature}\`)${r.carriedCommit ? `; uncommitted changes were saved as ${r.carriedCommit.slice(0, 12)} (harness: ${r.feature} carried work)` : ''}`);
    }
  }
  const blocked = state.results.filter((r) => r.status === 'blocked');
  if (blocked.length) {
    lines.push('', '## Blocked — decisions needed', '');
    for (const r of blocked) {
      lines.push(`### ${r.feature} — ${r.reason}`, '');
      if (r.detail) lines.push(`- detail: ${r.detail}`);
      for (const f of r.failures || []) lines.push(`- failed: \`${mdCell(f.item).replace(/`/g, "'")}\` — ${mdCell(f.message)}`);
      r.history.forEach((ids, i) => lines.push(`- round ${i + 1} blocking: ${ids.length ? ids.join(', ') : '(none)'}`));
      if (r.worktree) lines.push(`- work kept in \`${r.worktree}\` (branch \`harness/${r.feature}\`)`);
      lines.push('- re-scope options (recorded in backlog.json): split · rewrite criteria · accept risk', '');
    }
  }
  if (state.warnings?.length) {
    lines.push('', '## Warnings', '');
    for (const w of state.warnings) lines.push(`- ${mdCell(w.replace(/^warning: /, ''))}`);
  }
  const flaky = state.results.filter((r) => r.flaky_tests?.length);
  if (flaky.length) {
    lines.push('', '## Flaky tests', '', 'Failed on the first run of a verify command and passed on the re-run:', '');
    for (const r of flaky) lines.push(`- ${r.feature}: ${r.flaky_tests.map((t) => `\`${mdCell(t).replace(/`/g, "'")}\``).join(', ')}`);
  }
  lines.push(...stepTables(metrics, new Set((state.servedMismatches ?? []).map((x) => `${x.requested}\u0000${x.served}`))));
  if (notRun.length) {
    lines.push('', '## Not run', '');
    for (const n of notRun) lines.push(`- ${n.id}: ${n.why}`);
  }
  lines.push('', '## Next', '',
    `Passed features are merged into \`${cfg.integration_branch}\`. Merging into \`${cfg.base_branch}\` is a human decision —`,
    `review and open a PR (for example \`gh pr create --base ${cfg.base_branch} --head ${cfg.integration_branch}\`). The harness never pushes.`, '');
  return lines.join('\n');
}

// ------------------------------------------------------------------ run

// Writes the report of a finished run from the same redacted copy as the state file (SR-8).
export function writeReport(ctx) {
  const { root, d, p, state, redact, metricsPath, inScope } = ctx;
  // Report, then drop the resumable state.
  const all = loadFeatures(root).features;
  const done = new Set(state.results.map((r) => r.feature));
  const notRun = all.filter((f) => inScope(f.id) && !done.has(f.id) && (state.scope || RUN_STATUSES.includes(f.status))).map((f) => ({
    id: f.id,
    why: !RUN_STATUSES.includes(f.status) ? `status is ${f.status}`
      : state.stopped ? 'run stopped before it'
        : 'not executable (dependencies not passed or contract not frozen)',
  }));
  const report = path.join(p.runs, `${state.runId}.md`);
  fs.mkdirSync(p.runs, { recursive: true });
  const metrics = readMetricsFile(metricsPath).rows;
  // Rendered from the same redacted copy as the state file (SR-8).
  fs.writeFileSync(report, renderReport(redactDeep(state, redact, KEEP_UNREDACTED, VALUES_ONLY), { finishedAt: d.now().toISOString(), notRun, metrics }));
  return { report, notRun };
}
