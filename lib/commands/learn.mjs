// `harness learn [--hub <dir>] [--since YYYY-MM-DD] [--json] [--propose | --compare <v1> <v2>]`
// — reads the field data hub (SPEC §2 하네스 자기 개선). Read-only unless --propose, which
// records the candidates in this project's backlog. Nothing is turned into a contract here.
import { HarnessError } from '../errors.mjs';
import { isInitialized, paths } from '../state.mjs';
import { hubDir } from '../telemetry.mjs';
import { NO_DATA, compare, emptyLearn, learn, propose, readHub, renderCompare, renderLearn } from '../learn.mjs';

const USAGE = 'usage: harness learn [--hub <dir>] [--since YYYY-MM-DD] [--json] [--propose | --compare <v1> <v2>]';
const usage = (msg) => new HarnessError(`${msg}\n${USAGE}`, { code: 'usage' });
const value = (args, i) => (args[i] === undefined || args[i] === '' || args[i].startsWith('-') ? undefined : args[i]);

function parseArgs(args) {
  const opts = { hub: null, since: null, json: false, propose: false, compare: null };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--json') opts.json = true;
    else if (a === '--propose') opts.propose = true;
    else if (a === '--hub') {
      opts.hub = value(args, i + 1);
      if (opts.hub === undefined) throw usage('--hub needs a directory');
      i += 1;
    } else if (a === '--since') {
      const v = args[i + 1];
      if (v === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw usage('--since needs a date YYYY-MM-DD');
      opts.since = v;
      i += 1;
    } else if (a === '--compare') {
      const v1 = value(args, i + 1);
      const v2 = value(args, i + 2);
      if (v1 === undefined || v2 === undefined) throw usage('--compare needs two harness versions');
      opts.compare = [v1, v2];
      i += 2;
    } else throw usage(`unexpected argument '${a}'`);
  }
  if (opts.propose && opts.compare) throw usage('--propose and --compare cannot be combined');
  return opts;
}

export default async function learnCommand({ root, args, out, err, env = process.env }) {
  const opts = parseArgs(args);
  if (opts.propose && !isInitialized(root)) throw new HarnessError('not initialized — run `harness init` (--propose writes this project\'s backlog)', { code: 'not_initialized' });
  const { lines, warnings } = readHub(hubDir({ hub: opts.hub, root, env }), { since: opts.since });
  for (const w of warnings) err(`harness: warning: ${w}`);
  if (!lines.length) {
    out(opts.json ? JSON.stringify(emptyLearn(opts.since), null, 2) : NO_DATA);
    return 0;
  }
  if (opts.compare) {
    for (const v of new Set(opts.compare)) if (!lines.some((l) => l.version === v)) err(`harness: warning: no field data for version ${v}`);
    const c = compare(lines, ...opts.compare, { since: opts.since });
    if (opts.json) out(JSON.stringify(c, null, 2));
    else for (const line of renderCompare(c)) out(line);
    return 0;
  }
  const report = learn(lines, { since: opts.since });
  if (opts.json) out(JSON.stringify(report, null, 2));
  else for (const line of renderLearn(report)) out(line);
  if (opts.propose) {
    const { added, updated } = propose(paths(root).backlog, report.candidates);
    if (!opts.json) {
      out(`proposed: ${added.length} added, ${updated.length} updated (${paths(root).backlog})`);
      for (const i of added) out(`  ${i.id} [${i.priority}] ${i.learn_rule} added`);
      for (const i of updated) out(`  ${i.id} [${i.priority ?? 'none'}] ${i.learn_rule} seen ${i.seen}`);
    } else err(`harness: proposed ${added.length} added, ${updated.length} updated`);
  }
  return 0;
}
