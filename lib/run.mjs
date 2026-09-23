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
import { loadConfig, validateUser } from './config.mjs';
import { executableFeatures, loadContract } from './contract.mjs';
import { runCommand } from './exec.mjs';
import { verify as realVerify } from './verify.mjs';

export const MAX_BUILD_ATTEMPTS = 3; // build retries per round when verify fails (SPEC §8.3)
export const MAX_EVAL_ERRORS = 2; // consecutive eval_error verdicts before blocked (SPEC §7.3)
export const INTEGRATION_WT = '_integration';
const GIT_TIMEOUT_SEC = 300;
const STATE_VERSION = 1;

class Interrupted extends Error {
  constructor() { super('interrupted'); this.name = 'Interrupted'; }
}

// ------------------------------------------------------------------ convergence (pure)

const idOf = (x) => (typeof x === 'string' ? x : x?.criterion_id);

/** Distinct blocking criterion ids of a round: an id array, a finding array, or {blocking}. */
export function blockingIds(round) {
  const list = Array.isArray(round) ? round : (round?.blocking ?? []);
  return [...new Set(list.map(idOf).filter((id) => typeof id === 'string' && id))];
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

async function git(args, cwd) {
  const r = await runCommand({ file: 'git', args: [...coreGitArgs(), ...args] }, { cwd, timeoutSec: GIT_TIMEOUT_SEC });
  if (r.error === 'ENOENT') throw new HarnessError('git is not installed or not on PATH', { code: 'git_missing' });
  return r;
}

const gitCause = (r) => (r.stderr || r.stdout || r.error || (r.timedOut ? 'timed out' : `exit ${r.code}`)).trim();

async function gitOk(args, cwd, what) {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new HarnessError(`${what}: ${gitCause(r)}`, { code: 'git' });
  return r.stdout.trim();
}

async function revParse(ref, cwd) {
  const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
  return r.code === 0 ? r.stdout.trim() : null;
}

function canonical(p) {
  let out = path.resolve(p);
  try { out = fs.realpathSync.native(out); } catch { /* not created yet */ }
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

// [{path, branch}] from `git worktree list --porcelain`.
async function listWorktrees(cwd) {
  const text = await gitOk(['worktree', 'list', '--porcelain'], cwd, 'git worktree list failed');
  const list = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) list.push({ path: line.slice('worktree '.length), branch: null });
    else if (line.startsWith('branch ') && list.length) list[list.length - 1].branch = line.slice('branch '.length);
  }
  return list;
}

