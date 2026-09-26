import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BIN, REPO, tmpdir } from './helpers.mjs';
import { git, gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { verify as realVerify, missingProgram } from '../lib/verify.mjs';
import { runFeatures, renderReport, FAILURE_MESSAGE_CHARS } from '../lib/run.mjs';

const FAKE_CLI = path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs');
const TOOL = 'harness-f29-tool';

// ------------------------------------------------------------------ fixtures

function contract(id, check = 'node scripts/ok.mjs') {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check, new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-26T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

// features: [{id, check?}]
function fixture(features = [{ id: 'F1' }]) {
  const files = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: features.map((f) => ({ id: f.id, title: `feature ${f.id}`, security_tier: 'standard', depends_on: [], status: 'approved' })) },
    'scripts/ok.mjs': 'process.exit(0);\n',
    'scripts/fail.mjs': 'process.exit(1);\n',
    'scripts/long.mjs': "process.stderr.write('E'.repeat(1000) + '\\n');\nprocess.exit(1);\n",
    'scripts/leak.mjs': "console.log('SECRET_TOKEN=' + process.env.SECRET_TOKEN);\nconsole.log('SECRET_TOKEN=sk-test-secret');\nprocess.exit(1);\n",
  };
  for (const f of features) files[`.harness/contracts/${f.id}.json`] = contract(f.id, f.check);
  return gitRepo(files, { branch: null });
}

const cfg = (over = {}) => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, ...over });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const statusOf = (dir, id = 'F1') => readJson(path.join(dir, '.harness/features.json')).features.find((f) => f.id === id).status;
const statePath = (dir) => path.join(dir, '.harness/runs/current.json');
const backlog = (dir) => readJson(path.join(dir, '.harness/backlog.json')).items;
const real = (p) => path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
const isIntegration = (cwd) => real(cwd).endsWith(`${path.sep}_integration`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalResult = (a, over = {}) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null, ...over });

function fakeBuild({ delay = () => 0, wait = async () => {} } = {}) {
  const calls = [];
  const fn = async (a) => {
    const c = { featureId: a.featureId, round: a.round, attempt: a.attempt, done: false, aborted: false };
    calls.push(c);
    await wait(a);
    await sleep(delay(a));
    writeFiles(a.cwd, { [`${a.featureId}.txt`]: `built r${a.round}\n` });
    c.done = true;
    c.aborted = !!a.signal?.aborted;
    return { ok: true, costUsd: 0.5 };
  };
  fn.calls = calls;
  return fn;
}

// A directory holding TOOL (exit 0), put on PATH only while `withTool` runs.
const toolDir = (() => {
  const dir = tmpdir('harness-f29-bin-');
  fs.writeFileSync(path.join(dir, TOOL), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, `${TOOL}.cmd`), '@exit /b 0\r\n');
  return dir;
})();
const pathKey = () => Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
async function withTool(fn) {
  const key = pathKey();
  const saved = process.env[key];
  process.env[key] = `${toolDir}${path.delimiter}${saved}`;
  try { return await fn(); } finally { process.env[key] = saved; }
}

function run(dir, deps = {}, { config, ...opts } = {}) {
  const logs = [];
  const p = runFeatures({
    root: dir, config: cfg(config),
    deps: { evaluate: async (a) => evalResult(a), log: (m) => logs.push(m), ...deps },
    ...opts,
  });
  return p.then((r) => ({ ...r, logs, out: logs.join('\n') }));
}

