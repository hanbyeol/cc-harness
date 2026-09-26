// `harness run` — autonomous build → verify → eval → merge with guaranteed convergence (SPEC §8).
// The loop is code, not a prompt: a round cap, a strictly shrinking blocking set and
// divergence detection make an unbounded evaluator loop impossible. The core never
// pushes and never merges into main or a protected branch (SR-5); a human merges
// integration → main.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HarnessError } from './errors.mjs';
import { paths, readJson, writeJsonAtomic, loadFeatures, saveFeatures, verdictRounds } from './state.mjs';
import { loadConfig, validateUser, isMaxParallel, isParallelSetting, availableCpus } from './config.mjs';
import { executableFeatures, loadContract, hashContract } from './contract.mjs';
import { contractVerdicts } from './eval.mjs';
import { runCommand } from './exec.mjs';
import { appendItem, resolveItems } from './backlog.mjs';
import { verify as realVerify } from './verify.mjs';
import { startSleepInhibitor, sleepMeter, SLEEP_THRESHOLD_MS } from './sleep.mjs';
import { roleModel, builderModels } from './adapters/index.mjs';
import { appendMetric, readMetricsFile, METRIC_SUFFIX } from './metrics.mjs';

export const MAX_BUILD_ATTEMPTS = 3; // build retries per round when verify fails (SPEC §8.3)
export const MAX_EVAL_ERRORS = 2; // consecutive eval_error verdicts before blocked (SPEC §7.3)
export const INTEGRATION_WT = '_integration';
const GIT_TIMEOUT_SEC = 300;
const STATE_VERSION = 1;
// A feature an interactive `harness eval` left in_progress is run too; it continues the
// rounds of its contract (SPEC §8.8).
const RUN_STATUSES = ['approved', 'in_progress'];

class Interrupted extends Error {
  constructor() { super('interrupted'); this.name = 'Interrupted'; }
}

// A feature stops before its next step because the run is stopping (budget, SPEC §8.10).
class Halt extends Error {
  constructor(outcome) { super('halt'); this.name = 'Halt'; this.outcome = outcome; }
}

// A step timed out while the system slept: the run stops resumably, nothing is blocked (SPEC §8).
class SystemSleep extends Error {
  constructor(feature, stage, sleptMs) {
    super('system sleep');
    this.name = 'SystemSleep';
    Object.assign(this, { feature, stage, sleptSec: Math.round(sleptMs / 1000) });
  }
}

// A verify result where a command or a criterion check ran into the step timeout.
const verifyTimedOut = (v) => [...(v?.commands || []), ...(v?.criteria || [])].some((c) => c.timedOut);

// ------------------------------------------------------------------ convergence (pure)

const idOf = (x) => (typeof x === 'string' ? x : x?.criterion_id);

/** Distinct blocking criterion ids of a round: an id array, a finding array, or {blocking}. */
export function blockingIds(round) {
  const list = Array.isArray(round) ? round : (round?.blocking ?? []);
  return [...new Set(list.map(idOf).filter((id) => typeof id === 'string' && id))];
}

/** Blocking ids of a failing verdict record; a verify failure without findings blocks as 'VERIFY'. */
export function verdictBlockingIds(v) {
  const ids = blockingIds(Array.isArray(v?.blocking) ? v.blocking : []);
  return ids.length === 0 && v?.verify_pass === false ? ['VERIFY'] : ids;
}

/**
 * Convergence rule between consecutive failing rounds (SPEC §8.6, brainstorm D2): the
 * blocking set of round k must be a proper subset of round k-1's.
 * - divergence: an id blocking in k that was not blocking in k-1 (a criterion that
 *   passed, or a REGRESSION, came back)
 * - stall: the blocking set did not shrink
 * @returns {{ok:true} | {blocked:'divergence'|'stall', ids:string[]}}
 */
export function convergence(prevRound, currRound) {
  if (prevRound === null || prevRound === undefined) return { ok: true };
  const prev = new Set(blockingIds(prevRound));
  const curr = blockingIds(currRound);
  const appeared = curr.filter((id) => !prev.has(id));
  if (appeared.length > 0) return { blocked: 'divergence', ids: appeared };
  if (curr.length >= prev.size) return { blocked: 'stall', ids: curr };
  return { ok: true };
}

// ------------------------------------------------------------------ git

let noHooksDir = null;
// An empty directory as core.hooksPath: no repository hook runs during core git calls.
function hooksOff() {
  if (!noHooksDir || !fs.existsSync(noHooksDir)) noHooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-no-hooks-'));
  return noHooksDir;
}

// Commits and merges the core makes are authored by the core, unsigned, hook-free.
const coreGitArgs = () => ['-c', `core.hooksPath=${hooksOff()}`, '-c', 'core.quotePath=false',
  '-c', 'commit.gpgsign=false', '-c', 'user.name=cc-harness', '-c', 'user.email=cc-harness@localhost'];

/** The core git runner: `git(args, cwd)` → {code, stdout, stderr, timedOut}. */
export async function git(args, cwd) {
  const r = await runCommand({ file: 'git', args: [...coreGitArgs(), ...args] }, { cwd, timeoutSec: GIT_TIMEOUT_SEC });
  if (r.error === 'ENOENT') throw new HarnessError('git is not installed or not on PATH', { code: 'git_missing' });
  return r;
}

/**
 * Git calls that change worktrees, branches or merge state. A run makes them one at a time
 * (SPEC §8.10): concurrent `worktree add`/`branch`/`merge` calls race on shared repository files.
 */
export function isSerializedGit(args) {
  const [cmd, sub] = args;
  if (cmd === 'worktree') return sub === 'add' || sub === 'remove' || sub === 'prune';
  return cmd === 'branch' || cmd === 'merge' || cmd === 'checkout' || cmd === 'switch';
}

const gitCause = (r) => (r.stderr || r.stdout || r.error || (r.timedOut ? 'timed out' : `exit ${r.code}`)).trim();

async function gitOk(run, args, cwd, what) {
  const r = await run(args, cwd);
  if (r.code !== 0) throw new HarnessError(`${what}: ${gitCause(r)}`, { code: 'git' });
  return r.stdout.trim();
}

async function revParse(run, ref, cwd) {
  const r = await run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
  return r.code === 0 ? r.stdout.trim() : null;
}

function canonical(p) {
  let out = path.resolve(p);
  try { out = fs.realpathSync.native(out); } catch { /* not created yet */ }
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

// [{path, branch}] from `git worktree list --porcelain`.
async function listWorktrees(run, cwd) {
  const text = await gitOk(run, ['worktree', 'list', '--porcelain'], cwd, 'git worktree list failed');
  const list = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) list.push({ path: line.slice('worktree '.length), branch: null });
    else if (line.startsWith('branch ') && list.length) list[list.length - 1].branch = line.slice('branch '.length);
  }
  return list;
}

async function registeredWorktree(run, cwd, dir, branch) {
  const want = canonical(dir);
  return (await listWorktrees(run, cwd)).some((w) => canonical(w.path) === want && w.branch === `refs/heads/${branch}`);
}

// ------------------------------------------------------------------ protected branches (SR-5)

// Branch names are compared case-insensitively: on case-insensitive filesystems (macOS,
// Windows defaults) refs/heads/Main is the same loose ref as refs/heads/main, so a
// case variant of a protected name would merge straight into it.
const foldBranch = (b) => String(b).toLowerCase();

