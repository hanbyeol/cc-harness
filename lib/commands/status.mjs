import { isInitialized, loadFeatures, runnableFeatures, paths } from '../state.mjs';
import { readBacklog, openItems, SEVERITIES } from '../backlog.mjs';
import { executableFeatures } from '../contract.mjs';
import { HarnessError } from '../errors.mjs';

const ORDER = ['passed', 'in_progress', 'approved', 'todo', 'blocked', 'skipped'];
const HIGH_SHOWN = 5;
const SUMMARY_CHARS = 100;

export default async function status({ root, args, out }) {
  const brief = args.includes('--brief');
  if (!isInitialized(root)) {
    // --brief runs from a SessionStart hook in every project; stay silent there.
    if (brief) return 0;
    throw new HarnessError('not initialized — run `harness init`', { code: 'not_initialized' });
  }
  const { features } = loadFeatures(root);
  const counts = {};
  for (const f of features) counts[f.status] = (counts[f.status] || 0) + 1;
  const summary = ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(' · ') || 'no features';
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
  for (const f of features) out(`  ${f.id.padEnd(5)} ${f.status.padEnd(11)} ${f.title}`);
  out(next.length ? `runnable: ${next.join(', ')}` : 'runnable: none');
  if (stale.length) out(`changed after approval (run \`harness approve\` again): ${stale.join(', ')}`);
  const byPriority = [...SEVERITIES, null].map((s) => `${s ?? 'none'} ${open.filter((i) => (SEVERITIES.includes(i.priority) ? i.priority : null) === s).length}`);
  out(`backlog: ${open.length} open (${byPriority.join(' · ')})`);
  for (const i of high.slice(0, HIGH_SHOWN)) out(`  ${String(i.id).padEnd(5)} ${String(i.summary ?? '').replace(/\s+/g, ' ').slice(0, SUMMARY_CHARS)}`);
  if (high.length > HIGH_SHOWN) out(`  … ${high.length - HIGH_SHOWN} more high item(s) in .harness/backlog.json`);
  return 0;
}
