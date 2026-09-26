#!/usr/bin/env node
// Test count for verify.test_count (SPEC §6.2-3): runs the suite and prints the number
// of tests as the last stdout line. Failing tests still count — verify.commands judges
// pass/fail; this only guards against tests disappearing.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const res = spawnSync(process.execPath,
  ['--test', '--test-reporter=tap', 'test/**/*.test.mjs'],
  // NODE_TEST_CONTEXT (set when this runs under node --test) switches the nested runner
  // to a child protocol with no TAP on stdout — drop it, as t.mjs does.
  { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });

// The run summary is the last '# tests N' line.
const counts = [...(res.stdout || '').matchAll(/^# tests (\d+)$/gm)];
if (counts.length === 0) {
  process.stderr.write(res.stderr || '');
  console.error('count.mjs: no "# tests N" summary in the test runner output');
  process.exit(1);
}
console.log(counts[counts.length - 1][1]);