export function protectedSet(config) {
  const list = Array.isArray(config.protected_branches) ? config.protected_branches : [];
  const names = new Set(['main', ...list.filter((b) => typeof b === 'string' && b)].map(foldBranch));
  return { has: (b) => typeof b === 'string' && names.has(foldBranch(b)), names };
}

/**
 * Throws unless the integration branch is a legal, unprotected merge target.
 * `runGit(args, cwd)` → {code, stdout, stderr} is the git runner (injectable for tests).
 */
export async function assertIntegrationAllowed(config, cwd, { runGit = git } = {}) {
  const integ = config.integration_branch;
  const prot = protectedSet(config);
  if (typeof integ !== 'string' || !integ || integ.startsWith('-')) {
    throw new HarnessError(`integration_branch must be a branch name (got ${JSON.stringify(integ)})`, { code: 'config' });
  }
  if (prot.has(integ)) {
    throw new HarnessError(`integration_branch '${integ}' is protected — harness never merges into protected branches (SR-5). Set integration_branch to a dedicated branch.`, { code: 'protected_branch' });
  }
  if (typeof config.base_branch === 'string' && foldBranch(integ) === foldBranch(config.base_branch) && prot.has(config.base_branch)) {
    throw new HarnessError(`integration_branch equals the protected base '${integ}' (SR-5)`, { code: 'protected_branch' });
  }
  const r = await runGit(['check-ref-format', '--branch', integ], cwd);
  if (r.code !== 0) throw new HarnessError(`integration_branch '${integ}' is not a valid branch name`, { code: 'config' });
  // A local branch spelled differently but equal after case folding is the same loose ref
  // on a case-insensitive filesystem: the run would advance the user's branch (F10).
  const refs = await runGit(['for-each-ref', '--format=%(refname)', 'refs/heads/'], cwd);
  if (refs.code !== 0) throw new HarnessError(`cannot list local branches (git for-each-ref): ${gitCause(refs)}`, { code: 'git' });
  const clash = refs.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('refs/heads/'))
    .map((l) => l.slice('refs/heads/'.length))
    .find((b) => b !== integ && foldBranch(b) === foldBranch(integ));
  if (clash !== undefined) {
    throw new HarnessError(`integration_branch '${integ}' differs only by case from the existing local branch '${clash}' — on a case-insensitive filesystem they are the same branch, so the run would move '${clash}'. Rename one of them or choose another integration_branch.`, { code: 'branch_case' });
  }
}

// ------------------------------------------------------------------ defaults

async function defaultDiagnose(args) {
  const { diagnose } = await import('./commands/doctor.mjs');
  return diagnose(args);
}

/**
 * Run preflight (SPEC §8): the doctor verdict for builder, evaluator and — when a critical
 * feature is in scope — security-reviewer. Throws (exit 2) naming each unusable role and why.
 */
export async function preflight({ config, critical, diagnose = defaultDiagnose }) {
  const roles = ['builder', 'evaluator', ...(critical ? ['security-reviewer'] : [])];
  const report = await diagnose({ config });
  const bad = roles.map((role) => {
    const r = (report?.roles || []).find((x) => x.role === role);
    if (r?.usable) return null;
    return `${role}${r?.adapter ? ` (${r.adapter})` : ''}: ${r?.reason || 'not reported by doctor'}`;
  }).filter(Boolean);
  if (bad.length) {
    throw new HarnessError(`run preflight failed — role not usable:\n  ${bad.join('\n  ')}\nnothing was started; fix the roles (see \`harness doctor\`) and run again`, { code: 'preflight' });
  }
}

async function defaultEvaluate(args) {
  const { evaluate } = await import('./eval.mjs');
  return evaluate(args);
}

// The builder role gets the frozen contract plus what failed last (SPEC §8.2).
export function builderPrompt({ rolePrompt, featureId, round, attempt, contract, findings, verifyFailure, conflicts }) {
  const parts = [rolePrompt.trim(), '', `# Task: feature ${featureId}, round ${round}, attempt ${attempt}`, '',
    'Frozen contract:', '```json', JSON.stringify(contract, null, 2), '```'];
  if (findings?.length) {
    parts.push('', 'Blocking findings from the previous round (fix these first):', '```json', JSON.stringify(findings, null, 2), '```');
  }
  if (verifyFailure) {
    parts.push('', 'Deterministic verification failed on the previous attempt:', '```json', JSON.stringify(verifyFailure, null, 2), '```');
  }
  if (conflicts?.length) {
    parts.push('', '# Merge conflict resolution',
      'The feature passed evaluation, but merging it into the integration branch conflicted. The integration',
      'branch is now being merged into this worktree and the merge stopped with conflicts in these files:',
      ...conflicts.map((f) => `- ${f}`),
      'Resolve every conflict so that both this feature and the changes already on the integration branch keep',
      'working, and remove all conflict markers. Do not commit, abort or restart the merge; the harness',
      'completes it and verifies and evaluates the result again.');
  }
  return parts.join('\n') + '\n';
}

// `adapter`/`model` are the builder model the run chose for this call (SPEC §10 role model policy).
async function defaultBuild({ cwd, featureId, round, attempt, contract, findings, verifyFailure, conflicts, config, timeoutSec, budgetUsd, signal, adapter: chosen, model: chosenModel }) {
  const { getAdapter, roleModel: policy } = await import('./adapters/index.mjs');
  const { loadRolePrompt } = await import('./roles.mjs');
  const { adapter: name, model } = chosen !== undefined
    ? { adapter: chosen, model: chosenModel ?? null }
    : policy(config, 'builder', { tier: contract?.security_tier, round, conflict: Boolean(conflicts?.length) });
  const adapter = name ? getAdapter(name, config) : null;
  if (!adapter) return { ok: false, error: 'adapter_unavailable', detail: `builder adapter '${name}' is unknown`, costUsd: null };
  const prompt = builderPrompt({ rolePrompt: loadRolePrompt('builder'), featureId, round, attempt, contract, findings, verifyFailure, conflicts });
  return adapter.run({ role: 'builder', prompt, cwd, readOnly: false, timeoutSec, budgetUsd, model, signal });
}

// ------------------------------------------------------------------ helpers

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const tsName = (d) => d.toISOString().replace(/[:.]/g, '-');

// Compact, prompt-sized summary of a failed verify for the next build attempt.
function verifyFailureSummary(v) {
  if (!v || v.pass) return null;
  return {
    commands: (v.commands || []).filter((c) => !c.pass).map((c) => ({ cmd: c.cmd, message: c.message, output: c.output })),
    integrity: v.integrity,
    criteria: (v.criteria || []).filter((c) => !c.pass).map((c) => ({ id: c.id, check: c.check, message: c.message })),
  };
}

// A round whose verify never passed is judged by verify alone: its blocking set is the
// failing criterion ids plus pseudo-ids for failing commands / integrity.
export function verifyBlocking(v) {
  const out = [];
  for (const c of v?.criteria || []) {
    if (!c.pass) out.push({ criterion_id: String(c.id).split('#')[0], dimension: 'verify', summary: c.message || 'check failed', repro: c.check });
  }
  const failed = (v?.commands || []).filter((c) => !c.pass);
  if (failed.length) out.push({ criterion_id: 'VERIFY:commands', dimension: 'verify', summary: failed.map((c) => `${c.cmd}: ${c.message}`).join('; ') });
  const i = v?.integrity;
  const tc = i?.testCount?.status;
  if (i && ((i.markers || []).length || (i.harnessPaths || []).length || (tc && tc !== 'ok' && tc !== 'unset'))) {
    out.push({ criterion_id: 'VERIFY:integrity', dimension: 'verify', summary: 'integrity check failed (skip markers, .harness changes or test count)' });
  }
  if (out.length === 0) out.push({ criterion_id: 'VERIFY', dimension: 'verify', summary: 'verify failed' });
  return out;
}

