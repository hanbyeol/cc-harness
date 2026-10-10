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
const LIMIT_TEXT = "You've hit your session limit · resets 3:10am (Asia/Seoul)";

// A claude `--output-format json` wrapper (the shape of claude-json-success.json) with `over` applied.
const wrapper = (over = {}) => ({
  type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: '{"ok":true}',
  total_cost_usd: 0, num_turns: 1, session_id: 'f88', ...over,
});
const LIMIT = wrapper({ is_error: true, api_error: 'usage_limit_reached', api_error_status: 429, result: LIMIT_TEXT });

const replyFile = (reply) => {
  const f = path.join(tmpdir('harness-f88-reply-'), 'reply.json');
  fs.writeFileSync(f, typeof reply === 'string' ? reply : JSON.stringify(reply));
  return f;
};
// One claude adapter call against the fake CLI printing `reply`; `fail` makes it exit 1.
const claudeRun = (reply, { fail = true, ...opts } = {}) => getAdapter('claude').run({
  prompt: 'x', cwd: REPO, timeoutSec: 30, ...opts, bin: process.execPath, binArgs: [FAKE, fail ? 'print-fail' : 'print', replyFile(reply)],
});

// ------------------------------------------------------------------ run fixtures

function contract(id, tier = 'standard') {
  const c = {
    id, title: `feature ${id}`, security_tier: tier, version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-08T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture(ids = ['F1'], { tier = 'standard', config = {} } = {}) {
  const files = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...config },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: tier, depends_on: [], status: 'approved' })) },
    'scripts/ok.mjs': 'process.exit(0);\n',
  };
  for (const id of ids) files[`.harness/contracts/${id}.json`] = contract(id, tier);
  return gitRepo(files, { branch: null });
}

const cfg = (over = {}) => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, ...over });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const statusOf = (dir, id = 'F1') => readJson(path.join(dir, '.harness/features.json')).features.find((f) => f.id === id).status;
const statePath = (dir) => path.join(dir, '.harness/runs/current.json');
const verdictFiles = (dir) => {
  const d = path.join(dir, '.harness/verdicts');
  return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
};
const backlog = (dir) => readJson(path.join(dir, '.harness/backlog.json')).items;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A builder that hits the usage limit (through the claude adapter) while `limit.on` is set,
// and otherwise writes <id>.txt and succeeds.
function builder(limit = { on: true }, { wait = async () => {}, delay = () => 0 } = {}) {
  const calls = [];
  const fn = async (a) => {
    const c = { featureId: a.featureId, round: a.round, attempt: a.attempt, done: false, aborted: false };
    calls.push(c);
    await wait(a);
    if (limit.on && (!limit.only || limit.only === a.featureId)) {
      const r = await claudeRun(LIMIT, { cwd: a.cwd });
      c.done = true;
      limit.returned = true;
      return r;
    }
    await sleep(delay(a));
    writeFiles(a.cwd, { [`${a.featureId}.txt`]: `built r${a.round}\n` });
    c.done = true;
    c.aborted = !!a.signal?.aborted;
    return { ok: true, costUsd: 0 };
  };
  fn.calls = calls;
  return fn;
}

// A verify that records the features it ran for.
function verifier() {
  const calls = [];
  const fn = async (a) => { calls.push(a.featureId); return realVerify(a); };
  fn.calls = calls;
  return fn;
}

// Evaluator roles: `script[role]` is 'limit', 'error' (exit_nonzero) or 'pass' (the default).
function roles(script = {}) {
  const calls = [];
  const fn = async (role, opts) => {
    calls.push(role);
    const what = typeof script[role] === 'function' ? script[role]() : script[role] ?? 'pass';
    if (what === 'limit') return claudeRun(LIMIT, { cwd: opts.cwd });
    if (what === 'error') return claudeRun(wrapper({ is_error: true, api_error: 'overloaded_error', api_error_status: 529, result: 'Overloaded' }), { cwd: opts.cwd });
    return { ok: true, error: null, text: '', json: PASS_REPLY, costUsd: 0, exitCode: 0 };
  };
  fn.calls = calls;
  return fn;
}

function run(dir, deps = {}, { config, ...opts } = {}) {
  const logs = [];
  return runFeatures({ root: dir, config: cfg(config), deps: { runAdapter: roles(), log: (m) => logs.push(m), warn: (m) => logs.push(m), ...deps }, ...opts })
    .then((r) => ({ ...r, logs, out: logs.join('\n') }));
}

