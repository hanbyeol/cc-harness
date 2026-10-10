import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import * as run from '../lib/run.mjs';

const lines = (file) => fs.readFileSync(path.join(REPO, file), 'utf8').split('\n').length - 1;

const EXPORTS = ['MAX_BUILD_ATTEMPTS', 'MAX_EVAL_ERRORS', 'INTEGRATION_WT', 'environmentFailure', 'FAILURE_MESSAGE_CHARS',
  'blockingIds', 'verdictBlockingIds', 'convergence', 'git', 'isSerializedGit', 'protectedSet', 'assertIntegrationName',
  'assertIntegrationAllowed', 'preflight', 'effectiveTier', 'MAX_PROMPT_FILES', 'builderPrompt', 'hasConflictMarkers',
  'conflictMarkedFiles', 'verifyBlocking', 'renderReport', 'availableCpus', 'verifyParallelFor', 'runFeatures'];

const MODULES = ['state', 'worktree', 'feature', 'merge', 'report'];

function runFiles() {
  const dir = path.join(REPO, 'lib', 'run');
  const out = ['lib/run.mjs'];
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith('.mjs')) out.push(`lib/run/${f}`);
  return out;
}

// The span of a top-level function: its first line to the next line that is only '}'.
function topLevelFunctions(file) {
  const src = fs.readFileSync(path.join(REPO, file), 'utf8').split('\n');
  const out = [];
  for (let i = 0; i < src.length; i += 1) {
    const m = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/.exec(src[i]);
    if (!m) continue;
    let j = i;
    while (j < src.length && src[j] !== '}') j += 1;
    out.push({ name: m[1], length: j - i + 1 });
  }
  return out;
}

test('F113 AC-1 lib/run.mjs is at most 400 lines and keeps its exports', () => {
  assert.ok(lines('lib/run.mjs') <= 400, `lib/run.mjs has ${lines('lib/run.mjs')} lines`);
  for (const name of EXPORTS) assert.ok(name in run, `${name} is not exported`);
  assert.equal(typeof run.runFeatures, 'function');
});

test('F113 AC-2 lib/run/ holds the five modules, each at most 600 lines, and runFeatures is at most 200', () => {
  for (const m of MODULES) {
    const file = `lib/run/${m}.mjs`;
    assert.ok(fs.existsSync(path.join(REPO, file)), `${file} is missing`);
    assert.ok(lines(file) <= 600, `${file} has ${lines(file)} lines`);
  }
  const fn = topLevelFunctions('lib/run.mjs').find((f) => f.name === 'runFeatures');
  assert.ok(fn, 'runFeatures is not defined in lib/run.mjs');
  assert.ok(fn.length <= 200, `runFeatures has ${fn.length} lines`);
});

test('F113 AC-3 no top-level function of lib/run.mjs or lib/run/*.mjs is over 250 lines', () => {
  for (const file of runFiles()) {
    for (const f of topLevelFunctions(file)) assert.ok(f.length <= 250, `${file}: ${f.name} has ${f.length} lines`);
  }
});