async function registeredWorktree(cwd, dir, branch) {
  const want = canonical(dir);
  return (await listWorktrees(cwd)).some((w) => canonical(w.path) === want && w.branch === `refs/heads/${branch}`);
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

async function defaultEvaluate(args) {
  const { evaluate } = await import('./eval.mjs');
  return evaluate(args);
}

// The builder role gets the frozen contract plus what failed last (SPEC §8.2).
export function builderPrompt({ rolePrompt, featureId, round, attempt, contract, findings, verifyFailure }) {
  const parts = [rolePrompt.trim(), '', `# Task: feature ${featureId}, round ${round}, attempt ${attempt}`, '',
    'Frozen contract:', '```json', JSON.stringify(contract, null, 2), '```'];
  if (findings?.length) {
    parts.push('', 'Blocking findings from the previous round (fix these first):', '```json', JSON.stringify(findings, null, 2), '```');
  }
  if (verifyFailure) {
    parts.push('', 'Deterministic verification failed on the previous attempt:', '```json', JSON.stringify(verifyFailure, null, 2), '```');
  }
  return parts.join('\n') + '\n';
}

async function defaultBuild({ cwd, featureId, round, attempt, contract, findings, verifyFailure, config, timeoutSec, budgetUsd, signal }) {
  const { getAdapter, resolveRole } = await import('./adapters/index.mjs');
  const { loadRolePrompt } = await import('./roles.mjs');
  const { adapter: name, model } = resolveRole(config.roles?.builder, config);
  const adapter = name ? getAdapter(name, config) : null;
  if (!adapter) return { ok: false, error: 'adapter_unavailable', detail: `builder adapter '${name}' is unknown`, costUsd: null };
  const prompt = builderPrompt({ rolePrompt: loadRolePrompt('builder'), featureId, round, attempt, contract, findings, verifyFailure });
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
  merge_conflict: 'the feature branch conflicts with the integration branch',
  post_merge_verify: 'verify failed on the integration branch after the merge',
  budget: 'a step timed out or the budget was exhausted',
  'needs-human': 'the evaluator scored below threshold without a reproducible finding',
  eval_error: 'the evaluator failed twice in a row',
  worktree: 'the feature worktree could not be created',
  adapter_unavailable: 'the builder CLI is not available',
  verify_error: 'verify could not run',
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
  const file = paths(root).backlog;
  const data = readJson(file, { optional: true }) ?? { items: [] };
  if (!data || !Array.isArray(data.items)) {
    throw new HarnessError(`${file}: expected { "items": [...] }`, { code: 'state_corrupt' });
  }
  data.items.push(item);
  writeJsonAtomic(file, data);
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

function validateState(s, file) {
  const ok = s && typeof s === 'object' && s.version === STATE_VERSION && typeof s.runId === 'string'
    && Array.isArray(s.results) && s.config && typeof s.config === 'object'
    && (s.current === null || (typeof s.current === 'object' && typeof s.current.feature === 'string'
      && Number.isInteger(s.current.round) && typeof s.current.stage === 'string' && Array.isArray(s.current.history)));
  if (!ok) throw new HarnessError(`${file}: not a valid run state — fix or delete it; harness will not guess`, { code: 'state_corrupt' });
}

// ------------------------------------------------------------------ report

function mdCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderReport(state, { finishedAt, notRun = [] }) {
  const cfg = state.config;
  const lines = [`# harness run ${state.runId}`, '',
    `- started: ${state.startedAt}`, `- finished: ${finishedAt}`,
    `- scope: ${state.scope ? state.scope.join(', ') : 'all approved features'}`,
    `- integration branch: \`${cfg.integration_branch}\` (from \`${cfg.base_branch}\`)`,
    `- total cost: $${num(state.costUsd).toFixed(2)}${state.maxUsd != null ? ` of $${state.maxUsd} run budget` : ''}`,
    `- stopped: ${state.stopped ? `${state.stopped.reason}${state.stopped.feature ? ` (${state.stopped.feature})` : ''}${state.stopped.detail ? ` — ${state.stopped.detail}` : ''}` : 'no — ran to completion'}`,
    '', '## Features', '',
    '| Feature | Result | Rounds | Independence | Cost (USD) | Blocked reason |',
    '|---------|--------|--------|--------------|------------|----------------|'];
  for (const r of state.results) {
    lines.push(`| ${mdCell(r.feature)} ${mdCell(r.title)} | ${r.status} | ${r.rounds ?? 0} | ${mdCell(r.independence ?? '-')} | ${num(r.costUsd).toFixed(2)} | ${mdCell(r.status === 'blocked' ? `${r.reason}${r.detail ? `: ${r.detail}` : ''}` : r.status === 'skipped' ? r.reason : '')} |`);
  }
  if (state.results.length === 0) lines.push('| (none) | | | | | |');
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

/**
 * Runs approved features to passed / blocked / skipped (SPEC §8).
 * @param {{root:string, config?:object, ids?:string[], resume?:boolean, maxUsd?:number,
 *   signal?:AbortSignal, deps?:{build?,verify?,evaluate?,now?,log?,runAdapter?,git?}}} opts
 *   deps.git is the git runner for the pre-run integration branch checks.
 * @returns {Promise<{interrupted:boolean, results:object[], stopped:object|null, costUsd:number, report:string|null, statePath:string}>}
 */
export async function runFeatures({ root, config, ids, resume = false, maxUsd, signal, deps = {} } = {}) {
  const d = {
    build: defaultBuild, verify: realVerify, evaluate: defaultEvaluate,
    now: () => new Date(), log: () => {}, git, ...deps,
  };
  const p = paths(root);
  const statePath = path.join(p.runs, 'current.json');

  let state;
  if (resume) {
    if (ids?.length) throw new HarnessError('--resume continues the saved run; do not pass feature ids', { code: 'usage' });
    state = readJson(statePath, { optional: true });
    if (state === undefined) throw new HarnessError(`nothing to resume — ${statePath} does not exist`, { code: 'no_run' });
    validateState(state, statePath);
    if (maxUsd !== undefined && maxUsd !== null) state.maxUsd = maxUsd;
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
      costUsd: 0,
      results: [],
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
  const maxRounds = Number.isInteger(cfg.max_rounds) && cfg.max_rounds > 0 ? cfg.max_rounds : 3;
  const stepTimeout = cfg.budget?.step_timeout_sec ?? 1800;
  const stepUsd = cfg.budget?.step_usd ?? null;
  const save = () => writeJsonAtomic(statePath, state);

  // Refuse before touching anything (SR-5).
  const top = await gitOk(['rev-parse', '--show-toplevel'], root, `${root} is not inside a git repository`);
  const projectRel = path.relative(canonical(top), canonical(root));
  await assertIntegrationAllowed(cfg, root, { runGit: d.git });
  const integ = cfg.integration_branch;
  const prot = protectedSet(cfg);

  if (!(await revParse(`refs/heads/${integ}`, root))) {
    const baseSha = await revParse(cfg.base_branch, root);
    if (!baseSha) throw new HarnessError(`base branch '${cfg.base_branch}' not found — cannot create '${integ}'`, { code: 'base_missing' });
    await gitOk(['branch', integ, baseSha], root, `cannot create integration branch '${integ}'`);
    d.log(`created integration branch ${integ} from ${cfg.base_branch}`);
  }
  // A dedicated worktree for merges: the user's own worktree never changes branch.
  const intWt = path.join(p.worktrees, INTEGRATION_WT);
  if (!(await registeredWorktree(root, intWt, integ))) {
    if (fs.existsSync(intWt)) throw new HarnessError(`${intWt} exists but is not a worktree of '${integ}' — remove it`, { code: 'worktree' });
    fs.mkdirSync(p.worktrees, { recursive: true });
    await gitOk(['worktree', 'add', intWt, integ], root, `cannot create the integration worktree for '${integ}' (is it checked out elsewhere?)`);
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

  // Races a step against SIGINT: an interrupted step is redone on resume.
  const step = async (fn) => {
    if (signal?.aborted) throw new Interrupted();
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
    state.stopped = { reason: 'budget', feature, detail: `run cost $${state.costUsd.toFixed(2)} exceeds $${state.maxUsd}` };
    return blocked('budget', state.stopped.detail);
  };
  const isFatal = (err) => err instanceof Interrupted || (err instanceof HarnessError && err.code === 'state_corrupt');

  // Closes a failing round; returns a blocked outcome or null to continue with round+1.
  const endRound = (e, blocking) => {
    const ids = blockingIds(blocking);
    const prev = e.history.length ? e.history[e.history.length - 1] : null;
    e.history.push(ids);
    e.findings = blocking;
    const c = convergence(prev, ids);
    if (c.blocked) return blocked(c.blocked, `${c.blocked === 'divergence' ? 'newly blocking' : 'still blocking'}: ${c.ids.join(', ') || '(none)'}`, { ids: c.ids });
    if (e.round >= maxRounds) return blocked('max_rounds', `round ${e.round} of ${maxRounds} ended with ${ids.join(', ') || 'a failing verdict'}`);
    e.round += 1;
    e.stage = 'build';
    e.attempt = 0;
    e.attemptsDone = 0;
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
      let b;
      try {
        b = await step(() => d.build({
          root, cwd: cwdOf(e.feature), featureId: e.feature, round: e.round, attempt, contract,
          findings: e.findings, verifyFailure: verifyFailureSummary(last), config: cfg,
          timeoutSec: stepTimeout, budgetUsd: remainingUsd(), signal,
        }));
      } catch (err) {
        if (isFatal(err)) throw err;
        b = { ok: false, error: 'exit_nonzero', detail: err.message };
      }
      addCost(e, b?.costUsd);
      save();
      d.log(`${e.feature} r${e.round} build ${attempt}/${MAX_BUILD_ATTEMPTS}: ${b?.ok ? 'ok' : (b?.error || 'failed')}`);
      const over = stopRunOnBudget(e.feature);
      if (over) return over;
      if (b?.error === 'timeout') return blocked('budget', `build timed out after ${stepTimeout}s`);
      if (stepUsd !== null && num(b?.costUsd) >= stepUsd) return blocked('budget', `build cost $${num(b?.costUsd).toFixed(2)} reached the step budget $${stepUsd}`);
      if (b?.error === 'adapter_unavailable') return blocked('adapter_unavailable', b.detail);
      try {
        last = await step(() => d.verify({ root, cwd: cwdOf(e.feature), featureId: e.feature, base: e.baseSha, config: cfg, signal }));
      } catch (err) {
        if (isFatal(err)) throw err;
        return blocked('verify_error', err.message);
      }
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
    const dirty = await gitOk(['status', '--porcelain'], wt, 'git status failed');
    if (dirty) {
      await gitOk(['add', '-A'], wt, 'git add failed');
      await gitOk(['commit', '-q', '-m', `harness: ${e.feature} round ${e.round} builder changes`], wt, 'commit of builder changes failed');
    }
    // 2. merge in the dedicated integration worktree, never a protected branch
    const head = await gitOk(['symbolic-ref', '--short', 'HEAD'], intWt, 'integration worktree has no branch');
    if (head !== integ || prot.has(head)) throw new HarnessError(`integration worktree is on '${head}', expected '${integ}' — refusing to merge (SR-5)`, { code: 'protected_branch' });
    const alreadyMerged = e.preMergeSha
      && (await git(['merge-base', '--is-ancestor', branch, 'HEAD'], intWt)).code === 0
      && (await revParse('HEAD', intWt)) !== e.preMergeSha;
    if (!alreadyMerged) {
      if (await gitOk(['status', '--porcelain'], intWt, 'git status failed')) {
        throw new HarnessError(`integration worktree ${intWt} has uncommitted changes — clean it before running`, { code: 'worktree' });
      }
      e.preMergeSha = await revParse('HEAD', intWt);
      save();
      const r = await git(['merge', '--no-ff', '--no-edit', '-m', `harness: merge ${e.feature} (round ${e.round})`, branch], intWt);
      if (r.code !== 0) {
        const conflicts = (await git(['diff', '--name-only', '--diff-filter=U'], intWt)).stdout.trim().split(/\r?\n/).filter(Boolean);
        await git(['merge', '--abort'], intWt);
        const clean = !(await gitOk(['status', '--porcelain'], intWt, 'git status failed'));
        const detail = conflicts.length ? `conflicts in ${conflicts.join(', ')}` : gitCause(r);
        return blocked('merge_conflict', `${detail}${clean ? '' : ' (integration worktree left dirty — clean it by hand)'}`);
      }
    }
    // 3. verify what was actually merged (the structural backstop, SPEC §7.3 D1)
    let v;
    try {
      v = await step(() => d.verify({ root, cwd: intCwd, featureId: e.feature, base: e.preMergeSha, config: cfg, signal }));
    } catch (err) {
      if (isFatal(err)) throw err;
      v = { pass: false, error: err.message };
    }
    if (!v.pass) {
      await gitOk(['reset', '-q', '--hard', e.preMergeSha], intWt, 'cannot roll back the failed merge');
      return blocked('post_merge_verify', v.error || 'verify failed on the merged integration branch; merge rolled back');
    }
    // 4. the feature branch is merged; its worktree is no longer needed
    await git(['worktree', 'remove', '--force', wt], root);
    // -D after an explicit ancestry check: -d would compare against the user's HEAD, not integration
    if ((await git(['merge-base', '--is-ancestor', branch, integ], root)).code === 0) await git(['branch', '-D', branch], root);
    return { status: 'passed', reason: null, detail: null };
  }

  async function runOne(e) {
    const contract = loadContract(root, e.feature).contract;
    if (e.stage === 'worktree') {
      const branch = `harness/${e.feature}`;
      try {
        if (prot.has(branch)) throw new HarnessError(`${branch} is protected`, { code: 'protected_branch' });
        const base = await revParse(`refs/heads/${integ}`, root);
        await gitOk(['worktree', 'add', '-b', branch, wtOf(e.feature), base], root, `cannot create worktree for ${e.feature}`);
        e.baseSha = base;
      } catch (err) {
        if (isFatal(err)) throw err;
        return blocked('worktree', err.message);
      }
      e.stage = 'build';
      e.round = 1;
      save();
    } else if (!(await registeredWorktree(root, wtOf(e.feature), `harness/${e.feature}`))) {
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
          try {
            pendingVerify = await step(() => d.verify({ root, cwd: cwdOf(e.feature), featureId: e.feature, base: e.baseSha, config: cfg, signal }));
          } catch (err) {
            if (isFatal(err)) throw err;
            return blocked('verify_error', err.message);
          }
          if (!pendingVerify.pass) {
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
        try {
          v = await step(() => d.evaluate({
            root, cwd: cwdOf(e.feature), featureId: e.feature, round: e.round, verdictRound, base: e.baseSha,
            config: cfg, verifyResult: pendingVerify, runAdapter: d.runAdapter, signal, origin: 'run',
          }));
        } catch (err) {
          if (isFatal(err)) throw err;
          v = { verdict: 'eval_error', error: err.message };
        }
        addCost(e, v?.costUsd);
        if (v?.independence) e.independence = v.independence;
        const verdict = v?.verdict;
        d.log(`${e.feature} r${e.round} eval: ${verdict}`);
        const over = stopRunOnBudget(e.feature);
        if (over) return over;
        if (verdict === 'pass') {
          e.evalErrors = 0;
          e.history.push([]);
          e.stage = 'merge';
          save();
        } else if (verdict === 'fail') {
          e.evalErrors = 0;
          pendingVerify = null;
          const out = endRound(e, Array.isArray(v.blocking) ? v.blocking : []);
          if (out) return out;
          continue;
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
        if (signal?.aborted) throw new Interrupted();
        return merge(e);
      }
    }
  }

  const finish = (e, outcome) => {
    const final = outcome.status;
    setStatus(root, e.feature, final);
    const result = {
      feature: e.feature, title: e.title, tier: e.tier, status: final, reason: outcome.reason,
      detail: outcome.detail, rounds: e.round, history: e.history, independence: e.independence,
      costUsd: e.costUsd,
    };
    if (final === 'blocked') {
      if (fs.existsSync(wtOf(e.feature))) result.worktree = path.relative(root, wtOf(e.feature)).split(path.sep).join('/');
      appendBacklog(root, rescopeProposal(e, outcome));
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
    state.current = null;
    save();
  };

  try {
    while (!state.stopped) {
      if (!state.current) {
        const next = executableFeatures(root).find((f) => inScope(f.id));
        if (!next) break;
        state.current = {
          feature: next.id, title: next.title, tier: next.security_tier, stage: 'worktree', round: 0, attempt: 0,
          history: [], findings: [], evalErrors: 0, baseSha: null, preMergeSha: null, independence: null, costUsd: 0,
        };
        setStatus(root, next.id, 'in_progress');
        save();
        d.log(`${next.id}: start`);
      }
      const e = state.current;
      finish(e, await runOne(e));
    }
  } catch (err) {
    if (err instanceof Interrupted) {
      save();
      return { interrupted: true, results: state.results, stopped: null, costUsd: state.costUsd, report: null, statePath };
    }
    throw err;
  }

  // Report, then drop the resumable state.
  const all = loadFeatures(root).features;
  const done = new Set(state.results.map((r) => r.feature));
  const notRun = all.filter((f) => inScope(f.id) && !done.has(f.id) && (state.scope || f.status === 'approved')).map((f) => ({
    id: f.id,
    why: f.status !== 'approved' ? `status is ${f.status}`
      : state.stopped ? 'run stopped before it'
        : 'not executable (dependencies not passed or contract not frozen)',
  }));
  const report = path.join(p.runs, `${state.runId}.md`);
  fs.mkdirSync(p.runs, { recursive: true });
  fs.writeFileSync(report, renderReport(state, { finishedAt: d.now().toISOString(), notRun }));
  await git(['worktree', 'remove', intWt], root); // best effort; kept if dirty
  fs.rmSync(statePath, { force: true });
  return { interrupted: false, results: state.results, stopped: state.stopped, costUsd: state.costUsd, report, statePath, notRun };
}
