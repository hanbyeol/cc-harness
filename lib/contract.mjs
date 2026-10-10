import fs from 'node:fs';
import crypto from 'node:crypto';
import { HarnessError } from './errors.mjs';
import { paths, loadFeatures, runnableFeatures } from './state.mjs';
import { DEFAULTS } from './config.mjs';
import { jsonErrorOffset } from './jsonpos.mjs';
import { isTestPath, matchesAnyGlob } from './glob.mjs';

// section key → id prefix. A criterion's prefix must match the section it sits in,
// so "SC ≥ 1" and the size limits count what they claim to count.
export const SECTIONS = Object.freeze({
  acceptance_criteria: 'AC',
  security_criteria: 'SC',
  error_scenarios: 'ES',
});
const LIMIT_KEY = { AC: 'ac', SC: 'sc', ES: 'es' };

// Universal negatives are undecidable by a finite check unless the scenarios
// are enumerated (SPEC §5 rule 3). The list is fixed in code on purpose.
export const FORBIDDEN_PATTERNS = Object.freeze([
  ['어떤 .*도', /어떤 .*도/u],
  ['모든 .*에 대해', /모든 .*에 대해/u],
  ['우회 불가', /우회 불가/u],
  // 절대로 whatever follows; bare 절대 as a word, but not 절대 경로 (absolute path) nor 절대값/절대적
  ['절대', /절대로|절대(?=\s|$)(?!\s*경로)/u],
  ['any possible', /any possible/i],
  ['cannot be bypassed', /cannot be bypassed/i],
  ['no way to', /no way to/i],
  ['never', /\bnever\b/i],
]);

const ID_RE = /^(AC|SC|ES)-[1-9]\d*$/;
const TIERS = new Set(['standard', 'critical']);

const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

export function withoutApproval(contract) {
  const { approval, ...rest } = contract;
  return rest;
}

// Key order is whatever the parsed file had — JSON.parse preserves it — so the
// hash is reproducible from the file alone (SPEC §5 rule 6).
export function hashContract(contract) {
  return crypto.createHash('sha256').update(JSON.stringify(withoutApproval(contract))).digest('hex');
}

export function isApprovalValid(contract) {
  const hash = contract?.approval?.hash;
  return nonEmptyString(hash) && hash === hashContract(contract);
}

// Text inside quotes ('…', "…", `…`) is a mention, not a use: a criterion that describes
// the lint rule itself quotes the forbidden words without making a universal claim.
const QUOTED = /'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g;

export function matchedForbidden(text) {
  if (typeof text !== 'string') return [];
  const used = text.replace(QUOTED, ' ');
  return FORBIDDEN_PATTERNS.filter(([, re]) => re.test(used)).map(([name]) => name);
}

// A universal statement is acceptable only as a finite list of checked scenarios.
function hasCheckedCases(c) {
  return Array.isArray(c.cases) && c.cases.length > 0
    && c.cases.every((k) => k && typeof k === 'object' && nonEmptyString(k.check));
}

// File names a test runner picks up as tests. A test_paths file named otherwise (test/t.mjs,
// tests/util.js) is a helper; the base vacuity run overlays it too (§6.3).
const TEST_FILE_SHAPES = Object.freeze(['*.test.*', '*.spec.*', '*_test.*', 'test_*.py']);
// A repo-relative file path in prose: at least one '/', a file extension, not part of a URL.
const PATH_IN_TEXT = /(?<![\w.@/:-])(?:\.\/)?([\w@-][\w.@-]*(?:\/[\w.@-]+)+\.[A-Za-z0-9]+)(?![\w/-])/g;

// Paths named in a criterion that match verify.test_paths but are not test files by name.
export function overlaidHelpers(text, testPaths) {
  if (typeof text !== 'string' || !Array.isArray(testPaths) || !testPaths.length) return [];
  const found = new Set();
  for (const [, p] of text.matchAll(PATH_IN_TEXT)) {
    const name = p.slice(p.lastIndexOf('/') + 1);
    if (isTestPath(p, testPaths) && !matchesAnyGlob(name, TEST_FILE_SHAPES)) found.add(p);
  }
  return [...found];
}

