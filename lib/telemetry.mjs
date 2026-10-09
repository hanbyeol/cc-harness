// Field data export (SPEC §2 현장 데이터 내보내기): on by default (config telemetry.share unset),
// off with telemetry.share false or CC_HARNESS_TELEMETRY=0|off. The events recorded since the
// last export, reduced to a fixed allowlist, written as one bundle <hub>/<project>/<ISO time>.jsonl. Nothing leaves the machine: the hub is a local directory.
// The allowlist is deliberately closed: a field or value not listed here is dropped, so a new
// event field is never exported until it is added here and to the SPEC table.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { STAGES, EVENTS_DIR, EVENT_SUFFIX, eventsDir, projectId } from './events.mjs';
import { listProfiles } from './config.mjs';
import { DIMENSIONS } from './eval.mjs';
import { ROLES } from './roles.mjs';

export const EXPORTED_FILE = '.exported';
export const HUB_ENV = 'CC_HARNESS_HUB';

// Top-level fields of an exported line. `feature` is not exported: a feature id says nothing
// across projects and lines up with titles in the project's own files.
export const LINE_FIELDS = Object.freeze(['ts', 'stage', 'type', 'harness_version', 'profile', 'project', 'round']);

const sha16 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
const oneOf = (list) => (v) => (list.includes(v) ? v : undefined);
const FEATURE_STATUSES = Object.freeze(['todo', 'approved', 'in_progress', 'passed', 'blocked', 'skipped']);

// data keys whose string values are exported, and the values each one accepts. Every other
// string in `data` is dropped; numbers and booleans are kept under any key named like a code
// identifier (SAFE_KEY).
export const ENUM_FIELDS = Object.freeze({
  // lint-contract rule names (plan/lint errors[].rule, warnings[].rule)
  rule: Object.freeze(['shape', 'contract_id', 'security_tier', 'id', 'check', 'criterion_text', 'universal', 'size', 'critical_sc', 'rollout', 'resolves', 'approval', 'overlaid_helper']),
  // why a finding went to the backlog instead of blocking (eval/finding, security/finding)
  // and why a feature's status changed (status events: run, eval, approve)
  reason: Object.freeze(['missing_criterion_id', 'criterion_not_in_contract', 'missing_repro', 'repro_denied', 'adversarial_scenario',
    'repro_timeout', 'repro_not_runnable', 'repro_not_reproduced', 'out_of_scope',
    'pass', 'fail', 'approve', 'run_start', 'rounds', 'max_rounds', 'divergence', 'stall', 'needs_human', 'needs-human', 'eval_error',
    'budget', 'merge_conflict', 'post_merge_verify', 'worktree', 'adapter_unavailable', 'verify_error', 'run_stopped',
    'dependency_blocked', 'critical_blocked']),
  outcome: Object.freeze(['blocking', 'backlogged']),
  // feature statuses of a status event
  from: FEATURE_STATUSES,
  to: FEATURE_STATUSES,
  model: 'a model name: letters, digits and . _ : @ + - (at most 100 characters)',
  role: ROLES,
  dimension: DIMENSIONS,
  // harness note --kind
  kind: Object.freeze(['manual-fix', 'manual-merge', 'environment', 'other']),
  // test names are exported only as the first 16 hex characters of their sha256
  test: 'sha256 of the test name, first 16 hex characters',
  tests: 'sha256 of each test name, first 16 hex characters',
});

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,99}$/;
const ENUM_VALUE = {
  rule: oneOf(ENUM_FIELDS.rule),
  reason: oneOf(ENUM_FIELDS.reason),
  outcome: oneOf(ENUM_FIELDS.outcome),
  from: oneOf(ENUM_FIELDS.from),
  to: oneOf(ENUM_FIELDS.to),
  model: (v) => (MODEL.test(v) ? v : undefined),
  role: oneOf(ENUM_FIELDS.role),
  dimension: oneOf(ENUM_FIELDS.dimension),
  kind: oneOf(ENUM_FIELDS.kind),
  test: (v) => sha16(v),
  tests: (v) => sha16(v),
};

