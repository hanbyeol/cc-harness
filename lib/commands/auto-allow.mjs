// `harness auto-allow`: a PreToolUse hook for Bash (hooks/hooks.json). Reads the hook's JSON from
// stdin and prints an `allow` decision when the command is exactly one cc-harness core command,
// optionally followed by `2>&1` and one `| tail -<n>`, `| head -<n>` or `| grep <word>` stage
// (SPEC §8.13). Anything else — including input it cannot read — prints nothing, so the normal
// permission flow applies. Always exit 0. When in doubt it prints nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USAGE } from '../help.mjs';

const ALLOW = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'cc-harness core command' } };
// Commands that record a human decision: never auto-allowed.
const EXCLUDED = new Set(['decide', 'migrate-v1']);
const PLAIN = /^[A-Za-z0-9_\-./=:,@%+]+$/;
// Characters that end an unquoted word or are refused outright.
const BREAK = new Set([' ', '\t', '|', "'", '"']);

const SELF = (() => {
  try {
    return fs.realpathSync.native(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'harness.mjs'));
  } catch {
    return null;
  }
})();

/**
 * Words of a command: [{text, quoted, backslash}] and the token '|' as {pipe: true}; the exact
 * word `2>&1` is {redirect: true}. `backslash` is true when a quoted part of the word holds a
 * backslash: single quotes keep it literal; in double quotes a backslash before `"`, `\`, `$` or
 * a backtick is a shell escape and returns null. Returns null for anything outside this small
 * grammar: expansions, unquoted backslashes, other redirects or operators, control characters,
 * unterminated quotes.
 */
export function words(command) {
  if (/[\n\r;&`$<>()\0]/.test(command.replace(/(^|[ \t])2>&1(?=$|[ \t|])/g, '$1'))) return null;
  const out = [];
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === ' ' || c === '\t') { i += 1; continue; }
    if (c === '|') { out.push({ pipe: true }); i += 1; continue; }
    if (command.startsWith('2>&1', i) && (i + 4 === command.length || ' \t|'.includes(command[i + 4]))) {
      out.push({ redirect: true });
      i += 4;
      continue;
    }
    let text = '';
    let quoted = false;
    let backslash = false;
    while (i < command.length && command[i] !== ' ' && command[i] !== '\t' && command[i] !== '|') {
      const q = command[i];
      if (q === "'" || q === '"') {
        const j = command.indexOf(q, i + 1);
        if (j === -1) return null;
        const part = command.slice(i + 1, j);
        // A part ending in a backslash means the closing `"` was escaped.
        if (q === '"' && /\\(["\\$`]|$)/.test(part)) return null;
        if (part.includes('\\')) backslash = true;
        text += part;
        quoted = true;
        i = j + 1;
        continue;
      }
      let k = i;
      while (k < command.length && !BREAK.has(command[k])) k += 1;
      const part = command.slice(i, k);
      if (!PLAIN.test(part)) return null;
      text += part;
      i = k;
    }
    if (/[\0-\x1f\x7f]/.test(text)) return null;
    out.push({ text, quoted, backslash });
  }
  return out;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

const real = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
};

// The number of leading words that invoke the harness, or 0.
function prefixLength(ws, cwd) {
  const bare = (w) => w && !w.pipe && !w.redirect && !w.quoted;
  if (bare(ws[0]) && ws[0].text === 'harness') return 1;
  if (bare(ws[0]) && ws[0].text === 'npx' && bare(ws[1]) && ws[1].text === 'github:hanbyeol/cc-harness') return 2;
  if (bare(ws[0]) && ws[0].text === 'node' && ws[1] && ws[1].text !== undefined) {
    const p = ws[1].text;
    if (!ws[1].quoted && (p === 'bin/harness.mjs' || p === './bin/harness.mjs')
      && readJsonFile(path.join(cwd, 'package.json'))?.name === 'cc-harness') return 2;
    if (SELF && real(path.resolve(cwd, p)) === SELF) return 2;
  }
  return 0;
}

// True when the pipe stage is one `tail -<n>`, `head -<n>` or `grep <word>`.
function filterStage(ws) {
  if (ws.length !== 2 || ws.some((w) => w.text === undefined) || ws[0].quoted) return false;
  const [cmd, arg] = [ws[0].text, ws[1].text];
  if (cmd === 'tail' || cmd === 'head') return !ws[1].quoted && /^-[0-9]{1,6}$/.test(arg);
  if (cmd === 'grep') return arg.length > 0 && !arg.startsWith('-') && /^[A-Za-z0-9_\-./=:,@%+ ]+$/.test(arg);
  return false;
}

/** True when the hook input's command may run without a permission prompt. */
export function allowed(input) {
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || !command.trim()) return false;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const ws = words(command);
  if (!ws) return false;
  // A backslash is allowed only in the path right after a bare `node` (a Windows path to SELF,
  // which prefixLength checks); anywhere else it is refused.
  if (ws.some((w, i) => w.backslash && !(i === 1 && !ws[0].quoted && ws[0].text === 'node'))) return false;
  const pipe = ws.findIndex((w) => w.pipe);
  const head = pipe === -1 ? ws : ws.slice(0, pipe);
  if (pipe !== -1 && !filterStage(ws.slice(pipe + 1))) return false;
  if (head.at(-1)?.redirect) head.pop();
  if (head.some((w) => w.pipe || w.redirect)) return false;
  const n = prefixLength(head, cwd);
  if (!n) return false;
  const sub = head[n];
  if (!sub || sub.quoted || !Object.hasOwn(USAGE, sub.text) || EXCLUDED.has(sub.text)) return false;
  const args = head.slice(n + 1).map((w) => w.text);
  if (sub.text === 'approve') {
    if (args.some((a) => a.startsWith('--extra-round'))) return false;
    const config = readJsonFile(path.join(cwd, '.harness', 'config.json'));
    if (!config || typeof config !== 'object' || config.approval !== 'auto') return false;
  }
  return true;
}

export default async function autoAllow({ out }) {
  try {
    if (process.stdin.isTTY) return 0;
    if (allowed(JSON.parse(fs.readFileSync(0, 'utf8')))) out(JSON.stringify(ALLOW));
  } catch {
    // Unreadable or invalid input: no decision, the normal permission flow applies.
  }
  return 0;
}