// Returns [{level, id?, message}]. `ignoreApproval` lets `approve` re-freeze a
// contract that was edited after an earlier approval; `expectId` is the file's id.
// `backlog` (the backlog.json items, when known) lets `resolves` ids be checked against it.
// `testPaths` is the merged config's verify.test_paths (the overlaid_helper warning).
export function lintContract(contract, { limits = DEFAULTS.limits, bytes, ignoreApproval = false, expectId, backlog, testPaths = [] } = {}) {
  const problems = [];
  // `rule` names the lint rule for the plan/lint event (F54 AC-2).
  const add = (level, rule, message, id) => problems.push(id ? { level, rule, id, message } : { level, rule, message });
  const error = (rule, message, id) => add('error', rule, message, id);
  const warn = (rule, message, id) => add('warning', rule, message, id);
  const lim = { ...DEFAULTS.limits, ...limits };

  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    error('shape', 'contract must be a JSON object');
    return problems;
  }
  if (!nonEmptyString(contract.id)) error('contract_id', 'missing contract id');
  else if (expectId !== undefined && contract.id !== expectId) error('contract_id', `contract id '${contract.id}' does not match file name ${expectId}.json`);
  if (!TIERS.has(contract.security_tier)) error('security_tier', `security_tier must be one of ${[...TIERS].join('|')}`);

  const seen = new Set();
  const counts = { AC: 0, SC: 0, ES: 0 };
  for (const [section, prefix] of Object.entries(SECTIONS)) {
    const list = contract[section] ?? [];
    if (!Array.isArray(list)) { error('shape', `${section} must be an array`); continue; }
    counts[prefix] = list.length;
    list.forEach((c, i) => {
      const where = `${section}[${i}]`;
      if (!c || typeof c !== 'object' || Array.isArray(c)) { error('shape', `${where} must be an object`); return; }
      const id = typeof c.id === 'string' ? c.id : undefined;
      const label = id || where;
      // Rule 2: unique ids in the AC-n|SC-n|ES-n form, prefix matching the section.
      if (!id || !ID_RE.test(id)) error('id', `invalid id ${JSON.stringify(c.id)} in ${where} (expected ${prefix}-n)`, label);
      else if (!id.startsWith(`${prefix}-`)) error('id', `id ${id} is in ${section} (expected ${prefix}-n)`, label);
      if (id) {
        if (seen.has(id)) error('id', `duplicate id ${id}`, label);
        seen.add(id);
      }
      // Rule 1: every criterion is decided by a command.
      if (!nonEmptyString(c.check)) error('check', 'missing or empty check', label);
      if (!nonEmptyString(c.criterion)) warn('criterion_text', 'missing criterion text', label);
      // A new criterion whose test is in a helper the base run also gets can pass on base (§6.3).
      else if (c.new === true) {
        const helpers = overlaidHelpers(c.criterion, testPaths);
        if (helpers.length) {
          warn('overlaid_helper', `${label} names ${helpers.join(', ')} — a verify.test_paths file that is not a test file by name and is overlaid on base in the vacuity run (§6.3); a criterion decided by it can pass on base, consider new: false`, label);
        }
      }
      // Rule 3: universal negatives need enumerated, checked cases.
      const hits = matchedForbidden(c.criterion);
      if (hits.length && !hasCheckedCases(c)) {
        error('universal', `universal statement (${hits.map((h) => `"${h}"`).join(', ')}) needs a non-empty "cases" array where every case has a check`, label);
      }
    });
  }

  // Rule 4: size limits keep contracts reviewable.
  for (const prefix of ['AC', 'SC', 'ES']) {
    const max = lim[LIMIT_KEY[prefix]];
    if (counts[prefix] > max) error('size', `${counts[prefix]} ${prefix} criteria exceed the limit of ${max}`);
  }
  if (typeof bytes === 'number' && bytes > lim.bytes) error('size', `file is ${bytes} bytes, over the limit of ${lim.bytes}`);

  // Rule 5.
  if (contract.security_tier === 'critical' && counts.SC === 0) error('critical_sc', 'security_tier critical requires at least one SC criterion');

  // SR-7 (F7 SC-1): live-change skills never run unattended.
  if (Array.isArray(contract.run_steps) && contract.run_steps.includes('rollout')) {
    error('rollout', 'run_steps includes "rollout" — live changes cannot be an autonomous run step (SR-7)');
  }

  // resolves: backlog ids this feature closes when it passes (SPEC §7.7).
  if (contract.resolves !== undefined) {
    if (!Array.isArray(contract.resolves) || !contract.resolves.every((x) => typeof x === 'string')) {
      error('resolves', 'resolves must be an array of backlog id strings');
    } else if (Array.isArray(backlog)) {
      for (const ref of contract.resolves) {
        const item = backlog.find((i) => i && typeof i === 'object' && i.id === ref);
        if (!item) warn('resolves', `resolves: backlog item ${ref} does not exist`);
        else if (item.resolved_by !== undefined && item.resolved_by !== null && item.resolved_by !== '') {
          warn('resolves', `resolves: backlog item ${ref} is already resolved by ${item.resolved_by}`);
        } else if (item.closed !== undefined && item.closed !== null && item.closed !== '') {
          const as = typeof item.closed?.as === 'string' ? ` as ${item.closed.as}` : '';
          warn('resolves', `resolves: backlog item ${ref} is already closed${as}`);
        }
      }
    }
  }

  // Rule 6: an approval is a hash freeze; any later edit invalidates it.
  if (!ignoreApproval && contract.approval !== undefined) {
    const hash = contract.approval?.hash;
    if (hash !== undefined && !isApprovalValid(contract)) {
      error('approval', 'approval hash does not match the contract content — changed after approval; re-approve');
    }
  }
  return problems;
}

