// verify.test_count presets (SPEC §6.2-3): a fixed executable name and a fixed argument
// array per runner, spawned without a shell. No config value ever reaches the arguments —
// the config only selects one of these entries by exact name.
import fs from 'node:fs';
import path from 'node:path';

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