const RESCOPE = {
  divergence: 'criteria that were not blocking came back — the change to fix one breaks another',
  stall: 'the blocking set did not shrink between rounds',
  max_rounds: 'the round limit was reached with blocking findings left',
  merge_conflict: 'the feature branch conflicts with the integration branch and one automatic resolution did not fix it',
  post_merge_verify: 'verify failed on the integration branch after the merge',
  budget: 'a step timed out or the budget was exhausted',
  'needs-human': 'the evaluator scored below threshold without a reproducible finding',
  eval_error: 'the evaluator failed twice in a row',
  worktree: 'the feature worktree could not be created',
  adapter_unavailable: 'a role CLI (builder or evaluator) is not available',
  verify_error: 'verify could not run',
  run_stopped: 'the run stopped (a critical feature was blocked) after this feature\'s round failed',
};

function rescopeProposal(e, outcome) {
  const last = e.history.length ? e.history[e.history.length - 1] : [];
  const ids = outcome.ids?.length ? outcome.ids : last;
  const list = ids.length ? ids.join(', ') : 'the feature';
  return {
    source: `run:${e.feature}`,
    feature: e.feature,
    kind: 'rescope',
    reason: outcome.reason,
    rounds: e.round,
    blocking: last,
    summary: `${e.feature} blocked (${outcome.reason}): ${RESCOPE[outcome.reason] || outcome.reason}${outcome.detail ? ` — ${outcome.detail}` : ''}`,
    options: [
      { kind: 'split', summary: `split ${e.feature} so ${list} ship as a separate feature with its own contract` },
      { kind: 'rewrite', summary: `rewrite the criteria for ${list} (new contract version, re-approval)` },
      { kind: 'accept-risk', summary: `accept the risk: drop or relax ${list} with a recorded decision` },
    ],
  };
}

function appendBacklog(root, item) {
  appendItem(paths(root).backlog, item);
}

function setStatus(root, id, status) {
  const data = loadFeatures(root);
  const f = data.features.find((x) => x.id === id);
  if (!f) throw new HarnessError(`feature ${id} disappeared from features.json during the run`, { code: 'state_corrupt' });
  f.status = status;
  saveFeatures(root, data);
}

// Approved features that depend (transitively) on `id`, restricted to the run scope.
function dependentsOf(features, id, inScope) {
  const out = [];
  const blocked = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of features) {
      if (f.status !== 'approved' || !inScope(f.id) || blocked.has(f.id)) continue;
      if ((f.depends_on || []).some((d) => blocked.has(d))) { blocked.add(f.id); out.push(f.id); grew = true; }
    }
  }
  return out;
}

const validEntry = (c) => c !== null && typeof c === 'object' && typeof c.feature === 'string'
  && Number.isInteger(c.round) && typeof c.stage === 'string' && Array.isArray(c.history);

// `active` lists every feature in flight (SPEC §8.10); `current` mirrors its first entry and is
// all a state file written before parallel runs has.
function validateState(s, file) {
  const ok = s && typeof s === 'object' && s.version === STATE_VERSION && typeof s.runId === 'string'
    && Array.isArray(s.results) && s.config && typeof s.config === 'object'
    && (Array.isArray(s.active) ? s.active.every(validEntry) : (s.current === null || validEntry(s.current)))
    && (s.maxParallel === undefined || isParallelSetting(s.maxParallel))
    && (s.verifyParallel === undefined || isMaxParallel(s.verifyParallel?.value));
  if (!ok) throw new HarnessError(`${file}: not a valid run state — fix or delete it; harness will not guess`, { code: 'state_corrupt' });
  if (!Array.isArray(s.active)) s.active = s.current ? [s.current] : [];
}

// ------------------------------------------------------------------ report

function mdCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

const STEP_TIME = (ms) => `${(num(ms) / 1000).toFixed(1)}s`;

// Per-feature step table from the run's metrics lines (SPEC §8.11).
function stepTables(metrics) {
  const lines = [];
  const features = [...new Set(metrics.map((m) => m.feature).filter(Boolean))];
  if (!features.length) return lines;
  lines.push('', '## Steps', '');
  for (const f of features) {
    lines.push(`### ${f}`, '', '| Round | Step | Time | Cost (USD) | Model | Outcome |', '|-------|------|------|------------|-------|---------|');
    for (const m of metrics.filter((x) => x.feature === f)) {
      lines.push(`| ${m.round ?? '-'} | ${mdCell(m.step)} | ${STEP_TIME(m.duration_ms)} | ${m.cost_usd === null || m.cost_usd === undefined ? '-' : num(m.cost_usd).toFixed(2)} | ${mdCell(m.model ?? '-')} | ${mdCell(m.outcome ?? '-')} |`);
    }
    lines.push('');
  }
  lines.pop();
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
    `- total cost: $${num(state.costUsd).toFixed(2)}${state.maxUsd != null ? ` of $${state.maxUsd} run budget` : ''}`,
    `- ${state.sleepInhibitor?.ok ? `sleep inhibitor: ${state.sleepInhibitor.label}` : `sleep inhibitor unavailable: ${state.sleepInhibitor?.label ?? 'not started'}`}`,
    `- stopped: ${state.stopped ? `${state.stopped.reason}${state.stopped.feature ? ` (${state.stopped.feature})` : ''}${state.stopped.detail ? ` — ${state.stopped.detail}` : ''}` : 'no — ran to completion'}`,
    '', '## Features', '',
    '| Feature | Result | Rounds | Independence | Cost (USD) | Blocked reason | Conflict resolution |',
    '|---------|--------|--------|--------------|------------|----------------|---------------------|'];
  for (const r of state.results) {
    lines.push(`| ${mdCell(r.feature)} ${mdCell(r.title)} | ${r.status} | ${r.rounds ?? 0} | ${mdCell(r.independence ?? '-')} | ${num(r.costUsd).toFixed(2)} | ${mdCell(r.status === 'blocked' ? `${r.reason}${r.detail ? `: ${r.detail}` : ''}` : r.status === 'skipped' ? r.reason : '')} | ${r.conflictResolution ?? 'no'} |`);
  }
  if (state.results.length === 0) lines.push('| (none) | | | | | | |');
  const blocked = state.results.filter((r) => r.status === 'blocked');
  if (blocked.length) {
    lines.push('', '## Blocked — decisions needed', '');
    for (const r of blocked) {
      lines.push(`### ${r.feature} — ${r.reason}`, '');
      if (r.detail) lines.push(`- detail: ${r.detail}`);
      r.history.forEach((ids, i) => lines.push(`- round ${i + 1} blocking: ${ids.length ? ids.join(', ') : '(none)'}`));
      if (r.worktree) lines.push(`- work kept in \`${r.worktree}\` (branch \`harness/${r.feature}\`)`);
      lines.push('- re-scope options (recorded in backlog.json): split · rewrite criteria · accept risk', '');
    }
  }
  lines.push(...stepTables(metrics));
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

// Runs at most `n` tasks at once; the rest wait in call order.
function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || queue.length === 0) return;
    active += 1;
    queue.shift()();
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push(() => Promise.resolve().then(fn).then(resolve, reject).finally(() => { active -= 1; next(); }));
    next();
  });
}

export { availableCpus };

