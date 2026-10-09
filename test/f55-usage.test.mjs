import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpdir, readJson } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { runFeatures } from '../lib/run.mjs';
import { verify } from '../lib/verify.mjs';
import { METRIC_FIELDS } from '../lib/metrics.mjs';
import { parseOutput, parseUsage } from '../lib/adapters/index.mjs';
import { claudeSessionLog, usageOf } from '../lib/usage.mjs';
import claude from '../lib/adapters/claude.mjs';
import gemini from '../lib/adapters/gemini.mjs';
import codex from '../lib/adapters/codex.mjs';
import { createGenericAdapter } from '../lib/adapters/generic.mjs';
import evalCommand from '../lib/commands/eval.mjs';

// F55: adapter usage (turns, tokens, session) in metrics and build/eval/security step events,
// where the claude session log is, and verify/command · verify/check events.

const FAKE = path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs');
const RECORDED = path.join(REPO, 'test', 'fixtures', 'output', 'claude-json-success.json');
const SESSION = 'bfb2cc03-8b1a-4cee-9d97-a5e8a4463f57';
const TOKENS = { input: 2, output: 1537, cache_read: 24084, cache_creation: 12493 };
const NULL_USAGE = { turns: null, tokens: null, session_id: null, duration_api_ms: null };
const MARK = { prompt: 'F55-MARK-PROMPT-q7', response: 'F55-MARK-RESPONSE-z3', diff: 'F55-MARK-DIFF-k9' };

// The recorded claude wrapper with `result` (and optionally usage fields) replaced.
function wrapperFile(result, patch = {}) {
  const w = { ...readJson(RECORDED), result, ...patch };
  const file = path.join(tmpdir('harness-f55-out-'), 'claude.json');
  fs.writeFileSync(file, JSON.stringify(w));
  return file;
}
const viaFake = (file) => ({ bin: process.execPath, binArgs: [FAKE, 'print', file] });
// What the adapter reads from stdout: the parsed reply and its usage.
const parsed = (raw) => ({ ...parseOutput(raw), ...parseUsage(raw) });

const scores = { functionality: 9, quality: 9, security: 9, errors: 9, tests: 9 };
const EVAL_REPLY = { scores, findings: [], out_of_scope: [] };

