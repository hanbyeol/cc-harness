// backlog.json: findings that did not block, and blocked-feature re-scope proposals (SPEC §7.7).
// Every item the core writes carries a stable id B<n>; open items (no resolved_by) are shown
// to the evaluator so a repeated finding is counted on the existing item instead of added again.
import { HarnessError } from './errors.mjs';
import { readJson, writeJsonAtomic } from './state.mjs';

export const SEVERITIES = Object.freeze(['high', 'medium', 'low']);
export const PROMPT_LIMIT = 40; // open items listed in an evaluation prompt

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const idNumber = (id) => {
  const m = typeof id === 'string' ? /^B(\d+)$/.exec(id) : null;
  return m ? Number(m[1]) : 0;
};

/** The severity as a priority, or null when it is not one of high|medium|low. */
export const severityOf = (v) => (SEVERITIES.includes(v) ? v : null);

export const isOpen = (item) => isObj(item) && (item.resolved_by === undefined || item.resolved_by === null || item.resolved_by === '');

/**
 * Reads backlog.json (missing = empty). A file that is not { items: [...] }, or whose item ids
 * repeat, is state_corrupt: the caller stops before spending or writing anything (E6).
 */
export function readBacklog(file) {
  const data = readJson(file, { optional: true });
  if (data === undefined) return { items: [] };
  if (!isObj(data) || !Array.isArray(data.items)) {
    throw new HarnessError(`${file}: expected { "items": [...] }. Fix or restore the file; harness will not modify it.`, { code: 'state_corrupt' });
  }
  const seen = new Set();
  const dups = new Set();
  for (const item of data.items) {
    if (!isObj(item) || item.id === undefined) continue;
    const key = JSON.stringify(item.id);
    if (seen.has(key)) dups.add(typeof item.id === 'string' ? item.id : key);
    seen.add(key);
  }
  if (dups.size) {
    throw new HarnessError(`${file}: duplicate item id ${[...dups].join(', ')}. Fix or restore the file; harness will not modify it.`, { code: 'state_corrupt' });
  }
  return data;
}

/** Gives every object item without an id the next B<n> after the largest, in file order. */
export function assignIds(data) {
  let max = 0;
  for (const item of data.items) if (isObj(item)) max = Math.max(max, idNumber(item.id));
  for (const item of data.items) {
    if (isObj(item) && item.id === undefined) { max += 1; item.id = `B${max}`; }
  }
  return data;
}

export function writeBacklog(file, data) {
  writeJsonAtomic(file, assignIds(data));
}

/**
 * Open items ordered high → medium → low → none (file order within a priority). Items without
 * an id get it in memory first — the same ids the next write assigns, since both go in file order.
 */
export function openItems(data) {
  assignIds(data);
  const rank = (i) => { const r = SEVERITIES.indexOf(i.priority); return r === -1 ? SEVERITIES.length : r; };
  return data.items
    .map((item, pos) => ({ item, pos }))
    .filter(({ item }) => isOpen(item))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.pos - b.pos)
    .map(({ item }) => item);
}

/**
 * Records one round's non-blocking entries. An entry whose backlog_id names an open item
 * bumps that item's `seen` and adds `<feature>-r<round>` to its `sources`; anything else
 * (no backlog_id, an unknown id, a resolved item) becomes a new item.
 */
export function recordEntries(file, entries, { feature, round, at }) {
  const data = readBacklog(file);
  assignIds(data);
  const byId = new Map(data.items.filter(isOpen).map((i) => [i.id, i]));
  const tag = `${feature}-r${round}`;
  for (const e of entries) {
    const { backlog_id: ref, ...rest } = e;
    const hit = typeof ref === 'string' ? byId.get(ref) : undefined;
    if (hit) {
      hit.seen = (Number.isInteger(hit.seen) && hit.seen > 0 ? hit.seen : 1) + 1;
      const sources = Array.isArray(hit.sources) ? hit.sources : [];
      if (!sources.includes(tag)) sources.push(tag);
      hit.sources = sources;
      continue;
    }
    data.items.push({ feature, round, at, ...rest });
  }
  writeBacklog(file, data);
}

/** Appends one item (a re-scope proposal) with an id. */
export function appendItem(file, item) {
  const data = readBacklog(file);
  data.items.push(item);
  writeBacklog(file, data);
}

/**
 * Marks the open items listed in the contract's `resolves` as resolved by `featureId`.
 * Called only when the feature is recorded passed. Items already resolved keep their resolver.
 */
export function resolveItems(file, contract, featureId) {
  const ids = Array.isArray(contract?.resolves) ? contract.resolves.filter((x) => typeof x === 'string') : [];
  if (!ids.length) return;
  const data = readBacklog(file);
  let changed = false;
  for (const item of data.items) {
    if (isOpen(item) && ids.includes(item.id)) { item.resolved_by = featureId; changed = true; }
  }
  if (changed) writeBacklog(file, data);
}
