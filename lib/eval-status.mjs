// Interactive `harness eval`: one evaluation round, then the feature status recorded with
// the convergence rules `harness run` applies (SPEC §7.6). The run path does not come
// through here — it records status itself, after the merge and the post-merge verify.
import fs from 'node:fs';
import path from 'node:path';
import { HarnessError } from './errors.mjs';
import { paths, loadFeatures, saveFeatures as realSaveFeatures, verdictRounds } from './state.mjs';
import { loadContract, isApprovalValid, hashContract } from './contract.mjs';
import { evaluate as realEvaluate, nextRound, readVerdict, contractVerdicts } from './eval.mjs';
import { convergence, verdictBlockingIds, MAX_EVAL_ERRORS } from './run.mjs';
import { readBacklog, writeBacklog, resolveItems } from './backlog.mjs';
import { appendMetric, EVAL_METRICS } from './metrics.mjs';
import { redactor } from './failures.mjs';

export const ORIGIN = 'eval';
const EVALUABLE = new Set(['approved', 'in_progress']);

const RESCOPE = {
  rounds: 'the round limit was reached with blocking findings left',
  divergence: 'criteria that were not blocking came back — the change to fix one breaks another',
  stall: 'the blocking set did not shrink between rounds',
  eval_error: 'the evaluator failed twice in a row',
  needs_human: 'the evaluator scored below threshold without a reproducible finding',
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Blocking criterion ids of a failing verdict. A verify failure without findings still
// blocks as a whole ('VERIFY'), like the run's verify-only rounds.
const failIds = verdictBlockingIds;

/**
 * The status a verdict leads to (pure). `prev` is the previous verdict of the same contract
 * hash or null; the round is `contract_round` — rounds are counted per contract hash (§7.6).
 * @returns {{status:string|null, reason:string|null, ids?:string[], roundsLeft?:number}}
 *   status null = unchanged
 */
export function decideStatus({ verdict, prev, maxRounds }) {
  const k = Number.isInteger(verdict.contract_round) ? verdict.contract_round : verdict.round;
  if (verdict.verdict === 'pass') return { status: 'passed', reason: null };
  if (verdict.verdict === 'needs-human') return { status: 'blocked', reason: 'needs_human' };
  if (verdict.verdict === 'fail') {
    const ids = failIds(verdict);
    const c = convergence(prev && prev.verdict === 'fail' ? failIds(prev) : null, ids);
    if (c.blocked) return { status: 'blocked', reason: c.blocked, ids: c.ids };
    if (k >= maxRounds) return { status: 'blocked', reason: 'rounds', ids };
    return { status: 'in_progress', reason: null, ids, roundsLeft: maxRounds - k };
  }
  // eval_error (or anything unrecognized) does not consume a round.
  const n = Number.isInteger(verdict.consecutive) ? verdict.consecutive : 1;
  if (n >= MAX_EVAL_ERRORS) return { status: 'blocked', reason: 'eval_error' };
  return { status: null, reason: null };
}

function appendRescope(root, featureId, verdict, decision) {
  const file = paths(root).backlog;
  const data = readBacklog(file);
  const source = `${featureId}-blocked`;
  // A retried recording (ES-2) must not add the same proposal twice.
  if (data.items.some((i) => isObj(i) && i.source === source && i.round === verdict.round && i.reason === decision.reason)) return;
  const ids = decision.ids?.length ? decision.ids : [];
  const list = ids.length ? ids.join(', ') : featureId;
  data.items.push({
    source, feature: featureId, kind: 'rescope', reason: decision.reason, round: verdict.round, blocking: ids,
    at: new Date().toISOString(),
    summary: `${featureId} blocked (${decision.reason}): ${RESCOPE[decision.reason] || decision.reason}`,
    options: [
      { kind: 'split', summary: `split ${featureId} so ${list} ship as a separate feature with its own contract` },
      { kind: 'rewrite', summary: `rewrite the criteria for ${list} (new contract version, re-approval)` },
      { kind: 'accept', summary: `accept the risk: drop or relax ${list} with a recorded decision` },
    ],
  });
  writeBacklog(file, data);
}

// Writes the decision: backlog first (deduplicated; `resolves` on a pass), then features.json.
// `eval_round` in the feature entry marks the round whose status is recorded (the ES-2 retry key).
function record({ root, featureId, contract, verdict, decision, saveFeatures }) {
  if (decision.status === 'blocked') appendRescope(root, featureId, verdict, decision);
  if (decision.status === 'passed') resolveItems(paths(root).backlog, contract, featureId);
  if (decision.status === null) return;
  const data = loadFeatures(root);
  const f = data.features.find((x) => x.id === featureId);
  if (!f) throw new HarnessError(`feature ${featureId} disappeared from features.json`, { code: 'state_corrupt' });
  f.status = decision.status;
  if (verdict.verdict !== 'eval_error') f.eval_round = verdict.round;
  try {
    saveFeatures(root, data);
  } catch (e) {
    if (!(e instanceof HarnessError)) throw e;
    throw new HarnessError(`${e.message}\nthe verdict is kept in ${verdict.file}; run \`harness eval ${featureId}\` again to record the status`, { code: e.code });
  }
}

/**
 * Evaluates one round of `featureId` and records its status (SPEC §7.6).
 * Refusals (exit 2) happen before any adapter call.
 * @returns {Promise<object>} the verdict plus {feature_status, status_reason, rounds_left, retried}
 */
export async function evalAndRecord({ root, cwd = root, featureId, round, base, config, runAdapter, verifyResult, deps = {} }) {
  const evaluate = deps.evaluate ?? realEvaluate;
  const saveFeatures = deps.saveFeatures ?? realSaveFeatures;
  if (!/^F\d+$/.test(featureId || '')) throw new HarnessError(`invalid feature id '${featureId}' (expected F<n>)`, { code: 'usage' });
  const p = paths(root);
  const feature = loadFeatures(root).features.find((f) => f.id === featureId);
  if (!feature) throw new HarnessError(`unknown feature ${featureId} — not in ${p.features}`, { code: 'usage' });
  const { contract } = loadContract(root, featureId);
  readBacklog(p.backlog); // a corrupt backlog stops before anything is evaluated or recorded (E6)
  if (!isApprovalValid(contract)) {
    throw new HarnessError(`${featureId}: the contract is not approved or changed after approval — run \`harness approve ${featureId}\` (user approval) first; nothing evaluated`, { code: 'not_approved' });
  }
  const maxRounds = Number.isInteger(config.max_rounds) && config.max_rounds > 0 ? config.max_rounds : 3;
  const vdir = p.verdicts;
  const hash = hashContract(contract);
  const fileOf = (k) => path.join(vdir, `${featureId}-r${k}.json`);
  const existing = verdictRounds(vdir, featureId);
  // Verdicts of the current contract hash: the round count and the convergence comparison
  // use only these; older contracts (and pre-F18 verdicts without a hash) only take file
  // numbers (§7.6). Reading them all stops on a corrupt verdict before anything is spent (E6).
  const same = contractVerdicts(vdir, featureId, hash);
  const prevOf = (k) => {
    const earlier = same.filter((r) => r.k < k);
    return earlier.length ? earlier[earlier.length - 1].v : null;
  };
  const roundOf = (k) => same.filter((r) => r.k < k).length + 1;
  const finish = (verdict, retried) => {
    const decision = decideStatus({ verdict, prev: verdict.verdict === 'fail' ? prevOf(verdict.round) : null, maxRounds });
    record({ root, featureId, contract, verdict, decision, saveFeatures });
    return {
      ...verdict,
      max_rounds: maxRounds,
      feature_status: decision.status ?? feature.status,
      status_changed: decision.status !== null,
      status_reason: decision.reason,
      rounds_left: decision.roundsLeft ?? null,
      retried,
    };
  };

  // ES-2: the latest interactive verdict whose status was never recorded is recorded now,
  // without a new evaluation.
  if (existing.length) {
    const last = existing[existing.length - 1];
    const v = readVerdict(fileOf(last));
    if (v.origin === ORIGIN && feature.eval_round !== last && v.contract_hash === hash) {
      return finish({ ...v, contract_round: roundOf(last), file: fileOf(last) }, true);
    }
  }

  if (feature.status === 'passed' || feature.status === 'blocked') {
    throw new HarnessError(`${featureId} is already ${feature.status} — harness eval does not re-evaluate it; nothing evaluated`, { code: 'feature_closed' });
  }
  if (!EVALUABLE.has(feature.status)) {
    throw new HarnessError(`${featureId} has status ${feature.status} — only approved or in_progress features are evaluated; nothing evaluated`, { code: 'not_approved' });
  }
  const k = round ?? nextRound(vdir, featureId);
  if (fs.existsSync(fileOf(k))) {
    throw new HarnessError(`round ${k} of ${featureId} already has a verdict (${fileOf(k)}) — it is not overwritten; omit --round to evaluate the next round`, { code: 'round_exists' });
  }

  // Every evaluator / security-reviewer call is one line of runs/eval.metrics.jsonl (SPEC §8.11).
  // Redacted with the same function as the verdict (SR-8); evaluate() reads process.env too.
  const redact = redactor(process.env, Array.isArray(config.env_allowlist) ? config.env_allowlist : []);
  const onAdapterCall = (c) => appendMetric(path.join(p.runs, EVAL_METRICS), {
    feature: featureId, step: 'eval', ...c,
  }, redact);
  const result = await evaluate({ root, cwd, featureId, round: k, base, config, runAdapter, verifyResult, origin: ORIGIN, onAdapterCall });
  return finish(result, false);
}
