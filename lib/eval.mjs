// Independent evaluation and the core's verdict rules (SPEC §7, SR-3, SR-4, SR-6).
// The model only proposes scores and findings; everything that decides the verdict
// (schema, contract membership, repro re-run, min-of-5, thresholds) happens here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HarnessError } from './errors.mjs';
import { paths, readJson, writeJsonAtomic } from './state.mjs';
import { runCommand, isNotFound } from './exec.mjs';
import { verify, contractChecks } from './verify.mjs';
import { hashContract } from './contract.mjs';
import { loadRolePrompt } from './roles.mjs';
import { getAdapter, resolveRole, independence as classifyIndependence } from './adapters/index.mjs';

export const DIMENSIONS = Object.freeze(['functionality', 'quality', 'security', 'errors', 'tests']);
export const CRITICAL_SECURITY_MIN = 7;
const CRITERIA_KEYS = ['acceptance_criteria', 'security_criteria', 'error_scenarios'];
const DIFF_LIMIT = 200_000; // characters of diff sent to the model
const UNTRACKED_LIMIT = 100_000; // bytes of one untracked file shown in the diff
const GIT_BATCH = 100; // paths per `git diff` call (Windows command-line length)

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
        },
      },
    },
    out_of_scope: {
      type: 'array',
      items: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } },
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

// ------------------------------------------------------------------ SR-4 secret paths

const DEFAULT_SECRET = [/^\.env/i, /\.pem$/i, /\.key$/i, /^id_/i, /\.p12$/i];

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') { i += 1; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/**
 * True when a repo-relative path must not reach a model prompt (SR-4).
 * Default patterns apply to every path segment (a `.env.d/` directory hides its files);
 * a secret_glob without '/' matches any segment, with '/' the whole path.
 */
