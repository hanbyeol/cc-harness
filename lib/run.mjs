// `harness run` — autonomous build → verify → eval → merge with guaranteed convergence (SPEC §8).
// The loop is code, not a prompt: a round cap, a strictly shrinking blocking set and
// divergence detection make an unbounded evaluator loop impossible. The core never
// pushes and never merges into main or a protected branch (SR-5); a human merges
// integration → main.
// The work is split over lib/run/: state (the run context and its bookkeeping), worktree (git
// and worktrees), feature (one feature's rounds), merge (merging and recovery), report.
import fs from 'node:fs';
import { availableCpus } from './config.mjs';
import { executableFeatures, loadContract, hashContract } from './contract.mjs';
import { contractVerdicts, extraRoundsOf } from './eval.mjs';
import { FAILURE_MESSAGE_CHARS } from './failures.mjs';
import { startSleepInhibitor, sleepMeter } from './sleep.mjs';
import { RUN_STATUSES, Interrupted, Halt, SystemSleep, EnvironmentStop, SetupStop, UsageLimitStop, Paused, verdictBlockingIds } from './run/common.mjs';
import { setStatus, initRun, attachRecorder, attachControl } from './run/state.mjs';
import { attachGit } from './run/worktree.mjs';
import { runWorktreeSetup, setupCommands } from './run/setup.mjs';
import { runOne, finish } from './run/feature.mjs';
import { syncBase } from './run/merge.mjs';
import { writeReport } from './run/report.mjs';
import { effectiveTier, tierWarning, runPreflight } from './run/preflight.mjs';
import { acquireRunLock } from './run/lock.mjs';
import { paths } from './state.mjs';

export { isProcessAlive } from './run/lock.mjs';

export { MAX_BUILD_ATTEMPTS, MAX_EVAL_ERRORS, INTEGRATION_WT, environmentFailure, blockingIds, verdictBlockingIds, convergence } from './run/common.mjs';
export { git, isSerializedGit, protectedSet, assertIntegrationName, assertIntegrationAllowed } from './run/worktree.mjs';
export { preflight, effectiveTier } from './run/preflight.mjs';
export { MAX_PROMPT_FILES, MAX_CONTEXT_CHARS, builderPrompt, hasConflictMarkers, conflictMarkedFiles } from './run/prompt.mjs';
export { verifyBlocking } from './run/feature.mjs';
export { renderReport } from './run/report.mjs';
export { verifyParallelFor } from './run/state.mjs';
export { FAILURE_MESSAGE_CHARS, availableCpus };

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
export async function runFeatures(opts = {}) {
  // The lock comes before the state file check, the preflight and the base sync (SPEC §8).
  const { root, deps = {} } = opts;
  const release = acquireRunLock(paths(root).runs, {
    warn: deps.warn ?? ((m) => process.stderr.write(`${m}\n`)),
    now: deps.now ? () => new Date(deps.now()) : undefined,
  });
  try {
    return await runLocked(opts);
  } finally {
    release();
  }
}

async function runLocked({ root, config, ids, resume = false, fresh = false, maxUsd, parallel, signal: outer, deps = {} } = {}) {
  const ctx = initRun({ root, config, ids, resume, fresh, maxUsd, parallel, signal: outer, deps });
  const { d, state, save, cfg } = ctx;
  await runPreflight(ctx);
  await attachGit(ctx);
  attachRecorder(ctx);
  attachControl(ctx);
  // A newly created integration worktree is set up before its first merge (the base sync is one);
  // resume repeats an unfinished setup.
  if (ctx.createdIntegrationWt && setupCommands(cfg).length) state.integrationSetup = 'pending';
  if (state.integrationSetup === 'pending') {
    try {
      await runWorktreeSetup(ctx, { name: 'integration', wt: ctx.intWt, cwd: ctx.intCwd });
    } catch (err) {
      if (err instanceof SetupStop || err instanceof Interrupted) return stopResult(ctx, err);
      throw err;
    }
    state.integrationSetup = 'done';
  }
  // A new run first takes in what base gained since integration was made (SPEC §8 base sync);
  // before the first save, so a failed sync leaves no run to resume.
  state.baseSync = resume ? 'skipped (resume)' : await syncBase(ctx);
  if (!resume) d.log(state.baseSync);
  save();

  // Keep the system awake for the run (SPEC §8); where that is not possible the run goes on.
  const noInhibitor = (why) => {
    state.sleepInhibitor = { ok: false, label: why };
    d.log(`sleep inhibitor unavailable: ${why} — the system may sleep during the run`);
  };
  const inhibitor = await startSleepInhibitor({ platform: d.platform, env: d.env, onLost: noInhibitor });
  if (inhibitor.ok) state.sleepInhibitor = { ok: true, label: inhibitor.label };
  else noInhibitor(inhibitor.label);
  ctx.meter = sleepMeter({ now: d.now, monotonic: d.monotonic });
  save();
  try {
    return await schedule(ctx);
  } finally {
    inhibitor.stop();
    ctx.meter.stop();
  }
}

