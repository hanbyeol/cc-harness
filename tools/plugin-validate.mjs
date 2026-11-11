#!/usr/bin/env node
// F158: strict plugin validation for this repository. Runs `claude plugin validate . --strict
// --json` (or reads a saved report with --report <file>) and passes when the report has no
// errors and no advice, and its only warning is the known one about the repository's own
// development CLAUDE.md at the plugin root. directory.findings (e.g. ICON_MISSING) are
// ignored: the validator itself says they do not change the result.
//   exit 0  only the known warning (or none)
//   exit 1  any other warning, error or advice; each is printed on stderr
//   exit 2  the report cannot be read, or claude cannot be run
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const KNOWN = (w) => w && w.path === 'root' && typeof w.message === 'string'
  && w.message.startsWith('CLAUDE.md at the plugin root is not loaded');

function fail(code, msg) {
  process.stderr.write(`plugin-validate: ${msg}\n`);
  process.exit(code);
}

// The first file named `name` (with a PATHEXT extension on Windows) in a PATH directory, or null.
function onPath(name) {
  const env = process.env;
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const f = path.join(d, name + e);
      try {
        if (fs.statSync(f).isFile()) return f;
      } catch { /* not here */ }
    }
  }
  return null;
}

function readReport(argv) {
  const i = argv.indexOf('--report');
  if (i >= 0) {
    const file = argv[i + 1];
    if (!file) fail(2, 'usage: plugin-validate.mjs [--report <file>]');
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (e) {
      fail(2, `unreadable report (${e.code ?? e.message})`);
    }
  }
  // Looked up on PATH first: on Windows `claude` is a .cmd shim that only a shell runs, and a
  // shell reports a missing command as an ordinary exit code instead of ENOENT.
  const bin = onPath('claude');
  if (!bin) fail(2, 'claude not found');
  const win = process.platform === 'win32';
  const r = spawnSync(win ? `"${bin}"` : bin, ['plugin', 'validate', '.', '--strict', '--json'], { encoding: 'utf8', shell: win });
  if (r.error?.code === 'ENOENT') fail(2, 'claude not found');
  if (r.error) fail(2, `claude could not be run (${r.error.message})`);
  return r.stdout;
}

/** The problems of a parsed report, as `<file>: <kind>: <message>` lines; null when it is not a report. */
export function problems(report) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.contents)) return null;
  const out = [];
  const entries = [report.manifest, ...report.contents].filter((e) => e && typeof e === 'object');
  for (const e of entries) {
    const where = e.file ?? '(unknown file)';
    for (const x of Array.isArray(e.errors) ? e.errors : []) out.push(`${where}: error: ${x?.message ?? JSON.stringify(x)}`);
    for (const x of Array.isArray(e.warnings) ? e.warnings : []) {
      if (!KNOWN(x)) out.push(`${where}: warning: ${x?.message ?? JSON.stringify(x)}`);
    }
  }
  for (const x of Array.isArray(report.advice) ? report.advice : []) out.push(`advice: ${x?.message ?? JSON.stringify(x)}`);
  return out;
}

function main() {
  const text = readReport(process.argv.slice(2));
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    fail(2, 'unreadable report (not JSON)');
  }
  const found = problems(report);
  if (found === null) fail(2, "unreadable report (no 'contents' array)");
  if (found.length) {
    for (const p of found) process.stderr.write(`${p}\n`);
    fail(1, `${found.length} problem(s) besides the known root CLAUDE.md warning`);
  }
  process.stdout.write('plugin-validate: ok (only the known root CLAUDE.md warning)\n');
}

main();
