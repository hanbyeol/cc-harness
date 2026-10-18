// One feature's rounds: build → verify → eval, then the merge (SPEC §8).
// Compact, prompt-sized summary of a failed verify for the next build attempt.
import fs from 'node:fs';
import path from 'node:path';
import { HarnessError } from '../errors.mjs';
import { loadFeatures, saveFeatures, verdictRounds, setFeatureStatus } from '../state.mjs';
import { loadContract } from '../contract.mjs';
import { verifyFailures } from '../failures.mjs';
import { resolveItems } from '../backlog.mjs';
import { roleCall, builderModels } from '../adapters/index.mjs';
import { recordEvent } from '../events.mjs';
import { stageOfRole, stepEventData, sumUsage, usageOf } from '../usage.mjs';
import { MAX_BUILD_ATTEMPTS, MAX_EVAL_ERRORS, Interrupted, environmentFailure, verifyTimedOut, blockingIds, convergence, verifyBlocking, RECOVERY_REASON, RECOVERY_WHAT, num, blocked, verifyOutcome } from './common.mjs';
import { appendBacklog, setStatus, statusEvent, dependentsOf } from './state.mjs';
import { gitOk, revParse, changedFromBase, registeredWorktree, pathExists, takeOver, removeLeftover } from './worktree.mjs';
import { merge, preMergeVerify, undoPreMerge, resolveConflict, recoverPostMerge } from './merge.mjs';

export function verifyFailureSummary(v) {
  if (!v || v.pass) return null;
  return {
    commands: (v.commands || []).filter((c) => !c.pass).map((c) => ({ cmd: c.cmd, message: c.message, output: c.output })),
    integrity: v.integrity,
    criteria: (v.criteria || []).filter((c) => !c.pass).map((c) => ({ id: c.id, check: c.check, message: c.message, output: c.output })),
  };
}

export { verifyBlocking };

export const RESCOPE = {
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

export function rescopeProposal(e, outcome) {
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

// Closes a failing round; returns a blocked outcome or null to continue with round+1.
export function endRound(ctx, e, blocking) {
  const { state, maxRounds, save } = ctx;
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
  // The next round's first attempt starts from where this round's verify left off (§8).
  e.prevVerify = e.lastVerify?.pass === false ? e.lastVerify : null;
  e.lastVerify = null;
  save();
  return null;
}

export async function buildAndVerify(ctx, e, contract) {
  const { root, d, cfg, g, signal, stepTimeout, stepUsd, redact, save, runVerify, wtOf, cwdOf, commitBuilderChanges, stamp, metric, addCost, reserveBuild, stopRunOnBudget, noteFlaky, isFatal, stopOnEnvironment, stopOnUsageLimit, step, sleptThrough } = ctx;
  // Resume continues the round's attempt count: completed build+verify cycles and the
  // last verify result are part of the saved state, so a round never exceeds the cap.
  let last = e.lastVerify ?? null;
  if (last?.pass) return { verifyResult: last };
  let failedBefore = last ?? e.prevVerify ?? null; // the failure the next build starts from
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
      const m = ctx.meter.mark();
      const at = stamp();
      // Round 1 takes the tier's model, later rounds of the contract the escalation model.
      const who = roleCall(cfg, 'builder', { tier: contract.security_tier, round: e.round });
      const hold = {};
      try {
        b = await step(e, async () => {
          hold.r = await reserveBuild(e);
          return d.build({
            root, cwd: cwdOf(e.feature), featureId: e.feature, round: e.round, attempt, contract,
            findings: e.findings, verifyFailure: verifyFailureSummary(failedBefore), continuation: e.continuation ?? undefined,
            carriedWork: e.carriedWork ?? undefined, criteriaStatus: status, config: cfg,
            timeoutSec: stepTimeout, budgetUsd: hold.r.usd, signal, redact, ...who,
          });
        });
      } catch (err) {
        hold.r?.release();
        if (isFatal(err)) throw err;
        b = { ok: false, error: 'exit_nonzero', detail: err.message };
      }
      if (b?.error === 'usage_limit') {
        // Neither the attempt nor the round is used; resume calls the builder again.
        metric(e, 'build', at, { role: 'builder', who, costUsd: b.costUsd, usage: b, attempt, outcome: 'usage_limit' });
        addCost(e, b.costUsd);
        hold.r?.release();
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
      hold.r?.release();
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
    const mv = ctx.meter.mark();
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
    failedBefore = last;
    e.verifyFailures = last.pass ? null : verifyFailures(last, redact);
    save();
    d.log(`${e.feature} r${e.round} verify: ${last.pass ? 'pass' : 'fail'}`);
    if (last.pass) break;
  }
  return { verifyResult: last };
}

export async function runOne(ctx, e) {
  const { root, d, p, state, cfg, g, signal, maxRounds, redact, save, mergeLock, worktreeLock, runVerify, integ, prot, wtOf, cwdOf, stamp, checkServed, metric, addCost, stopRunOnBudget, noteFlaky, isFatal, stopOnEnvironment, stopOnUsageLimit, checkHalt, step, sleptThrough } = ctx;
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
          const why = await removeLeftover(ctx, e.feature);
          if (why) return { blocked: why };
        } else if (pathExists(wtOf(e.feature))) {
          return takeOver(ctx, e.feature, base);
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
      const out = await undoPreMerge(ctx, e);
      if (out) return out;
    }
    if (!(await registeredWorktree(g, root, wtOf(e.feature), `harness/${e.feature}`))) {
      return blocked('worktree', `${wtOf(e.feature)} is missing — cannot resume ${e.feature}`);
    }
  }

  let pendingVerify = null;
  for (;;) {
    if (e.stage === 'build') {
      const r = await buildAndVerify(ctx, e, contract);
      if (r.status) return r;
      if (!r.verifyResult?.pass) {
        const out = endRound(ctx, e, verifyBlocking(r.verifyResult));
        if (out) return out;
        continue;
      }
      pendingVerify = r.verifyResult;
      e.stage = 'eval';
      save();
    }
    if (e.stage === 'eval') {
      if (!pendingVerify) { // resumed at eval: re-establish the verify result
        const m = ctx.meter.mark();
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
          e.lastVerify = pendingVerify;
          const out = endRound(ctx, e, verifyBlocking(pendingVerify));
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
      const m = ctx.meter.mark();
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
        const out = endRound(ctx, e, Array.isArray(v.blocking) ? v.blocking : []);
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
      const pre = await preMergeVerify(ctx, e);
      if (pre) return pre;
      const out = await mergeLock(() => {
        if (signal.aborted) throw new Interrupted();
        checkHalt(e);
        return merge(ctx, e);
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
      const out = await recoverPostMerge(ctx, e, contract);
      if (out) return out;
      pendingVerify = null;
      e.stage = 'eval';
      save();
    }
    if (e.stage === 'resolve') {
      const out = await resolveConflict(ctx, e, contract);
      if (out) return out;
      pendingVerify = null;
      e.stage = 'eval';
      save();
    }
  }
}

export function finish(ctx, e, outcome) {
  const { root, d, p, state, cfg, redact, save, inScope, wtOf } = ctx;
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
}
