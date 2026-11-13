// Failure records shared by run and eval (SPEC §7.3, §8): what failed in a verify, cut to a
// prompt- and report-sized message with secrets redacted, and the names of flaky tests.
import { BASE_ENV_ALLOWLIST } from './exec.mjs';

export const FAILURE_MESSAGE_CHARS = 300;
export const MAX_FLAKY_TESTS = 20;

// GitHub Actions metadata (refs, paths, run ids): not secrets. The redactor skips them so a
// branch name like contracts/f135-f139 does not garble ids; commands never receive them.
export const CI_METADATA_ENV = Object.freeze([
  ...['ACTION', 'ACTION_PATH', 'ACTION_REPOSITORY', 'ACTIONS', 'ACTOR', 'ACTOR_ID', 'API_URL', 'BASE_REF', 'ENV',
    'EVENT_NAME', 'EVENT_PATH', 'GRAPHQL_URL', 'HEAD_REF', 'JOB', 'OUTPUT', 'PATH', 'REF', 'REF_NAME',
    'REF_PROTECTED', 'REF_TYPE', 'REPOSITORY', 'REPOSITORY_ID', 'REPOSITORY_OWNER', 'REPOSITORY_OWNER_ID',
    'RETENTION_DAYS', 'RUN_ATTEMPT', 'RUN_ID', 'RUN_NUMBER', 'SERVER_URL', 'SHA', 'STATE', 'STEP_SUMMARY',
    'TRIGGERING_ACTOR', 'WORKFLOW', 'WORKFLOW_REF', 'WORKFLOW_SHA', 'WORKSPACE'].map((n) => `GITHUB_${n}`),
  ...['ARCH', 'DEBUG', 'ENVIRONMENT', 'NAME', 'OS', 'TEMP', 'TOOL_CACHE', 'WORKSPACE'].map((n) => `RUNNER_${n}`),
]);

// The current-directory variables (SR-2): paths, not secrets. The redactor skips them so a worktree
// directory name like _integration is not cut into a fragment; commands never receive them.
export const CWD_ENV = Object.freeze(['PWD', 'OLDPWD', 'INIT_CWD']);

// Non-secret metadata npm puts in the environment of every script it runs (paths, the package name
// and version, node and npm locations). The redactor skips them so `npm test` output keeps the
// project path and `name@version`; commands never receive them. npm_lifecycle_script (may hold an
// inline secret) and the other npm_config_ names (_authToken, password, proxy ...) stay redacted.
export const NPM_ENV = Object.freeze([
  'NODE', '_', 'npm_command',
  ...['cache', 'global_prefix', 'globalconfig', 'init_module', 'local_prefix', 'node_gyp', 'npm_version',
    'prefix', 'user_agent', 'userconfig'].map((n) => `npm_config_${n}`),
  'npm_execpath', 'npm_lifecycle_event', 'npm_node_execpath',
  ...['json', 'name', 'version'].map((n) => `npm_package_${n}`),
]);

const MIN_SECRET = 8; // shorter values and fragments are not redacted
const REDACTED = '[redacted]';

// Length of the longest suffix of `v` (≥ MIN_SECRET characters) that `text` starts with, or 0.
function leadingFragment(text, v) {
  const head = text.slice(0, MIN_SECRET);
  if (head.length < MIN_SECRET) return 0;
  for (let i = v.indexOf(head); i !== -1 && v.length - i >= MIN_SECRET; i = v.indexOf(head, i + 1)) {
    if (text.startsWith(v.slice(i))) return v.length - i;
  }
  return 0;
}

// Length of the longest prefix of `v` (≥ MIN_SECRET characters) that `text` ends with, or 0.
function trailingFragment(text, v) {
  const end = text.slice(-MIN_SECRET);
  if (end.length < MIN_SECRET) return 0;
  for (let j = v.lastIndexOf(end); j !== -1; j = j > 0 ? v.lastIndexOf(end, j - 1) : -1) {
    if (text.endsWith(v.slice(0, j + MIN_SECRET))) return j + MIN_SECRET;
  }
  return 0;
}

/**
 * Replaces the values of environment variables outside the allowlist (SR-2) in `text`, then a
 * fragment of a value that a cut left at either edge of `text` (SR-8): a start equal to a
 * suffix of the value, or an end equal to a prefix of it, of at least 8 characters.
 * Short values (< 8 characters) stay: they are not secrets and would garble the text.
 */
export function redactor(env, allowlist = []) {
  const allow = new Set([...BASE_ENV_ALLOWLIST, ...allowlist, ...CI_METADATA_ENV, ...CWD_ENV, ...NPM_ENV]);
  const values = [...new Set(Object.entries(env || {})
    .filter(([k, v]) => !allow.has(k) && typeof v === 'string' && v.length >= MIN_SECRET).map(([, v]) => v))]
    .sort((a, b) => b.length - a.length);
  return (text) => {
    let out = values.reduce((acc, v) => acc.split(v).join(REDACTED), String(text ?? ''));
    for (const v of values) {
      const n = leadingFragment(out, v);
      if (n) out = REDACTED + out.slice(n);
    }
    for (const v of values) {
      const n = trailingFragment(out, v);
      if (n) out = out.slice(0, out.length - n) + REDACTED;
    }
    return out;
  };
}

