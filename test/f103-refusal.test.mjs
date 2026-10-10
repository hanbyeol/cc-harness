import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BIN, REPO, harness, tmpdir } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { getAdapter } from '../lib/adapters/index.mjs';
import { runAdapter } from '../lib/adapters/common.mjs';
import { readEvents } from '../lib/events.mjs';
import { exportLine } from '../lib/telemetry.mjs';
import { verify as realVerify } from '../lib/verify.mjs';
import { runFeatures } from '../lib/run.mjs';

const FIX = path.join(REPO, 'test', 'fixtures');
const FAKE = path.join(FIX, 'fake-cli.mjs');
const FAKE_CLAUDE = path.join(FIX, 'fake-claude.mjs');
const PASS_REPLY = JSON.parse(fs.readFileSync(path.join(FIX, 'eval', 'pass.json'), 'utf8'));

// A refusal wrapper with the keys of a measured claude 2.1 `--output-format json` wrapper
// (stop_reason, safety_stops, is_error, api_error_status, result, …); only the values are made up.
const REFUSAL = JSON.parse(fs.readFileSync(path.join(FIX, 'output', 'claude-json-refusal.json'), 'utf8'));
const REFUSAL_TEXT = REFUSAL.result;
// The same wrapper as a normal answer.
const NORMAL = { ...REFUSAL, stop_reason: 'end_turn', safety_stops: 0, result: '{"ok":true}' };
const LIMIT = { ...REFUSAL, is_error: true, api_error: 'usage_limit_reached', api_error_status: 429, result: "You've hit your session limit · resets 3:10am (Asia/Seoul)" };

const replyFile = (reply) => {
  const f = path.join(tmpdir('harness-f103-reply-'), 'reply.json');
  fs.writeFileSync(f, typeof reply === 'string' ? reply : JSON.stringify(reply));
  return f;
};
const fakeOpts = (reply, fail, opts) => ({ prompt: 'x', cwd: REPO, timeoutSec: 30, ...opts, bin: process.execPath, binArgs: [FAKE, fail ? 'print-fail' : 'print', replyFile(reply)] });
// One claude adapter call against the fake CLI printing `reply`; `fail` makes it exit 1.
const claudeRun = (reply, { fail = false, ...opts } = {}) => getAdapter('claude').run(fakeOpts(reply, fail, opts));
// The same call through the claude adapter without refusal detection (the behaviour before F103).
const claudeRunBefore = (reply, { fail = false, ...opts } = {}) => {
  const { refusal, ...before } = getAdapter('claude');
  return runAdapter(before, fakeOpts(reply, fail, opts));
};

// ------------------------------------------------------------------ run fixtures

function contract(id, tier = 'standard') {
  const c = {
    id, title: `feature ${id}`, security_tier: tier, version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-09T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture(ids = ['F1'], { tier = 'standard', config = {}, feature = {}, files = {} } = {}) {
  const all = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...config },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: tier, depends_on: [], status: 'approved', ...feature })) },
    'scripts/ok.mjs': 'process.exit(0);\n',
    ...files,
  };
  for (const id of ids) all[`.harness/contracts/${id}.json`] = contract(id, tier);
  return gitRepo(all, { branch: null });
}

const cfg = (over = {}) => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, ...over });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const featureOf = (dir, id = 'F1') => readJson(path.join(dir, '.harness/features.json')).features.find((f) => f.id === id);
const verdictFiles = (dir) => {
  const d = path.join(dir, '.harness/verdicts');
  return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
};
const readLines = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const runMetrics = (r) => readLines(r.report.replace(/\.md$/, '.metrics.jsonl'));
const statusEvents = (dir, id) => readEvents(dir).events.filter((e) => e.type === 'status' && e.feature === id);

