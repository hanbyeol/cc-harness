// Gemini CLI adapter. Every flag below appears in `gemini --help` (0.38.1,
// fixture test/fixtures/help/gemini-0.38.1.txt).
// `-p/--prompt` "Run in non-interactive (headless) mode with the given prompt. Appended to
// input on stdin (if any)." — so `-p ""` selects headless mode and the real prompt arrives
// on stdin (measured: `-p ""` is accepted by the parser).
// No structured-output or budget flag exists: JSON is extracted from the `-o json` wrapper's
// `response` text, and cost is bounded by timeout only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAdapter } from './common.mjs';

// Any of these selects a non-interactive auth method; only their presence is checked.
export const AUTH_ENV = Object.freeze(['GEMINI_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA']);
// gemini's FatalAuthenticationError exit code.
export const AUTH_EXIT = 41;

const present = (v) => typeof v === 'string' && v !== '';

/**
 * Whether headless gemini can authenticate, decided without a (paid) call (SPEC §10):
 * one of AUTH_ENV is set, or the user's ~/.gemini/settings.json has security.auth.selectedType
 * (written by an interactive login). Reports names only — never a value.
 * @returns {{ok:boolean, via?:string, reason?:string}}
 */
export function authStatus(env = process.env) {
  const name = AUTH_ENV.find((k) => present(env[k]));
  if (name) return { ok: true, via: name };
  // Where gemini itself looks (os.homedir()): USERPROFILE on Windows, HOME elsewhere.
  const home = (process.platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME) || os.homedir();
  const file = path.join(home, '.gemini', 'settings.json');
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') settings = null;
    else return { ok: false, reason: 'not authenticated (settings.json unreadable)' };
  }
  if (present(settings?.security?.auth?.selectedType)) return { ok: true, via: 'settings.json' };
  return { ok: false, reason: `not authenticated (set ${AUTH_ENV.join(', ')} or log in once with \`gemini\`)` };
}

const adapter = {
  name: 'gemini',
  bin: 'gemini',
  helpArgs: ['--help'],
  buildArgs({ readOnly = false, model } = {}) {
    const args = ['-p', ''];
    if (readOnly) args.push('--approval-mode', 'plan');
    else args.push('--approval-mode', 'yolo', '-s');
    args.push('-o', 'json');
    if (model) args.push('-m', model);
    return args;
  },
  requiredFlags({ readOnly = false, model } = {}) {
    const req = ['-p', `--approval-mode=${readOnly ? 'plan' : 'yolo'}`, '-o=json'];
    if (!readOnly) req.push('-s');
    if (model) req.push('-m');
    return req;
  },
  authStatus,
  // Exit codes that mean the CLI cannot work at all (not a failed step).
  unavailableExit(code) {
    return code === AUTH_EXIT ? `gemini: authentication failed (exit ${AUTH_EXIT}) — set ${AUTH_ENV.join(', ')} or log in with \`gemini\`` : null;
  },
  run(opts) {
    return runAdapter(adapter, opts);
  },
};

export default adapter;