// A data key that is kept: lower-case identifier as the core writes it. Keys made from user
// content (criterion ids, env var names, paths) do not match and are dropped with their value.
const SAFE_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const TYPE = /^[a-z][a-z0-9_-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?$/;
const PROJECT = /^[0-9a-f]{16}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// `value` reduced to the allowlist, or undefined when nothing of it may be exported.
function sanitizeValue(value, key) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return Object.hasOwn(ENUM_VALUE, key) ? ENUM_VALUE[key](value) : undefined;
  if (Array.isArray(value)) {
    const out = value.map((v) => sanitizeValue(v, key)).filter((v) => v !== undefined);
    return out.length || !value.length ? out : undefined;
  }
  if (isObj(value)) return sanitizeData(value);
  return undefined;
}

function sanitizeData(data) {
  const out = {};
  const keys = Object.keys(data);
  for (const k of keys) {
    if (!SAFE_KEY.test(k)) continue;
    const v = sanitizeValue(data[k], k);
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length || !keys.length ? out : undefined;
}

/**
 * One event reduced to the exported line: only LINE_FIELDS and the allowed `data`, with the
 * project set to `project` (the path hash of the exporting repository). null when the event
 * has no valid time or stage.
 */
export function exportLine(event, { project, profiles = listProfiles() } = {}) {
  if (!isObj(event)) return null;
  const t = typeof event.ts === 'string' ? Date.parse(event.ts) : NaN;
  if (Number.isNaN(t) || !STAGES.includes(event.stage)) return null;
  const line = {
    ts: new Date(t).toISOString(),
    stage: event.stage,
    type: typeof event.type === 'string' && TYPE.test(event.type) ? event.type : null,
    harness_version: typeof event.harness_version === 'string' && VERSION.test(event.harness_version) ? event.harness_version : null,
    profile: profiles.includes(event.profile) ? event.profile : null,
    project: PROJECT.test(project) ? project : null,
  };
  if (Number.isInteger(event.round)) line.round = event.round;
  line.data = (isObj(event.data) ? sanitizeData(event.data) : undefined) ?? {};
  return line;
}

// Reading the hub back (harness learn): the same allowlist, except that test names are already
// hashes there. Every dropped key is reported by its path (`title`, `data.nested.summary`).
const HASH16 = /^[0-9a-f]{16}$/;
const HUB_VALUE = { ...ENUM_VALUE, test: (v) => (HASH16.test(v) ? v : undefined), tests: (v) => (HASH16.test(v) ? v : undefined) };

function hubValue(value, key, at, ignored) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return Object.hasOwn(HUB_VALUE, key) ? HUB_VALUE[key](value) : undefined;
  if (Array.isArray(value)) {
    const out = [];
    for (const v of value) {
      const x = hubValue(v, key, at, ignored);
      if (x !== undefined) out.push(x);
    }
    return out.length || !value.length ? out : undefined;
  }
  if (isObj(value)) return hubData(value, at, ignored);
  return value === null ? null : undefined;
}

function hubData(data, at, ignored) {
  const out = {};
  for (const k of Object.keys(data)) {
    const p = `${at}.${k}`;
    const v = SAFE_KEY.test(k) ? hubValue(data[k], k, p, ignored) : undefined;
    if (v === undefined) ignored.add(p);
    else out[k] = v;
  }
  return out;
}

/**
 * One hub line reduced to the export allowlist, or null when it is not a line at all (not an
 * object, no valid ts or stage). Keys outside the allowlist are dropped and added to `ignored`.
 */
export function readHubLine(raw, ignored = new Set()) {
  if (!isObj(raw)) return null;
  const t = typeof raw.ts === 'string' ? Date.parse(raw.ts) : NaN;
  if (Number.isNaN(t) || !STAGES.includes(raw.stage)) return null;
  for (const k of Object.keys(raw)) if (!LINE_FIELDS.includes(k) && k !== 'data') ignored.add(k);
  const line = {
    ts: new Date(t).toISOString(),
    stage: raw.stage,
    type: typeof raw.type === 'string' && TYPE.test(raw.type) ? raw.type : null,
    harness_version: typeof raw.harness_version === 'string' && VERSION.test(raw.harness_version) ? raw.harness_version : null,
    project: typeof raw.project === 'string' && PROJECT.test(raw.project) ? raw.project : null,
  };
  if (Number.isInteger(raw.round)) line.round = raw.round;
  if (raw.data !== undefined && !isObj(raw.data)) ignored.add('data');
  line.data = isObj(raw.data) ? hubData(raw.data, 'data', ignored) : {};
  return line;
}

