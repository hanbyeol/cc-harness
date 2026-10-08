// Independent evaluation and the core's verdict rules (SPEC §7, SR-3, SR-4, SR-6).
// The model only proposes scores and findings; everything that decides the verdict
// (schema, contract membership, repro re-run, min-of-5, thresholds) happens here.
import fs from 'node:fs';
import path from 'node:path';
import { HarnessError } from './errors.mjs';
import { paths, readJson, writeJsonAtomic, verdictRounds } from './state.mjs';
import { verifyFailures, redactor, redactDeep, MAX_FLAKY_TESTS } from './failures.mjs';
import { runCommand, isNotFound, gitTimeoutError } from './exec.mjs';
import { DEFAULTS, gitTimeoutOf } from './config.mjs';
import { verify, contractChecks } from './verify.mjs';
import { withNoHooksDir } from './tmp.mjs';
import { hashContract } from './contract.mjs';
import { matchesAnyGlob } from './glob.mjs';
import { usageOf } from './usage.mjs';
import { loadRolePrompt } from './roles.mjs';
import { getAdapter, resolveRole, roleCall, builderModels, independenceOf } from './adapters/index.mjs';
import { readBacklog, recordEntries, openItems, severityOf, SEVERITIES, PROMPT_LIMIT, PROMPT_SUMMARY_CHARS } from './backlog.mjs';
import { recordEvent } from './events.mjs';

export const DIMENSIONS = Object.freeze(['functionality', 'quality', 'security', 'errors', 'tests']);
export const CRITICAL_SECURITY_MIN = 7;
const CRITERIA_KEYS = ['acceptance_criteria', 'security_criteria', 'error_scenarios'];
const DIFF_LIMIT = 200_000; // characters of diff sent to the model
const UNTRACKED_LIMIT = 100_000; // bytes of one untracked file shown in the diff
const GIT_BATCH = 100; // paths per `git diff` call (Windows command-line length)
const EVENT_SUMMARY_CHARS = 300; // of a finding summary in its event
const EVENT_ID_CHARS = 100; // of a reviewer-given criterion id or dimension in an event
const EVENT_TEXT_CHARS = 200; // of one schema problem in a re-ask event
// Backlog reason → finding event reason (SPEC §7.8).
const EVENT_REASONS = Object.freeze({
  missing_criterion_id: 'no_criterion',
  criterion_not_in_contract: 'not_in_contract',
  missing_repro: 'no_repro',
  repro_denied: 'repro_denied',
  adversarial_scenario: 'adversarial',
  repro_timeout: 'repro_timeout',
  repro_not_runnable: 'repro_not_runnable',
  repro_not_reproduced: 'not_reproduced',
  out_of_scope: 'out_of_scope',
});

// §7.2 output schema, passed to adapters that support structured output.
export const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['scores', 'findings', 'out_of_scope'],
  properties: {
    scores: {
      type: 'object',
      required: [...DIMENSIONS],
      properties: Object.fromEntries(DIMENSIONS.map((d) => [d, { type: 'integer', minimum: 0, maximum: 10 }])),
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['criterion_id', 'dimension', 'summary', 'repro'],
        properties: {
          criterion_id: { type: 'string' },
          dimension: { type: 'string', enum: [...DIMENSIONS] },
          summary: { type: 'string' },
          repro: { type: 'string' },
          severity: { type: 'string', enum: [...SEVERITIES] },
          backlog_id: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer', minimum: 1 },
        },
      },
    },
    out_of_scope: {
      type: 'array',
      items: {
        type: 'object',
        required: ['summary'],
        properties: {
          summary: { type: 'string' }, severity: { type: 'string', enum: [...SEVERITIES] }, backlog_id: { type: 'string' },
          file: { type: 'string' }, line: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
});

// ------------------------------------------------------------------ schema check

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const optString = (v) => v === undefined || v === null || typeof v === 'string';

/**
 * Checks a model reply against §7.2. Only what the core relies on is required:
 * a missing criterion_id or repro is not a schema error — it makes the finding
 * non-blocking (§7.3).
 * @returns {string[]} problems; empty = valid
 */
export function validateOutput(json) {
  const errs = [];
  if (!isObj(json)) return ['reply is not a JSON object'];
  if (!isObj(json.scores)) errs.push('scores: missing or not an object');
  else {
    for (const d of DIMENSIONS) {
      const v = json.scores[d];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10) errs.push(`scores.${d}: expected a number 0-10`);
    }
  }
  if (!Array.isArray(json.findings)) errs.push('findings: missing or not an array');
  else {
    json.findings.forEach((f, i) => {
      if (!isObj(f)) { errs.push(`findings[${i}]: not an object`); return; }
      if (typeof f.summary !== 'string' || !f.summary.trim()) errs.push(`findings[${i}].summary: expected a non-empty string`);
      for (const k of ['criterion_id', 'dimension', 'repro']) if (!optString(f[k])) errs.push(`findings[${i}].${k}: expected a string`);
    });
  }
  if (json.out_of_scope !== undefined) {
    if (!Array.isArray(json.out_of_scope)) errs.push('out_of_scope: not an array');
    else {
      json.out_of_scope.forEach((o, i) => {
        if (!isObj(o) || typeof o.summary !== 'string') errs.push(`out_of_scope[${i}].summary: expected a string`);
      });
    }
  }
  return errs;
}

// ------------------------------------------------------------------ SR-3 deny patterns