function assertStopped(dir, r, stage) {
  assert.equal(r.interrupted, true, `${r.out}\n${JSON.stringify(r.results)}`);
  assert.deepEqual(r.usageLimit, { feature: 'F1', stage, detail: LIMIT_TEXT });
  assert.deepEqual(r.results, [], 'no feature result: nothing was blocked');
  assert.equal(statusOf(dir), 'in_progress', 'status stays in_progress, not blocked');
  assert.deepEqual(backlog(dir), [], 'no re-scope proposal');
  for (const w of ['usage limit', LIMIT_TEXT, 'harness run --resume']) assert.ok(r.out.includes(w), `${w} in: ${r.out}`);
  const saved = readJson(statePath(dir));
  assert.deepEqual(saved.active.map((e) => e.feature), ['F1']);
  assert.equal(saved.active[0].round, 1, 'the round is not consumed');
  assert.deepEqual(saved.active[0].history, []);
  assert.equal(saved.active[0].stage, stage);
  return saved.active[0];
}

// A PATH directory holding a fake `claude` (fixtures/fake-claude.mjs).
function fakeClaudeBin() {
  return fakeNodeCli('claude', FAKE_CLAUDE);
}
const GIT_DIR = path.dirname(spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim());

// The real CLI with the fake claude first on PATH, printing `reply` and exiting `exit`.
function cli(args, dir, reply, exit = 1) {
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const env = { ...process.env, [pathKey]: [fakeClaudeBin(), path.dirname(process.execPath), GIT_DIR].join(path.delimiter),
    FAKE_CLAUDE_REPLY: replyFile(reply), FAKE_CLAUDE_EXIT: String(exit) };
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, env, encoding: 'utf8', timeout: 180000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const CLAUDE_ROLES = { roles: { builder: 'claude', evaluator: 'claude', 'security-reviewer': 'claude' } };

// ------------------------------------------------------------------ AC-1
test('F88 AC-1 a usage_limit_reached wrapper with a non-zero exit is error usage_limit with the result sentence as detail', async () => {
  const r = await claudeRun(LIMIT, { fail: true });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'usage_limit');
  assert.equal(r.detail, LIMIT_TEXT);
  assert.equal(r.exitCode, 1);
});

test('F88 AC-1 a usage_limit_reached wrapper with exit 0 is error usage_limit too', async () => {
  const r = await claudeRun(LIMIT, { fail: false });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'usage_limit');
  assert.equal(r.detail, LIMIT_TEXT);
  assert.equal(r.exitCode, 0);
  // With a schema the missing JSON is not reported as no_json: the limit comes first.
  const s = await claudeRun(LIMIT, { fail: false, readOnly: true, schema: { type: 'object' } });
  assert.equal(s.error, 'usage_limit');
});

test('F88 AC-1 api_error_status 429 with another api_error is usage_limit, with either exit code', async () => {
  const rate = wrapper({ is_error: true, api_error: 'rate_limit_error', api_error_status: 429, result: LIMIT_TEXT });
  for (const fail of [true, false]) {
    const r = await claudeRun(rate, { fail });
    assert.equal(r.error, 'usage_limit', `fail=${fail}`);
    assert.equal(r.detail, LIMIT_TEXT);
  }
});

test('F88 AC-1 the detail is at most 300 characters', async () => {
  const long = `${LIMIT_TEXT} ${'x'.repeat(1000)}`;
  for (const fail of [true, false]) {
    const r = await claudeRun({ ...LIMIT, result: long }, { fail });
    assert.equal(r.error, 'usage_limit');
    assert.ok(r.detail.length <= 300, String(r.detail.length));
    assert.ok(r.detail.startsWith(LIMIT_TEXT), r.detail);
  }
});

// ------------------------------------------------------------------ ES-1 / ES-2
test('F88 ES-1 is_error with 529 overloaded or 500 is exit_nonzero, not usage_limit', async () => {
  for (const over of [{ api_error: 'overloaded_error', api_error_status: 529 }, { api_error: 'api_error', api_error_status: 500 }]) {
    const r = await claudeRun(wrapper({ is_error: true, result: 'API Error', ...over }), { fail: true });
    assert.equal(r.error, 'exit_nonzero', JSON.stringify(over));
  }
});

test('F88 ES-1 in a run an overloaded builder is a failed attempt and an overloaded evaluator is an eval_error', async () => {
  const dir = fixture();
  let builds = 0;
  const build = async (a) => {
    builds += 1;
    if (builds === 1) return claudeRun(wrapper({ is_error: true, api_error: 'overloaded_error', api_error_status: 529, result: 'Overloaded' }), { cwd: a.cwd });
    writeFiles(a.cwd, { 'F1.txt': 'built\n' });
    return { ok: true, costUsd: 0 };
  };
  const verify = verifier();
  const r = await run(dir, { build, verify, runAdapter: roles({ evaluator: 'error' }) });
  assert.equal(r.usageLimit, undefined, r.out);
  assert.equal(r.interrupted, false, r.out);
  assert.ok(verify.calls.length >= 1, 'the failed build attempt went on to verify');
  assert.equal(r.results[0].status, 'blocked', r.out);
  assert.equal(r.results[0].reason, 'eval_error');
  assert.ok(verdictFiles(dir).includes('F1-r1.eval_error.json'), verdictFiles(dir).join(', '));
});

