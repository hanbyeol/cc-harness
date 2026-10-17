import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { verify as realVerify } from '../lib/verify.mjs';
import { runFeatures } from '../lib/run.mjs';
import { verifyFailureSummary } from '../lib/run/feature.mjs';
import { builderPrompt } from '../lib/run/prompt.mjs';
import { redactor } from '../lib/failures.mjs';

const SECRET = 'sk-Q7vZ3mK9pL2wN8rT4yB6hJ1cF5dG0sA-Mq2Wn4Er6Ty8Ui0OpLkJhGfDs';
const ENV = { ...process.env, SECRET_TOKEN: SECRET };
const TAIL = 2000;
const HEADING = 'Deterministic verification failed';

function contract(check) {
  const c = {
    id: 'F1', title: 'feature F1', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check, new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-17T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture({ check = 'node scripts/ok.mjs', files = {} } = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract(check),
    'scripts/ok.mjs': 'process.exit(0);\n',
    ...files,
  }, { branch: null });
}

const cfg = (over = {}) => resolveConfig({
  base_branch: 'main', run: { max_parallel: 1 }, verify: { commands: [], ...(over.verify || {}) },
  budget: { step_timeout_sec: 60, ...(over.budget || {}) }, ...(over.max_rounds ? { max_rounds: over.max_rounds } : {}),
});

const verifyOf = (dir, config, redact) => realVerify({ root: dir, cwd: dir, featureId: 'F1', base: 'main', config, redact });
const statePath = (dir) => path.join(dir, '.harness/runs/current.json');
const evalPass = (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });
const evalFail = (a) => ({ ...evalPass(a), verdict: 'fail', score: 4, blocking: [{ criterion_id: 'AC-1', dimension: 'functionality', summary: 'broken', repro: 'false' }] });

const PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const failing = (n) => ({
  ...PASSING, pass: false,
  commands: [{ cmd: 'npm test', pass: false, message: 'exit 1', output: `boom ${n}` }],
  criteria: [{ id: 'AC-1', check: 'x', pass: false, message: 'exit 1', output: `assert ${n}` }],
});

function scriptedVerify(seq) {
  let n = 0;
  return async () => seq[n++] ?? PASSING;
}

const promptOf = (a, config) => builderPrompt({ rolePrompt: 'role', featureId: a.featureId, round: a.round, attempt: a.attempt, contract: a.contract, findings: a.findings, verifyFailure: a.verifyFailure, config });

// ------------------------------------------------------------------ AC-1
test('F125 AC-1 the first attempt of the next round gets the last verify failure of the round before', async () => {
  const dir = fixture();
  const seen = [];
  const build = async (a) => {
    seen.push({ round: a.round, attempt: a.attempt, verifyFailure: a.verifyFailure, prompt: promptOf(a, cfg()) });
    writeFiles(a.cwd, { 'F1.txt': `built ${a.round}.${a.attempt}\n` });
    return { ok: true, costUsd: 0 };
  };
  const results = [failing(1), failing(2), failing(3)];
  await runFeatures({ root: dir, config: cfg(), deps: { build, verify: scriptedVerify([...results, PASSING, PASSING]), evaluate: async (a) => evalPass(a) } });
  assert.deepEqual(seen.map((s) => [s.round, s.attempt]), [[1, 1], [1, 2], [1, 3], [2, 1]]);
  assert.equal(seen[0].verifyFailure, null);
  assert.deepEqual(seen[3].verifyFailure, verifyFailureSummary(results[2]));
  assert.ok(seen[3].verifyFailure.criteria[0].output.includes('assert 3'));
  assert.ok(seen[3].prompt.includes(HEADING));
  assert.ok(!seen[0].prompt.includes(HEADING));
});

