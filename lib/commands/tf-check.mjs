// `harness tf-check [--dir <path>] [--scan <name>]...` — the iac profile's verify command (SPEC §4 profiles).
// Runs `terraform init -backend=false` and `terraform validate` in every directory that holds
// *.tf files (then `terraform test` where it has *.tftest.hcl/json, itself or in tests/), then
// `terraform fmt -check -recursive` once, with a shared provider cache, then each `--scan` scanner.
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

// The policy scanners `--scan <name>` may name, with the arguments each runs with at the top dir.
const SCANNERS = {
  tflint: ['--recursive', '--no-color'],
  trivy: ['config', '--quiet', '--exit-code', '1', '.'],
  checkov: ['-d', '.', '--quiet', '--compact'],
};
const SCANNER_NAMES = Object.keys(SCANNERS).join(', ');
const OUTPUT_TAIL_CHARS = 2000;

function scanName(value) {
  if (!value) throw new HarnessError(`--scan needs a scanner name (one of: ${SCANNER_NAMES})`, { code: 'usage' });
  if (!Object.hasOwn(SCANNERS, value)) throw new HarnessError(`--scan ${value}: unknown scanner (one of: ${SCANNER_NAMES})`, { code: 'usage' });
  return value;
}

function parseArgs(args) {
  let dir = null;
  const scans = [];
  const addScan = (name) => { if (!scans.includes(name)) scans.push(name); };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--scan') {
      addScan(scanName(args[++i]));
    } else if (a.startsWith('--scan=')) {
      addScan(scanName(a.slice('--scan='.length)));
    } else if (a === '--dir') {
      dir = args[++i];
      if (!dir) throw new HarnessError('--dir needs a path', { code: 'usage' });
    } else if (a.startsWith('--dir=')) {
      dir = a.slice('--dir='.length);
      if (!dir) throw new HarnessError('--dir needs a path', { code: 'usage' });
    } else {
      throw new HarnessError(`unknown argument '${a}'. Usage: harness tf-check [--dir <path>] [--scan <name>]...`, { code: 'usage' });
    }
  }
  return { dir, scans };
}

/** Whether `dir` or its tests/ subdirectory holds a terraform test file (*.tftest.hcl, *.tftest.json). */
function hasTestFiles(dir) {
  return [dir, path.join(dir, 'tests')].some((d) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true })
        .some((e) => e.isFile() && (e.name.endsWith('.tftest.hcl') || e.name.endsWith('.tftest.json')));
    } catch { return false; }
  });
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
// missing terraform (or scanner) is reported once, before any directory is touched.
function onPath(program, env) {
  if (process.platform === 'win32') return resolveInvocation(program, [], { env }) !== null;
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    try {
      const file = path.join(dir, program);
      if (fs.statSync(file).isFile()) { fs.accessSync(file, fs.constants.X_OK); return true; }
    } catch { /* not in this directory */ }
  }
  return false;
}

export default async function tfCheck({ root, args, out, err }) {
  const { dir, scans } = parseArgs(args);
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

  // Names the command's first program ('harness') on the same line, so a verify run still
  // judges the exit 127 as command not found (SPEC §6.1).
  const notFound = (program = 'terraform') => {
    err(`harness tf-check: command not found: ${program}`);
    return NOT_FOUND_EXIT;
  };
  if (!onPath('terraform', env)) return notFound();
  for (const s of scans) if (!onPath(s, env)) return notFound(s);

  const run = (program, cwd, progArgs) => {
    const inv = resolveInvocation(program, progArgs, { env });
    return inv ? runCommand(inv, { cwd, env }) : Promise.resolve({ code: null, error: 'ENOENT', stdout: '', stderr: '' });
  };
  const terraform = (cwd, tfArgs) => run('terraform', cwd, tfArgs);
  const rel = (d) => path.relative(root, d).split(path.sep).join('/') || '.';
  const tail = (r) => (r.stderr.trim() || r.stdout.trim());
  // The end of everything a test run or scanner printed: findings come last, on either stream.
  const outputTail = (r) => {
    const text = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
    if (!text) return r.timedOut ? 'timed out' : `exit ${r.code}`;
    return text.length > OUTPUT_TAIL_CHARS ? `…${text.slice(-OUTPUT_TAIL_CHARS)}` : text;
  };
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
      continue;
    }
    out(`ok ${name}`);
    if (!hasTestFiles(d)) continue;
    const tests = await terraform(d, ['test', '-no-color']);
    if (isNotFound(tests)) return notFound();
    if (tests.code !== 0) {
      err(`${name}: test failed: ${outputTail(tests)}`);
      failed.push(`test ${name}`);
    } else {
      out(`ok test ${name}`);
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

  if (scans.length === 0) out('tf-check: no policy scanners (--scan tflint|trivy|checkov)');
  for (const s of scans) {
    const r = await run(s, top, SCANNERS[s]);
    if (isNotFound(r)) return notFound(s);
    if (r.code !== 0) {
      err(`scan ${s} failed: ${outputTail(r)}`);
      failed.push(`scan ${s}`);
    } else {
      out(`ok scan ${s}`);
    }
  }

  if (failed.length > 0) {
    err(`tf-check: failed: ${failed.join(', ')}`);
    return 1;
  }
  return 0;
}
