// Adapter usage (SPEC §2 실행 단계 기록): turns, tokens, session id and API time as the claude
// `--output-format json` wrapper reports them, the claude session log they point to, and the
// data of a build/eval/security `step` event. Adapters that report no usage give nulls.
// Only counts, ids, names and times are kept — never a prompt, a reply or a diff (F55 SC-1).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A session id is used as a file name: only a plain id (a UUID in practice) is kept.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const sessionIdOf = (v) => (typeof v === 'string' && SESSION_ID.test(v) ? v : null);

/** Token counts of a claude `usage` object; null when there is none. */
export function tokensOf(usage) {
  if (!isObj(usage)) return null;
  return {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cache_read: count(usage.cache_read_input_tokens),
    cache_creation: count(usage.cache_creation_input_tokens),
  };
}

/** Usage fields of a claude result wrapper, as adapter result fields. */
export function claudeUsage(wrapper) {
  return {
    turns: count(wrapper?.num_turns),
    tokens: tokensOf(wrapper?.usage),
    sessionId: sessionIdOf(wrapper?.session_id),
    durationApiMs: count(wrapper?.duration_api_ms),
  };
}

export const NO_USAGE = Object.freeze({ turns: null, tokens: null, sessionId: null, durationApiMs: null });

/**
 * The usage an adapter result reports ({turns, tokens, sessionId, durationApiMs}) or a usage
 * record ({…, session_id, duration_api_ms}), validated again; nulls for anything missing.
 */
export function usageOf(r) {
  const tokens = isObj(r?.tokens) ? {
    input: count(r.tokens.input), output: count(r.tokens.output),
    cache_read: count(r.tokens.cache_read), cache_creation: count(r.tokens.cache_creation),
  } : null;
  return {
    turns: count(r?.turns),
    tokens,
    session_id: sessionIdOf(r?.sessionId ?? r?.session_id),
    duration_api_ms: count(r?.durationApiMs ?? r?.duration_api_ms),
  };
}

const add = (a, b) => (a === null ? b : b === null ? a : a + b);

/**
 * Several calls as one: turns and tokens summed (null when no call reported them), the
 * session id of the last call that had one, API time summed.
 */
export function sumUsage(list) {
  let out = { turns: null, tokens: null, session_id: null, duration_api_ms: null };
  for (const u of list) {
    const t = u.tokens;
    out = {
      turns: add(out.turns, u.turns),
      tokens: t === null ? out.tokens : out.tokens === null ? { ...t } : Object.fromEntries(Object.keys(t).map((k) => [k, add(out.tokens[k], t[k])])),
      session_id: u.session_id ?? out.session_id,
      duration_api_ms: add(out.duration_api_ms, u.duration_api_ms),
    };
  }
  return out;
}

/** How claude names the project directory of a working directory: every non-alphanumeric character becomes '-'. */
export function encodeProjectDir(cwd) {
  let real = path.resolve(cwd);
  try { real = fs.realpathSync.native(real); } catch { /* a missing directory keeps its spelling */ }
  return real.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Where claude keeps the session's transcript: ~/.claude/projects/<encoded cwd>/<session id>.jsonl,
 * and whether it is there. Null without a (plain) session id. The file is never read.
 */
export function claudeSessionLog(sessionId, cwd, { home = os.homedir() } = {}) {
  const id = sessionIdOf(sessionId);
  if (!id || !cwd) return null;
  const file = path.join(home, '.claude', 'projects', encodeProjectDir(cwd), `${id}.jsonl`);
  let exists = false;
  try { exists = fs.statSync(file).isFile(); } catch { exists = false; }
  return { path: file, exists };
}

/** The event stage of a role's adapter call. */
export const stageOfRole = (role) => (role === 'builder' ? 'build' : role === 'security-reviewer' ? 'security' : 'eval');

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** `data` of a build/eval/security `step` event: one adapter call. */
export function stepEventData({ step, attempt, role, adapter, model, outcome, startedAt, endedAt, costUsd, usage, cwd }) {
  const u = usage ?? usageOf(null);
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  const data = { step, role: role ?? null, adapter: adapter ?? null, model: model ?? null, outcome: outcome ?? null };
  if (Number.isInteger(attempt)) data.attempt = attempt;
  return {
    ...data,
    duration_ms: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null,
    cost_usd: finite(costUsd),
    turns: u.turns,
    tokens: u.tokens,
    session_id: u.session_id,
    duration_api_ms: u.duration_api_ms,
    session_log: claudeSessionLog(u.session_id, cwd),
  };
}
