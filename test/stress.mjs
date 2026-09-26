#!/usr/bin/env node
// Load stress: `node test/stress.mjs N` runs the whole test suite N times at once, the way
// several harness features verify at the same time on one machine. Exit 0 when every run
// passes; otherwise prints each failing test with the number of runs it failed in, exit 1.
// `--root <dir>` runs the suite of another checkout (used by the tests of this script).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: node test/stress.mjs <N> [--root <dir>]   (N: positive integer)';

const args = process.argv.slice(2);
let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--root' && args[i + 1] !== undefined) {
    root = path.resolve(args[i + 1]);
    i += 1;
  } else {
    positional.push(args[i]);
  }
}
if (positional.length !== 1 || !/^[1-9]\d*$/.test(positional[0])) {
  console.error(USAGE);
  process.exit(2);
}
const n = Number(positional[0]);

// Failing leaf tests of one TAP run. node prints a test's children before its own line,
// so a failed parent (suite, file) that already has failed children is not reported itself.
function failedTests(tap) {
  const entries = [];
  for (const line of tap.split('\n')) {
    const m = /^(\s*)not ok \d+ - (.*?)(\s+# .*)?$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const kids = entries.filter((e) => !e.claimed && e.indent > indent);
    for (const k of kids) k.claimed = true;
    entries.push({ indent, name: m[2], leaf: kids.length === 0, claimed: false });
  }
  return entries.filter((e) => e.leaf).map((e) => e.name);
}

function runSuite() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath,
      ['--test', '--test-reporter=tap', 'test/**/*.test.mjs'],
      // NODE_TEST_CONTEXT (set when this runs under node --test) switches the nested runner
      // to a child protocol with no TAP on stdout — drop it, as t.mjs does.
      { cwd: root, env: { ...process.env, NODE_TEST_CONTEXT: undefined }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.resume();
    child.on('error', (e) => resolve({ code: null, failed: [`<cannot start the test runner: ${e.message}>`] }));
    child.on('close', (code) => {
      const failed = failedTests(stdout);
      if (code !== 0 && failed.length === 0) failed.push(`<test runner exited ${code} without a failing test>`);
      resolve({ code, failed });
    });
  });
}

const started = Date.now();
console.log(`stress: running ${n} concurrent test suite${n === 1 ? '' : 's'} in ${root}`);
const runs = await Promise.all(Array.from({ length: n }, runSuite));

const counts = new Map();
let failedRuns = 0;
for (const run of runs) {
  if (run.code === 0) continue;
  failedRuns += 1;
  for (const name of new Set(run.failed)) counts.set(name, (counts.get(name) || 0) + 1);
}
const seconds = Math.round((Date.now() - started) / 1000);
if (failedRuns === 0) {
  console.log(`stress: all ${n} runs passed (${seconds}s)`);
  process.exit(0);
}
console.log(`stress: ${failedRuns} of ${n} runs failed (${seconds}s)`);
for (const [name, count] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  FAILED ${name} — failed in ${count}/${n} runs`);
}
process.exit(1);