// ------------------------------------------------------------------ AC-2
test('F125 AC-2 a resumed first attempt of the next round gets the same verify failure', async () => {
  const dir = fixture();
  const controller = new AbortController();
  const results = [failing(1), failing(2), failing(3)];
  const verify = scriptedVerify([...results, PASSING, PASSING]);
  const build1 = async (a) => {
    if (a.round === 2) controller.abort();
    writeFiles(a.cwd, { 'F1.txt': `built ${a.round}.${a.attempt}\n` });
    return { ok: true, costUsd: 0 };
  };
  const first = await runFeatures({ root: dir, config: cfg(), signal: controller.signal, deps: { build: build1, verify, evaluate: async (a) => evalPass(a) } });
  assert.equal(first.interrupted, true);
  const saved = JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));
  assert.equal(saved.current.round, 2);
  const seen = [];
  const build2 = async (a) => {
    seen.push({ round: a.round, attempt: a.attempt, verifyFailure: a.verifyFailure, prompt: promptOf(a, cfg()) });
    writeFiles(a.cwd, { 'F1.txt': `resumed ${a.round}.${a.attempt}\n` });
    return { ok: true, costUsd: 0 };
  };
  await runFeatures({ root: dir, resume: true, deps: { build: build2, verify, evaluate: async (a) => evalPass(a) } });
  assert.deepEqual([seen[0].round, seen[0].attempt], [2, 1]);
  assert.deepEqual(seen[0].verifyFailure, verifyFailureSummary(results[2]));
  assert.ok(seen[0].prompt.includes(HEADING));
});

// ------------------------------------------------------------------ AC-3
const streams = (err, out) => ({
  'scripts/fail.mjs': `process.stderr.write(${JSON.stringify(err)});\nprocess.stdout.write(${JSON.stringify(out)});\nprocess.exit(1);\n`,
});

test('F125 AC-3 a failed command keeps the end of both streams, each cut to 2000 characters', async () => {
  const dir = fixture({ files: streams('npm WARN deprecated', '✖ F1 AC-1 boom') });
  const v = await verifyOf(dir, cfg({ verify: { commands: ['node scripts/fail.mjs'] } }), redactor(ENV));
  assert.equal(v.commands[0].output, '--- stderr ---\nnpm WARN deprecated\n--- stdout ---\n✖ F1 AC-1 boom');
});

test('F125 AC-3 each stream is cut on its own and a single stream is kept as it is', async () => {
  const err = 'e'.repeat(3000);
  const out = `${'o'.repeat(2500)}END`;
  const dir = fixture({ files: { ...streams(err, out), 'scripts/one.mjs': `process.stderr.write(${JSON.stringify(err)});\nprocess.exit(1);\n` } });
  const both = await verifyOf(dir, cfg({ verify: { commands: ['node scripts/fail.mjs'] } }));
  assert.equal(both.commands[0].output, `--- stderr ---\n${err.slice(-TAIL)}\n--- stdout ---\n${out.slice(-TAIL)}`);
  const one = await verifyOf(dir, cfg({ verify: { commands: ['node scripts/one.mjs'] } }));
  assert.equal(one.commands[0].output, err.slice(-TAIL));
});

// ------------------------------------------------------------------ AC-4
test('F125 AC-4 a failed criterion check carries its output; a passed one does not', async () => {
  const dir = fixture({
    check: 'node scripts/chk.mjs',
    files: { 'scripts/chk.mjs': "process.stdout.write('assert boom-F125');\nprocess.exit(1);\n" },
  });
  const v = await verifyOf(dir, cfg());
  assert.equal(v.criteria[0].message, 'exit 1');
  assert.equal(v.criteria[0].output, 'assert boom-F125');
  const ok = await verifyOf(fixture(), cfg());
  assert.equal('output' in ok.criteria[0], false);
});

test('F125 AC-4 the retry prompt carries the failed check output', async () => {
  const dir = fixture({
    check: 'node scripts/chk.mjs',
    files: { 'scripts/chk.mjs': "import fs from 'node:fs';\nif (fs.existsSync('F1.txt')) process.exit(0);\nprocess.stdout.write('assert boom-F125');\nprocess.exit(1);\n" },
  });
  const prompts = [];
  const build = async (a) => {
    prompts.push(promptOf(a, cfg()));
    if (a.attempt === 2) writeFiles(a.cwd, { 'F1.txt': 'x\n' });
    else writeFiles(a.cwd, { 'other.txt': 'x\n' });
    return { ok: true, costUsd: 0 };
  };
  await runFeatures({ root: dir, config: cfg(), deps: { build, verify: realVerify, evaluate: async (a) => evalPass(a) } });
  assert.ok(prompts.length >= 2);
  assert.ok(!prompts[0].includes('boom-F125'));
  assert.ok(prompts[1].includes('assert boom-F125'), prompts[1]);
});

