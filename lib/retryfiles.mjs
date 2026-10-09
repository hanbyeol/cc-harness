// Partial re-run of a failed `node --test` verify command (SPEC §6.1): the re-runs run only
// the test files the first run's spec reporter output located a failed test in.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
// Characters outside quotes that chain, redirect, substitute, escape or comment out; a command
// with one is not parsed. Other words are copied into the re-run as they were written.
const SHELL_SPECIAL = /[;|&<>$`()\\\r\n#^]/;
// A word passed as is by both sh and cmd.exe.
const PLAIN = /^[A-Za-z0-9_\-./:=@+,]+$/;

// Raw words of a command line (quoted parts kept, quotes included), or null when an unquoted
// part has a shell special character or a quote is not closed.
function rawWords(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of cmd) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
    } else if (SHELL_SPECIAL.test(ch)) {
      return null;
    } else {
      cur += ch;
    }
  }
  if (quote) return null;
  if (cur) out.push(cur);
  return out;
}

const unquote = (w) => w.replace(/["']/g, '');

/**
 * The parts of a command of the form `node [--option...] --test [argument...]`: `head` is the
 * raw text up to and including `--test`, `options` the raw arguments after it that start with
 * `--`. Null for any other command, and when an argument after `--test` is `--` alone or a
 * `--flag` without '=' followed by a word that is not an option (it may be the flag's value).
 */
export function parseNodeTest(cmd) {
  const words = rawWords(String(cmd ?? '').trim());
  if (!words || words.length < 2 || words[0] !== 'node') return null;
  const at = words.findIndex((w) => unquote(w) === '--test');
  if (at < 1) return null;
  if (!words.slice(1, at).every((w) => unquote(w).startsWith('--'))) return null;
  const rest = words.slice(at + 1);
  const options = [];
  for (const [i, w] of rest.entries()) {
    const v = unquote(w);
    if (!v.startsWith('--')) continue;
    if (v === '--') return null;
    const next = rest[i + 1];
    if (!v.includes('=') && next !== undefined && !unquote(next).startsWith('--')) return null;
    options.push(w);
  }
  return { head: words.slice(0, at + 1).join(' '), options };
}

/** A file path as one shell argument (sh: single quotes; cmd.exe: double quotes), or null. */
export function shellQuote(file, platform = process.platform) {
  if (PLAIN.test(file)) return file;
  if (platform === 'win32') return /["%!\r\n]/.test(file) ? null : `"${file}"`;
  return `'${file.replace(/'/g, "'\\''")}'`;
}

const realpath = (p) => {
  try { return fs.realpathSync.native(p); } catch { return null; }
};

/**
 * The failed test files of a spec reporter output: the 'test at <path>:<line>:<col>' lines
 * under the '✖ failing tests:' heading, as paths relative to `cwd`, distinct, in order.
 * `{ files }`, or `{ reason }` when no file was found, a located file is outside `cwd` or does
 * not exist, or that section lists more failed tests ('✖ ' lines) than locations.
 */
export function failedTestFiles(output, cwd) {
  const lines = String(output ?? '').split(/\r?\n/).map((l) => l.replace(ANSI, ''));
  const start = lines.findIndex((l) => l.trim() === '✖ failing tests:');
  if (start === -1) return { reason: 'no_files' };
  const root = realpath(cwd);
  if (!root) return { reason: 'no_files' };
  const files = [];
  let located = 0;
  let failed = 0;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('✖ ')) failed += 1;
    if (!line.startsWith('test at ')) continue;
    located += 1;
    const m = /^(.+):\d+:\d+$/.exec(line.slice('test at '.length).trim());
    if (!m) return { reason: 'unknown_file' };
    let p = m[1];
    if (p.startsWith('file://')) {
      try { p = fileURLToPath(p); } catch { return { reason: 'unknown_file' }; }
    }
    const real = realpath(path.resolve(root, p));
    if (!real) return { reason: 'unknown_file' };
    const rel = path.relative(root, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { reason: 'unknown_file' };
    try { if (!fs.statSync(real).isFile()) return { reason: 'unknown_file' }; } catch { return { reason: 'unknown_file' }; }
    if (!files.includes(rel)) files.push(rel);
  }
  if (files.length === 0) return { reason: 'no_files' };
  if (failed > located) return { reason: 'unlocated_failures' };
  return { files };
}

/**
 * The re-run of a failed verify command: `{ cmd, files }` with the command
 * `node [same options] --test [its '--' arguments] <failed files...>`, or null when the whole
 * command runs again (SPEC §6.1).
 */
export function partialRetry(cmd, output, cwd, { scope = 'failed_files', platform = process.platform } = {}) {
  if (scope !== 'failed_files') return null;
  const parsed = parseNodeTest(cmd);
  if (!parsed) return null;
  const found = failedTestFiles(output, cwd);
  if (!found.files) return null;
  const quoted = found.files.map((f) => shellQuote(f, platform));
  if (quoted.includes(null)) return null;
  return { cmd: [parsed.head, ...parsed.options, ...quoted].join(' '), files: found.files };
}
