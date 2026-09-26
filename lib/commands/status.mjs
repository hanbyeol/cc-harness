import { isInitialized, loadFeatures, runnableFeatures, paths } from '../state.mjs';
import { readBacklog, openItems, SEVERITIES } from '../backlog.mjs';
import { executableFeatures } from '../contract.mjs';
import { HarnessError } from '../errors.mjs';

const ORDER = ['passed', 'in_progress', 'approved', 'todo', 'blocked', 'skipped'];
const HIGH_SHOWN = 5;
const SUMMARY_CHARS = 100;
const V1_INLINE_CHARS = 60;
const V1_LIST_CHARS = 120;
const V1_STATES = ['partial', 'in_progress', 'blocked', 'deferred'];

// A todo feature that migrate-v1 brought over (SPEC §13). Anything else prints as before.
const isV1Todo = (f) => f.status === 'todo' && f.v1 !== null && typeof f.v1 === 'object' && !Array.isArray(f.v1);
// v1.status is free text from a hand-edited file; a non-string or blank value is not shown.
const v1Text = (f, max) => (typeof f.v1.status === 'string' ? f.v1.status.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const v1State = (f) => (V1_STATES.includes(f.v1.state) ? f.v1.state : null);

export default async function status({ root, args, out }) {
  const brief = args.includes('--brief');
  const todoV1 = args.includes('--todo-v1');
  if (!isInitialized(root)) {
    // --brief runs from a SessionStart hook in every project; stay silent there.
    if (brief) return 0;
    throw new HarnessError('not initialized — run `harness init`', { code: 'not_initialized' });
  }
  const { features } = loadFeatures(root);
  const counts = {};
  for (const f of features) counts[f.status] = (counts[f.status] || 0) + 1;
  const v1Todo = features.filter(isV1Todo);
  const v1Count = (state) => v1Todo.filter((f) => v1State(f) === state).length;
  const summary = ORDER.filter((s) => counts[s]).map((s) => {
    const n = `${counts[s]} ${s}`;
    // In --brief the todo count is split so v1 work that was already started stands out.
    return brief && s === 'todo' && v1Count('partial') + v1Count('blocked') ? `${n} (v1 partial ${v1Count('partial')} · blocked ${v1Count('blocked')})` : n;
  }).join(' · ') || 'no features';
  if (todoV1) return listV1Todo(v1Todo, out);
  // Only contracts whose approval hash still matches can run (F2 AC-7); an edited
  // approved contract is shown as needing re-approval instead of as next.
  const next = executableFeatures(root).map((f) => f.id);
  const stale = runnableFeatures(features).map((f) => f.id).filter((id) => !next.includes(id));
  const open = openItems(readBacklog(paths(root).backlog));
  const high = open.filter((i) => i.priority === 'high');

  if (brief) {
    out(`harness: ${summary}${next.length ? ` — next: ${next.join(', ')}` : ''}${stale.length ? ` — re-approve: ${stale.join(', ')}` : ''}${high.length ? ` — backlog high: ${high.length}` : ''}`);
    return 0;
  }
  out(`features: ${summary}`);
  for (const f of features) {
    const v1 = isV1Todo(f) ? v1Text(f, V1_INLINE_CHARS) : '';
    out(`  ${f.id.padEnd(5)} ${f.status.padEnd(11)} ${f.title}${v1 ? ` (v1: ${v1})` : ''}`);
  }
  out(next.length ? `runnable: ${next.join(', ')}` : 'runnable: none');
  if (stale.length) out(`changed after approval (run \`harness approve\` again): ${stale.join(', ')}`);
  const byPriority = [...SEVERITIES, null].map((s) => `${s ?? 'none'} ${open.filter((i) => (SEVERITIES.includes(i.priority) ? i.priority : null) === s).length}`);
  out(`backlog: ${open.length} open (${byPriority.join(' · ')})`);
  for (const i of high.slice(0, HIGH_SHOWN)) out(`  ${String(i.id).padEnd(5)} ${String(i.summary ?? '').replace(/\s+/g, ' ').slice(0, SUMMARY_CHARS)}`);
  if (high.length > HIGH_SHOWN) out(`  … ${high.length - HIGH_SHOWN} more high item(s) in .harness/backlog.json`);
  return 0;
}

// `status --todo-v1`: the v1-origin todo features, grouped by v1.state, ungrouped ones last.
function listV1Todo(v1Todo, out) {
  if (!v1Todo.length) {
    out('v1 todo: none');
    return 0;
  }
  out(`v1 todo: ${v1Todo.length}`);
  for (const state of [...V1_STATES, null]) {
    const group = v1Todo.filter((f) => v1State(f) === state);
    if (!group.length) continue;
    out(`${state ?? 'no state'} (${group.length})`);
    for (const f of group) {
      const v1 = v1Text(f, V1_LIST_CHARS);
      out(`  ${f.id.padEnd(5)} ${f.title}${v1 ? ` — v1: ${v1}` : ''}`);
    }
  }
  return 0;
}