// ------------------------------------------------------------------ AC-6
test('F125 AC-6 SPEC describes the two-stream failure output and the carried verify failure', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s61 = spec.slice(spec.indexOf('### 6.1'), spec.indexOf('### 6.2'));
  for (const w of ['--- stderr ---', '--- stdout ---', '2000자', '기준 check']) assert.ok(s61.includes(w), w);
  const s8 = spec.slice(spec.indexOf('## 8.'), spec.indexOf('## 9.'));
  const line = s8.split('\n').find((l) => l.startsWith('3. verify'));
  assert.ok(line, 'no verify retry line in §8');
  for (const w of ['다음 라운드', '첫 build 시도', '직전 라운드']) assert.ok(line.includes(w), w);
});

// ------------------------------------------------------------------ SC-1
test('F125 SC-1 a secret cut by the 2000-character boundary leaves no piece in output, prompt or current.json', async () => {
  const pad = 'x'.repeat(TAIL - (SECRET.length - 30) - 1);
  const leak = `${SECRET}${pad}\n`;
  const dir = fixture({
    check: 'node scripts/leak.mjs',
    files: { 'scripts/leak.mjs': `process.stderr.write(${JSON.stringify(leak)});\nprocess.stdout.write(${JSON.stringify(leak)});\nprocess.exit(1);\n` },
  });
  const pieces = (t) => { const f = []; for (let i = 0; i + 8 <= SECRET.length; i++) if (t.includes(SECRET.slice(i, i + 8))) f.push(SECRET.slice(i, i + 8)); return f; };
  const prompts = [];
  const states = [];
  const build = async (a) => {
    prompts.push(promptOf(a, cfg()));
    if (fs.existsSync(statePath(dir))) states.push(fs.readFileSync(statePath(dir), 'utf8'));
    writeFiles(a.cwd, { 'F1.txt': `b${a.round}.${a.attempt}\n` });
    return { ok: true, costUsd: 0 };
  };
  const r = await runFeatures({ root: dir, config: cfg({ max_rounds: 1 }), deps: { build, verify: realVerify, evaluate: async (a) => evalPass(a), env: ENV } });
  assert.equal(r.results[0].status, 'blocked');
  const v = await verifyOf(dir, cfg(), redactor(ENV));
  assert.ok(v.criteria[0].output.includes('[redacted]'));
  assert.deepEqual(pieces(v.criteria[0].output), []);
  assert.ok(prompts[1].includes('[redacted]'), 'the retry prompt carries the failure');
  assert.ok(states.some((t) => t.includes('[redacted]')), 'a saved state carries the failure');
  for (const t of [...prompts, ...states]) assert.deepEqual(pieces(t), []);
});

// ------------------------------------------------------------------ ES-1
test('F125 ES-1 a round that ended in an eval failure starts the next one without a verify failure', async () => {
  const dir = fixture();
  const seen = [];
  const build = async (a) => {
    seen.push({ round: a.round, verifyFailure: a.verifyFailure, prompt: promptOf(a, cfg()) });
    writeFiles(a.cwd, { 'F1.txt': `b${a.round}\n` });
    return { ok: true, costUsd: 0 };
  };
  let n = 0;
  await runFeatures({ root: dir, config: cfg(), deps: { build, verify: scriptedVerify([]), evaluate: async (a) => (n++ === 0 ? evalFail(a) : evalPass(a)) } });
  assert.deepEqual(seen.map((s) => s.round), [1, 2]);
  assert.equal(seen[1].verifyFailure, null);
  assert.ok(!seen[1].prompt.includes(HEADING));
});

// ------------------------------------------------------------------ ES-2
test('F125 ES-2 a check killed on timeout keeps the stdout it wrote before', async () => {
  const dir = fixture({
    check: 'node scripts/slow.mjs',
    files: { 'scripts/slow.mjs': "process.stdout.write('before-kill\\n');\nsetTimeout(() => {}, 60000);\n" },
  });
  const v = await verifyOf(dir, cfg({ budget: { step_timeout_sec: 2 } }));
  assert.equal(v.criteria[0].message, 'timed out — process tree killed');
  assert.ok(v.criteria[0].output.includes('before-kill'), JSON.stringify(v.criteria[0]));
});
