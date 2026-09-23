import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HarnessError } from './errors.mjs';
import { HARNESS_DIR, paths, readJson } from './state.mjs';
import { runCommand, isNotFound } from './exec.mjs';

// Skip/focus markers that always fail verify when they appear on an added line.
// Fixed in code: config.verify.skip_markers can only ADD to this list (SPEC §6.2-1).
// Each marker is split at '|' so this file's own diff never contains a literal marker.
export const DEFAULT_SKIP_MARKERS = Object.freeze([
  '.sk|ip(', '.on|ly(', 'x|it(', 'x|describe(', '@pytest.mark.sk|ip', '@Dis|abled', 't.Sk|ip(', '@Ig|nore',
].map((m) => m.replace('|', '')));

const CRITERIA_KEYS = ['acceptance_criteria', 'security_criteria', 'error_scenarios'];
const TAIL = 2000; // characters of command output kept in the result

export function effectiveMarkers(config) {
  const extra = config?.verify?.skip_markers;
  const added = Array.isArray(extra) ? extra.filter((m) => typeof m === 'string' && m.length > 0) : [];
  return [...new Set([...DEFAULT_SKIP_MARKERS, ...added])];
}

const IDENT = /[A-Za-z0-9_$]/;

// Markers match as tokens: a marker that starts with an identifier character must
// not continue an identifier on its left, so a `process.exit` call is not the
// jasmine x-it marker and a LINQ `list.Skip` call is not Go's t-dot-Skip marker.
// Markers starting with punctuation are plain substring hits.
export function findMarker(text, marker) {
  const leading = IDENT.test(marker[0]);
  for (let i = text.indexOf(marker); i !== -1; i = text.indexOf(marker, i + 1)) {
    if (!leading || i === 0 || !IDENT.test(text[i - 1])) return true;
  }
  return false;
}

const tail = (s) => (s && s.length > TAIL ? s.slice(-TAIL) : s || '');

// Git settings that must not change how the diff is produced or run user code
// (external diff drivers, textconv, hooks, relative paths, prefixes, colors).
const GIT_SAFE = ['-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.relative=false',
  '-c', 'color.ui=never', '-c', `core.hooksPath=${path.join(os.tmpdir(), 'harness-no-hooks-dir')}`];

async function git(args, { cwd, timeoutSec, signal }) {
  const r = await runCommand({ file: 'git', args: [...GIT_SAFE, ...args] }, { cwd, timeoutSec, signal });
  if (r.error === 'ENOENT') throw new HarnessError('git is not installed or not on PATH', { code: 'git_missing' });
  return r;
}

async function gitOk(args, opts, what) {
  const r = await git(args, opts);
  if (r.code !== 0) {
    const cause = (r.stderr || r.stdout || r.error || (r.timedOut ? 'timed out' : `exit ${r.code}`)).trim();
    throw new HarnessError(`${what}: ${cause}`, { code: 'git' });
  }
  return r.stdout;
}

// Runs a shell command; a failure is re-run once and a changed outcome is flaky (still a fail).
async function runVerifyCommand(cmd, opts) {
  const first = await runCommand(cmd, opts);
  const ok1 = first.code === 0 && !first.timedOut && !first.error;
  const entry = { cmd, code: first.code, pass: ok1, flaky: false, attempts: 1, timedOut: first.timedOut };
  let last = first;
  if (!ok1) {
    const second = await runCommand(cmd, opts);
    const ok2 = second.code === 0 && !second.timedOut && !second.error;
    entry.attempts = 2;
    entry.flaky = ok1 !== ok2;
    entry.pass = false;
    last = second.code === 0 ? first : second;
  }
  if (!entry.pass) entry.message = describeFailure(cmd, last);
  if (!entry.pass) entry.output = tail(last.stderr || last.stdout);
  return entry;
}

function describeFailure(cmd, r) {
  if (r.timedOut) return `timed out — process tree killed`;
  if (isNotFound(r)) return `command not found: ${String(cmd).split(/\s+/)[0]}`;
  if (r.error) return `could not run: ${r.error}`;
  if (r.code === null) return `terminated by signal ${r.signal}`;
  return `exit ${r.code}`;
}

