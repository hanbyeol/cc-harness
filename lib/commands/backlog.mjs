// `harness backlog close B<n> [B<m> ...] --resolved|--obsolete "<reason>"` — a human closes open
// backlog items that are already solved or need no work (SPEC §2 피드백 단계, §7.7). A closed item
// stays in backlog.json with `closed: {as, reason, at}` and is no longer open.
import { HarnessError } from '../errors.mjs';
import { loadConfig } from '../config.mjs';
import { paths } from '../state.mjs';
import { readBacklog, writeBacklog, assignIds } from '../backlog.mjs';
import { redactor } from '../failures.mjs';
import { recordEvent } from '../events.mjs';
import { isObj } from '../util.mjs';

const USAGE = 'usage: harness backlog close B<n> [B<m> ...] --resolved|--obsolete [--] "<reason>"\n'
  + '  (put -- before a reason that starts with -: harness backlog close B1 --resolved -- "-5% fixed")';
export const CLOSE_AS = Object.freeze(['resolved', 'obsolete']);

const usage = (message) => new HarnessError(`${message}\n${USAGE}`, { code: 'usage' });
const present = (v) => v !== undefined && v !== null && v !== '';

// Ids come before the --resolved|--obsolete flag, the reason (one argument) after it. Every
// argument after `--` is a reason, so a reason may start with '-'.
function parseClose(args) {
  const ids = [];
  const reasons = [];
  let as = null;
  const end = args.indexOf('--');
  if (end !== -1) reasons.push(...args.slice(end + 1));
  for (const a of end === -1 ? args : args.slice(0, end)) {
    const flag = a.startsWith('--') ? a.slice(2) : null;
    if (flag !== null && CLOSE_AS.includes(flag)) {
      if (as) throw usage(`give one of --resolved|--obsolete, not --${as} and ${a}`);
      as = flag;
    } else if (a.startsWith('-') && a.length > 1) throw usage(`unexpected option '${a}'`);
    else if (as) reasons.push(a);
    else ids.push(a);
  }
  if (!ids.length) throw usage('backlog close needs at least one backlog id B<n>');
  const bad = ids.filter((id) => !/^B\d+$/.test(id));
  if (bad.length) throw usage(`not a backlog id: ${bad.join(', ')} (expected B<n>)`);
  if (!as) throw usage('backlog close needs one of --resolved|--obsolete');
  if (reasons.length > 1) throw usage('give the reason as one quoted argument');
  const reason = (reasons[0] ?? '').trim();
  if (!reason) throw usage('backlog close needs a non-empty reason');
  return { ids: [...new Set(ids)], as, reason };
}

// Every id is checked before anything is written: one bad id closes nothing.
function closable(items, ids) {
  return ids.map((id) => {
    const item = items.find((i) => isObj(i) && i.id === id);
    if (!item) throw usage(`unknown backlog id ${id} — not in .harness/backlog.json`);
    if (item.kind === 'decision') throw usage(`${id} is a decision record (kind decision), not an open item`);
    if (present(item.resolved_by)) throw usage(`${id} is already resolved by ${item.resolved_by}`);
    if (present(item.closed)) throw usage(`${id} is already closed${typeof item.closed?.as === 'string' ? ` as ${item.closed.as}` : ''}`);
    return item;
  });
}

export default async function backlog({ root, args, out, err }) {
  const [sub, ...rest] = args;
  if (sub !== 'close') throw usage(sub === undefined ? 'backlog needs a subcommand' : `unknown backlog subcommand '${sub}'`);
  const { ids, as, reason } = parseClose(rest);
  const file = paths(root).backlog;
  const data = readBacklog(file); // a corrupt backlog stops before anything is written (E6)
  assignIds(data); // the same ids harness status shows for items written without one
  const items = closable(data.items, ids);
  const config = loadConfig(root);
  const redact = redactor(process.env, config.env_allowlist);
  const at = new Date().toISOString();
  for (const item of items) item.closed = { as, reason: redact(reason), at };
  writeBacklog(file, data);
  const ok = recordEvent(root, { stage: 'feedback', type: 'backlog_close', data: { ids, as, reason } }, { redact, warn: err });
  for (const id of ids) out(`${id}: closed as ${as}`);
  return ok ? 0 : 1;
}