test('F88 ES-2 output that is not JSON, or a wrapper without api_error, is not usage_limit', async () => {
  const text = await claudeRun('usage_limit_reached 429 not json', { fail: true });
  assert.equal(text.error, 'exit_nonzero');
  const noField = wrapper({ is_error: true, api_error_status: 429, result: LIMIT_TEXT });
  assert.equal((await claudeRun(noField, { fail: true })).error, 'exit_nonzero');
  assert.notEqual((await claudeRun(noField, { fail: false })).error, 'usage_limit');
});

// ------------------------------------------------------------------ AC-2
test('F88 AC-2 a usage limit in build stops the run: in_progress, no attempt or round used, no verify', async () => {
  const dir = fixture();
  const build = builder();
  const verify = verifier();
  const r = await run(dir, { build, verify });
  const e = assertStopped(dir, r, 'build');
  assert.equal(build.calls.length, 1, 'no build retry');
  assert.deepEqual(verify.calls, [], 'verify did not run');
  assert.equal(e.attemptsDone ?? 0, 0, 'the build attempt is not consumed');
  assert.equal(e.built ?? null, null, 'the build is not recorded as done');
});

test('F88 AC-2 harness run CLI: exit 1, stderr names the usage limit, its detail and harness run --resume', () => {
  const dir = fixture(['F1'], { config: CLAUDE_ROLES });
  const r = cli(['run'], dir, LIMIT, 1);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  for (const w of ['usage limit', LIMIT_TEXT, 'harness run --resume']) assert.ok(r.stderr.includes(w), `${w} in: ${r.stderr}`);
  assert.equal(statusOf(dir), 'in_progress');
  assert.ok(fs.existsSync(statePath(dir)), 'the run state is saved');
});

// ------------------------------------------------------------------ AC-3
test('F88 AC-3 a usage limit in the evaluator stops the run without an eval_error', async () => {
  const dir = fixture();
  const r = await run(dir, { build: builder({ on: false }), runAdapter: roles({ evaluator: 'limit' }) });
  const e = assertStopped(dir, r, 'eval');
  assert.equal(e.evalErrors ?? 0, 0, 'not counted as an eval_error');
  assert.deepEqual(verdictFiles(dir), [], 'no verdict and no eval_error file');
});

test('F88 AC-3 a usage limit in the security-reviewer stops the run the same way', async () => {
  const dir = fixture(['F1'], { tier: 'critical' });
  const r = await run(dir, { build: builder({ on: false }), runAdapter: roles({ 'security-reviewer': 'limit' }) });
  const e = assertStopped(dir, r, 'eval');
  assert.equal(e.evalErrors ?? 0, 0);
  assert.deepEqual(verdictFiles(dir), []);
});

test('F88 AC-3 the consecutive eval_error count is unchanged by a usage limit', async () => {
  const dir = fixture();
  let n = 0;
  const evaluator = () => { n += 1; return n === 1 ? 'error' : 'limit'; };
  const r = await run(dir, { build: builder({ on: false }), runAdapter: roles({ evaluator }) });
  const e = assertStopped(dir, r, 'eval');
  assert.equal(e.evalErrors, 1, 'one eval_error before the limit, still one');
  assert.deepEqual(verdictFiles(dir), ['F1-r1.eval_error.json']);
  assert.equal(readJson(path.join(dir, '.harness/verdicts/F1-r1.eval_error.json')).consecutive, 1);
});

// ------------------------------------------------------------------ AC-4
test('F88 AC-4 resume after a build stop calls the builder again in the same round and attempt, then passes', async () => {
  const dir = fixture();
  const limit = { on: true };
  const build = builder(limit);
  assertStopped(dir, await run(dir, { build }), 'build');
  limit.on = false;
  const r = await run(dir, { build }, { resume: true });
  assert.equal(r.usageLimit, undefined, r.out);
  assert.equal(r.results[0]?.status, 'passed', r.out);
  assert.equal(r.results[0].rounds, 1);
  assert.deepEqual(build.calls.map((c) => [c.round, c.attempt]), [[1, 1], [1, 1]], 'the same round and attempt again');
  assert.equal(statusOf(dir), 'passed');
  assert.ok(!fs.existsSync(statePath(dir)));
});

