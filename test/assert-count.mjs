#!/usr/bin/env node
// Guards against weakening tests: `node test/assert-count.mjs [--base <ref>] [--root <dir>]`
// compares every test file in the working tree with its version at the merge base with
// <ref> (default: base_branch of .harness/config.json, else main). Exit 1 when a file that
// existed at the base has fewer assert calls, lost a test name, or was deleted; exit 0
// otherwise. New files and extra asserts or tests are fine. Exit 2 when the base cannot be resolved.
// With `--removes F<n>` the removes_tests prefixes of .harness/contracts/F<n>.json are approved
// removals: tests whose name matches a prefix may vanish (a file whose every test name matches may
// be deleted), and a file may lose as many asserts as the vanished matching test blocks held.
// Exit 2 when that contract is missing or has no removes_tests. Without --removes the removes_tests of
// the approved contracts added or changed since the merge base, and those at the merge base whose
// feature was todo, in_progress or blocked there, are used (printed on stdout).
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ref = null;
let removesId = null;
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === '--base' && args[i + 1]) ref = args[i + 1];
  else if (args[i] === '--root' && args[i + 1]) root = path.resolve(args[i + 1]);
  else if (args[i] === '--removes' && args[i + 1]) removesId = args[i + 1];
  else {
    console.error('usage: node test/assert-count.mjs [--base <ref>] [--root <dir>] [--removes F<n>]');
    process.exit(2);
  }
}

// removes_tests prefixes of the named contract; exits 2 naming the contract when there are none.
let prefixes = [];
if (removesId !== null) {
  let list;
  try {
    if (!/^F\d+$/.test(removesId)) throw new Error('not a contract id');
    list = JSON.parse(fs.readFileSync(path.join(root, '.harness', 'contracts', `${removesId}.json`), 'utf8')).removes_tests;
  } catch { list = undefined; }
  if (!Array.isArray(list) || list.length === 0 || !list.every((p) => typeof p === 'string')) {
    console.error(`assert-count: contract ${removesId} is missing or has no removes_tests`);
    process.exit(2);
  }
  prefixes = list;
}
const explicit = removesId !== null;
// Same rule as matchesRemoved in lib/contract.mjs (this file imports only node: built-ins).
const matches = (name) => prefixes.some((p) => name === p || name.startsWith(`${p} `) || name.startsWith(`${p}:`));

