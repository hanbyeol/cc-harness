// `harness decide F<n> --accept-risk|--split|--rewrite "<reason>"` — records a human decision
// (SPEC §2 피드백 단계): a feedback/decision event and a backlog item of kind decision.
// Only --drop changes the status (todo/approved/blocked -> skipped); the others are a record for the human.
import { HarnessError } from '../errors.mjs';
import { loadConfig } from '../config.mjs';
import { loadFeatures, saveFeatures, setFeatureStatus, paths } from '../state.mjs';
import { appendItem } from '../backlog.mjs';
import { redactor } from '../failures.mjs';
import { recordEvent } from '../events.mjs';

const USAGE = 'usage: harness decide F<n> --accept-risk|--split|--rewrite|--drop "<reason>"';
export const DECISIONS = Object.freeze(['accept-risk', 'split', 'rewrite', 'drop']);
const DROPPABLE = ['todo', 'approved', 'blocked'];

function parseArgs(args) {
  let feature = null;
  let decision = null;
  const rest = [];
  for (const a of args) {
    const flag = a.startsWith('--') ? a.slice(2) : null;
    if (flag !== null && DECISIONS.includes(flag)) {
      if (decision) throw new HarnessError(`give one decision, not --${decision} and ${a}\n${USAGE}`, { code: 'usage' });
      decision = flag;
    } else if (a.startsWith('-') && a.length > 1) throw new HarnessError(`unexpected option '${a}'\n${USAGE}`, { code: 'usage' });
    else if (feature === null) feature = a;
    else rest.push(a);
  }
  if (!feature || !/^F\d+$/.test(feature)) throw new HarnessError(`decide needs a feature id F<n>\n${USAGE}`, { code: 'usage' });
  if (!decision) throw new HarnessError(`decide needs one of ${DECISIONS.map((d) => `--${d}`).join('|')}\n${USAGE}`, { code: 'usage' });
  if (rest.length > 1) throw new HarnessError(`give the reason as one quoted argument\n${USAGE}`, { code: 'usage' });
  const reason = (rest[0] ?? '').trim();
  if (!reason) throw new HarnessError(`decide needs a non-empty reason\n${USAGE}`, { code: 'usage' });
  return { feature, decision, reason };
}

export default async function decide({ root, args, out, err }) {
  const { feature, decision, reason } = parseArgs(args);
  const data = loadFeatures(root);
  const entry = data.features.find((f) => f.id === feature);
  if (!entry) throw new HarnessError(`unknown feature ${feature} — not in ${paths(root).features}\n${USAGE}`, { code: 'usage' });
  if (decision === 'drop' && !DROPPABLE.includes(entry.status)) {
    throw new HarnessError(`${feature} is ${entry.status}; --drop closes only ${DROPPABLE.join('|')} features\n${USAGE}`, { code: 'usage' });
  }
  const config = loadConfig(root);
  const redact = redactor(process.env, config.env_allowlist);
  const redacted = redact(reason);
  const item = {
    kind: 'decision', feature, decision, reason: redacted,
    summary: `decision ${decision} for ${feature}: ${redacted}`, at: new Date().toISOString(),
  };
  appendItem(paths(root).backlog, item);
  const ok = recordEvent(root, { stage: 'feedback', type: 'decision', feature, data: { decision, reason, backlog_id: item.id } },
    { redact, warn: err });
  if (decision === 'drop') {
    const from = entry.status;
    setFeatureStatus(entry, 'skipped');
    saveFeatures(root, data);
    out(`${feature}: decision drop recorded (backlog ${item.id}); status ${from} -> skipped`);
  } else out(`${feature}: decision ${decision} recorded (backlog ${item.id}); status unchanged (${entry.status})`);
  return ok ? 0 : 1;
}
