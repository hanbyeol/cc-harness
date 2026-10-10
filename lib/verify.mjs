import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HarnessError } from './errors.mjs';
import { DEFAULTS, availableCpus, isMaxParallel, gitTimeoutOf } from './config.mjs';
import { HARNESS_DIR, paths, readJson } from './state.mjs';
import { runCommand, isNotFound, commandNotFound, builtinInvocation, gitTimeoutError, firstProgram, filteredEnv } from './exec.mjs';
import { recordEvent, HARNESS_VERSION } from './events.mjs';
import { hashContract } from './contract.mjs';
import { VERIFY_CACHE, cacheKey, readVerifyCache, cachedResult, storable, storeResult } from './verify-cache.mjs';
import { isTestPath } from './glob.mjs';
import {
  getPreset, isPresetValue, fromIndex, parseSummaryCount, TEST_COUNT_CACHE, readCountCache, cachedEntry, cachedCount, storeCount,
  fillTree,
} from './testcount.mjs';
import { resolveInvocation } from './adapters/common.mjs';
import { failedTestNames, MAX_FLAKY_TESTS, redactDeep } from './failures.mjs';
import { partialRetry } from './retryfiles.mjs';
import { makeTempDir, removeTempDir, withNoHooksDir } from './tmp.mjs';

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
const same = (s) => String(s ?? '');

// Git settings that must not change how the diff is produced or run user code
// (external diff drivers, textconv, hooks, fsmonitor, relative paths, prefixes, colors). Hooks point at
// an empty directory made for each call and removed after it (SPEC §6).
const GIT_SAFE = ['-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.relative=false',
  '-c', 'color.ui=never', '-c', 'core.fsmonitor=false'];

async function git(args, { cwd, timeoutSec, signal, env }) {
  const r = await withNoHooksDir((hooks) => runCommand(
    { file: 'git', args: [...GIT_SAFE, '-c', `core.hooksPath=${hooks}`, ...args] }, { cwd, timeoutSec, signal, env }));
  if (r.error === 'ENOENT') throw new HarnessError('git is not installed or not on PATH', { code: 'git_missing' });
  if (r.timedOut) throw gitTimeoutError(args, timeoutSec);
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

// A verify command, check or test_count command: 'harness …' runs the core's own bin (§6.1).
const runUserCommand = (cmd, opts) => runCommand(builtinInvocation(cmd) ?? cmd, opts);

// Runs a shell command; a failure is re-run once and a changed outcome is flaky. A flaky
// command is a fail, except under verify.flaky 'retry' (the default): it runs a third time and
// passes when that run passes, the first run named its failing tests and none of them is the
// feature's own ('<featureId> …') — those must be stable (§6.1). Under 'retry' a first run that
// failed one of the feature's own tests, or named no failed test, is not re-run: no re-run can
// turn it into a pass, so the verdict is fail either way (retry_skipped).
// Under 'retry' the re-runs of a failed `node --test` command run only the files its first run
// located a failed test in (retry_files), unless verify.retry_scope is 'command'; the test
// count then comes from the first run, which ran every test.
async function runVerifyCommand(cmd, opts, redact = same, { featureId, flakyMode = 'retry', retryScope = 'failed_files' } = {}) {
  const started = performance.now();
  const ok = (r) => r.code === 0 && !r.timedOut && !r.error;
  const first = await runUserCommand(cmd, opts);
  const ok1 = ok(first);
  const entry = { cmd, code: first.code, pass: ok1, flaky: false, attempts: 1, timedOut: first.timedOut };
  let last = first;
  let latest = first;
  const firstOutput = `${first.stdout || ''}\n${first.stderr || ''}`;
  const all = ok1 ? [] : failedTestNames(firstOutput, Infinity);
  const own = typeof featureId === 'string' && all.some((n) => n.startsWith(`${featureId} `));
  if (!ok1 && flakyMode === 'retry' && (own || all.length === 0)) {
    entry.retry_skipped = own ? 'own_test' : 'no_test_names';
  } else if (!ok1) {
    const partial = flakyMode === 'retry'
      ? partialRetry(cmd, firstOutput, opts.cwd ?? process.cwd(), { scope: retryScope })
      : null;
    if (partial) entry.retry_files = partial.files;
    const again = partial ? partial.cmd : cmd;
    const second = await runUserCommand(again, opts);
    if (!partial) latest = second;
    const ok2 = ok(second);
    entry.attempts = 2;
    entry.flaky = ok1 !== ok2;
    entry.pass = false;
    last = second.code === 0 ? first : second;
    if (ok2) {
      // Failed first, passed on the re-run: the tests the first run reported as failing (§6.1).
      entry.flaky_tests = failedTestNames(firstOutput);
      if (flakyMode === 'retry' && all.length > 0 && !own) {
        const third = await runUserCommand(again, opts);
        if (!partial) latest = third;
        entry.attempts = 3;
        if (ok(third)) {
          entry.pass = true;
          entry.flaky_passed = true;
          entry.code = third.code;
        } else {
          last = third;
          entry.code = third.code;
          entry.timedOut = Boolean(first.timedOut || third.timedOut);
        }
      }
    }
  }
  if (!entry.pass) entry.message = describeFailure(cmd, last);
  // Redacted before the cut, so the cut never leaves a fragment of a secret (SR-8).
  if (!entry.pass) entry.output = tail(redact(last.stderr || last.stdout));
  if (!entry.pass && !last.timedOut && commandNotFound(cmd, last)) entry.notFound = missingProgram(cmd, last);
  // The most recent full run's output, for 'from:commands[i]'; not part of the result.
  Object.defineProperty(entry, 'run', { value: latest, enumerable: false });
  // Time of all attempts, for the verify/command event; not part of the result either.
  Object.defineProperty(entry, 'durationMs', { value: performance.now() - started, enumerable: false });
  return entry;
}

/**
 * The program a "command not found" result is about: the one the shell names in its message
 * (`sh: 1: jest: not found`, `bash: jest: command not found`, `zsh: command not found: jest`,
 * cmd.exe's `'jest' is not recognized …`) — a script inside the command may be what is
 * missing — else the command's first word.
 */
export function missingProgram(cmd, r) {
  for (const line of String(r?.stderr || '').split(/\r?\n/)) {
    const zsh = /command not found: (\S+)\s*$/.exec(line);
    if (zsh) return zsh[1];
    const win = /^'([^'\r\n]+)' is not recognized/.exec(line.trimStart());
    if (win) return win[1];
    if (/: (?:command )?not found\s*$/.test(line)) {
      const parts = line.split(': ');
      const name = parts.length >= 3 ? parts[parts.length - 2].trim() : '';
      if (name && !/\s/.test(name)) return name;
    }
  }
  return String(cmd).trim().split(/\s+/)[0];
}

