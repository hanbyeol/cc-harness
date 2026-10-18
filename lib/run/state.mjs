// The run state: the state file, resume, the run context every step works through, the
// metrics and cost bookkeeping and the stop controls (SPEC §8, §8.10, §8.11).
import fs from 'node:fs';
import path from 'node:path';
import { HarnessError } from '../errors.mjs';
import { paths, readJson, writeJsonAtomic, loadFeatures, saveFeatures, setFeatureStatus } from '../state.mjs';
import { loadConfig, validateUser, isMaxParallel, isParallelSetting, availableCpus, gitTimeoutOf, maxRoundsOf } from '../config.mjs';
import { redactor, redactDeep, MAX_FLAKY_TESTS } from '../failures.mjs';
import { appendItem, recordFlakyTests } from '../backlog.mjs';
import { verify as realVerify, criteriaStatus as realCriteriaStatus } from '../verify.mjs';
import { SLEEP_THRESHOLD_MS } from '../sleep.mjs';
import { appendMetric, METRIC_SUFFIX } from '../metrics.mjs';
import { recordEvent } from '../events.mjs';
import { stepEventData, usageOf, modelMismatch, mismatchWarning } from '../usage.mjs';
import { Interrupted, Halt, SystemSleep, EnvironmentStop, UsageLimitStop, Paused, KEEP_UNREDACTED, VALUES_ONLY, AUTO_PARALLEL, num, tsName, limiter, blocked } from './common.mjs';
import { git, isSerializedGit, assertIntegrationName } from './worktree.mjs';
import { defaultEvaluate, defaultBuild } from './prompt.mjs';

export const STATE_VERSION = 1;

export function appendBacklog(root, item, redact) {
  appendItem(paths(root).backlog, redactDeep(item, redact, KEEP_UNREDACTED, VALUES_ONLY));
}

