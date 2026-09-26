import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { writeJsonAtomic } from '../lib/state.mjs';
import { verify as realVerify } from '../lib/verify.mjs';
import { evaluate } from '../lib/eval.mjs';
import { runFeatures } from '../lib/run.mjs';

const SECRET = 'sk-test-secret';
const ALLOWED = 'visible-value-123'; // an env_allowlist variable: never redacted
const SHORT = 'abc1234'; // 7 characters: below the redaction length
const REGEX = 'x.*+?[]()y-secret'; // regex special characters in a secret value
const ENV = { ...process.env, SECRET_TOKEN: SECRET, ALLOWED_VAR: ALLOWED, SHORT_VAR: SHORT, REGEX_VAR: REGEX };

// ------------------------------------------------------------------ fixtures

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-26T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

const LEAK_LINES = [
  `SECRET_TOKEN=${SECRET}`, `ALLOWED_VAR=${ALLOWED}`, `SHORT_VAR=${SHORT}`,
  `REGEX_VAR=${REGEX}`, 'near misses: xAAy-secret x.*+?[]()y x-secret',
];

function fixture() {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract('F1'),
    'scripts/ok.mjs': 'process.exit(0);\n',
    'scripts/leak.mjs': `${LEAK_LINES.map((l) => `console.log(${JSON.stringify(l)});`).join('\n')}\nprocess.exit(1);\n`,
  }, { branch: null });
}

const cfg = (over = {}) => resolveConfig({
  base_branch: 'main', verify: { commands: ['node scripts/leak.mjs'] }, budget: { step_timeout_sec: 60 },
  env_allowlist: ['ALLOWED_VAR'], ...over,
});
const statePath = (dir) => path.join(dir, '.harness/runs/current.json');
const evalPass = (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });

// Every state file write, as the text that reaches the disk.
function spyWrites() {
  const writes = [];
  const fn = (file, data, opts) => {
    writes.push({ file, text: JSON.stringify(data) });
    return writeJsonAtomic(file, data, opts);
  };
  fn.writes = writes;
  return fn;
}

// Builder that interrupts the run at attempt 2 of round 1 — after one failed verify was saved.
function interruptingBuild(ac) {
  return async (a) => {
    if (a.attempt === 2) ac.abort();
    writeFiles(a.cwd, { 'F1.txt': `built r${a.round}.${a.attempt}\n` });
    return { ok: true, costUsd: 0 };
  };
}

async function runBlocked() {
  const dir = fixture();
  const spy = spyWrites();
  const build = async (a) => { writeFiles(a.cwd, { 'F1.txt': `built ${a.attempt}\n` }); return { ok: true, costUsd: 0 }; };
  const r = await runFeatures({
    root: dir, config: cfg({ max_rounds: 1 }),
    deps: { build, verify: realVerify, evaluate: async (a) => evalPass(a), env: ENV, writeJsonAtomic: spy },
  });
  return { dir, r, writes: spy.writes };
}

async function runInterrupted() {
  const dir = fixture();
  const spy = spyWrites();
  const ac = new AbortController();
  const r = await runFeatures({
    root: dir, config: cfg(), signal: ac.signal,
    deps: { build: interruptingBuild(ac), verify: realVerify, evaluate: async (a) => evalPass(a), env: ENV, writeJsonAtomic: spy },
  });
  return { dir, r, writes: spy.writes };
}

// The saved state file carries the failed verify's full result, redacted, and no secret.
function assertStateRedacted(text) {
  const last = JSON.stringify(JSON.parse(text).active[0]?.lastVerify ?? null);
  assert.ok(last.includes('SECRET_TOKEN=[redacted]'), `the last verify is saved, redacted: ${last.slice(0, 2000)}`);
  assert.ok(!text.includes(SECRET), text);
}

// ------------------------------------------------------------------ AC-1
test('F34 AC-1 a blocked run never wrote the secret to current.json', async () => {
  const { dir, r, writes } = await runBlocked();
  assert.equal(r.results[0].status, 'blocked', JSON.stringify(r.results));
  assert.ok(writes.length > 0, 'the state file was written');
  assert.ok(writes.some((w) => w.text.includes('SECRET_TOKEN=[redacted]')), 'the failed verify was saved');
  for (const w of writes) assert.ok(!w.text.includes(SECRET), w.text);
  if (fs.existsSync(statePath(dir))) assert.ok(!fs.readFileSync(statePath(dir), 'utf8').includes(SECRET));
  assert.ok(!fs.readFileSync(r.report, 'utf8').includes(SECRET));
});

test('F34 AC-1 a run stopped by SIGINT leaves current.json without the secret', async () => {
  const { dir, r } = await runInterrupted();
  assert.equal(r.interrupted, true);
  assertStateRedacted(fs.readFileSync(statePath(dir), 'utf8'));
});