test('F88 AC-4 resume after an eval stop verifies again and calls the evaluator again, then passes', async () => {
  const dir = fixture();
  const build = builder({ on: false });
  assertStopped(dir, await run(dir, { build, runAdapter: roles({ evaluator: 'limit' }) }), 'eval');
  const verify = verifier();
  const evaluator = roles();
  const r = await run(dir, { build, verify, runAdapter: evaluator }, { resume: true });
  assert.equal(r.results[0]?.status, 'passed', r.out);
  assert.equal(r.results[0].rounds, 1);
  assert.equal(build.calls.length, 1, 'the build is not redone');
  assert.ok(verify.calls.includes('F1'), 'the verify result is established again');
  assert.deepEqual(evaluator.calls, ['evaluator']);
  assert.ok(verdictFiles(dir).includes('F1-r1.json'), verdictFiles(dir).join(', '));
  assert.ok(!verdictFiles(dir).some((f) => f.includes('eval_error')));
  assert.equal(statusOf(dir), 'passed');
});

// ------------------------------------------------------------------ AC-5
test('F88 AC-5 parallel: a usage limit starts no new feature, lets the running build finish and keeps both features active', async () => {
  const dir = fixture(['F1', 'F2', 'F3']);
  const limit = { on: true, only: 'F1' };
  // F1 hits the limit only once F2's build has started; F2's build ends 3 s after that.
  let build;
  const wait = async (a) => {
    if (a.featureId === 'F1') {
      for (let t = 0; t < 60000 && !build.calls.some((c) => c.featureId === 'F2'); t += 50) await sleep(50);
    } else if (a.featureId === 'F2') {
      for (let t = 0; t < 60000 && !limit.returned; t += 50) await sleep(50);
    }
  };
  build = builder(limit, { wait, delay: (a) => (a.featureId === 'F2' ? 3000 : 0) });
  const verify = verifier();
  const r = await run(dir, { build, verify }, { parallel: 2 });
  assert.equal(r.interrupted, true, r.out);
  assert.equal(r.usageLimit?.feature, 'F1');
  assert.deepEqual(r.results, []);
  const f2 = build.calls.filter((c) => c.featureId === 'F2');
  assert.equal(f2.length, 1);
  assert.ok(f2[0].done && !f2[0].aborted, 'F2 finished its build step, not aborted');
  assert.ok(!verify.calls.includes('F2'), 'F2 did not start its next step (verify)');
  assert.equal(build.calls.filter((c) => c.featureId === 'F3').length, 0, 'F3 was not started');
  assert.equal(statusOf(dir, 'F3'), 'approved');
  assert.equal(statusOf(dir, 'F1'), 'in_progress');
  const saved = readJson(statePath(dir));
  assert.deepEqual(saved.active.map((e) => e.feature).sort(), ['F1', 'F2']);
  limit.on = false;
  const r2 = await run(dir, { build }, { resume: true, parallel: 2 });
  assert.deepEqual(r2.results.map((x) => [x.feature, x.status]).sort(), [['F1', 'passed'], ['F2', 'passed'], ['F3', 'passed']], r2.out);
  assert.equal(build.calls.filter((c) => c.featureId === 'F2').length, 1, 'F2 is not rebuilt');
});

// ------------------------------------------------------------------ AC-6
test('F88 AC-6 harness eval: a usage limit exits 1 with the detail and records nothing', () => {
  const dir = fixture(['F1'], { config: CLAUDE_ROLES });
  const prior = { feature: 'F1', round: 1, verdict: 'eval_error', error: 'exit_nonzero', detail: null, consecutive: 1, score: null, scores: null, blocking: [], backlogged: [], independence: 'fresh-context', costUsd: 0, at: '2026-10-08T00:00:00.000Z', origin: 'eval' };
  const errFile = path.join(dir, '.harness/verdicts/F1-r1.eval_error.json');
  writeFiles(dir, { '.harness/verdicts/F1-r1.eval_error.json': prior });
  const before = fs.readFileSync(errFile, 'utf8');
  for (const exit of [1, 0]) {
    const r = cli(['eval', 'F1'], dir, LIMIT, exit);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    for (const w of ['usage limit', LIMIT_TEXT]) assert.ok(r.stderr.includes(w), `${w} in: ${r.stderr}`);
    assert.equal(statusOf(dir), 'approved', 'status unchanged');
    assert.deepEqual(verdictFiles(dir), ['F1-r1.eval_error.json'], 'no verdict file written');
    assert.equal(fs.readFileSync(errFile, 'utf8'), before, 'the consecutive eval_error count is unchanged');
  }
});

// ------------------------------------------------------------------ AC-7
test('F88 AC-7 SPEC §8 describes the usage limit: condition, run stop and resume, and harness eval', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s8 = spec.slice(spec.indexOf('## 8.'), spec.indexOf('## 9.'));
  const line = s8.split('\n').find((l) => l.includes('usage_limit_reached'));
  assert.ok(line, 'no usage-limit rule in §8');
  for (const w of ['is_error', 'api_error', 'api_error_status', '429', 'usage_limit', '300자', 'harness run --resume', 'in_progress', 'eval_error', 'harness eval', 'exit 1', 'active']) {
    assert.ok(line.includes(w), w);
  }
});