// Integer printed by the test_count command (last non-empty line of stdout).
async function testCount(cmd, opts) {
  const r = await runCommand(cmd, opts);
  const line = (r.stdout || '').trim().split(/\r?\n/).pop()?.trim() ?? '';
  if (r.code !== 0 || r.timedOut || !/^\d+$/.test(line)) {
    return { count: null, error: `${describeFailure(cmd, r)}${r.code === 0 && !r.timedOut ? ` (no integer on stdout: '${line.slice(0, 80)}')` : ''}` };
  }
  return { count: Number(line) };
}

// Parses `git diff --unified=0` output into added lines. Header lines (---/+++)
// only occur between `diff --git` and the first hunk of each file.
export function addedLines(patch) {
  const out = [];
  let file = null;
  let inHeader = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) { inHeader = true; file = null; continue; }
    if (inHeader) {
      if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '');
      else if (line.startsWith('@@')) inHeader = false;
      continue;
    }
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+')) out.push({ file, text: line.slice(1) });
  }
  return out;
}

function untrackedLines(top, rel) {
  const abs = path.join(top, rel);
  let st;
  try { st = fs.lstatSync(abs); } catch { return []; }
  if (!st.isFile()) return []; // symlinks, nested repos: content is not the file's own lines
  return fs.readFileSync(abs, 'utf8').split(/\r?\n/).map((text) => ({ file: rel, text }));
}

const splitZ = (s) => s.split('\0').filter(Boolean);

// `dir` is the project's .harness location relative to the git top level
// ('.harness' normally, 'pkg/app/.harness' when the project is a monorepo subdirectory).
export function isHarnessPath(p, dir = HARNESS_DIR) {
  const n = p.replace(/\\/g, '/');
  return n === dir || n.startsWith(`${dir}/`);
}

// Every criterion and enumerated case with a check, in contract order.
export function contractChecks(contract) {
  const list = [];
  for (const key of CRITERIA_KEYS) {
    for (const c of contract[key] || []) {
      if (c && typeof c.check === 'string') list.push({ id: c.id, check: c.check, new: c.new !== false });
      (c?.cases || []).forEach((k, i) => {
        if (k && typeof k.check === 'string') {
          list.push({ id: `${c.id}#${k.id ?? i + 1}`, check: k.check, new: (k.new ?? c.new) !== false });
        }
      });
    }
  }
  return list;
}

/**
 * Deterministic verification of one feature (SPEC §6).
 * @returns {Promise<{pass:boolean, base:string, mergeBase:string, commands:object[], integrity:object, criteria:object[], warnings:string[]}>}
 */
