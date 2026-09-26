import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { verify as realVerify } from '../lib/verify.mjs';
import { evaluate } from '../lib/eval.mjs';
import { runFeatures } from '../lib/run.mjs';
import { redactor } from '../lib/failures.mjs';

// 60 characters, no 'x' (the padding) and no 8-character run that occurs elsewhere.
const SECRET = 'sk-Q7vZ3mK9pL2wN8rT4yB6hJ1cF5dG0sA-Mq2Wn4Er6Ty8Ui0OpLkJhGfDs';
const ENV = { ...process.env, SECRET_TOKEN: SECRET };
const TAIL = 2000;
// Output = secret + padding + '\n' whose last 2000 characters start 30 characters into the secret.
const PAD = TAIL - (SECRET.length - 30) - 1;

// Every 8-character piece of the secret found in `text`.
function pieces(text) {
  const found = [];
  for (let i = 0; i + 8 <= SECRET.length; i++) if (text.includes(SECRET.slice(i, i + 8))) found.push(SECRET.slice(i, i + 8));
  return found;
}
const assertClean = (text, what) => assert.deepEqual(pieces(text), [], `${what}: ${text.slice(0, 3000)}`);

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-26T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture(scripts = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract('F1'),
    'scripts/ok.mjs': 'process.exit(0);\n',
    // The secret reaches the output from the script itself (verify commands get a filtered env).
    'scripts/leak.mjs': `process.stdout.write(${JSON.stringify(SECRET)} + 'x'.repeat(${PAD}) + '\\n');\nprocess.exit(1);\n`,
    ...scripts,
  }, { branch: null });
}

const cfg = (over = {}) => resolveConfig({
  base_branch: 'main', verify: { commands: ['node scripts/leak.mjs'] }, budget: { step_timeout_sec: 60 }, ...over,
});
const statePath = (dir) => path.join(dir, '.harness/runs/current.json');
const evalPass = (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });

// A run whose verify fails on the boundary output until the feature is blocked. The first
// build attempt fails with an error that ends in the start of the secret (a metrics outcome).
async function runBlocked() {
  const dir = fixture();
  const writes = [];
  const writeJsonAtomic = (file, data) => {
    writes.push(JSON.stringify(data));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  };
  const build = async (a) => {
    if (a.round === 1 && a.attempt === 1) return { ok: false, error: `crashed ${SECRET.slice(0, 24)}`, costUsd: 0 };
    writeFiles(a.cwd, { 'F1.txt': `built ${a.round}.${a.attempt}\n` });
    return { ok: true, costUsd: 0 };
  };
  const r = await runFeatures({
    root: dir, config: cfg({ max_rounds: 1 }),
    deps: { build, verify: realVerify, evaluate: async (a) => evalPass(a), env: ENV, writeJsonAtomic },
  });
  assert.equal(r.results[0].status, 'blocked', JSON.stringify(r.results));
  return { dir, r, writes };
}

// A verdict from evaluate() running verify itself, with reviewer text cut inside the secret.
async function evaluated() {
  const dir = fixture();
  const config = cfg({
    roles: { builder: 'claude', evaluator: 'generic', 'security-reviewer': 'generic' },
    adapters: { generic: { read_only_command: [process.execPath, '-e', 'process.exit(1)'] } },
  });
  const json = {
    scores: { functionality: 3, quality: 9, security: 9, errors: 9, tests: 9 },
    findings: [
      { criterion_id: 'AC-1', dimension: 'functionality', summary: `${SECRET.slice(25)} leaks`, repro: 'node scripts/leak.mjs' },
      { criterion_id: '', dimension: 'security', summary: `token ${SECRET.slice(0, 40)}`, repro: 'false' },
    ],
    out_of_scope: [{ summary: `rotate ${SECRET.slice(0, 20)}` }],
  };
  const runAdapter = async () => ({ ok: true, error: null, text: JSON.stringify(json), json, costUsd: 0, exitCode: 0 });
  const v = await evaluate({ root: dir, featureId: 'F1', base: 'main', config, runAdapter, env: ENV });
  assert.equal(v.verdict, 'fail');
  return { dir, v };
}

// ------------------------------------------------------------------ AC-1
test('F36 AC-1 the fixture cuts the output inside the secret', () => {
  const out = `${SECRET}${'x'.repeat(PAD)}\n`;
  assert.ok(out.slice(-TAIL).startsWith(SECRET.slice(30)));
});

test('F36 AC-1 current.json and the run report carry no piece of a secret the 2000-character cut went through', async () => {
  const { dir, r, writes } = await runBlocked();
  assert.ok(writes.length > 0);
  assert.ok(writes.some((w) => w.includes('xxxxxxxx')), 'the failed verify output was saved');
  for (const w of writes) assertClean(w, 'state write');
  if (fs.existsSync(statePath(dir))) assertClean(fs.readFileSync(statePath(dir), 'utf8'), 'current.json');
  const report = fs.readFileSync(r.report, 'utf8');
  assert.ok(report.includes('- failed:'), report);
  assertClean(report, 'run report');
});