// 1-based line/column for a character offset; used for parse error messages.
function lineCol(text, pos) {
  const before = text.slice(0, pos).split('\n');
  return { line: before.length, column: before[before.length - 1].length + 1 };
}

// Parses contract text, turning JSON errors into a message with file and position.
export function parseContract(text, file) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const m = /position (\d+)/.exec(e.message);
    const pos = m ? Number(m[1]) : (/end of JSON/i.test(e.message) ? text.length : jsonErrorOffset(text));
    const at = pos === null ? '' : (() => { const { line, column } = lineCol(text, pos); return ` at line ${line} column ${column}`; })();
    throw new HarnessError(`${file}: invalid JSON${at} — ${e.message}`, { code: 'contract_parse' });
  }
}

export function contractIds(root) {
  const dir = paths(root).contracts;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^F\d+\.json$/.test(f))
    .map((f) => f.slice(0, -'.json'.length))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

// Returns {contract, file, bytes}. Missing file → HarnessError code 'unknown_contract'.
export function loadContract(root, id) {
  if (!/^F\d+$/.test(id)) throw new HarnessError(`invalid contract id '${id}' (expected F<n>)`, { code: 'unknown_contract' });
  const file = paths(root).contract(id);
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') throw new HarnessError(`${file}: no such contract '${id}'`, { code: 'unknown_contract' });
    throw new HarnessError(`${file}: cannot read (${e.code})`, { code: 'io' });
  }
  return { contract: parseContract(buf.toString('utf8'), file), file, bytes: buf.length };
}

// Approved (or another of `statuses`), dependencies passed, and the frozen contract still
// matches its hash (AC-7).
export function executableFeatures(root, { statuses } = {}) {
  const { features } = loadFeatures(root);
  return runnableFeatures(features, { statuses }).filter((f) => {
    try {
      return isApprovalValid(loadContract(root, f.id).contract);
    } catch (e) {
      // A missing contract just means "not runnable"; a corrupt one stops the caller (SPEC E6).
      if (e instanceof HarnessError && e.code === 'unknown_contract') return false;
      throw e;
    }
  });
}
