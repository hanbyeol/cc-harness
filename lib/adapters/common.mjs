// Shared machinery for CLI adapters: process invocation (incl. Windows .cmd shims),
// output → JSON extraction, and the never-throwing run() skeleton.
import fs from 'node:fs';
import path from 'node:path';
import { runCommand, isNotFound } from '../exec.mjs';

// ---------------------------------------------------------------- JSON extraction

const isContainer = (v) => v !== null && typeof v === 'object';

function tryParse(s) {
  try {
    const v = JSON.parse(s);
    return isContainer(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

// claude `-p --output-format json` wrapper (measured, 2.1.280):
//   {"type":"result","subtype":"success"|"error_max_budget_usd"|…,"is_error":bool,
//    "result":"<model text>","total_cost_usd":0.07,…}
// `result` is absent when the run ended in error. With --json-schema the validated
// object is assumed to arrive in `structured_output` (not measured; falls back to `result`).
const isClaudeWrapper = (v) => isContainer(v) && !Array.isArray(v) && v.type === 'result'
  && ('total_cost_usd' in v || 'is_error' in v);

// gemini `-o json` wrapper (documented shape; the measured error form is
// {"session_id","error":{type,message,code}}): {"session_id"?,"response":"<model text>","stats":{…}}
const isGeminiWrapper = (v) => isContainer(v) && !Array.isArray(v) && typeof v.response === 'string'
  && ('stats' in v || 'session_id' in v);

const FENCE = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;

// Pulls a JSON object/array out of model text. Accepts, in order:
// the whole text as JSON, the last ```json (or bare ```) fenced block that parses,
// then the outermost {...} span. Returns null when nothing parses.
function jsonFromModelText(text) {
  if (typeof text !== 'string') return null;
  const whole = tryParse(text.trim());
  if (whole !== undefined) return whole;
  const blocks = [...text.matchAll(FENCE)].filter((m) => m[1] === '' || m[1].toLowerCase() === 'json');
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const v = tryParse(blocks[i][2].trim());
    if (v !== undefined) return v;
  }
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a !== -1 && b > a) {
    const v = tryParse(text.slice(a, b + 1));
    if (v !== undefined) return v;
  }
  return null;
}

/**
 * Parses raw CLI stdout. Unwraps the claude/gemini JSON wrappers.
 * @returns {{json: object|null, text: string, costUsd: number|null}}
 */
export function parseOutput(raw) {
  const stdout = typeof raw === 'string' ? raw : '';
  const top = tryParse(stdout.trim());
  if (isClaudeWrapper(top)) {
    const text = typeof top.result === 'string' ? top.result : '';
    const costUsd = typeof top.total_cost_usd === 'number' ? top.total_cost_usd : null;
    const json = isContainer(top.structured_output) ? top.structured_output : jsonFromModelText(text);
    return { json, text, costUsd };
  }
  if (isGeminiWrapper(top)) {
    return { json: jsonFromModelText(top.response), text: top.response, costUsd: null };
  }
  return { json: jsonFromModelText(stdout), text: stdout, costUsd: null };
}

export function extractJson(raw) {
  return parseOutput(raw).json;
}

// ---------------------------------------------------------------- invocation

// cmd.exe metacharacters (same set cross-spawn escapes).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

export function escapeCmdCommand(s) {
  return s.replace(CMD_META, '^$1');
}

// MSVCRT argv quoting, then caret-escape for cmd.exe. `.cmd`/`.bat` shims re-parse
// their `%*` once more, so their arguments are escaped twice.
export function escapeCmdArgument(arg, doubleEscape) {
  let s = String(arg);
  s = s.replace(/(\\*)"/g, '$1$1\\"');
  s = s.replace(/(\\*)$/, '$1$1');
  s = `"${s}"`;
  s = s.replace(CMD_META, '^$1');
  if (doubleEscape) s = s.replace(CMD_META, '^$1');
  return s;
}

// Resolves `bin` against PATH × PATHEXT the way cmd.exe would (win32 only).
function whichWin32(bin, env, exists) {
  const p = path.win32;
  const exts = (env.PATHEXT || env.Pathext || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasExt = exts.some((e) => bin.toLowerCase().endsWith(e.toLowerCase()));
  const candidates = hasExt ? [bin] : exts.map((e) => bin + e.toLowerCase());
  const dirs = /[\\/]/.test(bin) ? [''] : (env.Path || env.PATH || '').split(';').filter(Boolean);
  for (const d of dirs) {
    for (const c of candidates) {
      const full = d ? p.join(d, c) : c;
      if (exists(full)) return full;
    }
  }
  return null;
}

const defaultExists = (f) => {
  try { return fs.statSync(f).isFile(); } catch { return false; }
};

/**
 * Decides how to spawn `bin args` on `platform`.
 * - POSIX: spawn the file directly (no shell), arguments passed verbatim.
 * - win32: resolve via PATH/PATHEXT. `.exe`/`.com` spawn directly. npm-installed CLIs are
 *   `.cmd` shims, which CreateProcess cannot start without cmd.exe: build one escaped command
 *   line and hand it to runCommand as a string (Node runs it as `cmd.exe /d /s /c "<line>"`
 *   with verbatim arguments). The prompt never appears on this line — it goes through stdin.
 * @returns {{file:string,args:string[]}|string|null}  null = binary not found
 */
export function resolveInvocation(bin, args, { platform = process.platform, env = process.env, exists = defaultExists } = {}) {
  if (platform !== 'win32') return { file: bin, args };
  const full = whichWin32(bin, env, exists);
  if (!full) return null;
  if (/\.(exe|com)$/i.test(full)) return { file: full, args };
  return [escapeCmdCommand(full), ...args.map((a) => escapeCmdArgument(a, true))].join(' ');
}

// ---------------------------------------------------------------- run skeleton

const RESULT_KEYS = ['ok', 'error', 'text', 'json', 'costUsd', 'exitCode'];

const result = (fields) => ({ ok: false, error: null, text: '', json: null, costUsd: null, exitCode: null, detail: null, ...fields });

const tail = (s, n = 2000) => (s && s.length > n ? s.slice(-n) : s || '');

/**
 * Runs one adapter invocation. Never throws.
 * opts.bin / opts.binArgs override the executable (tests point it at a fake CLI:
 * bin = node, binArgs = [script, mode]); opts.platform / opts.env / opts.exists feed
 * resolveInvocation.
 */
export async function runAdapter(adapter, opts = {}) {
  try {
    const args = adapter.buildArgs(opts);
    const bin = opts.bin || adapter.bin;
    if (!bin) return result({ error: 'adapter_unavailable', detail: `${adapter.name}: no executable configured` });
    const inv = resolveInvocation(bin, [...(opts.binArgs || []), ...args], {
      platform: opts.platform, env: opts.env, exists: opts.exists,
    });
    if (!inv) return result({ error: 'adapter_unavailable', detail: `${bin}: not found on PATH` });
    const r = await runCommand(inv, {
      cwd: opts.cwd || process.cwd(),
      timeoutSec: opts.timeoutSec || 1800,
      inheritEnv: true, // CLIs need their auth env (SPEC §10)
      input: opts.prompt ?? '',
      signal: opts.signal,
    });
    if (r.aborted) return result({ error: 'aborted', exitCode: r.code, detail: 'interrupted' });
    if (r.timedOut) return result({ error: 'timeout', exitCode: r.code, detail: `killed after ${opts.timeoutSec}s` });
    if (isNotFound(r)) return result({ error: 'adapter_unavailable', exitCode: r.code, detail: `${bin}: not found (${r.error || r.code})` });
    const parsed = parseOutput(r.stdout);
    // The CLI's stderr is not repeated here: an auth failure may echo credentials.
    const unavailable = !r.error && r.code !== 0 ? adapter.unavailableExit?.(r.code) : null;
    if (unavailable) return result({ ...parsed, error: 'adapter_unavailable', exitCode: r.code, detail: unavailable });
    if (r.error || r.code !== 0) {
      return result({ ...parsed, error: 'exit_nonzero', exitCode: r.code, detail: tail(r.stderr) || r.error || tail(r.stdout) });
    }
    if (opts.schema && parsed.json === null) {
      return result({ ...parsed, error: 'no_json', exitCode: r.code, detail: 'no JSON object found in output' });
    }
    return result({ ...parsed, ok: true, exitCode: r.code });
  } catch (e) {
    return result({ error: 'exit_nonzero', detail: `adapter error: ${e.message}` });
  }
}

export { RESULT_KEYS };

// ---------------------------------------------------------------- help-text checks

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// An option name as it appears in a declaration, e.g. `-p`, `--output-format <format>`,
// `--resume [value]`.
const OPT = String.raw`--?[A-Za-z0-9][\w-]*(?:\s*<[^>]*>|\s*\[[^\]]*\])?`;
const indentOf = (l) => l.length - l.trimStart().length;

// Lines describing `flag`: the line where it is declared plus its wrapped continuation
// lines, up to the next option declaration.
function flagBlock(help, flag) {
  const lines = help.split(/\r?\n/);
  // A declaration line starts with a comma-separated list of option names that includes
  // `flag`. A mention inside another option's wrapped description (claude wraps
  // "--print and --output-format=stream-json)" onto its own line) does not count.
  const decl = new RegExp(String.raw`^\s*(?:${OPT},\s*)*${escapeRe(flag)}(?=[\s,=<\[]|$)`);
  // Wrapped description lines can also begin with the flag ("--output-format=stream-json)"
  // at column 40); the real declaration is the least-indented match.
  let i = -1;
  lines.forEach((l, k) => { if (decl.test(l) && (i === -1 || indentOf(l) < indentOf(lines[i]))) i = k; });
  if (i === -1) return null;
  const base = indentOf(lines[i]);
  const isOptionStart = new RegExp(String.raw`^\s*${OPT}(?:,|\s|$)`);
  const block = [lines[i]];
  // The block ends at the next declaration (an option name indented like this one) or an
  // unindented section header ("Commands:"). Wrapped description lines, blank lines and
  // "- value: …" bullets (clap long help) stay in the block.
  for (let j = i + 1; j < lines.length; j += 1) {
    const l = lines[j];
    if (/^\S/.test(l)) break;
    if (isOptionStart.test(l) && indentOf(l) <= base + 4) break;
    block.push(l);
  }
  return block.join('\n');
}

/**
 * Checks required flags against --help text. A requirement is `--flag` or `--flag=value`
 * (value must be listed in the flag's own description, e.g. its choices).
 * @returns {string[]} the requirements that are missing
 */
export function missingFlags(help, required) {
  const text = typeof help === 'string' ? help : '';
  return required.filter((req) => {
    const eq = req.indexOf('=', 2);
    const flag = eq === -1 ? req : req.slice(0, eq);
    const value = eq === -1 ? null : req.slice(eq + 1);
    const block = flagBlock(text, flag);
    if (block === null) return true;
    if (value === null) return false;
    return !new RegExp(`(^|[\\s"',(\\[])${escapeRe(value)}(?=[\\s"',)\\]]|$)`).test(block);
  });
}
