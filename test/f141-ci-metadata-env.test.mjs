import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './helpers.mjs';
import { redactor, CI_METADATA_ENV } from '../lib/failures.mjs';
import { BASE_ENV_ALLOWLIST, filteredEnv, runCommand } from '../lib/exec.mjs';

const G1 = ['ACTION', 'ACTION_PATH', 'ACTION_REPOSITORY', 'ACTIONS', 'ACTOR', 'ACTOR_ID', 'API_URL', 'BASE_REF', 'ENV',
  'EVENT_NAME', 'EVENT_PATH', 'GRAPHQL_URL', 'HEAD_REF', 'JOB', 'OUTPUT', 'PATH', 'REF', 'REF_NAME', 'REF_PROTECTED',
  'REF_TYPE', 'REPOSITORY', 'REPOSITORY_ID', 'REPOSITORY_OWNER'].map((n) => `GITHUB_${n}`);
const G2 = ['REPOSITORY_OWNER_ID', 'RETENTION_DAYS', 'RUN_ATTEMPT', 'RUN_ID', 'RUN_NUMBER', 'SERVER_URL', 'SHA', 'STATE',
  'STEP_SUMMARY', 'TRIGGERING_ACTOR', 'WORKFLOW', 'WORKFLOW_REF', 'WORKFLOW_SHA', 'WORKSPACE'].map((n) => `GITHUB_${n}`);
const R = ['ARCH', 'DEBUG', 'ENVIRONMENT', 'NAME', 'OS', 'TEMP', 'TOOL_CACHE', 'WORKSPACE'].map((n) => `RUNNER_${n}`);
const REF = 'contracts/f135-f139';

test('F141 AC-1 CI_METADATA_ENV is frozen and holds the 23 GITHUB_ names', () => {
  assert.ok(Object.isFrozen(CI_METADATA_ENV));
  assert.equal(G1.length, 23);
  for (const n of G1) assert.ok(CI_METADATA_ENV.includes(n), n);
});

test('F141 AC-2 CI_METADATA_ENV holds 14 more GITHUB_ and 8 RUNNER_ names, 45 in all, no duplicates', () => {
  assert.equal(G2.length, 14);
  for (const n of [...G2, ...R]) assert.ok(CI_METADATA_ENV.includes(n), n);
  assert.equal(CI_METADATA_ENV.length, 45);
  assert.equal(new Set(CI_METADATA_ENV).size, 45);
});

test('F141 AC-3 the redactor leaves CI metadata values and their fragments alone', () => {
  const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const red = redactor({
    GITHUB_HEAD_REF: REF, GITHUB_REPOSITORY: 'hanbyeol/cc-harness', GITHUB_SHA: sha, RUNNER_TEMP: '/home/runner/work/_temp',
  });
  for (const t of ['criterion_not_in_contract', 'f135-f139 rest', `ref ${REF}`,
    'repo hanbyeol/cc-harness here', `sha ${sha} end`, 'dir /home/runner/work/_temp/x']) {
    assert.equal(red(t), t);
  }
});

test('F141 AC-4 the CI-failing tests pass with GITHUB_HEAD_REF set', () => {
  const run = (file, name) => spawnSync(process.execPath, ['test/t.mjs', name], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, GITHUB_HEAD_REF: REF },
  });
  for (const [f, name] of [['f5-eval', 'F5 AC-3'], ['f56-eval-events', 'F56 AC-1'], ['f75-finding-location', 'F75 AC-3'],
    ['f75-finding-location', 'F75 SC-1']]) {
    assert.ok(fs.readdirSync(path.join(REPO, 'test')).some((x) => x.startsWith(f)), f);
    const r = run(f, name);
    assert.equal(r.status, 0, `${name}\n${r.stdout}\n${r.stderr}`.slice(-2000));
  }
});

test('F141 AC-5 SPEC SR-2 describes CI_METADATA_ENV', () => {
  const sr2 = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8').split('\n').find((l) => l.startsWith('- SR-2 '));
  for (const s of ['CI_METADATA_ENV', 'lib/failures.mjs', 'SR-8', 'GITHUB_TOKEN', 'ACTIONS_']) assert.ok(sr2.includes(s), s);
});

test('F141 SC-1 secret GitHub variables are still redacted', () => {
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_CACHE_URL', 'ACTIONS_RESULTS_URL']) {
    const v = `${name.toLowerCase()}-s3cr3tvalue`;
    const red = redactor({ [name]: v });
    assert.equal(red(`a ${v} b`), 'a [redacted] b', name);
    assert.equal(red(`${v.slice(5)} rest`), '[redacted] rest', name);
    assert.equal(red(`pre ${v.slice(0, -4)}`), 'pre [redacted]', name);
  }
});

test('F141 SC-2 the fragment rule still applies to names outside the list', () => {
  const red = redactor({ MY_REF: REF });
  assert.equal(red('criterion_not_in_contract'), 'criterion_not_in_[redacted]');
  assert.equal(red('f135-f139 rest'), '[redacted] rest');
  const both = redactor({ GITHUB_HEAD_REF: REF, MY_REF: REF });
  assert.equal(both(`ref ${REF}`), 'ref [redacted]');
  assert.equal(both('f135-f139 rest'), '[redacted] rest');
});

test('F141 SC-3 CI metadata names never reach a command environment', async () => {
  const src = { PATH: process.env.PATH, GITHUB_ENV: '/x/env', GITHUB_OUTPUT: '/x/out', GITHUB_PATH: '/x/path',
    GITHUB_STEP_SUMMARY: '/x/sum', GITHUB_STATE: '/x/state', GITHUB_HEAD_REF: REF };
  for (const n of CI_METADATA_ENV) assert.ok(!BASE_ENV_ALLOWLIST.includes(n) || n === 'x', n);
  assert.deepEqual(filteredEnv([], src), { PATH: process.env.PATH });
  const saved = { ...process.env };
  Object.assign(process.env, src);
  try {
    const r = await runCommand(`"${process.execPath}" -e "process.stdout.write(Object.keys(process.env).filter((k)=>k.startsWith('GITHUB_')).join())"`,
      { cwd: REPO, timeoutSec: 60 });
    assert.equal(r.stdout.trim(), '');
  } finally {
    for (const k of Object.keys(src)) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; }
  }
});

test('F141 ES-1 empty, short and non-string values are skipped without throwing', () => {
  const red = redactor({ GITHUB_HEAD_REF: '', GITHUB_REF: 'main', GITHUB_RUN_ID: 12345678, GITHUB_JOB: undefined }, ['GITHUB_HEAD_REF']);
  assert.equal(red('x main 12345678 y'), 'x main 12345678 y');
});
