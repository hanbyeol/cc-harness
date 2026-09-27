// `harness events [--stage S] [--feature F] [--since YYYY-MM-DD] [--json]` — the event log
// (.harness/events/*.jsonl, SPEC §2 이벤트 기록), oldest first.
import { HarnessError } from '../errors.mjs';
import { STAGES, readEvents, filterEvents } from '../events.mjs';

const USAGE = 'usage: harness events [--stage S] [--feature F] [--since YYYY-MM-DD] [--json]';

function parseArgs(args) {
  const opts = { json: false, stage: null, feature: null, since: null };
  const value = (i, name) => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('-')) throw new HarnessError(`${name} needs a value\n${USAGE}`, { code: 'usage' });
    return v;
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--json') opts.json = true;
    else if (a === '--stage') {
      opts.stage = value(i, a);
      if (!STAGES.includes(opts.stage)) throw new HarnessError(`--stage must be one of ${STAGES.join('|')}\n${USAGE}`, { code: 'usage' });
      i += 1;
    } else if (a === '--feature') {
      opts.feature = value(i, a);
      if (!/^F\d+$/.test(opts.feature)) throw new HarnessError(`--feature needs a feature id F<n>\n${USAGE}`, { code: 'usage' });
      i += 1;
    } else if (a === '--since') {
      const v = value(i, a);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
        throw new HarnessError(`--since needs a date YYYY-MM-DD\n${USAGE}`, { code: 'usage' });
      }
      opts.since = v;
      i += 1;
    } else throw new HarnessError(`unexpected argument '${a}'\n${USAGE}`, { code: 'usage' });
  }
  return opts;
}

function render(e) {
  const where = [e.feature, Number.isInteger(e.round) ? `r${e.round}` : null].filter(Boolean).join(' ');
  return `${e.ts} ${e.stage}/${e.type}${where ? ` ${where}` : ''} ${JSON.stringify(e.data ?? {})}`;
}

export default async function events({ root, args, out, err }) {
  const opts = parseArgs(args);
  const { events: all, warnings } = readEvents(root);
  for (const w of warnings) err(`harness: warning: ${w}`);
  const selected = filterEvents(all, opts);
  if (opts.json) out(JSON.stringify(selected, null, 2));
  else if (!all.length) out('no events yet');
  else if (!selected.length) out('no matching events');
  else for (const e of selected) out(render(e));
  return 0;
}
