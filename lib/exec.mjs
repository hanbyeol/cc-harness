import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HarnessError } from './errors.mjs';
import { escapeRe } from './util.mjs';

// Environment names always passed to commands the harness runs on the user's
// behalf (verify commands, criterion checks, repro). Secrets are not on this list;
// config.env_allowlist can add names. (SPEC SR-2)
export const BASE_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'TMP', 'TEMP', 'TMPDIR',
  'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'ComSpec', 'COMSPEC', 'WINDIR', 'APPDATA', 'LOCALAPPDATA',
  'CI', 'NODE_ENV',
  // Windows user and host names: in every home path, not secrets (F60 AC-1)
  'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'HOSTNAME', 'LOGONSERVER',
]);

export function filteredEnv(extra = [], source = process.env) {
  const allow = new Set([...BASE_ENV_ALLOWLIST, ...extra]);
  const env = {};
  for (const [k, v] of Object.entries(source)) if (allow.has(k)) env[k] = v;
  return env;
}

const MAX_OUTPUT = 1024 * 1024; // keep the last 1 MiB of each stream

// The signals on which `harness run` and `harness verify` stop the running step's process tree
// and save what they have (SPEC §8). Windows does not deliver SIGTERM, and SIGHUP there (a
// closed console) is out of scope.
export const STOP_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);

/** The POSIX process table as [pid, ppid] pairs (`ps`); empty when it cannot be read. */
export function processTable() {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0 || typeof r.stdout !== 'string') return [];
  return r.stdout.split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter((x) => x.length === 2 && x.every(Number.isInteger));
}

/** Every pid below `rootPid` in `table` ([pid, ppid] pairs), whatever process group or session it made. */
export function descendantPids(rootPid, table) {
  const children = new Map();
  for (const [pid, ppid] of table) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const out = [];
  const seen = new Set([rootPid]);
  for (let queue = [rootPid]; queue.length;) {
    for (const pid of children.get(queue.shift()) ?? []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      out.push(pid);
      queue.push(pid);
    }
  }
  return out;
}

/**
 * SIGKILLs every process below `rootPid`, including those that left its process group
 * (detached, setsid), which a group kill misses (SPEC §8). Only descendants of the step's own
 * process are touched. A table that cannot be read or a process that cannot be killed
 * (gone, not permitted) is skipped silently. Returns the pids it found.
 */
export function killDescendants(rootPid, { table = processTable, kill = process.kill.bind(process) } = {}) {
  let pids;
  try { pids = descendantPids(rootPid, table()); } catch { return []; }
  for (const pid of pids) {
    try { kill(pid, 'SIGKILL'); } catch { /* gone or not permitted */ }
  }
  return pids;
}

// Kills the command and everything it started. On POSIX the group is killed even
// when the top process already exited: a leftover background child can still hold
// the output pipes and would otherwise keep 'close' from ever firing. With `detached`,
// descendants in other process groups are found and killed first (the tree is read
// before the group kill reparents them).
function killTree(child, { detached = false } = {}) {
  if (detached && process.platform !== 'win32' && child.pid) killDescendants(child.pid);
  try {
    if (process.platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      }
    } else {
      process.kill(-child.pid, 'SIGKILL'); // negative pid = the whole process group
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  // Orphans that escaped the kill (Windows, setsid) must not hold our read ends open.
  child.stdout?.destroy();
  child.stderr?.destroy();
}

// After the top process exits, leftover background processes get this long to
// release the pipes before they are killed.
const EXIT_GRACE_MS = 2000;

/**
 * Run a command and never throw.
 * @param {string|{file:string,args:string[]}} command  string → run through the platform shell
 * `env` replaces the whole environment (the caller has already decided what the command sees).
 * `killDetached` (POSIX): on timeout or abort, also kill descendants that left the process group.
 * @param {{cwd:string, timeoutSec?:number, envExtra?:string[], inheritEnv?:boolean, env?:object, input?:string, killDetached?:boolean}} opts
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean, error:string|null}>}
 */
export function runCommand(command, { cwd, timeoutSec = 1800, envExtra = [], inheritEnv = false, env: fullEnv, input, signal, killDetached = false } = {}) {
  return new Promise((resolve) => {
    const isShell = typeof command === 'string';
    const env = fullEnv ?? (inheritEnv ? { ...process.env } : filteredEnv(envExtra));
    let child;
    try {
      child = isShell
        ? spawn(command, { cwd, env, shell: true, detached: process.platform !== 'win32', windowsHide: true })
        : spawn(command.file, command.args, { cwd, env, detached: process.platform !== 'win32', windowsHide: true });
    } catch (e) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, error: e.code || e.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let error = null;
    const cap = (s) => (s.length > MAX_OUTPUT ? s.slice(-MAX_OUTPUT) : s);
    child.stdout?.on('data', (d) => { stdout = cap(stdout + d); });
    child.stderr?.on('data', (d) => { stderr = cap(stderr + d); });
    child.on('error', (e) => { error = e.code || e.message; });
    // A child that exits without reading stdin makes a large write fail with EPIPE;
    // unhandled, that would crash the whole core. The exit status tells the story.
    child.stdin?.on('error', () => {});
    if (input !== undefined) child.stdin?.end(input); else child.stdin?.end();
    let exitCode = null;
    let exitSignal = null;
    let grace = null;
    const timer = setTimeout(() => { timedOut = true; killTree(child, { detached: killDetached }); }, timeoutSec * 1000);
    // An aborted run (SIGINT) must not leave the step's process tree behind.
    let aborted = false;
    const onAbort = () => { aborted = true; killTree(child, { detached: killDetached }); };
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    child.on('exit', (code, sig) => {
      exitCode = code;
      exitSignal = sig;
      grace = setTimeout(() => killTree(child), EXIT_GRACE_MS);
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener('abort', onAbort);
      // A background child that redirected its stdio doesn't hold our pipes, so
      // 'close' comes right after 'exit' — kill whatever is left in the group now.
      if (process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already empty */ }
      }
      // Report the top process's own exit status, not the status after cleanup.
      resolve({ code: exitCode ?? code, signal: exitSignal ?? sig, stdout, stderr, timedOut, aborted, error });
    });
  });
}

