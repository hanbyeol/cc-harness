import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { HarnessError } from '../errors.mjs';
import { loadConfig, maxRoundsOf } from '../config.mjs';
import { paths, loadFeatures, saveFeatures as realSaveFeatures, writeJsonAtomic, setFeatureStatus } from '../state.mjs';
import { hashContract, isApprovalValid, lintContract, loadContract } from '../contract.mjs';
import { criteriaDiff, criterionHashes, readEvents, recordEvent } from '../events.mjs';
import { contractVerdicts, extraRoundsOf } from '../eval.mjs';
import { formatProblem } from './lint-contract.mjs';

const USAGE = 'usage: harness approve F3 [F4 ...] [--by <who>] [--extra-round]';

function parseArgs(args) {
  const ids = [];
  let by;
  let extraRound = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--extra-round') extraRound = true;
    else if (a === '--by') {
      by = args[++i];
      if (!by || by.startsWith('-') || !by.trim()) throw new HarnessError(`--by needs a value. ${USAGE}`, { code: 'usage' });
    } else if (a.startsWith('--by=')) {
      by = a.slice('--by='.length);
      if (!by.trim()) throw new HarnessError(`--by needs a value. ${USAGE}`, { code: 'usage' });
    } else if (a.startsWith('-')) {
      throw new HarnessError(`unknown option '${a}'. ${USAGE}`, { code: 'usage' });
    } else ids.push(a);
  }
  if (!ids.length) throw new HarnessError(USAGE, { code: 'usage' });
  return { ids: [...new Set(ids)], by, extraRound };
}