function describeFailure(cmd, r) {
  if (r.timedOut) return `timed out — process tree killed`;
  if (commandNotFound(cmd, r)) return `command not found: ${missingProgram(cmd, r)}`;
  if (r.error) return `could not run: ${r.error}`;
  if (r.code === null) return `terminated by signal ${r.signal}`;
  return `exit ${r.code}`;
}

// Integer printed by the test_count command (last non-empty line of stdout), or the count
// a preset parses from its runner's output. A preset is a fixed executable with fixed
// arguments, spawned without a shell; its exit code is ignored (failing tests still count).
async function testCount(cmd, opts, redact = same) {
  if (isPresetValue(cmd)) return presetCount(getPreset(cmd), opts, redact);
  const r = await runUserCommand(cmd, opts);
  const line = redact((r.stdout || '').trim().split(/\r?\n/).pop()?.trim() ?? '');
  if (r.code !== 0 || r.timedOut || !/^\d+$/.test(line)) {
    if (!r.timedOut && commandNotFound(cmd, r)) return { count: null, error: describeFailure(cmd, r), notFound: missingProgram(cmd, r) };
    return { count: null, error: `${describeFailure(cmd, r)}${r.code === 0 && !r.timedOut ? ` (no integer on stdout: '${line.slice(0, 80)}')` : ''}` };
  }
  return { count: Number(line) };
}

// The count in a verify command's output (§6.2-3 'from:commands[i]'); `index` names the
// command in errors. The exit code is ignored: failing tests still count.
function summaryCount(r, index) {
  const what = `verify.commands[${index}]`;
  if (r.timedOut) return { count: null, error: `${what}: ${describeFailure(r.cmd, r)}` };
  if (commandNotFound(r.cmd, r)) return { count: null, error: `${what}: ${describeFailure(r.cmd, r)}`, notFound: missingProgram(r.cmd, r) };
  if (r.error || r.code === null) return { count: null, error: `${what}: ${describeFailure(r.cmd, r)}` };
  const count = parseSummaryCount(r.stdout || '');
  if (count === null) return { count: null, error: `no test count in output of ${what} (expected a '# tests N' or '\u2139 tests N' line)` };
  return { count };
}

