import { spawn } from 'node:child_process';

// Environment names always passed to commands the harness runs on the user's
// behalf (verify commands, criterion checks, repro). Secrets are not on this list;
// config.env_allowlist can add names. (SPEC SR-2)
export const BASE_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'TMP', 'TEMP', 'TMPDIR',
  'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'ComSpec', 'COMSPEC', 'WINDIR', 'APPDATA', 'LOCALAPPDATA',
  'CI', 'NODE_ENV',
]);

export function filteredEnv(extra = [], source = process.env) {
  const allow = new Set([...BASE_ENV_ALLOWLIST, ...extra]);
  const env = {};
  for (const [k, v] of Object.entries(source)) if (allow.has(k)) env[k] = v;
  return env;
}

const MAX_OUTPUT = 1024 * 1024; // keep the last 1 MiB of each stream

// Kills the command and everything it started. On POSIX the group is killed even
// when the top process already exited: a leftover background child can still hold
// the output pipes and would otherwise keep 'close' from ever firing.
function killTree(child) {
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
 * @param {{cwd:string, timeoutSec?:number, envExtra?:string[], inheritEnv?:boolean, input?:string}} opts
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean, error:string|null}>}
 */
export function runCommand(command, { cwd, timeoutSec = 1800, envExtra = [], inheritEnv = false, input, signal } = {}) {
  return new Promise((resolve) => {
    const isShell = typeof command === 'string';
    const env = inheritEnv ? { ...process.env } : filteredEnv(envExtra);
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
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutSec * 1000);
    // An aborted run (SIGINT) must not leave the step's process tree behind.
    let aborted = false;
    const onAbort = () => { aborted = true; killTree(child); };
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

// Shell exit codes meaning "command not found" (POSIX sh 127, cmd.exe 9009).
export const isNotFound = (r) => r.error === 'ENOENT' || r.code === 127 || r.code === 9009;