export function isSecretPath(p, secretGlobs = []) {
  const norm = String(p).replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  if (parts.some((seg) => DEFAULT_SECRET.some((re) => re.test(seg)))) return true;
  for (const g of Array.isArray(secretGlobs) ? secretGlobs : []) {
    if (typeof g !== 'string' || !g) continue;
    const pattern = g.replace(/\\/g, '/').replace(/^\//, '').replace(/\/$/, '/**');
    const re = globToRegExp(pattern);
    if (pattern.includes('/') ? re.test(norm) : parts.some((seg) => re.test(seg))) return true;
  }
  return false;
}

// ------------------------------------------------------------------ git diff (SR-4)

// Same hardening as verify: no external diff/textconv, no hooks, no fsmonitor, fixed prefixes.
const GIT_SAFE = ['-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.relative=false',
  '-c', 'color.ui=never', '-c', 'core.fsmonitor=false',
  '-c', `core.hooksPath=${path.join(os.tmpdir(), 'harness-no-hooks-dir')}`];
const DIFF_ARGS = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/'];
const splitZ = (s) => s.split('\0').filter(Boolean);

async function git(args, opts) {
  const r = await runCommand({ file: 'git', args: [...GIT_SAFE, ...args] }, opts);
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
export async function buildDiff({ cwd, base, secretGlobs = [], timeoutSec = 1800, signal }) {
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

function nextRound(dir, featureId) {
  let max = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* no verdicts yet */ }
  const re = new RegExp(`^${featureId}-r(\\d+)\\.json$`);
  for (const n of names) {
    const m = re.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function readBacklog(file) {
  const data = readJson(file, { optional: true });
  if (data === undefined) return { items: [] };
  if (!isObj(data) || !Array.isArray(data.items)) {
    throw new HarnessError(`${file}: expected { "items": [...] }. Fix or restore the file; harness will not modify it.`, { code: 'state_corrupt' });
  }
  return data;
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

export function buildPrompt({ rolePrompt, featureId, contract, diff, base, vr, threshold, critical, rubric }) {
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
  sections.push(`## Output\nReply with one JSON object matching this schema and nothing else:\n${fence(JSON.stringify(OUTPUT_SCHEMA), 'json')}`);
  return `${sections.join('\n\n')}\n`;
}

const REASK = (scores, why) => [
  '',
  '## Re-ask: unsupported low score',
  `Your scores ${JSON.stringify(scores)} are below the passing bar, but none of your findings blocked:`,
  why.length ? why.map((w) => `- ${w}`).join('\n') : '- you reported no findings',
  'Provide a reproducible finding (criterion_id from this contract or REGRESSION, and a repro command that',
  'exits non-zero while the defect exists) or correct the score. Reply with the full JSON object again.',
  '',
].join('\n');

const RETRY = (problems) => [
  '',
  '## Retry: your previous reply did not match the output schema',
  ...problems.slice(0, 20).map((p) => `- ${p}`),
  'Reply with exactly one JSON object matching the schema above and nothing else.',
  '',
].join('\n');

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
 */
export async function evaluate({ root, cwd = root, featureId, round, base, config, verifyResult, runAdapter, signal }) {
  if (!/^F\d+$/.test(featureId || '')) throw new HarnessError(`invalid feature id '${featureId}' (expected F<n>)`, { code: 'usage' });
  if (!base || typeof base !== 'string') throw new HarnessError('no base ref — pass --base or set base_branch', { code: 'usage' });
  if (base.startsWith('-')) throw new HarnessError(`invalid base ref '${base}'`, { code: 'usage' });
  if (round !== undefined && round !== null && !(Number.isInteger(round) && round >= 1)) {
    throw new HarnessError(`invalid round '${round}' (expected an integer ≥ 1)`, { code: 'usage' });
  }
  if (!fs.existsSync(cwd)) throw new HarnessError(`worktree not found: ${cwd}`, { code: 'usage' });
  const p = paths(root);
  const contract = readJson(p.contract(featureId));
  readBacklog(p.backlog); // fail on a corrupt backlog before spending anything (E6)
  const k = round ?? nextRound(p.verdicts, featureId);
  const critical = contract.security_tier === 'critical';
  const threshold = Number.isFinite(config.threshold) ? config.threshold : 7;
  const timeoutSec = config.budget?.step_timeout_sec ?? 1800;
  const budgetUsd = config.budget?.step_usd ?? null;
  const envExtra = Array.isArray(config.env_allowlist) ? config.env_allowlist : [];
  const indep = classifyIndependence(config.roles || {}, config);
  const ids = contractIds(contract);
  const call = runAdapter ?? defaultRunAdapter(config);

  const vr = verifyResult ?? await verify({ root, cwd, featureId, base, config, signal });
  const diff = await buildDiff({ cwd, base, secretGlobs: config.secret_globs, timeoutSec, signal });

  let costUsd = 0;
  const reproCache = new Map();

  // One schema-checked reply; a mismatch is re-asked once (§7.3).
  async function ask(role, prompt) {
    let text = prompt;
    let problems = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let r;
      try {
        r = await call(role, { role, prompt: text, cwd, readOnly: true, schema: OUTPUT_SCHEMA, timeoutSec, budgetUsd, signal });
      } catch (e) {
        return { error: 'adapter_error', detail: e.message };
      }
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
      text = prompt + RETRY(problems);
    }
    return { error: 'schema_mismatch', detail: problems.join('; ') };
  }

  async function runRepro(repro) {
    if (!reproCache.has(repro)) reproCache.set(repro, runCommand(repro, { cwd, timeoutSec, envExtra, signal }));
    return reproCache.get(repro);
  }

  // Splits a reply into blocking findings and backlog entries (§7.3, SR-3, D1).
  async function classify(role, json) {
    const blocking = [];
    const backlogged = [];
    const later = (f, reason, extra = {}) => backlogged.push({
      summary: f.summary, reason, source: role,
      ...(f.criterion_id ? { criterion_id: f.criterion_id } : {}),
      ...(f.repro ? { repro: f.repro } : {}),
      ...extra,
    });
    for (const f of json.findings) {
      const id = normalizeCriterionId(f.criterion_id, featureId);
      const repro = typeof f.repro === 'string' ? f.repro.trim() : '';
      if (!id) { later(f, 'missing_criterion_id'); continue; }
      if (id !== 'REGRESSION' && !ids.has(id)) { later(f, 'criterion_not_in_contract'); continue; }
      if (!repro) { later(f, 'missing_repro'); continue; }
      const denied = deniedPattern(repro);
      if (denied) { later(f, 'repro_denied', { pattern: denied }); continue; }
      const adversarial = adversarialPattern(repro);
      if (adversarial) { later(f, 'adversarial_scenario', { pattern: adversarial }); continue; }
      const r = await runRepro(repro);
      // A repro killed by the run's abort was not reproduced — stop without judging.
      if (r.aborted || signal?.aborted) throw new HarnessError('evaluation interrupted', { code: 'interrupted' });
      if (r.timedOut) { later(f, 'repro_timeout', { timeout_sec: timeoutSec }); continue; }
      if (r.error || isNotFound(r)) { later(f, 'repro_not_runnable', { exit: r.code ?? null }); continue; }
      if (r.code === 0) { later(f, 'repro_not_reproduced', { exit: 0 }); continue; }
      blocking.push({
        criterion_id: id, dimension: typeof f.dimension === 'string' ? f.dimension : null,
        summary: f.summary, repro, source: role, exit: r.code, ...(r.code === null ? { signal: r.signal } : {}),
      });
    }
    for (const o of json.out_of_scope || []) backlogged.push({ summary: o.summary, reason: 'out_of_scope', source: role });
    return { blocking, backlogged };
  }

  const reviewLow = (role, scores) => (role === 'security-reviewer'
    ? scores.security < threshold || scores.security < CRITICAL_SECURITY_MIN
    : isLowScore(scores, { threshold, critical }));

  // One role: ask, classify, and — when the score is low with nothing blocking — re-ask once (§7.3).
  async function review(role, mayReask) {
    const prompt = buildPrompt({
      rolePrompt: loadRolePrompt(role), featureId, contract, diff, base, vr, threshold, critical, rubric: config.rubric,
    });
    const first = await ask(role, prompt);
    if (first.error) return first;
    let { blocking, backlogged } = await classify(role, first.json);
    let scores = first.json.scores;
    let reasked = false;
    if (mayReask() && blocking.length === 0 && reviewLow(role, scores)) {
      reasked = true;
      const why = backlogged.filter((b) => b.reason !== 'out_of_scope').map((b) => `"${b.summary}" was not blocking: ${b.reason}`);
      const second = await ask(role, prompt + REASK(scores, why));
      if (second.error) return second;
      const again = await classify(role, second.json);
      blocking = again.blocking;
      backlogged = [...backlogged, ...again.backlogged];
      scores = second.json.scores;
    }
    return { scores: pickScores(scores), blocking, backlogged, reasked };
  }

  const reviews = {};
  const evalErr = async (res) => finishError({ root, featureId, round: k, independence: indep, costUsd, error: res.error, detail: res.detail });

  const ev = await review('evaluator', () => vr.pass);
  if (ev.error) return evalErr(ev);
  reviews.evaluator = { scores: ev.scores, reasked: ev.reasked };
  const scores = { ...ev.scores };
  let blocking = [...ev.blocking];
  let backlogged = [...ev.backlogged];

  if (critical) {
    const sr = await review('security-reviewer', () => vr.pass && blocking.length === 0);
    if (sr.error) return evalErr(sr);
    reviews['security-reviewer'] = { scores: sr.scores, reasked: sr.reasked };
    // The reviewer judges security only: its other dimensions are recorded, not used (§7.4).
    scores.security = Math.min(scores.security, sr.scores.security);
    blocking = [...blocking, ...sr.blocking];
    backlogged = [...backlogged, ...sr.backlogged];
  }

  // An interrupted evaluation writes nothing: no verdict, no backlog (the run redoes the round).
  if (signal?.aborted) throw new HarnessError('evaluation interrupted', { code: 'interrupted' });
  const { verdict, score } = decideVerdict({ verifyPass: Boolean(vr.pass), blockingCount: blocking.length, scores, critical, threshold });
  const at = new Date().toISOString();
  if (backlogged.length) {
    const bl = readBacklog(p.backlog);
    bl.items.push(...backlogged.map((b) => ({ feature: featureId, round: k, at, ...b })));
    writeJsonAtomic(p.backlog, bl);
  }
  const record = {
    feature: featureId, round: k, verdict, score, scores, threshold, security_tier: contract.security_tier ?? 'standard',
    verify_pass: Boolean(vr.pass), blocking, backlogged, independence: indep, costUsd,
    contract_hash: hashContract(contract), reviews, at,
  };
  const file = path.join(p.verdicts, `${featureId}-r${k}.json`);
  writeJsonAtomic(file, record);
  return { ...record, file };
}

const pickScores = (s) => Object.fromEntries(DIMENSIONS.map((d) => [d, s[d]]));

// eval_error does not consume a round (§7.3): it is recorded beside the round, never as
// F{n}-r{k}.json, and counts consecutive errors for the run loop's blocked rule.
function finishError({ root, featureId, round, independence, costUsd, error, detail }) {
  const file = path.join(paths(root).verdicts, `${featureId}-r${round}.eval_error.json`);
  const prev = readJson(file, { optional: true });
  const consecutive = (isObj(prev) && Number.isInteger(prev.consecutive) ? prev.consecutive : 0) + 1;
  const record = {
    feature: featureId, round, verdict: 'eval_error', error, detail: detail ?? null, consecutive,
    score: null, scores: null, blocking: [], backlogged: [], independence, costUsd, at: new Date().toISOString(),
  };
  writeJsonAtomic(file, record);
  return { ...record, file };
}