const SEGMENT_SPLIT = /\|\||&&|\$\(|<\(|[;&|\n\r()`]/;
// Shell quote removal: quotes may sit mid-token, e.g. "$HOME"/* (the shellcheck-recommended spelling).
const unquote = (t) => t.replace(/['"]/g, '');
const tokens = (seg) => seg.split(/\s+/).map(unquote).filter(Boolean);
const cmdName = (t) => t.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
const segments = (cmd) => cmd.split(SEGMENT_SPLIT).map((s) => s.trim()).filter(Boolean);

function isGitPush(seg) {
  const t = tokens(seg);
  const g = t.findIndex((x) => cmdName(x) === 'git');
  return g !== -1 && t.slice(g + 1).includes('push');
}

const ROOT_TARGET = /^\/+\.?\*?$/;
const HOME_TARGET = /^(~|\$HOME|\$\{HOME\}|%USERPROFILE%)[\\/]?\*?$/i;

// rm with a recursive flag aimed at / or ~ (force or not — both are the same accident).
function rmRecursiveTarget(seg, target) {
  const t = tokens(seg);
  const r = t.findIndex((x) => cmdName(x) === 'rm');
  if (r === -1) return false;
  let recursive = false;
  let hit = false;
  for (const a of t.slice(r + 1)) {
    if (a === '--recursive') recursive = true;
    else if (/^-[A-Za-z]+$/.test(a) && /[rR]/.test(a)) recursive = true;
    else if (!a.startsWith('-') && target.test(a)) hit = true;
  }
  return recursive && hit;
}

const SHELLS = String.raw`(?:\S*[\\/])?(?:ba|z|da|k|fi|tc|c)?sh\b`;
const PIPE_TO_SHELL = new RegExp(String.raw`\b(?:curl|wget)\b[^\n]*?\|\s*(?:sudo\s+)?(?:env\s+)?${SHELLS}`, 'i');
const SHELL_OF_DOWNLOAD = new RegExp(String.raw`(?:^|[\s;&|(])${SHELLS}[^\n]*(?:\$\(|<\(|\`)\s*(?:curl|wget)\b`, 'i');

// [name, test(cmd)] — SPEC SR-3's five patterns. A match means the repro is never run.
export const DENY_PATTERNS = Object.freeze([
  ['git push', (cmd) => segments(cmd).some(isGitPush)],
  ['rm -rf /', (cmd) => segments(cmd).some((s) => rmRecursiveTarget(s, ROOT_TARGET))],
  ['rm -rf ~', (cmd) => segments(cmd).some((s) => rmRecursiveTarget(s, HOME_TARGET))],
  ['curl | sh', (cmd) => PIPE_TO_SHELL.test(cmd) || SHELL_OF_DOWNLOAD.test(cmd)],
  ['sudo', (cmd) => segments(cmd).some((s) => tokens(s).some((x) => cmdName(x) === 'sudo'))],
]);

/** @returns {string|null} the name of the first deny pattern the command matches */
export function deniedPattern(cmd) {
  if (typeof cmd !== 'string') return null;
  // The shell removes backslash-newline (line continuation) before it splits words, so
  // `git \<newline>push` runs `git push`; judge the command the shell will actually run.
  const joined = cmd.replace(/\\\r?\n/g, '');
  for (const [name, test] of DENY_PATTERNS) if (test(joined)) return name;
  return null;
}

// D1 threat boundary (§7.3): a repro that needs deliberate manipulation of git internals
// or configuration describes an adversarial scenario — out of scope even when it fails.
// Not running it also keeps the worktree's git state untouched.
const ADVERSARIAL = Object.freeze([
  ['index flag', /\bupdate-index\b[^\n]*--(?:no-)?(?:skip-worktree|assume-unchanged)/i],
  ['replace ref', /\bgit\b(?:\s+-[cC]\s+\S+)*\s+replace\b|refs\/replace\//i],
  ['clean/smudge filter', /\bfilter\.[^\s.=]+\.(?:clean|smudge|process)\b/i],
  ['hooks', /core\.hookspath|\.git[\\/]hooks\b/i],
  ['git config', /\bgit\b(?:\s+-[cC]\s+\S+)*\s+config\b|\.git[\\/](?:config|info)\b/i],
]);

export function adversarialPattern(cmd) {
  if (typeof cmd !== 'string') return null;
  for (const [name, re] of ADVERSARIAL) if (re.test(cmd)) return name;
  return null;
}

/**
 * The first program name of a repro command (leading VAR=value assignments skipped, directory
 * and .exe removed, lower case): all a finding event keeps of the command (F56 SC-1).
 */
export function reproProgram(cmd) {
  if (typeof cmd !== 'string') return null;
  const [first] = segments(cmd.replace(/\\\r?\n/g, ''));
  // Words with their quoted parts kept together: `B="x y" prog` is one assignment, then prog.
  const words = (first ?? '').match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? [];
  const name = words.map(unquote).find((t) => t && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  return name ? cmdName(name) || null : null;
}

// ------------------------------------------------------------------ SR-4 secret paths

const DEFAULT_SECRET = [/^\.env/i, /\.pem$/i, /\.key$/i, /^id_/i, /\.p12$/i];

/**
 * True when a repo-relative path must not reach a model prompt (SR-4).
 * Default patterns apply to every path segment (a `.env.d/` directory hides its files);
 * a secret_glob without '/' matches any segment, with '/' the whole path.
 */
export function isSecretPath(p, secretGlobs = []) {
  const norm = String(p).replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  if (parts.some((seg) => DEFAULT_SECRET.some((re) => re.test(seg)))) return true;
  return matchesAnyGlob(norm, secretGlobs);
}

// ------------------------------------------------------------------ finding location (F75)

export const MAX_LOCATION_FILE = 512;
// eslint-disable-next-line no-control-regex
const LOCATION_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * The optional { file, line } of a finding or out_of_scope entry, or {} (SPEC §7.2).
 * file must be a non-empty project-relative path of at most 512 characters: no absolute path
 * (/x, \x, C:x), no '..' segment, no control character, not a secret path (SR-4). line is kept
 * only with a valid file and when it is an integer ≥ 1. An invalid value never drops the finding.
 */
export function locationOf(f, secretGlobs = []) {
  const file = f?.file;
  if (typeof file !== 'string' || !file || file.length > MAX_LOCATION_FILE) return {};
  if (LOCATION_CONTROL.test(file) || /^[\\/]/.test(file) || /^[A-Za-z]:/.test(file)) return {};
  if (file.split(/[\\/]/).includes('..')) return {};
  if (isSecretPath(file, secretGlobs)) return {};
  return { file, ...(Number.isInteger(f.line) && f.line >= 1 ? { line: f.line } : {}) };
}

// ------------------------------------------------------------------ git diff (SR-4)

// Same hardening as verify: no external diff/textconv, no hooks (a fresh empty hooksPath per
// call), no fsmonitor, fixed prefixes.
const GIT_SAFE = ['-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.relative=false',
  '-c', 'color.ui=never', '-c', 'core.fsmonitor=false',
  // 0 = no limit: past diff.renameLimit (default 1000 paths) git silently reports a secret's
  // edited rename as a plain add, and its content would reach the eval diff (F9 AC-3).
  '-c', 'diff.renameLimit=0'];
const DIFF_ARGS = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/'];
const splitZ = (s) => s.split('\0').filter(Boolean);

async function git(args, opts) {
  const r = await withNoHooksDir((hooks) => runCommand(
    { file: 'git', args: [...GIT_SAFE, '-c', `core.hooksPath=${hooks}`, ...args] }, opts));
  // A git call killed by the run's abort is an interruption, not a git failure (SPEC §8).
  if (r.aborted || opts?.signal?.aborted) throw new HarnessError('evaluation interrupted', { code: 'interrupted' });
  if (r.error === 'ENOENT') throw new HarnessError('git is not installed or not on PATH', { code: 'git_missing' });
  if (r.timedOut) throw gitTimeoutError(args, opts.timeoutSec);
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

function untrackedDiff(top, rel) {
  let st;
  try { st = fs.lstatSync(path.join(top, rel)); } catch { return ''; }
  const head = `diff --git a/${rel} b/${rel}\nnew file (untracked)\n`;
  if (!st.isFile()) return `${head}(not a regular file — omitted)\n`;
  if (st.size > UNTRACKED_LIMIT) return `${head}(${st.size} bytes — omitted)\n`;
  const buf = fs.readFileSync(path.join(top, rel));
  if (buf.includes(0)) return `${head}Binary file — omitted\n`;
  const lines = buf.toString('utf8').replace(/\r?\n$/, '').split(/\r?\n/);
  return `${head}--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
}

// `git ls-tree -r -z` / `git ls-files -s -z` records → Map(path → blob id)
function blobMap(out, re) {
  const m = new Map();
  for (const rec of splitZ(out)) {
    const r = re.exec(rec);
    if (r) m.set(r[2], r[1]);
  }
  return m;
}
const LS_TREE = /^\d+ blob ([0-9a-f]+)\t([\s\S]+)$/;
const LS_FILES = /^\d+ ([0-9a-f]+) \d\t([\s\S]+)$/;

// Blob ids of the working-tree files `rels` (regular files only), hashed both with and
// without the repo's filters so either form of a stored blob matches. Map(path → Set(id)).
async function hashWorktree(top, rels, o) {
  const files = rels.filter((rel) => {
    try { return fs.lstatSync(path.join(top, rel)).isFile(); } catch { return false; }
  });
  const ids = new Map(files.map((f) => [f, new Set()]));
  for (const mode of [[], ['--no-filters']]) {
    for (let i = 0; i < files.length; i += GIT_BATCH) {
      const batch = files.slice(i, i + GIT_BATCH);
      const out = (await gitOk(['hash-object', ...mode, '--', ...batch], o, 'git hash-object failed')).split(/\r?\n/).filter(Boolean);
      batch.forEach((f, k) => { if (out[k]) ids.get(f).add(out[k]); });
    }
  }
  return ids;
}

/**
 * SR-4 content rule: non-secret paths that carry a secret file's content — a rename,
 * a move outside git, a copy, or a rename with an edit that git still detects (≥50%).
 * Secret contents = blobs at secret paths in the merge-base, HEAD, the index and the
 * working tree. The empty blob never counts (an empty secret says nothing).
 * @returns {Promise<Set<string>>} paths to drop from the diff
 */
async function secretCopies({ top, mergeBase, tracked, untracked, isSecret }, o) {
  const drop = new Set();
  const candTracked = tracked.filter((f) => !isSecret(f));
  const candUntracked = untracked.filter((f) => !isSecret(f));
  if (candTracked.length + candUntracked.length === 0) return drop;

  const empty = (await gitOk(['hash-object', '--stdin'], { ...o, input: '' }, 'git hash-object failed')).trim();
  const baseTree = blobMap(await gitOk(['ls-tree', '-r', '-z', '--full-tree', mergeBase], o, 'git ls-tree failed'), LS_TREE);
  const headTree = blobMap(await gitOk(['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], o, 'git ls-tree failed'), LS_TREE);
  const index = blobMap(await gitOk(['ls-files', '-s', '-z'], o, 'git ls-files failed'), LS_FILES);

  const secretIds = new Set();
  for (const m of [baseTree, headTree, index]) for (const [p, id] of m) if (isSecret(p)) secretIds.add(id);
  const secretFiles = [...new Set([...index.keys(), ...untracked])].filter(isSecret);
  for (const set of (await hashWorktree(top, secretFiles, o)).values()) for (const id of set) secretIds.add(id);
  secretIds.delete(empty);

  // Same content: the working-tree file, or (for a tracked change) its merge-base version.
  const cand = [...candTracked, ...candUntracked];
  const hashed = await hashWorktree(top, cand, o);
  for (const f of cand) {
    const ids = [...(hashed.get(f) || []), baseTree.get(f)];
    if (ids.some((id) => id && secretIds.has(id))) drop.add(f);
  }

  // Renamed with an edit: git's rename detection pairs the secret source with the destination.
  if (candTracked.length > 0) {
    const renameArgs = [...DIFF_ARGS.filter((a) => a !== '--no-renames'), '-M', '--name-status', '-z', mergeBase, '--'];
    const t = splitZ(await gitOk(renameArgs, o, 'git diff failed'));
    for (let i = 0; i < t.length;) {
      const status = t[i];
      if (/^[RC]/.test(status)) {
        if (isSecret(t[i + 1])) drop.add(t[i + 2]);
        i += 3;
      } else i += 2;
    }
  }
  return drop;
}

/**
 * Diff of merge-base(base, HEAD) against the working tree of `cwd`, untracked files
 * included, secret paths excluded (SR-4).
 * @returns {Promise<{text:string, mergeBase:string, files:string[], excluded:number, truncated:boolean}>}
 */
export async function buildDiff({ cwd, base, secretGlobs = [], timeoutSec = DEFAULTS.budget.git_timeout_sec, signal }) {
  if (!base || typeof base !== 'string' || base.startsWith('-')) throw new HarnessError(`invalid base ref '${base}'`, { code: 'usage' });
  const gopts = { cwd, timeoutSec, signal };
  const top = (await gitOk(['rev-parse', '--show-toplevel'], gopts, `${cwd} is not a git worktree`)).trim();
  const baseSha = (await git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], gopts)).stdout.trim();
  if (!baseSha) throw new HarnessError(`base ref '${base}' not found in ${top} — create it or pass --base <ref>`, { code: 'base_missing' });
  const mergeBase = (await gitOk(['merge-base', baseSha, 'HEAD'], gopts, `no merge-base between '${base}' and HEAD`)).trim();
  const o = { cwd: top, timeoutSec, signal };
  const tracked = splitZ(await gitOk([...DIFF_ARGS, '--name-only', '-z', mergeBase, '--'], o, 'git diff failed'));
  const untracked = splitZ(await gitOk(['ls-files', '--others', '--exclude-standard', '-z', '--', '.'], o, 'git ls-files failed'));
  const isSecret = (f) => isSecretPath(f, secretGlobs);
  const drop = await secretCopies({ top, mergeBase, tracked, untracked, isSecret }, o);
  const keepTracked = tracked.filter((f) => !isSecret(f) && !drop.has(f));
  const keepUntracked = untracked.filter((f) => !isSecret(f) && !drop.has(f));
  const excluded = tracked.length + untracked.length - keepTracked.length - keepUntracked.length;

  const parts = [];
  for (let i = 0; i < keepTracked.length; i += GIT_BATCH) {
    const batch = keepTracked.slice(i, i + GIT_BATCH).map((f) => `:(literal)${f}`);
    parts.push(await gitOk([...DIFF_ARGS, mergeBase, '--', ...batch], o, 'git diff failed'));
  }
  for (const f of keepUntracked) parts.push(untrackedDiff(top, f));
  let text = parts.join('');
  const truncated = text.length > DIFF_LIMIT;
  if (truncated) text = `${text.slice(0, DIFF_LIMIT)}\n[diff truncated: ${text.length - DIFF_LIMIT} more characters]\n`;
  return { text, mergeBase, files: [...keepTracked, ...keepUntracked], excluded, truncated };
}

// ------------------------------------------------------------------ verdict rules (§7.3)

const minScore = (scores) => Math.min(...DIMENSIONS.map((d) => scores[d]));

/** A score the role gave that needs a blocking finding to back it up. */
export function isLowScore(scores, { threshold, critical }) {
  return minScore(scores) < threshold || (critical && scores.security < CRITICAL_SECURITY_MIN);
}

/**
 * Pure verdict table (§7.3). Called after the one re-ask has been spent, so a low score
 * with no blocking finding is `needs-human`.
 */
export function decideVerdict({ verifyPass, blockingCount, scores, critical, threshold }) {
  const score = minScore(scores);
  let verdict;
  if (!verifyPass || blockingCount > 0) verdict = 'fail';
  else if (isLowScore(scores, { threshold, critical })) verdict = 'needs-human';
  else verdict = 'pass';
  return { verdict, score };
}

// ------------------------------------------------------------------ helpers

function contractIds(contract) {
  const ids = new Set();
  for (const key of CRITERIA_KEYS) for (const c of contract[key] || []) if (c && typeof c.id === 'string') ids.add(c.id);
  for (const c of contractChecks(contract)) ids.add(c.id);
  return ids;
}

// "AC-1", "F5 AC-1", "F5/AC-1" → "AC-1"
function normalizeCriterionId(id, featureId) {
  if (typeof id !== 'string') return '';
  let s = id.trim();
  const prefix = new RegExp(`^${featureId}[\\s:/.-]+`, 'i');
  s = s.replace(prefix, '');
  return /^regression$/i.test(s) ? 'REGRESSION' : s.replace(/^(ac|sc|es)-/i, (m) => m.toUpperCase());
}

/** Next unused verdict number: one past the highest F{n}-r{k}.json in `dir`. */
export function nextRound(dir, featureId) {
  const ks = verdictRounds(dir, featureId);
  return ks.length ? ks[ks.length - 1] + 1 : 1;
}

/** Reads one F{n}-r{k}.json; anything that is not a verdict record is state_corrupt (E6). */
export function readVerdict(file) {
  const v = readJson(file);
  if (!isObj(v) || typeof v.verdict !== 'string') {
    throw new HarnessError(`${file}: not a verdict record. Fix or restore the file; harness will not modify it.`, { code: 'state_corrupt' });
  }
  return v;
}

/**
 * Verdicts judged against the contract hash `hash`, as [{k, file, v}] ascending by number.
 * Rounds and convergence are counted per contract hash (SPEC §7.6); a verdict without
 * `contract_hash` (written before F18) belongs to no current contract. Every verdict file
 * is read: one that cannot be read has an unknown hash and stops the caller (E6).
 */
export function contractVerdicts(dir, featureId, hash) {
  return verdictRounds(dir, featureId)
    .map((k) => {
      const file = path.join(dir, `${featureId}-r${k}.json`);
      return { k, file, v: readVerdict(file) };
    })
    .filter((r) => typeof r.v.contract_hash === 'string' && r.v.contract_hash === hash);
}

/** Round number of verdict `k` within the contract hash `hash`: 1 + same-hash verdicts before it. */
export function contractRound(dir, featureId, hash, k) {
  return contractVerdicts(dir, featureId, hash).filter((r) => r.k < k).length + 1;
}

/**
 * Extra rounds a human allowed for the contract hash `hash` (`harness approve --extra-round`),
 * kept in the feature entry as `extra_rounds: {hash, count}`; 0 for any other hash (§7.6).
 */
export function extraRoundsOf(feature, hash) {
  const x = feature?.extra_rounds;
  return isObj(x) && x.hash === hash && Number.isInteger(x.count) && x.count > 0 ? x.count : 0;
}

function verifySummary(vr) {
  const lines = [`result: ${vr.pass ? 'PASS' : 'FAIL'}`];
  for (const c of vr.commands || []) lines.push(`command ${c.pass ? 'ok  ' : 'FAIL'} ${c.cmd}${c.pass ? '' : ` — ${c.message ?? `exit ${c.code}`}${c.flaky ? ' (flaky)' : ''}`}`);
  const i = vr.integrity;
  if (i) {
    lines.push(`integrity: skip/focus markers ${i.markers?.length ?? 0}, .harness changes ${i.harnessPaths?.length ?? 0}, test count ${i.testCount?.status ?? 'unset'}`);
  }
  for (const c of vr.criteria || []) lines.push(`criterion ${c.pass ? 'ok  ' : 'FAIL'} ${c.id}${c.pass ? '' : ` — ${c.message ?? 'failed'}`}`);
  for (const w of vr.warnings || []) lines.push(`warning: ${w}`);
  return lines.join('\n');
}

// A fence longer than any backtick run inside the content.
function fence(content, lang = '') {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${content}${content.endsWith('\n') ? '' : '\n'}${f}`;
}

// Items about a file the diff changed first — the item's file is a changed path, or its summary
// names one or that file's name — each group in the order it came in (SPEC §7.7).
function relatedFirst(items, files) {
  if (!files.length) return items;
  const paths = new Set(files);
  // A summary that names a changed path names its file too: the file names are enough.
  const names = [...new Set(files.map((f) => path.posix.basename(f)))].filter(Boolean);
  const related = (i) => (typeof i.file === 'string' && paths.has(i.file))
    || (typeof i.summary === 'string' && names.some((n) => i.summary.includes(n)));
  return [...items.filter(related), ...items.filter((i) => !related(i))];
}

// One line of the summary, at most PROMPT_SUMMARY_CHARS characters (code points) plus '…'.
function shortSummary(summary) {
  const chars = Array.from(typeof summary === 'string' ? summary.replace(/\s+/g, ' ') : '');
  return chars.length > PROMPT_SUMMARY_CHARS ? `${chars.slice(0, PROMPT_SUMMARY_CHARS).join('')}…` : chars.join('');
}

// Open backlog items the evaluator may point at with backlog_id instead of reporting them again.
function backlogSection(items, files) {
  const shown = relatedFirst(items, files).slice(0, PROMPT_LIMIT);
  const lines = shown.map((i) => `- ${i.id} [${i.priority ?? '-'}] ${shortSummary(i.summary)}`);
  if (items.length > shown.length) lines.push(`- … ${items.length - shown.length} more open item(s) not shown`);
  return [
    '## Open backlog',
    'Known, still-open items. When a finding or out_of_scope entry is the same issue as one of these,',
    'set its backlog_id to that id instead of describing it as new. Optional severity: high | medium | low.',
    fence(lines.join('\n')),
  ].join('\n');
}

// How the reply is given (SPEC §7.1): an adapter that passes the schema to its CLI (claude
// --json-schema) gets the object through the StructuredOutput tool, so the model is told to call
// it rather than to write the object as text as well; any other adapter extracts JSON from the text.
const OUTPUT_INSTRUCTION = {
  structured: 'Return the result object by calling the StructuredOutput tool once with an object matching this schema; do not also write it as text',
  text: 'Reply with one JSON object matching this schema and nothing else',
};

/**
 * The evaluation prompt. `structured`: the role's adapter passes the output schema to its CLI
 * (adapter.structuredOutput).
 */
export function buildPrompt({ rolePrompt, featureId, contract, diff, base, vr, threshold, critical, rubric, backlog = [], structured = false }) {
  const rules = critical
    ? `threshold ${threshold}; security_tier critical: security must also be ≥ ${CRITICAL_SECURITY_MIN}`
    : `threshold ${threshold}`;
  const sections = [
    rolePrompt.trim(),
    `## Feature\n${featureId} — ${contract.title ?? ''} (${rules})`,
  ];
  if (rubric && Object.keys(rubric).length) sections.push(`## Rubric\n${fence(JSON.stringify(rubric, null, 2), 'json')}`);
  sections.push(`## Frozen contract\n${fence(JSON.stringify(contract, null, 2), 'json')}`);
  sections.push(`## Deterministic verification (harness verify)\n${fence(verifySummary(vr))}`);
  const note = [`base ${base}, merge-base ${diff.mergeBase.slice(0, 12)}, working tree incl. untracked files`];
  if (diff.excluded) note.push(`${diff.excluded} secret path(s) excluded`);
  if (diff.truncated) note.push('truncated');
  sections.push(`## Diff (${note.join('; ')})\n${diff.text ? fence(diff.text, 'diff') : '(no changes)'}`);
  if (backlog.length) sections.push(backlogSection(backlog, Array.isArray(diff.files) ? diff.files : []));
  const how = structured ? OUTPUT_INSTRUCTION.structured : OUTPUT_INSTRUCTION.text;
  sections.push(`## Output\n${how}:\n${fence(JSON.stringify(OUTPUT_SCHEMA), 'json')}`);
  return `${sections.join('\n\n')}\n`;
}

const REASK = (scores, why, structured) => [
  '',
  '## Re-ask: unsupported low score',
  `Your scores ${JSON.stringify(scores)} are below the passing bar, but none of your findings blocked:`,
  why.length ? why.map((w) => `- ${w}`).join('\n') : '- you reported no findings',
  'Provide a reproducible finding (criterion_id from this contract or REGRESSION, and a repro command that',
  `exits non-zero while the defect exists) or correct the score. ${structured ? 'Call the StructuredOutput tool again with the full object.' : 'Reply with the full JSON object again.'}`,
  '',
].join('\n');

const RETRY = (problems, structured) => [
  '',
  '## Retry: your previous reply did not match the output schema',
  ...problems.slice(0, 20).map((p) => `- ${p}`),
  structured
    ? 'Call the StructuredOutput tool again with one object matching the schema above.'
    : 'Reply with exactly one JSON object matching the schema above and nothing else.',
  '',
].join('\n');

// The {adapter, model} a verdict review records (the effort is in the metrics, SPEC §8.11).
const modelOf = ({ adapter, model }) => ({ adapter, model });

function defaultRunAdapter(config) {
  return async (role, opts) => {
    const { adapter: name, model } = resolveRole(config.roles?.[role], config);
    const adapter = name ? getAdapter(name, config) : null;
    if (!adapter) {
      return { ok: false, error: 'adapter_unavailable', text: '', json: null, costUsd: null, exitCode: null,
        detail: `no adapter assigned to role '${role}'` };
    }
    return adapter.run({ ...opts, role, model: opts.model ?? model });
  };
}

// ------------------------------------------------------------------ evaluate

/**
 * Independent evaluation of one feature (SPEC §7).
 * @returns {Promise<{feature:string, round:number, verdict:'pass'|'fail'|'eval_error'|'needs-human',
 *   score:number|null, scores:object|null, blocking:object[], backlogged:object[],
 *   independence:'cross-model'|'fresh-context', costUsd:number, error?:string, file:string}>}
 * `origin` ('eval' | 'run') is recorded in the verdict: it tells which path records the status.
 * The verdict is written to F{n}-r{k}.json with k = `verdictRound` ?? `round` ?? the next unused
 * number; an existing verdict file is never overwritten. The run passes its own round counter as
 * `round` and the file number as `verdictRound`. `contract_round` (the round within the current
 * contract hash) is counted from the verdict files (SPEC §7.6).
 * `onAdapterCall({role, adapter, model, round, startedAt, endedAt, costUsd, outcome})` is told about
 * every evaluator / security-reviewer call (the metrics of interactive eval, SPEC §8.11).
 * Each role is called with its model for the contract's security tier (SPEC §10). `builders`
 * ({adapter, model}[]) are the builder models the feature used — the run passes them; by default
 * they follow the policy for the contract round. Independence compares them with the evaluator's.
 * The evaluation's events (SPEC §7.8) are recorded at the end; `warn` receives an event write failure.
 */
export async function evaluate({ root, cwd = root, featureId, round, verdictRound, base, config, verifyResult, runAdapter, signal, origin, onAdapterCall, builders, env = process.env, warn }) {
  if (!/^F\d+$/.test(featureId || '')) throw new HarnessError(`invalid feature id '${featureId}' (expected F<n>)`, { code: 'usage' });
  if (!base || typeof base !== 'string') throw new HarnessError('no base ref — pass --base or set base_branch', { code: 'usage' });
  if (base.startsWith('-')) throw new HarnessError(`invalid base ref '${base}'`, { code: 'usage' });
  for (const r of [round, verdictRound]) {
    if (r !== undefined && r !== null && !(Number.isInteger(r) && r >= 1)) {
      throw new HarnessError(`invalid round '${r}' (expected an integer ≥ 1)`, { code: 'usage' });
    }
  }
  if (!fs.existsSync(cwd)) throw new HarnessError(`worktree not found: ${cwd}`, { code: 'usage' });
  const p = paths(root);
  const contract = readJson(p.contract(featureId));
  // Fails on a corrupt backlog before spending anything (E6).
  const openBacklog = openItems(readBacklog(p.backlog));
  const k = verdictRound ?? round ?? nextRound(p.verdicts, featureId);
  const file = path.join(p.verdicts, `${featureId}-r${k}.json`);
  const refuseExisting = () => {
    if (fs.existsSync(file)) {
      throw new HarnessError(`round ${k} of ${featureId} already has a verdict (${file}) — it is not overwritten`, { code: 'round_exists' });
    }
  };
  refuseExisting();
  const contractHash = hashContract(contract);
  // Reads the earlier verdicts: a corrupt one stops before anything is spent (E6).
  const cRound = contractRound(p.verdicts, featureId, contractHash, k);
  const critical = contract.security_tier === 'critical';
  const threshold = Number.isFinite(config.threshold) ? config.threshold : 7;
  const securityMin = Math.max(threshold, CRITICAL_SECURITY_MIN);
  const timeoutSec = config.budget?.step_timeout_sec ?? 1800;
  const budgetUsd = config.budget?.step_usd ?? null;
  const envExtra = Array.isArray(config.env_allowlist) ? config.env_allowlist : [];
  // Verdicts and backlog entries carry command output and reviewer text: redacted like the report (SR-2).
  const redact = redactor(env, envExtra);
  const redacted = (x) => redactDeep(x, redact, KEEP_UNREDACTED);
  const tier = contract.security_tier ?? 'standard';
  const who = {
    evaluator: roleCall(config, 'evaluator', { tier }),
    'security-reviewer': roleCall(config, 'security-reviewer', { tier }),
  };
  const structured = (role) => Boolean(getAdapter(who[role].adapter, config)?.structuredOutput);
  const indep = independenceOf(builders ?? builderModels(config, { tier, round: cRound }), who.evaluator);
  const ids = contractIds(contract);
  const call = runAdapter ?? defaultRunAdapter(config);

  const vr = verifyResult ?? await verify({ root, cwd, featureId, base, config, signal, redact });
  const diff = await buildDiff({ cwd, base, secretGlobs: config.secret_globs, timeoutSec: gitTimeoutOf(config), signal });

  let costUsd = 0;
  const reproCache = new Map();

  // Events of this evaluation (SPEC §7.8), recorded when it ends with a verdict or an eval_error;
  // an interrupted evaluation records none, like it writes no verdict.
  const noted = [];
  const note = (stage, type, data) => noted.push({ stage, type, data });
  const clip = (s, n) => redact(String(s)).slice(0, n); // redacted before the cut (F56 SC-1)
  const flush = (extra) => {
    for (const e of [...noted, ...extra]) {
      recordEvent(root, { ...e, feature: featureId, round: k }, { config, redact, warn });
    }
  };

  // One schema-checked reply; a mismatch is re-asked once (§7.3).
  async function ask(role, prompt) {
    let text = prompt;
    let problems = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let r;
      const startedAt = new Date();
      const told = (outcome) => onAdapterCall?.({ role, ...who[role], round: cRound, startedAt, endedAt: new Date(), costUsd: r?.costUsd ?? null, usage: usageOf(r),
        servedModel: r?.servedModel ?? null, servedCanonical: r?.servedCanonical ?? null, outcome });
      try {
        r = await call(role, { role, prompt: text, cwd, readOnly: true, schema: OUTPUT_SCHEMA, timeoutSec, budgetUsd, model: who[role].model, effort: who[role].effort, signal, redact });
      } catch (e) {
        told('adapter_error');
        return { error: 'adapter_error', detail: e.message };
      }
      told(r?.ok ? 'ok' : (r?.error || 'adapter_error'));
      if (typeof r?.costUsd === 'number' && Number.isFinite(r.costUsd)) costUsd += r.costUsd;
      if (!r || r.error === 'adapter_unavailable') return { error: 'adapter_unavailable', detail: r?.detail ?? null };
      if (r.ok) {
        problems = validateOutput(r.json);
        if (problems.length === 0) return { json: r.json };
      } else if (r.error === 'no_json') {
        problems = ['no JSON object found in the reply'];
      } else {
        return { error: r.error || 'adapter_error', detail: r.detail ?? null };
      }
      if (attempt === 1) {
        note('eval', 'reask', { role, reason: 'schema_mismatch', problems: problems.slice(0, 5).map((x) => clip(x, EVENT_TEXT_CHARS)) });
      }
      text = prompt + RETRY(problems, structured(role));
    }
    return { error: 'schema_mismatch', detail: problems.join('; ') };
  }

  async function runRepro(repro) {
    if (!reproCache.has(repro)) {
      const started = Date.now();
      reproCache.set(repro, runCommand(repro, { cwd, timeoutSec, envExtra, signal }).then((r) => ({ ...r, ms: Date.now() - started })));
    }
    return reproCache.get(repro);
  }

  // Splits a reply into blocking findings and backlog entries (§7.3, SR-3, D1).
  async function classify(role, json) {
    const blocking = [];
    const backlogged = [];
    const stage = role === 'security-reviewer' ? 'security' : 'eval';
    // One finding event per finding and out_of_scope entry (SPEC §7.8): never the repro itself.
    const noteFinding = (f, id, reason, r) => note(stage, 'finding', {
      criterion_id: id ? clip(id, EVENT_ID_CHARS)
        : typeof f.criterion_id === 'string' && f.criterion_id.trim() ? clip(f.criterion_id, EVENT_ID_CHARS) : null,
      dimension: typeof f.dimension === 'string' ? clip(f.dimension, EVENT_ID_CHARS) : null,
      source: role,
      result: reason ? 'backlogged' : 'blocking',
      reason: reason ? (EVENT_REASONS[reason] ?? reason) : null,
      repro_program: reproProgram(f.repro),
      // A killed repro has no exit code on POSIX but may have one on Windows: timed_out says it.
      repro_exit: Number.isInteger(r?.code) ? r.code : null,
      timed_out: r?.timedOut === true,
      repro_ms: Number.isInteger(r?.ms) ? r.ms : null,
      summary: clip(f.summary ?? '', EVENT_SUMMARY_CHARS),
    });
    // severity outside high|medium|low is ignored; backlog_id is resolved when the backlog is written.
    // An invalid or secret file/line is dropped, the entry kept (F75).
    const loc = (f) => locationOf(f, config.secret_globs);
    const tags = (f) => ({
      ...loc(f),
      ...(severityOf(f.severity) ? { priority: f.severity } : {}),
      ...(typeof f.backlog_id === 'string' && f.backlog_id ? { backlog_id: f.backlog_id } : {}),
    });
    const later = (f, reason, extra = {}, id = '', r = null) => {
      noteFinding(f, id, reason, r);
      backlogged.push({
        summary: f.summary, reason, source: role,
        ...(f.criterion_id ? { criterion_id: f.criterion_id } : {}),
        ...(f.repro ? { repro: f.repro } : {}),
        ...extra,
        ...tags(f),
      });
    };
    for (const f of json.findings) {
      const id = normalizeCriterionId(f.criterion_id, featureId);
      const repro = typeof f.repro === 'string' ? f.repro.trim() : '';
      if (!id) { later(f, 'missing_criterion_id'); continue; }
      if (id !== 'REGRESSION' && !ids.has(id)) { later(f, 'criterion_not_in_contract', {}, id); continue; }
      if (!repro) { later(f, 'missing_repro', {}, id); continue; }
      const denied = deniedPattern(repro);
      if (denied) { later(f, 'repro_denied', { pattern: denied }, id); continue; }
      const adversarial = adversarialPattern(repro);
      if (adversarial) { later(f, 'adversarial_scenario', { pattern: adversarial }, id); continue; }
      const r = await runRepro(repro);
      // A repro killed by the run's abort was not reproduced — stop without judging.
      if (r.aborted || signal?.aborted) throw new HarnessError('evaluation interrupted', { code: 'interrupted' });
      if (r.timedOut) { later(f, 'repro_timeout', { timeout_sec: timeoutSec }, id, r); continue; }
      // exit 126 (POSIX "found but not executable", e.g. missing +x or a bad shebang) is not
      // reproduced, only unusable, same as a missing command (SPEC §7.3).
      if (r.error || isNotFound(r) || r.code === 126) { later(f, 'repro_not_runnable', { exit: r.code ?? null }, id, r); continue; }
      if (r.code === 0) { later(f, 'repro_not_reproduced', { exit: 0 }, id, r); continue; }
      noteFinding(f, id, null, r);
      blocking.push({
        criterion_id: id, dimension: typeof f.dimension === 'string' ? f.dimension : null,
        summary: f.summary, repro, source: role, exit: r.code, ...(r.code === null ? { signal: r.signal } : {}),
        ...loc(f),
      });
    }
    for (const o of json.out_of_scope || []) {
      noteFinding({ summary: o.summary }, '', 'out_of_scope', null);
      backlogged.push({ summary: o.summary, reason: 'out_of_scope', source: role, ...tags(o) });
    }
    return { blocking, backlogged };
  }

  const reviewLow = (role, scores) => (role === 'security-reviewer'
    ? scores.security < threshold || scores.security < CRITICAL_SECURITY_MIN
    : isLowScore(scores, { threshold, critical }));

  // One role: ask, classify, and — when the score is low with nothing blocking — re-ask once (§7.3).
  async function review(role, mayReask) {
    const prompt = buildPrompt({
      rolePrompt: loadRolePrompt(role), featureId, contract, diff, base, vr, threshold, critical, rubric: config.rubric,
      backlog: openBacklog, structured: structured(role),
    });
    const first = await ask(role, prompt);
    if (first.error) return first;
    let { blocking, backlogged } = await classify(role, first.json);
    let scores = first.json.scores;
    let reasked = false;
    if (blocking.length === 0 && reviewLow(role, scores) && await mayReask()) {
      reasked = true;
      const why = backlogged.filter((b) => b.reason !== 'out_of_scope').map((b) => `"${b.summary}" was not blocking: ${b.reason}`);
      note('eval', 'reask', { role, reason: 'unsupported_low_score', scores: pickScores(scores), unsupported: why.length });
      const second = await ask(role, prompt + REASK(scores, why, structured(role)));
      if (second.error) return second;
      const again = await classify(role, second.json);
      blocking = again.blocking;
      backlogged = [...backlogged, ...again.backlogged];
      scores = second.json.scores;
    }
    return { scores: pickScores(scores), blocking, backlogged, reasked };
  }

  const reviews = {};
  const evalErr = async (res) => {
    const out = finishError({ root, featureId, round: k, independence: indep, costUsd, error: res.error, detail: res.detail, origin, redacted });
    const roles = { evaluator: ev.scores ?? null, ...(critical ? { 'security-reviewer': sr?.scores ?? null } : {}) };
    flush([
      { stage: 'eval', type: 'verdict', data: {
        verdict: 'eval_error', error: res.error, score: null, scores: null, roles, threshold, independence: indep,
        contract_round: cRound, ...(origin ? { origin } : {}),
      } },
      ...(critical ? [{ stage: 'security', type: 'verdict', data: {
        // The evaluator's error comes first: the review is then not used.
        verdict: 'eval_error', reviewer: sr?.error ? 'error' : 'unused', reviewer_scores: sr?.scores ?? null,
        security: null, security_min: securityMin, security_verdict: null,
      } }] : []),
    ]);
    return out;
  };

  // critical: the security-reviewer runs concurrently with the evaluator (§7.4). Its low-score
  // re-ask still waits for the evaluator, so it happens exactly when it would sequentially.
  const evP = review('evaluator', () => vr.pass);
  const srP = critical
    ? review('security-reviewer', async () => vr.pass && (await evP).blocking?.length === 0)
    : null;
  const [ev, sr] = await Promise.all([evP, srP]);
  // A usage limit is not an eval_error (SPEC §8): nothing is recorded and the caller stops.
  const limited = [['evaluator', ev], ['security-reviewer', sr]].find(([, x]) => x?.error === 'usage_limit');
  if (limited) {
    const [role, x] = limited;
    const detail = x.detail || 'usage limit reached';
    const err = new HarnessError(`${role} usage limit reached: ${detail} — nothing recorded (no verdict, status unchanged); evaluate again after the limit resets`, { code: 'usage_limit', exit: 1 });
    Object.assign(err, { role, detail, costUsd });
    throw err;
  }
  if (ev.error) return evalErr(ev);
  reviews.evaluator = { scores: ev.scores, reasked: ev.reasked, ...modelOf(who.evaluator) };
  const scores = { ...ev.scores };
  let blocking = [...ev.blocking];
  let backlogged = [...ev.backlogged];

  if (critical && blocking.length > 0) {
    // The evaluator already fails the round: the reviewer's result is not used for the
    // verdict (which is fail either way), and recorded as unused.
    reviews['security-reviewer'] = 'unused';
  } else if (critical) {
    if (sr.error) return evalErr(sr);
    reviews['security-reviewer'] = { scores: sr.scores, reasked: sr.reasked, ...modelOf(who['security-reviewer']) };
    // The reviewer judges security only: its other dimensions are recorded, not used (§7.4).
    scores.security = Math.min(scores.security, sr.scores.security);
    blocking = [...blocking, ...sr.blocking];
    backlogged = [...backlogged, ...sr.backlogged];
  }

  // An interrupted evaluation writes nothing: no verdict, no backlog (the run redoes the round).
  if (signal?.aborted) throw new HarnessError('evaluation interrupted', { code: 'interrupted' });
  refuseExisting(); // written meanwhile (a concurrent eval): keep that verdict, write nothing
  const { verdict, score } = decideVerdict({ verifyPass: Boolean(vr.pass), blockingCount: blocking.length, scores, critical, threshold });
  const at = new Date().toISOString();
  if (backlogged.length) {
    recordEntries(p.backlog, redacted(backlogged), { feature: featureId, round: k, at });
  }
  const record = {
    feature: featureId, round: k, verdict, score, scores, threshold, security_tier: contract.security_tier ?? 'standard',
    verify_pass: Boolean(vr.pass), blocking, backlogged, independence: indep, costUsd,
    contract_hash: contractHash, contract_round: cRound, reviews, at, ...(origin ? { origin } : {}),
  };
  // What made verify fail, so the verdict explains a fail without a finding (SPEC §7.3).
  if (!vr.pass) record.verify_failures = verifyFailures(vr, redact);
  if (Array.isArray(vr.flaky_tests) && vr.flaky_tests.length) record.flaky_tests = vr.flaky_tests.slice(0, MAX_FLAKY_TESTS);
  const saved = redacted(record);
  writeJsonAtomic(file, saved);
  const srUnused = reviews['security-reviewer'] === 'unused';
  if (srUnused) for (const e of noted) if (e.stage === 'security' && e.type === 'finding') e.data.unused = true;
  const roles = { evaluator: ev.scores, ...(critical ? { 'security-reviewer': srUnused ? 'unused' : sr.scores } : {}) };
  // The security dimension's own verdict: the final security score against the critical bar,
  // and no blocking finding of the reviewer or of the security dimension.
  const securityBlocking = blocking.filter((b) => b.source === 'security-reviewer' || b.dimension === 'security').length;
  flush([
    { stage: 'eval', type: 'verdict', data: {
      verdict, score, scores, roles, threshold, independence: indep, verify_pass: Boolean(vr.pass),
      blocking: blocking.length, backlogged: backlogged.length, contract_round: cRound, ...(origin ? { origin } : {}),
    } },
    ...(critical ? [{ stage: 'security', type: 'verdict', data: {
      reviewer: srUnused ? 'unused' : 'used', reviewer_scores: sr?.scores ?? null,
      security: scores.security, security_min: securityMin, blocking: securityBlocking,
      security_verdict: scores.security >= securityMin && securityBlocking === 0 ? 'pass' : 'fail',
    } }] : []),
  ]);
  return { ...saved, file };
}

// Identifiers a verdict is read back by; they never hold command output. criterion_id and
// backlog_id are not among them: a backlogged finding keeps the reviewer's own text there.
const KEEP_UNREDACTED = new Set(['feature', 'contract_hash']);

const pickScores = (s) => Object.fromEntries(DIMENSIONS.map((d) => [d, s[d]]));

// eval_error does not consume a round (§7.3): it is recorded beside the round, never as
// F{n}-r{k}.json, and counts consecutive errors for the run loop's blocked rule.
function finishError({ root, featureId, round, independence, costUsd, error, detail, origin, redacted }) {
  const file = path.join(paths(root).verdicts, `${featureId}-r${round}.eval_error.json`);
  const prev = readJson(file, { optional: true });
  const consecutive = (isObj(prev) && Number.isInteger(prev.consecutive) ? prev.consecutive : 0) + 1;
  const record = {
    feature: featureId, round, verdict: 'eval_error', error, detail: detail ?? null, consecutive,
    score: null, scores: null, blocking: [], backlogged: [], independence, costUsd, at: new Date().toISOString(),
    ...(origin ? { origin } : {}),
  };
  writeJsonAtomic(file, redacted(record));
  return { ...record, file };
}
