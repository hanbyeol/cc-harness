// F159: the claude adapter reads the wrapper's subtype — an error wrapper's detail is
// '<subtype>: <errors>' instead of the stdout tail, and a builder call that ended with
// error_max_budget_usd blocks its feature (budget) without a verify, whatever step_usd says.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BIN, REPO, tmpdir, fakeNodeCli } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { getAdapter } from '../lib/adapters/index.mjs';
import { verify as realVerify } from '../lib/verify.mjs';
import { runFeatures } from '../lib/run.mjs';

const FIX = path.join(REPO, 'test', 'fixtures');
const FAKE = path.join(FIX, 'fake-cli.mjs');
const FAKE_CLAUDE = path.join(FIX, 'fake-claude.mjs');
const PASS_REPLY = JSON.parse(fs.readFileSync(path.join(FIX, 'eval', 'pass.json'), 'utf8'));
const BUDGET_FILE = path.join(FIX, 'output', 'claude-json-budget-exhausted.json');
const BUDGET = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
const BUDGET_DETAIL = 'error_max_budget_usd: Reached maximum budget ($0.05)';

const replyFile = (reply) => {
  const f = path.join(tmpdir('harness-f159-reply-'), 'reply.json');
  fs.writeFileSync(f, typeof reply === 'string' ? reply : JSON.stringify(reply));
  return f;
};
// One adapter call against the fake CLI printing `reply`; `fail` makes it exit 1.
const adapterRun = (name, reply, { fail = false, ...opts } = {}) => getAdapter(name).run({
  prompt: 'x', cwd: REPO, timeoutSec: 30, ...opts, bin: process.execPath, binArgs: [FAKE, fail ? 'print-fail' : 'print', replyFile(reply)],
});

// ------------------------------------------------------------------ AC-1, AC-2, SC-1, ES-1

test('F159 AC-1: a budget-exhausted wrapper is exit_nonzero with budgetExhausted and the subtype detail', async () => {
  const r = await adapterRun('claude', BUDGET, { fail: true });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'exit_nonzero');
  assert.equal(r.budgetExhausted, true);
  assert.equal(r.detail, BUDGET_DETAIL);
  assert.equal(r.costUsd, 0.0663634);
  assert.equal(r.exitCode, 1);
});

test('F159 AC-2: another error subtype gives its detail and no budgetExhausted; errors missing → subtype only', async () => {
  const turns = { ...BUDGET, subtype: 'error_max_turns', terminal_reason: 'max_turns', errors: ['Reached maximum number of turns (1)'] };
  const r = await adapterRun('claude', turns, { fail: true });
  assert.equal(r.error, 'exit_nonzero');
  assert.equal(r.detail, 'error_max_turns: Reached maximum number of turns (1)');
  assert.equal(r.budgetExhausted, false);
  for (const errors of [undefined, 'not an array', []]) {
    const { errors: _e, ...rest } = turns;
    const w = errors === undefined ? rest : { ...rest, errors };
    const x = await adapterRun('claude', w, { fail: true });
    assert.equal(x.detail, 'error_max_turns', JSON.stringify(errors));
  }
});

test('F159 SC-1: a secret in the errors strings is redacted from the detail', async () => {
  const secret = 'sk-f159-secret-value';
  const prev = process.env.HARNESS_F159_SECRET;
  process.env.HARNESS_F159_SECRET = secret;
  try {
    const w = { ...BUDGET, errors: [`Reached maximum budget for key ${secret}`] };
    const r = await adapterRun('claude', w, { fail: true });
    assert.equal(r.error, 'exit_nonzero');
    assert.ok(r.detail.startsWith('error_max_budget_usd: '), r.detail);
    assert.ok(!r.detail.includes(secret), r.detail);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_F159_SECRET;
    else process.env.HARNESS_F159_SECRET = prev;
  }
});

test('F159 ES-1: a success wrapper and a non-claude adapter are not budget-exhausted', async () => {
  const ok = await adapterRun('claude', fs.readFileSync(path.join(FIX, 'output', 'claude-json-success.json'), 'utf8'), { readOnly: true, schema: { type: 'object' } });
  assert.equal(ok.ok, true);
  assert.ok(!ok.budgetExhausted);
  const gem = await adapterRun('gemini', { session_id: 's', response: '{"ok":true}', stats: {}, subtype: 'error_max_budget_usd', errors: ['x'] }, { fail: true });
  assert.equal(gem.ok, false);
  assert.ok(!gem.budgetExhausted);
});

// ------------------------------------------------------------------ run fixtures

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-11-11T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture({ config = {} } = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...config },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract('F1'),
    'scripts/ok.mjs': 'process.exit(0);\n',
  }, { branch: null });
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const featureOf = (dir) => readJson(path.join(dir, '.harness/features.json')).features.find((f) => f.id === 'F1');