test('F36 AC-1 the verdict carries no piece of a secret the 2000-character cut went through', async () => {
  const { v } = await evaluated();
  const verdict = fs.readFileSync(v.file, 'utf8');
  assert.ok(JSON.parse(verdict).verify_failures.length > 0, verdict);
  assertClean(verdict, 'verdict');
});

test('F36 AC-1 verify redacts command output before it keeps the last 2000 characters', async () => {
  const dir = fixture();
  const vr = await realVerify({ root: dir, cwd: dir, featureId: 'F1', base: 'main', config: cfg(), redact: redactor(ENV) });
  // The whole value was replaced first, so the shorter text is kept whole.
  assert.equal(vr.commands[0].output, `[redacted]${'x'.repeat(PAD)}\n`);
});

// ------------------------------------------------------------------ AC-2
test('F36 AC-2 a start equal to a suffix of the value (8+ characters) becomes [redacted]', () => {
  const redact = redactor(ENV);
  assert.equal(redact(`${SECRET.slice(-8)} rest`), '[redacted] rest');
  assert.equal(redact(`${SECRET.slice(30)} rest`), '[redacted] rest');
});

test('F36 AC-2 an end equal to a prefix of the value (8+ characters) becomes [redacted]', () => {
  const redact = redactor(ENV);
  assert.equal(redact(`head ${SECRET.slice(0, 8)}`), 'head [redacted]');
  assert.equal(redact(`head ${SECRET.slice(0, 30)}`), 'head [redacted]');
});

test('F36 AC-2 a fragment shorter than 8 characters or away from the edges stays', () => {
  const redact = redactor(ENV);
  assert.equal(redact(`${SECRET.slice(-7)} rest`), `${SECRET.slice(-7)} rest`);
  assert.equal(redact(`head ${SECRET.slice(0, 7)}`), `head ${SECRET.slice(0, 7)}`);
  assert.equal(redact(`a ${SECRET.slice(30)} b`), `a ${SECRET.slice(30)} b`);
  assert.equal(redact(`a ${SECRET} b`), 'a [redacted] b');
});

// ------------------------------------------------------------------ AC-3
test('F36 AC-3 output without a redacted value keeps exactly its last 2000 characters', async () => {
  const body = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
  const dir = fixture({ 'scripts/leak.mjs': `process.stdout.write(${JSON.stringify(body)});\nprocess.exit(1);\n` });
  for (const redact of [undefined, redactor(ENV)]) {
    const vr = await realVerify({ root: dir, cwd: dir, featureId: 'F1', base: 'main', config: cfg(), redact });
    assert.equal(vr.commands[0].output, body.slice(-TAIL));
  }
});

// ------------------------------------------------------------------ AC-4
test('F36 AC-4 SPEC security requirements describe redaction before the cut and the fragment rule', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const sr = spec.slice(spec.indexOf('## 9.'), spec.indexOf('## 10.'));
  const line = sr.split('\n').find((l) => l.includes('자르기 전'));
  assert.ok(line, 'no rule on the order of redaction and the cut in §9');
  for (const w of ['2000자', '[redacted]', '접미사', '접두사', '8자']) assert.ok(line.includes(w), w);
});

// ------------------------------------------------------------------ SC-1
test('F36 SC-1 state file, run report, verdict, backlog and metrics carry no piece of a boundary secret', async () => {
  const { dir, r, writes } = await runBlocked();
  for (const w of writes) assertClean(w, 'state write');
  assertClean(fs.readFileSync(r.report, 'utf8'), 'run report');
  const runs = path.join(dir, '.harness/runs');
  const metricFiles = fs.readdirSync(runs).filter((f) => f.endsWith('.metrics.jsonl'));
  assert.ok(metricFiles.length > 0);
  const metrics = metricFiles.map((f) => fs.readFileSync(path.join(runs, f), 'utf8')).join('');
  assert.ok(metrics.includes('crashed [redacted]'), metrics);
  assertClean(metrics, 'metrics');
  assertClean(fs.readFileSync(path.join(dir, '.harness/backlog.json'), 'utf8'), 'backlog after run');

  const ev = await evaluated();
  assertClean(fs.readFileSync(ev.v.file, 'utf8'), 'verdict');
  const backlog = fs.readFileSync(path.join(ev.dir, '.harness/backlog.json'), 'utf8');
  assert.ok(JSON.parse(backlog).items.length >= 2, backlog);
  assertClean(backlog, 'backlog');
});

// ------------------------------------------------------------------ ES-1
test('F36 ES-1 a value longer than 2000 characters becomes [redacted] as a whole', async () => {
  const long = `LONG-${'abcdefghij'.repeat(250)}`;
  const env = { ...process.env, LONG_SECRET: long };
  const redact = redactor(env);
  // Already cut to its last 2000 characters: the whole text is a suffix of the value.
  assert.equal(redact(long.slice(-TAIL)), '[redacted]');
  const dir = fixture({ 'scripts/leak.mjs': `process.stdout.write(${JSON.stringify(long)});\nprocess.exit(1);\n` });
  const vr = await realVerify({ root: dir, cwd: dir, featureId: 'F1', base: 'main', config: cfg(), redact });
  assert.equal(vr.commands[0].output, '[redacted]');
});
