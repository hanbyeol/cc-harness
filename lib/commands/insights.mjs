// `harness insights [--since YYYY-MM-DD] [--json]` — aggregates the event log into improvement
// candidates (SPEC §2 피드백 단계). Read-only: it never changes state.
import { HarnessError } from '../errors.mjs';
import { readEvents, filterEvents } from '../events.mjs';
import { emptyInsights, insights, renderInsights } from '../insights.mjs';

const USAGE = 'usage: harness insights [--since YYYY-MM-DD] [--json]';

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

export default async function insightsCommand({ root, args, out, err }) {
  const opts = parseArgs(args);
  const { events: all, warnings } = readEvents(root);
  for (const w of warnings) err(`harness: warning: ${w}`);
  const selected = filterEvents(all, { since: opts.since });
  if (opts.json) out(JSON.stringify(selected.length ? insights(selected, opts) : emptyInsights(opts.since), null, 2));
  else if (!all.length) out('no events yet');
  else if (!selected.length) out('no matching events');
  else for (const line of renderInsights(insights(selected, opts))) out(line);
  return 0;
}
