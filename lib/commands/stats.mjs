// `harness stats [--since YYYY-MM-DD] [--json]` — aggregates .harness/runs/*.metrics.jsonl (SPEC §8.11).
import { HarnessError } from '../errors.mjs';
import { paths, loadFeatures } from '../state.mjs';
import { loadConfig } from '../config.mjs';
import { readMetrics, sinceFilter, computeStats, renderStats } from '../metrics.mjs';

const USAGE = 'usage: harness stats [--since YYYY-MM-DD] [--json]';

function parseArgs(args) {
  const opts = { json: false, since: null };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--json') opts.json = true;
    else if (a === '--since') {
      const v = args[i + 1];
      if (v === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
        throw new HarnessError(`--since needs a date YYYY-MM-DD\n${USAGE}`, { code: 'usage' });
      }
      opts.since = v;
      i += 1;
    } else throw new HarnessError(`unexpected argument '${a}'\n${USAGE}`, { code: 'usage' });
  }
  return opts;
}

export default async function stats({ root, args, out, err }) {
  const opts = parseArgs(args);
  const { files, rows, warnings } = readMetrics(paths(root).runs);
  for (const w of warnings) err(`warning: ${w}`);
  if (!files.length) {
    out('no metrics yet');
    return 0;
  }
  const selected = sinceFilter(rows, opts.since);
  const config = loadConfig(root);
  const standardFeature = loadFeatures(root).features.some((f) => (f.security_tier ?? 'standard') === 'standard');
  const s = computeStats(selected, { stepTimeoutSec: config.budget?.step_timeout_sec ?? 1800, standardFeature });
  if (opts.json) {
    out(JSON.stringify({ since: opts.since, files, warnings, ...s }, null, 2));
  } else if (!selected.length) {
    out(opts.since ? `no metrics since ${opts.since}` : 'no metrics yet');
  } else {
    out(renderStats(s, { since: opts.since }));
  }
  return 0;
}