function assertEnvStop(dir, r, { stage = 'verify', item } = {}) {
  assert.equal(r.interrupted, true, `${r.out}\n${JSON.stringify(r.results)}`);
  assert.equal(r.environment?.feature, 'F1');
  assert.equal(r.environment?.stage, stage);
  assert.equal(r.environment?.program, TOOL);
  if (item) assert.equal(r.environment?.item, item);
  assert.deepEqual(r.results, [], 'no feature result: nothing was blocked');
  assert.equal(statusOf(dir), 'in_progress', 'status is not blocked');
  assert.deepEqual(backlog(dir), [], 'no re-scope proposal');
  for (const w of [TOOL, 'command not found', 'harness run --resume']) assert.ok(r.out.includes(w), `${w} in: ${r.out}`);
  const saved = readJson(statePath(dir));
  assert.equal(saved.active.length, 1);
  assert.equal(saved.active[0].feature, 'F1');
  assert.equal(saved.active[0].round, 1);
  // A post-merge stop comes after the passing evaluation of round 1; no failing round is recorded.
  assert.deepEqual(saved.active[0].history, stage === 'post_merge_verify' ? [[]] : []);
  return saved;
}

// ------------------------------------------------------------------ AC-1
test('F29 AC-1 a verify command that is not installed stops the run for --resume; the feature is not blocked', async () => {
  const dir = fixture();
  const build = fakeBuild();
  const r = await run(dir, { build }, { config: { verify: { commands: [`${TOOL} --check`] } } });
  const saved = assertEnvStop(dir, r, { item: `${TOOL} --check` });
  assert.equal(build.calls.length, 1, 'no build retry for a missing program');
  assert.equal(saved.active[0].attemptsDone ?? 0, 0, 'the build attempt is not consumed');
  assert.equal(saved.active[0].built, 1, 'the build is kept: resume verifies it again');
});

test('F29 AC-1 a test_count command that is not installed stops the run the same way', async () => {
  const dir = fixture();
  const r = await run(dir, { build: fakeBuild() }, { config: { verify: { commands: [], test_count: TOOL } } });
  assertEnvStop(dir, r, { item: 'test_count' });
});

test('F29 AC-1 a criterion check whose program is not installed stops the run the same way', async () => {
  const dir = fixture([{ id: 'F1', check: `${TOOL} AC-1` }]);
  const r = await run(dir, { build: fakeBuild() });
  assertEnvStop(dir, r, { item: 'AC-1' });
});

test('F29 AC-1 a post-merge verify with a missing program rolls the merge back, then stops the run', async () => {
  const dir = fixture();
  const before = git(dir, 'rev-parse', 'main');
  // The program exists for the feature verify and is gone for the post-merge verify.
  const verify = async (a) => (isIntegration(a.cwd) ? realVerify(a) : withTool(() => realVerify(a)));
  const r = await run(dir, { build: fakeBuild(), verify }, { config: { verify: { commands: [TOOL] } } });
  const saved = assertEnvStop(dir, r, { stage: 'post_merge_verify', item: TOOL });
  assert.equal(git(dir, 'rev-parse', 'harness/integration'), before, 'integration is back at its pre-merge commit');
  assert.equal(saved.active[0].stage, 'merge');
  assert.equal(git(path.join(dir, '.harness/wt/_integration'), 'status', '--porcelain'), '');
});

test('F29 AC-1 the missing program is the one the shell names, else the first word', () => {
  assert.equal(missingProgram('npm test', { stderr: '/bin/sh: 1: jest: not found\n' }), 'jest');
  assert.equal(missingProgram('npm test', { stderr: 'sh: line 1: jest: command not found\n' }), 'jest');
  assert.equal(missingProgram('npm test', { stderr: 'bash: jest: command not found\n' }), 'jest');
  assert.equal(missingProgram('npm test', { stderr: 'zsh:1: command not found: jest\n' }), 'jest');
  assert.equal(missingProgram('npm test', { stderr: "'jest' is not recognized as an internal or external command,\r\n" }), 'jest');
  assert.equal(missingProgram('pytest -q', { stderr: '' }), 'pytest');
});

test('F29 AC-1 the CLI prints the program, "command not found" and the --resume hint for an environment stop', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'commands', 'run.mjs'), 'utf8');
  assert.ok(/r\.environment/.test(src) && /command not found/.test(src) && /harness run --resume/.test(src));
});

