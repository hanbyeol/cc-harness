import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { HarnessError } from '../errors.mjs';
import { loadConfig } from '../config.mjs';
import { loadFeatures, saveFeatures, writeJsonAtomic } from '../state.mjs';
import { hashContract, isApprovalValid, lintContract, loadContract } from '../contract.mjs';
import { criteriaDiff, criterionHashes, readEvents, recordEvent } from '../events.mjs';
import { formatProblem } from './lint-contract.mjs';

const USAGE = 'usage: harness approve F3 [F4 ...] [--by <who>]';

function parseArgs(args) {
  const ids = [];
  let by;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--by') {
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
  return { ids: [...new Set(ids)], by };
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

// All-or-nothing: every named contract is loaded and linted before anything is written.
export default async function approve({ root, args, out, err }) {
  const { ids, by: byArg } = parseArgs(args);
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
    const problems = lintContract(l.contract, { limits, bytes: l.bytes, expectId: id, ignoreApproval: true });
    for (const p of problems) out(formatProblem(id, p));
    if (problems.some((p) => p.level === 'error')) failed += 1;
    loaded.push({ id, ...l });
  }
  if (failed) {
    err(`harness: ${failed} contract(s) failed lint — nothing approved`);
    return 1;
  }

  const by = byArg || defaultApprover(root);
  const at = new Date().toISOString();
  let past = [];
  try { past = readEvents(root).events; } catch { /* no history: every criterion counts as added */ }
  const recorded = [];
  for (const { id, contract, file } of loaded) {
    contract.approval = { by, at, hash: hashContract(contract) };
    writeJsonAtomic(file, contract);
    const from = byId.get(id).status;
    byId.get(id).status = 'approved';
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