async function presetCount(preset, opts, redact = same) {
  if (!preset) return { count: null, error: 'unknown preset' }; // config validation rejects these first
  const inv = resolveInvocation(preset.bin, [...preset.args]);
  if (!inv) return { count: null, error: `command not found: ${preset.bin}`, notFound: preset.bin };
  const r = await runCommand(inv, opts);
  if (!r.timedOut && commandNotFound(preset.bin, r)) return { count: null, error: describeFailure(preset.bin, r), notFound: preset.bin };
  if (r.timedOut || isNotFound(r) || r.error || r.code === null) return { count: null, error: describeFailure(preset.bin, r) };
  const count = preset.parse(r.stdout || '');
  if (count === null) {
    const last = redact((r.stdout || r.stderr || '').trim().split(/\r?\n/).pop()?.trim() ?? '');
    return { count: null, error: `no test count in output of ${preset.bin} (exit ${r.code}: '${last.slice(0, 80)}')` };
  }
  return { count };
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

// The test-count cache's tree keys of a commit (§6.2-3), from one listing of its tree:
// `tree`, a digest of everything outside the project's .harness/ (`harnessDir`, as from the top
// level) — shared by a commit that changed only .harness/ and its parent — and `test_tree`, a
// digest of the project's files matching verify.test_paths (outside .harness/) — shared by
// commits with the same test files — or null when test_paths is empty.
// Throws a HarnessError when git cannot list the tree.
async function treeKeys(sha, { harnessDir, projectRel, testPaths }, opts) {
  const out = await gitOk(['ls-tree', '-r', '-z', '--full-tree', sha], opts, 'git ls-tree failed');
  const pathOf = (rec) => rec.slice(rec.indexOf('\t') + 1);
  const kept = splitZ(out).filter((rec) => {
    const p = pathOf(rec);
    return p !== harnessDir && !p.startsWith(`${harnessDir}/`);
  });
  const digest = (recs) => createHash('sha256').update(recs.join('\0')).digest('hex');
  const prefix = projectRel ? `${projectRel}/` : '';
  const tests = testPaths.length === 0 ? null : kept.filter((rec) => {
    const p = pathOf(rec);
    return p.startsWith(prefix) && isTestPath(p.slice(prefix.length), testPaths);
  });
  return { tree: digest(kept), test_tree: tests && digest(tests) };
}

// The test-count cache key of verify.test_count for a merge-base (§6.2-3), or null when it is not
// set. Throws config_invalid when 'from:commands[i]' names a missing verify.commands entry.
function countCacheKey(tcCmd, cmds, mergeBase) {
  if (!tcCmd) return null;
  const fromI = fromIndex(tcCmd);
  if (fromI === null) return { base: mergeBase, command: tcCmd, rule: isPresetValue(tcCmd) ? 'preset' : 'stdout-integer' };
  if (typeof cmds[fromI] !== 'string') {
    throw new HarnessError(`verify.test_count '${tcCmd}' refers to a missing verify.commands entry`, { code: 'config_invalid' });
  }
  return { base: mergeBase, command: cmds[fromI], rule: 'summary' };
}

// The verify settings that are part of the result cache key (§6.4).
const CACHE_KEY_SETTINGS = ['commands', 'test_count', 'test_paths', 'skip_markers', 'flaky', 'retry_scope', 'check_parallel', 'vacuity_timeout_sec'];

// An ignored path that does not stop the result cache (§6.4): the core's records under the
// project's .harness/runs and .harness/events, and installed packages (any node_modules).
function cacheNeutral(p, harnessDir) {
  const n = p.replace(/\/$/, '');
  if ([`${harnessDir}/runs`, `${harnessDir}/events`].some((d) => n === d || n.startsWith(`${d}/`))) return true;
  return n.split('/').includes('node_modules');
}

// The working tree as a git tree (§6.4): tracked files and the untracked files git does not
// ignore, staged into a temporary index — the repository's own index is never written — with
// the project's .harness/runs and .harness/events left out. The temporary index is a copy of
// the worktree's own when there is one, so only changed files are hashed again; it is removed
// whatever happens. Throws a HarnessError (code 'git') when a git call fails.
async function workingTree(harnessDir, opts) {
  const dir = makeTempDir('harness-index-');
  try {
    const own = path.resolve(opts.cwd, (await gitOk(['rev-parse', '--git-path', 'index'], opts, 'git rev-parse failed')).trim());
    const index = path.join(dir, 'index');
    const iopts = { ...opts, env: { ...filteredEnv(), GIT_INDEX_FILE: index } };
    let copied = true;
    try { fs.copyFileSync(own, index); } catch { copied = false; }
    if (!copied) await gitOk(['read-tree', 'HEAD'], iopts, 'git read-tree failed');
    await gitOk(['add', '-A', '--', '.'], iopts, 'git add failed');
    await gitOk(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', `:(literal)${harnessDir}/runs`, `:(literal)${harnessDir}/events`],
      iopts, 'git rm failed');
    return (await gitOk(['write-tree'], iopts, 'git write-tree failed')).trim();
  } finally {
    removeTempDir(dir);
  }
}

/**
 * The result cache key of a verify (§6.4) as `{ key, tree }`, or `{ reason }` when the cache is
 * skipped: git ignores a file outside the core's records and node_modules (a result that passed
 * thanks to it must not stand for a merged tree without it, D1), or git could not give the
 * working tree — then `warning` says so too.
 */
async function resultCacheKey({ harnessDir, mergeBase, contract, config, envExtra }, opts) {
  try {
    // '!! <path>' entries: a directory an ignore pattern matches as `dir/`, other ignored files
    // one by one, also inside untracked directories. The repository's index is not refreshed.
    const status = await gitOk(['--no-optional-locks', 'status', '--porcelain', '-z', '--ignored=matching', '--untracked-files=all',
      '--ignore-submodules=all'], opts, 'git status failed');
    const ignored = splitZ(status).filter((rec) => rec.startsWith('!! ')).map((rec) => rec.slice(3)).filter((p) => !cacheNeutral(p, harnessDir));
    if (ignored.length > 0) {
      const more = ignored.length > 1 ? ` and ${ignored.length - 1} more` : '';
      return { reason: `ignored files outside .harness/runs, .harness/events and node_modules: ${ignored[0]}${more}` };
    }
    const tree = await workingTree(harnessDir, opts);
    const settings = Object.fromEntries(CACHE_KEY_SETTINGS.map((k) => [k, config.verify?.[k] ?? DEFAULTS.verify[k] ?? null]));
    const env = Object.entries(filteredEnv(envExtra)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const key = cacheKey({
      tree, merge_base: mergeBase, contract: hashContract(contract), verify: settings,
      node: process.version, platform: process.platform, harness: HARNESS_VERSION, env,
    });
    return { key, tree };
  } catch (e) {
    if (!(e instanceof HarnessError) || e.code !== 'git') throw e;
    const reason = `cannot compute the tree key (${e.message})`;
    return { reason, warning: `verify cache: ${reason} — not looked up or stored, everything runs` };
  }
}

// True when `p` is a protected .harness path, i.e. a change to it fails integrity (§6.2).
// The core's own records are exempt, matched exactly by path segment on git's '/' paths:
// `<dir>/verdicts/**`, `<dir>/backlog.json`, `<dir>/runs/**`, `<dir>/events/**`. Everything else under `dir`
// (config.json, contracts/**, features.json, any other path) stays protected.
// `dir` is the project's .harness location relative to the git top level
// ('.harness' normally, 'pkg/app/.harness' when the project is a monorepo subdirectory).
export function isHarnessPath(p, dir = HARNESS_DIR) {
  const n = p.replace(/\\/g, '/');
  if (n !== dir && !n.startsWith(`${dir}/`)) return false;
  const rest = n.slice(dir.length + 1);
  return !(rest === 'backlog.json' || rest.startsWith('verdicts/') || rest.startsWith('runs/') || rest.startsWith('events/'));
}

// Repo-relative paths (git's '/' form) of the feature's added or modified test files:
// under the project, matching verify.test_paths, and a regular file in the working tree.
// Deleted paths and symlinks are left out — base keeps its own version (§6.3).
function featureTestFiles(top, files, projectRel, testPaths) {
  const prefix = projectRel ? `${projectRel}/` : '';
  return [...new Set(files)].filter((f) => {
    if (prefix && !f.startsWith(prefix)) return false;
    if (!isTestPath(f.slice(prefix.length), testPaths)) return false;
    try { return fs.lstatSync(path.join(top, f)).isFile(); } catch { return false; }
  }).sort();
}

// A file name a test runner would likely pick up: *.test.*, *.spec.*, *_test.*, test_*.
const TEST_FILE_NAME = /\.test\.|\.spec\.|_test\.|^test_/;

// Project-relative paths of changed files named like tests but outside verify.test_paths:
// a base count taken from the test_tree cache could miss their tests (§6.2-3).
function testFilesOutsidePaths(files, { projectRel, harnessDir, testPaths }) {
  const prefix = projectRel ? `${projectRel}/` : '';
  return [...new Set(files)].filter((f) => {
    if ((prefix && !f.startsWith(prefix)) || f === harnessDir || f.startsWith(`${harnessDir}/`)) return false;
    const rel = f.slice(prefix.length);
    return TEST_FILE_NAME.test(rel.slice(rel.lastIndexOf('/') + 1)) && !isTestPath(rel, testPaths);
  }).map((f) => f.slice(prefix.length)).sort();
}

const ENTRY_RUNNERS = new Set(['node', 'bash', 'sh', 'python3']);

// The first command's words of a check, split the way a shell would on whitespace and quotes.
// Null when a quote is left open anywhere in the check, or a word holds characters the shell
// would expand or reinterpret — the check is then not understood and gets no entry rule.
function leadingWords(check) {
  const words = [];
  let word = null;
  let quote = null;
  for (const ch of check) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      word ??= '';
    } else if (/\s/.test(ch) || /[;&|<>()]/.test(ch)) {
      if (word !== null) words.push(word);
      word = null;
      if (!/\s/.test(ch) && words.length > 0) words.push(null); // end of the first command
    } else {
      word = (word ?? '') + ch;
    }
  }
  if (quote) return null;
  if (word !== null) words.push(word);
  const end = words.indexOf(null);
  return end === -1 ? words : words.slice(0, end);
}

/**
 * The repository file a check runs directly (SPEC §6.3): `node|bash|sh|python3 <path>` or
 * `./<path>`, as a normalized '/' path relative to where the check runs. Null when the check
 * has another shape, cannot be parsed, or the path is absolute (`/`, `C:`) or leaves the
 * repository through `..`.
 */
