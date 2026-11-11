// `harness k8s-check [--dir <path>] [--ignore-missing-schemas] [--scan <name>]...` — the ops profile's
// verify command (SPEC §4 profiles). Validates Kubernetes manifests offline with `kubeconform -strict
// -summary`: plain *.yaml/*.yml files per directory, and the rendered output of every kustomization
// directory (`kustomize build`) and Helm chart directory (`helm template`); then runs each `--scan`
// policy scanner (trivy, checkov) on the checked directory.
import fs from 'node:fs';
import path from 'node:path';
import { runCommand, isNotFound } from '../exec.mjs';
import { resolveInvocation } from '../adapters/common.mjs';
import { HarnessError } from '../errors.mjs';

const USAGE = 'Usage: harness k8s-check [--dir <path>] [--ignore-missing-schemas] [--scan <name>]...';
const DEFAULT_DIR = 'k8s';
const SKIP_DIRS = new Set(['.git', '.harness']);
const KUSTOMIZATION_FILES = ['kustomization.yaml', 'kustomization.yml', 'Kustomization'];
const TAIL_CHARS = 2000;
const NOT_FOUND_EXIT = 127;

// The policy scanners `--scan <name>` may name, with the arguments each runs with for the
// checked directory (project-relative, run from the project root).
const SCANNERS = {
  trivy: (dir) => ['config', '--quiet', '--exit-code', '1', dir],
  checkov: (dir) => ['-d', dir, '--quiet', '--compact', '--framework', 'kubernetes', 'helm', 'kustomize'],
};
const SCANNER_NAMES = Object.keys(SCANNERS).join(', ');

function scanName(value) {
  if (!value) throw new HarnessError(`--scan needs a scanner name (one of: ${SCANNER_NAMES})`, { code: 'usage' });
  if (!Object.hasOwn(SCANNERS, value)) throw new HarnessError(`--scan ${value}: unknown scanner (one of: ${SCANNER_NAMES})`, { code: 'usage' });
  return value;
}

function parseArgs(args) {
  let dir = null;
  let ignoreMissingSchemas = false;
  const scans = [];
  const addScan = (name) => { if (!scans.includes(name)) scans.push(name); };
  const needPath = (v) => {
    if (!v) throw new HarnessError(`--dir needs a path. ${USAGE}`, { code: 'usage' });
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dir') dir = needPath(args[++i]);
    else if (a.startsWith('--dir=')) dir = needPath(a.slice('--dir='.length));
    else if (a === '--ignore-missing-schemas') ignoreMissingSchemas = true;
    else if (a === '--scan') addScan(scanName(args[++i]));
    else if (a.startsWith('--scan=')) addScan(scanName(a.slice('--scan='.length)));
    else throw new HarnessError(`unknown argument '${a}'. ${USAGE}`, { code: 'usage' });
  }
  return { dir: dir ?? DEFAULT_DIR, ignoreMissingSchemas, scans };
}

/**
 * The validation targets under `top` (including it), in walk order (names sorted):
 * { kind: 'kustomize' | 'helm', dir } for a render directory (not descended into), and
 * { kind: 'plain', dir, files } for a directory with *.yaml/*.yml files. Symlinked
 * directories are not followed (a Dirent of a symlink is not a directory).
 */
function targets(top) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    if (files.some((n) => KUSTOMIZATION_FILES.includes(n))) { found.push({ kind: 'kustomize', dir }); return; }
    if (files.includes('Chart.yaml')) { found.push({ kind: 'helm', dir }); return; }
    const yaml = files.filter((n) => /\.ya?ml$/.test(n));
    if (yaml.length) found.push({ kind: 'plain', dir, files: yaml.map((n) => path.join(dir, n)) });
    for (const e of entries) if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
  };
  walk(top);
  return found;
}

