// Merging a passed feature into the integration branch, the verify around it and the
// recovery from a conflict or a failed post-merge verify (SPEC §8.10).
// A post-merge verify can leave untracked files or changes in the integration worktree; they
// are dropped (`git reset --hard`, `git clean -fd`) before the next merge (SPEC §8.10). Ignored
// files and nested repositories stay. Returns null when the worktree is clean, else the
// blocked(merge_conflict) detail: a cleanup command failed or the worktree is still dirty.
// The discarded paths become a run warning (output and report). `what` names the merge.
import { HarnessError } from '../errors.mjs';
import { verifyFailures } from '../failures.mjs';
import { roleCall } from '../adapters/index.mjs';
import { environmentFailure, verifyTimedOut, RECOVERY_WHAT, blocked, verifyOutcome } from './common.mjs';
import { gitCause, gitOk, revParse, deleteBranch, dirtyPaths, worktreeSnapshot, changedSince } from './worktree.mjs';
import { conflictMarkedFiles } from './prompt.mjs';

export async function cleanIntegration(ctx, what) {
  const { d, state, g, intWt, isFatal } = ctx;
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
export async function syncBase(ctx) {
  const { root, cfg, g, createdIntegration, integ, prot, intWt } = ctx;
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
  const dirtyLeft = await cleanIntegration(ctx, `syncing with ${base}`);
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

export async function merge(ctx, e) {
  const { root, d, cfg, g, signal, redact, save, runVerify, integ, prot, intWt, intCwd, wtOf, commitBuilderChanges, stamp, metric, noteFlaky, isFatal, stopOnEnvironment, step, sleptThrough } = ctx;
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
    const dirtyLeft = await cleanIntegration(ctx, `merging ${e.feature}`);
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
  const m = ctx.meter.mark();
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
  const removed = await g(['worktree', 'remove', '--force', wt], root);
  // update-ref -d does not refuse a branch checked out in a worktree, so a failed remove keeps it.
  // The ancestry check is explicit (branch -d would compare against the user's HEAD, not integration)
  // and the delete names the checked sha, so a branch moved meanwhile is kept.
  const sha = removed.code === 0 ? await revParse(g, `refs/heads/${branch}`, root) : null;
  if (sha && (await g(['merge-base', '--is-ancestor', sha, integ], root)).code === 0) await deleteBranch(g, root, branch, sha);
  return { status: 'passed', reason: null, detail: null };
}

// Pre-merge verify (SPEC §8.10): when integration moved past the feature's base, it is merged
// into the feature worktree on a detached HEAD and verified there before the merge lock is
// taken, outside it; then the worktree goes back to its branch, which never moved. The merge
// in the lock merges the same two commits, so its post-merge verify sees the same tree on the
// same merge-base — a result cache hit unless integration moved again. A conflict or a failure
// changes nothing: the merge flow follows as before. Returns a blocked outcome only when the
// worktree could not be put back, else null.
export async function preMergeVerify(ctx, e) {
  const { root, d, cfg, g, signal, save, runVerify, integ, wtOf, cwdOf, commitBuilderChanges, stamp, metric, noteFlaky, isFatal, step } = ctx;
  const wt = wtOf(e.feature);
  // Cut off before it was put back (an interrupt): the merge is undone and the verify redone.
  if (e.preVerify) {
    const out = await undoPreMerge(ctx, e);
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
        await undoPreMerge(ctx, e).catch(() => {});
        throw err;
      }
      v = { pass: false, error: err.message };
    }
    metric(e, 'pre_merge_verify', at, { outcome: verifyOutcome(v), verified: v });
    noteFlaky(e, v);
  }
  const out = await undoPreMerge(ctx, e);
  if (out) return out;
  e.preMerged = integSha;
  save();
  if (v) d.log(`${e.feature} pre-merge verify: ${verifyOutcome(v)}`);
  return null;
}

