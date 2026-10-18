// Shared pieces of the run modules: stop signals, constants and pure helpers (SPEC §8).

export const MAX_BUILD_ATTEMPTS = 3; // build retries per round when verify fails (SPEC §8.3)
export const MAX_EVAL_ERRORS = 2; // consecutive eval_error verdicts before blocked (SPEC §7.3)
export const INTEGRATION_WT = '_integration';
// A feature an interactive `harness eval` left in_progress is run too; it continues the
// rounds of its contract (SPEC §8.8).
export const RUN_STATUSES = ['approved', 'in_progress'];

export class Interrupted extends Error {
  constructor() { super('interrupted'); this.name = 'Interrupted'; }
}

// A feature stops before its next step because the run is stopping (budget, SPEC §8.10).
export class Halt extends Error {
  constructor(outcome) { super('halt'); this.name = 'Halt'; this.outcome = outcome; }
}

// A step timed out while the system slept: the run stops resumably, nothing is blocked (SPEC §8).
export class SystemSleep extends Error {
  constructor(feature, stage, sleptMs) {
    super('system sleep');
    this.name = 'SystemSleep';
    Object.assign(this, { feature, stage, sleptSec: Math.round(sleptMs / 1000) });
  }
}

// A verify command, test_count or criterion check whose program is not installed (SPEC §8):
// the environment, not the feature, is at fault. The run stops resumably; nothing is blocked.
export class EnvironmentStop extends Error {
  constructor(feature, stage, failure) {
    super(`command not found: ${failure.program}`);
    this.name = 'EnvironmentStop';
    Object.assign(this, { feature, stage, item: failure.item, program: failure.program });
  }
}

// A worktree setup command (config run.worktree_setup) failed, timed out or left files git
// would track (SPEC §8): the environment, not the feature, is at fault. The run stops
// resumably; the setup runs again from its first command on resume.
export class SetupStop extends Error {
  constructor(feature, info) {
    super(`worktree setup failed: ${info.worktree}`);
    this.name = 'SetupStop';
    Object.assign(this, { feature, ...info });
  }
}

// A role CLI reported its usage limit (SPEC §8): the account, not the feature, is at fault.
// The run stops resumably like an environment stop; nothing is blocked or consumed.
export class UsageLimitStop extends Error {
  constructor(feature, stage, detail) {
    super(`usage limit: ${detail}`);
    this.name = 'UsageLimitStop';
    Object.assign(this, { feature, stage, detail });
  }
}

// Another feature stopped the run on the environment: this one stops before its next step
// and stays in the state file (SPEC §8.10).
export class Paused extends Error {
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

// Values the run state is read back by (config snapshot, ids, commits, conflicted files):
// they never hold command output and are saved as they are.
export const KEEP_UNREDACTED = new Set(['config', 'runId', 'startedAt', 'scope', 'feature', 'title', 'history', 'carriedPrev',
  'criterion_id', 'baseSha', 'preMergeSha', 'preMerged', 'integSha', 'files', 'preMergeHead', 'snapshot', 'fresh', 'takeover', 'carriedCommit']);
// The state, backlog and report are read back by their keys: only values are redacted (F109 AC-1).
export const VALUES_ONLY = Object.freeze({ keys: false });

// A verify result where a command or a criterion check ran into the step timeout.
export const verifyTimedOut = (v) => [...(v?.commands || []), ...(v?.criteria || [])].some((c) => c.timedOut);

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

// ------------------------------------------------------------------ convergence (pure)

export const idOf = (x) => (typeof x === 'string' ? x : x?.criterion_id);

/** Distinct blocking criterion ids of a round: an id array, a finding array, or {blocking}. */
export function blockingIds(round) {
  const list = Array.isArray(round) ? round : (round?.blocking ?? []);
  return [...new Set(list.map(idOf).filter((id) => typeof id === 'string' && id))];
}

/**
 * Blocking ids of a failing verdict record. A verdict whose verify failed blocks with the
 * union of its findings' ids and its `verify_blocking` ids (the run's verifyBlocking ids);
 * a verify failure with neither blocks as a whole ('VERIFY').
 */
export function verdictBlockingIds(v) {
  const ids = blockingIds(Array.isArray(v?.blocking) ? v.blocking : []);
  if (v?.verify_pass !== false) return ids;
  const fromVerify = blockingIds(Array.isArray(v.verify_blocking) ? v.verify_blocking : []);
  const all = [...new Set([...ids, ...fromVerify])];
  return all.length === 0 ? ['VERIFY'] : all;
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

// The blocked reason once a merge recovery was tried: the failure is the recovery's.
export const RECOVERY_REASON = { conflict: 'merge_conflict', post_merge_verify: 'post_merge_verify' };
export const RECOVERY_WHAT = { conflict: 'the automatic conflict resolution', post_merge_verify: 'the post-merge verify recovery' };

// What run.max_parallel 'auto' allows: this many features in flight at once (SPEC §8).
export const AUTO_PARALLEL = 3;

export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
export const tsName = (d) => d.toISOString().replace(/[:.]/g, '-');

// Runs at most `n` tasks at once; the rest wait in call order.
export function limiter(n) {
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

export const blocked = (reason, detail, extra = {}) => ({ status: 'blocked', reason, detail: detail || null, ...extra });
export const verifyOutcome = (v) => (v?.error ? 'error' : v?.pass ? 'pass' : 'fail');
