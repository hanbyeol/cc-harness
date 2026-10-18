// Partial re-run of a failed `node --test` verify command (SPEC §6.1): the re-runs run only
// the test files the first run's spec or TAP output located a failed test in.
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

// `rel` of a located file (a path, maybe a file:// URL) under the realpath `root`, or null when
// it is outside `root`, missing or not a file.
function locate(root, p) {
  if (p.startsWith('file://')) {
    try { p = fileURLToPath(p); } catch { return null; }
  }
  const real = realpath(path.resolve(root, p));
  if (!real) return null;
  const rel = path.relative(root, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try { if (!fs.statSync(real).isFile()) return null; } catch { return null; }
  return rel;
}

// The JS string literal util.inspect wrote ('...', "..." or `...`) as its value, or null.
function unquoteInspect(text) {
  const q = text[0];
  if (q !== "'" && q !== '"' && q !== '`') return null;
  let out = '';
  for (let i = 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === q) return i === text.length - 1 ? out : null;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    i += 1;
    if (i >= text.length || !'\\\'"`'.includes(text[i])) return null;
    out += text[i];
  }
  return null;
}

// The failed test files of a TAP output: the 'location' key of each 'not ok' block that is not
// a TODO or SKIP. `{ files }` (relative to the realpath `root`) or `{ reason }`.
function tapFailedFiles(lines, root) {
  const files = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^( *)not ok\b(.*)$/.exec(lines[i]);
    if (!m || /\s#\s*(TODO|SKIP)\b/i.test(m[2])) continue;
    const key = `${m[1]}  `;
    let value = null;
    if (lines[i + 1]?.trimEnd() === `${key}---`) {
      for (let j = i + 2; j < lines.length; j += 1) {
        const l = lines[j];
        if (l.trimEnd() === `${key}...` || !l.startsWith(key)) break;
        if (l.startsWith(`${key}location:`) && l[key.length + 'location:'.length] === ' ') {
          value = l.slice(key.length + 'location: '.length).trim();
          break;
        }
      }
    }
    if (value === null) return { reason: 'unknown_file' };
    const text = unquoteInspect(value);
    const lm = text === null ? null : /^(.+):\d+:\d+$/.exec(text);
    const rel = lm ? locate(root, lm[1]) : null;
    if (!rel) return { reason: 'unknown_file' };
    if (!files.includes(rel)) files.push(rel);
  }
  return files.length === 0 ? { reason: 'no_files' } : { files };
}

/**
 * The failed test files of a first run's output, as paths relative to `cwd`, distinct, in order:
 * the 'test at <path>:<line>:<col>' lines under the spec reporter's '✖ failing tests:' heading,
 * or, without that heading, the 'location' keys of the TAP 'not ok' blocks.
 * `{ files }`, or `{ reason }` when no file was found, a located file is outside `cwd` or does
 * not exist, or (spec) that section lists more failed tests ('✖ ' lines) than locations, or
 * (TAP) a failed test has no readable location.
 */
export function failedTestFiles(output, cwd) {
  const lines = String(output ?? '').split(/\r?\n/).map((l) => l.replace(ANSI, ''));
  const start = lines.findIndex((l) => l.trim() === '✖ failing tests:');
  const root = realpath(cwd);
  if (!root) return { reason: 'no_files' };
  if (start === -1) return tapFailedFiles(lines, root);
  const files = [];
  let located = 0;
  let failed = 0;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('✖ ')) failed += 1;
    if (!line.startsWith('test at ')) continue;
    located += 1;
    const m = /^(.+):\d+:\d+$/.exec(line.slice('test at '.length).trim());
    if (!m) return { reason: 'unknown_file' };
    const rel = locate(root, m[1]);
    if (!rel) return { reason: 'unknown_file' };
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