// ------------------------------------------------------------------ AC-2
test('F29 AC-2 resume with the program installed verifies the same build and passes without using a round', async () => {
  const dir = fixture();
  const build = fakeBuild();
  const config = { verify: { commands: [TOOL] } };
  const r1 = await run(dir, { build }, { config });
  assertEnvStop(dir, r1);
  const rounds = [];
  const r2 = await withTool(() => run(dir, { build, evaluate: async (a) => { rounds.push(a.round); return evalResult(a); } }, { resume: true }));
  assert.equal(r2.environment, undefined, r2.out);
  assert.equal(r2.results[0].status, 'passed', r2.out);
  assert.equal(r2.results[0].rounds, 1, 'still round 1');
  assert.deepEqual(rounds, [1]);
  assert.equal(build.calls.length, 1, 'the build was not redone');
  assert.equal(statusOf(dir), 'passed');
  assert.ok(!fs.existsSync(statePath(dir)));
});

test('F29 AC-2 resume after a post-merge environment stop merges again and passes', async () => {
  const dir = fixture();
  const build = fakeBuild();
  const config = { verify: { commands: [TOOL] } };
  const verify = async (a) => (isIntegration(a.cwd) ? realVerify(a) : withTool(() => realVerify(a)));
  const r1 = await run(dir, { build, verify }, { config });
  assertEnvStop(dir, r1, { stage: 'post_merge_verify' });
  let evals = 0;
  const r2 = await withTool(() => run(dir, { build, evaluate: async (a) => { evals += 1; return evalResult(a); } }, { resume: true }));
  assert.equal(r2.results[0].status, 'passed', r2.out);
  assert.equal(r2.results[0].rounds, 1);
  assert.equal(evals, 0, 'the passed evaluation is not redone');
  assert.equal(build.calls.length, 1);
  assert.equal(git(dir, 'show', 'harness/integration:F1.txt'), 'built r1');
});

// ------------------------------------------------------------------ AC-3
test('F29 AC-3 parallel: an environment stop starts no new feature, lets the running build finish and keeps every feature in the state file', async () => {
  const dir = fixture([{ id: 'F1', check: `${TOOL} AC-1` }, { id: 'F2' }, { id: 'F3' }]);
  // F2's build is still running when F1's verify meets the missing program, and ends after it.
  let f1Verified = false;
  const wait = async (a) => {
    if (a.featureId !== 'F2') return;
    for (let t = 0; t < 60000 && !f1Verified; t += 50) await sleep(50);
  };
  const build = fakeBuild({ wait, delay: (a) => (a.featureId === 'F2' ? 500 : 0) });
  const verified = [];
  const verify = async (a) => {
    verified.push(a.featureId);
    const v = await realVerify(a);
    if (a.featureId === 'F1') f1Verified = true;
    return v;
  };
  const r = await run(dir, { build, verify }, { parallel: 2 });
  assert.equal(r.interrupted, true, r.out);
  assert.equal(r.environment?.feature, 'F1');
  assert.deepEqual(r.results, []);
  const f2 = build.calls.filter((c) => c.featureId === 'F2');
  assert.equal(f2.length, 1);
  assert.ok(f2[0].done && !f2[0].aborted, 'F2 finished its build step, not aborted');
  assert.ok(!verified.includes('F2'), 'F2 did not start its next step (verify)');
  assert.equal(build.calls.filter((c) => c.featureId === 'F3').length, 0, 'F3 was not started');
  assert.equal(statusOf(dir, 'F3'), 'approved');
  const saved = readJson(statePath(dir));
  assert.deepEqual(saved.active.map((e) => e.feature).sort(), ['F1', 'F2']);
  assert.equal(saved.active.find((e) => e.feature === 'F2').built, 1, 'F2 build is recorded for resume');
  // Resume with the program installed: both continue, F3 runs, all pass.
  const r2 = await withTool(() => run(dir, { build }, { resume: true, parallel: 2 }));
  assert.deepEqual(r2.results.map((x) => [x.feature, x.status]).sort(), [['F1', 'passed'], ['F2', 'passed'], ['F3', 'passed']], r2.out);
  assert.equal(build.calls.filter((c) => c.featureId === 'F2').length, 1, 'F2 is not rebuilt');
});