// Shell exit codes meaning "command not found" (POSIX sh 127, cmd.exe 9009). Run through
// `cmd /d /s /c` (Node's shell on Windows), a missing program exits 1 with this message
// instead; only the English wording is recognised, anything else stays a plain failure.
// The message must be cmd.exe's own: the first non-empty stderr line starts with
// '<program>' is not recognized — a tool that merely quotes the phrase is a real failure.
const WIN_NOT_FOUND = /^'[^'\r\n]+' is not recognized as an internal or external command/i;
const firstLine = (s) => String(s || '').split(/\r?\n/).find((l) => l.trim() !== '')?.trimStart() ?? '';
export const isNotFound = (r, platform = process.platform) => r.error === 'ENOENT' || r.code === 127 || r.code === 9009
  || (platform === 'win32' && r.code === 1 && WIN_NOT_FOUND.test(firstLine(r.stderr)));

// Words of a command line; a quoted part stays inside its word, quotes removed.
const words = (cmd) => (String(cmd ?? '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).map((w) => w.replace(/["']/g, ''));

/** The first program a command line runs: its first word after leading `NAME=value` assignments. */
export function firstProgram(cmd) {
  const w = words(cmd);
  let i = 0;
  while (i < w.length - 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) i += 1;
  return w[i] ?? '';
}

/**
 * The first program of each part of a command line chained with '&&', '||', ';' or '|'
 * (SPEC §6.1), in order and without repeats. Separators inside quotes do not split.
 */
export function commandPrograms(cmd) {
  const s = String(cmd ?? '');
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ';' || ch === '|' || (ch === '&' && s[i + 1] === '&')) {
      parts.push(cur);
      cur = '';
      if (s[i + 1] === ch || (ch === '|' && s[i + 1] === '&')) i += 1; // '&&', '||', ';;', '|&'
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return [...new Set(parts.map(firstProgram).filter(Boolean))];
}

/**
 * "Command not found" for a command line the user configured (SPEC §6.1): like isNotFound, but
 * an exit 127 counts only when one stderr line names the first program of one of the command's
 * chained parts ('&&', '||', ';', '|') together with 'not found' or 'No such file'. A script
 * that exits 127 itself, or whose inner tool is missing, is a plain failure. Exit 9009,
 * cmd.exe's message and ENOENT are judged as before.
 */
export function commandNotFound(cmd, r, platform = process.platform) {
  if (!isNotFound(r, platform)) return false;
  if (r.code !== 127 || r.error === 'ENOENT') return true;
  const progs = commandPrograms(cmd);
  if (progs.length === 0) return false;
  const named = new RegExp(`(?:^|[\\s:'"])(?:${progs.map(escapeRe).join('|')})(?=$|[\\s:'",])`);
  return String(r.stderr ?? '').split(/\r?\n/).some((l) => named.test(l) && (/not found/i.test(l) || l.includes('No such file')));
}

const HARNESS_BIN = fileURLToPath(new URL('../bin/harness.mjs', import.meta.url));
// A word the built-in path passes as is: nothing a shell would expand, quote, redirect or chain.
const PLAIN_WORD = /^[A-Za-z0-9_\-./:=@+,]+$/;

/**
 * The core's own invocation for a verify command or check that starts exactly with 'harness '
 * (SPEC §6.1): this checkout's bin/harness.mjs under the running node, as an argument array
 * without a shell, so no `harness` on PATH is needed. Null when any word is not a plain word
 * (`;`, `|`, `&`, `$`, quotes, redirections, `%`, `~`, …) — that command goes to the shell as is.
 */
export function builtinInvocation(cmd) {
  if (typeof cmd !== 'string' || !cmd.startsWith('harness ')) return null;
  const args = cmd.slice('harness '.length).split(' ').filter((w) => w !== '');
  if (args.length === 0 || !args.every((w) => PLAIN_WORD.test(w))) return null;
  return { file: process.execPath, args: [HARNESS_BIN, ...args] };
}

// A core git command that ran past budget.git_timeout_sec (its process tree is already
// killed by runCommand). `args` start at the git subcommand.
export function gitTimeoutError(args, timeoutSec) {
  const name = args[0] === 'worktree' && args[1] ? `worktree ${args[1]}` : args[0];
  return new HarnessError(`git ${name} timed out after ${timeoutSec}s (budget.git_timeout_sec)`, { code: 'git' });
}