// A builder that is refused (through the claude adapter) for the features in `refuse`, and
// otherwise writes <id>.txt and succeeds.
function builder(refuse = ['F1']) {
  const calls = [];
  const fn = async (a) => {
    calls.push(a.featureId);
    if (refuse.includes(a.featureId)) return claudeRun(REFUSAL, { cwd: a.cwd });
    writeFiles(a.cwd, { [`${a.featureId}.txt`]: `built r${a.round}\n` });
    return { ok: true, costUsd: 0 };
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

// Evaluator roles: `script[role]` is 'refuse' or 'pass' (the default).
function roles(script = {}) {
  const calls = [];
  const fn = async (role, opts) => {
    calls.push(role);
    if (script[role] === 'refuse') return claudeRun(REFUSAL, { cwd: opts.cwd, readOnly: true, schema: { type: 'object' } });
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

// The Blocked reason cell of `id` in the run report's Features table.
function blockedCell(r, id) {
  const lines = fs.readFileSync(r.report, 'utf8').split(/\r?\n/);
  const header = lines.find((l) => l.startsWith('| Feature |')).split('|').map((c) => c.trim());
  const row = lines.find((l) => l.startsWith(`| ${id} `)).split('|').map((c) => c.trim());
  return row[header.indexOf('Blocked reason')];
}

// A PATH directory holding a fake `claude` (fixtures/fake-claude.mjs).
function fakeClaudeBin() {
  const dir = tmpdir('harness-f103-bin-');
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'claude.cmd'), `@"${process.execPath}" "${FAKE_CLAUDE}" %*\r\n`);
  } else {
    const f = path.join(dir, 'claude');
    fs.writeFileSync(f, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`);
    fs.chmodSync(f, 0o755);
  }
  return dir;
}
const GIT_DIR = path.dirname(spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim());

// The real CLI with the fake claude first on PATH, printing `reply` and exiting `exit`.
function cli(args, dir, reply, exit = 0) {
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const env = { ...process.env, [pathKey]: [fakeClaudeBin(), path.dirname(process.execPath), GIT_DIR].join(path.delimiter),
    FAKE_CLAUDE_REPLY: replyFile(reply), FAKE_CLAUDE_EXIT: String(exit) };
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, env, encoding: 'utf8', timeout: 180000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const CLAUDE_ROLES = { roles: { builder: 'claude', evaluator: 'claude', 'security-reviewer': 'claude' } };

// ------------------------------------------------------------------ AC-1
test('F103 AC-1 a stop_reason refusal wrapper is error refusal with the result sentence and safety_stops in the detail', async () => {
  for (const fail of [false, true]) {
    for (const isError of [false, true]) {
      const r = await claudeRun({ ...REFUSAL, is_error: isError }, { fail });
      assert.equal(r.ok, false, `fail=${fail} is_error=${isError}`);
      assert.equal(r.error, 'refusal', `fail=${fail} is_error=${isError}`);
      assert.equal(r.detail, `${REFUSAL_TEXT} (safety_stops: 1)`);
      assert.equal(r.exitCode, fail ? 1 : 0);
    }
  }
  // With a schema the missing JSON is not reported as no_json: the refusal comes first.
  const s = await claudeRun(REFUSAL, { readOnly: true, schema: { type: 'object' } });
  assert.equal(s.error, 'refusal');
  const three = await claudeRun({ ...REFUSAL, safety_stops: 3 });
  assert.ok(three.detail.endsWith('(safety_stops: 3)'), three.detail);
});

test('F103 AC-1 the detail holds the first 300 characters of the result sentence', async () => {
  const long = `${REFUSAL_TEXT} ${'x'.repeat(1000)}`;
  const r = await claudeRun({ ...REFUSAL, result: long });
  assert.equal(r.error, 'refusal');
  assert.equal(r.detail, `${long.slice(0, 300)} (safety_stops: 1)`);
});

test('F103 AC-1 an end_turn answer with safety_stops 0 is handled as before the feature', async () => {
  for (const opts of [{}, { readOnly: true, schema: { type: 'object' } }, { fail: true }]) {
    const now = await claudeRun(NORMAL, opts);
    const before = await claudeRunBefore(NORMAL, opts);
    assert.deepEqual(now, before, JSON.stringify(opts));
    assert.notEqual(now.error, 'refusal');
  }
  const ok = await claudeRun(NORMAL, { readOnly: true, schema: { type: 'object' } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.json, { ok: true });
});

// ------------------------------------------------------------------ ES-1
test('F103 ES-1 output that is not JSON, or a wrapper without a string stop_reason, is not refusal', async () => {
  const text = await claudeRun('{"stop_reason":"refusal" — not json', { fail: true });
  assert.equal(text.error, 'exit_nonzero');
  assert.notEqual((await claudeRun('stop_reason refusal', { fail: false })).error, 'refusal');
  const { stop_reason: _, ...missing } = REFUSAL;
  for (const w of [missing, { ...REFUSAL, stop_reason: null }, { ...REFUSAL, stop_reason: ['refusal'] }, { ...REFUSAL, stop_reason: { refusal: true } }, { ...REFUSAL, stop_reason: 1 }]) {
    for (const fail of [false, true]) {
      const r = await claudeRun(w, { fail });
      assert.notEqual(r.error, 'refusal', `${JSON.stringify(w.stop_reason)} fail=${fail}`);
      assert.equal(r.error, fail ? 'exit_nonzero' : null);
    }
  }
  // The control: the same wrapper with the string stop_reason is a refusal.
  for (const fail of [false, true]) assert.equal((await claudeRun({ ...missing, stop_reason: 'refusal' }, { fail })).error, 'refusal');
});

test('F103 ES-1 a wrapper that is both a usage limit and a refusal is usage_limit', async () => {
  for (const fail of [false, true]) {
    const r = await claudeRun(LIMIT, { fail });
    assert.equal(r.error, 'usage_limit', `fail=${fail}`);
    assert.equal(r.detail, LIMIT.result);
    // The same wrapper without its usage-limit fields is a refusal: both conditions were there.
    const { api_error: _, ...noLimit } = LIMIT;
    const refused = await claudeRun({ ...noLimit, is_error: false, api_error_status: null }, { fail });
    assert.equal(refused.error, 'refusal', `fail=${fail}`);
  }
});

// ------------------------------------------------------------------ AC-2
test('F103 AC-2 a refused build blocks the feature (refusal) without another attempt, verify or eval; the run goes on', async () => {
  const dir = fixture(['F1', 'F2']);
  const build = builder(['F1']);
  const verify = verifier();
  const evaluator = roles();
  const r = await run(dir, { build, verify, runAdapter: evaluator });
  const f1 = r.results.find((x) => x.feature === 'F1');
  const f2 = r.results.find((x) => x.feature === 'F2');
  assert.equal(f1?.status, 'blocked', r.out);
  assert.equal(f1.reason, 'refusal');
  assert.equal(f2?.status, 'passed', `the run goes on with F2: ${r.out}`);
  assert.equal(build.calls.filter((id) => id === 'F1').length, 1, 'no further build attempt');
  assert.ok(!verify.calls.includes('F1'), 'no verify for F1');
  assert.equal(evaluator.calls.length, 1, 'only F2 was evaluated');
  assert.ok(!verdictFiles(dir).some((f) => f.startsWith('F1-')), verdictFiles(dir).join(', '));
  assert.equal(featureOf(dir, 'F1').status, 'blocked');
  assert.equal(featureOf(dir, 'F1').blocked_reason, 'refusal');
  assert.ok(blockedCell(r, 'F1').startsWith('refusal'), blockedCell(r, 'F1'));
  const blockedEvent = statusEvents(dir, 'F1').find((e) => e.data?.to === 'blocked');
  assert.equal(blockedEvent?.stage, 'build', JSON.stringify(statusEvents(dir, 'F1')));
  assert.equal(blockedEvent.data.reason, 'refusal');
  const builds = runMetrics(r).filter((m) => m.feature === 'F1' && m.step === 'build');
  assert.deepEqual(builds.map((m) => m.outcome), ['refusal']);
});

// ------------------------------------------------------------------ AC-3
test('F103 AC-3 a refused evaluator blocks the feature (refusal): no eval_error, not asked again, no verdict', async () => {
  const dir = fixture(['F1', 'F2']);
  const evaluator = roles({ evaluator: 'refuse' });
  const r = await run(dir, { build: builder([]), runAdapter: evaluator });
  const f1 = r.results.find((x) => x.feature === 'F1');
  assert.equal(f1?.status, 'blocked', r.out);
  assert.equal(f1.reason, 'refusal');
  assert.ok(f1.detail.includes(REFUSAL_TEXT), f1.detail);
  assert.equal(r.results.find((x) => x.feature === 'F2')?.status, 'blocked', 'F2 was still run');
  assert.equal(evaluator.calls.length, 2, 'one evaluator call per feature, none asked again');
  assert.deepEqual(verdictFiles(dir), [], 'no verdict and no eval_error file');
  assert.equal(featureOf(dir, 'F1').blocked_reason, 'refusal');
  const evals = runMetrics(r).filter((m) => m.feature === 'F1' && m.step === 'eval');
  assert.deepEqual(evals.map((m) => m.outcome), ['refusal']);
  assert.equal(statusEvents(dir, 'F1').find((e) => e.data?.to === 'blocked')?.data.reason, 'refusal');
});

test('F103 AC-3 a refused security-reviewer blocks the feature (refusal) the same way', async () => {
  const dir = fixture(['F1'], { tier: 'critical' });
  const evaluator = roles({ 'security-reviewer': 'refuse' });
  const r = await run(dir, { build: builder([]), runAdapter: evaluator });
  assert.equal(r.results[0]?.status, 'blocked', r.out);
  assert.equal(r.results[0].reason, 'refusal');
  assert.equal(evaluator.calls.filter((c) => c === 'security-reviewer').length, 1, 'not asked again');
  assert.deepEqual(verdictFiles(dir), []);
  assert.equal(featureOf(dir).blocked_reason, 'refusal');
});

test('F103 AC-3 harness eval: a refusal exits 1 with refusal and the detail, writes no verdict and keeps the status', () => {
  const dir = fixture(['F1'], { config: CLAUDE_ROLES });
  for (const exit of [0, 1]) {
    const r = cli(['eval', 'F1'], dir, REFUSAL, exit);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    for (const w of ['refusal', REFUSAL_TEXT, 'safety_stops: 1']) assert.ok(r.stderr.includes(w), `${w} in: ${r.stderr}`);
    assert.equal(featureOf(dir).status, 'approved', 'status unchanged');
    assert.deepEqual(verdictFiles(dir), [], 'no verdict file written');
  }
});

// ------------------------------------------------------------------ AC-4
test('F103 AC-4 blocked (refusal) with max_rounds verdicts of the same hash is re-approved', () => {
  const hash = contract('F1').approval.hash;
  const verdict = (k) => ({
    feature: 'F1', round: k, verdict: 'fail', score: 3, verify_pass: true, origin: 'eval', contract_hash: hash, contract_round: k,
    blocking: [{ criterion_id: 'AC-1', summary: 'broken', repro: 'node scripts/ok.mjs', exit: 1 }], backlogged: [],
  });
  const files = Object.fromEntries([1, 2, 3].map((k) => [`.harness/verdicts/F1-r${k}.json`, verdict(k)]));
  const dir = fixture(['F1'], { feature: { status: 'blocked', blocked_reason: 'refusal', eval_round: 3 }, files });
  const r = harness(['approve', 'F1', '--by', 'test'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(featureOf(dir).status, 'approved');
  assert.equal('blocked_reason' in featureOf(dir), false);
});

test('F103 AC-4 harness status shows (refusal) on the blocked line', () => {
  const dir = fixture(['F1'], { feature: { status: 'blocked', blocked_reason: 'refusal' } });
  const r = harness(['status'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^\s*F1\s+blocked \(refusal\)\s+feature F1$/m);
});

test('F103 AC-4 telemetry export keeps the reason refusal', () => {
  const line = exportLine({ ts: '2026-10-09T00:00:00.000Z', stage: 'build', type: 'status', feature: 'F1', round: 1, data: { from: 'in_progress', to: 'blocked', reason: 'refusal' } }, { project: 'a'.repeat(16) });
  assert.deepEqual(line.data, { from: 'in_progress', to: 'blocked', reason: 'refusal' });
});

// ------------------------------------------------------------------ AC-5
test('F103 AC-5 SPEC §7.6, §8 and §10 describe refusal: the stop_reason condition, run and eval handling, re-approval', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s76 = spec.slice(spec.indexOf('6. **대화형 eval 의 상태 기록**'), spec.indexOf('7. **backlog 정리 루프**'));
  const others = s76.match(/그 밖의 사유\(([^)]*)\)면/);
  assert.ok(others && others[1].includes('`refusal`'), 'refusal is among the re-approvable reasons');
  assert.match(s76, /`refusal`[^.]*`needs_human` 과 같은 규칙/);
  assert.match(s76, /blocked \(refusal\)/);
  const s8 = spec.slice(spec.indexOf('## 8.'), spec.indexOf('## 9.'));
  const line = s8.split('\n').find((l) => l.startsWith('모델 거부(refusal)'));
  assert.ok(line, 'no refusal rule in §8');
  for (const w of ['stop_reason', '`refusal`', 'is_error', '300자', 'safety_stops', 'usage_limit', '남은 build 시도', 'verify·eval 없이', 'eval_error 로 세지 않고', '다시 묻지 않으며',
    'harness eval F{n}', 'exit 1', '판정 파일을 쓰지 않고', 'harness approve F{n}', '다른 기능을 계속']) {
    assert.ok(line.includes(w), w);
  }
  const s10 = spec.slice(spec.indexOf('## 10.'), spec.indexOf('## 11.'));
  assert.match(s10, /`stop_reason` 이 `refusal` 이면 `refusal`/);
});