// ------------------------------------------------------------------ AC-4
test('F29 AC-4 a feature blocked by verify lists the failed command and criterion with the first 300 characters of the message', async () => {
  const dir = fixture([{ id: 'F1', check: 'node scripts/fail.mjs' }]);
  const r = await run(dir, { build: fakeBuild() }, { config: { max_rounds: 1, verify: { commands: ['node scripts/long.mjs'] } } });
  assert.equal(r.results[0].status, 'blocked', r.out);
  assert.equal(r.results[0].reason, 'max_rounds');
  const md = fs.readFileSync(r.report, 'utf8');
  const cmdLine = md.split('\n').find((l) => l.startsWith('- failed: `node scripts/long.mjs`'));
  assert.ok(cmdLine, md);
  assert.match(cmdLine, /exit 1: E{10}/);
  const msg = cmdLine.slice(cmdLine.indexOf(' — ') + 3);
  assert.equal(msg.length, FAILURE_MESSAGE_CHARS, 'the message is cut at 300 characters');
  assert.ok(md.split('\n').some((l) => l.startsWith('- failed: `AC-1` — exit 1')), md);
});

test('F29 AC-4 a feature blocked by the post-merge verify lists the failed command in the report', async () => {
  const dir = fixture();
  const verify = async (a) => realVerify(isIntegration(a.cwd) ? { ...a, config: { ...a.config, verify: { commands: ['node scripts/fail.mjs'] } } } : a);
  const r = await run(dir, { build: fakeBuild(), verify });
  assert.equal(r.results[0].status, 'blocked', r.out);
  assert.equal(r.results[0].reason, 'post_merge_verify');
  const md = fs.readFileSync(r.report, 'utf8');
  assert.ok(md.split('\n').some((l) => l.startsWith('- failed: `node scripts/fail.mjs` — exit 1')), md);
});

test('F29 AC-4 renderReport shows failed items only for features that have them', () => {
  const state = {
    runId: 'x', startedAt: 's', config: { integration_branch: 'i', base_branch: 'main' }, costUsd: 0, stopped: null,
    results: [{ feature: 'F1', title: 't', status: 'blocked', reason: 'stall', detail: null, rounds: 2, history: [['AC-1'], ['AC-1']], failures: [{ item: 'npm test', message: 'exit 1: boom' }] },
      { feature: 'F2', title: 't', status: 'blocked', reason: 'stall', detail: null, rounds: 2, history: [['AC-1'], ['AC-1']] }],
  };
  const md = renderReport(state, { finishedAt: 'f' });
  assert.equal(md.split('\n').filter((l) => l.startsWith('- failed:')).length, 1);
  assert.match(md, /- failed: `npm test` — exit 1: boom/);
});

// ------------------------------------------------------------------ AC-5
test('F29 AC-5 an ordinary verify failure (exit 1) still fails rounds and blocks the feature', async () => {
  const dir = fixture();
  const build = fakeBuild();
  const r = await run(dir, { build }, { config: { verify: { commands: ['node scripts/fail.mjs'] } } });
  assert.equal(r.environment, undefined);
  assert.equal(r.interrupted, false);
  assert.equal(r.results[0].status, 'blocked');
  assert.equal(r.results[0].reason, 'stall');
  assert.equal(r.results[0].rounds, 2);
  assert.equal(build.calls.length, 6, 'three attempts in each of two rounds');
  assert.equal(statusOf(dir), 'blocked');
  assert.ok(!fs.existsSync(statePath(dir)));
});

test('F29 AC-5 an ordinary post-merge verify failure is blocked(post_merge_verify) as before', async () => {
  const dir = fixture();
  const verify = async (a) => realVerify(isIntegration(a.cwd) ? { ...a, config: { ...a.config, verify: { commands: ['node scripts/fail.mjs'] } } } : a);
  const r = await run(dir, { build: fakeBuild(), verify });
  assert.equal(r.environment, undefined);
  assert.equal(r.results[0].status, 'blocked');
  assert.equal(r.results[0].reason, 'post_merge_verify');
});