// POSIX spawns the file directly, so ENOENT would only show up per call; look on PATH first so a
// missing program is reported once, before anything runs.
function onPath(name, env) {
  if (process.platform === 'win32') return resolveInvocation(name, [], { env }) !== null;
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    try {
      const file = path.join(dir, name);
      if (fs.statSync(file).isFile()) { fs.accessSync(file, fs.constants.X_OK); return true; }
    } catch { /* not in this directory */ }
  }
  return false;
}

export default async function k8sCheck({ root, args, out, err }) {
  const { dir, ignoreMissingSchemas, scans } = parseArgs(args);
  const top = path.resolve(root, dir);
  if (!fs.existsSync(top) || !fs.statSync(top).isDirectory()) {
    throw new HarnessError(`${dir}: not a directory`, { code: 'usage' });
  }

  const env = { ...process.env };
  const found = targets(top);
  const needed = ['kubeconform'];
  if (found.some((t) => t.kind === 'kustomize')) needed.push('kustomize');
  if (found.some((t) => t.kind === 'helm')) needed.push('helm');
  needed.push(...scans);
  // Names the command's first program ('harness') on the same line, so a verify run still
  // judges the exit 127 as command not found (SPEC §6.1).
  const notFound = (name) => {
    err(`harness k8s-check: command not found: ${name}`);
    return NOT_FOUND_EXIT;
  };
  for (const name of needed) if (!onPath(name, env)) return notFound(name);

  const rel = (d) => path.relative(root, d).split(path.sep).join('/') || '.';
  const noScanners = () => { if (scans.length === 0) out('k8s-check: no policy scanners (--scan trivy|checkov)'); };
  if (found.length === 0) {
    // Nothing to check, so the scanners are not run either.
    out(`k8s-check: no manifests under ${rel(top)}`);
    noScanners();
    return 0;
  }

  const run = (bin, binArgs, input) => {
    const inv = resolveInvocation(bin, binArgs, { env });
    return inv ? runCommand(inv, { cwd: root, env, input }) : Promise.resolve({ code: null, error: 'ENOENT', stdout: '', stderr: '' });
  };
  const tail = (r, text) => {
    const s = (text.trim() || (r.timedOut ? 'timed out' : `exit ${r.code}`));
    return s.length > TAIL_CHARS ? s.slice(-TAIL_CHARS) : s;
  };
  const kubeconformArgs = ['-strict', '-summary', ...(ignoreMissingSchemas ? ['-ignore-missing-schemas'] : [])];
  // Paths handed to the tools are relative to the project root (their cwd), in OS spelling.
  const arg = (p) => path.relative(root, p) || '.';
  const failed = [];

  for (const t of found) {
    const name = rel(t.dir);
    let result;
    if (t.kind === 'plain') {
      result = await run('kubeconform', [...kubeconformArgs, ...t.files.map(arg)]);
    } else {
      const render = t.kind === 'kustomize'
        ? await run('kustomize', ['build', arg(t.dir)])
        : await run('helm', ['template', arg(t.dir)]);
      if (isNotFound(render)) return notFound(t.kind);
      if (render.code !== 0) {
        err(`${name}: render failed: ${tail(render, render.stderr.trim() || render.stdout)}`);
        failed.push(name);
        continue;
      }
      result = await run('kubeconform', [...kubeconformArgs, '-'], render.stdout);
    }
    if (isNotFound(result)) return notFound('kubeconform');
    if (result.code !== 0) {
      err(`${name}: kubeconform failed: ${tail(result, `${result.stdout}\n${result.stderr}`)}`);
      failed.push(name);
    } else {
      out(`ok ${name}`);
    }
  }

  // Policy scanners read the checked directory themselves, after all validation, even when it failed.
  noScanners();
  for (const s of scans) {
    const r = await run(s, SCANNERS[s](arg(top)));
    if (isNotFound(r)) return notFound(s);
    if (r.code !== 0) {
      err(`scan ${s} failed: ${tail(r, [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n'))}`);
      failed.push(`scan ${s}`);
    } else {
      out(`ok scan ${s}`);
    }
  }

  if (failed.length > 0) {
    err(`k8s-check: failed: ${failed.join(', ')}`);
    return 1;
  }
  return 0;
}