/** The hub directory: --hub, else $CC_HARNESS_HUB, else <home>/.cc-harness/hub. */
export function hubDir({ hub, root = process.cwd(), env = process.env } = {}) {
  if (hub) return path.resolve(root, hub);
  if (env[HUB_ENV]) return path.resolve(env[HUB_ENV]);
  return path.join(os.homedir(), '.cc-harness', 'hub');
}

export const exportedFile = (root) => path.join(eventsDir(root), EXPORTED_FILE);

/**
 * The last export as {at, files}: `at` its time (ISO string or null) and `files` the bytes of
 * each event file already exported, by file name (F60). The earlier form of .exported, one ISO
 * time, reads as {at, files: null}. null when there is none or it is unreadable or invalid.
 */
export function readExported(root) {
  let text;
  try {
    text = fs.readFileSync(exportedFile(root), 'utf8').trim();
  } catch {
    return null;
  }
  let v;
  try { v = JSON.parse(text); } catch { v = undefined; }
  if (isObj(v) && isObj(v.files)) {
    const files = {};
    for (const [name, n] of Object.entries(v.files)) if (Number.isSafeInteger(n) && n >= 0) files[name] = n;
    const t = typeof v.at === 'string' ? Date.parse(v.at) : NaN;
    return { at: Number.isNaN(t) ? null : new Date(t).toISOString(), files };
  }
  const t = typeof v === 'object' ? NaN : Date.parse(text);
  return Number.isNaN(t) ? null : { at: new Date(t).toISOString(), files: null };
}

/**
 * The events appended to .harness/events/*.jsonl after the byte positions in `from` (file name →
 * bytes), and the new positions. A last line without its newline is still being written and is
 * left for the next export. A file shorter than its position, or whose position is not at the
 * start of a line, was truncated or replaced: it is read from the start, with a warning (F60 ES-1).
 * @returns {{events:object[], files:Object<string,number>, warnings:string[]}}
 */
export function readNewEvents(root, from = {}) {
  const dir = eventsDir(root);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(EVENT_SUFFIX)).sort();
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
  }
  const events = [];
  const warnings = [];
  const files = {};
  for (const name of names) {
    const buf = fs.readFileSync(path.join(dir, name));
    let start = Object.hasOwn(from, name) ? from[name] : 0;
    if (start > buf.length || (start > 0 && buf[start - 1] !== 0x0a)) {
      warnings.push(`${EVENTS_DIR}/${name} is shorter than or does not match its export position (${buf.length} bytes, position ${start}): truncated or replaced — exporting it from the start`);
      start = 0;
    }
    const end = Math.max(start, buf.lastIndexOf(0x0a) + 1);
    files[name] = end;
    let lineNo = 0;
    for (let i = buf.indexOf(0x0a); i !== -1 && i < start; i = buf.indexOf(0x0a, i + 1)) lineNo += 1;
    for (const line of buf.subarray(start, end).toString('utf8').split('\n')) {
      lineNo += 1;
      if (!line.trim()) continue;
      let v;
      try { v = JSON.parse(line); } catch { v = undefined; }
      if (!isObj(v)) {
        warnings.push(`${EVENTS_DIR}/${name}:${lineNo}: not a JSON object — line skipped`);
        continue;
      }
      events.push(v);
    }
  }
  return { events, files, warnings };
}

const samePositions = (a, b) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
};

// ISO 8601 basic format (no ':'), so the name is valid on Windows: 20260928T123456.789Z.
export const bundleName = (now) => `${now.toISOString().replace(/[-:]/g, '')}.jsonl`;

export const TELEMETRY_ENV = 'CC_HARNESS_TELEMETRY';
const ENV_OFF = Object.freeze(['0', 'off']);

