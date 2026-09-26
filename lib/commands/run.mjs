import path from 'node:path';
import { HarnessError } from '../errors.mjs';
import { runFeatures } from '../run.mjs';

const USAGE = 'usage: harness run [F<n> ...] [--resume] [--max-usd <N>] [--parallel <N>]';

export function parseArgs(args) {
  const opts = { ids: [], resume: false, maxUsd: undefined, parallel: undefined };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--resume') opts.resume = true;
    else if (a === '--max-usd') {
      const v = args[i + 1];
      const n = Number(v);
      if (v === undefined || v.trim() === '' || !Number.isFinite(n) || n < 0) {
        throw new HarnessError(`--max-usd needs a non-negative number\n${USAGE}`, { code: 'usage' });
      }
      opts.maxUsd = n;
      i += 1;
    } else if (a === '--parallel') {
      const v = args[i + 1];
      if (v === undefined || !/^[1-9][0-9]*$/.test(v) || !Number.isSafeInteger(Number(v))) {
        throw new HarnessError(`--parallel needs a positive integer, got ${v === undefined ? 'nothing' : JSON.stringify(v)}\n${USAGE}`, { code: 'usage' });
      }
      opts.parallel = Number(v);
      i += 1;
    } else if (a.startsWith('-')) throw new HarnessError(`unknown option '${a}'\n${USAGE}`, { code: 'usage' });
    else if (/^F\d+$/.test(a)) opts.ids.push(a);
    else throw new HarnessError(`invalid feature id '${a}'\n${USAGE}`, { code: 'usage' });
  }
  if (opts.resume && opts.ids.length) throw new HarnessError(`--resume continues the saved run; do not pass feature ids\n${USAGE}`, { code: 'usage' });
  return opts;
}

export default async function run({ root, args, out, err }) {
  const opts = parseArgs(args);
  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130); // second Ctrl-C: leave now, state was saved at the last step
    err('harness: interrupt received — stopping the current step and saving run state');
    controller.abort();
  };
  process.on('SIGINT', onSigint);
  try {
    const r = await runFeatures({
      root, ids: opts.ids.length ? opts.ids : undefined, resume: opts.resume, maxUsd: opts.maxUsd, parallel: opts.parallel,
      signal: controller.signal, deps: { log: (m) => out(m) },
    });
    if (r.sleep) {
      err(`harness: run stopped — ${r.sleep.feature} ${r.sleep.stage} timed out after system sleep; ${r.sleep.feature} is not blocked. State saved to ${path.relative(root, r.statePath)}`);
      err('continue with: harness run --resume');
      return 1;
    }
    if (r.interrupted) {
      err(`harness: run interrupted — state saved to ${path.relative(root, r.statePath)}`);
      err('continue with: harness run --resume');
      // A step's child process may still hold the event loop; do not wait for it.
      setTimeout(() => process.exit(130), 1000).unref();
      return 130;
    }
    for (const x of r.results) out(`${x.feature.padEnd(5)} ${x.status}${x.reason ? ` (${x.reason})` : ''}`);
    if (r.results.length === 0) out('no approved, executable features in scope');
    if (r.stopped) err(`harness: run stopped — ${r.stopped.detail || r.stopped.reason}`);
    out(`cost: $${r.costUsd.toFixed(2)}`);
    out(`report: ${path.relative(root, r.report)}`);
    return !r.stopped && r.results.every((x) => x.status === 'passed') ? 0 : 1;
  } finally {
    process.off('SIGINT', onSigint);
  }
}