// `event` ({stage, round, reason, config, redact, warn}) describes the change for the status event.
export function setStatus(root, id, status, event) {
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
export function addBuildTotals(totals, step) {
  const t = totals ?? { build_duration_ms: null, build_turns: null, build_cost_usd: null };
  const add = (sum, v) => (typeof v === 'number' && Number.isFinite(v) ? (sum ?? 0) + v : sum);
  return {
    build_duration_ms: add(t.build_duration_ms, step.duration_ms),
    build_turns: add(t.build_turns, step.turns),
    build_cost_usd: add(t.build_cost_usd, step.cost_usd),
  };
}

export function statusEvent(root, id, from, to, { stage, round, reason, config, redact, warn, extra }) {
  recordEvent(root, { stage, type: 'status', feature: id, round, data: { from, to, reason: reason ?? null, ...extra } }, { config, redact, warn });
}

// Approved features that depend (transitively) on `id`, restricted to the run scope.
export function dependentsOf(features, id, inScope) {
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

export const validEntry = (c) => c !== null && typeof c === 'object' && typeof c.feature === 'string'
  && Number.isInteger(c.round) && typeof c.stage === 'string' && Array.isArray(c.history);

// `active` lists every feature in flight (SPEC §8.10); `current` mirrors its first entry and is
// all a state file written before parallel runs has.
export function validateState(s, file) {
  const ok = s && typeof s === 'object' && s.version === STATE_VERSION && typeof s.runId === 'string'
    && Array.isArray(s.results) && s.config && typeof s.config === 'object'
    && (Array.isArray(s.active) ? s.active.every(validEntry) : (s.current === null || validEntry(s.current)))
    && (s.maxParallel === undefined || isParallelSetting(s.maxParallel))
    && (s.verifyParallel === undefined || isMaxParallel(s.verifyParallel?.value));
  if (!ok) throw new HarnessError(`${file}: not a valid run state — fix or delete it; harness will not guess`, { code: 'state_corrupt' });
  if (!Array.isArray(s.active)) s.active = s.current ? [s.current] : [];
}

/** Verify pool size (SPEC §8.10): an integer setting as is; 'auto' (or unset) is max(1, floor(cpus / 8)). */
export function verifyParallelFor(setting, cpus) {
  if (isMaxParallel(setting)) return setting;
  return Math.max(1, Math.floor(num(cpus) / 8));
}

// Opens a run: validates the options, reads the saved state (resume) or makes a new one, and
// returns the run context. Git, the recorder and the stop controls are attached to it later.
export function initRun({ root, config, ids, resume = false, fresh = false, maxUsd, parallel, signal: outer, deps = {} } = {}) {
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
  const maxParallel = state.maxParallel === 'auto' ? AUTO_PARALLEL : isMaxParallel(state.maxParallel) ? state.maxParallel : 1;
  if (!state.verifyParallel) {
    const setting = cfg.run?.verify_parallel ?? 'auto';
    state.verifyParallel = { value: verifyParallelFor(setting, d.cpus), auto: setting === 'auto', cpus: d.cpus };
  }
  const maxRounds = maxRoundsOf(cfg);
  const stepTimeout = cfg.budget?.step_timeout_sec ?? 1800;
  const stepUsd = cfg.budget?.step_usd ?? null;
  // One state object for every feature in flight; writes are synchronous, so none is lost.
  // Command output in the saved state is redacted like the report (SR-2); the run itself
  // keeps the full values in memory.
  const redact = redactor(d.env, Array.isArray(cfg.env_allowlist) ? cfg.env_allowlist : []);
  const save = () => {
    state.current = state.active[0] ?? null;
    d.writeJsonAtomic(statePath, redactDeep(state, redact, KEEP_UNREDACTED, VALUES_ONLY));
  };
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
  // One metrics line per finished step (SPEC §8.11). `at` is the step's start from stamp().
  const metricsPath = path.join(p.runs, `${state.runId}${METRIC_SUFFIX}`);
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
  return {
    root, resume, deps, d, p, statePath, state, cfg, g, runGit, signal, ac, outer, onOuter, maxRounds, maxParallel,
    stepTimeout, stepUsd, redact, save, metricsPath, inScope, mergeLock, worktreeLock, verifyQueueMs, runVerify,
    envStop: null, meter: null, createdIntegration: false,
  };
}

// Metrics lines, cost and budget checks, flaky-test notes: needs the worktree helpers (cwdOf).
export function attachRecorder(ctx) {
  const { root, d, p, state, cfg, redact, stepUsd, metricsPath, verifyQueueMs, cwdOf } = ctx;
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

  const addCost = (e, c) => {
    state.costUsd = num(state.costUsd) + num(c);
    if (e) e.costUsd = num(e.costUsd) + num(c);
  };
  const runOver = () => state.maxUsd !== null && state.maxUsd !== undefined && state.costUsd > state.maxUsd;

  // Builder calls share the run budget: a call is assigned min(step_usd, what is left after the
  // cost so far and the calls running, split over the in-progress features without an assignment).
  // With nothing left but calls running, the feature waits for one to end (its real cost may be
  // lower); with nothing running, the run stops on budget (SPEC §8).
  const held = new Map(); // feature → budgetUsd of its running builder call
  let waiters = [];
  const reserveBuild = async (e) => {
    if (state.maxUsd == null) return { usd: stepUsd, release() {} };
    for (;;) {
      const heldSum = [...held.values()].reduce((a, b) => a + b, 0);
      const share = (state.maxUsd - num(state.costUsd) - heldSum) / Math.max(1, (ctx.running?.size ?? 1) - held.size);
      if (share > 1e-9) {
        const usd = stepUsd === null ? share : Math.min(stepUsd, share);
        held.set(e.feature, usd);
        return { usd, release() { held.delete(e.feature); const w = waiters; waiters = []; w.forEach((f) => f()); } };
      }
      if (held.size === 0) {
        const detail = `run cost $${num(state.costUsd).toFixed(2)} reached the run budget $${state.maxUsd}`;
        if (state.stopped?.reason !== 'budget') state.stopped = { reason: 'budget', feature: e.feature, detail };
        throw new Halt(blocked('budget', detail));
      }
      await new Promise((resolve) => waiters.push(resolve));
    }
  };

  const stopRunOnBudget = (feature) => {
    if (!runOver()) return null;
    if (state.stopped?.reason !== 'budget') {
      state.stopped = { reason: 'budget', feature, detail: `run cost $${state.costUsd.toFixed(2)} exceeds $${state.maxUsd}` };
    }
    return blocked('budget', `run cost $${state.costUsd.toFixed(2)} exceeds $${state.maxUsd}`);
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
  Object.assign(ctx, { stamp, checkServed, metric, addCost, runOver, reserveBuild, stopRunOnBudget, noteFlaky });
}

// Stops: fatal errors, environment and usage-limit stops, the budget halt, SIGINT races, sleep.
export function attachControl(ctx) {
  const { state, signal, save } = ctx;
  const isFatal = (err) => err instanceof Interrupted || err instanceof SystemSleep || err instanceof Halt
    || err instanceof EnvironmentStop || err instanceof UsageLimitStop || err instanceof Paused
    || (err instanceof HarnessError && err.code === 'state_corrupt');

  // A missing program stops the run (SPEC §8): the feature that met it stops at once, the
  // others finish their current step and stop before the next one.
  const stopOnEnvironment = (e, stage, failure) => {
    const err = new EnvironmentStop(e.feature, stage, failure);
    ctx.envStop = ctx.envStop ?? err;
    save();
    throw err;
  };
  // A usage limit stops the run the same way: the step is redone on resume (SPEC §8).
  const stopOnUsageLimit = (e, stage, detail) => {
    const err = new UsageLimitStop(e.feature, stage, detail || 'usage limit reached');
    ctx.envStop = ctx.envStop ?? err;
    save();
    throw err;
  };

  // While the run stops on budget, no feature starts another step (SPEC §8 budget).
  const checkHalt = (e) => {
    if (ctx.envStop) throw new Paused();
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

  // A step that timed out while the system slept stops the run for --resume instead of
  // blocking the feature (SPEC §8): the timeout measured the sleep, not the work.
  const sleptThrough = (mark, timedOut, e, stage) => {
    if (!timedOut) return;
    const ms = ctx.meter.sleptSince(mark);
    if (ms >= SLEEP_THRESHOLD_MS) throw new SystemSleep(e.feature, stage, ms);
  };
  Object.assign(ctx, { isFatal, stopOnEnvironment, stopOnUsageLimit, checkHalt, step, sleptThrough });
}