// A builder that writes a file and returns `result` (merged over a failed build).
function builder(result) {
  const calls = [];
  const fn = async (a) => {
    calls.push(a.featureId);
    writeFiles(a.cwd, { 'partial.txt': 'half done\n' });
    return { ok: false, error: 'exit_nonzero', text: '', json: null, exitCode: 1, ...result };
  };
  fn.calls = calls;
  return fn;
}
function verifier() {
  const calls = [];
  const fn = async (a) => { calls.push(a.featureId); return realVerify(a); };
  fn.calls = calls;
  return fn;
}
const passingRoles = async () => ({ ok: true, error: null, text: '', json: PASS_REPLY, costUsd: 0, exitCode: 0 });

function run(dir, deps, budget) {
  const logs = [];
  const config = resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60, ...budget } });
  return runFeatures({ root: dir, config, deps: { runAdapter: passingRoles, log: (m) => logs.push(m), warn: (m) => logs.push(m), ...deps } })
    .then((r) => ({ ...r, out: logs.join('\n') }));
}

// ------------------------------------------------------------------ AC-3, ES-2

test('F159 AC-3: a builder stopped at its budget share blocks the feature (budget) without a verify', async () => {
  const dir = fixture();
  const build = builder({ budgetExhausted: true, costUsd: 0.4, detail: BUDGET_DETAIL });
  const verify = verifier();
  const r = await run(dir, { build, verify }, { run_usd: 1 });
  const f1 = r.results.find((x) => x.feature === 'F1');
  assert.equal(f1?.status, 'blocked', r.out);
  assert.equal(f1.reason, 'budget');
  assert.ok(f1.detail.includes('stopped at its budget'), f1.detail);
  assert.ok(f1.detail.includes('error_max_budget_usd'), f1.detail);
  assert.equal(featureOf(dir).blocked_reason, 'budget');
  assert.deepEqual(verify.calls, [], 'no verify');
  assert.deepEqual(build.calls, ['F1'], 'one builder call');
});

test('F159 ES-2: a build over step_usd is still blocked with the step budget detail', async () => {
  const dir = fixture();
  const build = builder({ costUsd: 0.6, detail: 'boom' });
  const r = await run(dir, { build, verify: verifier() }, { step_usd: 0.5 });
  const f1 = r.results.find((x) => x.feature === 'F1');
  assert.equal(f1?.status, 'blocked', r.out);
  assert.equal(f1.reason, 'budget');
  assert.ok(f1.detail.includes('reached the step budget'), f1.detail);
});

// ------------------------------------------------------------------ AC-4

const GIT_DIR = path.dirname(spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim());

test('F159 AC-4: harness eval records the subtype detail in the eval_error file, not the stdout JSON', () => {
  const dir = fixture({ config: { roles: { builder: 'claude', evaluator: 'claude', 'security-reviewer': 'claude' } } });
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const env = { ...process.env, [pathKey]: [fakeNodeCli('claude', FAKE_CLAUDE), path.dirname(process.execPath), GIT_DIR].join(path.delimiter),
    FAKE_CLAUDE_REPLY: BUDGET_FILE, FAKE_CLAUDE_EXIT: '1' };
  const r = spawnSync(process.execPath, [BIN, 'eval', 'F1'], { cwd: dir, env, encoding: 'utf8', timeout: 180000 });
  const file = path.join(dir, '.harness', 'verdicts', 'F1-r1.eval_error.json');
  assert.ok(fs.existsSync(file), `no eval_error file: ${r.stdout}${r.stderr}`);
  const e = readJson(file);
  assert.equal(e.error, 'exit_nonzero');
  assert.equal(e.detail, BUDGET_DETAIL);
  assert.ok(!String(e.detail).includes('"type"'), 'no stdout JSON in the detail');
});

// ------------------------------------------------------------------ AC-5

test('F159 AC-5: SPEC §8 and §10 describe the subtype detail and the budget-exhausted builder', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const cls = spec.split('\n').find((l) => l.startsWith('claude 결과 분류:'));
  assert.ok(cls, "no 'claude 결과 분류' line");
  for (const w of ['subtype', 'error_max_budget_usd']) assert.ok(cls.includes(w), w);
  const s8 = spec.slice(spec.indexOf('\n## 8.'), spec.indexOf('\n## 9.'));
  const para = s8.split('\n').find((l) => l.includes('error_max_budget_usd'));
  assert.ok(para, '§8 paragraph with error_max_budget_usd');
  assert.ok(para.includes('blocked(`budget`)'), para);
});
