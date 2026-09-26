#!/usr/bin/env node
// Guards against weakening tests: `node test/assert-count.mjs [--base <ref>] [--root <dir>]`
// compares every test file in the working tree with its version at the merge base with
// <ref> (default: base_branch of .harness/config.json, else main). Exit 1 when a file that
// existed at the base has fewer assert calls, lost a test name, or was deleted; exit 0
// otherwise. New files and extra asserts or tests are fine. Exit 2 when the base cannot be resolved.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ref = null;
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === '--base' && args[i + 1]) ref = args[i + 1];
  else if (args[i] === '--root' && args[i + 1]) root = path.resolve(args[i + 1]);
  else {
    console.error('usage: node test/assert-count.mjs [--base <ref>] [--root <dir>]');
    process.exit(2);
  }
}

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

const files = (git('ls-tree', '-r', '--name-only', mergeBase, '--', 'test') || '')
  .split('\n').filter((f) => /\.test\.mjs$/.test(f));

const problems = [];
for (const file of files) {
  const before = git('show', `${mergeBase}:${file}`);
  if (before === null) continue;
  const abs = path.join(root, file);
  if (!fs.existsSync(abs)) {
    problems.push(`${file}: deleted (had ${countAsserts(before)} asserts)`);
    continue;
  }
  const after = fs.readFileSync(abs, 'utf8');
  const nb = countAsserts(before);
  const na = countAsserts(after);
  if (na < nb) problems.push(`${file}: asserts ${nb} -> ${na}`);
  const kept = new Set(testNames(after));
  for (const name of testNames(before)) {
    if (!kept.has(name)) problems.push(`${file}: test name removed or renamed: "${name}"`);
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`assert-count: ${p}`);
  console.error(`assert-count: ${problems.length} problem(s) against ${mergeBase.slice(0, 12)} (${ref})`);
  process.exit(1);
}
console.log(`assert-count: ${files.length} test files, none weakened against ${mergeBase.slice(0, 12)} (${ref})`);