// ------------------------------------------------------------------ AC-2
test('F34 AC-2 the verdict (verify_failures, blocking) and backlog.json carry no secret', async () => {
  const dir = fixture();
  const config = cfg({
    roles: { builder: 'claude', evaluator: 'generic', 'security-reviewer': 'generic' },
    adapters: { generic: { read_only_command: [process.execPath, '-e', 'process.exit(1)'] } },
  });
  const vr = await realVerify({ root: dir, cwd: dir, featureId: 'F1', base: 'main', config });
  assert.equal(vr.pass, false);
  const scores = { functionality: 3, quality: 9, security: 9, errors: 9, tests: 9 };
  const json = {
    scores,
    findings: [
      { criterion_id: 'AC-1', dimension: 'functionality', summary: `verify prints SECRET_TOKEN=${SECRET}`, repro: 'node scripts/leak.mjs' },
      { criterion_id: '', dimension: 'security', summary: `token ${SECRET} is logged`, repro: `echo ${SECRET}` },
      // A criterion id outside the contract is the reviewer's own text and goes to the backlog.
      { criterion_id: `SECRET_TOKEN=${SECRET}`, dimension: 'security', summary: 'x', repro: 'false' },
      { criterion_id: '', summary: 'y', backlog_id: `B-${SECRET}` },
    ],
    out_of_scope: [{ summary: `rotate ${SECRET}` }],
  };
  const runAdapter = async () => ({ ok: true, error: null, text: JSON.stringify(json), json, costUsd: 0, exitCode: 0 });
  const v = await evaluate({ root: dir, featureId: 'F1', base: 'main', config, verifyResult: vr, runAdapter, env: ENV });
  assert.equal(v.verdict, 'fail');
  const verdict = fs.readFileSync(v.file, 'utf8');
  assert.ok(verdict.includes('[redacted]'), verdict);
  assert.ok(JSON.parse(verdict).verify_failures.length > 0);
  assert.equal(JSON.parse(verdict).blocking.length, 1, verdict);
  assert.ok(!verdict.includes(SECRET), verdict);
  const backlog = fs.readFileSync(path.join(dir, '.harness/backlog.json'), 'utf8');
  assert.ok(JSON.parse(backlog).items.length >= 2, backlog);
  assert.ok(!backlog.includes(SECRET), backlog);
});

// ------------------------------------------------------------------ AC-3
test('F34 AC-3 a value of an env_allowlist variable stays in the state file', async () => {
  const { writes } = await runBlocked();
  assert.ok(writes.some((w) => w.text.includes(`ALLOWED_VAR=${ALLOWED}`)), 'the allowlisted value is kept');
});

test('F34 AC-3 a value shorter than 8 characters stays in the state file', async () => {
  const { writes } = await runBlocked();
  assert.ok(writes.some((w) => w.text.includes(`SHORT_VAR=${SHORT}`)), 'the short value is kept');
});

// ------------------------------------------------------------------ AC-4
test('F34 AC-4 --resume continues from the redacted state file and the feature passes', async () => {
  const { dir, r } = await runInterrupted();
  assert.equal(r.interrupted, true);
  assertStateRedacted(fs.readFileSync(statePath(dir), 'utf8'));
  // The builder now fixes the failing command.
  const build = async (a) => { writeFiles(a.cwd, { 'scripts/leak.mjs': 'process.exit(0);\n', 'F1.txt': 'fixed\n' }); return { ok: true, costUsd: 0 }; };
  const r2 = await runFeatures({ root: dir, resume: true, deps: { build, verify: realVerify, evaluate: async (a) => evalPass(a), env: ENV } });
  assert.equal(r2.interrupted, false);
  assert.equal(r2.results[0].status, 'passed', JSON.stringify(r2.results));
});

// ------------------------------------------------------------------ AC-5
test('F34 AC-5 SPEC SR describes the redaction of the run state, verdicts and backlog', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const sr = spec.slice(spec.indexOf('## 9.'), spec.indexOf('## 10.'));
  const line = sr.split('\n').find((l) => l.includes('current.json'));
  assert.ok(line, 'no redaction rule for the run state in §9');
  for (const w of ['verdict', 'backlog', '[redacted]', 'env_allowlist', '8자', '--resume']) assert.ok(line.includes(w), w);
});

// ------------------------------------------------------------------ SC-1
test('F34 SC-1 every state write is redacted before it is written', async () => {
  const { dir, writes } = await runInterrupted();
  const target = fs.realpathSync.native(path.dirname(statePath(dir)));
  assert.ok(writes.length >= 3, `saves: ${writes.length}`);
  for (const w of writes) assert.equal(fs.realpathSync.native(path.dirname(w.file)), target);
  assert.ok(writes.some((w) => w.text.includes('SECRET_TOKEN=[redacted]')), 'the failed verify was saved');
  for (const [i, w] of writes.entries()) assert.ok(!w.text.includes(SECRET), `write ${i}: ${w.text}`);
});

// ------------------------------------------------------------------ ES-1
test('F34 ES-1 a value with regex special characters is redacted literally and nothing else changes', async () => {
  const { writes } = await runBlocked();
  const text = writes.find((w) => w.text.includes('REGEX_VAR='))?.text ?? '';
  assert.ok(text.includes('REGEX_VAR=[redacted]'), text);
  assert.ok(!text.includes(REGEX));
  assert.ok(text.includes('near misses: xAAy-secret x.*+?[]()y x-secret'), 'other output is unchanged');
});