function defaultApprover(root) {
  const r = spawnSync('git', ['config', 'user.email'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const email = r.status === 0 ? r.stdout.trim() : '';
  if (email) return email;
  try { return os.userInfo().username || 'unknown'; } catch { return 'unknown'; }
}

// The previous approval of `id`: its last plan/approve event, else the contract committed at
// HEAD when that one carries a valid approval (approved before events were recorded).
function previousApproval(root, id, events) {
  const last = events.filter((e) => e.stage === 'plan' && e.type === 'approve' && e.feature === id).pop();
  if (last?.data?.criteria && typeof last.data.criteria === 'object') return { hash: last.data.hash ?? null, criteria: last.data.criteria };
  const r = spawnSync('git', ['show', `HEAD:./.harness/contracts/${id}.json`], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (r.status !== 0) return null;
  try {
    const c = JSON.parse(r.stdout);
    return isApprovalValid(c) ? { hash: c.approval.hash, criteria: criterionHashes(c) } : null;
  } catch { return null; }
}

// Blocked reasons that mean the rounds did not converge. Only these keep a same-hash
// re-approval from resetting the round limit; a feature blocked for another recorded reason
// (needs_human, eval_error, a run-stage reason) is re-approved (SPEC §7.6).
const CONVERGENCE_REASONS = new Set(['rounds', 'max_rounds', 'stall', 'divergence']);

// Rounds of the contract hash `hash` already evaluated, when `feature` is blocked with all its
// allowed rounds (max_rounds + extra) used; null otherwise (SPEC §7.6). A feature blocked
// before blocked_reason was recorded follows the verdict count alone.
function roundsExhausted(root, feature, hash, maxRounds) {
  if (feature.status !== 'blocked') return null;
  if (typeof feature.blocked_reason === 'string' && !CONVERGENCE_REASONS.has(feature.blocked_reason)) return null;
  const used = contractVerdicts(paths(root).verdicts, feature.id, hash).length;
  return used >= maxRounds + extraRoundsOf(feature, hash) ? used : null;
}

// All-or-nothing: every named contract is loaded and linted before anything is written.
// `deps.saveFeatures` is for tests.
export default async function approve({ root, args, out, err, deps = {} }) {
  const saveFeatures = deps.saveFeatures ?? realSaveFeatures;
  const { ids, by: byArg, extraRound } = parseArgs(args);
  const config = loadConfig(root);
  const { limits } = config;
  const data = loadFeatures(root);
  const byId = new Map(data.features.map((f) => [f.id, f]));

  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length) throw new HarnessError(`unknown feature id(s) in features.json: ${unknown.join(', ')} — nothing approved`, { code: 'unknown_contract' });

  const loaded = [];
  let failed = 0;
  for (const id of ids) {
    // Missing contract → HarnessError exit 2, before any write.
    const l = loadContract(root, id);
    // The old approval is being replaced, so its (possibly stale) hash is not a lint error here.
    const problems = lintContract(l.contract, { limits, bytes: l.bytes, expectId: id, ignoreApproval: true, testPaths: config.verify?.test_paths });
    for (const p of problems) out(formatProblem(id, p));
    if (problems.some((p) => p.level === 'error')) failed += 1;
    loaded.push({ id, ...l });
  }
  if (failed) {
    err(`harness: ${failed} contract(s) failed lint — nothing approved`);
    return 1;
  }

  // Re-approving the contract a feature used up its rounds with does not add rounds: only an
  // explicit --extra-round (one more round for this hash) does (SPEC §7.6).
  const maxRounds = maxRoundsOf(config);
  for (const l of loaded) {
    l.hash = hashContract(l.contract);
    l.used = roundsExhausted(root, byId.get(l.id), l.hash, maxRounds);
    if (extraRound && l.used === null) {
      throw new HarnessError(`${l.id} is not blocked after max_rounds — --extra-round only adds a round to a feature blocked with all rounds of its contract used; nothing approved`, { code: 'not_blocked' });
    }
    if (!extraRound && l.used !== null) {
      throw new HarnessError(`${l.id} is blocked after max_rounds with this contract — change the contract, or pass --extra-round to allow one more round; nothing approved`, { code: 'rounds_exhausted' });
    }
  }
  if (extraRound) return approveExtraRound({ root, loaded, byId, data, config, maxRounds, byArg, saveFeatures, out, err });

  const by = byArg || defaultApprover(root);
  const at = new Date().toISOString();
  let past = [];
  try { past = readEvents(root).events; } catch { /* no history: every criterion counts as added */ }
  const recorded = [];
  for (const { id, contract, file } of loaded) {
    contract.approval = { by, at, hash: hashContract(contract) };
    writeJsonAtomic(file, contract);
    const from = byId.get(id).status;
    setFeatureStatus(byId.get(id), 'approved');
    const prev = previousApproval(root, id, past);
    const criteria = criterionHashes(contract);
    recorded.push({ id, from, data: {
      version: contract.version ?? null, hash: contract.approval.hash, previous_hash: prev?.hash ?? null,
      ...criteriaDiff(prev?.criteria, criteria), criteria,
    } });
    out(`approved ${id} (${contract.approval.hash.slice(0, 12)})`);
  }
  saveFeatures(root, data);
  const opts = { config, warn: err };
  for (const { id, from, data: d } of recorded) {
    recordEvent(root, { stage: 'plan', type: 'approve', feature: id, data: d }, opts);
    if (from !== 'approved') recordEvent(root, { stage: 'plan', type: 'status', feature: id, data: { from, to: 'approved', reason: 'approve' } }, opts);
  }
  return 0;
}

// --extra-round: the feature goes back to approved with one more round allowed for this
// contract hash. The contract is left as it is (its approval is only rewritten when it is no
// longer valid). features.json is written first; if that fails nothing changed (exit 2).
function approveExtraRound({ root, loaded, byId, data, config, maxRounds, byArg, saveFeatures, out, err }) {
  const at = new Date().toISOString();
  const recorded = [];
  for (const { id, contract, file, hash, used } of loaded) {
    const f = byId.get(id);
    const count = extraRoundsOf(f, hash) + 1;
    recorded.push({ id, from: f.status, hash, round: used + 1, count, maxRounds, contract, file });
    setFeatureStatus(f, 'approved');
    f.extra_rounds = { hash, count };
  }
  saveFeatures(root, data);
  const opts = { config, warn: err };
  let by;
  for (const r of recorded) {
    if (!isApprovalValid(r.contract)) {
      by ??= byArg || defaultApprover(root);
      r.contract.approval = { by, at, hash: r.hash };
      writeJsonAtomic(r.file, r.contract);
    }
    out(`approved ${r.id} for one more round (${r.hash.slice(0, 12)}): contract round ${r.round} allowed (max_rounds ${r.maxRounds} +${r.count} extra)`);
    recordEvent(root, { stage: 'plan', type: 'decision', feature: r.id,
      data: { decision: 'extra_round', contract_round: r.round, extra_rounds: r.count, hash: r.hash } }, opts);
    recordEvent(root, { stage: 'plan', type: 'status', feature: r.id, data: { from: r.from, to: 'approved', reason: 'approve' } }, opts);
  }
  return 0;
}