export function checkEntry(check) {
  if (typeof check !== 'string') return null;
  const words = leadingWords(check);
  if (!words || words.length === 0) return null;
  let p;
  if (ENTRY_RUNNERS.has(words[0])) p = words[1];
  else if (words[0].startsWith('./')) p = words[0];
  if (typeof p !== 'string' || p === '' || p.startsWith('-')) return null;
  if (/[$`*?[\]{}~%!]/.test(p)) return null;
  if (p.includes('\\')) {
    if (process.platform !== 'win32') return null; // an escape on POSIX shells, not a separator
    p = p.replace(/\\/g, '/');
  }
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  const n = path.posix.normalize(p);
  if (n === '.' || n === '..' || n.startsWith('../') || n.endsWith('/')) return null;
  return n;
}

// Writes each file's working-tree content into the base worktree at the same path.
// Nothing is written through a link: an existing symlink, file or directory in the way
// (the target itself or any parent) is removed first, and the file is created exclusively.
export function overlayFiles(top, baseDir, files) {
  for (const rel of files) {
    const parts = rel.split('/');
    let dir = baseDir;
    for (const seg of parts.slice(0, -1)) {
      dir = path.join(dir, seg);
      let st = null;
      try { st = fs.lstatSync(dir); } catch { /* missing */ }
      if (st && !st.isDirectory()) fs.rmSync(dir, { force: true });
      if (!st || !st.isDirectory()) fs.mkdirSync(dir);
    }
    const dest = path.join(dir, parts[parts.length - 1]);
    fs.rmSync(dest, { recursive: true, force: true });
    const src = path.join(top, rel);
    fs.writeFileSync(dest, fs.readFileSync(src), { flag: 'wx', mode: fs.statSync(src).mode & 0o777 });
  }
}

/** Criterion check concurrency (SPEC §6.3): an integer setting as is; 'auto' (or unset) is max(1, floor(cpus / 4)). */
export function checkParallelFor(setting, cpus) {
  if (isMaxParallel(setting)) return setting;
  return Math.max(1, Math.floor(Number(cpus) / 4) || 1);
}

// Runs at most `limit` commands at once, the rest in call order. Each result carries
// `overlapped`: whether another command of this pool was running at any point during it.
// `pool.alongside(fn)` runs fn at once, outside the limit, but still counts as running for
// `overlapped` — a check that ran alongside it is marked (a verify command, a test count).
function commandPool(limit) {
  let active = 0;
  const queue = [];
  const running = new Set();
  const enter = () => {
    const token = { overlapped: running.size > 0 };
    for (const t of running) t.overlapped = true;
    running.add(token);
    return token;
  };
  const next = () => {
    while (active < limit && queue.length > 0) {
      active += 1;
      queue.shift()();
    }
  };
  const pool = (fn) => new Promise((resolve, reject) => {
    queue.push(async () => {
      const token = enter();
      try {
        const r = await fn();
        resolve({ ...r, overlapped: token.overlapped });
      } catch (e) {
        reject(e);
      } finally {
        running.delete(token);
        active -= 1;
        next();
      }
    });
    next();
  });
  pool.alongside = async (fn) => {
    const token = enter();
    try {
      return await fn();
    } finally {
      running.delete(token);
    }
  };
  return pool;
}

// Like Promise.all, but waits for every promise to settle before rethrowing the first
// failure, so nothing is still running in the base worktree when it is removed.
async function settleAll(promises) {
  const results = await Promise.allSettled(promises);
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map((r) => r.value);
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
 * The current result of every criterion check in `cwd`, in contract order, for the builder
 * prompt of a continued or carried-over build (SPEC §8). Each check runs once, one at a time,
 * with verify's head limit (budget.step_timeout_sec, default 1800). A check that cannot start
 * or exits non-zero is 'fail'; one past the limit is 'timeout'. An aborted `signal` kills the
 * running check and starts no other. No output is kept.
 * @returns {Promise<{id:string, status:'pass'|'fail'|'timeout'}[]>}
 */
export async function criteriaStatus({ cwd, contract, config, signal, runCheck = runUserCommand }) {
  const timeoutSec = config?.budget?.step_timeout_sec ?? 1800;
  const envExtra = Array.isArray(config?.env_allowlist) ? config.env_allowlist : [];
  const out = [];
  for (const c of contractChecks(contract)) {
    if (signal?.aborted) break;
    const r = await runCheck(c.check, { cwd, timeoutSec, envExtra, signal });
    const status = r.timedOut ? 'timeout' : r.code === 0 && !r.error ? 'pass' : 'fail';
    out.push({ id: c.id, status });
  }
  return out;
}

/**
 * Deterministic verification of one feature (SPEC §6).
 * `cpus` is the CPU count behind verify.check_parallel 'auto'. `redact` (SR-8) is applied to
 * command output before it is cut to its end.
 * @returns {Promise<{pass:boolean, base:string, mergeBase:string, commands:object[], integrity:object, criteria:object[], warnings:string[], phases_ms:object, total_ms:number}>}
 */
const ms = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null);
const POST_MERGE = 'post_merge_verify';

// One verify/command event per verify.commands entry and one verify/check event per criterion
// (SPEC §2): time, result and whether it was re-run. The command itself is named by its first
// program only; its output is never recorded. One verify/phases event carries the time of each
// phase, and where the test counts came from — numbers and names only. One verify/cache event
// tells whether the result cache was used (§6.4).
function recordVerifyEvents(root, { featureId, round, step, commands, criteria, headRuns, config, redact, phases, cache }) {
  const opts = { config, redact: redact === same ? undefined : redact };
  const base = { feature: featureId, round };
  const at = step ? { step } : {};
  commands.forEach((c, index) => {
    // A command that is a lone NAME=value runs no program; its value is never recorded.
    const first = firstProgram(c.cmd);
    const program = /^[A-Za-z_][A-Za-z0-9_]*=/.test(first) ? null : first;
    recordEvent(root, { stage: 'verify', type: 'command', ...base, data: {
      ...at, index, program: program ? path.basename(program) : null, duration_ms: ms(c.durationMs), pass: c.pass,
      exit_code: Number.isInteger(c.code) ? c.code : null, attempts: c.attempts, flaky: c.flaky, timed_out: Boolean(c.timedOut),
      ...(c.flaky_passed ? { flaky_passed: true } : {}),
      ...(c.retry_skipped ? { retry_skipped: c.retry_skipped } : {}),
      ...(c.retry_files ? { retry_files: c.retry_files.length } : {}),
    } }, opts);
  });
  criteria.forEach((c, i) => {
    const h = headRuns[i] ?? {};
    recordEvent(root, { stage: 'verify', type: 'check', ...base, data: {
      ...at, id: c.id, duration_ms: ms(h.ms), pass: c.pass, exit_code: Number.isInteger(h.code) ? h.code : null,
      vacuous: Boolean(c.vacuous), parallel_retry: Boolean(c.parallel_retry), base_retry: Boolean(c.base_retry), timed_out: Boolean(c.timedOut),
      ...(step === POST_MERGE ? { vacuity_reused: Boolean(c.vacuity_reused) } : {}),
    } }, opts);
  });
  recordEvent(root, { stage: 'verify', type: 'phases', ...base, data: {
    step: step ?? null, total_ms: phases.total_ms, phases_ms: phases.phases_ms, test_count_source: phases.test_count_source,
  } }, opts);
  recordEvent(root, { stage: 'verify', type: 'cache', ...base, data: {
    step: step ?? null, status: cache.status, ...(cache.status === 'skipped' ? { reason: cache.reason } : {}),
  } }, opts);
}

export const VERIFY_PHASES = Object.freeze(['integrity', 'commands', 'test_count', 'checks', 'cleanup']);

// Wall-clock time of each verify phase (§6), in whole milliseconds from the start of verify.
// Each phase is the difference of two floored offsets, so the phases add up to total_ms exactly.
// Time while a head check runs is checks time, even when it overlaps the commands or the test
// count (check_parallel above 1 starts head checks with the verify commands).
function phaseClock() {
  const started = performance.now();
  let last = 0;
  let current = VERIFY_PHASES[0]; // the phase the time since `last` belongs to
  let checksRunning = 0;
  const phases_ms = Object.fromEntries(VERIFY_PHASES.map((p) => [p, 0]));
  const charge = (name) => {
    const at = Math.floor(performance.now() - started);
    phases_ms[checksRunning > 0 ? 'checks' : name] += Math.max(0, at - last);
    last = Math.max(last, at);
  };
  return {
    phases_ms,
    lap(name) {
      charge(name);
      current = VERIFY_PHASES[VERIFY_PHASES.indexOf(name) + 1] ?? name;
    },
    checkStarted() {
      charge(current);
      checksRunning += 1;
    },
    checkEnded() {
      charge(current);
      checksRunning -= 1;
    },
    total: () => Math.max(last, Math.floor(performance.now() - started)),
  };
}

/**
 * `round` and `step` ('verify', 'post_merge_verify') only label the verify events of a run.
 * `vacuityBase` is the base of the feature verify before a run's post-merge verify: when it is
 * the same commit as `base`, the vacuity runs of new criteria already ran there and are reused (§6.3).
 */
export async function verify({ root, cwd = root, featureId, base, config, signal, cpus = availableCpus(), redact = same, round, step, vacuityBase }) {
  const clock = phaseClock();
  if (!/^F\d+$/.test(featureId || '')) throw new HarnessError(`invalid feature id '${featureId}' (expected F<n>)`, { code: 'usage' });
  if (!base || typeof base !== 'string') throw new HarnessError('no base ref — pass --base or set base_branch', { code: 'usage' });
  if (base.startsWith('-')) throw new HarnessError(`invalid base ref '${base}'`, { code: 'usage' });
  const contract = readJson(paths(root).contract(featureId));
  const timeoutSec = config.budget?.step_timeout_sec ?? 1800;
  const envExtra = Array.isArray(config.env_allowlist) ? config.env_allowlist : [];
  const run = { cwd, timeoutSec, envExtra, signal }; // signal: an aborted run kills the running command (SPEC §8)
  // Base-side vacuity runs only need to show the criterion does not pass before the feature.
  // Their limit is max(verify.vacuity_timeout_sec, 3 × the head run's duration as measured by
  // the core), never above step_timeout_sec (§6.3): a check that is slow on head gets as long on base.
  const vacuitySec = config.verify?.vacuity_timeout_sec ?? DEFAULTS.verify.vacuity_timeout_sec;
  const baseLimitSec = (headMs) => Math.min(timeoutSec, Math.max(vacuitySec, Math.ceil((3 * headMs) / 100) / 10));
  // The core's own git calls have their own limit, independent of the user's commands (§6.3).
  const gitTimeoutSec = gitTimeoutOf(config);
  const gopts = { cwd, timeoutSec: gitTimeoutSec, signal };
  const warnings = [];

  if (!fs.existsSync(cwd)) throw new HarnessError(`worktree not found: ${cwd}`, { code: 'usage' });
  const top = (await gitOk(['rev-parse', '--show-toplevel'], gopts, `${cwd} is not a git worktree`)).trim();
  const baseSha = (await git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], gopts)).stdout.trim();
  if (!baseSha) throw new HarnessError(`base ref '${base}' not found in ${top} — create it or pass --base <ref>`, { code: 'base_missing' });
  const mergeBase = (await gitOk(['merge-base', baseSha, 'HEAD'], gopts, `no merge-base between '${base}' and HEAD`)).trim();
  // Only a run's post-merge verify reuses the feature verify's vacuity runs, and only when the
  // integration commit before the merge is the base that verify judged against (§6.3).
  const reuseVacuity = step === POST_MERGE && typeof vacuityBase === 'string' && /^[0-9a-f]{4,64}$/i.test(vacuityBase)
    && (await git(['rev-parse', '--verify', '--quiet', `${vacuityBase}^{commit}`], gopts)).stdout.trim() === baseSha;
  const topOpts = { cwd: top, timeoutSec: gitTimeoutSec, signal };
  // Where the project's .harness sits inside the repo; the same subpath applies in any worktree.
  const rootTop = (await gitOk(['rev-parse', '--show-toplevel'], { cwd: root, timeoutSec: gitTimeoutSec, signal }, `${root} is not a git worktree`)).trim();
  // realpathSync.native returns the on-disk letter case (macOS, Windows), so a root spelled in
  // another case still maps onto the paths git reports; plain realpathSync keeps the caller's case.
  const projectRel = path.relative(fs.realpathSync.native(rootTop), fs.realpathSync.native(root)).split(path.sep).join('/');
  const harnessDir = projectRel ? `${projectRel}/${HARNESS_DIR}` : HARNESS_DIR;
  const testPaths = config.verify?.test_paths || [];
  // The test-count cache's tree keys of a commit ({ tree, test_tree }), both null with a warning
  // when git cannot give them: the cache is then looked up and written by commit only (§6.2-3).
  // One warning per verify; each commit's keys (or their failure) are computed once per verify.
  let treeWarned = false;
  const treeMemo = new Map();
  const computeTrees = async (sha) => {
    try {
      return await treeKeys(sha, { harnessDir, projectRel, testPaths }, topOpts);
    } catch (e) {
      if (!(e instanceof HarnessError) || e.code !== 'git') throw e;
      if (!treeWarned) warnings.push(`test count cache: cannot compute the tree key of ${sha.slice(0, 12)} (${e.message}) — looked up by commit only`);
      treeWarned = true;
      return { tree: null, test_tree: null };
    }
  };
  const cacheTrees = (sha) => {
    if (!treeMemo.has(sha)) treeMemo.set(sha, computeTrees(sha));
    return treeMemo.get(sha);
  };
  // A passed post-merge verify counted head on the merged integration commit — the base of the
  // next feature apart from .harness/ records — so that count is cached under its keys (§6.2-3).
  const storeMergedCount = async (pass, testCount, countKey) => {
    if (step !== POST_MERGE || !pass || !countKey || testCount.message || !Number.isSafeInteger(testCount.head)) return;
    const headSha = (await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], gopts)).stdout.trim();
    if (!headSha) return;
    const w = storeCount(path.join(paths(root).runs, TEST_COUNT_CACHE), { ...countKey, base: headSha, ...await cacheTrees(headSha) }, testCount.head);
    if (w) warnings.push(w);
  };

  // --- result cache (§6.4): the passed result of a verify of the same inputs is returned as it
  // was stored, and nothing runs. The cache's own warnings are never part of a stored result.
  const cacheFile = path.join(paths(root).runs, VERIFY_CACHE);
  const cache = { status: (config.verify?.cache ?? DEFAULTS.verify.cache) === 'off' ? 'off' : 'miss' };
  let cacheKeyOf = null; // { key, tree } under which a passed result is stored
  const cacheWarnings = new Set();
  const cacheWarn = (w) => {
    warnings.push(w);
    cacheWarnings.add(w);
  };
  if (cache.status === 'miss') {
    const k = await resultCacheKey({ harnessDir, mergeBase, contract, config, envExtra }, topOpts);
    if (k.reason) {
      cache.status = 'skipped';
      cache.reason = k.reason;
      if (k.warning) cacheWarn(k.warning);
    } else {
      cacheKeyOf = k;
      const read = readVerifyCache(cacheFile);
      if (read.warning) cacheWarn(read.warning);
      const stored = cachedResult(read.entries, k.key);
      if (stored) {
        cache.status = 'hit';
        clock.lap('integrity');
        await storeMergedCount(true, stored.integrity.testCount, countCacheKey(config.verify?.test_count, config.verify?.commands || [], mergeBase));
        clock.lap('test_count');
        const phases = { total_ms: clock.total(), phases_ms: { ...clock.phases_ms }, test_count_source: null };
        recordVerifyEvents(root, { featureId, round, step, commands: [], criteria: [], headRuns: [], config, redact, phases, cache });
        return {
          ...stored, feature: featureId, base, mergeBase, cwd, warnings: [...new Set([...stored.warnings, ...warnings])],
          phases_ms: phases.phases_ms, total_ms: phases.total_ms, cache: { status: 'hit' },
        };
      }
    }
  }

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

  clock.lap('integrity');

  // --- verify.commands (§6.1)
  const cmds = config.verify?.commands || [];
  if (cmds.length === 0) warnings.push('verify.commands is empty — nothing but integrity and criteria was checked');
  const commands = [];
  const flakyMode = config.verify?.flaky ?? DEFAULTS.verify.flaky;
  const retryScope = config.verify?.retry_scope ?? DEFAULTS.verify.retry_scope;

  // --- base-side runs share one temporary detached worktree of the merge-base
  const checks = contractChecks(contract);
  const overlay = featureTestFiles(top, [...changedTracked, ...untracked], projectRel, testPaths);
  if (testPaths.length === 0 && checks.some((c) => c.new)) {
    warnings.push("verify.test_paths is empty — new criteria run on base without the feature's test files, so a test in a new file always counts as non-vacuous");
  }
  const tcCmd = config.verify?.test_count;
  const testCountResult = { base: null, head: null, status: 'unset' };
  const countKey = countCacheKey(tcCmd, cmds, mergeBase); // a passed post-merge verify stores head under it too
  const limit = checkParallelFor(config.verify?.check_parallel, cpus);
  const pool = commandPool(limit);
  const criteria = [];
  const headRuns = []; // criterion index → {ms, code} of its head run(s), for the verify/check event
  const baseDirs = [];
  const depLinks = [];
  // The working tree's node_modules, linked into a base worktree so a check that imports an
  // installed package does not fail on base for want of it (§6.3). A symbolic link (a
  // junction on Windows) inside the base worktree only; the working tree is not touched.
  // A link that cannot be made is a warning and the base runs without it.
  const deps = path.join(top, 'node_modules');
  const linkDependencies = (dir) => {
    let st;
    try { st = fs.statSync(deps); } catch { return; }
    if (!st.isDirectory()) return;
    const link = path.join(dir, 'node_modules');
    try {
      fs.symlinkSync(deps, link, 'junction');
      depLinks.push(link);
    } catch (e) {
      warnings.push(`could not link node_modules into the base worktree (${e.code || e.message}) — base runs without it`);
    }
  };
  let early = null; // the head checks started with the verify commands (limit above 1)
  let openCounted = () => {};
  try {
    const addBaseWorktree = async () => {
      const dir = makeTempDir('harness-base-');
      try {
        await gitOk(['worktree', 'add', '--detach', dir, mergeBase], topOpts, 'cannot create base worktree');
      } catch (e) {
        // Not a worktree: only the temporary directory is removed, the git error stands.
        removeTempDir(dir);
        throw e;
      }
      baseDirs.push(dir);
      linkDependencies(dir);
      return dir;
    };
    const placeOverlay = (dir, files) => {
      try {
        overlayFiles(top, dir, files);
      } catch (e) {
        throw new HarnessError(`cannot place the feature's test files on base: ${e.message}`, { code: 'io' });
      }
      return dir;
    };
    let basePromise = null;
    const ensureBase = () => (basePromise ??= addBaseWorktree());
    // Overlaid files the merge-base does not have, i.e. the feature created them. Read from
    // the base worktree before anything is placed on it.
    const newOnBase = new Set();
    // test_count compares against the untouched base; the feature's tests are placed on
    // base only afterwards, for the vacuity runs of new criteria (§6.3). Both steps below
    // finish before any base vacuity run starts.
    let overlayPromise = null;
    const ensureOverlaidBase = () => (overlayPromise ??= ensureBase().then((dir) => {
      for (const f of overlay) {
        try { fs.lstatSync(path.join(dir, f)); } catch { newOnBase.add(f); }
      }
      return placeOverlay(dir, overlay);
    }));
    // A check that directly runs a file the feature created (its entry script) is run on a
    // base worktree that has every overlaid file but that one: the entry is the feature
    // itself, not a test of it (§6.3). One worktree per distinct entry, made on first use.
    const entryBases = new Map();
    const withheldEntry = (c) => {
      const e = checkEntry(c.check);
      return e !== null && newOnBase.has(e) ? e : null;
    };
    const baseFor = async (c, entry) => {
      const shared = await ensureOverlaidBase();
      const e = withheldEntry(c);
      if (e === null) return shared;
      entry.base_entry = e;
      if (!entryBases.has(e)) entryBases.set(e, addBaseWorktree().then((dir) => placeOverlay(dir, overlay.filter((f) => f !== e))));
      return entryBases.get(e);
    };

    // --- contract checks (§6.3): at most `limit` head checks and base vacuity runs at a time.
    // With a limit above 1 the head checks start with the verify commands; base vacuity runs
    // wait for `counted`, the end of the test count (and so of the untouched base).
    const counted = new Promise((resolve) => { openCounted = resolve; });
    const ok = (r) => r.code === 0 && !r.timedOut && !r.error;
    const headEntry = (c, r) => {
      const entry = { id: c.id, check: c.check, pass: ok(r), vacuous: false };
      if (!entry.pass) entry.message = describeFailure(c.check, r);
      if (!entry.pass && !r.timedOut && commandNotFound(c.check, r)) entry.notFound = missingProgram(c.check, r);
      if (r.timedOut) entry.timedOut = true;
      return entry;
    };
    // The head run's duration is measured here, around the process, never read from its output.
    const timedRun = async (cmd, opts) => {
      clock.checkStarted();
      try {
        const started = performance.now();
        const r = await runUserCommand(cmd, opts);
        return { ...r, durationMs: performance.now() - started };
      } finally {
        clock.checkEnded();
      }
    };
    const baseRetry = new Map(); // criterion index → base limit in seconds
    const vacuity = async (c, entry, i, headMs) => {
      // false: the commands or the test count threw, and verify ends without base runs.
      if (!await counted) return;
      if (reuseVacuity) {
        entry.vacuity_reused = true;
        return;
      }
      const dir = await baseFor(c, entry);
      const limitSec = baseLimitSec(headMs);
      const b = await pool(() => runUserCommand(c.check, { ...run, cwd: dir, timeoutSec: limitSec }));
      // A base run that did not pass while other runs were active may have failed from
      // contention, which would hide a vacuous criterion: it is re-run alone below.
      if (b.overlapped && !ok(b)) {
        baseRetry.set(i, limitSec);
        return;
      }
      judgeBase(c, entry, b, limitSec);
    };
    const judgeBase = (c, entry, b, limitSec) => {
      // A base run past its limit did not pass on base: not vacuous, the head result stands.
      if (b.timedOut) {
        entry.base_timed_out = true;
        entry.base_timeout_sec = limitSec;
        warnings.push(`${c.id}: base vacuity run timed out after ${limitSec}s — judged by its head result; it would be vacuous if it passes on base more slowly`);
      } else if (commandNotFound(c.check, b) && !entry.base_entry) {
        // The base run could not start its program: vacuity is undecided and the environment,
        // not the feature, is at fault (§8 environment stop). A withheld entry script is
        // missing on base by design (`./tool.sh` exits 127): an ordinary base failure.
        entry.pass = false;
        entry.base_not_found = true;
        entry.notFound = missingProgram(c.check, b);
        entry.message = `command not found on base: ${entry.notFound}`;
      } else if (ok(b)) {
        entry.vacuous = true;
        entry.pass = false;
        entry.message = overlay.length > 0
          ? "vacuous: new criterion already passes on base with the feature's test files"
          : 'vacuous: new criterion already passes on base';
      }
    };
    const retry = new Set();
    const checkOne = async (c, i) => {
      const r = await pool(() => timedRun(c.check, run));
      headRuns[i] = { ms: r.durationMs, code: r.code };
      const entry = headEntry(c, r);
      criteria[i] = entry;
      // A failure while other runs were active may be contention; it is re-run alone below.
      // A timeout is final.
      if (!entry.pass && r.overlapped && !r.timedOut) retry.add(i);
      else if (entry.pass && c.new) await vacuity(c, entry, i, r.durationMs);
    };
    if (limit > 1) {
      early = settleAll(checks.map(checkOne));
      early.catch(() => {}); // awaited below, or in finally when a step before throws
    }

    // --- verify.commands (§6.1), one at a time; a head check running alongside one counts as
    // overlapped, so a failure there gets its solo re-run.
    for (const cmd of cmds) commands.push(await pool.alongside(() => runVerifyCommand(cmd, run, redact, { featureId, flakyMode, retryScope })));
    for (const c of commands) {
      if (c.flaky_passed) warnings.push(`flaky: passed on retry — ${redact(c.cmd)} (${redact(c.flaky_tests.join(', '))})`);
    }
    clock.lap('commands');

    if (tcCmd) {
      // 'from:commands[i]' reads head from the command already run above and runs the same
      // command once on base; other values run the count command on both sides.
      const fromI = fromIndex(tcCmd);
      const fromCmd = fromI === null ? null : cmds[fromI];
      const countHead = async () => (fromI !== null
        ? { ...summaryCount({ ...commands[fromI].run, cmd: fromCmd }, fromI), source: 'parsed' }
        : { ...await testCount(tcCmd, run, redact), source: 'ran' });
      const countCacheFile = path.join(paths(root).runs, TEST_COUNT_CACHE);
      const key = countKey;
      const countBase = async () => {
        const cache = readCountCache(countCacheFile);
        if (cache.warning) warnings.push(cache.warning);
        const hit = cachedEntry(cache.entries, key);
        if (hit) {
          // An entry stored before the tree key gets its commit's tree, so a later base that
          // changed only .harness/ finds it too; one that has a tree is not written again.
          if (typeof hit.tree !== 'string') {
            const w = fillTree(countCacheFile, key, (await cacheTrees(mergeBase)).tree);
            if (w) warnings.push(w);
          }
          return { count: hit.count, source: 'cache' };
        }
        // Not cached for this commit: the same tree outside .harness/ has the same tests, and
        // so — taking test_paths to hold every file the count depends on — do the same test files.
        Object.assign(key, await cacheTrees(mergeBase));
        const byTree = cachedCount(cache.entries, key, 'tree');
        const treeHit = byTree ?? cachedCount(cache.entries, key, 'test_tree');
        if (treeHit !== null) {
          if (byTree === null) {
            const outside = testFilesOutsidePaths([...changedTracked, ...untracked], { projectRel, harnessDir, testPaths });
            if (outside.length) warnings.push(`test file outside verify.test_paths: ${outside[0]}${outside.length > 1 ? ` (and ${outside.length - 1} more)` : ''}`);
          }
          return { count: treeHit, source: 'cache' };
        }
        const cwdBase = await ensureBase();
        const b = fromI !== null
          ? summaryCount({ ...await runUserCommand(fromCmd, { ...run, cwd: cwdBase }), cmd: fromCmd }, fromI)
          : await testCount(tcCmd, { ...run, cwd: cwdBase }, redact);
        if (!b.error) {
          const w = storeCount(countCacheFile, key, b.count);
          if (w) warnings.push(w);
        }
        return { ...b, source: 'ran' };
      };
      // check_parallel 1 keeps every run one at a time, head first.
      const [head, b] = limit > 1
        ? await settleAll([pool.alongside(countHead), pool.alongside(countBase)])
        : [await countHead(), await countBase()];
      testCountResult.head = head.count;
      testCountResult.base = b.count;
      testCountResult.source = { head: head.source, base: b.source };
      if (head.error || b.error) {
        testCountResult.status = 'error';
        testCountResult.message = [head.error && `head: ${head.error}`, b.error && `base: ${b.error}`].filter(Boolean).join('; ');
        if (head.notFound || b.notFound) testCountResult.notFound = head.notFound || b.notFound;
      } else {
        testCountResult.status = head.count < b.count ? 'decreased' : 'ok';
      }
    } else {
      warnings.push('verify.test_count is not set — test count decrease is not checked');
    }
    clock.lap('test_count');
    openCounted(true);

    if (early) await early;
    else for (const [i, c] of checks.entries()) await checkOne(c, i);

    // Solo re-checks start after every concurrent run has ended, one at a time.
    for (const [i, c] of checks.entries()) {
      if (!retry.has(i)) continue;
      const r = await timedRun(c.check, run);
      headRuns[i] = { ms: headRuns[i].ms + r.durationMs, code: r.code };
      const entry = headEntry(c, r);
      entry.parallel_retry = true;
      criteria[i] = entry;
      if (entry.pass) {
        warnings.push(`${c.id}: check failed while running concurrently and passed when re-run alone — it may depend on shared resources (set verify.check_parallel to 1 if so)`);
        if (c.new) await vacuity(c, entry, i, r.durationMs);
      }
    }
    // Solo base re-runs, after every concurrent run has ended; the solo result decides (§6.3).
    for (const [i, c] of checks.entries()) {
      if (!baseRetry.has(i)) continue;
      const entry = criteria[i];
      const dir = await baseFor(c, entry);
      entry.base_retry = true;
      const limitSec = baseRetry.get(i);
      judgeBase(c, entry, await runUserCommand(c.check, { ...run, cwd: dir, timeoutSec: limitSec }), limitSec);
    }
    clock.lap('checks');
  } finally {
    // A step that threw left head checks running: no base run starts, and they finish first.
    openCounted(false);
    if (early) await Promise.allSettled([early]);
    // Cleanup runs even when the verify was aborted (SIGINT): without the signal, so the
    // base worktree is unregistered too, not only its directory removed (SPEC §8).
    const cleanOpts = { ...topOpts, signal: undefined };
    // The links go first, so removing a worktree never descends into the working tree's
    // node_modules. One an overlay replaced with a directory is no longer a link: left alone.
    for (const link of depLinks) {
      try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link); } catch { /* removed with its worktree */ }
    }
    for (const dir of baseDirs) {
      try { await git(['worktree', 'remove', '--force', dir], cleanOpts); } catch { /* the directory goes below */ }
      removeTempDir(dir);
    }
    if (baseDirs.length > 0) { try { await git(['worktree', 'prune'], cleanOpts); } catch { /* best effort */ } }
  }
  clock.lap('cleanup');

  // A contract with nothing to check cannot vouch for anything — never a vacuous pass.
  if (checks.length === 0) warnings.push(`contract ${featureId} has no checks — verify fails`);
  const integrity = { markers, harnessPaths, testCount: testCountResult };
  const pass = commands.every((c) => c.pass)
    && markers.length === 0
    && harnessPaths.length === 0
    && (testCountResult.status === 'ok' || testCountResult.status === 'unset')
    && checks.length > 0
    && criteria.every((c) => c.pass);
  await storeMergedCount(pass, testCountResult, countKey);
  const flaky = [...new Set(commands.flatMap((c) => c.flaky_tests || []))].slice(0, MAX_FLAKY_TESTS);
  const phases_ms = { ...clock.phases_ms };
  const total_ms = clock.total();
  const phases = { total_ms, phases_ms, test_count_source: testCountResult.source ? { head: testCountResult.source.head, base: testCountResult.source.base } : null };
  recordVerifyEvents(root, { featureId, round, step, commands, criteria, headRuns, config, redact, phases, cache });
  const result = {
    pass, feature: featureId, base, mergeBase, cwd, commands, integrity, criteria, warnings, ...(flaky.length ? { flaky_tests: flaky } : {}),
    phases_ms: { ...phases_ms }, total_ms, cache,
  };
  // Only a clean pass is stored: no flaky retry, no timeout (§6.4). The stored copy goes through
  // the same redaction as the verify's output (SR-8).
  if (cacheKeyOf && storable(result)) {
    const { cache: _status, ...kept } = result;
    const w = storeResult(cacheFile, {
      key: cacheKeyOf.key, feature: featureId, merge_base: mergeBase, tree: cacheKeyOf.tree, stored_at: new Date().toISOString(),
      result: redactDeep({ ...kept, warnings: warnings.filter((x) => !cacheWarnings.has(x)) }, redact, undefined, { keys: false }),
    });
    if (w) warnings.push(w);
  }
  return result;
}
