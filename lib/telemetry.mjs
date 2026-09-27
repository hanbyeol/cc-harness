// Field data export (SPEC §2 현장 데이터 내보내기): opt-in (config telemetry.share), the events
// recorded since the last export, reduced to a fixed allowlist, written as one bundle
// <hub>/<project>/<ISO time>.jsonl. Nothing leaves the machine: the hub is a local directory.
// The allowlist is deliberately closed: a field or value not listed here is dropped, so a new
// event field is never exported until it is added here and to the SPEC table.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { STAGES, eventsDir, projectId, readEvents } from './events.mjs';
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

// data keys whose string values are exported, and the values each one accepts. Every other
// string in `data` is dropped; numbers and booleans are kept under any key named like a code
// identifier (SAFE_KEY).
export const ENUM_FIELDS = Object.freeze({
  // lint-contract rule names (plan/lint errors[].rule, warnings[].rule)
  rule: Object.freeze(['shape', 'contract_id', 'security_tier', 'id', 'check', 'criterion_text', 'universal', 'size', 'critical_sc', 'rollout', 'resolves', 'approval']),
  // why a finding went to the backlog instead of blocking (eval/finding, security/finding)
  reason: Object.freeze(['missing_criterion_id', 'criterion_not_in_contract', 'missing_repro', 'repro_denied', 'adversarial_scenario',
    'repro_timeout', 'repro_not_runnable', 'repro_not_reproduced', 'out_of_scope']),
  outcome: Object.freeze(['blocking', 'backlogged']),
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

/** The hub directory: --hub, else $CC_HARNESS_HUB, else <home>/.cc-harness/hub. */
export function hubDir({ hub, root = process.cwd(), env = process.env } = {}) {
  if (hub) return path.resolve(root, hub);
  if (env[HUB_ENV]) return path.resolve(env[HUB_ENV]);
  return path.join(os.homedir(), '.cc-harness', 'hub');
}

export const exportedFile = (root) => path.join(eventsDir(root), EXPORTED_FILE);

/** The time of the last export (ISO string) or null. An unreadable or invalid file counts as none. */
export function lastExport(root) {
  try {
    const v = fs.readFileSync(exportedFile(root), 'utf8').trim();
    return Number.isNaN(Date.parse(v)) ? null : new Date(Date.parse(v)).toISOString();
  } catch {
    return null;
  }
}

// ISO 8601 basic format (no ':'), so the name is valid on Windows: 20260928T123456.789Z.
export const bundleName = (now) => `${now.toISOString().replace(/[-:]/g, '')}.jsonl`;

export const isShareOn = (config) => config?.telemetry?.share === true;
export const isAutoExportOn = (config) => isShareOn(config) && config?.telemetry?.auto_export === true;

/**
 * Collects the lines to export: events with since ≤ ts < now, oldest first. An event at the
 * export time itself goes to the next export, which starts at that time: none is sent twice.
 * @returns {{lines:object[], since:string|null, file:string, warnings:string[]}}
 */
export function planExport(root, { hub, env, now = new Date() } = {}) {
  const since = lastExport(root);
  const from = since ? Date.parse(since) : -Infinity;
  const to = now.getTime();
  const project = projectId(root);
  const profiles = listProfiles();
  const { events, warnings } = readEvents(root);
  const lines = events
    .map((e) => [e, typeof e.ts === 'string' ? Date.parse(e.ts) : NaN])
    .filter(([, t]) => !Number.isNaN(t) && t >= from && t < to)
    .map(([e, t], i) => [e, t, i])
    .sort((a, b) => a[1] - b[1] || a[2] - b[2])
    .map(([e]) => exportLine(e, { project, profiles }))
    .filter(Boolean);
  const file = path.join(hubDir({ hub, root, env }), project, bundleName(now));
  return { lines, since, file, warnings };
}

/**
 * Writes the bundle and then the export time. Throws {path, cause} when the hub or the
 * .exported file cannot be written; .exported is only written after the bundle, and a bundle
 * whose export time could not be written is removed.
 * @returns {{count:number, file:string|null}}
 */
export function writeExport(root, plan, { now = new Date() } = {}) {
  if (!plan.lines.length) return { count: 0, file: null };
  const text = plan.lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  try {
    fs.mkdirSync(path.dirname(plan.file), { recursive: true });
    fs.writeFileSync(plan.file, text, { flag: 'wx' });
  } catch (cause) {
    throw Object.assign(new Error(`cannot write ${plan.file}: ${cause.code || cause.message}`), { path: plan.file, cause });
  }
  const marker = exportedFile(root);
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${now.toISOString()}\n`);
  } catch (cause) {
    // Without the export time the next export would repeat these events: take the bundle back.
    try { fs.rmSync(plan.file, { force: true }); } catch { /* reported below */ }
    throw Object.assign(new Error(`cannot write ${marker}: ${cause.code || cause.message}`), { path: marker, cause });
  }
  return { count: plan.lines.length, file: plan.file };
}