export async function verify({ root, cwd = root, featureId, base, config, signal }) {
  if (!/^F\d+$/.test(featureId || '')) throw new HarnessError(`invalid feature id '${featureId}' (expected F<n>)`, { code: 'usage' });
  if (!base || typeof base !== 'string') throw new HarnessError('no base ref — pass --base or set base_branch', { code: 'usage' });
  if (base.startsWith('-')) throw new HarnessError(`invalid base ref '${base}'`, { code: 'usage' });
  const contract = readJson(paths(root).contract(featureId));
  const timeoutSec = config.budget?.step_timeout_sec ?? 1800;
  const envExtra = Array.isArray(config.env_allowlist) ? config.env_allowlist : [];
  const run = { cwd, timeoutSec, envExtra, signal }; // signal: an aborted run kills the running command (SPEC §8)
  const gopts = { cwd, timeoutSec, signal };
  const warnings = [];

  if (!fs.existsSync(cwd)) throw new HarnessError(`worktree not found: ${cwd}`, { code: 'usage' });
  const top = (await gitOk(['rev-parse', '--show-toplevel'], gopts, `${cwd} is not a git worktree`)).trim();
  const baseSha = (await git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], gopts)).stdout.trim();
  if (!baseSha) throw new HarnessError(`base ref '${base}' not found in ${top} — create it or pass --base <ref>`, { code: 'base_missing' });
  const mergeBase = (await gitOk(['merge-base', baseSha, 'HEAD'], gopts, `no merge-base between '${base}' and HEAD`)).trim();
  const topOpts = { cwd: top, timeoutSec, signal };
  // Where the project's .harness sits inside the repo; the same subpath applies in any worktree.
  const rootTop = (await gitOk(['rev-parse', '--show-toplevel'], { cwd: root, timeoutSec, signal }, `${root} is not a git worktree`)).trim();
  const projectRel = path.relative(fs.realpathSync(rootTop), fs.realpathSync(root)).split(path.sep).join('/');
  const harnessDir = projectRel ? `${projectRel}/${HARNESS_DIR}` : HARNESS_DIR;

  // --- integrity (§6.2): computed before any command runs, so it reflects the builder's diff only
  const diffArgs = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/'];
  const changedTracked = splitZ(await gitOk([...diffArgs, '--name-only', '-z', mergeBase, '--'], topOpts, 'git diff failed'));
  const untracked = splitZ(await gitOk(['ls-files', '--others', '--exclude-standard', '-z', '--', '.'], topOpts, 'git ls-files failed'));
  const patch = await gitOk([...diffArgs, '--unified=0', '--text', mergeBase, '--'], topOpts, 'git diff failed');
  const lines = [...addedLines(patch), ...untracked.flatMap((f) => untrackedLines(top, f))];

  const markerList = effectiveMarkers(config);
  const markers = [];
  for (const { file, text } of lines) {
    for (const marker of markerList) {
      if (findMarker(text, marker)) markers.push({ file, marker, line: text.trim().slice(0, 200) });
    }
  }
  const harnessPaths = [...new Set([...changedTracked, ...untracked].filter((f) => isHarnessPath(f, harnessDir)))].sort();

  // --- verify.commands (§6.1)
  const cmds = config.verify?.commands || [];
  if (cmds.length === 0) warnings.push('verify.commands is empty — nothing but integrity and criteria was checked');
  const commands = [];
  for (const cmd of cmds) commands.push(await runVerifyCommand(cmd, run));

  // --- base-side runs share one temporary detached worktree of the merge-base
  const checks = contractChecks(contract);
  const tcCmd = config.verify?.test_count;
  const testCountResult = { base: null, head: null, status: 'unset' };
  const criteria = [];
  let baseDir = null;
  try {
    const ensureBase = async () => {
      if (baseDir) return baseDir;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-base-'));
      baseDir = dir;
      await gitOk(['worktree', 'add', '--detach', dir, mergeBase], topOpts, 'cannot create base worktree');
      return dir;
    };

    if (tcCmd) {
      const head = await testCount(tcCmd, run);
      const b = await testCount(tcCmd, { ...run, cwd: await ensureBase() });
      testCountResult.head = head.count;
      testCountResult.base = b.count;
      if (head.error || b.error) {
        testCountResult.status = 'error';
        testCountResult.message = [head.error && `head: ${head.error}`, b.error && `base: ${b.error}`].filter(Boolean).join('; ');
      } else {
        testCountResult.status = head.count < b.count ? 'decreased' : 'ok';
      }
    } else {
      warnings.push('verify.test_count is not set — test count decrease is not checked');
    }

    // --- contract checks (§6.3)
    for (const c of checks) {
      const r = await runCommand(c.check, run);
      const entry = { id: c.id, check: c.check, pass: r.code === 0 && !r.timedOut && !r.error, vacuous: false };
      if (!entry.pass) entry.message = describeFailure(c.check, r);
      if (entry.pass && c.new) {
        const b = await runCommand(c.check, { ...run, cwd: await ensureBase() });
        if (b.code === 0 && !b.timedOut && !b.error) {
          entry.vacuous = true;
          entry.pass = false;
          entry.message = 'vacuous: new criterion already passes on base';
        }
      }
      criteria.push(entry);
    }
  } finally {
    if (baseDir) {
      await git(['worktree', 'remove', '--force', baseDir], topOpts);
      try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch { /* best effort */ }
      await git(['worktree', 'prune'], topOpts);
    }
  }

  // A contract with nothing to check cannot vouch for anything — never a vacuous pass.
  if (checks.length === 0) warnings.push(`contract ${featureId} has no checks — verify fails`);
  const integrity = { markers, harnessPaths, testCount: testCountResult };
  const pass = commands.every((c) => c.pass)
    && markers.length === 0
    && harnessPaths.length === 0
    && (testCountResult.status === 'ok' || testCountResult.status === 'unset')
    && checks.length > 0
    && criteria.every((c) => c.pass);
  return { pass, feature: featureId, base, mergeBase, cwd, commands, integrity, criteria, warnings };
}
