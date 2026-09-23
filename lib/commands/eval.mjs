import path from 'node:path';
import { HarnessError } from '../errors.mjs';
import { loadConfig } from '../config.mjs';
import { evaluate } from '../eval.mjs';

const USAGE = 'usage: harness eval F<n> [--round <k>] [--base <ref>] [--cwd <dir>] [--json]';

function parseArgs(args) {
  const opts = { json: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--json') opts.json = true;
    else if (a === '--base' || a === '--cwd' || a === '--round') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) throw new HarnessError(`${a} needs a value\n${USAGE}`, { code: 'usage' });
      opts[a.slice(2)] = v;
      i += 1;
    } else if (a.startsWith('-')) throw new HarnessError(`unknown option '${a}'\n${USAGE}`, { code: 'usage' });
    else if (opts.feature) throw new HarnessError(`unexpected argument '${a}'\n${USAGE}`, { code: 'usage' });
    else opts.feature = a;
  }
  if (!opts.feature) throw new HarnessError(USAGE, { code: 'usage' });
  if (opts.round !== undefined) {
    if (!/^[1-9]\d*$/.test(opts.round)) throw new HarnessError(`--round must be a positive integer\n${USAGE}`, { code: 'usage' });
    opts.round = Number(opts.round);
  }
  return opts;
}

function summary(r) {
  const lines = [`eval ${r.feature} round ${r.round}: ${r.verdict.toUpperCase()}${r.error ? ` (${r.error}${r.detail ? `: ${r.detail}` : ''})` : ''}`];
  if (r.scores) {
    lines.push(`score ${r.score} (min of ${Object.entries(r.scores).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  }
  lines.push(`independence: ${r.independence}; cost: $${(r.costUsd ?? 0).toFixed(2)}`);
  if (r.blocking.length) {
    lines.push('blocking findings:');
    for (const b of r.blocking) lines.push(`  ${b.criterion_id} [${b.source}] ${b.summary}\n    repro: ${b.repro} (exit ${b.exit ?? b.signal})`);
  }
  if (r.backlogged.length) lines.push(`backlogged: ${r.backlogged.length} (see .harness/backlog.json)`);
  if (r.verdict === 'needs-human') lines.push('low score without a reproducible finding after one re-ask — a human decides');
  lines.push(`verdict file: ${r.file}`);
  return lines.join('\n');
}

export default async function evalCommand({ root, args, out }) {
  const opts = parseArgs(args);
  const config = loadConfig(root);
  const base = opts.base ?? config.base_branch;
  const cwd = opts.cwd ? path.resolve(root, opts.cwd) : root;
  const result = await evaluate({ root, cwd, featureId: opts.feature, round: opts.round, base, config });
  out(opts.json ? JSON.stringify(result, null, 2) : summary(result));
  if (result.verdict === 'pass') return 0;
  if (result.verdict === 'eval_error') return 2;
  return 1;
}