/** Verify pool size (SPEC §8.10): an integer setting as is; 'auto' (or unset) is max(1, floor(cpus / 8)). */
export function verifyParallelFor(setting, cpus) {
  if (isMaxParallel(setting)) return setting;
  return Math.max(1, Math.floor(num(cpus) / 8));
}

/**
 * Runs approved features to passed / blocked / skipped (SPEC §8).
 * Independent features run concurrently up to `parallel` (default config run.max_parallel;
 * 'auto' = every ready feature); verifies share a pool of run.verify_parallel slots; merges
 * into the integration branch and every core git call that changes worktrees, branches or
 * merge state stay serial (SPEC §8.10).
 * @param {{root:string, config?:object, ids?:string[], resume?:boolean, maxUsd?:number, parallel?:number,
 *   signal?:AbortSignal, deps?:{build?,verify?,evaluate?,now?,monotonic?,log?,runAdapter?,git?,diagnose?,platform?,env?,cpus?}}} opts
 *   deps.git is the runner for every core git call (default: the exported `git`). deps.cpus is
 *   the CPU count behind verify_parallel 'auto'. deps.diagnose is the
 *   doctor report for the preflight; it is skipped when build and evaluation are both injected
 *   (no role CLI will be called) and no diagnose is given. deps.now/monotonic are the wall and
 *   monotonic clocks (ms) for sleep detection; deps.platform/env select and find the sleep inhibitor.
 * @returns {Promise<{interrupted:boolean, sleep?:{feature,stage,sleptSec}, results:object[], stopped:object|null, costUsd:number, report:string|null, statePath:string}>}
 */
