// `harness merge-check F<n>`: before a passed feature is merged, confirm the working tree is the
// one its passed verdict judged (SPEC §7.9). The verdict compared is the last passed verdict whose
// contract_hash is the current contract's hash; its `tree` must equal the current working tree
// (tracked and non-ignored untracked files, .harness/ left out). Reads state, writes nothing —
// the repository's index included (the tree is built in a temporary index).
import fs from 'node:fs';
import path from 'node:path';
import { HarnessError } from '../errors.mjs';
import { loadConfig, gitTimeoutOf } from '../config.mjs';
import { loadFeatures, paths, readJson, verdictRounds } from '../state.mjs';
import { hashContract } from '../contract.mjs';
import { evaluatedTree } from '../verify.mjs';
import { runCommand } from '../exec.mjs';

const USAGE = 'usage: harness merge-check F<n>';
const TREE_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function parseArgs(args) {
  let feature;
  for (const a of args) {
    if (a.startsWith('-')) throw new HarnessError(`unknown option '${a}'\n${USAGE}`, { code: 'usage' });
    if (feature) throw new HarnessError(`unexpected argument '${a}'\n${USAGE}`, { code: 'usage' });
    feature = a;
  }
  if (!feature) throw new HarnessError(USAGE, { code: 'usage' });
  if (!/^F\d+$/.test(feature)) throw new HarnessError(`invalid feature id '${feature}' (expected F<n>)\n${USAGE}`, { code: 'usage' });
  return feature;
}

// The last passed verdict of `featureId` judged against the contract hash `hash`, or undefined.
function lastPassed(dir, featureId, hash) {
  for (const k of verdictRounds(dir, featureId).reverse()) {
    const v = readJson(path.join(dir, `${featureId}-r${k}.json`));
    if (v && v.verdict === 'pass' && v.contract_hash === hash) return { round: k, verdict: v };
  }
  return undefined;
}

// Paths that differ between two trees, as git reports them.
async function changedPaths(oldTree, newTree, { cwd, timeoutSec }) {
  const r = await runCommand({ file: 'git', args: ['-c', 'core.quotePath=false', 'diff-tree', '-r', '--name-only', '--no-renames', oldTree, newTree] },
    { cwd, timeoutSec });
  if (r.code !== 0) return null;
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

export default async function mergeCheck({ root, args, out, err }) {
  const featureId = parseArgs(args);
  const config = loadConfig(root);
  const feature = loadFeatures(root).features.find((f) => f.id === featureId);
  if (!feature) throw new HarnessError(`unknown feature '${featureId}'\n${USAGE}`, { code: 'usage' });
  const p = paths(root);
  if (feature.status !== 'passed') {
    err(`harness: ${featureId} is ${feature.status}, not passed — merge only a feature that passed harness eval`);
    return 1;
  }
  if (!fs.existsSync(p.contract(featureId))) throw new HarnessError(`${p.contract(featureId)}: not found`, { code: 'missing' });
  const hash = hashContract(readJson(p.contract(featureId)));
  const found = lastPassed(p.verdicts, featureId, hash);
  if (!found) {
    err(`harness: ${featureId}: no evaluated tree — no passed verdict for the current contract (hash ${hash.slice(0, 12)})`);
    return 1;
  }
  const evaluated = found.verdict.tree;
  if (typeof evaluated !== 'string' || !TREE_ID.test(evaluated)) {
    err(`harness: ${featureId}: no evaluated tree in verdict r${found.round} (written before F185) — run harness eval again or ask the user`);
    return 1;
  }
  const timeoutSec = gitTimeoutOf(config);
  const current = await evaluatedTree({ root, timeoutSec });
  if (current === evaluated) {
    out(`ok ${featureId} tree ${current.slice(0, 12)}`);
    return 0;
  }
  const changed = await changedPaths(evaluated, current, { cwd: root, timeoutSec });
  const lines = [`harness: ${featureId}: tree changed since eval (verdict r${found.round} tree ${evaluated.slice(0, 12)}, now ${current.slice(0, 12)})`];
  if (changed?.length) lines.push('changed paths:', ...changed.map((f) => `  ${f}`));
  else if (!changed) lines.push('changed paths: unknown (the evaluated tree is not in this repository)');
  lines.push('do not merge: revert the changes made after eval, or ask the user');
  err(lines.join('\n'));
  return 1;
}
