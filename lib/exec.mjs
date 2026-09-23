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

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGKILL'); // negative pid = the whole process group
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * Run a command and never throw.
 * @param {string|{file:string,args:string[]}} command  string → run through the platform shell
 * @param {{cwd:string, timeoutSec?:number, envExtra?:string[], inheritEnv?:boolean, input?:string}} opts
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean, error:string|null}>}
 */
export function runCommand(command, { cwd, timeoutSec = 1800, envExtra = [], inheritEnv = false, input } = {}) {
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
    if (input !== undefined) child.stdin?.end(input); else child.stdin?.end();
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutSec * 1000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, error });
    });
  });
}

// Shell exit codes meaning "command not found" (POSIX sh 127, cmd.exe 9009).
export const isNotFound = (r) => r.error === 'ENOENT' || r.code === 127 || r.code === 9009;