/**
 * Whether export and the automatic export are on, and what decided it (SPEC §2): `env` when
 * CC_HARNESS_TELEMETRY is 0 or off, `default` when config has no telemetry.share, else `config`.
 * telemetry.share and telemetry.auto_export default to true; any value other than a boolean
 * (and a telemetry that is not an object) turns them off.
 * @returns {{share:boolean, autoExport:boolean, source:'default'|'config'|'env'}}
 */
export function telemetryState(config, env = process.env) {
  if (ENV_OFF.includes(env?.[TELEMETRY_ENV])) return { share: false, autoExport: false, source: 'env' };
  const t = config?.telemetry;
  if (t === undefined) return { share: true, autoExport: true, source: 'default' };
  if (!isObj(t)) return { share: false, autoExport: false, source: 'config' };
  const share = t.share === undefined || t.share === true;
  const autoExport = share && (t.auto_export === undefined || t.auto_export === true);
  return { share, autoExport, source: t.share === undefined ? 'default' : 'config' };
}

/** The one-line notice of the first export while telemetry is on by default. */
export const defaultOnNotice = (hub) => `harness: telemetry is on by default — anonymized events go to ${hub} (local only); `
  + `set "telemetry": {"share": false} in .harness/config.json or ${TELEMETRY_ENV}=0 to turn it off`;

/**
 * Collects the lines to export: the lines appended to each event file after the position the
 * last export recorded, oldest `ts` first (F60). Positions, not times, decide, so an event with
 * the same millisecond as one already exported is still exported, and none is sent twice.
 * After an .exported of the earlier form (a time only) the events with ts ≥ that time are
 * exported once, and the positions are recorded from then on (F60 AC-3).
 * `update` is true when .exported must be (re)written even if there is no line to export.
 * @returns {{lines:object[], since:string|null, files:Object<string,number>, update:boolean, file:string, warnings:string[]}}
 */
export function planExport(root, { hub, env, now = new Date() } = {}) {
  const prev = readExported(root);
  const byTime = prev && !prev.files ? Date.parse(prev.at) : null;
  const project = projectId(root);
  const profiles = listProfiles();
  const { events, files, warnings } = readNewEvents(root, prev?.files ?? {});
  const lines = events
    .map((e, i) => [e, typeof e.ts === 'string' ? Date.parse(e.ts) : NaN, i])
    .filter(([, t]) => !Number.isNaN(t) && (byTime === null || t >= byTime))
    .sort((a, b) => a[1] - b[1] || a[2] - b[2])
    .map(([e]) => exportLine(e, { project, profiles }))
    .filter(Boolean);
  const update = lines.length > 0 || (prev !== null && prev.files === null) || !samePositions(files, prev?.files ?? {});
  const file = path.join(hubDir({ hub, root, env }), project, bundleName(now));
  return { lines, since: prev?.at ?? null, files, update, file, warnings };
}

/**
 * Writes the bundle (when there are lines) and then .exported: the export time and the position
 * reached in each event file. Throws {path, cause} when the hub or the .exported file cannot be
 * written; .exported is only written after the bundle, and a bundle whose positions could not be
 * written is removed.
 * @returns {{count:number, file:string|null}}
 */
export function writeExport(root, plan, { now = new Date() } = {}) {
  if (!plan.lines.length && !plan.update) return { count: 0, file: null };
  if (plan.lines.length) {
    const text = plan.lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    try {
      // Owner only (SPEC §2): the hub and project directories it creates, and the bundle.
      fs.mkdirSync(path.dirname(plan.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(plan.file, text, { flag: 'wx', mode: 0o600 });
    } catch (cause) {
      throw Object.assign(new Error(`cannot write ${plan.file}: ${cause.code || cause.message}`), { path: plan.file, cause });
    }
  }
  const marker = exportedFile(root);
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${JSON.stringify({ at: now.toISOString(), files: plan.files ?? {} })}\n`);
  } catch (cause) {
    // Without the positions the next export would repeat these events: take the bundle back.
    if (plan.lines.length) try { fs.rmSync(plan.file, { force: true }); } catch { /* reported below */ }
    throw Object.assign(new Error(`cannot write ${marker}: ${cause.code || cause.message}`), { path: marker, cause });
  }
  return plan.lines.length ? { count: plan.lines.length, file: plan.file } : { count: 0, file: null };
}