// ------------------------------------------------------------------ AC-6
test('F29 AC-6 SPEC §8 and README describe the environment stop and the failed items in the report', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s8 = spec.slice(spec.indexOf('## 8.'), spec.indexOf('## 9.'));
  const env = s8.split('\n').find((l) => l.includes('환경 실패'));
  assert.ok(env, 'no environment-stop rule in §8');
  for (const w of ['127', '9009', 'not recognized', 'ENOENT', 'verify.commands', 'test_count', 'check', 'harness run --resume', 'command not found', '라운드', '되돌린']) {
    assert.ok(env.includes(w), w);
  }
  const rep = s8.split('\n').find((l) => l.includes('실패 항목'));
  assert.ok(rep, 'no failed-items rule in §8');
  for (const w of ['300자', '기준 id', '명령']) assert.ok(rep.includes(w), w);
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  for (const re of [/command not found/, /harness run --resume/, /300자/]) assert.match(readme, re);
});

// ------------------------------------------------------------------ SC-1
test('F29 SC-1 failure messages in the report carry no value of an environment variable outside env_allowlist', async () => {
  const dir = fixture();
  const saved = process.env.SECRET_TOKEN;
  process.env.SECRET_TOKEN = 'sk-test-secret';
  let r;
  try {
    r = await run(dir, { build: fakeBuild() }, { config: { max_rounds: 1, verify: { commands: ['node scripts/leak.mjs'] } } });
  } finally {
    if (saved === undefined) delete process.env.SECRET_TOKEN; else process.env.SECRET_TOKEN = saved;
  }
  assert.equal(r.results[0].status, 'blocked', r.out);
  const md = fs.readFileSync(r.report, 'utf8');
  assert.ok(md.includes('- failed: `node scripts/leak.mjs`'), md);
  assert.ok(!md.includes('sk-test-secret'), md);
  assert.ok(md.includes('SECRET_TOKEN=[redacted]'), 'the literal value is redacted');
  assert.ok(!JSON.stringify(backlog(dir)).includes('sk-test-secret'));
});

// ------------------------------------------------------------------ ES-1
test('F29 ES-1 resume while the program is still missing stops again with exit 1, no builder call, no round or cost used', { timeout: 120000 }, async () => {
  const dir = fixture();
  const marker = path.join(tmpdir('harness-f29-builder-'), 'called');
  const config = {
    verify: { commands: [TOOL] },
    roles: { builder: 'generic', evaluator: 'generic', 'security-reviewer': 'generic' },
    adapters: { generic: { command: [process.execPath, FAKE_CLI, 'sleep', marker], read_only_command: [process.execPath, FAKE_CLI, 'echo-args'] } },
  };
  const build = fakeBuild();
  const r1 = await run(dir, { build }, { config });
  assertEnvStop(dir, r1);
  const before = readJson(statePath(dir));
  const cli = spawnSync(process.execPath, [BIN, 'run', '--resume'], { cwd: dir, encoding: 'utf8', timeout: 90000 });
  const out = cli.stdout + cli.stderr;
  assert.equal(cli.status, 1, out);
  for (const w of [TOOL, 'command not found', 'harness run --resume']) assert.ok(out.includes(w), `${w} in: ${out}`);
  assert.ok(!fs.existsSync(marker), 'the builder was not called');
  const after = readJson(statePath(dir));
  assert.equal(after.costUsd, before.costUsd, 'no cost');
  assert.equal(after.active[0].round, 1, 'no round');
  assert.equal(after.active[0].attemptsDone ?? 0, before.active[0].attemptsDone ?? 0, 'no build attempt');
  assert.deepEqual(after.results, []);
  assert.equal(statusOf(dir), 'in_progress');
});
