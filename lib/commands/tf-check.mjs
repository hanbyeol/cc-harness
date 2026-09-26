// `harness tf-check [--dir <path>]` — the iac profile's verify command (SPEC §4 profiles).
// Runs `terraform init -backend=false` and `terraform validate` in every directory that holds
// *.tf files, then `terraform fmt -check -recursive` once, with a shared provider cache.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand, isNotFound } from '../exec.mjs';
import { resolveInvocation } from '../adapters/common.mjs';
import { HarnessError } from '../errors.mjs';

// Directories never searched for modules: terraform's working data, harness state and worktrees.
const SKIP_DIRS = new Set(['.terraform', '.harness', '.git']);
const INIT_ERROR_CHARS = 300;
const NOT_FOUND_EXIT = 127;

/** <user cache dir>/cc-harness/terraform-plugins — where provider binaries are shared between runs. */
export function defaultPluginCacheDir({ env = process.env, platform = process.platform } = {}) {
  const home = (platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
  let base;
  if (platform === 'win32') base = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
  else if (platform === 'darwin') base = path.join(home, 'Library', 'Caches');
  else base = env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : path.join(home, '.cache');
  return (platform === 'win32' ? path.win32 : path).join(base, 'cc-harness', 'terraform-plugins');
}

function parseArgs(args) {
  let dir = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dir') {
      dir = args[++i];
      if (!dir) throw new HarnessError('--dir needs a path', { code: 'usage' });
    } else if (a.startsWith('--dir=')) {
      dir = a.slice('--dir='.length);
      if (!dir) throw new HarnessError('--dir needs a path', { code: 'usage' });
    } else {
      throw new HarnessError(`unknown argument '${a}'. Usage: harness tf-check [--dir <path>]`, { code: 'usage' });
    }
  }
  return { dir };
}

/** Directories under `top` (including it) that contain a *.tf file, sorted. Symlinked directories are not followed. */
function moduleDirs(top) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name.endsWith('.tf'))) found.push(dir);
    for (const e of entries.filter((x) => x.isDirectory() && !SKIP_DIRS.has(x.name)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      walk(path.join(dir, e.name));
    }
  };
  walk(top);
  return found;
}

// POSIX spawns the file directly, so ENOENT would only show up per call; look on PATH first so a
// missing terraform is reported once, before any directory is touched.
function terraformOnPath(env) {
  if (process.platform === 'win32') return resolveInvocation('terraform', [], { env }) !== null;
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    try {
      const file = path.join(dir, 'terraform');
      if (fs.statSync(file).isFile()) { fs.accessSync(file, fs.constants.X_OK); return true; }
    } catch { /* not in this directory */ }
  }
  return false;
}

export default async function tfCheck({ root, args, out, err }) {
  const { dir } = parseArgs(args);
  const top = dir ? path.resolve(root, dir) : root;
  if (!fs.existsSync(top) || !fs.statSync(top).isDirectory()) {
    throw new HarnessError(`--dir ${dir}: not a directory`, { code: 'usage' });
  }

  const env = { ...process.env };
  if (!env.TF_PLUGIN_CACHE_DIR) {
    const cache = defaultPluginCacheDir({ env });
    try {
      fs.mkdirSync(cache, { recursive: true });
      env.TF_PLUGIN_CACHE_DIR = cache;
    } catch (e) {
      err(`tf-check: cannot create provider cache ${cache} (${e.code || e.message}); providers are downloaded per directory`);
    }
  }

  const notFound = () => {
    err('command not found: terraform');
    return NOT_FOUND_EXIT;
  };
  if (!terraformOnPath(env)) return notFound();

  const terraform = (cwd, tfArgs) => {
    const inv = resolveInvocation('terraform', tfArgs, { env });
    return inv ? runCommand(inv, { cwd, env }) : Promise.resolve({ code: null, error: 'ENOENT', stdout: '', stderr: '' });
  };
  const rel = (d) => path.relative(root, d).split(path.sep).join('/') || '.';
  const tail = (r) => (r.stderr.trim() || r.stdout.trim());
  const failed = [];

  const dirs = moduleDirs(top);
  if (dirs.length === 0) out(`tf-check: no *.tf files under ${rel(top)}`);
  for (const d of dirs) {
    const name = rel(d);
    const init = await terraform(d, ['init', '-backend=false', '-input=false']);
    if (isNotFound(init)) return notFound();
    if (init.code !== 0) {
      err(`${name}: init failed: ${(tail(init) || (init.timedOut ? 'timed out' : `exit ${init.code}`)).slice(0, INIT_ERROR_CHARS)}`);
      failed.push(name);
      continue;
    }
    const validate = await terraform(d, ['validate']);
    if (isNotFound(validate)) return notFound();
    if (validate.code !== 0) {
      err(`${name}: validate failed: ${tail(validate) || (validate.timedOut ? 'timed out' : `exit ${validate.code}`)}`);
      failed.push(name);
    } else {
      out(`ok ${name}`);
    }
  }

  const fmt = await terraform(top, ['fmt', '-check', '-recursive']);
  if (isNotFound(fmt)) return notFound();
  if (fmt.code !== 0) {
    err(`fmt -check failed (${rel(top)}): ${tail(fmt) || (fmt.timedOut ? 'timed out' : `exit ${fmt.code}`)}`);
    failed.push('fmt');
  } else {
    out('ok fmt');
  }

  if (failed.length > 0) {
    err(`tf-check: failed: ${failed.join(', ')}`);
    return 1;
  }
  return 0;
}