function contract(id, { tier = 'standard', title = `feature ${id}` } = {}) {
  const c = {
    id, title, security_tier: tier, version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id} works`, check: 'node scripts/ok.mjs', new: false }],
    security_criteria: tier === 'critical' ? [{ id: 'SC-1', criterion: 'safe', check: 'node scripts/ok.mjs', new: false }] : [],
    error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-27T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function project({ tier = 'standard', title, config = {} } = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...config },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: title ?? 'feature F1', security_tier: tier, depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract('F1', { tier, title }),
    'scripts/ok.mjs': 'process.exit(0);\n',
  }, { branch: null });
}

const eventsDir = (dir) => path.join(dir, '.harness', 'events');
const eventsText = (dir) => {
  let names = [];
  try { names = fs.readdirSync(eventsDir(dir)).sort(); } catch { return ''; }
  return names.map((n) => fs.readFileSync(path.join(eventsDir(dir), n), 'utf8')).join('');
};
const events = (dir) => eventsText(dir).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const of = (dir, stage, type) => events(dir).filter((e) => e.stage === stage && e.type === type);
const runsDir = (dir) => path.join(dir, '.harness', 'runs');
const metricsText = (dir) => {
  let names = [];
  try { names = fs.readdirSync(runsDir(dir)).filter((n) => n.endsWith('.metrics.jsonl')).sort(); } catch { return ''; }
  return names.map((n) => fs.readFileSync(path.join(runsDir(dir), n), 'utf8')).join('');
};
const metrics = (dir) => metricsText(dir).split('\n').filter(Boolean).map((l) => JSON.parse(l));

const runCfg = (extra = {}) => resolveConfig({
  base_branch: 'main', run: { max_parallel: 1 }, verify: { commands: [] }, budget: { step_timeout_sec: 120 },
  roles: { builder: 'claude', evaluator: 'claude', 'security-reviewer': 'claude' }, ...extra,
});
const RUN_PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };

// A build through the real claude adapter: the fake CLI prints the recorded wrapper.
const claudeBuild = (file, { diff = 'x\n', prompt = 'build it' } = {}) => async (a) => {
  writeFiles(a.cwd, { 'F1.txt': diff });
  return claude.run({ role: 'builder', prompt, cwd: a.cwd, readOnly: false, timeoutSec: 60, ...viaFake(file) });
};
// Evaluator and security-reviewer through the real claude adapter.
const claudeRoles = (file) => async (role, opts) => claude.run({ ...opts, ...viaFake(file) });

// HOME (USERPROFILE on Windows) pointed at a temporary directory for the duration of `fn`.
async function withHome(fn) {
  const home = fs.realpathSync.native(tmpdir('harness-f55-home-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(home);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
const encodeCwd = (cwd) => fs.realpathSync.native(cwd).replace(/[^A-Za-z0-9]/g, '-');

// ---------- AC-1 ----------
test('F55 AC-1: the claude adapter reads num_turns, usage, session_id and duration_api_ms from the recorded output', async () => {
  const p = parsed(fs.readFileSync(RECORDED, 'utf8'));
  assert.equal(p.turns, 1);
  assert.deepEqual(p.tokens, TOKENS);
  assert.equal(p.sessionId, SESSION);
  assert.equal(p.durationApiMs, 16620);
  const r = await claude.run({ prompt: 'x', cwd: REPO, ...viaFake(RECORDED) });
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(usageOf(r), { turns: 1, tokens: TOKENS, session_id: SESSION, duration_api_ms: 16620 });
});

test('F55 AC-1: run writes turns, tokens and session_id to the build metrics line and a build/step event', async () => {
  const dir = project();
  const file = wrapperFile('done');
  await runFeatures({ root: dir, config: runCfg(), deps: {
    build: claudeBuild(file), verify: async () => RUN_PASSING,
    evaluate: async (a) => ({ feature: a.featureId, round: a.round, score: 9, scores, backlogged: [], blocking: [], independence: 'cross-model', costUsd: 0, file: null, verdict: 'pass' }),
  } });
  const [m] = metrics(dir).filter((l) => l.step === 'build');
  assert.deepEqual(Object.keys(m), [...METRIC_FIELDS]);
  assert.equal(m.turns, 1);
  assert.deepEqual(m.tokens, TOKENS);
  assert.equal(m.session_id, SESSION);
  const [e] = of(dir, 'build', 'step');
  assert.equal(e.feature, 'F1');
  assert.equal(e.round, 1);
  assert.equal(e.data.step, 'build');
  assert.equal(e.data.role, 'builder');
  assert.equal(e.data.adapter, 'claude');
  assert.equal(e.data.outcome, 'ok');
  assert.equal(e.data.turns, 1);
  assert.deepEqual(e.data.tokens, TOKENS);
  assert.equal(e.data.session_id, SESSION);
  assert.equal(e.data.duration_api_ms, 16620);
  assert.equal(e.data.cost_usd, 0.0701628);
  assert.equal(typeof e.data.duration_ms, 'number');
});

test('F55 AC-1: run records one eval/step or security/step event per reviewer call and sums the usage on the eval metrics line', async () => {
  const dir = project({ tier: 'critical' });
  const file = wrapperFile(JSON.stringify(EVAL_REPLY));
  const r = await runFeatures({ root: dir, config: runCfg(), deps: {
    build: claudeBuild(wrapperFile('done')), verify: async () => RUN_PASSING, runAdapter: claudeRoles(file),
  } });
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results));
  const ev = of(dir, 'eval', 'step');
  const sec = of(dir, 'security', 'step');
  assert.equal(ev.length, 1);
  assert.equal(sec.length, 1);
  assert.deepEqual([ev[0].data.role, sec[0].data.role], ['evaluator', 'security-reviewer']);
  for (const e of [...ev, ...sec]) {
    assert.equal(e.feature, 'F1');
    assert.equal(e.round, 1);
    assert.equal(e.data.turns, 1);
    assert.deepEqual(e.data.tokens, TOKENS);
    assert.equal(e.data.session_id, SESSION);
    assert.equal(e.data.outcome, 'ok');
  }
  const [m] = metrics(dir).filter((l) => l.step === 'eval');
  assert.equal(m.turns, 2);
  assert.deepEqual(m.tokens, { input: 4, output: 3074, cache_read: 48168, cache_creation: 24986 });
  assert.equal(m.session_id, SESSION);
});

test('F55 AC-1: interactive eval writes usage to each eval.metrics.jsonl line and records eval/step and security/step events', async () => {
  const dir = project({ tier: 'critical', config: { roles: { builder: 'claude', evaluator: 'claude', 'security-reviewer': 'claude' } } });
  const file = wrapperFile(JSON.stringify(EVAL_REPLY));
  const code = await evalCommand({ root: dir, args: ['F1'], out: () => {}, err: () => {},
    deps: { runAdapter: claudeRoles(file), verifyResult: { ...RUN_PASSING, criteria: [{ id: 'AC-1', pass: true }, { id: 'SC-1', pass: true }] } } });
  assert.equal(code, 0);
  const lines = metrics(dir);
  // the two reviewers run concurrently: their lines come in either order
  assert.deepEqual(lines.map((l) => l.role).sort(), ['evaluator', 'security-reviewer']);
  for (const l of lines) {
    assert.deepEqual(Object.keys(l), [...METRIC_FIELDS]);
    assert.deepEqual([l.turns, l.tokens, l.session_id], [1, TOKENS, SESSION]);
  }
  assert.deepEqual(of(dir, 'eval', 'step').map((e) => [e.feature, e.round, e.data.role, e.data.turns]), [['F1', 1, 'evaluator', 1]]);
  assert.deepEqual(of(dir, 'security', 'step').map((e) => [e.feature, e.round, e.data.role, e.data.session_id]), [['F1', 1, 'security-reviewer', SESSION]]);
});

// ---------- AC-2 ----------
test('F55 AC-2: the session log path is ~/.claude/projects/<encoded cwd>/<session_id>.jsonl; exists follows the file', async () => {
  await withHome(async (home) => {
    const cwd = tmpdir('harness-f55-cwd.x_');
    const expected = path.join(home, '.claude', 'projects', encodeCwd(cwd), `${SESSION}.jsonl`);
    assert.match(encodeCwd(cwd), /^[A-Za-z0-9-]+$/);
    assert.deepEqual(claudeSessionLog(SESSION, cwd), { path: expected, exists: false });
    fs.mkdirSync(path.dirname(expected), { recursive: true });
    fs.writeFileSync(expected, '{}\n');
    assert.deepEqual(claudeSessionLog(SESSION, cwd), { path: expected, exists: true });
    assert.equal(claudeSessionLog(null, cwd), null);
  });
});

test('F55 AC-2: a build/step event carries the session log of the builder session, exists: true when the file is there', async () => {
  await withHome(async (home) => {
    const dir = project();
    const file = wrapperFile('done');
    let log = null; // computed while the worktree exists: run removes it at the end
    const build = async (a) => {
      log = path.join(home, '.claude', 'projects', encodeCwd(a.cwd), `${SESSION}.jsonl`);
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fs.writeFileSync(log, '{}\n');
      return claudeBuild(file)(a);
    };
    await runFeatures({ root: dir, config: runCfg(), deps: {
      build, verify: async () => RUN_PASSING,
      evaluate: async (a) => ({ feature: a.featureId, round: a.round, score: 9, scores, backlogged: [], blocking: [], independence: 'cross-model', costUsd: 0, file: null, verdict: 'pass' }),
    } });
    const [e] = of(dir, 'build', 'step');
    assert.deepEqual(e.data.session_log, { path: log, exists: true });
  });
});

test('F55 AC-2: no session id, or one that is not a plain id, gives no session log path', async () => {
  await withHome(async () => {
    const cwd = tmpdir('harness-f55-cwd-');
    for (const bad of ['../../etc/passwd', 'a/b', 'a\\b', '', 'x'.repeat(200)]) {
      assert.equal(claudeSessionLog(bad, cwd), null, bad);
      const p = parsed(JSON.stringify({ ...readJson(RECORDED), session_id: bad }));
      assert.equal(p.sessionId, null, bad);
    }
  });
});

// ---------- AC-3 ----------
const WAIT_FOR = (file) => `const t0 = Date.now(); while (!fs.existsSync(${JSON.stringify(file)}) && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 20));\n`;
test('F55 AC-3: verify records a verify/command event per command and a verify/check event per criterion with time, result and re-runs', async () => {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main' },
    '.harness/features.json': { features: [{ id: 'F9', title: 'x', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': {
      id: 'F9', title: 'x', security_tier: 'standard', version: 1,
      acceptance_criteria: [
        { id: 'AC-1', criterion: 'a', check: 'node scripts/a.mjs', new: false },
        { id: 'AC-2', criterion: 'b', check: 'node scripts/b.mjs', new: false },
      ],
      security_criteria: [], error_scenarios: [{ id: 'ES-1', criterion: 'c', check: 'node scripts/fail.mjs', new: false }], out_of_scope: [],
    },
    'scripts/ok.mjs': 'process.exit(0);\n',
    'scripts/fail.mjs': 'process.exit(3);\n',
    'scripts/flaky.mjs': "import fs from 'node:fs';\nconst f = 'flaky.state';\nif (fs.existsSync(f)) process.exit(0);\nfs.writeFileSync(f, '1');\nprocess.exit(1);\n",
    // AC-1 fails once while AC-2 is running (by construction: each waits for the other to start),
    // then passes when re-run alone.
    'scripts/a.mjs': `import fs from 'node:fs';\nfs.writeFileSync('a.started', '1');\n${WAIT_FOR('b.started')}if (fs.existsSync('a.retry')) process.exit(0);\nfs.writeFileSync('a.retry', '1');\nprocess.exit(1);\n`,
    'scripts/b.mjs': `import fs from 'node:fs';\nfs.writeFileSync('b.started', '1');\n${WAIT_FOR('a.started')}process.exit(0);\n`,
    '.gitignore': '*.started\n*.retry\n*.state\n',
  });
  const config = resolveConfig({ base_branch: 'main', verify: { commands: ['node scripts/ok.mjs', 'node scripts/flaky.mjs'], check_parallel: 2, flaky: 'fail' }, budget: { step_timeout_sec: 60 } });
  const r = await verify({ root: dir, featureId: 'F9', base: 'main', config, cpus: 8 });
  assert.equal(r.criteria[0].parallel_retry, true, JSON.stringify(r.criteria));
  const cmds = of(dir, 'verify', 'command');
  assert.equal(cmds.length, 2);
  assert.deepEqual(cmds.map((e) => [e.feature, e.data.index, e.data.program, e.data.pass, e.data.attempts, e.data.flaky]),
    [['F9', 0, 'node', true, 1, false], ['F9', 1, 'node', false, 2, true]]);
  for (const e of cmds) assert.ok(Number.isInteger(e.data.duration_ms) && e.data.duration_ms >= 0, JSON.stringify(e.data));
  const checks = of(dir, 'verify', 'check');
  // ES-1 fails either way; whether it overlapped another check (and was re-run) depends on timing
  assert.deepEqual(checks.map((e) => [e.feature, e.data.id, e.data.pass]), [['F9', 'AC-1', true], ['F9', 'AC-2', true], ['F9', 'ES-1', false]]);
  assert.deepEqual([checks[0].data.parallel_retry, checks[1].data.parallel_retry], [true, false]);
  assert.equal(checks[2].data.parallel_retry, r.criteria[2].parallel_retry === true);
  for (const e of checks) {
    assert.ok(Number.isInteger(e.data.duration_ms) && e.data.duration_ms >= 0, JSON.stringify(e.data));
    assert.equal(e.data.vacuous, false);
    assert.equal(e.data.timed_out, false);
  }
  assert.equal(checks[2].data.exit_code, 3);
});

test('F55 AC-3: run passes its round to the verify events', async () => {
  const dir = project();
  // The verify result cache (F87) is off, so the post-merge verify runs its checks too.
  await runFeatures({ root: dir, config: runCfg({ verify: { commands: [], cache: 'off' } }), deps: {
    build: async (a) => { writeFiles(a.cwd, { 'F1.txt': 'x\n' }); return { ok: true, costUsd: 0 }; },
    evaluate: async (a) => ({ feature: a.featureId, round: a.round, score: 9, scores, backlogged: [], blocking: [], independence: 'cross-model', costUsd: 0, file: null, verdict: 'pass' }),
  } });
  const checks = of(dir, 'verify', 'check');
  assert.ok(checks.length >= 1, JSON.stringify(events(dir).map((e) => `${e.stage}/${e.type}`)));
  assert.ok(checks.every((e) => e.feature === 'F1' && e.round === 1 && e.data.id === 'AC-1'));
  assert.deepEqual([...new Set(checks.map((e) => e.data.step))].sort(), ['post_merge_verify', 'verify']);
});

// ---------- AC-4 ----------
test('F55 AC-4: gemini, codex and generic results carry null usage fields without an error', async () => {
  const geminiOut = path.join(tmpdir('harness-f55-g-'), 'g.json');
  fs.writeFileSync(geminiOut, JSON.stringify({ session_id: 'g-1', response: '{"ok":true}', stats: { models: {} } }));
  const generic = createGenericAdapter({ adapters: { generic: { command: [process.execPath, FAKE, 'text', '{"ok":true}'] } } });
  const results = [
    await gemini.run({ prompt: 'x', cwd: REPO, ...viaFake(geminiOut) }),
    await codex.run({ prompt: 'x', cwd: REPO, bin: process.execPath, binArgs: [FAKE, 'text', '{"ok":true}'] }),
    await generic.run({ prompt: 'x', cwd: REPO }),
    await createGenericAdapter({}).run({ prompt: 'x', cwd: REPO, readOnly: true }),
  ];
  for (const r of results.slice(0, 3)) assert.equal(r.ok, true, r.detail);
  for (const r of results) {
    assert.deepEqual(usageOf(r), NULL_USAGE);
    assert.deepEqual([r.turns ?? null, r.tokens ?? null, r.sessionId ?? null], [null, null, null]);
  }
  assert.equal(usageOf(null).turns, null);
  assert.equal(usageOf({ ok: true, costUsd: 0 }).tokens, null);
});

// ---------- AC-5 ----------
const section = (text, head) => {
  const i = text.indexOf(head);
  assert.ok(i >= 0, head);
  const level = head.match(/^#+/)[0];
  const rest = text.slice(i + head.length);
  const next = rest.search(new RegExp(`\\n${level} `));
  return next === -1 ? rest : rest.slice(0, next);
};
test('F55 AC-5: SPEC and the README describe the usage fields, the session log and the verify events', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s2 = section(spec, '## 2. ');
  for (const re of [/build\/step/, /eval\/step/, /security\/step/, /verify\/command/, /verify\/check/, /`turns`/, /`tokens`/, /`session_id`/,
    /`duration_api_ms`/, /`session_log`/, /~\/\.claude\/projects\//, /num_turns/, /`flaky`/, /`parallel_retry`/, /`duration_ms`/, /null/]) {
    assert.match(s2, re);
  }
  const s8 = section(spec, '## 8. ');
  for (const re of [/`turns`/, /`tokens`/, /`session_id`/]) assert.match(s8, re);
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  for (const re of [/build\/step/, /verify\/check/, /session_log|세션 기록/, /turns/]) assert.match(readme, re);
});

// ---------- SC-1 ----------
test('F55 SC-1: no prompt, model response or diff reaches the events or metrics', async () => {
  const dir = project({ tier: 'critical', title: `title ${MARK.prompt}` });
  const buildOut = wrapperFile(`I did it: ${MARK.response}`);
  const evalOut = wrapperFile(`${MARK.response}\n\`\`\`json\n${JSON.stringify(EVAL_REPLY)}\n\`\`\``);
  const seen = [];
  const roles = claudeRoles(evalOut);
  const r = await runFeatures({ root: dir, config: runCfg(), deps: {
    build: claudeBuild(buildOut, { diff: `${MARK.diff}\n`, prompt: `do ${MARK.prompt}` }),
    verify: async () => RUN_PASSING,
    runAdapter: async (role, opts) => { seen.push(opts.prompt); const x = await roles(role, opts); seen.push(x.text); return x; },
  } });
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results));
  // the markers did reach the adapters and back: the test is not vacuous
  assert.ok(seen.some((s) => s.includes(MARK.diff)), 'diff in the reviewer prompt');
  assert.ok(seen.some((s) => s.includes(MARK.prompt)), 'title in the reviewer prompt');
  assert.ok(seen.some((s) => s.includes(MARK.response)), 'response text returned');
  const text = eventsText(dir) + metricsText(dir);
  assert.ok(of(dir, 'build', 'step').length === 1 && of(dir, 'eval', 'step').length === 1 && of(dir, 'security', 'step').length === 1);
  for (const m of Object.values(MARK)) assert.equal(text.includes(m), false, m);
});

