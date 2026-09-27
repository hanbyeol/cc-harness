#!/usr/bin/env node
// Load stress: `node test/stress.mjs N` runs the whole test suite N times at once, the way
// several harness features verify at the same time on one machine. Exit 0 when every run
// passes; otherwise prints each failing test with the number of runs it failed in, exit 1.
// `--root <dir>` runs the suite of another checkout (used by the tests of this script).
// `--files <glob>` (relative to the root) runs only the matching test files — the load of the
// whole suite is not needed to stress a few timing-sensitive files.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandFileGlob } from '../lib/glob.mjs';
import { STDERR_TAIL_CHARS, appendTail } from '../lib/stress.mjs';

const USAGE = 'usage: node test/stress.mjs <N> [--root <dir>] [--files <glob>]   (N: positive integer)';

const args = process.argv.slice(2);
let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let filesGlob = null;
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--root' && args[i + 1] !== undefined) {
    root = path.resolve(args[i + 1]);
    i += 1;
  } else if (args[i] === '--files' && args[i + 1] !== undefined) {
    filesGlob = args[i + 1];
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

let testFiles = ['test/**/*.test.mjs'];
if (filesGlob !== null) {
  testFiles = expandFileGlob(filesGlob, root);
  if (testFiles.length === 0) {
    console.error(`stress: no test files match ${filesGlob} in ${root}`);
    process.exit(2);
  }
}

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
    const childEnv = { ...process.env, NODE_TEST_CONTEXT: undefined };
    // Test-only seam: lets a test of this script make the test-runner child itself crash
    // (STRESS_TEST_CHILD_NODE_OPTIONS becomes that child's own NODE_OPTIONS) without also
    // crashing this process, which inherits the same environment from its own parent.
    if (process.env.STRESS_TEST_CHILD_NODE_OPTIONS) childEnv.NODE_OPTIONS = process.env.STRESS_TEST_CHILD_NODE_OPTIONS;
    const child = spawn(process.execPath,
      ['--test', '--test-reporter=tap', ...testFiles],
      // NODE_TEST_CONTEXT (set when this runs under node --test) switches the nested runner
      // to a child protocol with no TAP on stdout — drop it, as t.mjs does.
      { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr = appendTail(stderr, d); });
    child.on('error', (e) => resolve({ code: null, failed: [`<cannot start the test runner: ${e.message}>`], stderrTail: '' }));
    child.on('close', (code) => {
      const failed = failedTests(stdout);
      const abnormal = code !== 0 && failed.length === 0;
      if (abnormal) failed.push(`<test runner exited ${code} without a failing test>`);
      resolve({ code, failed, stderrTail: abnormal ? stderr : '' });
    });
  });
}

const started = Date.now();
const what = filesGlob === null
  ? `test suite${n === 1 ? '' : 's'}`
  : `run${n === 1 ? '' : 's'} of ${testFiles.length} test file${testFiles.length === 1 ? '' : 's'}`;
console.log(`stress: running ${n} concurrent ${what} in ${root}`);
const runs = await Promise.all(Array.from({ length: n }, runSuite));

const counts = new Map();
const stderrTails = [];
let failedRuns = 0;
for (const run of runs) {
  if (run.code === 0) continue;
  failedRuns += 1;
  for (const name of new Set(run.failed)) counts.set(name, (counts.get(name) || 0) + 1);
  if (run.stderrTail) stderrTails.push(run.stderrTail);
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
for (const tail of stderrTails) {
  console.log(`  --- stderr (last ${STDERR_TAIL_CHARS} chars) ---`);
  console.log(tail);
}
process.exit(1);
