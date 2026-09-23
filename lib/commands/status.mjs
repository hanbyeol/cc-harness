import { isInitialized, loadFeatures, runnableFeatures } from '../state.mjs';
import { HarnessError } from '../errors.mjs';

const ORDER = ['passed', 'in_progress', 'approved', 'todo', 'blocked', 'skipped'];

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
  const next = runnableFeatures(features).map((f) => f.id);

  if (brief) {
    out(`harness: ${summary}${next.length ? ` — next: ${next.join(', ')}` : ''}`);
    return 0;
  }
  out(`features: ${summary}`);
  for (const f of features) out(`  ${f.id.padEnd(5)} ${f.status.padEnd(11)} ${f.title}`);
  out(next.length ? `runnable: ${next.join(', ')}` : 'runnable: none');
  return 0;
}
