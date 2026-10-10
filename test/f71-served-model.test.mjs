import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpdir, fakeNodeCli } from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';
import { loadConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { readEvents } from '../lib/events.mjs';
import { runFeatures } from '../lib/run.mjs';
import { servedModelOf, modelMismatch } from '../lib/usage.mjs';
import { getAdapter } from '../lib/adapters/index.mjs';
import { parseUsage } from '../lib/adapters/common.mjs';
import evalCommand from '../lib/commands/eval.mjs';

const FIX = path.join(REPO, 'test', 'fixtures');
const MODEL_CLI = path.join(FIX, 'fake-model-cli.mjs');
const GIT_DIR = path.dirname(spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim());

// ------------------------------------------------------------------ fixtures

function contract(id, tier = 'standard') {
  const c = {
    id, title: `feature ${id}`, security_tier: tier, version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node -e "process.exit(0)"', new: false }],
    security_criteria: tier === 'critical' ? [{ id: 'SC-1', criterion: 'ok', check: 'node -e "process.exit(0)"', new: false }] : [],
    error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-05T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function repo(features, { roles, adapters } = {}) {
  const state = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, run: { max_parallel: 1 }, roles, ...(adapters ? { adapters } : {}) },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': {
      features: features.map((f) => ({ id: f.id, title: `feature ${f.id}`, security_tier: f.tier || 'standard', depends_on: [], status: 'approved' })),
    },
  };
  for (const f of features) state[`.harness/contracts/${f.id}.json`] = contract(f.id, f.tier);
  return gitRepo(state, { branch: null });
}

const PASS_VERIFY = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const passVerify = () => async () => PASS_VERIFY;