// ---------- ES-1 ----------
test('F55 ES-1: output that is not JSON, or a wrapper without usage, keeps the result and nulls only the usage fields', async () => {
  const text = await claude.run({ prompt: 'x', cwd: REPO, bin: process.execPath, binArgs: [FAKE, 'text', 'plain words, no JSON'] });
  assert.equal(text.ok, true);
  assert.equal(text.text, 'plain words, no JSON');
  assert.deepEqual(usageOf(text), NULL_USAGE);
  const bare = { type: 'result', subtype: 'success', is_error: false, result: '{"ok":true}', total_cost_usd: 0.5 };
  const p = parsed(JSON.stringify(bare));
  assert.deepEqual([p.json, p.text, p.costUsd], [{ ok: true }, '{"ok":true}', 0.5]);
  assert.deepEqual([p.turns, p.tokens, p.sessionId, p.durationApiMs], [null, null, null, null]);
  // malformed usage values are nulls, not errors
  const odd = parsed(JSON.stringify({ ...bare, num_turns: 'three', usage: 'lots', duration_api_ms: -1, session_id: 42 }));
  assert.deepEqual([odd.json, odd.costUsd, odd.turns, odd.tokens, odd.sessionId, odd.durationApiMs], [{ ok: true }, 0.5, null, null, null, null]);
  const part = parsed(JSON.stringify({ ...bare, usage: { input_tokens: 5, output_tokens: 'x' } }));
  assert.deepEqual(part.tokens, { input: 5, output: null, cache_read: null, cache_creation: null });

  // through the run: a plain-text builder output still builds, the metrics line and the event have nulls
  const dir = project();
  await runFeatures({ root: dir, config: runCfg(), deps: {
    build: async (a) => { writeFiles(a.cwd, { 'F1.txt': 'x\n' }); return claude.run({ prompt: 'x', cwd: a.cwd, bin: process.execPath, binArgs: [FAKE, 'text', 'not json'] }); },
    verify: async () => RUN_PASSING,
    evaluate: async (a) => ({ feature: a.featureId, round: a.round, score: 9, scores, backlogged: [], blocking: [], independence: 'cross-model', costUsd: 0, file: null, verdict: 'pass' }),
  } });
  assert.equal(readJson(path.join(dir, '.harness', 'features.json')).features[0].status, 'passed');
  const [m] = metrics(dir).filter((l) => l.step === 'build');
  assert.deepEqual([m.outcome, m.turns, m.tokens, m.session_id], ['ok', null, null, null]);
  const [e] = of(dir, 'build', 'step');
  assert.deepEqual([e.data.outcome, e.data.turns, e.data.tokens, e.data.session_id, e.data.duration_api_ms, e.data.session_log], ['ok', null, null, null, null, null]);
});

test('F55 ES-1: a claude run that exits non-zero with its wrapper keeps the error and the usage it reported', async () => {
  const r = await claude.run({ prompt: 'x', cwd: REPO, bin: process.execPath,
    binArgs: [FAKE, 'print-fail', path.join(REPO, 'test', 'fixtures', 'output', 'claude-json-budget-exhausted.json')] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'exit_nonzero');
  assert.equal(r.costUsd, 0.0663634);
  assert.deepEqual(usageOf(r), { turns: 1, tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, session_id: '620716bf-d412-4c36-b6b8-78010df94926', duration_api_ms: 0 });
});