function git(...a) {
  const r = spawnSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

if (!ref) {
  try {
    ref = JSON.parse(fs.readFileSync(path.join(root, '.harness', 'config.json'), 'utf8')).base_branch;
  } catch { /* fall through to main */ }
  ref = ref || 'main';
}
const mergeBase = (git('merge-base', 'HEAD', ref) || '').trim();
if (!mergeBase) {
  console.error(`assert-count: cannot resolve a merge base of HEAD and "${ref}"`);
  process.exit(2);
}

// assert(...) and assert.xxx(...) calls (also t.assert.xxx) — one per verification.
function countAsserts(src) {
  return (src.match(/\bassert(?:\.\w+)*\s*\(/g) || []).length;
}
// Literal names passed to test(), it(), describe() and suite().
function testNames(src) {
  const names = [];
  for (const m of src.matchAll(/\b(?:test|it|describe|suite)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)) names.push(m[2]);
  return names;
}

// Asserts of the test blocks that begin at a line-start 'test(' and end before the next one,
// by block name.
function blockAsserts(src) {
  const out = [];
  const starts = [...src.matchAll(/^test\(/gm)].map((m) => m.index);
  starts.forEach((at, i) => {
    const block = src.slice(at, i + 1 < starts.length ? starts[i + 1] : src.length);
    const name = testNames(block)[0];
    if (name !== undefined) out.push({ name, asserts: countAsserts(block) });
  });
  return out;
}

// Without --removes: the removes_tests of every approved contract added or changed since the merge
// base (approval.hash equal to the contract's current hash, as hashContract in lib/contract.mjs).
if (!explicit) {
  const approved = [];
  const idOf = (file) => Number(file.match(/F(\d+)/)[1]);
  const contractFile = /^\.harness\/contracts\/F\d+\.json$/;
  // removes_tests of the contract at HEAD:<file> when it is approved (approval.hash equals its
  // current hash, as hashContract in lib/contract.mjs); null when it has none to offer.
  const approvedList = (file) => {
    const c = JSON.parse(git('show', `HEAD:${file}`) ?? '');
    if (c === null || typeof c !== 'object' || Array.isArray(c)) throw new Error('not a JSON object');
    if (c.removes_tests !== undefined && !Array.isArray(c.removes_tests)) throw new Error('removes_tests is not an array');
    const { approval, ...rest } = c;
    const hash = crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
    if (!Array.isArray(c.removes_tests) || typeof approval?.hash !== 'string' || approval.hash !== hash) return null;
    const list = c.removes_tests.filter((p) => typeof p === 'string');
    return list.length === 0 ? null : list;
  };
  const changed = (git('diff', '--name-only', '--diff-filter=AM', mergeBase, 'HEAD', '--', '.harness/contracts') || '')
    .split('\n').filter((f) => contractFile.test(f));
  for (const file of changed) {
    try {
      const list = approvedList(file);
      if (list) approved.push({ file, list });
    } catch (e) {
      console.error(`assert-count: skipped ${file}: ${e.message.split('\n')[0]}`);
    }
  }
  // Contracts already at the merge base and unchanged count while their feature was unfinished there.
  const atBase = (git('ls-tree', '--name-only', mergeBase, '--', '.harness/contracts/') || '')
    .split('\n').filter((f) => contractFile.test(f) && !changed.includes(f));
  let unfinished = new Set();
  const featuresText = atBase.length > 0 ? git('show', `${mergeBase}:.harness/features.json`) : null;
  if (featuresText !== null) {
    try {
      const parsed = JSON.parse(featuresText);
      const items = Array.isArray(parsed) ? parsed : parsed?.features;
      if (!Array.isArray(items)) throw new Error('no features array');
      unfinished = new Set(items.filter((f) => f && ['todo', 'in_progress', 'blocked'].includes(f.status)).map((f) => f.id));
    } catch (e) {
      console.error(`assert-count: skipped .harness/features.json: ${e.message.split('\n')[0]}`);
    }
  }
  for (const file of atBase) {
    if (!unfinished.has(path.basename(file, '.json'))) continue;
    try {
      const list = approvedList(file);
      if (list) approved.push({ file, list });
    } catch { /* a contract unreadable at HEAD offers nothing */ }
  }
  approved.sort((a, b) => idOf(a.file) - idOf(b.file));
  for (const { list } of approved) prefixes.push(...list);
  const approvedBy = approved.map(({ file }) => path.basename(file, '.json'));
  if (approvedBy.length > 0) console.log(`assert-count: removes_tests approved by ${approvedBy.join(', ')}`);
}
const active = prefixes.length > 0;

const files = (git('ls-tree', '-r', '--name-only', mergeBase, '--', 'test') || '')
  .split('\n').filter((f) => /\.test\.mjs$/.test(f));

const problems = [];
for (const file of files) {
  const before = git('show', `${mergeBase}:${file}`);
  if (before === null) continue;
  const abs = path.join(root, file);
  if (!fs.existsSync(abs)) {
    const names = testNames(before);
    if (active && names.length > 0 && names.every(matches)) continue;
    const unmatched = active ? names.filter((n) => !matches(n)) : [];
    if (unmatched.length) problems.push(`${file}: deleted, but test name not in removes_tests of ${explicit ? removesId : 'the approved contracts'}: "${unmatched[0]}"`);
    else problems.push(`${file}: deleted (had ${countAsserts(before)} asserts)`);
    continue;
  }
  const after = fs.readFileSync(abs, 'utf8');
  const nb = countAsserts(before);
  const na = countAsserts(after);
  const kept = new Set(testNames(after));
  let allowed = 0;
  if (active) {
    for (const b of blockAsserts(before)) if (!kept.has(b.name) && matches(b.name)) allowed += b.asserts;
  }
  if (na < nb - allowed) problems.push(`${file}: asserts ${nb} -> ${na}${active ? ` (at most ${allowed} may be removed)` : ''}`);
  for (const name of testNames(before)) {
    if (!kept.has(name) && !(active && matches(name))) problems.push(`${file}: test name removed or renamed: "${name}"`);
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`assert-count: ${p}`);
  console.error(`assert-count: ${problems.length} problem(s) against ${mergeBase.slice(0, 12)} (${ref})`);
  process.exit(1);
}
console.log(`assert-count: ${files.length} test files, none weakened against ${mergeBase.slice(0, 12)} (${ref})`);
