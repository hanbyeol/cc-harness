// Event log (SPEC §2 이벤트 기록): one JSON line per event in .harness/events/YYYY-MM.jsonl
// (UTC month of `ts`). Every line carries the harness version, the profile and a hash of the
// repository top-level path, so events from several projects and versions can be compared.
// Recording never changes the result of the command that records (F54 ES-1): a failed write
// is one warning line on stderr.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths, readJson } from './state.mjs';
import { redactor, redactDeep } from './failures.mjs';
import { sha16 } from './util.mjs';

export const STAGES = Object.freeze(['plan', 'build', 'verify', 'eval', 'security', 'feedback']);
export const EVENTS_DIR = 'events';
export const EVENT_SUFFIX = '.jsonl';

export const HARNESS_VERSION = JSON.parse(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;

export const eventsDir = (root) => path.join(paths(root).dir, EVENTS_DIR);

// The repository top level as git reports it; the resolved root outside a git repository.
const topLevels = new Map();
export function repoTopLevel(root) {
  const key = path.resolve(root);
  if (!topLevels.has(key)) {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: key, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    const top = r.status === 0 ? r.stdout.trim() : '';
    topLevels.set(key, top || key);
  }
  return topLevels.get(key);
}

/** sha256 of the repository top-level path, first 16 hex characters. */
export const projectId = (root) => sha16(repoTopLevel(root));

// The raw config file, without validation: recording must not fail on a config problem.
export function rawConfig(root) {
  try { return readJson(paths(root).config, { optional: true }) ?? {}; } catch { return {}; }
}

/** The redactor of a project's events: process.env except config.env_allowlist (SR-8). */
export const eventRedactor = (cfg) => redactor(process.env, Array.isArray(cfg?.env_allowlist) ? cfg.env_allowlist : []);

/** The event line for `event`, `data` passed through `redact` (the run report's rule, SR-8). */
export function eventLine(root, { stage, type, feature, round, data }, { config, redact, now = new Date() } = {}) {
  if (!STAGES.includes(stage)) throw new TypeError(`unknown event stage '${stage}'`);
  const cfg = config ?? rawConfig(root);
  const r = redact ?? eventRedactor(cfg);
  const line = { ts: now.toISOString(), stage, type: String(type) };
  if (typeof feature === 'string' && feature) line.feature = feature;
  if (Number.isInteger(round)) line.round = round;
  line.harness_version = HARNESS_VERSION;
  line.profile = typeof cfg.profile === 'string' ? cfg.profile : null;
  line.project = projectId(root);
  line.data = redactDeep(data ?? {}, r, undefined, { keys: true });
  return line;
}

// One warning per events directory and process: a failing disk is reported, not repeated.
const warned = new Set();

/**
 * Appends one event to .harness/events/YYYY-MM.jsonl. Never throws on a write failure:
 * it prints one warning line through `warn` (stderr by default) and returns false.
 */
export function recordEvent(root, event, { config, redact, now, warn } = {}) {
  const dir = eventsDir(root);
  const line = eventLine(root, event, { config, redact, now });
  const file = path.join(dir, `${line.ts.slice(0, 7)}${EVENT_SUFFIX}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
    return true;
  } catch (e) {
    if (!warned.has(dir)) {
      warned.add(dir);
      const say = warn ?? ((m) => process.stderr.write(`${m}\n`));
      say(`harness: warning: could not record event ${line.stage}/${line.type} in ${file} (${e.code || e.message})`);
    }
    return false;
  }
}

/**
 * Every event line in .harness/events/*.jsonl, files in name order. A line that is not a JSON
 * object is skipped with a warning naming the file and line number (F54 ES-2).
 * @returns {{files:string[], events:object[], warnings:string[]}}
 */
export function readEvents(root) {
  const dir = eventsDir(root);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((n) => n.endsWith(EVENT_SUFFIX)).sort();
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
  }
  const events = [];
  const warnings = [];
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    text.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      let v;
      try { v = JSON.parse(line); } catch { v = undefined; }
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        warnings.push(`${EVENTS_DIR}/${name}:${i + 1}: not a JSON object — line skipped`);
        return;
      }
      events.push(v);
    });
  }
  return { files, events, warnings };
}

const timeOf = (e) => {
  const t = Date.parse(e.ts);
  return Number.isNaN(t) ? Infinity : t;
};

/** Events matching the filters, oldest first (ties keep file order). `since` is YYYY-MM-DD, UTC. */
export function filterEvents(events, { stage, feature, since } = {}) {
  const from = since ? Date.parse(`${since}T00:00:00.000Z`) : null;
  return events
    .filter((e) => (!stage || e.stage === stage) && (!feature || e.feature === feature) && (from === null || timeOf(e) >= from))
    .map((e, i) => [e, i])
    .sort(([a, i], [b, j]) => timeOf(a) - timeOf(b) || i - j)
    .map(([e]) => e);
}

// ------------------------------------------------------------------ plan stage data

/** sha256 (16 hex) of each criterion sentence, by criterion id: what approve compares. */
export function criterionHashes(contract) {
  const out = {};
  for (const key of ['acceptance_criteria', 'security_criteria', 'error_scenarios']) {
    const list = Array.isArray(contract?.[key]) ? contract[key] : [];
    for (const c of list) {
      if (c && typeof c === 'object' && typeof c.id === 'string') out[c.id] = sha16(typeof c.criterion === 'string' ? c.criterion : '');
    }
  }
  return out;
}

/** Criterion ids added, removed and with a changed sentence from `prev` to `next` (hash maps). */
export function criteriaDiff(prev, next) {
  const before = prev ?? {};
  return {
    added: Object.keys(next).filter((id) => !Object.hasOwn(before, id)),
    removed: Object.keys(before).filter((id) => !Object.hasOwn(next, id)),
    changed: Object.keys(next).filter((id) => Object.hasOwn(before, id) && before[id] !== next[id]),
  };
}
