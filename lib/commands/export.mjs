// `harness export [--hub <dir>] [--dry-run]` — writes the events recorded since the last export,
// reduced to the allowlist, as <hub>/<project>/<ISO time>.jsonl (SPEC §2 현장 데이터 내보내기).
// Opt-in: nothing happens unless config telemetry.share is true.
import { HarnessError } from '../errors.mjs';
import { loadConfig } from '../config.mjs';
import { isShareOn, isAutoExportOn, planExport, writeExport } from '../telemetry.mjs';

const USAGE = 'usage: harness export [--hub <dir>] [--dry-run]';
export const SHARE_OFF = 'telemetry.share is off — nothing exported (set "telemetry": {"share": true} in .harness/config.json to opt in)';
const PREVIEW = 3;

function parseArgs(args) {
  const opts = { hub: null, dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--hub') {
      const v = args[i + 1];
      if (v === undefined || v === '' || v.startsWith('-')) throw new HarnessError(`--hub needs a directory\n${USAGE}`, { code: 'usage' });
      opts.hub = v;
      i += 1;
    } else throw new HarnessError(`unexpected argument '${a}'\n${USAGE}`, { code: 'usage' });
  }
  return opts;
}

/** Exports once; returns the exit code. `env` and `now` are for tests. */
export function runExport({ root, hub = null, dryRun = false, out, err, env = process.env, now = new Date() }) {
  const plan = planExport(root, { hub, env, now });
  for (const w of plan.warnings) err(`harness: warning: ${w}`);
  if (dryRun) {
    out(`dry run: ${plan.lines.length} line${plan.lines.length === 1 ? '' : 's'} would be exported to ${plan.file}`);
    for (const l of plan.lines.slice(0, PREVIEW)) out(JSON.stringify(l));
    return 0;
  }
  try {
    // With no line to export this still records new positions (skipped lines, an .exported of
    // the earlier form, a truncated file).
    const r = writeExport(root, plan, { now });
    if (r.count) out(`exported ${r.count} line${r.count === 1 ? '' : 's'} to ${r.file}`);
    else out(`nothing to export since ${plan.since ?? 'the first event'}`);
    return 0;
  } catch (e) {
    err(`harness: export failed: ${e.message}`);
    return 1;
  }
}

/**
 * The export at the end of run and eval (telemetry.share and telemetry.auto_export both true).
 * Never throws and prints only to `err`: the command's result and stdout stay as they were.
 */
export function autoExport({ root, err }) {
  try {
    if (!isAutoExportOn(loadConfig(root))) return;
    runExport({ root, out: err, err });
  } catch (e) {
    try { err(`harness: warning: auto export failed: ${e.message}`); } catch { /* nothing left to report to */ }
  }
}

export default async function exportCommand({ root, args, out, err, env, now }) {
  const opts = parseArgs(args);
  if (!isShareOn(loadConfig(root))) {
    out(SHARE_OFF);
    return 0;
  }
  return runExport({ root, hub: opts.hub, dryRun: opts.dryRun, out, err, env, now });
}
