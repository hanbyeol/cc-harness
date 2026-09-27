// `harness note [F<n>] --kind manual-fix|manual-merge|environment|other "<text>"` — records a
// human intervention as a feedback/intervention event (SPEC §2 피드백 단계).
import { HarnessError } from '../errors.mjs';
import { recordEvent } from '../events.mjs';

const USAGE = 'usage: harness note [F<n>] --kind manual-fix|manual-merge|environment|other "<text>"';
export const KINDS = Object.freeze(['manual-fix', 'manual-merge', 'environment', 'other']);

function parseArgs(args) {
  let kind = null;
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--kind') {
      kind = args[i + 1];
      if (!KINDS.includes(kind)) throw new HarnessError(`--kind must be one of ${KINDS.join('|')}\n${USAGE}`, { code: 'usage' });
      i += 1;
    } else if (a.startsWith('-') && a.length > 1) throw new HarnessError(`unexpected option '${a}'\n${USAGE}`, { code: 'usage' });
    else rest.push(a);
  }
  if (!kind) throw new HarnessError(`note needs --kind\n${USAGE}`, { code: 'usage' });
  const feature = rest.length && /^F\d+$/.test(rest[0]) ? rest.shift() : null;
  if (rest.length > 1) throw new HarnessError(`give the text as one quoted argument\n${USAGE}`, { code: 'usage' });
  const text = (rest[0] ?? '').trim();
  if (!text) throw new HarnessError(`note needs a non-empty text\n${USAGE}`, { code: 'usage' });
  return { feature, kind, text };
}

export default async function note({ root, args, out, err }) {
  const { feature, kind, text } = parseArgs(args);
  const ok = recordEvent(root, { stage: 'feedback', type: 'intervention', feature, data: { kind, text } }, { warn: err });
  out(`${feature ? `${feature}: ` : ''}intervention ${kind} recorded`);
  return ok ? 0 : 1;
}