export async function runFeatures({ root, config, ids, resume = false, maxUsd, parallel, signal: outer, deps = {} } = {}) {
  if (parallel !== undefined && parallel !== null && !isMaxParallel(parallel)) {
    throw new HarnessError(`--parallel needs a positive integer (got ${JSON.stringify(parallel)})`, { code: 'usage' });
  }
  const d = {
    build: defaultBuild, verify: realVerify, evaluate: defaultEvaluate,
    now: () => new Date(), monotonic: () => performance.now(), log: () => {}, git,
    platform: process.platform, env: process.env, cpus: availableCpus(), ...deps,
  };
  // Worktree, branch and merge changes go through one lock (SPEC §8.10).
  const gitLock = limiter(1);
  const g = (args, cwd) => (isSerializedGit(args) ? gitLock(() => d.git(args, cwd)) : d.git(args, cwd));
  const p = paths(root);
  const statePath = path.join(p.runs, 'current.json');

  let state;
  if (resume) {
    if (ids?.length) throw new HarnessError('--resume continues the saved run; do not pass feature ids', { code: 'usage' });
    state = readJson(statePath, { optional: true });
    if (state === undefined) throw new HarnessError(`nothing to resume — ${statePath} does not exist`, { code: 'no_run' });
    validateState(state, statePath);
    if (maxUsd !== undefined && maxUsd !== null) state.maxUsd = maxUsd;
    if (parallel !== undefined && parallel !== null) state.maxParallel = parallel;
  } else {
    if (fs.existsSync(statePath)) {
      throw new HarnessError(`an interrupted run is saved in ${statePath} — continue it with \`harness run --resume\` or delete the file`, { code: 'run_in_progress' });
    }
    const cfg = config ?? loadConfig(root);
    const known = new Set(loadFeatures(root).features.map((f) => f.id));
    const unknown = (ids || []).filter((id) => !known.has(id));
    if (unknown.length) throw new HarnessError(`unknown feature(s): ${unknown.join(', ')}`, { code: 'usage' });
    const started = d.now();
    state = {
      version: STATE_VERSION,
      runId: tsName(started),
      startedAt: started.toISOString(),
      scope: ids?.length ? [...ids] : null,
      maxUsd: maxUsd ?? cfg.budget?.run_usd ?? null,
      config: structuredClone(cfg), // snapshot: the run never re-reads config (brainstorm D2)
      maxParallel: parallel ?? cfg.run?.max_parallel ?? 'auto',
      costUsd: 0,
      results: [],
      active: [],
      current: null,
      stopped: null,
    };
  }
  const cfg = state.config;
  // The snapshot is what the run acts on, so it gets the same shape checks as config.json:
  // a state file written before F13, or a config passed in directly, could carry e.g.
  // protected_branches: "v2", which protectedSet would silently read as [] (SR-5).
  validateUser(cfg, resume ? `${statePath} (config snapshot)` : 'config');
  const inScope = (id) => !state.scope || state.scope.includes(id);
  const maxParallel = state.maxParallel === 'auto' ? Infinity : isMaxParallel(state.maxParallel) ? state.maxParallel : 1;
  if (!state.verifyParallel) {
    const setting = cfg.run?.verify_parallel ?? 'auto';
    state.verifyParallel = { value: verifyParallelFor(setting, d.cpus), auto: setting === 'auto', cpus: d.cpus };
  }
  // Every verify (feature and post-merge) takes a slot of this pool; build and eval do not.
  const verifyPool = limiter(state.verifyParallel.value);
  const runVerify = (args) => verifyPool(() => d.verify(args));
  const maxRounds = Number.isInteger(cfg.max_rounds) && cfg.max_rounds > 0 ? cfg.max_rounds : 3;
  const stepTimeout = cfg.budget?.step_timeout_sec ?? 1800;
  const stepUsd = cfg.budget?.step_usd ?? null;
  // One state object for every feature in flight; writes are synchronous, so none is lost.
  const save = () => {
    state.current = state.active[0] ?? null;
    writeJsonAtomic(statePath, state);
  };

  // One metrics line per finished step (SPEC §8.11). `at` is the step's start from stamp().
  const metricsPath = path.join(p.runs, `${state.runId}${METRIC_SUFFIX}`);
  const stamp = () => new Date(+d.now());
  // `who` is the {adapter, model} the role was actually called with; core steps have none.
  const metric = (e, step, at, { role = null, who = null, costUsd = null, outcome, round = e.round } = {}) => {
    const r = role ? { role, adapter: who?.adapter ?? null, model: who?.model ?? null } : { role: 'core', adapter: null, model: null };
    appendMetric(metricsPath, { feature: e.feature, round, step, startedAt: at, endedAt: stamp(), costUsd, ...r, outcome });
  };
  const verifyOutcome = (v) => (v?.error ? 'error' : v?.pass ? 'pass' : 'fail');

  // SIGINT (outer) or a fatal error in one feature (system sleep, corrupt state) stops every
  // step in flight: with more than one feature in flight they share the run's own signal.
  // With one, the steps get the caller's signal as it is.
  const ac = new AbortController();
  const signal = maxParallel > 1 || state.active.length > 1 || !outer ? ac.signal : outer;
  if (outer?.aborted) ac.abort();
  const onOuter = () => ac.abort();
  outer?.addEventListener('abort', onOuter, { once: true });

  // Merges (with their post-merge verify) and worktree creation run one at a time.
  const serial = () => {
    let tail = Promise.resolve();
    return (fn) => {
      const r = tail.then(fn);
      tail = r.catch(() => {});
      return r;
    };
  };
  const mergeLock = serial();
  const worktreeLock = serial();

  // A new run checks the role CLIs before it creates any branch or worktree (SPEC §8).
  const callsCli = !(deps.build && (deps.evaluate || deps.runAdapter));
  if (!resume && (deps.diagnose || callsCli)) {
    const scoped = loadFeatures(root).features.filter((f) => inScope(f.id) && RUN_STATUSES.includes(f.status));
    if (scoped.length) {
      await preflight({ config: cfg, critical: scoped.some((f) => f.security_tier === 'critical'), diagnose: deps.diagnose });
    }
  }

  // Refuse before touching anything (SR-5).
  const top = await gitOk(g, ['rev-parse', '--show-toplevel'], root, `${root} is not inside a git repository`);
  const projectRel = path.relative(canonical(top), canonical(root));
  await assertIntegrationAllowed(cfg, root, { runGit: d.git });
  const integ = cfg.integration_branch;
  const prot = protectedSet(cfg);

  if (!(await revParse(g, `refs/heads/${integ}`, root))) {
    const baseSha = await revParse(g, cfg.base_branch, root);
    if (!baseSha) throw new HarnessError(`base branch '${cfg.base_branch}' not found — cannot create '${integ}'`, { code: 'base_missing' });
    await gitOk(g, ['branch', integ, baseSha], root, `cannot create integration branch '${integ}'`);
    d.log(`created integration branch ${integ} from ${cfg.base_branch}`);
  }
  // A dedicated worktree for merges: the user's own worktree never changes branch.
  const intWt = path.join(p.worktrees, INTEGRATION_WT);
  if (!(await registeredWorktree(g, root, intWt, integ))) {
    if (fs.existsSync(intWt)) throw new HarnessError(`${intWt} exists but is not a worktree of '${integ}' — remove it`, { code: 'worktree' });
    fs.mkdirSync(p.worktrees, { recursive: true });
    await gitOk(g, ['worktree', 'add', intWt, integ], root, `cannot create the integration worktree for '${integ}' (is it checked out elsewhere?)`);
  }
  const intCwd = path.join(intWt, projectRel);
  save();

  const addCost = (e, c) => {
    state.costUsd = num(state.costUsd) + num(c);
    if (e) e.costUsd = num(e.costUsd) + num(c);
  };
  const runOver = () => state.maxUsd !== null && state.maxUsd !== undefined && state.costUsd > state.maxUsd;
  const remainingUsd = () => {
    const run = state.maxUsd != null ? Math.max(0, state.maxUsd - state.costUsd) : null;
    if (run === null) return stepUsd;
    return stepUsd === null ? run : Math.min(stepUsd, run);
  };

  // While the run stops on budget, no feature starts another step (SPEC §8 budget).
  const checkHalt = (e) => {
    const s = state.stopped;
    if (s?.reason === 'budget' && s.feature !== e.feature) throw new Halt(blocked('budget', `run stopped on budget before the next step — ${s.detail}`));
  };

  // Races a step against SIGINT: an interrupted step is redone on resume.
  // `halt: false` for the post-merge verify: a merge is always verified (or rolled back).
  const step = async (e, fn, { halt = true } = {}) => {
    if (signal?.aborted) throw new Interrupted();
    if (halt) checkHalt(e);
    const pr = Promise.resolve().then(fn);
    if (!signal) return pr;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new Interrupted());
      signal.addEventListener('abort', onAbort, { once: true });
      pr.then((v) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(new Interrupted()); else resolve(v);
      }, (err) => { signal.removeEventListener('abort', onAbort); reject(err); });
    });
  };

  const blocked = (reason, detail, extra = {}) => ({ status: 'blocked', reason, detail: detail || null, ...extra });
  const stopRunOnBudget = (feature) => {
    if (!runOver()) return null;
    if (state.stopped?.reason !== 'budget') {
      state.stopped = { reason: 'budget', feature, detail: `run cost $${state.costUsd.toFixed(2)} exceeds $${state.maxUsd}` };
    }
    return blocked('budget', `run cost $${state.costUsd.toFixed(2)} exceeds $${state.maxUsd}`);
  };
  const isFatal = (err) => err instanceof Interrupted || err instanceof SystemSleep || err instanceof Halt
    || (err instanceof HarnessError && err.code === 'state_corrupt');

  // A step that timed out while the system slept stops the run for --resume instead of
  // blocking the feature (SPEC §8): the timeout measured the sleep, not the work.
  let meter = null;
  const sleptThrough = (mark, timedOut, e, stage) => {
    if (!timedOut) return;
    const ms = meter.sleptSince(mark);
    if (ms >= SLEEP_THRESHOLD_MS) throw new SystemSleep(e.feature, stage, ms);
  };

  // Closes a failing round; returns a blocked outcome or null to continue with round+1.
  const endRound = (e, blocking) => {
    const ids = blockingIds(blocking);
    // The run's first round compares with the last verdict of the same contract hash, if it
    // failed (e.carriedPrev); later rounds with the run's own previous round.
    const carried = e.carried ?? 0;
    const prev = e.history.length > carried ? e.history[e.history.length - 1] : (e.carriedPrev ?? null);
    e.history.push(ids);
    e.findings = blocking;
    const c = convergence(prev, ids);
    if (c.blocked) return blocked(c.blocked, `${c.blocked === 'divergence' ? 'newly blocking' : 'still blocking'}: ${c.ids.join(', ') || '(none)'}`, { ids: c.ids });
    if (e.round >= maxRounds) return blocked('max_rounds', `round ${e.round} of ${maxRounds} ended with ${ids.join(', ') || 'a failing verdict'}`);
    // A stopping run lets features in flight finish their round, but starts no new one (SPEC §8.10).
    if (state.stopped) {
      return state.stopped.reason === 'budget'
        ? blocked('budget', `run stopped on budget — ${state.stopped.detail}`)
        : blocked('run_stopped', `run stopped (${state.stopped.reason}${state.stopped.feature ? ` ${state.stopped.feature}` : ''}) after round ${e.round} failed with ${ids.join(', ') || 'a failing verdict'}`);
    }
    e.round += 1;
    e.stage = 'build';
    e.attempt = 0;
    e.attemptsDone = 0;
    e.built = null;
    e.lastVerify = null;
    save();
    return null;
  };

  const wtOf = (id) => path.join(p.worktrees, id);
  const cwdOf = (id) => path.join(wtOf(id), projectRel);

  async function buildAndVerify(e, contract) {
    // Resume continues the round's attempt count: completed build+verify cycles and the
    // last verify result are part of the saved state, so a round never exceeds the cap.
    let last = e.lastVerify ?? null;
    if (last?.pass) return { verifyResult: last };
    for (let attempt = (e.attemptsDone ?? 0) + 1; attempt <= MAX_BUILD_ATTEMPTS; attempt += 1) {
      e.attempt = attempt;
      save();
      // A resumed attempt whose build finished (its verify was cut off) goes straight to verify.
      if (e.built !== attempt) {
        let b;
        const m = meter.mark();
        const at = stamp();
        // Round 1 takes the tier's model, later rounds of the contract the escalation model.
        const who = roleModel(cfg, 'builder', { tier: contract.security_tier, round: e.round });
        try {
          b = await step(e, () => d.build({
            root, cwd: cwdOf(e.feature), featureId: e.feature, round: e.round, attempt, contract,
            findings: e.findings, verifyFailure: verifyFailureSummary(last), config: cfg,
            timeoutSec: stepTimeout, budgetUsd: remainingUsd(), signal, ...who,
          }));
        } catch (err) {
          if (isFatal(err)) throw err;
          b = { ok: false, error: 'exit_nonzero', detail: err.message };
        }
        metric(e, 'build', at, { role: 'builder', who, costUsd: b?.costUsd, outcome: b?.ok ? 'ok' : (b?.error || 'failed') });
        addCost(e, b?.costUsd);
        save();
        d.log(`${e.feature} r${e.round} build ${attempt}/${MAX_BUILD_ATTEMPTS}: ${b?.ok ? 'ok' : (b?.error || 'failed')}`);
        const over = stopRunOnBudget(e.feature);
        if (over) return over;
        sleptThrough(m, b?.error === 'timeout', e, 'build');
        if (b?.error === 'timeout') return blocked('budget', `build timed out after ${stepTimeout}s`);
        if (stepUsd !== null && num(b?.costUsd) >= stepUsd) return blocked('budget', `build cost $${num(b?.costUsd).toFixed(2)} reached the step budget $${stepUsd}`);
        if (b?.error === 'adapter_unavailable') return blocked('adapter_unavailable', b.detail);
        e.built = attempt;
        save();
      }
      const mv = meter.mark();
      const at = stamp();
      try {
        last = await step(e, () => runVerify({ root, cwd: cwdOf(e.feature), featureId: e.feature, base: e.baseSha, config: cfg, signal, cpus: d.cpus }));
      } catch (err) {
        if (isFatal(err)) throw err;
        metric(e, 'verify', at, { outcome: 'error' });
        return blocked('verify_error', err.message);
      }
      metric(e, 'verify', at, { outcome: verifyOutcome(last) });
      sleptThrough(mv, verifyTimedOut(last), e, 'verify');
      e.attemptsDone = attempt;
      e.lastVerify = last;
      save();
      d.log(`${e.feature} r${e.round} verify: ${last.pass ? 'pass' : 'fail'}`);
      if (last.pass) break;
    }
    return { verifyResult: last };
  }

  async function merge(e) {
    const branch = `harness/${e.feature}`;
    if (prot.has(branch)) return blocked('merge_conflict', `${branch} is a protected branch name`);
    // 1. the builder's uncommitted work becomes a core-authored commit on the feature branch
    const wt = wtOf(e.feature);
    const dirty = await gitOk(g, ['status', '--porcelain'], wt, 'git status failed');
    if (dirty) {
      await gitOk(g, ['add', '-A'], wt, 'git add failed');
      await gitOk(g, ['commit', '-q', '-m', `harness: ${e.feature} round ${e.round} builder changes`], wt, 'commit of builder changes failed');
    }
    // 2. merge in the dedicated integration worktree, never a protected branch
    const head = await gitOk(g, ['symbolic-ref', '--short', 'HEAD'], intWt, 'integration worktree has no branch');
    if (head !== integ || prot.has(head)) throw new HarnessError(`integration worktree is on '${head}', expected '${integ}' — refusing to merge (SR-5)`, { code: 'protected_branch' });
    const alreadyMerged = e.preMergeSha
      && (await g(['merge-base', '--is-ancestor', branch, 'HEAD'], intWt)).code === 0
      && (await revParse(g, 'HEAD', intWt)) !== e.preMergeSha;
    if (!alreadyMerged) {
      if (await gitOk(g, ['status', '--porcelain'], intWt, 'git status failed')) {
        throw new HarnessError(`integration worktree ${intWt} has uncommitted changes — clean it before running`, { code: 'worktree' });
      }
      e.preMergeSha = await revParse(g, 'HEAD', intWt);
      save();
      const at = stamp();
      const r = await g(['merge', '--no-ff', '--no-edit', '-m', `harness: merge ${e.feature} (round ${e.round})`, branch], intWt);
      metric(e, 'merge', at, { outcome: r.code === 0 ? 'merged' : 'conflict' });
      if (r.code !== 0) {
        const conflicts = (await g(['diff', '--name-only', '--diff-filter=U'], intWt)).stdout.trim().split(/\r?\n/).filter(Boolean);
        await g(['merge', '--abort'], intWt);
        const clean = !(await gitOk(g, ['status', '--porcelain'], intWt, 'git status failed'));
        // The first conflict of a feature goes back to its builder once (SPEC §8.10); integration stays as it was.
        if (conflicts.length && clean && !e.conflictTried) return { resolve: conflicts };
        const detail = conflicts.length ? `conflicts in ${conflicts.join(', ')}` : gitCause(r);
        return blocked('merge_conflict', `${detail}${e.conflictTried ? ' after the automatic conflict resolution' : ''}${clean ? '' : ' (integration worktree left dirty — clean it by hand)'}`);
      }
    }
    // 3. verify what was actually merged (the structural backstop, SPEC §7.3 D1)
    let v;
    const m = meter.mark();
    const at = stamp();
    try {
      v = await step(e, () => runVerify({ root, cwd: intCwd, featureId: e.feature, base: e.preMergeSha, config: cfg, signal, cpus: d.cpus }), { halt: false });
    } catch (err) {
      if (isFatal(err)) throw err;
      v = { pass: false, error: err.message };
    }
    metric(e, 'post_merge_verify', at, { outcome: verifyOutcome(v) });
    sleptThrough(m, verifyTimedOut(v), e, 'verify'); // resume finds the merge done and re-verifies
    if (!v.pass) {
      await gitOk(g, ['reset', '-q', '--hard', e.preMergeSha], intWt, 'cannot roll back the failed merge');
      return blocked('post_merge_verify', v.error || 'verify failed on the merged integration branch; merge rolled back');
    }
    // 4. the feature branch is merged; its worktree is no longer needed
    await g(['worktree', 'remove', '--force', wt], root);
    // -D after an explicit ancestry check: -d would compare against the user's HEAD, not integration
    if ((await g(['merge-base', '--is-ancestor', branch, integ], root)).code === 0) await g(['branch', '-D', branch], root);
    return { status: 'passed', reason: null, detail: null };
  }

  // Merges the integration branch into the feature worktree, lets the builder resolve the
  // conflicts once and completes that merge (SPEC §8.10). Returns a blocked outcome or null;
  // on null the feature is verified and evaluated again before the next merge attempt.
  async function resolveConflict(e, contract) {
    const wt = wtOf(e.feature);
    const fail = async (detail) => {
      if ((await revParse(g, 'MERGE_HEAD', wt))) await g(['merge', '--abort'], wt);
      return blocked('merge_conflict', `automatic conflict resolution failed: ${detail}`);
    };
    // 1. the conflicted state, in the feature worktree only (resume keeps a merge in progress)
    if (!e.conflict?.integSha || !(await revParse(g, 'MERGE_HEAD', wt))) {
      const integSha = await revParse(g, `refs/heads/${integ}`, root);
      const r = await g(['merge', '--no-ff', '--no-edit', '-m', `harness: merge ${integ} into harness/${e.feature} (conflict resolution)`, integSha], wt);
      const files = r.code === 0 ? []
        : (await g(['diff', '--name-only', '--diff-filter=U'], wt)).stdout.trim().split(/\r?\n/).filter(Boolean);
      if (r.code !== 0 && files.length === 0) return fail(gitCause(r));
      e.conflict = { integSha, files };
      save();
    }
    const { integSha, files } = e.conflict;
    // 2. one builder call with the conflicting files
    if (files.length) {
      let b;
      const m = meter.mark();
      const at = stamp();
      const who = roleModel(cfg, 'builder', { tier: contract.security_tier, round: e.round, conflict: true });
      try {
        b = await step(e, () => d.build({
          root, cwd: cwdOf(e.feature), featureId: e.feature, round: e.round, attempt: 1, contract,
          findings: [], verifyFailure: null, conflicts: files, config: cfg,
          timeoutSec: stepTimeout, budgetUsd: remainingUsd(), signal, ...who,
        }));
      } catch (err) {
        if (isFatal(err)) throw err;
        b = { ok: false, error: 'exit_nonzero', detail: err.message };
      }
      metric(e, 'conflict_resolve', at, { role: 'builder', who, costUsd: b?.costUsd, outcome: b?.ok ? 'ok' : (b?.error || 'failed') });
      addCost(e, b?.costUsd);
      save();
      d.log(`${e.feature} conflict resolution build: ${b?.ok ? 'ok' : (b?.error || 'failed')}`);
      const over = stopRunOnBudget(e.feature);
      if (over) return over;
      sleptThrough(m, b?.error === 'timeout', e, 'build');
      if (!b?.ok) return fail(`builder ${b?.error || 'failed'}${b?.detail ? ` (${b.detail})` : ''} — conflicts in ${files.join(', ')}`);
      const marked = files.filter((f) => {
        const file = path.join(wt, f);
        return fs.existsSync(file) && fs.statSync(file).isFile() && fs.readFileSync(file, 'utf8').includes('<<<<<<<');
      });
      if (marked.length) return fail(`conflict markers left in ${marked.join(', ')}`);
    }
    // 3. the core completes the merge; the builder may have committed it already
    if (await gitOk(g, ['status', '--porcelain'], wt, 'git status failed')) await gitOk(g, ['add', '-A'], wt, 'git add failed');
    if ((await revParse(g, 'MERGE_HEAD', wt)) || (await gitOk(g, ['status', '--porcelain'], wt, 'git status failed'))) {
      const c = await g(['commit', '-q', '--no-edit', '-m', `harness: merge ${integ} into harness/${e.feature} (conflict resolution)`], wt);
      if (c.code !== 0) return fail(`cannot commit the resolved merge: ${gitCause(c)}`);
    }
    if ((await g(['merge-base', '--is-ancestor', integSha, 'HEAD'], wt)).code !== 0) return fail(`harness/${e.feature} does not contain ${integ} after the resolution`);
    // Verify and eval now judge the feature against the integration commit it contains.
    e.baseSha = integSha;
    e.conflict = null;
    return null;
  }

  async function runOne(e) {
    const contract = loadContract(root, e.feature).contract;
    if (e.stage === 'worktree' && (e.carried ?? 0) >= maxRounds) {
      e.round = e.carried;
      return blocked('max_rounds', `${e.carried} of ${maxRounds} rounds of this contract were already evaluated`);
    }
    if (e.stage === 'worktree') {
      const branch = `harness/${e.feature}`;
      try {
        if (prot.has(branch)) throw new HarnessError(`${branch} is protected`, { code: 'protected_branch' });
        e.baseSha = await worktreeLock(async () => {
          const base = await revParse(g, `refs/heads/${integ}`, root);
          await gitOk(g, ['worktree', 'add', '-b', branch, wtOf(e.feature), base], root, `cannot create worktree for ${e.feature}`);
          return base;
        });
      } catch (err) {
        if (isFatal(err)) throw err;
        return blocked('worktree', err.message);
      }
      e.stage = 'build';
      e.round = (e.carried ?? 0) + 1;
      save();
    } else if (!(await registeredWorktree(g, root, wtOf(e.feature), `harness/${e.feature}`))) {
      return blocked('worktree', `${wtOf(e.feature)} is missing — cannot resume ${e.feature}`);
    }

    let pendingVerify = null;
    for (;;) {
      if (e.stage === 'build') {
        const r = await buildAndVerify(e, contract);
        if (r.status) return r;
        if (!r.verifyResult?.pass) {
          const out = endRound(e, verifyBlocking(r.verifyResult));
          if (out) return out;
          continue;
        }
        pendingVerify = r.verifyResult;
        e.stage = 'eval';
        save();
      }
      if (e.stage === 'eval') {
        if (!pendingVerify) { // resumed at eval: re-establish the verify result
          const m = meter.mark();
          const at = stamp();
          try {
            pendingVerify = await step(e, () => runVerify({ root, cwd: cwdOf(e.feature), featureId: e.feature, base: e.baseSha, config: cfg, signal, cpus: d.cpus }));
          } catch (err) {
            if (isFatal(err)) throw err;
            metric(e, 'verify', at, { outcome: 'error' });
            return blocked('verify_error', err.message);
          }
          metric(e, 'verify', at, { outcome: verifyOutcome(pendingVerify) });
          sleptThrough(m, verifyTimedOut(pendingVerify), e, 'verify');
          if (!pendingVerify.pass) {
            if (e.conflictTried) return blocked('merge_conflict', `verify failed after the automatic conflict resolution: ${blockingIds(verifyBlocking(pendingVerify)).join(', ')}`);
            const out = endRound(e, verifyBlocking(pendingVerify));
            pendingVerify = null;
            if (out) return out;
            continue;
          }
        }
        let v;
        // e.round counts this contract's rounds (the report's number); the verdict file takes
        // the feature's next unused number, so verdicts of earlier contracts stay (SPEC §8).
        const done = verdictRounds(p.verdicts, e.feature);
        const verdictRound = (done.length ? done[done.length - 1] : 0) + 1;
        const m = meter.mark();
        const at = stamp();
        const tier = contract.security_tier;
        try {
          v = await step(e, () => d.evaluate({
            root, cwd: cwdOf(e.feature), featureId: e.feature, round: e.round, verdictRound, base: e.baseSha,
            config: cfg, verifyResult: pendingVerify, runAdapter: d.runAdapter, signal, origin: 'run',
            builders: builderModels(cfg, { tier, round: e.round, conflict: Boolean(e.conflictTried) }),
          }));
        } catch (err) {
          if (isFatal(err)) throw err;
          v = { verdict: 'eval_error', error: err.message };
        }
        metric(e, 'eval', at, { role: 'evaluator', who: roleModel(cfg, 'evaluator', { tier }), costUsd: v?.costUsd, outcome: typeof v?.verdict === 'string' ? v.verdict : 'eval_error' });
        addCost(e, v?.costUsd);
        if (v?.independence) e.independence = v.independence;
        const verdict = v?.verdict;
        d.log(`${e.feature} r${e.round} eval: ${verdict}`);
        const over = stopRunOnBudget(e.feature);
        if (over) return over;
        // eval_error does not consume a round anyway; after sleep it does not count as an error either
        sleptThrough(m, verdict === 'eval_error' && v?.error === 'timeout', e, 'eval');
        if (verdict === 'pass') {
          e.evalErrors = 0;
          if (!e.conflictTried) e.history.push([]); // a resolution re-evaluates the same round
          e.stage = 'merge';
          save();
        } else if (verdict === 'fail' && e.conflictTried) {
          return blocked('merge_conflict', `evaluation failed after the automatic conflict resolution: ${blockingIds(v.blocking || []).join(', ') || 'no finding ids'}`);
        } else if (verdict === 'fail') {
          e.evalErrors = 0;
          pendingVerify = null;
          const out = endRound(e, Array.isArray(v.blocking) ? v.blocking : []);
          if (out) return out;
          continue;
        } else if (verdict === 'eval_error' && v.error === 'adapter_unavailable') {
          // Not a transient error: every later feature needs the same evaluator roles.
          state.stopped = { reason: 'adapter_unavailable', feature: e.feature, detail: `evaluator CLI not available — ${v.detail || 'adapter_unavailable'}` };
          return blocked('adapter_unavailable', v.detail || 'the evaluator CLI is not available');
        } else if (verdict === 'needs-human') {
          return blocked('needs-human', v.error || 'score below threshold without a reproducible finding');
        } else { // eval_error or anything unrecognized: the round is not consumed
          e.evalErrors = num(e.evalErrors) + 1;
          save();
          if (e.evalErrors >= MAX_EVAL_ERRORS) return blocked('eval_error', v?.error || `verdict ${JSON.stringify(verdict)}`);
          continue;
        }
      }
      if (e.stage === 'merge') {
        const out = await mergeLock(() => {
          if (signal.aborted) throw new Interrupted();
          checkHalt(e);
          return merge(e);
        });
        if (!out.resolve) return out;
        // Resolution runs outside the merge lock: other features keep merging meanwhile.
        e.conflictTried = true;
        e.conflict = { integSha: null, files: out.resolve };
        e.stage = 'resolve';
        save();
        d.log(`${e.feature}: merge conflict in ${out.resolve.join(', ')} — one automatic resolution`);
      }
      if (e.stage === 'resolve') {
        const out = await resolveConflict(e, contract);
        if (out) return out;
        pendingVerify = null;
        e.stage = 'eval';
        save();
      }
    }
  }

  const finish = (e, outcome) => {
    const final = outcome.status;
    // A pass resolves the backlog items the contract names (SPEC §7.7), before the status is written.
    if (final === 'passed') resolveItems(p.backlog, loadContract(root, e.feature).contract, e.feature);
    setStatus(root, e.feature, final);
    const result = {
      feature: e.feature, title: e.title, tier: e.tier, status: final, reason: outcome.reason,
      detail: outcome.detail, rounds: e.round, history: e.history, independence: e.independence,
      costUsd: e.costUsd, conflictResolution: e.conflictTried ? (final === 'passed' ? 'resolved' : 'failed') : 'no',
    };
    if (final === 'blocked') {
      if (fs.existsSync(wtOf(e.feature))) result.worktree = path.relative(root, wtOf(e.feature)).split(path.sep).join('/');
      // run_stopped is not a problem of the feature: there is nothing to re-scope.
      if (outcome.reason !== 'run_stopped') appendBacklog(root, rescopeProposal(e, outcome));
    }
    state.results.push(result);
    d.log(`${e.feature}: ${final}${outcome.reason ? ` (${outcome.reason})` : ''}`);
    if (final === 'blocked') {
      const data = loadFeatures(root);
      for (const id of dependentsOf(data.features, e.feature, inScope)) {
        const f = data.features.find((x) => x.id === id);
        f.status = 'skipped';
        state.results.push({ feature: id, title: f.title, tier: f.security_tier, status: 'skipped', reason: `depends on ${e.feature} (blocked)`, detail: null, rounds: 0, history: [], independence: null, costUsd: 0 });
        d.log(`${id}: skipped (depends on ${e.feature})`);
      }
      saveFeatures(root, data);
      if (e.tier === 'critical' && !state.stopped) {
        state.stopped = { reason: 'critical_blocked', feature: e.feature, detail: `critical feature ${e.feature} is blocked (${outcome.reason})` };
      }
    }
    state.active = state.active.filter((x) => x !== e);
    save();
  };

  // Keep the system awake for the run (SPEC §8); where that is not possible the run goes on.
  const noInhibitor = (why) => {
    state.sleepInhibitor = { ok: false, label: why };
    d.log(`sleep inhibitor unavailable: ${why} — the system may sleep during the run`);
  };
  const inhibitor = await startSleepInhibitor({ platform: d.platform, env: d.env, onLost: noInhibitor });
  if (inhibitor.ok) state.sleepInhibitor = { ok: true, label: inhibitor.label };
  else noInhibitor(inhibitor.label);
  meter = sleepMeter({ now: d.now, monotonic: d.monotonic });
  save();
  try {
    return await loop();
  } finally {
    inhibitor.stop();
    meter.stop();
  }

  async function loop() {
    const running = new Map(); // feature id → settled-never-rejects promise
    let failure = null; // the first error that stops the whole run
    const launch = (e) => {
      const pr = runOne(e)
        .catch((err) => { if (err instanceof Halt) return err.outcome; throw err; })
        .then((outcome) => finish(e, outcome))
        .catch((err) => {
          // SIGINT reaches every feature; a fatal error in one stops the others (their steps
          // are redone on resume). The first non-interrupt error decides how the run ends.
          if (!failure || (failure instanceof Interrupted && !(err instanceof Interrupted))) failure = err;
          ac.abort();
        })
        .finally(() => running.delete(e.feature));
      running.set(e.feature, pr);
    };
    const start = () => {
      const busy = new Set(state.active.map((x) => x.feature));
      const done = new Set(state.results.map((r) => r.feature));
      // A dependent of a feature in flight is not executable until that feature has passed
      // (merged and verified), so every candidate is independent of the running ones.
      const next = executableFeatures(root, { statuses: RUN_STATUSES }).find((f) => inScope(f.id) && !busy.has(f.id) && !done.has(f.id));
      if (!next) return false;
      // Earlier verdicts of the current contract hash (interactive eval included) count
      // toward the round limit and the convergence comparison (SPEC §8.8). Reading them
      // all stops on a corrupt one before anything changes (E6).
      const earlier = contractVerdicts(p.verdicts, next.id, hashContract(loadContract(root, next.id).contract));
      const last = earlier.length ? earlier[earlier.length - 1].v : null;
      const e = {
        feature: next.id, title: next.title, tier: next.security_tier, stage: 'worktree', round: 0, attempt: 0,
        history: earlier.map((r) => (r.v.verdict === 'fail' ? verdictBlockingIds(r.v) : [])),
        carried: earlier.length,
        carriedPrev: last?.verdict === 'fail' ? verdictBlockingIds(last) : null,
        findings: last?.verdict === 'fail' && Array.isArray(last.blocking) ? last.blocking : [],
        evalErrors: 0, baseSha: null, preMergeSha: null, independence: null, costUsd: 0,
      };
      state.active.push(e);
      setStatus(root, next.id, 'in_progress');
      save();
      d.log(`${next.id}: start`);
      launch(e);
      return true;
    };

    // Resume: every feature that was in flight continues, whatever the slot count.
    for (const e of state.active) launch(e);
    for (;;) {
      try {
        while (!failure && !state.stopped && !signal.aborted && running.size < maxParallel && start()) { /* fill free slots */ }
      } catch (err) {
        failure = failure ?? err;
        ac.abort();
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
    }
    outer?.removeEventListener('abort', onOuter);

    if (failure) {
      if (failure instanceof Interrupted) {
        save();
        return { interrupted: true, results: state.results, stopped: null, costUsd: state.costUsd, report: null, statePath };
      }
      if (failure instanceof SystemSleep) {
        save(); // the features keep their status and the round its attempts: resume redoes the step
        d.log(`${failure.feature} ${failure.stage} timed out after system sleep (~${failure.sleptSec}s asleep) — run stopped, state saved; continue with: harness run --resume`);
        const sleep = { feature: failure.feature, stage: failure.stage, sleptSec: failure.sleptSec };
        return { interrupted: true, sleep, results: state.results, stopped: null, costUsd: state.costUsd, report: null, statePath };
      }
      save();
      throw failure;
    }

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
    fs.writeFileSync(report, renderReport(state, { finishedAt: d.now().toISOString(), notRun, metrics }));
    await g(['worktree', 'remove', intWt], root); // best effort; kept if dirty
    fs.rmSync(statePath, { force: true });
    return { interrupted: false, results: state.results, stopped: state.stopped, costUsd: state.costUsd, report, statePath, notRun };
  }
}