// Fills free slots with resumed or new features until none is left and the run is idle.
async function schedule(ctx) {
  const { root, d, p, statePath, state, cfg, g, signal, ac, outer, onOuter, maxRounds, maxParallel, redact, save, inScope, intWt } = ctx;
  const running = new Map(); // feature id → settled-never-rejects promise
  ctx.running = running; // the budget split counts the features in flight
  let failure = null; // the first error that stops the whole run
  const launch = (e) => {
    const pr = runOne(ctx, e)
      .catch((err) => { if (err instanceof Halt) return err.outcome; throw err; })
      .then((outcome) => finish(ctx, e, outcome))
      .catch((err) => {
        // Paused at a step boundary by an environment stop: the feature stays in state.active.
        if (err instanceof Paused) return;
        // SIGINT reaches every feature; a fatal error in one stops the others (their steps
        // are redone on resume). The first non-interrupt error decides how the run ends.
        if (!failure || (failure instanceof Interrupted && !(err instanceof Interrupted))) failure = err;
        // An environment or usage-limit stop lets the other features finish their current step.
        if (!(err instanceof EnvironmentStop) && !(err instanceof SetupStop) && !(err instanceof UsageLimitStop)) ac.abort();
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

  // Resume: the features that were in flight continue up to the slot count; the rest wait in
  // state.active with their round and attempt and take the next free slots (SPEC §8).
  const resumeWaiting = () => {
    const waiting = state.active.find((x) => !running.has(x.feature));
    if (!waiting) return false;
    launch(waiting);
    return true;
  };
  while (running.size < maxParallel && resumeWaiting()) { /* fill the slots with resumed features */ }
  for (;;) {
    try {
      while (!failure && !ctx.envStop && !state.stopped && !signal.aborted && running.size < maxParallel && (resumeWaiting() || start())) { /* fill free slots */ }
    } catch (err) {
      failure = failure ?? err;
      ac.abort();
    }
    if (running.size === 0) break;
    await Promise.race(running.values());
  }
  outer?.removeEventListener('abort', onOuter);
  if (failure) return stopResult(ctx, failure);
  const { report, notRun } = writeReport(ctx);
  await g(['worktree', 'remove', intWt], root); // best effort; kept if dirty
  fs.rmSync(statePath, { force: true });
  return { interrupted: false, results: state.results, stopped: state.stopped, costUsd: state.costUsd, report, statePath, notRun };
}

// How a run that stopped on an error ends: interrupted and resumable, or the error itself.
function stopResult(ctx, failure) {
  const { d, statePath, state, save } = ctx;
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
  if (failure instanceof SetupStop) {
    save(); // setupPending stays: resume runs the setup again from its first command
    const f = failure;
    d.log(`worktree setup failed in ${f.worktree}: ${f.command} (${f.reason}) — an environment problem, ${f.feature ? `${f.feature} is not blocked` : 'nothing was built'}. Run stopped, state saved; fix it, then continue with: harness run --resume`);
    const setup = { worktree: f.worktree, feature: f.feature, command: f.command, reason: f.reason, output: f.output };
    return { interrupted: true, setup, results: state.results, stopped: null, costUsd: state.costUsd, report: null, statePath };
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