// Puts the feature worktree back on its branch after the pre-merge verify (SPEC §8.10):
// `git checkout -f` leaves a merge in progress or a detached merge commit, drops what the merge
// and the verify changed in tracked files and removes MERGE_HEAD. Returns a blocked outcome or null.
export async function undoPreMerge(ctx, e) {
  const { d, state, g, save, harnessRel, wtOf } = ctx;
  const wt = wtOf(e.feature);
  const branch = `harness/${e.feature}`;
  const r = await g(['checkout', '-q', '-f', branch], wt);
  if (r.code !== 0) return blocked('merge_conflict', `cannot return ${wt} to ${branch} after the pre-merge verify: git checkout -f failed (${gitCause(r)}) — clean it by hand`);
  // Untracked files the verify wrote would join the next builder commit; ignored files and
  // .harness/ (the core's records) stay. The second -f also removes untracked nested git
  // repositories (a verify that clones one). A failed clean is a warning, the run goes on.
  const c = await g(['clean', '-q', '-f', '-f', '-d', '--', '.', `:(exclude,top,literal)${harnessRel}`], wt);
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
export function unresolvedIntegration({ integ }) {
  return `integration branch '${integ}' (refs/heads/${integ}) cannot be resolved to a commit — nothing was merged`;
}

// Takes a feature worktree out of a merge in progress after a failed recovery (SPEC §8.10):
// `git merge --abort`, and if that fails `git reset --hard` to the pre-merge commit (HEAD
// while the merge is uncommitted). Returns null when nothing was needed or the abort worked,
// else {clean, detail} for the blocked detail.
export async function leaveMerge(ctx, wt) {
  const { g } = ctx;
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
export async function leaveCommittedMerge(ctx, wt, preMergeHead) {
  const { g } = ctx;
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
export async function resolveConflict(ctx, e, contract) {
  const { root, d, cfg, g, signal, stepTimeout, redact, save, integ, wtOf, cwdOf, stamp, metric, addCost, reserveBuild, stopRunOnBudget, isFatal, stopOnUsageLimit, step, sleptThrough } = ctx;
  const wt = wtOf(e.feature);
  // `reason`: every caller names it (F109 AC-4).
  const fail = async (detail, reason) => {
    const left = (await leaveMerge(ctx, wt)) ?? (await leaveCommittedMerge(ctx, wt, e.conflict?.preMergeHead));
    return blocked(reason, `automatic conflict resolution failed: ${detail}${left ? `; ${left.detail}` : ''}`);
  };
  // 1. the conflicted state, in the feature worktree only (resume keeps a merge in progress)
  if (!e.conflict?.integSha || !(await revParse(g, 'MERGE_HEAD', wt))) {
    const integSha = await revParse(g, `refs/heads/${integ}`, root);
    if (!integSha) return blocked('merge_conflict', unresolvedIntegration(ctx));
    const preMergeHead = await revParse(g, 'HEAD', wt);
    const r = await g(['merge', '--no-ff', '--no-edit', '-m', `harness: merge ${integ} into harness/${e.feature} (conflict resolution)`, integSha], wt);
    const files = r.code === 0 ? []
      : (await g(['diff', '--name-only', '--diff-filter=U'], wt)).stdout.trim().split(/\r?\n/).filter(Boolean);
    if (r.code !== 0 && files.length === 0) return fail(gitCause(r), 'merge_conflict');
    // What the merge left, so the marker check covers every file the builder changes.
    e.conflict = { integSha, files, preMergeHead, snapshot: files.length ? await worktreeSnapshot(g, wt) : null };
    save();
  }
  const { integSha, files } = e.conflict;
  // 2. one builder call with the conflicting files
  if (files.length) {
    let b;
    const hold = {};
    const m = ctx.meter.mark();
    const at = stamp();
    const who = roleCall(cfg, 'builder', { tier: contract.security_tier, round: e.round, conflict: true });
    try {
      b = await step(e, async () => {
        hold.r = await reserveBuild(e);
        return d.build({
          root, cwd: cwdOf(e.feature), featureId: e.feature, round: e.round, attempt: 1, contract,
          findings: [], verifyFailure: null, conflicts: files, config: cfg,
          timeoutSec: stepTimeout, budgetUsd: hold.r.usd, signal, redact, ...who,
        });
      });
    } catch (err) {
      hold.r?.release();
      if (isFatal(err)) throw err;
      b = { ok: false, error: 'exit_nonzero', detail: err.message };
    }
    metric(e, 'conflict_resolve', at, { role: 'builder', who, costUsd: b?.costUsd, usage: b, outcome: b?.ok ? 'ok' : (b?.error || 'failed') });
    addCost(e, b?.costUsd);
    hold.r?.release();
    // The merge stays in progress in the feature worktree; resume calls the builder again.
    if (b?.error === 'usage_limit') stopOnUsageLimit(e, 'conflict_resolve', b.detail);
    save();
    d.log(`${e.feature} conflict resolution build: ${b?.ok ? 'ok' : (b?.error || 'failed')}`);
    const over = stopRunOnBudget(e.feature);
    if (over) return over;
    sleptThrough(m, b?.error === 'timeout', e, 'build');
    // A refusal is not asked again (SPEC §8): the merge is left and the feature is blocked as one.
    if (!b?.ok) return fail(`builder ${b?.error || 'failed'}${b?.detail ? ` (${b.detail})` : ''} — conflicts in ${files.join(', ')}`, b?.error === 'refusal' ? 'refusal' : 'merge_conflict');
    // Every file the resolution changed, not only the ones git reported as conflicted.
    const changed = new Set([...files, ...(await changedSince(g, wt, e.conflict))]);
    const marked = conflictMarkedFiles(wt, changed);
    if (marked.length) return fail(`conflict markers left in ${marked.join(', ')}`, 'merge_conflict');
  }
  // 3. the core completes the merge; the builder may have committed it already
  if (await gitOk(g, ['status', '--porcelain'], wt, 'git status failed')) await gitOk(g, ['add', '-A'], wt, 'git add failed');
  if ((await revParse(g, 'MERGE_HEAD', wt)) || (await gitOk(g, ['status', '--porcelain'], wt, 'git status failed'))) {
    const c = await g(['commit', '-q', '--no-edit', '-m', `harness: merge ${integ} into harness/${e.feature} (conflict resolution)`], wt);
    if (c.code !== 0) return fail(`cannot commit the resolved merge: ${gitCause(c)}`, 'merge_conflict');
  }
  if ((await g(['merge-base', '--is-ancestor', integSha, 'HEAD'], wt)).code !== 0) return fail(`harness/${e.feature} does not contain ${integ} after the resolution`, 'merge_conflict');
  // Verify and eval now judge the feature against the integration commit it contains.
  e.baseSha = integSha;
  e.conflict = null;
  return null;
}

// After a failed post-merge verify (rolled back): merges the integration branch into the
// feature worktree and lets the builder fix the failed items once (SPEC §8.10). Returns a
// blocked outcome or null; on null the feature is verified and evaluated again (base = the
// integration commit it now contains) before the next merge attempt.
export async function recoverPostMerge(ctx, e, contract) {
  const { root, d, cfg, g, signal, stepTimeout, redact, save, integ, wtOf, cwdOf, stamp, metric, addCost, reserveBuild, stopRunOnBudget, isFatal, stopOnUsageLimit, step, sleptThrough } = ctx;
  const wt = wtOf(e.feature);
  // `reason`: every caller names it (F109 AC-4); null derives it from the state the merge left.
  const fail = async (detail, reason) => {
    const left = await leaveMerge(ctx, wt);
    // A worktree left mid-merge is a merge problem, not the verify failure (SPEC §8.10).
    return blocked(reason ?? (left && !left.clean ? 'merge_conflict' : 'post_merge_verify'),
      `automatic post-merge verify recovery failed: ${detail}${left ? `; ${left.detail}` : ''}`, { failures: e.postMerge?.failures });
  };
  // 1. integration into the feature worktree only (resume finds it merged already)
  if (!e.postMerge.integSha) {
    const integSha = await revParse(g, `refs/heads/${integ}`, root);
    if (!integSha) return blocked('merge_conflict', unresolvedIntegration(ctx));
    if ((await g(['merge-base', '--is-ancestor', integSha, 'HEAD'], wt)).code !== 0) {
      const r = await g(['merge', '--no-ff', '--no-edit', '-m', `harness: merge ${integ} into harness/${e.feature} (post-merge verify recovery)`, integSha], wt);
      if (r.code !== 0) return fail(`cannot merge ${integ} into harness/${e.feature}: ${gitCause(r)}`, null);
    }
    e.postMerge.integSha = integSha;
    save();
  }
  const { integSha, failures } = e.postMerge;
  // 2. one builder call with the failed items
  if (!e.postMerge.built) {
    let b;
    const hold = {};
    const m = ctx.meter.mark();
    const at = stamp();
    const who = roleCall(cfg, 'builder', { tier: contract.security_tier, round: e.round });
    try {
      b = await step(e, async () => {
        hold.r = await reserveBuild(e);
        return d.build({
          root, cwd: cwdOf(e.feature), featureId: e.feature, round: e.round, attempt: 1, contract,
          findings: [], verifyFailure: null, postMergeFailures: failures, config: cfg,
          timeoutSec: stepTimeout, budgetUsd: hold.r.usd, signal, redact, ...who,
        });
      });
    } catch (err) {
      hold.r?.release();
      if (isFatal(err)) throw err;
      b = { ok: false, error: 'exit_nonzero', detail: err.message };
    }
    metric(e, 'post_merge_recovery', at, { role: 'builder', who, costUsd: b?.costUsd, usage: b, outcome: b?.ok ? 'ok' : (b?.error || 'failed') });
    addCost(e, b?.costUsd);
    hold.r?.release();
    if (b?.error === 'usage_limit') stopOnUsageLimit(e, 'post_merge_recovery', b.detail); // resume builds again
    save();
    d.log(`${e.feature} post-merge verify recovery build: ${b?.ok ? 'ok' : (b?.error || 'failed')}`);
    const over = stopRunOnBudget(e.feature);
    if (over) return over;
    sleptThrough(m, b?.error === 'timeout', e, 'build');
    // A refusal is not asked again (SPEC §8): the feature is blocked as one.
    if (!b?.ok) return fail(`builder ${b?.error || 'failed'}${b?.detail ? ` (${b.detail})` : ''}`, b?.error === 'refusal' ? 'refusal' : null);
    e.postMerge.built = true;
    save();
  }
  if ((await g(['merge-base', '--is-ancestor', integSha, 'HEAD'], wt)).code !== 0) return fail(`harness/${e.feature} does not contain ${integ} after the recovery`, null);
  // Verify and eval now judge the feature against the integration commit it contains.
  e.baseSha = integSha;
  e.postMerge = null;
  return null;
}