/**
 * A copy of `value` (plain JSON data) with `redact` applied to every string, except the values
 * under a key in `keep` (identifiers the record is read back by), which stay with their key.
 * Object keys are redacted too (F107 AC-3) only with `keys: true` — only the events ask for that
 * (F109 AC-1, F110 AC-3); the other records are read back by their keys. Two keys that redact to
 * the same key keep the later value.
 */
export function redactDeep(value, redact, keep = new Set(), { keys = false } = {}) {
  const deep = (x) => redactDeep(x, redact, keep, { keys });
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(deep);
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.toJSON === 'function') return deep(value.toJSON());
  return Object.fromEntries(Object.entries(value).map(([k, v]) => (keep.has(k) ? [k, v] : [keys ? redact(k) : k, deep(v)])));
}

/** Failed items of a verify result: [{item, message}] (SPEC §8 report, §7.3 verdict). */
export function verifyFailures(v, redact = (x) => String(x ?? '')) {
  if (!v || v.pass) return [];
  const out = [];
  const add = (item, message) => out.push({ item: String(item), message: redact(message).slice(0, FAILURE_MESSAGE_CHARS) });
  // The output is redacted on its own: a fragment a cut left at its start is at the start there.
  for (const c of v.commands || []) if (!c.pass) add(c.cmd, [c.message, c.output && redact(c.output).trim()].filter(Boolean).join(': '));
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

// The test name a runner output line announces, or null: '✖ <name> (1.2ms)' (node spec reporter)
// or 'not ok <n> - <name> # directive' (TAP). The spec reporter repeats failures under a
// '✖ failing tests:' heading, which is not a test.
function testNameOfLine(line) {
  let name = null;
  if (line.startsWith('✖ ')) name = line.slice(2).replace(/\s+\(\d+(?:\.\d+)?m?s\)\s*$/, '');
  else if (line.startsWith('not ok ')) name = line.slice('not ok '.length).replace(/^\d+\s*(?:-\s*)?/, '').replace(/\s+#\s.*$/, '');
  name = name?.trim();
  return !name || name === 'failing tests:' ? null : name;
}

/**
 * Names of the failed tests in a test runner's output (SPEC §6.1 flaky): lines that start
 * with '✖ ' (node spec reporter) or 'not ok ' (TAP), indentation ignored, duration and TAP
 * directive stripped, distinct, at most `limit`.
 */
export function failedTestNames(text, limit = MAX_FLAKY_TESTS) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const name = testNameOfLine(raw.replace(ANSI, '').trimStart());
    if (!name || out.includes(name)) continue;
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

export const EXCERPT_LINES = 12;
export const EXCERPT_CHARS = 600;

// TAP diagnostics that say nothing about why a test failed.
const TAP_NOISE = /^(?:---|\.\.\.|duration_ms:|type:)/;

/**
 * The failure block of each failed test (SPEC §6.1, F177): [{test, excerpt}] for the names
 * failedTestNames finds, in its order. The block is the lines under the name line that are
 * indented deeper than it (ANSI and the common indentation removed), without TAP's '---',
 * '...', 'duration_ms:' and 'type:' lines and its 'stack:' block. A test reported twice (the
 * spec reporter's '✖ failing tests:' list) uses its first block that has content; a test
 * without one has no entry. An excerpt has at most 12 lines and 600 characters; a cut ends in '…'.
 */
export function failedTestExcerpts(text, limit = MAX_FLAKY_TESTS) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.replace(ANSI, '').trimEnd());
  const indentOf = (l) => l.length - l.trimStart().length;
  const names = failedTestNames(text, limit);
  const found = new Map();
  lines.forEach((line, i) => {
    const name = testNameOfLine(line.trimStart());
    if (!name || found.has(name) || !names.includes(name)) return;
    const depth = indentOf(line);
    const block = [];
    let stackIndent = null;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() && indentOf(l) <= depth) break;
      if (stackIndent !== null) {
        if (!l.trim() || indentOf(l) > stackIndent) continue;
        stackIndent = null;
      }
      const t = l.trim();
      if (t.startsWith('stack:')) { stackIndent = indentOf(l); continue; }
      if (TAP_NOISE.test(t)) continue;
      block.push(l);
    }
    while (block.length && !block[0].trim()) block.shift();
    while (block.length && !block[block.length - 1].trim()) block.pop();
    if (!block.length) return;
    const common = Math.min(...block.filter((l) => l.trim()).map(indentOf));
    const body = block.map((l) => l.slice(Math.min(common, indentOf(l))));
    let excerpt = body.slice(0, EXCERPT_LINES).join('\n');
    const cut = body.length > EXCERPT_LINES;
    if (excerpt.length > EXCERPT_CHARS || (cut && excerpt.length >= EXCERPT_CHARS)) excerpt = `${excerpt.slice(0, EXCERPT_CHARS - 1).trimEnd()}…`;
    else if (cut) excerpt += '…';
    found.set(name, excerpt);
  });
  return names.filter((n) => found.has(n)).map((test) => ({ test, excerpt: found.get(test) }));
}
