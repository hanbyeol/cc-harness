// verify.test_count presets (SPEC §6.2-3): a fixed executable name and a fixed argument
// array per runner, spawned without a shell. No config value ever reaches the arguments —
// the config only selects one of these entries by exact name.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './state.mjs';

export const PRESET_PREFIX = 'preset:';

// Last '# tests N' summary line of the TAP reporter (failing tests still count).
const lastMatch = (re, text) => {
  const all = [...text.matchAll(re)];
  return all.length ? Number(all[all.length - 1][1]) : null;
};

// `go test -list . ./...` prints matching names per package, then an `ok` or `?` line.
// Output with neither names nor package lines is not a listing at all.
function goCount(text) {
  const lines = text.split(/\r?\n/);
  const names = lines.filter((l) => /^(Test|Example|Fuzz)/.test(l)).length;
  if (names > 0 || lines.some((l) => /^(ok|\?)\s/.test(l))) return names;
  return null;
}

export const TEST_COUNT_PRESETS = Object.freeze({
  'node-test': Object.freeze({
    bin: 'node',
    args: Object.freeze(['--test', '--test-reporter=tap']),
    parse: (text) => lastMatch(/^# tests (\d+)\r?$/gm, text),
  }),
  go: Object.freeze({
    bin: 'go',
    args: Object.freeze(['test', '-list', '.', './...']),
    parse: goCount,
  }),
  pytest: Object.freeze({
    bin: 'python',
    args: Object.freeze(['-m', 'pytest', '--collect-only', '-q']),
    parse: (text) => lastMatch(/^(\d+) tests? collected\b/gm, text),
  }),
});

export const PRESET_NAMES = Object.freeze(Object.keys(TEST_COUNT_PRESETS).map((n) => `${PRESET_PREFIX}${n}`));

export const isPresetValue = (v) => typeof v === 'string' && v.startsWith(PRESET_PREFIX);

// The preset for an exact 'preset:<name>' value, or null (unknown or not a preset).
export function getPreset(value) {
  if (!isPresetValue(value)) return null;
  const name = value.slice(PRESET_PREFIX.length);
  return Object.hasOwn(TEST_COUNT_PRESETS, name) ? TEST_COUNT_PRESETS[name] : null;
}

// 'from:commands[i]': the count is read from the output of verify.commands[i] (§6.2-3).
export const FROM_PREFIX = 'from:';
const FROM_RE = /^from:commands\[(0|[1-9]\d*)\]$/;

export const isFromValue = (v) => typeof v === 'string' && v.startsWith(FROM_PREFIX);

// The command index of an exact 'from:commands[i]' value, or null.
export function fromIndex(value) {
  const m = typeof value === 'string' ? FROM_RE.exec(value) : null;
  return m ? Number(m[1]) : null;
}

// Last '# tests N' (TAP reporter) or 'ℹ tests N' (spec reporter) summary line, or null.
export const parseSummaryCount = (text) => lastMatch(/^(?:# |\u2139 )tests (\d+)\r?$/gm, text);

// Base-side counts, keyed by (base commit, command, counting rule) — a commit's tests do
// not change, so the same key never needs another run (§6.2-3). Kept to the newest entries.
export const TEST_COUNT_CACHE = 'test-count-cache.json';
const CACHE_LIMIT = 200;

const validCount = (n) => Number.isSafeInteger(n) && n >= 0;

// { entries, warning? }: a missing file is an empty cache; an unreadable or malformed one
// is ignored with a warning naming the file (the counts are simply run again).
export function readCountCache(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { entries: [] };
    return { entries: [], warning: `test count cache ${file} cannot be read (${e.code || e.message}) — ignored, base count is run` };
  }
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!data || typeof data !== 'object' || !Array.isArray(data.entries)) {
    return { entries: [], warning: `test count cache ${file} is not valid JSON of the expected shape — ignored, base count is run and the file rewritten` };
  }
  return { entries: data.entries.filter((e) => e && typeof e === 'object') };
}

// The cached count for a key, or null. An entry whose count is not a non-negative
// integer is never used: the count is run again.
export function cachedCount(entries, key) {
  const hit = entries.find((e) => e.base === key.base && e.command === key.command && e.rule === key.rule);
  return hit && validCount(hit.count) ? hit.count : null;
}

// Re-reads the file and replaces the key's entry, so concurrent verifies lose as little as
// possible. Returns a warning string when the file cannot be written, else null.
export function storeCount(file, key, count) {
  if (!validCount(count)) return null;
  const { entries } = readCountCache(file);
  const rest = entries.filter((e) => !(e.base === key.base && e.command === key.command && e.rule === key.rule));
  const next = [...rest, { base: key.base, command: key.command, rule: key.rule, count }].slice(-CACHE_LIMIT);
  try {
    writeJsonAtomic(file, { entries: next });
    return null;
  } catch (e) {
    return `cannot write test count cache ${file}: ${e.message}`;
  }
}

const readText = (file) => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
};

// The preset suggested for a project directory, or null. Checked in this order:
// package.json scripts.test running `node --test`, go.mod, pytest configuration.
export function detectPreset(dir) {
  const pkg = readText(path.join(dir, 'package.json'));
  if (pkg !== null) {
    let testScript = null;
    try { testScript = JSON.parse(pkg)?.scripts?.test; } catch { /* not JSON: no suggestion from it */ }
    if (typeof testScript === 'string' && testScript.includes('node --test')) return 'preset:node-test';
  }
  if (fs.existsSync(path.join(dir, 'go.mod'))) return 'preset:go';
  if (fs.existsSync(path.join(dir, 'pytest.ini')) || fs.existsSync(path.join(dir, 'conftest.py'))) return 'preset:pytest';
  const pyproject = readText(path.join(dir, 'pyproject.toml'));
  if (pyproject !== null && /^\s*\[tool\.pytest\.ini_options\]\s*$/m.test(pyproject)) return 'preset:pytest';
  return null;
}
