// `harness export [--hub <dir>] [--dry-run]` — writes the events recorded since the last export,
// reduced to the allowlist, as <hub>/<project>/<ISO time>.jsonl (SPEC §2 현장 데이터 내보내기).
// On by default: off when config telemetry.share is false (or not a boolean) or
// CC_HARNESS_TELEMETRY is 0, off, false or no (trimmed, any case).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HarnessError } from '../errors.mjs';
import { loadConfig } from '../config.mjs';
import { telemetryState, TELEMETRY_ENV, defaultOnNotice, exportedFile, planExport, writeExport, readSalt, saltFile } from '../telemetry.mjs';

const USAGE = 'usage: harness export [--hub <dir>] [--dry-run]';
export const SHARE_OFF = 'telemetry.share is off — nothing exported (set "telemetry": {"share": true} in .harness/config.json to turn it on)';
export const ENV_OFF = `telemetry.share is off (${TELEMETRY_ENV}) — nothing exported (unset ${TELEMETRY_ENV} to follow .harness/config.json)`;
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

/**
 * Exports once; returns the exit code. `notice`: telemetry is on by default, so the first export
 * of the project (no events/.exported yet) that succeeds says where the events went, on `err`.
 * `env` and `now` are for tests.
 */
export function runExport({ root, hub = null, dryRun = false, notice = false, out, err, env = process.env, now = new Date() }) {
  let salt;
  try {
    // A dry run creates nothing (F107 AC-1): without a salt file it previews with a throwaway salt.
    salt = readSalt({ create: !dryRun });
  } catch (e) {
    // A telemetry failure never fails the command (F101 SC-2): nothing is exported, positions stay.
    err(`harness: warning: ${e.message} — nothing exported`);
    return 0;
  }
  const temporary = salt === null;
  if (temporary) salt = crypto.randomBytes(32).toString('hex');
  const plan = planExport(root, { hub, env, now, salt });
  for (const w of plan.warnings) err(`harness: warning: ${w}`);
  if (dryRun) {
    if (temporary) out(`no telemetry salt yet — the salt will be created at ${saltFile()} by the first real export; the project directory and hashes below use a temporary salt and will differ`);
    out(`dry run: ${plan.lines.length} line${plan.lines.length === 1 ? '' : 's'} would be exported to ${plan.file}`);
    for (const l of plan.lines.slice(0, PREVIEW)) out(JSON.stringify(l));
    return 0;
  }
  const first = notice && !fs.existsSync(exportedFile(root));
  try {
    // With no line to export this still records new positions (skipped lines, an .exported of
    // the earlier form, a truncated file).
    const r = writeExport(root, plan, { now });
    if (r.count) out(`exported ${r.count} line${r.count === 1 ? '' : 's'} to ${r.file}`);
    else out(`nothing to export since ${plan.since ?? 'the first event'}`);
    if (first) err(defaultOnNotice(path.dirname(path.dirname(plan.file))));
    return 0;
  } catch (e) {
    err(`harness: export failed: ${e.message}`);
    return 1;
  }
}

// The CC_HARNESS_TELEMETRY warning is printed once per process (F107 AC-2): a run exports after
// every feature and would repeat it.
let warned = false;
function warnOnce(warning, err) {
  if (!warning || warned) return;
  warned = true;
  err(warning);
}

/**
 * The export at the end of run and eval (telemetry.share and telemetry.auto_export on — both are
 * by default). Never throws and prints only to `err`: the command's result and stdout stay as they were.
 */
export function autoExport({ root, err, env = process.env }) {
  try {
    const state = telemetryState(loadConfig(root), env);
    warnOnce(state.warning, err);
    if (!state.autoExport) return;
    runExport({ root, notice: state.source === 'default', out: err, err, env });
  } catch (e) {
    try { err(`harness: warning: auto export failed: ${e.message}`); } catch { /* nothing left to report to */ }
  }
}

export default async function exportCommand({ root, args, out, err, env = process.env, now }) {
  const opts = parseArgs(args);
  const state = telemetryState(loadConfig(root), env);
  warnOnce(state.warning, err);
  if (!state.share) {
    out(state.source === 'env' ? ENV_OFF : SHARE_OFF);
    return 0;
  }
  return runExport({ root, hub: opts.hub, dryRun: opts.dryRun, notice: state.source === 'default', out, err, env, now });
}
