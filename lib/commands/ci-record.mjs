// `harness ci-record --sha <sha> --result success|failure [--job <name>] [--test <name>]...` —
// records one CI result as a feedback/ci event (SPEC §2 피드백 단계). `--test` names a failed
// test; insights counts a name recorded in several runs as a repeated failure.
import { HarnessError } from '../errors.mjs';
import { recordEvent } from '../events.mjs';

const USAGE = 'usage: harness ci-record --sha <sha> --result success|failure [--job <name>] [--test <name>]...';
export const RESULTS = Object.freeze(['success', 'failure']);

function parseArgs(args) {
  const opts = { sha: null, result: null, job: null, tests: [] };
  const value = (i, name) => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('-') || !v.trim()) throw new HarnessError(`${name} needs a value\n${USAGE}`, { code: 'usage' });
    return v;
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--sha') {
      opts.sha = value(i, a);
      if (!/^[0-9a-f]{4,64}$/i.test(opts.sha)) throw new HarnessError(`--sha needs a commit hash (hex)\n${USAGE}`, { code: 'usage' });
    } else if (a === '--result') {
      opts.result = value(i, a);
      if (!RESULTS.includes(opts.result)) throw new HarnessError(`--result must be one of ${RESULTS.join('|')}\n${USAGE}`, { code: 'usage' });
    } else if (a === '--job') opts.job = value(i, a);
    else if (a === '--test') opts.tests.push(value(i, a));
    else throw new HarnessError(`unexpected argument '${a}'\n${USAGE}`, { code: 'usage' });
    i += 1;
  }
  if (!opts.sha || !opts.result) throw new HarnessError(`ci-record needs --sha and --result\n${USAGE}`, { code: 'usage' });
  return opts;
}

export default async function ciRecord({ root, args, out, err }) {
  const data = parseArgs(args);
  const ok = recordEvent(root, { stage: 'feedback', type: 'ci', data }, { warn: err });
  out(`ci ${data.sha} ${data.result} recorded${data.tests.length ? ` (${data.tests.length} failed tests)` : ''}`);
  return ok ? 0 : 1;
}
