// `harness run` — autonomous build → verify → eval → merge with guaranteed convergence (SPEC §8).
// The loop is code, not a prompt: a round cap, a strictly shrinking blocking set and
// divergence detection make an unbounded evaluator loop impossible. The core never
// pushes and never merges into main or a protected branch (SR-5); a human merges
// integration → main.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HarnessError } from './errors.mjs';
import { HARNESS_DIR, paths, readJson, writeJsonAtomic, loadFeatures, saveFeatures, verdictRounds, setFeatureStatus } from './state.mjs';
import { TEST_COUNT_CACHE } from './testcount.mjs';
import { VERIFY_CACHE } from './verify-cache.mjs';
import { loadConfig, validateUser, isMaxParallel, isParallelSetting, availableCpus, gitTimeoutOf, maxRoundsOf } from './config.mjs';
import { executableFeatures, loadContract, hashContract } from './contract.mjs';
import { contractVerdicts, extraRoundsOf } from './eval.mjs';
import { runCommand, gitTimeoutError } from './exec.mjs';
import { FAILURE_MESSAGE_CHARS, redactor, redactDeep, verifyFailures, MAX_FLAKY_TESTS } from './failures.mjs';
import { appendItem, resolveItems, recordFlakyTests } from './backlog.mjs';
import { verify as realVerify, criteriaStatus as realCriteriaStatus } from './verify.mjs';
import { startSleepInhibitor, sleepMeter, SLEEP_THRESHOLD_MS } from './sleep.mjs';
import { roleCall, builderModels } from './adapters/index.mjs';
import { appendMetric, readMetricsFile, METRIC_SUFFIX } from './metrics.mjs';
import { makeTempDir } from './tmp.mjs';
import { recordEvent } from './events.mjs';
import { stageOfRole, stepEventData, sumUsage, usageOf, modelMismatch, mismatchWarning } from './usage.mjs';

export const MAX_BUILD_ATTEMPTS = 3; // build retries per round when verify fails (SPEC §8.3)
export const MAX_EVAL_ERRORS = 2; // consecutive eval_error verdicts before blocked (SPEC §7.3)
export const INTEGRATION_WT = '_integration';
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

// A verify command, test_count or criterion check whose program is not installed (SPEC §8):
// the environment, not the feature, is at fault. The run stops resumably; nothing is blocked.
class EnvironmentStop extends Error {
  constructor(feature, stage, failure) {
    super(`command not found: ${failure.program}`);
    this.name = 'EnvironmentStop';
    Object.assign(this, { feature, stage, item: failure.item, program: failure.program });
  }
}

// A role CLI reported its usage limit (SPEC §8): the account, not the feature, is at fault.
// The run stops resumably like an environment stop; nothing is blocked or consumed.
class UsageLimitStop extends Error {
  constructor(feature, stage, detail) {
    super(`usage limit: ${detail}`);
    this.name = 'UsageLimitStop';
    Object.assign(this, { feature, stage, detail });
  }
}

// Another feature stopped the run on the environment: this one stops before its next step
// and stays in the state file (SPEC §8.10).
class Paused extends Error {
  constructor() { super('paused'); this.name = 'Paused'; }
}

/** The first "command not found" of a verify result: {item, program} or null. */
export function environmentFailure(v) {
  for (const c of v?.commands || []) if (!c.pass && c.notFound) return { item: c.cmd, program: c.notFound };
  const tc = v?.integrity?.testCount;
  if (tc?.notFound) return { item: 'test_count', program: tc.notFound };
  for (const c of v?.criteria || []) if (!c.pass && c.notFound) return { item: c.id, program: c.notFound };
  return null;
}

export { FAILURE_MESSAGE_CHARS };

// Values the run state is read back by (config snapshot, ids, commits, conflicted files):
// they never hold command output and are saved as they are.
const KEEP_UNREDACTED = new Set(['config', 'runId', 'startedAt', 'scope', 'feature', 'title', 'history', 'carriedPrev',
  'criterion_id', 'baseSha', 'preMergeSha', 'preMerged', 'integSha', 'files', 'preMergeHead', 'snapshot', 'fresh', 'takeover', 'carriedCommit']);

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
// One per process, removed when the process exits (tmp.mjs).
function hooksOff() {
  if (!noHooksDir || !fs.existsSync(noHooksDir)) noHooksDir = makeTempDir('harness-no-hooks-');
  return noHooksDir;
}

// Commits and merges the core makes are authored by the core, unsigned, hook-free.
const coreGitArgs = () => ['-c', `core.hooksPath=${hooksOff()}`, '-c', 'core.quotePath=false',
  '-c', 'commit.gpgsign=false', '-c', 'user.name=cc-harness', '-c', 'user.email=cc-harness@localhost'];

/**
 * The core git runner: `git(args, cwd, {timeoutSec})` → {code, stdout, stderr}.
 * timeoutSec is budget.git_timeout_sec; past it the command's tree is killed and this throws.
 */
export async function git(args, cwd, { timeoutSec = gitTimeoutOf(null) } = {}) {
  const r = await runCommand({ file: 'git', args: [...coreGitArgs(), ...args] }, { cwd, timeoutSec });
  if (r.error === 'ENOENT') throw new HarnessError('git is not installed or not on PATH', { code: 'git_missing' });
  if (r.timedOut) throw gitTimeoutError(args, timeoutSec);
  return r;
}

/**
 * Git calls that change worktrees, branches, merge state, the index or commits. A run makes them
 * one at a time (SPEC §8.10): concurrent `worktree add`/`branch`/`merge`/`add`/`commit`/`reset --hard`
 * calls race on shared repository files (refs, objects, worktree metadata).
 */
export function isSerializedGit(args) {
  const [cmd, sub] = args;
  if (cmd === 'worktree') return sub === 'add' || sub === 'remove' || sub === 'prune';
  if (cmd === 'reset') return args.includes('--hard');
  return cmd === 'branch' || cmd === 'merge' || cmd === 'checkout' || cmd === 'switch' || cmd === 'add' || cmd === 'commit';
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

// Paths that differ from HEAD in a worktree — staged, unstaged, unmerged or untracked — from
// the top of the worktree. -z: no quoting; a rename or copy entry is followed by its source path.
async function dirtyPaths(run, cwd) {
  const r = await run(['status', '--porcelain', '-z', '--untracked-files=all'], cwd);
  if (r.code !== 0) throw new HarnessError(`git status failed: ${gitCause(r)}`, { code: 'git' });
  const tokens = r.stdout.split('\0');
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].length < 4) continue;
    out.push(tokens[i].slice(3));
    if (tokens[i][0] === 'R' || tokens[i][0] === 'C') i += 1;
  }
  return out;
}

// Paths a feature worktree changed against `base` — committed since, staged, unstaged or
// untracked — for the continuation of a timed-out build (SPEC §8). Names only, sorted.
async function changedFromBase(run, cwd, base) {
  const r = await run(['diff', '--name-only', '-z', base, 'HEAD'], cwd);
  if (r.code !== 0) throw new HarnessError(`git diff failed: ${gitCause(r)}`, { code: 'git' });
  return [...new Set([...r.stdout.split('\0').filter(Boolean), ...(await dirtyPaths(run, cwd))])].sort();
}

// Content hash of a regular file; null when it is missing or not a file.
function contentHash(file) {
  try {
    return fs.statSync(file).isFile() ? crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex') : null;
  } catch {
    return null;
  }
}

// {path: content hash} of every path that differs from HEAD: where a conflict resolution starts.
async function worktreeSnapshot(run, cwd) {
  return Object.fromEntries((await dirtyPaths(run, cwd)).map((f) => [f, contentHash(path.join(cwd, f))]));
}

