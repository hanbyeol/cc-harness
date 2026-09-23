import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { HarnessError } from '../errors.mjs';
import { loadConfig } from '../config.mjs';
import { loadFeatures, saveFeatures, writeJsonAtomic } from '../state.mjs';
import { hashContract, lintContract, loadContract } from '../contract.mjs';
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

// All-or-nothing: every named contract is loaded and linted before anything is written.
export default async function approve({ root, args, out, err }) {
  const { ids, by: byArg } = parseArgs(args);
  const { limits } = loadConfig(root);
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
  for (const { id, contract, file } of loaded) {
    contract.approval = { by, at, hash: hashContract(contract) };
    writeJsonAtomic(file, contract);
    byId.get(id).status = 'approved';
    out(`approved ${id} (${contract.approval.hash.slice(0, 12)})`);
  }
  saveFeatures(root, data);
  return 0;
}