// Runs fn with a fake `claude` first on PATH whose wrapper carries the modelUsage
// `usage[<--model value>]` (`usage['*']` for any other call).
async function withFakeClaude(usage, fn) {
  const bin = fakeNodeCli('claude', MODEL_CLI);
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const saved = { path: process.env[pathKey], usage: process.env.FAKE_MODEL_USAGE, log: process.env.FAKE_MODEL_LOG };
  process.env[pathKey] = [bin, path.dirname(process.execPath), GIT_DIR].join(path.delimiter);
  process.env.FAKE_MODEL_USAGE = JSON.stringify(usage);
  delete process.env.FAKE_MODEL_LOG;
  try {
    return await fn();
  } finally {
    process.env[pathKey] = saved.path;
    for (const [k, v] of [['FAKE_MODEL_USAGE', saved.usage], ['FAKE_MODEL_LOG', saved.log]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// harness run with stderr warnings captured.
async function runIn(dir) {
  const warnings = [];
  const result = await runFeatures({ root: dir, config: loadConfig(dir), deps: { verify: passVerify(), warn: (m) => warnings.push(m) } });
  return { result, warnings };
}

// harness eval F1 (the CLI command) with stdout/stderr captured.
async function evalIn(dir, feature = 'F1') {
  const out = [];
  const err = [];
  const code = await evalCommand({ root: dir, args: [feature, '--json'], out: (m) => out.push(m), err: (m) => err.push(m), deps: { verifyResult: PASS_VERIFY } });
  return { code, result: JSON.parse(out.join('\n')), stderr: err.join('\n') };
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const statuses = (dir) => Object.fromEntries(readJson(path.join(dir, '.harness/features.json')).features.map((f) => [f.id, f.status]));
const runsDir = (dir) => path.join(dir, '.harness', 'runs');
const metricLines = (dir, pick = (f) => f.endsWith('.metrics.jsonl') && f !== 'eval.metrics.jsonl') => fs.readdirSync(runsDir(dir))
  .filter(pick)
  .flatMap((f) => fs.readFileSync(path.join(runsDir(dir), f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
const evalMetricLines = (dir) => metricLines(dir, (f) => f === 'eval.metrics.jsonl');
const report = (dir) => {
  const f = fs.readdirSync(runsDir(dir)).find((n) => n.endsWith('.md'));
  return fs.readFileSync(path.join(runsDir(dir), f), 'utf8');
};
const section = (text, heading) => {
  const at = text.indexOf(`\n${heading}\n`);
  if (at === -1) return '';
  const rest = text.slice(at + heading.length + 2);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
};
const stepEvents = (dir) => readEvents(dir).events.filter((e) => e.type === 'step');
const verdictOf = (dir, id = 'F1') => {
  const vdir = path.join(dir, '.harness', 'verdicts');
  const files = fs.readdirSync(vdir).filter((f) => f.startsWith(`${id}-r`)).sort();
  const v = readJson(path.join(vdir, files[files.length - 1]));
  return { verdict: v.verdict, score: v.score, blocking: v.blocking };
};
// Model cells of the report's step table, as `<step>:<cell>`.
const modelCells = (text) => section(text, '## Steps').split('\n').filter((l) => /^\| \d/.test(l))
  .map((l) => l.split(' | ')).map((c) => `${c[1]}:${c[4].replace(/\\\|/g, '|')}`);

const out = (n) => ({ inputTokens: 10, outputTokens: n, costUSD: 0.01 });
const one = (model, extra = {}) => ({ [model]: { ...out(100), ...extra } });

const ROLES = {
  builder: { adapter: 'claude', model: 'b1' },
  evaluator: { adapter: 'claude', model: 'e1' },
  'security-reviewer': { adapter: 'claude', model: 's1' },
};
const MATCHING = { b1: one('b1'), e1: one('e1'), s1: one('s1') };

// A tiny CLI that prints $FAKE_WRAPPER: a claude-style wrapper, whatever the adapter.
function wrapperCli() {
  const f = path.join(tmpdir('harness-wrapper-'), 'print.mjs');
  fs.writeFileSync(f, 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(process.env.FAKE_WRAPPER));\n');
  return f;
}
const claudeWrapper = (modelUsage, extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result: '{"ok":true}', ...extra, ...(modelUsage === undefined ? {} : { modelUsage }) });

async function adapterRun(name, stdout, config = {}) {
  const cli = wrapperCli();
  const saved = process.env.FAKE_WRAPPER;
  process.env.FAKE_WRAPPER = stdout;
  try {
    const adapter = getAdapter(name, config);
    return await adapter.run({ prompt: 'x', cwd: tmpdir(), readOnly: true, model: 'm1', bin: process.execPath, binArgs: [cli], timeoutSec: 60 });
  } finally {
    if (saved === undefined) delete process.env.FAKE_WRAPPER; else process.env.FAKE_WRAPPER = saved;
  }
}

// ------------------------------------------------------------------ AC-1

test('F71 AC-1 served model: one model in modelUsage is that model', () => {
  assert.deepEqual(servedModelOf({ 'claude-opus-5-5': out(5000) }), { servedModel: 'claude-opus-5-5', servedCanonical: null });
  assert.deepEqual(servedModelOf({ 'claude-opus-5-5': { ...out(7), canonicalModel: 'opus' } }), { servedModel: 'claude-opus-5-5', servedCanonical: 'opus' });
});

test('F71 AC-1 served model: of several models, the one with the most outputTokens (opus 5000 + haiku 300 → opus)', () => {
  const opus = 'claude-opus-5-5';
  const haiku = 'claude-haiku-4-5-20251001';
  assert.equal(servedModelOf({ [opus]: out(5000), [haiku]: out(300) }).servedModel, opus);
  assert.equal(servedModelOf({ [haiku]: out(300), [opus]: out(5000) }).servedModel, opus, 'not the first key');
  assert.equal(servedModelOf({ [haiku]: out(6000), [opus]: out(5000) }).servedModel, haiku, 'not by name');
  assert.equal(servedModelOf({ a: out(1), b: out(3), c: out(2) }).servedModel, 'b');
});

test('F71 AC-1 served model: a tie on outputTokens takes the lexicographically first key', () => {
  assert.equal(servedModelOf({ zeta: out(50), alpha: out(50) }).servedModel, 'alpha');
  assert.equal(servedModelOf({ alpha: out(50), zeta: out(50) }).servedModel, 'alpha');
  assert.equal(servedModelOf({ m: out(0), b: out(0), x: out(0) }).servedModel, 'b');
  assert.equal(servedModelOf({ small: out(10), zeta: out(50), alpha: out(50) }).servedModel, 'alpha');
});

test('F71 AC-1 claude adapter: the result of a call carries the served model of its wrapper', async () => {
  const r = await adapterRun('claude', claudeWrapper({ 'claude-opus-5-5': out(5000), 'claude-haiku-4-5': out(300) }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.servedModel, 'claude-opus-5-5');
  assert.equal(parseUsage(claudeWrapper({ x: out(1) })).servedModel, 'x');
});

// ------------------------------------------------------------------ AC-2

test('F71 AC-2 harness run: metrics lines carry served_model for build and eval, null for core steps; model stays the requested one', async () => {
  const dir = repo([{ id: 'F1', tier: 'critical' }], { roles: ROLES });
  await withFakeClaude({ b1: one('b1-served'), e1: one('e1-served'), s1: one('s1-served') }, () => runIn(dir));
  assert.deepEqual(statuses(dir), { F1: 'passed' });
  const lines = metricLines(dir);
  const by = (step) => lines.filter((l) => l.step === step);
  assert.deepEqual(by('build').map((l) => [l.model, l.served_model]), [['b1', 'b1-served']]);
  assert.deepEqual(by('eval').map((l) => [l.model, l.served_model]), [['e1', 'e1-served']]);
  for (const step of ['verify', 'merge', 'post_merge_verify']) {
    assert.ok(by(step).length > 0, step);
    for (const l of by(step)) assert.deepEqual([l.model, l.served_model], [null, null], step);
  }
  assert.ok(lines.every((l) => Object.hasOwn(l, 'served_model')));
  const ev = stepEvents(dir);
  assert.deepEqual(ev.filter((e) => e.stage === 'build').map((e) => [e.data.model, e.data.served_model]), [['b1', 'b1-served']]);
  assert.deepEqual(ev.filter((e) => e.stage === 'eval').map((e) => [e.data.model, e.data.served_model]), [['e1', 'e1-served']]);
  assert.deepEqual(ev.filter((e) => e.stage === 'security').map((e) => [e.data.model, e.data.served_model]), [['s1', 's1-served']]);
});

test('F71 AC-2 harness eval: each eval.metrics.jsonl line and step event carries the served_model of its call', async () => {
  const dir = repo([{ id: 'F1', tier: 'critical' }], { roles: ROLES });
  const { code } = await withFakeClaude({ e1: one('e1-served'), s1: one('s1-served') }, () => evalIn(dir));
  assert.equal(code, 0);
  assert.deepEqual(evalMetricLines(dir).map((l) => [l.role, l.model, l.served_model]).sort(),
    [['evaluator', 'e1', 'e1-served'], ['security-reviewer', 's1', 's1-served']]);
  const ev = stepEvents(dir);
  assert.deepEqual(ev.filter((e) => e.stage === 'eval').map((e) => e.data.served_model), ['e1-served']);
  assert.deepEqual(ev.filter((e) => e.stage === 'security').map((e) => e.data.served_model), ['s1-served']);
});

// ------------------------------------------------------------------ AC-3

test('F71 AC-3 mismatch: neither the served key nor its canonicalModel equals the requested model', () => {
  assert.equal(modelMismatch('opus', { servedModel: 'claude-haiku-4-5', servedCanonical: null }), true);
  assert.equal(modelMismatch('opus', { servedModel: 'claude-haiku-4-5', servedCanonical: 'claude-haiku-4-5' }), true);
  assert.equal(modelMismatch('opus', { servedModel: 'opus', servedCanonical: null }), false);
  assert.equal(modelMismatch('opus', { servedModel: 'claude-opus-5-5', servedCanonical: 'opus' }), false);
  assert.equal(modelMismatch('opus', { servedModel: null, servedCanonical: null }), false);
});

test('F71 AC-3 harness run: a mismatched build, eval and security call each warn on stderr and in ## Warnings', async () => {
  const dir = repo([{ id: 'F1', tier: 'critical' }], { roles: ROLES });
  const { warnings } = await withFakeClaude({ b1: one('other-b'), e1: one('other-e'), s1: one('other-s') }, () => runIn(dir));
  const expected = ['F1 round 1 build: requested b1, served other-b', 'F1 round 1 eval: requested e1, served other-e', 'F1 round 1 security: requested s1, served other-s'];
  const warned = section(report(dir), '## Warnings');
  for (const w of expected) {
    assert.equal(warnings.filter((x) => x.includes(w)).length, 1, `${w}\n${warnings.join('\n')}`);
    assert.ok(warned.includes(w), `${w}\n${warned}`);
  }
});

test('F71 AC-3 harness run: a canonicalModel or key match gives no warning', async () => {
  const dir = repo([{ id: 'F1' }], { roles: { builder: { adapter: 'claude', model: 'opus' }, evaluator: { adapter: 'claude', model: 'e1' } } });
  const { warnings } = await withFakeClaude({ opus: one('claude-opus-5-5', { canonicalModel: 'opus' }), e1: one('e1') }, () => runIn(dir));
  assert.deepEqual(statuses(dir), { F1: 'passed' });
  assert.deepEqual(warnings.filter((w) => /requested .*, served /.test(w)), []);
  assert.ok(!/requested .*, served /.test(report(dir)));
});

test('F71 AC-3 harness run: verdict and status with a mismatch are those without one', async () => {
  const a = repo([{ id: 'F1', tier: 'critical' }], { roles: ROLES });
  const b = repo([{ id: 'F1', tier: 'critical' }], { roles: ROLES });
  const ra = await withFakeClaude({ b1: one('other-b'), e1: one('other-e'), s1: one('other-s') }, () => runIn(a));
  const rb = await withFakeClaude(MATCHING, () => runIn(b));
  assert.ok(ra.warnings.some((w) => w.includes('requested b1, served other-b')));
  assert.deepEqual(rb.warnings.filter((w) => /served/.test(w)), []);
  assert.deepEqual(statuses(a), statuses(b));
  assert.deepEqual(statuses(a), { F1: 'passed' });
  assert.deepEqual(verdictOf(a), verdictOf(b));
  assert.deepEqual(ra.result.results.map((r) => [r.feature, r.status, r.rounds]), rb.result.results.map((r) => [r.feature, r.status, r.rounds]));
});

// ------------------------------------------------------------------ AC-4

test('F71 AC-4 report: the Model cell is `<requested> → <served>` on a mismatch, else the requested model', async () => {
  const dir = repo([{ id: 'F1', tier: 'critical' }], { roles: ROLES });
  await withFakeClaude({ b1: one('other-b'), e1: one('e1') }, () => runIn(dir));
  const cells = modelCells(report(dir));
  assert.ok(cells.includes('build:b1 → other-b'), cells.join('\n'));
  assert.ok(cells.includes('eval:e1'), cells.join('\n'));
  assert.ok(cells.includes('verify:-'), cells.join('\n'));
});

test('F71 AC-4 report: without a served model, or on a canonicalModel match, the Model cell is the requested model', async () => {
  const dir = repo([{ id: 'F1' }], { roles: { builder: { adapter: 'claude', model: 'b1' }, evaluator: { adapter: 'claude', model: 'opus' } } });
  await withFakeClaude({ opus: one('claude-opus-5-5', { canonicalModel: 'opus' }) }, () => runIn(dir));
  const cells = modelCells(report(dir));
  assert.ok(cells.includes('build:b1'), cells.join('\n'));
  assert.ok(cells.includes('eval:opus'), cells.join('\n'));
  assert.ok(!cells.some((c) => c.includes('→')), cells.join('\n'));
});

// ------------------------------------------------------------------ AC-5

test('F71 AC-5 harness eval: mismatched evaluator and security-reviewer calls warn on stderr; exit code and verdict unchanged', async () => {
  const a = repo([{ id: 'F1', tier: 'critical' }], { roles: ROLES });
  const b = repo([{ id: 'F1', tier: 'critical' }], { roles: ROLES });
  const ra = await withFakeClaude({ e1: one('other-e'), s1: one('other-s') }, () => evalIn(a));
  const rb = await withFakeClaude(MATCHING, () => evalIn(b));
  assert.match(ra.stderr, /F1 round 1 eval: requested e1, served other-e/);
  assert.match(ra.stderr, /F1 round 1 security: requested s1, served other-s/);
  assert.doesNotMatch(rb.stderr, /served/);
  assert.equal(ra.code, rb.code);
  assert.equal(ra.code, 0);
  assert.deepEqual([ra.result.verdict, ra.result.score, ra.result.feature_status], [rb.result.verdict, rb.result.score, rb.result.feature_status]);
  assert.equal(ra.result.verdict, 'pass');
});

// ------------------------------------------------------------------ AC-6

test('F71 AC-6 roles without a model: served_model is recorded and no mismatch is warned (run)', async () => {
  const dir = repo([{ id: 'F1', tier: 'critical' }], { roles: { builder: 'claude', evaluator: { adapter: 'claude' }, 'security-reviewer': 'claude' } });
  const { warnings } = await withFakeClaude({ '*': one('cli-default') }, () => runIn(dir));
  assert.deepEqual(statuses(dir), { F1: 'passed' });
  const lines = metricLines(dir);
  for (const step of ['build', 'eval']) {
    assert.deepEqual(lines.filter((l) => l.step === step).map((l) => [l.model, l.served_model]), [[null, 'cli-default']], step);
  }
  assert.deepEqual(stepEvents(dir).filter((e) => e.stage === 'security').map((e) => e.data.served_model), ['cli-default']);
  assert.deepEqual(warnings.filter((w) => /served/.test(w)), []);
  assert.ok(!/served/.test(report(dir)));
});

test('F71 AC-6 roles without a model: served_model is recorded and no mismatch is warned (harness eval)', async () => {
  const dir = repo([{ id: 'F1', tier: 'critical' }], { roles: { builder: 'claude', evaluator: 'claude', 'security-reviewer': 'claude' } });
  const r = await withFakeClaude({ '*': one('cli-default') }, () => evalIn(dir));
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stderr, /served/);
  assert.deepEqual(evalMetricLines(dir).map((l) => [l.model, l.served_model]), [[null, 'cli-default'], [null, 'cli-default']]);
});

// ------------------------------------------------------------------ AC-7

test('F71 AC-7 SPEC describes the served model rule and mismatch (§10) and the fields, Model cell and warning (§8.11)', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s10 = spec.slice(spec.indexOf('\n## 10.'), spec.indexOf('\n## 11.'));
  for (const re of [/served model/, /`modelUsage`/, /`outputTokens`/, /사전순/, /`canonicalModel`/, /불일치/, /CLI 기본값/]) assert.match(s10, re);
  const start = spec.indexOf('(§8.11)');
  const s811 = spec.slice(start, spec.indexOf('\n## 9.', start));
  for (const re of [/`served_model`/, /step` 이벤트/, /Model 칸/, /`<요청> → <실제>`/, /## Warnings/, /requested <요청>, served <실제>/]) assert.match(s811, re);
});

// ------------------------------------------------------------------ ES-1

test('F71 ES-1 unusable modelUsage gives a null served model: missing, not an object, empty, no integer outputTokens', () => {
  const none = { servedModel: null, servedCanonical: null };
  for (const v of [undefined, [], [{ outputTokens: 5 }], 'claude-opus-5-5', null, 42, {},
    { a: { outputTokens: '5' }, b: { outputTokens: 1.5 }, c: {}, d: null, e: { outputTokens: null }, f: 'x' }]) {
    assert.deepEqual(servedModelOf(v), none, JSON.stringify(v));
  }
  // a usable entry next to unusable ones is still found
  assert.equal(servedModelOf({ a: { outputTokens: '9999' }, b: out(1) }).servedModel, 'b');
});

test('F71 ES-1 claude adapter: an unusable modelUsage leaves the call as it was, served model null', async () => {
  for (const mu of [undefined, ['x'], 'claude-opus-5-5', null, {}, { a: { outputTokens: '5' } }]) {
    const r = await adapterRun('claude', claudeWrapper(mu));
    assert.equal(r.ok, true, JSON.stringify(mu));
    assert.deepEqual(r.json, { ok: true });
    assert.equal(r.servedModel, null, JSON.stringify(mu));
  }
});

test('F71 ES-1 harness run: without modelUsage the steps end as before, served_model null and no warning', async () => {
  const dir = repo([{ id: 'F1' }], { roles: ROLES });
  const { warnings } = await withFakeClaude({ '*': { a: { outputTokens: 'many' } } }, () => runIn(dir));
  assert.deepEqual(statuses(dir), { F1: 'passed' });
  assert.ok(metricLines(dir).every((l) => l.served_model === null));
  assert.deepEqual(warnings.filter((w) => /served/.test(w)), []);
});

// ------------------------------------------------------------------ ES-2

test('F71 ES-2 codex, gemini and generic adapters: served model null even for output with modelUsage', async () => {
  const stdout = claudeWrapper({ 'claude-opus-5-5': out(5000) });
  const generic = { adapters: { generic: { command: ['x'], read_only_command: ['x'] } } };
  for (const name of ['codex', 'gemini', 'generic']) {
    const r = await adapterRun(name, stdout, generic);
    assert.equal(r.servedModel, null, `${name}: ${JSON.stringify(r)}`);
  }
  // the same output through the claude adapter does have one
  assert.equal((await adapterRun('claude', stdout)).servedModel, 'claude-opus-5-5');
});

test('F71 ES-2 harness run with generic builder and evaluator: served_model null, no mismatch warning', async () => {
  const cli = path.join(tmpdir('harness-generic-'), 'gen.mjs');
  const reply = { scores: { functionality: 9, quality: 9, security: 9, errors: 9, tests: 9 }, findings: [], out_of_scope: [] };
  const wrap = (result, structured) => ({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result, ...(structured ? { structured_output: structured } : {}), modelUsage: { 'served-elsewhere': out(500) } });
  fs.writeFileSync(cli, [
    "import fs from 'node:fs';",
    "if (process.argv.includes('--help') || process.argv.includes('--version')) { process.stdout.write('gen 1.0.0\\n'); process.exit(0); }",
    'let s = "";',
    'for await (const c of process.stdin) s += c;',
    `if (process.argv.includes('ro')) process.stdout.write(${JSON.stringify(JSON.stringify(wrap(JSON.stringify(reply), reply)))});`,
    `else { fs.writeFileSync('gen.txt', 'built\\n'); process.stdout.write(${JSON.stringify(JSON.stringify(wrap('done')))}); }`,
    '',
  ].join('\n'));
  const dir = repo([{ id: 'F1' }], {
    roles: { builder: { adapter: 'generic', model: 'gm' }, evaluator: { adapter: 'generic', model: 'gm' } },
    adapters: { generic: { command: [process.execPath, cli], read_only_command: [process.execPath, cli, 'ro'] } },
  });
  const { warnings } = await runIn(dir);
  assert.deepEqual(statuses(dir), { F1: 'passed' });
  const lines = metricLines(dir);
  assert.ok(lines.some((l) => l.step === 'build') && lines.some((l) => l.step === 'eval'));
  assert.ok(lines.every((l) => l.served_model === null), JSON.stringify(lines));
  assert.ok(stepEvents(dir).every((e) => e.data.served_model === null));
  assert.deepEqual(warnings.filter((w) => /served/.test(w)), []);
  assert.ok(!/served/.test(report(dir)));
});