// Paths the conflict resolution changed (SPEC §8.10): paths that differ from the pre-merge HEAD
// now (in the worktree, or in commits made since) and whose content is not what `snapshot`
// recorded. Without a snapshot (a state file written before F38) every such path counts.
async function changedSince(run, cwd, { preMergeHead, snapshot }) {
  const paths = new Set(await dirtyPaths(run, cwd));
  const head = await revParse(run, 'HEAD', cwd);
  if (preMergeHead && head && head !== preMergeHead) {
    const d = await run(['diff', '--name-only', '-z', preMergeHead, head], cwd);
    if (d.code !== 0) throw new HarnessError(`git diff failed: ${gitCause(d)}`, { code: 'git' });
    for (const f of d.stdout.split('\0')) if (f) paths.add(f);
  }
  if (!snapshot) return [...paths];
  return [...paths].filter((f) => !Object.hasOwn(snapshot, f) || snapshot[f] !== contentHash(path.join(cwd, f)));
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
 * Throws (exit 2) unless integration_branch is spelled as a short branch name. 'refs/…' and
 * 'heads/…' pass `git check-ref-format --branch` but name refs/heads/refs/… and a branch the
 * merge-time HEAD check cannot match, so the run would stop only after building (SPEC §8).
 */
export function assertIntegrationName(config) {
  const integ = config.integration_branch;
  if (typeof integ !== 'string' || !integ || integ.startsWith('-')) {
    throw new HarnessError(`integration_branch must be a branch name (got ${JSON.stringify(integ)})`, { code: 'config' });
  }
  if (integ.startsWith('refs/') || integ.startsWith('heads/')) {
    throw new HarnessError(`integration_branch '${integ}' must be a short branch name, not a ref path starting with 'refs/' or 'heads/' (for example 'harness/integration')`, { code: 'config_invalid' });
  }
}

/**
 * Throws unless the integration branch is a legal, unprotected merge target.
 * `runGit(args, cwd)` → {code, stdout, stderr} is the git runner (injectable for tests).
 */
export async function assertIntegrationAllowed(config, cwd, { runGit = git } = {}) {
  const integ = config.integration_branch;
  const prot = protectedSet(config);
  assertIntegrationName(config);
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
  // Only the role adapters: probing every installed CLI (gemini takes seconds) gains the run nothing.
  const report = await diagnose({ config, rolesOnly: true });
  const bad = roles.map((role) => {
    const r = (report?.roles || []).find((x) => x.role === role);
    if (r?.usable) return null;
    return `${role}${r?.adapter ? ` (${r.adapter})` : ''}: ${r?.reason || 'not reported by doctor'}`;
  }).filter(Boolean);
  if (bad.length) {
    throw new HarnessError(`run preflight failed — role not usable:\n  ${bad.join('\n  ')}\nnothing was started; fix the roles (see \`harness doctor\`) and run again`, { code: 'preflight' });
  }
}

/**
 * The security tier a run acts on (SPEC §8): the approved contract's, not the features.json copy.
 * A feature without a contract keeps its features.json tier. `mismatch` is the features.json
 * tier when it differs from the contract's, else null.
 */
export function effectiveTier(root, feature) {
  let contract;
  try {
    contract = loadContract(root, feature.id).contract;
  } catch (e) {
    if (e instanceof HarnessError && e.code === 'unknown_contract') return { tier: feature.security_tier, mismatch: null };
    throw e;
  }
  const tier = contract.security_tier ?? 'standard';
  const listed = feature.security_tier ?? 'standard';
  return { tier, mismatch: listed !== tier ? listed : null };
}

const tierWarning = (id, t) => `warning: ${id} security_tier is '${t.mismatch}' in features.json but '${t.tier}' in the approved contract — the run uses the contract's '${t.tier}'`;

async function defaultEvaluate(args) {
  const { evaluate } = await import('./eval.mjs');
  return evaluate(args);
}

// The changed-file list of a continued or carried-over build (SPEC §8): at most
// MAX_PROMPT_FILES paths, then '… N more'. A path with a control character (a newline could
// change the prompt's layout) is written as a JSON string with those characters escaped.
export const MAX_PROMPT_FILES = 100;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// eslint-disable-next-line no-control-regex
const UNESCAPED = /[\u007f-\u009f\u2028\u2029]/g; // left as is by JSON.stringify
const promptPath = (f) => (CONTROL.test(f)
  ? JSON.stringify(f).replace(UNESCAPED, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  : f);
function fileList(files) {
  const lines = files.slice(0, MAX_PROMPT_FILES).map((f) => `- ${promptPath(String(f))}`);
  if (files.length > MAX_PROMPT_FILES) lines.push(`… ${files.length - MAX_PROMPT_FILES} more`);
  return lines;
}

// The builder role gets the frozen contract plus what failed last (SPEC §8.2).
export function builderPrompt({ rolePrompt, featureId, round, attempt, contract, findings, verifyFailure, conflicts, postMergeFailures, continuation, carriedWork, criteriaStatus }) {
  const parts = [rolePrompt.trim(), '', `# Task: feature ${featureId}, round ${round}, attempt ${attempt}`, '',
    'Frozen contract:', '```json', JSON.stringify(contract, null, 2), '```'];
  if (findings?.length) {
    parts.push('', 'Blocking findings from the previous round (fix these first):', '```json', JSON.stringify(findings, null, 2), '```');
  }
  if (verifyFailure) {
    parts.push('', 'Deterministic verification failed on the previous attempt:', '```json', JSON.stringify(verifyFailure, null, 2), '```');
  }
  if (carriedWork?.files?.length) {
    parts.push('', '# Work carried from a previous attempt',
      `The work of a previous attempt at this feature (an earlier run that was blocked) is in this working tree,`,
      `on branch harness/${featureId}. Continue from it and finish the feature against the contract above instead`,
      'of starting over; change or drop whatever the contract no longer asks for. Files changed against the base:',
      ...fileList(carriedWork.files));
  }
  if (continuation?.files?.length) {
    parts.push('', '# Continuation of a timed-out build',
      'The previous attempt timed out before it finished. Its work is still in this working tree; continue',
      'from it and finish the feature instead of starting over. Files changed against the base:',
      ...fileList(continuation.files));
  }
  if (criteriaStatus?.length) {
    parts.push('', '# Criterion status in this working tree',
      "The harness ran each criterion's check in this working tree just before this attempt:",
      ...criteriaStatus.map((c) => `- ${c.id}: ${c.status}`));
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
  if (postMergeFailures?.length) {
    parts.push('', '# Post-merge verification failure',
      'The feature passed evaluation, but verify failed on the integration branch after the merge, so the',
      'merge was rolled back. The integration branch has been merged into this worktree; these items failed:',
      '```json', JSON.stringify(postMergeFailures, null, 2), '```',
      'Fix the cause so that both this feature and the changes already on the integration branch pass verify.',
      'Do not commit; the harness verifies and evaluates the result again before merging.');
  }
  return parts.join('\n') + '\n';
}

// `adapter`/`model`/`effort` are what the run chose for this call (SPEC §10 role model policy).
// `redact` is the run's redaction (SR-8), applied to an adapter error before it is cut (SR-9).
async function defaultBuild({ cwd, featureId, round, attempt, contract, findings, verifyFailure, conflicts, postMergeFailures, continuation, carriedWork, criteriaStatus, config, timeoutSec, budgetUsd, signal, redact, adapter: chosen, model: chosenModel, effort: chosenEffort }) {
  const { getAdapter, roleCall: policy } = await import('./adapters/index.mjs');
  const { loadRolePrompt } = await import('./roles.mjs');
  const { adapter: name, model, effort } = chosen !== undefined
    ? { adapter: chosen, model: chosenModel ?? null, effort: chosenEffort ?? null }
    : policy(config, 'builder', { tier: contract?.security_tier, round, conflict: Boolean(conflicts?.length) });
  const adapter = name ? getAdapter(name, config) : null;
  if (!adapter) return { ok: false, error: 'adapter_unavailable', detail: `builder adapter '${name}' is unknown`, costUsd: null };
  const prompt = builderPrompt({ rolePrompt: loadRolePrompt('builder'), featureId, round, attempt, contract, findings, verifyFailure, conflicts, postMergeFailures, continuation, carriedWork, criteriaStatus });
  return adapter.run({ role: 'builder', prompt, cwd, readOnly: false, timeoutSec, budgetUsd, model, effort, signal, redact });
}

// ------------------------------------------------------------------ helpers

/**
 * Whether `text` still has a git conflict marker (SPEC §8.10): a line that starts with
 * '<<<<<<< ' or '>>>>>>> ', or is '=======' alone. A marker quoted mid-line is not one.
 */
export function hasConflictMarkers(text) {
  return String(text ?? '').split(/\r?\n/).some((l) => l.startsWith('<<<<<<< ') || l.startsWith('>>>>>>> ') || l === '=======');
}

/**
 * The paths (relative to `wt`) among `files` that still hold a conflict marker. Only regular
 * files are read: a symbolic link is not followed (lstat), so a link to a file outside the
 * repository is never opened (SPEC §8.10).
 */
export function conflictMarkedFiles(wt, files) {
  return [...files].filter((f) => {
    const file = path.join(wt, f);
    let st;
    try { st = fs.lstatSync(file); } catch { return false; }
    return st.isFile() && hasConflictMarkers(fs.readFileSync(file, 'utf8'));
  });
}

// The blocked reason once a merge recovery was tried: the failure is the recovery's.
const RECOVERY_REASON = { conflict: 'merge_conflict', post_merge_verify: 'post_merge_verify' };
const RECOVERY_WHAT = { conflict: 'the automatic conflict resolution', post_merge_verify: 'the post-merge verify recovery' };

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
  rounds: 'the round limit was reached with blocking findings left',
  merge_conflict: 'the feature branch conflicts with the integration branch and one automatic resolution did not fix it',
  post_merge_verify: 'verify failed on the integration branch after the merge and one automatic recovery did not fix it',
  budget: 'a step timed out or the budget was exhausted',
  needs_human: 'the evaluator scored below threshold without a reproducible finding',
  eval_error: 'the evaluator failed twice in a row',
  worktree: 'the feature worktree could not be created',
  adapter_unavailable: 'a role CLI (builder or evaluator) is not available',
  verify_error: 'verify could not run',
  refusal: 'the model refused the prompt (stop_reason refusal); the same prompt is not sent again',
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

function appendBacklog(root, item, redact) {
  appendItem(paths(root).backlog, redactDeep(item, redact, KEEP_UNREDACTED));
}

// `event` ({stage, round, reason, config, redact, warn}) describes the change for the status event.
function setStatus(root, id, status, event) {
  const data = loadFeatures(root);
  const f = data.features.find((x) => x.id === id);
  if (!f) throw new HarnessError(`feature ${id} disappeared from features.json during the run`, { code: 'state_corrupt' });
  const from = f.status;
  setFeatureStatus(f, status, event.reason);
  saveFeatures(root, data);
  if (from !== status) statusEvent(root, id, from, status, event);
}

// The builder calls of a feature summed for its final status event (SPEC §2 하네스 자기 개선):
// a total stays null until one call reports that value.
function addBuildTotals(totals, step) {
  const t = totals ?? { build_duration_ms: null, build_turns: null, build_cost_usd: null };
  const add = (sum, v) => (typeof v === 'number' && Number.isFinite(v) ? (sum ?? 0) + v : sum);
  return {
    build_duration_ms: add(t.build_duration_ms, step.duration_ms),
    build_turns: add(t.build_turns, step.turns),
    build_cost_usd: add(t.build_cost_usd, step.cost_usd),
  };
}

function statusEvent(root, id, from, to, { stage, round, reason, config, redact, warn, extra }) {
  recordEvent(root, { stage, type: 'status', feature: id, round, data: { from, to, reason: reason ?? null, ...extra } }, { config, redact, warn });
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

// Merge recovery of a feature (SPEC §8.10): none, or `<conflict|post_merge_verify> → passed|failed`.
const recoveryCell = (x) => (x?.kind ? `${x.kind} → ${x.result}` : 'none');

const STEP_TIME = (ms) => `${(num(ms) / 1000).toFixed(1)}s`;

// The Model cell of a step (SPEC §8.11): the requested model, or `<requested> → <served>` when
// the run found that pair mismatched (`mismatches`, keys `<requested>\0<served>`).
function modelCell(m, mismatches) {
  const model = m.model ?? '-';
  return m.model && m.served_model && mismatches.has(`${m.model}\u0000${m.served_model}`) ? `${model} → ${m.served_model}` : model;
}

// Per-feature step table from the run's metrics lines (SPEC §8.11).
function stepTables(metrics, mismatches = new Set()) {
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
const oneLine = (s) => mdCell(s).replace(/[\r\n]|\u2028|\u2029/gu, ' ').replace(/`/g, "'");

// '## Needs you' (SPEC §8): what the human decides, first — blocked → run stopped → merge.
function needsYou(state, cfg) {
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
 * @param {{root:string, config?:object, ids?:string[], resume?:boolean, fresh?:boolean, maxUsd?:number, parallel?:number,
 *   signal?:AbortSignal, deps?:{build?,verify?,evaluate?,criteriaStatus?,now?,monotonic?,log?,warn?,runAdapter?,git?,diagnose?,platform?,env?,cpus?,writeJsonAtomic?}}} opts
 *   deps.git(args, cwd, {timeoutSec}) runs every core git call (default: the exported `git`). deps.cpus is
 *   the CPU count behind verify_parallel 'auto'. deps.diagnose is the
 *   doctor report for the preflight; it is skipped when build and evaluation are both injected
 *   (no role CLI will be called) and no diagnose is given. deps.now/monotonic are the wall and
 *   monotonic clocks (ms) for sleep detection; deps.platform/env select and find the sleep inhibitor.
 *   deps.env also decides what is redacted in the state file, verdicts and backlog (SR-2);
 *   deps.writeJsonAtomic writes the state file.
 * @returns {Promise<{interrupted:boolean, sleep?:{feature,stage,sleptSec}, environment?:{feature,stage,item,program}, usageLimit?:{feature,stage,detail}, results:object[], stopped:object|null, costUsd:number, report:string|null, statePath:string}>}
 */
export async function runFeatures({ root, config, ids, resume = false, fresh = false, maxUsd, parallel, signal: outer, deps = {} } = {}) {
  if (parallel !== undefined && parallel !== null && !isMaxParallel(parallel)) {
    throw new HarnessError(`--parallel needs a positive integer (got ${JSON.stringify(parallel)})`, { code: 'usage' });
  }
  if (fresh && (resume || !ids?.length)) {
    throw new HarnessError('--fresh needs feature ids and cannot be combined with --resume', { code: 'usage' });
  }
  const d = {
    build: defaultBuild, verify: realVerify, evaluate: defaultEvaluate, criteriaStatus: realCriteriaStatus,
    now: () => new Date(), monotonic: () => performance.now(), log: () => {}, warn: (m) => process.stderr.write(`${m}\n`), git,
    platform: process.platform, env: process.env, cpus: availableCpus(), writeJsonAtomic, ...deps,
  };
  // Worktree, branch and merge changes go through one lock (SPEC §8.10).
  const gitLock = limiter(1);
  // Set once the config is known; every core git call of the run uses budget.git_timeout_sec.
  const gitOpts = {};
  const runGit = (args, cwd) => d.git(args, cwd, gitOpts);
  const g = (args, cwd) => (isSerializedGit(args) ? gitLock(() => runGit(args, cwd)) : runGit(args, cwd));
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
      // Features whose leftover worktree and branch are removed before they start (--fresh, SPEC §8).
      fresh: fresh ? [...ids] : [],
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
  assertIntegrationName(cfg); // before the preflight and before anything is created (SPEC §8)
  gitOpts.timeoutSec = gitTimeoutOf(cfg);
  const inScope = (id) => !state.scope || state.scope.includes(id);
  const maxParallel = state.maxParallel === 'auto' ? Infinity : isMaxParallel(state.maxParallel) ? state.maxParallel : 1;
  if (!state.verifyParallel) {
    const setting = cfg.run?.verify_parallel ?? 'auto';
    state.verifyParallel = { value: verifyParallelFor(setting, d.cpus), auto: setting === 'auto', cpus: d.cpus };
  }
  // Every verify (feature and post-merge) takes a slot of this pool; build and eval do not.
  const verifyPool = limiter(state.verifyParallel.value);
  // Command output is redacted before verify cuts it (SR-8); `redact` is defined below.
  // The time each verify waited for its slot goes to that step's metrics line as queue_ms (§8.11).
  const verifyQueueMs = new Map(); // feature → ms its latest verify waited
  const runVerify = (args) => {
    const asked = performance.now();
    return verifyPool(() => {
      verifyQueueMs.set(args.featureId, Math.max(0, Math.floor(performance.now() - asked)));
      return d.verify({ ...args, redact });
    });
  };
  const maxRounds = maxRoundsOf(cfg);
  const stepTimeout = cfg.budget?.step_timeout_sec ?? 1800;
  const stepUsd = cfg.budget?.step_usd ?? null;
  // One state object for every feature in flight; writes are synchronous, so none is lost.
  // Command output in the saved state is redacted like the report (SR-2); the run itself
  // keeps the full values in memory.
  const redact = redactor(d.env, Array.isArray(cfg.env_allowlist) ? cfg.env_allowlist : []);
  const save = () => {
    state.current = state.active[0] ?? null;
    d.writeJsonAtomic(statePath, redactDeep(state, redact, KEEP_UNREDACTED));
  };

  // One metrics line per finished step (SPEC §8.11). `at` is the step's start from stamp().
  const metricsPath = path.join(p.runs, `${state.runId}${METRIC_SUFFIX}`);
  const stamp = () => new Date(+d.now());
  // A claude call served by another model than requested (SPEC §10) is a run warning on stderr
  // and in the report, and its pair marks the report's Model cell. The verdict is unchanged.
  const checkServed = (e, round, step, requested, served) => {
    if (!modelMismatch(requested, served)) return;
    const w = mismatchWarning(e.feature, round, step, requested, served.servedModel);
    state.warnings = [...(state.warnings || []), w];
    const seen = state.servedMismatches ?? [];
    if (!seen.some((x) => x.requested === requested && x.served === served.servedModel)) {
      state.servedMismatches = [...seen, { requested, served: served.servedModel }];
    }
    d.warn(w);
  };
  // `who` is the {adapter, model, effort} the role was actually called with; core steps have none.
  // `usage` is what the adapter reported (turns, tokens, session, served model); `served` overrides
  // its served model. A builder call is also a build/step event (SPEC §2).
  // `verified` is a verify step's result: its line says whether that was a stored result (§6.4).
  const metric = (e, step, at, { role = null, who = null, costUsd = null, outcome, round = e.round, usage = null, served = usage, attempt, verified } = {}) => {
    const r = role
      ? { role, adapter: who?.adapter ?? null, model: who?.model ?? null, servedModel: served?.servedModel ?? null, effort: who?.effort ?? null }
      : { role: 'core', adapter: null, model: null, servedModel: null, effort: null };
    const endedAt = stamp();
    let queueMs = null;
    let cached = null;
    if (step === 'verify' || step === 'pre_merge_verify' || step === 'post_merge_verify') {
      queueMs = verifyQueueMs.get(e.feature) ?? 0;
      verifyQueueMs.delete(e.feature);
      cached = verified?.cache?.status === 'hit';
    }
    appendMetric(metricsPath, { feature: e.feature, round, step, startedAt: at, endedAt, queueMs, costUsd, ...r, outcome, cached, usage }, redact);
    if (role === 'builder') {
      const data = stepEventData({ step, attempt, ...r, outcome, startedAt: at, endedAt, costUsd, usage: usageOf(usage), cwd: cwdOf(e.feature) });
      e.build = addBuildTotals(e.build, data);
      recordEvent(root, { stage: 'build', type: 'step', feature: e.feature, round, data }, { config: cfg, redact, warn: d.warn });
      checkServed(e, round, step, r.model, served ?? {});
    }
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
      await preflight({ config: cfg, critical: scoped.some((f) => effectiveTier(root, f).tier === 'critical'), diagnose: deps.diagnose });
    }
  }

  // Refuse before touching anything (SR-5).
  const top = await gitOk(g, ['rev-parse', '--show-toplevel'], root, `${root} is not inside a git repository`);
  const projectRel = path.relative(canonical(top), canonical(root));
  await assertIntegrationAllowed(cfg, root, { runGit });
  const integ = cfg.integration_branch;
  const prot = protectedSet(cfg);
  const isFatal = (err) => err instanceof Interrupted || err instanceof SystemSleep || err instanceof Halt
    || err instanceof EnvironmentStop || err instanceof UsageLimitStop || err instanceof Paused
    || (err instanceof HarnessError && err.code === 'state_corrupt');

  let createdIntegration = false;
  if (!(await revParse(g, `refs/heads/${integ}`, root))) {
    const baseSha = await revParse(g, cfg.base_branch, root);
    if (!baseSha) throw new HarnessError(`base branch '${cfg.base_branch}' not found — cannot create '${integ}'`, { code: 'base_missing' });
    await gitOk(g, ['branch', integ, baseSha], root, `cannot create integration branch '${integ}'`);
    d.log(`created integration branch ${integ} from ${cfg.base_branch}`);
    createdIntegration = true;
  }
  // A dedicated worktree for merges: the user's own worktree never changes branch.
  const intWt = path.join(p.worktrees, INTEGRATION_WT);
  if (!(await registeredWorktree(g, root, intWt, integ))) {
    if (fs.existsSync(intWt)) throw new HarnessError(`${intWt} exists but is not a worktree of '${integ}' — remove it`, { code: 'worktree' });
    fs.mkdirSync(p.worktrees, { recursive: true });
    await gitOk(g, ['worktree', 'add', intWt, integ], root, `cannot create the integration worktree for '${integ}' (is it checked out elsewhere?)`);
  }
  const intCwd = path.join(intWt, projectRel);
  // The test-count and verify result caches as paths from a worktree's top level, in git's '/' form.
  const cacheRel = [...(projectRel ? projectRel.split(path.sep) : []), HARNESS_DIR, 'runs', TEST_COUNT_CACHE].join('/');
  const verifyCacheRel = [...(projectRel ? projectRel.split(path.sep) : []), HARNESS_DIR, 'runs', VERIFY_CACHE].join('/');
  // Events a command recorded inside a worktree stay there: every feature branch appending to
  // the same month file would make each merge conflict (SPEC §2 이벤트 기록).
  const eventsRel = [...(projectRel ? projectRel.split(path.sep) : []), HARNESS_DIR, 'events'].join('/');
  const harnessRel = [...(projectRel ? projectRel.split(path.sep) : []), HARNESS_DIR].join('/');
  // Exclude pathspecs for the core's local records. git refuses `add` when a pathspec names an
  // existing path that .gitignore already ignores, even as an exclude, so an ignored record path
  // is left out of the pathspec: `add -A` skips ignored files anyway.
  const localRecordExcludes = async (wt) => {
    const out = [];
    for (const rel of [cacheRel, verifyCacheRel, eventsRel]) {
      if ((await g(['check-ignore', '-q', '--', rel], wt)).code !== 0) out.push(`:(exclude,literal)${rel}`);
    }
    return out;
  };
  // The builder's uncommitted work becomes a core-authored commit on the feature branch (SPEC §8):
  // after each build attempt, so the feature verify sees what the post-merge verify will see, and
  // before the merge for anything left since. No change, no commit.
  const commitBuilderChanges = async (e) => {
    const wt = wtOf(e.feature);
    if (!(await gitOk(g, ['status', '--porcelain'], wt, 'git status failed'))) return;
    // The test-count cache and events are the core's local records, never part of the feature (§6.2-3).
    await gitOk(g, ['add', '-A', '--', '.', ...(await localRecordExcludes(wt))], wt, 'git add failed');
    if ((await g(['diff', '--cached', '--quiet'], wt)).code !== 0) {
      await gitOk(g, ['commit', '-q', '-m', `harness: ${e.feature} round ${e.round} builder changes`], wt, 'commit of builder changes failed');
    }
  };
  // A new run first takes in what base gained since integration was made (SPEC §8 base sync);
  // before the first save, so a failed sync leaves no run to resume.
  state.baseSync = resume ? 'skipped (resume)' : await syncBase();
  if (!resume) d.log(state.baseSync);
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

  // A missing program stops the run (SPEC §8): the feature that met it stops at once, the
  // others finish their current step and stop before the next one.
  let envStop = null;
  const stopOnEnvironment = (e, stage, failure) => {
    const err = new EnvironmentStop(e.feature, stage, failure);
    envStop = envStop ?? err;
    save();
    throw err;
  };
  // A usage limit stops the run the same way: the step is redone on resume (SPEC §8).
  const stopOnUsageLimit = (e, stage, detail) => {
    const err = new UsageLimitStop(e.feature, stage, detail || 'usage limit reached');
    envStop = envStop ?? err;
    save();
    throw err;
  };

  // While the run stops on budget, no feature starts another step (SPEC §8 budget).
  const checkHalt = (e) => {
    if (envStop) throw new Paused();
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
    // Rounds a human added with `approve --extra-round` (§7.6): the last of them ends with rounds.
    const allowed = e.allowed ?? maxRounds;
    const limit = () => blocked('rounds', `round ${e.round} of ${allowed} ended with ${ids.join(', ') || 'a failing verdict'}`);
    if (e.round > maxRounds && e.round >= allowed) return limit();
    const c = convergence(prev, ids);
    if (c.blocked) return blocked(c.blocked, `${c.blocked === 'divergence' ? 'newly blocking' : 'still blocking'}: ${c.ids.join(', ') || '(none)'}`, { ids: c.ids });
    if (e.round >= allowed) return limit();
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
    e.continuation = null;
    e.built = null;
    e.lastVerify = null;
    save();
    return null;
  };

  // Flaky test names seen in any verify of the feature, for the report (SPEC §6.1).
  const noteFlaky = (e, v) => {
    if (!Array.isArray(v?.flaky_tests) || !v.flaky_tests.length) return;
    e.flakyTests = [...new Set([...(e.flakyTests || []), ...v.flaky_tests])].slice(0, MAX_FLAKY_TESTS);
    // Tests whose command passed on the third run go to the backlog (low priority).
    const passed = [...new Set((v.commands || []).filter((c) => c.flaky_passed).flatMap((c) => c.flaky_tests || []))];
    if (passed.length) {
      const names = passed.map((n) => redact(n));
      recordFlakyTests(p.backlog, names, { feature: e.feature, round: e.round, at: stamp().toISOString() });
    }
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
        // A continued or carried-over build first learns where each criterion stands in the
        // worktree (SPEC §8). Not an attempt: an abort here redoes it on resume.
        let status;
        if (e.continuation?.files?.length || e.carriedWork?.files?.length) {
          const cat = stamp();
          try {
            status = await step(e, () => d.criteriaStatus({ cwd: cwdOf(e.feature), contract, config: cfg, signal }));
            metric(e, 'criteria_status', cat, { outcome: 'ok' });
          } catch (err) {
            if (isFatal(err)) throw err;
            metric(e, 'criteria_status', cat, { outcome: 'error' });
          }
        }
        let b;
        const m = meter.mark();
        const at = stamp();
        // Round 1 takes the tier's model, later rounds of the contract the escalation model.
        const who = roleCall(cfg, 'builder', { tier: contract.security_tier, round: e.round });
        try {
          b = await step(e, () => d.build({
            root, cwd: cwdOf(e.feature), featureId: e.feature, round: e.round, attempt, contract,
            findings: e.findings, verifyFailure: verifyFailureSummary(last), continuation: e.continuation ?? undefined,
            carriedWork: e.carriedWork ?? undefined, criteriaStatus: status, config: cfg,
            timeoutSec: stepTimeout, budgetUsd: remainingUsd(), signal, redact, ...who,
          }));
        } catch (err) {
          if (isFatal(err)) throw err;
          b = { ok: false, error: 'exit_nonzero', detail: err.message };
        }
        if (b?.error === 'usage_limit') {
          // Neither the attempt nor the round is used; resume calls the builder again.
          metric(e, 'build', at, { role: 'builder', who, costUsd: b.costUsd, usage: b, attempt, outcome: 'usage_limit' });
          addCost(e, b.costUsd);
          stopOnUsageLimit(e, 'build', b.detail);
        }
        e.carriedWork = null; // the note is for the first build that takes over the worktree
        // A timeout that left changes against the base continues in the round's next attempt
        // (SPEC §8); the last attempt, no change or a failing git check block it as before.
        const timedOut = b?.error === 'timeout';
        let changed = null;
        let gitError = null;
        if (timedOut && attempt < MAX_BUILD_ATTEMPTS) {
          try {
            changed = await changedFromBase(g, wtOf(e.feature), e.baseSha);
          } catch (err) {
            if (isFatal(err)) throw err;
            gitError = err.message;
          }
        }
        const continued = Boolean(changed?.length);
        const outcome = continued ? 'timeout-continued' : (b?.ok ? 'ok' : (b?.error || 'failed'));
        metric(e, 'build', at, { role: 'builder', who, costUsd: b?.costUsd, usage: b, attempt, outcome });
        addCost(e, b?.costUsd);
        save();
        d.log(`${e.feature} r${e.round} build ${attempt}/${MAX_BUILD_ATTEMPTS}: ${outcome}`);
        const over = stopRunOnBudget(e.feature);
        if (over) return over;
        sleptThrough(m, timedOut, e, 'build');
        if (timedOut && !continued) return blocked('budget', `build timed out after ${stepTimeout}s${gitError ? ` — checking the worktree for changes failed: ${gitError}` : ''}`);
        if (stepUsd !== null && num(b?.costUsd) >= stepUsd) return blocked('budget', `build cost $${num(b?.costUsd).toFixed(2)} reached the step budget $${stepUsd}`);
        if (b?.error === 'adapter_unavailable') return blocked('adapter_unavailable', b.detail);
        // The same prompt would be refused again: no further attempt, no verify (SPEC §8).
        if (b?.error === 'refusal') return blocked('refusal', b.detail);
        if (continued) {
          // The attempt is consumed without a verify; resume starts the continuation.
          e.continuation = { files: changed };
          e.attemptsDone = attempt;
          save();
          continue;
        }
        e.continuation = null;
        e.built = attempt;
        save();
      }
      // Committed before the verify, so it judges the tracked state the merge will carry; a
      // resumed attempt whose commit was cut off commits here too.
      await commitBuilderChanges(e);
      const mv = meter.mark();
      const at = stamp();
      try {
        last = await step(e, () => runVerify({ root, cwd: cwdOf(e.feature), featureId: e.feature, base: e.baseSha, config: cfg, signal, cpus: d.cpus, round: e.round, step: 'verify' }));
      } catch (err) {
        if (isFatal(err)) throw err;
        metric(e, 'verify', at, { outcome: 'error' });
        return blocked('verify_error', err.message);
      }
      metric(e, 'verify', at, { outcome: verifyOutcome(last), verified: last });
      noteFlaky(e, last);
      sleptThrough(mv, verifyTimedOut(last), e, 'verify');
      // The attempt is not consumed: resume verifies the same build again.
      const env = environmentFailure(last);
      if (env) stopOnEnvironment(e, 'verify', env);
      e.attemptsDone = attempt;
      e.lastVerify = last;
      e.verifyFailures = last.pass ? null : verifyFailures(last, redact);
      save();
      d.log(`${e.feature} r${e.round} verify: ${last.pass ? 'pass' : 'fail'}`);
      if (last.pass) break;
    }
    return { verifyResult: last };
  }

  // A post-merge verify can leave untracked files or changes in the integration worktree; they
  // are dropped (`git reset --hard`, `git clean -fd`) before the next merge (SPEC §8.10). Ignored
  // files and nested repositories stay. Returns null when the worktree is clean, else the
  // blocked(merge_conflict) detail: a cleanup command failed or the worktree is still dirty.
  // The discarded paths become a run warning (output and report). `what` names the merge.
  async function cleanIntegration(what) {
    try {
      const discarded = await dirtyPaths(g, intWt);
      if (!discarded.length) return null;
      const listed = discarded.slice(0, 50).join(', ') + (discarded.length > 50 ? `, … ${discarded.length - 50} more` : '');
      const w = `warning: integration worktree cleanup before ${what} discarded ${discarded.length} path(s) (git reset --hard, git clean -fd): ${listed}`;
      state.warnings = [...(state.warnings || []), w];
      d.log(w);
      for (const args of [['reset', '-q', '--hard', 'HEAD'], ['clean', '-q', '-f', '-d']]) {
        const r = await g(args, intWt);
        if (r.code !== 0) return `cannot clean the integration worktree ${intWt} before the merge: git ${args[0]} failed: ${gitCause(r)}`;
      }
      const left = await dirtyPaths(g, intWt);
      if (!left.length) return null;
      const shown = left.slice(0, 10).join(', ') + (left.length > 10 ? `, … (${left.length} paths)` : '');
      return `integration worktree ${intWt} is still dirty after git reset --hard and git clean: ${shown} — clean it by hand`;
    } catch (err) {
      if (isFatal(err)) throw err;
      return `cannot clean the integration worktree ${intWt} before the merge: ${err.message}`;
    }
  }

  // Base sync at run start (SPEC §8): base commits integration does not have are merged
  // (--no-ff) or fast-forwarded into it in the integration worktree, before any feature
  // worktree is made from it. Returns the outcome sentence; throws on a conflict (aborted).
  async function syncBase() {
    const base = cfg.base_branch;
    const upToDate = `${integ} is up to date with ${base}`;
    if (createdIntegration) return upToDate;
    const baseSha = await revParse(g, base, root);
    if (!baseSha) throw new HarnessError(`base branch '${base}' not found — cannot sync '${integ}' with it`, { code: 'base_missing' });
    // Exit 1 is "not an ancestor"; any other non-zero exit is a git error, not a sync to do.
    const anc = await g(['merge-base', '--is-ancestor', baseSha, `refs/heads/${integ}`], root);
    if (anc.code === 0) return upToDate;
    if (anc.code !== 1) throw new HarnessError(`cannot sync '${integ}' with '${base}': git merge-base --is-ancestor failed (${gitCause(anc)})`, { code: 'integration_sync' });
    const count = await gitOk(g, ['rev-list', '--count', `refs/heads/${integ}..${baseSha}`], root, `cannot count the commits of '${base}' missing from '${integ}'`);
    const head = await gitOk(g, ['symbolic-ref', '--short', 'HEAD'], intWt, 'integration worktree has no branch');
    if (head !== integ || prot.has(head)) throw new HarnessError(`integration worktree is on '${head}', expected '${integ}' — refusing to merge (SR-5)`, { code: 'protected_branch' });
    const dirtyLeft = await cleanIntegration(`syncing with ${base}`);
    if (dirtyLeft) throw new HarnessError(`cannot sync '${integ}' with '${base}': ${dirtyLeft}`, { code: 'integration_sync' });
    const ff = (await g(['merge-base', '--is-ancestor', 'HEAD', baseSha], intWt)).code === 0;
    const r = await g(ff ? ['merge', '-q', '--ff-only', baseSha]
      : ['merge', '-q', '--no-ff', '--no-edit', '-m', `harness: sync ${integ} with ${base}`, baseSha], intWt);
    if (r.code !== 0) {
      const conflicts = (await g(['diff', '--name-only', '--diff-filter=U'], intWt)).stdout.trim().split(/\r?\n/).filter(Boolean);
      if (await revParse(g, 'MERGE_HEAD', intWt)) await g(['merge', '--abort'], intWt);
      const detail = conflicts.length ? `conflicts in ${conflicts.join(', ')}` : gitCause(r);
      throw new HarnessError(`syncing '${integ}' with '${base}' failed (${detail}); the merge was aborted and nothing was built — merge ${base} into ${integ} by hand, then run again`, { code: 'integration_sync' });
    }
    return `synced ${integ} with ${base}: ${ff ? 'fast-forwarded' : 'merged'} ${count} commits`;
  }

  async function merge(e) {
    const branch = `harness/${e.feature}`;
    if (prot.has(branch)) return blocked('merge_conflict', `${branch} is a protected branch name`);
    // 1. what is still uncommitted (e.g. left by an eval repro) joins the feature branch
    const wt = wtOf(e.feature);
    await commitBuilderChanges(e);
    // 2. merge in the dedicated integration worktree, never a protected branch
    const head = await gitOk(g, ['symbolic-ref', '--short', 'HEAD'], intWt, 'integration worktree has no branch');
    if (head !== integ || prot.has(head)) throw new HarnessError(`integration worktree is on '${head}', expected '${integ}' — refusing to merge (SR-5)`, { code: 'protected_branch' });
    const alreadyMerged = e.preMergeSha
      && (await g(['merge-base', '--is-ancestor', branch, 'HEAD'], intWt)).code === 0
      && (await revParse(g, 'HEAD', intWt)) !== e.preMergeSha;
    if (!alreadyMerged) {
      const dirtyLeft = await cleanIntegration(`merging ${e.feature}`);
      if (dirtyLeft) return blocked('merge_conflict', dirtyLeft);
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
        // A merge recovery (resolution or post-merge fix) is once per feature, whichever came first.
        if (conflicts.length && clean && !e.recovery) return { resolve: conflicts };
        const detail = conflicts.length ? `conflicts in ${conflicts.join(', ')}` : gitCause(r);
        return blocked('merge_conflict', `${detail}${e.recovery ? ` after ${RECOVERY_WHAT[e.recovery]}` : ''}${clean ? '' : ' (integration worktree left dirty — clean it by hand)'}`);
      }
    }
    // 3. verify what was actually merged (the structural backstop, SPEC §7.3 D1)
    let v;
    const m = meter.mark();
    const at = stamp();
    try {
      v = await step(e, () => runVerify({ root, cwd: intCwd, featureId: e.feature, base: e.preMergeSha, config: cfg, signal, cpus: d.cpus, round: e.round, step: 'post_merge_verify', vacuityBase: e.baseSha ?? undefined }), { halt: false });
    } catch (err) {
      if (isFatal(err)) throw err;
      v = { pass: false, error: err.message };
    }
    metric(e, 'post_merge_verify', at, { outcome: verifyOutcome(v), verified: v });
    noteFlaky(e, v);
    sleptThrough(m, verifyTimedOut(v), e, 'verify'); // resume finds the merge done and re-verifies
    if (!v.pass) {
      await gitOk(g, ['reset', '-q', '--hard', e.preMergeSha], intWt, 'cannot roll back the failed merge');
      // Rolled back first: resume merges again and verifies the merge.
      const env = environmentFailure(v);
      if (env) stopOnEnvironment(e, 'post_merge_verify', env);
      const failures = verifyFailures(v, redact);
      // The first failure goes back to the builder once (SPEC §8.10); integration stays as it was.
      if (!e.recovery) return { recover: failures.length ? failures : [{ item: 'verify', message: 'verify failed' }] };
      return blocked('post_merge_verify', `${v.error || 'verify failed on the merged integration branch; merge rolled back'} after ${RECOVERY_WHAT[e.recovery]}`,
        { failures });
    }
    // 4. the feature branch is merged; its worktree is no longer needed
    await g(['worktree', 'remove', '--force', wt], root);
    // -D after an explicit ancestry check: -d would compare against the user's HEAD, not integration
    if ((await g(['merge-base', '--is-ancestor', branch, integ], root)).code === 0) await g(['branch', '-D', branch], root);
    return { status: 'passed', reason: null, detail: null };
  }

  // Pre-merge verify (SPEC §8.10): when integration moved past the feature's base, it is merged
  // into the feature worktree on a detached HEAD and verified there before the merge lock is
  // taken, outside it; then the worktree goes back to its branch, which never moved. The merge
  // in the lock merges the same two commits, so its post-merge verify sees the same tree on the
  // same merge-base — a result cache hit unless integration moved again. A conflict or a failure
  // changes nothing: the merge flow follows as before. Returns a blocked outcome only when the
  // worktree could not be put back, else null.
  async function preMergeVerify(e) {
    const wt = wtOf(e.feature);
    // Cut off before it was put back (an interrupt): the merge is undone and the verify redone.
    if (e.preVerify) {
      const out = await undoPreMerge(e);
      if (out) return out;
    }
    const integSha = await revParse(g, `refs/heads/${integ}`, root);
    if (!integSha || !e.baseSha || integSha === e.baseSha || e.preMerged === integSha) return null;
    if ((await g(['merge-base', '--is-ancestor', integSha, 'HEAD'], wt)).code === 0) return null;
    await commitBuilderChanges(e);
    e.preVerify = { preMergeHead: await revParse(g, 'HEAD', wt), integSha };
    save();
    const detached = await g(['checkout', '-q', '--detach'], wt);
    const r = detached.code !== 0 ? detached
      : await g(['merge', '--no-ff', '--no-edit', '-m', `harness: merge ${integ} into harness/${e.feature} (pre-merge verify)`, integSha], wt);
    let v = null;
    if (r.code !== 0) {
      d.log(`${e.feature}: merging ${integ} into the feature worktree failed (${gitCause(r)}) — aborted, no pre-merge verify`);
    } else {
      const at = stamp();
      try {
        v = await step(e, () => runVerify({ root, cwd: cwdOf(e.feature), featureId: e.feature, base: integSha, config: cfg, signal, cpus: d.cpus, round: e.round, step: 'pre_merge_verify' }));
      } catch (err) {
        if (isFatal(err)) {
          // Put back now when possible; resume does it otherwise.
          await undoPreMerge(e).catch(() => {});
          throw err;
        }
        v = { pass: false, error: err.message };
      }
      metric(e, 'pre_merge_verify', at, { outcome: verifyOutcome(v), verified: v });
      noteFlaky(e, v);
    }
    const out = await undoPreMerge(e);
    if (out) return out;
    e.preMerged = integSha;
    save();
    if (v) d.log(`${e.feature} pre-merge verify: ${verifyOutcome(v)}`);
    return null;
  }

  // Puts the feature worktree back on its branch after the pre-merge verify (SPEC §8.10):
  // `git checkout -f` leaves a merge in progress or a detached merge commit, drops what the merge
  // and the verify changed in tracked files and removes MERGE_HEAD. Returns a blocked outcome or null.
  async function undoPreMerge(e) {
    const wt = wtOf(e.feature);
    const branch = `harness/${e.feature}`;
    const r = await g(['checkout', '-q', '-f', branch], wt);
    if (r.code !== 0) return blocked('merge_conflict', `cannot return ${wt} to ${branch} after the pre-merge verify: git checkout -f failed (${gitCause(r)}) — clean it by hand`);
    // Untracked files the verify wrote would join the next builder commit; ignored files and
    // .harness/ (the core's records) stay. A failed clean is a warning, the run goes on.
    const c = await g(['clean', '-q', '-f', '-d', '--', '.', `:(exclude,top,literal)${harnessRel}`], wt);
    if (c.code !== 0) {
      const w = `warning: ${e.feature}: cannot remove untracked files left by the pre-merge verify in ${wt}: git clean failed (${gitCause(c)})`;
      state.warnings = [...(state.warnings || []), w];
      d.log(w);
    }
    e.preVerify = null;
    save();
    return null;
  }

  // A merge recovery needs the integration commit; without it nothing is merged (SPEC §8.10).
  const unresolvedIntegration = () => `integration branch '${integ}' (refs/heads/${integ}) cannot be resolved to a commit — nothing was merged`;

  // Takes a feature worktree out of a merge in progress after a failed recovery (SPEC §8.10):
  // `git merge --abort`, and if that fails `git reset --hard` to the pre-merge commit (HEAD
  // while the merge is uncommitted). Returns null when nothing was needed or the abort worked,
  // else {clean, detail} for the blocked detail.
  async function leaveMerge(wt) {
    if (!(await revParse(g, 'MERGE_HEAD', wt))) return null;
    const a = await g(['merge', '--abort'], wt);
    if (a.code === 0) return null;
    const head = (await revParse(g, 'HEAD', wt)) ?? 'HEAD';
    const r = await g(['reset', '-q', '--hard', head], wt);
    if (r.code === 0) return { clean: true, detail: `git merge --abort failed (${gitCause(a)}); ${wt} was reset to ${head}` };
    return { clean: false, detail: `git merge --abort failed (${gitCause(a)}) and git reset --hard ${head} failed (${gitCause(r)}) — ${wt} is left mid-merge, clean it by hand` };
  }

  // After a failed conflict resolution whose merge is no longer in progress (the builder or the
  // core committed it, SPEC §8.10): when HEAD moved off the pre-resolution commit, `git reset
  // --hard` back to it, in the feature worktree only. Returns null when nothing was needed,
  // else {clean, detail} for the blocked detail.
  async function leaveCommittedMerge(wt, preMergeHead) {
    if (!preMergeHead || (await revParse(g, 'MERGE_HEAD', wt))) return null;
    const head = await revParse(g, 'HEAD', wt);
    if (!head || head === preMergeHead) return null;
    const r = await g(['reset', '-q', '--hard', preMergeHead], wt);
    if (r.code === 0) return { clean: true, detail: `the resolution was committed (${head}); ${wt} was reset to ${preMergeHead}` };
    return { clean: false, detail: `the resolution was committed (${head}) and git reset --hard ${preMergeHead} failed (${gitCause(r)}) — clean ${wt} by hand` };
  }

  // Merges the integration branch into the feature worktree, lets the builder resolve the
  // conflicts once and completes that merge (SPEC §8.10). Returns a blocked outcome or null;
  // on null the feature is verified and evaluated again before the next merge attempt.
  async function resolveConflict(e, contract) {
    const wt = wtOf(e.feature);
    const fail = async (detail) => {
      const left = (await leaveMerge(wt)) ?? (await leaveCommittedMerge(wt, e.conflict?.preMergeHead));
      return blocked('merge_conflict', `automatic conflict resolution failed: ${detail}${left ? `; ${left.detail}` : ''}`);
    };
    // 1. the conflicted state, in the feature worktree only (resume keeps a merge in progress)
    if (!e.conflict?.integSha || !(await revParse(g, 'MERGE_HEAD', wt))) {
      const integSha = await revParse(g, `refs/heads/${integ}`, root);
      if (!integSha) return blocked('merge_conflict', unresolvedIntegration());
      const preMergeHead = await revParse(g, 'HEAD', wt);
      const r = await g(['merge', '--no-ff', '--no-edit', '-m', `harness: merge ${integ} into harness/${e.feature} (conflict resolution)`, integSha], wt);
      const files = r.code === 0 ? []
        : (await g(['diff', '--name-only', '--diff-filter=U'], wt)).stdout.trim().split(/\r?\n/).filter(Boolean);
      if (r.code !== 0 && files.length === 0) return fail(gitCause(r));
      // What the merge left, so the marker check covers every file the builder changes.
      e.conflict = { integSha, files, preMergeHead, snapshot: files.length ? await worktreeSnapshot(g, wt) : null };
      save();
    }
    const { integSha, files } = e.conflict;
    // 2. one builder call with the conflicting files
    if (files.length) {
      let b;
      const m = meter.mark();
      const at = stamp();
      const who = roleCall(cfg, 'builder', { tier: contract.security_tier, round: e.round, conflict: true });
      try {
        b = await step(e, () => d.build({
          root, cwd: cwdOf(e.feature), featureId: e.feature, round: e.round, attempt: 1, contract,
          findings: [], verifyFailure: null, conflicts: files, config: cfg,
          timeoutSec: stepTimeout, budgetUsd: remainingUsd(), signal, redact, ...who,
        }));
      } catch (err) {
        if (isFatal(err)) throw err;
        b = { ok: false, error: 'exit_nonzero', detail: err.message };
      }
      metric(e, 'conflict_resolve', at, { role: 'builder', who, costUsd: b?.costUsd, usage: b, outcome: b?.ok ? 'ok' : (b?.error || 'failed') });
      addCost(e, b?.costUsd);
      // The merge stays in progress in the feature worktree; resume calls the builder again.
      if (b?.error === 'usage_limit') stopOnUsageLimit(e, 'conflict_resolve', b.detail);
      save();
      d.log(`${e.feature} conflict resolution build: ${b?.ok ? 'ok' : (b?.error || 'failed')}`);
      const over = stopRunOnBudget(e.feature);
      if (over) return over;
      sleptThrough(m, b?.error === 'timeout', e, 'build');
      if (!b?.ok) return fail(`builder ${b?.error || 'failed'}${b?.detail ? ` (${b.detail})` : ''} — conflicts in ${files.join(', ')}`);
      // Every file the resolution changed, not only the ones git reported as conflicted.
      const changed = new Set([...files, ...(await changedSince(g, wt, e.conflict))]);
      const marked = conflictMarkedFiles(wt, changed);
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

  // After a failed post-merge verify (rolled back): merges the integration branch into the
  // feature worktree and lets the builder fix the failed items once (SPEC §8.10). Returns a
  // blocked outcome or null; on null the feature is verified and evaluated again (base = the
  // integration commit it now contains) before the next merge attempt.
  async function recoverPostMerge(e, contract) {
    const wt = wtOf(e.feature);
    const fail = async (detail) => {
      const left = await leaveMerge(wt);
      // A worktree left mid-merge is a merge problem, not the verify failure (SPEC §8.10).
      return blocked(left && !left.clean ? 'merge_conflict' : 'post_merge_verify',
        `automatic post-merge verify recovery failed: ${detail}${left ? `; ${left.detail}` : ''}`, { failures: e.postMerge?.failures });
    };
    // 1. integration into the feature worktree only (resume finds it merged already)
    if (!e.postMerge.integSha) {
      const integSha = await revParse(g, `refs/heads/${integ}`, root);
      if (!integSha) return blocked('merge_conflict', unresolvedIntegration());
      if ((await g(['merge-base', '--is-ancestor', integSha, 'HEAD'], wt)).code !== 0) {
        const r = await g(['merge', '--no-ff', '--no-edit', '-m', `harness: merge ${integ} into harness/${e.feature} (post-merge verify recovery)`, integSha], wt);
        if (r.code !== 0) return fail(`cannot merge ${integ} into harness/${e.feature}: ${gitCause(r)}`);
      }
      e.postMerge.integSha = integSha;
      save();
    }
    const { integSha, failures } = e.postMerge;
    // 2. one builder call with the failed items
    if (!e.postMerge.built) {
      let b;
      const m = meter.mark();
      const at = stamp();
      const who = roleCall(cfg, 'builder', { tier: contract.security_tier, round: e.round });
      try {
        b = await step(e, () => d.build({
          root, cwd: cwdOf(e.feature), featureId: e.feature, round: e.round, attempt: 1, contract,
          findings: [], verifyFailure: null, postMergeFailures: failures, config: cfg,
          timeoutSec: stepTimeout, budgetUsd: remainingUsd(), signal, redact, ...who,
        }));
      } catch (err) {
        if (isFatal(err)) throw err;
        b = { ok: false, error: 'exit_nonzero', detail: err.message };
      }
      metric(e, 'post_merge_recovery', at, { role: 'builder', who, costUsd: b?.costUsd, usage: b, outcome: b?.ok ? 'ok' : (b?.error || 'failed') });
      addCost(e, b?.costUsd);
      if (b?.error === 'usage_limit') stopOnUsageLimit(e, 'post_merge_recovery', b.detail); // resume builds again
      save();
      d.log(`${e.feature} post-merge verify recovery build: ${b?.ok ? 'ok' : (b?.error || 'failed')}`);
      const over = stopRunOnBudget(e.feature);
      if (over) return over;
      sleptThrough(m, b?.error === 'timeout', e, 'build');
      if (!b?.ok) return fail(`builder ${b?.error || 'failed'}${b?.detail ? ` (${b.detail})` : ''}`);
      e.postMerge.built = true;
      save();
    }
    if ((await g(['merge-base', '--is-ancestor', integSha, 'HEAD'], wt)).code !== 0) return fail(`harness/${e.feature} does not contain ${integ} after the recovery`);
    // Verify and eval now judge the feature against the integration commit it contains.
    e.baseSha = integSha;
    e.postMerge = null;
    return null;
  }

  const pathExists = (p) => {
    try { fs.lstatSync(p); return true; } catch { return false; }
  };
  const describeWorktree = (w) => (w.branch ? `branch ${w.branch.replace(/^refs\/heads\//, '')}` : 'a detached HEAD');
  const worktreeAt = async (dir) => {
    const want = canonical(dir);
    return (await listWorktrees(g, root)).find((w) => canonical(w.path) === want) ?? null;
  };

  // The worktree a blocked run left for a re-approved feature (SPEC §8): taken over only when
  // git lists it as a worktree of this repository on harness/F{n}. Uncommitted work in it is
  // committed first. Returns {base, carried: {files, commit}} or {blocked: detail}.
  async function takeOver(id, base) {
    const wt = wtOf(id);
    const branch = `harness/${id}`;
    const w = await worktreeAt(wt);
    if (!w) return { blocked: `${wt} exists but is not a registered worktree of this repository (expected branch ${branch}) — not taken over; move it away by hand` };
    if (w.branch !== `refs/heads/${branch}`) return { blocked: `${wt} is a worktree on ${describeWorktree(w)}, not ${branch} — not taken over` };
    if (await revParse(g, 'MERGE_HEAD', wt)) return { blocked: `${wt} (branch ${branch}) is in the middle of a merge — finish or abort it by hand, or start over with --fresh` };
    let commit = null;
    if (await gitOk(g, ['status', '--porcelain'], wt, 'git status failed')) {
      // The test-count cache and events are the core's local records, never part of the feature (§6.2-3).
      await gitOk(g, ['add', '-A', '--', '.', ...(await localRecordExcludes(wt))], wt, 'git add failed');
      if ((await g(['diff', '--cached', '--quiet'], wt)).code !== 0) {
        await gitOk(g, ['commit', '-q', '-m', `harness: ${id} carried work`], wt, 'commit of the carried work failed');
        commit = await revParse(g, 'HEAD', wt);
      }
    }
    const from = base ? await gitOk(g, ['merge-base', base, 'HEAD'], wt, `no merge base of ${integ} and ${branch}`) : null;
    const files = from ? await changedFromBase(g, wt, from) : [];
    return { base, carried: { files, commit } };
  }

  // --fresh (SPEC §8): the feature's leftover worktree and branch are removed before it starts.
  // Returns null, or the blocked(worktree) detail when something could not be removed.
  async function removeLeftover(id) {
    const wt = wtOf(id);
    const branch = `harness/${id}`;
    if (pathExists(wt)) {
      const w = await worktreeAt(wt);
      if (!w) return `--fresh: ${wt} is not a registered worktree of this repository (expected branch ${branch}) — not removed; move it away by hand`;
      if (w.branch !== `refs/heads/${branch}`) return `--fresh: ${wt} is a worktree on ${describeWorktree(w)}, not ${branch} — not removed`;
      const r = await g(['worktree', 'remove', '--force', wt], root);
      if (r.code !== 0) return `--fresh could not remove the worktree ${wt}: ${gitCause(r)}`;
    }
    if (await revParse(g, `refs/heads/${branch}`, root)) {
      const r = await g(['branch', '-D', branch], root);
      if (r.code !== 0) return `--fresh could not delete the branch ${branch}: ${gitCause(r)}`;
    }
    d.log(`${id}: --fresh removed the leftover worktree and branch`);
    return null;
  }

  async function runOne(e) {
    const contract = loadContract(root, e.feature).contract;
    if (e.conflictTried && !e.recovery) e.recovery = 'conflict'; // a state file written before F32
    if (e.stage === 'worktree' && (e.carried ?? 0) >= (e.allowed ?? maxRounds)) {
      e.round = e.carried;
      return blocked('rounds', `${e.carried} of ${e.allowed ?? maxRounds} rounds of this contract were already evaluated`);
    }
    if (e.stage === 'worktree') {
      const branch = `harness/${e.feature}`;
      let out;
      try {
        if (prot.has(branch)) throw new HarnessError(`${branch} is protected`, { code: 'protected_branch' });
        out = await worktreeLock(async () => {
          const base = await revParse(g, `refs/heads/${integ}`, root);
          if (state.fresh?.includes(e.feature)) {
            const why = await removeLeftover(e.feature);
            if (why) return { blocked: why };
          } else if (pathExists(wtOf(e.feature))) {
            return takeOver(e.feature, base);
          }
          await gitOk(g, ['worktree', 'add', '-b', branch, wtOf(e.feature), base], root, `cannot create worktree for ${e.feature}`);
          return { base };
        });
      } catch (err) {
        if (isFatal(err)) throw err;
        return blocked('worktree', err.message);
      }
      if (out.blocked) return blocked('worktree', out.blocked);
      e.baseSha = out.base;
      if (out.carried) {
        e.takeover = { commit: out.carried.commit };
        e.carriedWork = { files: out.carried.files };
        d.log(`${e.feature}: continuing the work left in ${wtOf(e.feature)}${out.carried.commit ? ' (uncommitted changes committed as carried work)' : ''}`);
      }
      e.stage = 'build';
      e.round = (e.carried ?? 0) + 1;
      save();
    } else {
      // A pre-merge verify cut off on a detached HEAD: back on the branch first (SPEC §8.10).
      if (e.preVerify && pathExists(wtOf(e.feature))) {
        const out = await undoPreMerge(e);
        if (out) return out;
      }
      if (!(await registeredWorktree(g, root, wtOf(e.feature), `harness/${e.feature}`))) {
        return blocked('worktree', `${wtOf(e.feature)} is missing — cannot resume ${e.feature}`);
      }
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
            pendingVerify = await step(e, () => runVerify({ root, cwd: cwdOf(e.feature), featureId: e.feature, base: e.baseSha, config: cfg, signal, cpus: d.cpus, round: e.round, step: 'verify' }));
          } catch (err) {
            if (isFatal(err)) throw err;
            metric(e, 'verify', at, { outcome: 'error' });
            return blocked('verify_error', err.message);
          }
          metric(e, 'verify', at, { outcome: verifyOutcome(pendingVerify), verified: pendingVerify });
          noteFlaky(e, pendingVerify);
          sleptThrough(m, verifyTimedOut(pendingVerify), e, 'verify');
          const env = environmentFailure(pendingVerify);
          if (env) stopOnEnvironment(e, 'verify', env);
          e.verifyFailures = pendingVerify.pass ? null : verifyFailures(pendingVerify, redact);
          if (!pendingVerify.pass) {
            if (e.recovery) return blocked(RECOVERY_REASON[e.recovery], `verify failed after ${RECOVERY_WHAT[e.recovery]}: ${blockingIds(verifyBlocking(pendingVerify)).join(', ')}`);
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
        // Each reviewer call is an eval/step or security/step event; the eval metrics line
        // carries their usage summed (SPEC §2, §8.11).
        // The eval line's served model is the last evaluator call's that reported one.
        const calls = [];
        let evalServed = null;
        const onAdapterCall = (c) => {
          calls.push(c.usage ?? usageOf(null));
          if (c.role === 'evaluator' && c.servedModel) evalServed = c;
          recordEvent(root, { stage: stageOfRole(c.role), type: 'step', feature: e.feature, round: e.round,
            data: stepEventData({ step: 'eval', ...c, cwd: cwdOf(e.feature) }) }, { config: cfg, redact, warn: d.warn });
          checkServed(e, e.round, stageOfRole(c.role), c.model, c);
        };
        try {
          v = await step(e, () => d.evaluate({
            root, cwd: cwdOf(e.feature), featureId: e.feature, round: e.round, verdictRound, base: e.baseSha,
            config: cfg, verifyResult: pendingVerify, runAdapter: d.runAdapter, signal, origin: 'run', env: d.env, warn: d.warn,
            builders: builderModels(cfg, { tier, round: e.round, conflict: e.recovery === 'conflict' }), onAdapterCall,
          }));
        } catch (err) {
          if (isFatal(err)) throw err;
          if (err instanceof HarnessError && err.code === 'usage_limit') {
            // Not an eval_error: no verdict was written and the count stays; resume evaluates again.
            metric(e, 'eval', at, { role: 'evaluator', who: roleCall(cfg, 'evaluator', { tier }), costUsd: err.costUsd, usage: sumUsage(calls), served: evalServed, outcome: 'usage_limit' });
            addCost(e, err.costUsd);
            stopOnUsageLimit(e, 'eval', err.detail);
          }
          if (err instanceof HarnessError && err.code === 'refusal') {
            // Not an eval_error and not asked again: the feature is blocked (SPEC §8).
            metric(e, 'eval', at, { role: 'evaluator', who: roleCall(cfg, 'evaluator', { tier }), costUsd: err.costUsd, usage: sumUsage(calls), served: evalServed, outcome: 'refusal' });
            addCost(e, err.costUsd);
            return blocked('refusal', `${err.role} refused — ${err.detail}`);
          }
          v = { verdict: 'eval_error', error: err.message };
        }
        metric(e, 'eval', at, { role: 'evaluator', who: roleCall(cfg, 'evaluator', { tier }), costUsd: v?.costUsd, usage: sumUsage(calls), served: evalServed, outcome: typeof v?.verdict === 'string' ? v.verdict : 'eval_error' });
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
          if (!e.recovery) e.history.push([]); // a merge recovery re-evaluates the same round
          e.stage = 'merge';
          save();
        } else if (verdict === 'fail' && e.recovery) {
          return blocked(RECOVERY_REASON[e.recovery], `evaluation failed after ${RECOVERY_WHAT[e.recovery]}: ${blockingIds(v.blocking || []).join(', ') || 'no finding ids'}`);
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
          return blocked('needs_human', v.error || 'score below threshold without a reproducible finding');
        } else { // eval_error or anything unrecognized: the round is not consumed
          e.evalErrors = num(e.evalErrors) + 1;
          save();
          if (e.evalErrors >= MAX_EVAL_ERRORS) return blocked('eval_error', v?.error || `verdict ${JSON.stringify(verdict)}`);
          continue;
        }
      }
      if (e.stage === 'merge') {
        const pre = await preMergeVerify(e);
        if (pre) return pre;
        const out = await mergeLock(() => {
          if (signal.aborted) throw new Interrupted();
          checkHalt(e);
          return merge(e);
        });
        if (out.recover) {
          // Recovery runs outside the merge lock, like a conflict resolution.
          e.recovery = 'post_merge_verify';
          e.postMerge = { integSha: null, failures: out.recover, built: false };
          e.stage = 'recover';
          save();
          d.log(`${e.feature}: post-merge verify failed (${out.recover.map((f) => f.item).join(', ')}) — merge rolled back, one automatic recovery`);
        } else if (!out.resolve) {
          return out;
        } else {
          // Resolution runs outside the merge lock: other features keep merging meanwhile.
          e.recovery = 'conflict';
          e.conflict = { integSha: null, files: out.resolve };
          e.stage = 'resolve';
          save();
          d.log(`${e.feature}: merge conflict in ${out.resolve.join(', ')} — one automatic resolution`);
        }
      }
      if (e.stage === 'recover') {
        const out = await recoverPostMerge(e, contract);
        if (out) return out;
        pendingVerify = null;
        e.stage = 'eval';
        save();
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
    // The stage that decided: a pass or a verdict is eval's, anything earlier is build's.
    const stage = final === 'passed' || e.stage === 'eval' ? 'eval' : 'build';
    setStatus(root, e.feature, final, { stage, round: e.round, reason: outcome.reason ?? (final === 'passed' ? 'pass' : null), config: cfg, redact, warn: d.warn,
      extra: e.build ?? undefined });
    const result = {
      feature: e.feature, title: e.title, tier: e.tier, status: final, reason: outcome.reason,
      detail: outcome.detail, rounds: e.round, history: e.history, independence: e.independence,
      costUsd: e.costUsd, conflictResolution: e.recovery === 'conflict' ? (final === 'passed' ? 'resolved' : 'failed') : 'no',
      mergeRecovery: e.recovery ? { kind: e.recovery, result: final === 'passed' ? 'passed' : 'failed' } : null,
    };
    if (e.flakyTests?.length) result.flaky_tests = e.flakyTests;
    if (e.takeover) {
      result.carried = true;
      if (e.takeover.commit) result.carriedCommit = e.takeover.commit;
    }
    if (final === 'blocked') {
      const failures = outcome.failures ?? e.verifyFailures;
      if (failures?.length) result.failures = failures;
      if (fs.existsSync(wtOf(e.feature))) result.worktree = path.relative(root, wtOf(e.feature)).split(path.sep).join('/');
      // run_stopped is not a problem of the feature: there is nothing to re-scope.
      if (outcome.reason !== 'run_stopped') appendBacklog(root, rescopeProposal(e, outcome), redact);
    }
    state.results.push(result);
    d.log(`${e.feature}: ${final}${outcome.reason ? ` (${outcome.reason})` : ''}`);
    if (final === 'blocked') {
      const data = loadFeatures(root);
      const skipped = [];
      for (const id of dependentsOf(data.features, e.feature, inScope)) {
        const f = data.features.find((x) => x.id === id);
        skipped.push([id, f.status]);
        setFeatureStatus(f, 'skipped');
        state.results.push({ feature: id, title: f.title, tier: f.security_tier, status: 'skipped', reason: `depends on ${e.feature} (blocked)`, detail: null, rounds: 0, history: [], independence: null, costUsd: 0 });
        d.log(`${id}: skipped (depends on ${e.feature})`);
      }
      saveFeatures(root, data);
      for (const [id, from] of skipped) {
        statusEvent(root, id, from, 'skipped', { stage: 'build', reason: 'dependency_blocked', config: cfg, redact, warn: d.warn, extra: { blocked_by: e.feature } });
      }
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
          // Paused at a step boundary by an environment stop: the feature stays in state.active.
          if (err instanceof Paused) return;
          // SIGINT reaches every feature; a fatal error in one stops the others (their steps
          // are redone on resume). The first non-interrupt error decides how the run ends.
          if (!failure || (failure instanceof Interrupted && !(err instanceof Interrupted))) failure = err;
          // An environment or usage-limit stop lets the other features finish their current step.
          if (!(err instanceof EnvironmentStop) && !(err instanceof UsageLimitStop)) ac.abort();
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
      const hash = hashContract(loadContract(root, next.id).contract);
      const earlier = contractVerdicts(p.verdicts, next.id, hash);
      const last = earlier.length ? earlier[earlier.length - 1].v : null;
      // The critical stop follows the approved contract's tier; a differing features.json is reported.
      const tier = effectiveTier(root, next);
      if (tier.mismatch) {
        const w = tierWarning(next.id, tier);
        state.warnings = [...(state.warnings || []), w];
        d.log(w);
      }
      const e = {
        feature: next.id, title: next.title, tier: tier.tier, stage: 'worktree', round: 0, attempt: 0,
        history: earlier.map((r) => (r.v.verdict === 'fail' ? verdictBlockingIds(r.v) : [])),
        carried: earlier.length,
        allowed: maxRounds + extraRoundsOf(next, hash),
        carriedPrev: last?.verdict === 'fail' ? verdictBlockingIds(last) : null,
        findings: last?.verdict === 'fail' && Array.isArray(last.blocking) ? last.blocking : [],
        evalErrors: 0, baseSha: null, preMergeSha: null, independence: null, costUsd: 0,
      };
      state.active.push(e);
      setStatus(root, next.id, 'in_progress', { stage: 'build', reason: 'run_start', config: cfg, redact, warn: d.warn });
      save();
      d.log(`${next.id}: start`);
      launch(e);
      return true;
    };

    // Resume: every feature that was in flight continues, whatever the slot count.
    for (const e of state.active) launch(e);
    for (;;) {
      try {
        while (!failure && !envStop && !state.stopped && !signal.aborted && running.size < maxParallel && start()) { /* fill free slots */ }
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
      if (failure instanceof EnvironmentStop) {
        save(); // statuses, rounds and attempts unchanged: resume redoes the stopped step
        const f = failure;
        d.log(`${f.feature} ${f.stage}: command not found: ${f.program} (in ${f.item}) — an environment problem, ${f.feature} is not blocked. Run stopped, state saved; install ${f.program} or fix PATH, then continue with: harness run --resume`);
        const environment = { feature: f.feature, stage: f.stage, item: f.item, program: f.program };
        return { interrupted: true, environment, results: state.results, stopped: null, costUsd: state.costUsd, report: null, statePath };
      }
      if (failure instanceof UsageLimitStop) {
        save(); // statuses, rounds, attempts and eval_error counts unchanged: resume redoes the stopped step
        const f = failure;
        d.log(`${f.feature} ${f.stage}: usage limit reached (${f.detail}) — ${f.feature} is not blocked. Run stopped, state saved; after the limit resets continue with: harness run --resume`);
        const usageLimit = { feature: f.feature, stage: f.stage, detail: f.detail };
        return { interrupted: true, usageLimit, results: state.results, stopped: null, costUsd: state.costUsd, report: null, statePath };
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
    // Rendered from the same redacted copy as the state file (SR-8).
    fs.writeFileSync(report, renderReport(redactDeep(state, redact, KEEP_UNREDACTED), { finishedAt: d.now().toISOString(), notRun, metrics }));
    await g(['worktree', 'remove', intWt], root); // best effort; kept if dirty
    fs.rmSync(statePath, { force: true });
    return { interrupted: false, results: state.results, stopped: state.stopped, costUsd: state.costUsd, report, statePath, notRun };
  }
}
