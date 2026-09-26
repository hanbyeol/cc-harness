// Failure records shared by run and eval (SPEC §7.3, §8): what failed in a verify, cut to a
// prompt- and report-sized message with secrets redacted, and the names of flaky tests.
import { BASE_ENV_ALLOWLIST } from './exec.mjs';

export const FAILURE_MESSAGE_CHARS = 300;
export const MAX_FLAKY_TESTS = 20;

/**
 * Replaces the values of environment variables outside the allowlist (SR-2) in `text`.
 * Short values (< 8 characters) stay: they are not secrets and would garble the text.
 */
export function redactor(env, allowlist = []) {
  const allow = new Set([...BASE_ENV_ALLOWLIST, ...allowlist]);
  const values = [...new Set(Object.entries(env || {})
    .filter(([k, v]) => !allow.has(k) && typeof v === 'string' && v.length >= 8).map(([, v]) => v))]
    .sort((a, b) => b.length - a.length);
  return (text) => values.reduce((acc, v) => acc.split(v).join('[redacted]'), String(text ?? ''));
}

/**
 * A copy of `value` (plain JSON data) with `redact` applied to every string. Object keys stay,
 * and so do the values under a key in `keep` (identifiers the record is read back by).
 */
export function redactDeep(value, redact, keep = new Set()) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((x) => redactDeep(x, redact, keep));
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.toJSON === 'function') return redactDeep(value.toJSON(), redact, keep);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, keep.has(k) ? v : redactDeep(v, redact, keep)]));
}

/** Failed items of a verify result: [{item, message}] (SPEC §8 report, §7.3 verdict). */
export function verifyFailures(v, redact = (x) => String(x ?? '')) {
  if (!v || v.pass) return [];
  const out = [];
  const add = (item, message) => out.push({ item: String(item), message: redact(message).slice(0, FAILURE_MESSAGE_CHARS) });
  for (const c of v.commands || []) if (!c.pass) add(c.cmd, [c.message, c.output?.trim()].filter(Boolean).join(': '));
  const i = v.integrity;
  if (i?.markers?.length) add('skip markers', i.markers.map((m) => `${m.file}: ${m.marker}`).join(', '));
  if (i?.harnessPaths?.length) add('.harness changes', i.harnessPaths.join(', '));
  const tc = i?.testCount;
  if (tc && tc.status !== 'ok' && tc.status !== 'unset') add('test_count', tc.message || `test count ${tc.status} (base ${tc.base}, head ${tc.head})`);
  for (const c of v.criteria || []) if (!c.pass) add(c.id, c.message || 'check failed');
  if (v.error) add('verify', v.error);
  return out;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * Names of the failed tests in a test runner's output (SPEC §6.1 flaky): lines that start
 * with '✖ ' (node spec reporter) or 'not ok ' (TAP), indentation ignored, duration and TAP
 * directive stripped, distinct, at most MAX_FLAKY_TESTS.
 */
export function failedTestNames(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(ANSI, '').trimStart();
    let name = null;
    if (line.startsWith('✖ ')) name = line.slice(2).replace(/\s+\(\d+(?:\.\d+)?m?s\)\s*$/, '');
    else if (line.startsWith('not ok ')) name = line.slice('not ok '.length).replace(/^\d+\s*(?:-\s*)?/, '').replace(/\s+#\s.*$/, '');
    name = name?.trim();
    // The spec reporter repeats failures under a '✖ failing tests:' heading.
    if (!name || name === 'failing tests:' || out.includes(name)) continue;
    out.push(name);
    if (out.length >= MAX_FLAKY_TESTS) break;
  }
  return out;
}
