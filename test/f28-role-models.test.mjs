import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpdir } from './helpers.mjs';
import { gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig, loadConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { roleModel, builderModels, independenceOf } from '../lib/adapters/index.mjs';
import { loadRolePrompt } from '../lib/roles.mjs';
import { evalAndRecord } from '../lib/eval-status.mjs';
import doctor, { diagnose } from '../lib/commands/doctor.mjs';
import { runFeatures } from '../lib/run.mjs';
import { HarnessError } from '../lib/errors.mjs';

const FIX = path.join(REPO, 'test', 'fixtures');
const MODEL_CLI = path.join(FIX, 'fake-model-cli.mjs');
const CLAUDE_HELP = fs.readFileSync(path.join(FIX, 'help', 'claude-2.1.280.txt'), 'utf8');
const GIT_DIR = path.dirname(spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim());

// ------------------------------------------------------------------ fixtures

function contract(id, tier = 'standard') {
  const c = {
    id, title: `feature ${id}`, security_tier: tier, version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node -e "process.exit(0)"', new: false }],
    security_criteria: tier === 'critical' ? [{ id: 'SC-1', criterion: 'ok', check: 'node -e "process.exit(0)"', new: false }] : [],
    error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-26T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

// features: [{id, tier?, status?}]; verdicts: {'F1-r1': {...}}
function repo(features, { roles, files = {}, verdicts = {} } = {}) {
  const state = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, run: { max_parallel: 1 }, roles },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': {
      features: features.map((f) => ({ id: f.id, title: `feature ${f.id}`, security_tier: f.tier || 'standard', depends_on: [], status: f.status || 'approved' })),
    },
  };
  for (const f of features) state[`.harness/contracts/${f.id}.json`] = contract(f.id, f.tier);
  for (const [k, v] of Object.entries(verdicts)) state[`.harness/verdicts/${k}.json`] = v;
  return gitRepo({ ...state, ...files }, { branch: null });
}

const PASS_VERIFY = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const FAIL_VERIFY = { ...PASS_VERIFY, pass: false, criteria: [{ id: 'AC-1', check: 'x', pass: false, message: 'exit 1' }] };

// Scripted verify: seq[i] false = fail; everything else passes. `onCall` sees every call.
function scriptedVerify(seq = [], onCall) {
  let n = 0;
  return async (a) => {
    const s = seq[n];
    n += 1;
    await onCall?.(a, n);
    return s === false ? FAIL_VERIFY : PASS_VERIFY;
  };
}

// Runs fn with a fake `claude` first on PATH (test/fixtures/fake-model-cli.mjs) that logs
// every model call; returns the calls as {role, model, feature, argv}.
async function withFakeClaude(fn) {
  const bin = tmpdir('harness-bin-');
  const log = path.join(tmpdir('harness-log-'), 'calls.jsonl');
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'claude.cmd'), `@"${process.execPath}" "${MODEL_CLI}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${MODEL_CLI}" "$@"\n`);
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
  }
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const saved = { path: process.env[pathKey], log: process.env.FAKE_MODEL_LOG };
  process.env[pathKey] = [bin, path.dirname(process.execPath), GIT_DIR].join(path.delimiter);
  process.env.FAKE_MODEL_LOG = log;
  let result;
  try {
    result = await fn();
  } finally {
    process.env[pathKey] = saved.path;
    if (saved.log === undefined) delete process.env.FAKE_MODEL_LOG; else process.env.FAKE_MODEL_LOG = saved.log;
  }
  const heads = Object.fromEntries(['evaluator', 'security-reviewer'].map((r) => [r, loadRolePrompt(r).slice(0, 120)]));
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return {
    result,
    calls: calls.map((c) => {
      const mode = c.argv[c.argv.indexOf('--permission-mode') + 1];
      const role = mode === 'plan' ? Object.keys(heads).find((r) => c.head.startsWith(heads[r])) : 'builder';
      const i = c.argv.indexOf('--model');
      return { role, model: i === -1 ? null : c.argv[i + 1], feature: path.basename(c.cwd), conflict: c.conflict, argv: c.argv };
    }),
  };
}

const runIn = (dir, deps = {}) => runFeatures({ root: dir, config: loadConfig(dir), deps: { verify: scriptedVerify(), ...deps } });
const modelsOf = (calls, role, feature) => calls.filter((c) => c.role === role && c.feature === feature).map((c) => c.model);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const statuses = (dir) => Object.fromEntries(readJson(path.join(dir, '.harness/features.json')).features.map((f) => [f.id, f.status]));
const metricLines = (dir, suffix = '.metrics.jsonl') => fs.readdirSync(path.join(dir, '.harness', 'runs'))
  .filter((f) => f.endsWith(suffix))
  .flatMap((f) => fs.readFileSync(path.join(dir, '.harness', 'runs', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));

// ------------------------------------------------------------------ AC-1

test('F28 AC-1 roleModel: by_tier model for the tier, else model, else adapters.<name>.model', () => {
  const config = resolveConfig({
    roles: {
      builder: { adapter: 'claude', model: 'b-default', by_tier: { critical: 'b-crit' } },
      evaluator: { adapter: 'claude', by_tier: { standard: 'e-std' } },
      'security-reviewer': 'claude',
    },
    adapters: { claude: { model: 'adapter-default' } },
  });
  assert.deepEqual(roleModel(config, 'builder', { tier: 'critical' }), { adapter: 'claude', model: 'b-crit' });
  assert.deepEqual(roleModel(config, 'builder', { tier: 'standard' }), { adapter: 'claude', model: 'b-default' });
  assert.deepEqual(roleModel(config, 'evaluator', { tier: 'standard' }), { adapter: 'claude', model: 'e-std' });
  assert.deepEqual(roleModel(config, 'evaluator', { tier: 'critical' }), { adapter: 'claude', model: 'adapter-default' });
  assert.deepEqual(roleModel(config, 'security-reviewer', { tier: 'critical' }), { adapter: 'claude', model: 'adapter-default' });
});

test('F28 AC-1 harness run: builder, evaluator and security-reviewer each get the --model of the feature tier', async () => {
  const dir = repo([{ id: 'F1', tier: 'critical' }, { id: 'F2' }], {
    roles: {
      builder: { adapter: 'claude', model: 'b-default', by_tier: { critical: 'b-crit' } },
      evaluator: { adapter: 'claude', model: 'e-default', by_tier: { standard: 'e-std' } },
      'security-reviewer': { adapter: 'claude', model: 's-default', by_tier: { critical: 's-crit' } },
    },
  });
  const { calls } = await withFakeClaude(() => runIn(dir));
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed' });
  assert.deepEqual(modelsOf(calls, 'builder', 'F1'), ['b-crit']);
  assert.deepEqual(modelsOf(calls, 'evaluator', 'F1'), ['e-default']);
  assert.deepEqual(modelsOf(calls, 'security-reviewer', 'F1'), ['s-crit']);
  assert.deepEqual(modelsOf(calls, 'builder', 'F2'), ['b-default']);
  assert.deepEqual(modelsOf(calls, 'evaluator', 'F2'), ['e-std']);
  assert.deepEqual(modelsOf(calls, 'security-reviewer', 'F2'), [], 'no security review for a standard feature');
});

// ------------------------------------------------------------------ AC-2

test('F28 AC-2 roleModel: escalate applies to builder rounds ≥ 2 only', () => {
  const config = resolveConfig({ roles: { builder: { adapter: 'claude', model: 'b1', by_tier: { standard: 'b-std' }, escalate: 'b-esc' } } });
  assert.equal(roleModel(config, 'builder', { tier: 'standard', round: 1 }).model, 'b-std');
  assert.equal(roleModel(config, 'builder', { tier: 'critical', round: 1 }).model, 'b1');
  assert.equal(roleModel(config, 'builder', { tier: 'standard', round: 2 }).model, 'b-esc');
  assert.equal(roleModel(config, 'builder', { tier: 'critical', round: 3 }).model, 'b-esc');
  const none = resolveConfig({ roles: { builder: { adapter: 'claude', model: 'b1' } } });
  assert.equal(roleModel(none, 'builder', { round: 2 }).model, 'b1', 'without escalate round 2 keeps the round-1 model');
});

test('F28 AC-2 harness run: round 1 builds use the tier model, round 2 builds the escalate model', async () => {
  const dir = repo([{ id: 'F1' }], {
    roles: { builder: { adapter: 'claude', model: 'b1', by_tier: { standard: 'b-std' }, escalate: 'b-esc' }, evaluator: { adapter: 'claude', model: 'e1' } },
  });
  // round 1: three failing verifies; round 2: passes
  const { calls } = await withFakeClaude(() => runIn(dir, { verify: scriptedVerify([false, false, false]) }));
  assert.equal(statuses(dir).F1, 'passed');
  assert.deepEqual(modelsOf(calls, 'builder', 'F1'), ['b-std', 'b-std', 'b-std', 'b-esc']);
  const builds = metricLines(dir).filter((m) => m.step === 'build');
  assert.deepEqual(builds.map((m) => [m.round, m.model]), [[1, 'b-std'], [1, 'b-std'], [1, 'b-std'], [2, 'b-esc']]);
});

test('F28 AC-2 harness run: a run that carries round 1 of the contract builds its first round with the escalate model', async () => {
  const hash = contract('F1').approval.hash;
  const dir = repo([{ id: 'F1', status: 'in_progress' }], {
    roles: { builder: { adapter: 'claude', model: 'b1', escalate: 'b-esc' }, evaluator: { adapter: 'claude', model: 'e1' } },
    verdicts: {
      'F1-r1': {
        feature: 'F1', round: 1, verdict: 'fail', score: 3, verify_pass: true, origin: 'eval', contract_hash: hash, contract_round: 1,
        blocking: [{ criterion_id: 'AC-1', summary: 'broken', repro: 'node -e "process.exit(3)"', exit: 3 }], backlogged: [],
      },
    },
  });
  const { calls, result } = await withFakeClaude(() => runIn(dir));
  assert.equal(statuses(dir).F1, 'passed', JSON.stringify(result.results));
  assert.deepEqual(modelsOf(calls, 'builder', 'F1'), ['b-esc']);
});

// ------------------------------------------------------------------ AC-3

// Lands a conflicting shared.txt on integration while F1 is verified, so F1's merge conflicts.
const conflictVerify = (dir) => scriptedVerify([], async (a, n) => {
  if (n !== 1) return;
  const intWt = path.join(dir, '.harness', 'wt', '_integration');
  writeFiles(intWt, { 'shared.txt': 'human\n' });
  commitAll(intWt, 'conflicting change');
});

for (const [name, builder, expected] of [
  ['conflict_model set: the resolution uses it', { adapter: 'claude', model: 'b1', escalate: 'b-esc', conflict_model: 'b-conflict' }, 'b-conflict'],
  ['no conflict_model: the resolution uses the round builder model', { adapter: 'claude', model: 'b1', by_tier: { standard: 'b-std' } }, 'b-std'],
]) {
  test(`F28 AC-3 harness run: ${name}`, async () => {
    const dir = repo([{ id: 'F1' }], { roles: { builder, evaluator: { adapter: 'claude', model: 'e1' } }, files: { 'shared.txt': 'base\n' } });
    const { calls } = await withFakeClaude(() => runIn(dir, { verify: conflictVerify(dir) }));
    const resolutions = calls.filter((c) => c.role === 'builder' && c.conflict);
    assert.equal(resolutions.length, 1, 'one conflict resolution call');
    assert.equal(resolutions[0].model, expected);
    assert.equal(statuses(dir).F1, 'passed');
    const line = metricLines(dir).find((m) => m.step === 'conflict_resolve');
    assert.equal(line.model, expected);
  });
}

test('F28 AC-3 roleModel: conflict_model, else the round model (including escalate)', () => {
  const withC = resolveConfig({ roles: { builder: { adapter: 'claude', model: 'b1', escalate: 'b-esc', conflict_model: 'b-c' } } });
  assert.equal(roleModel(withC, 'builder', { round: 1, conflict: true }).model, 'b-c');
  assert.equal(roleModel(withC, 'builder', { round: 2, conflict: true }).model, 'b-c');
  const noC = resolveConfig({ roles: { builder: { adapter: 'claude', model: 'b1', escalate: 'b-esc' } } });
  assert.equal(roleModel(noC, 'builder', { round: 1, conflict: true }).model, 'b1');
  assert.equal(roleModel(noC, 'builder', { round: 2, conflict: true }).model, 'b-esc');
  assert.equal(roleModel(withC, 'evaluator', { conflict: true }).model, null, 'conflict_model is a builder setting');
});

// ------------------------------------------------------------------ AC-4

test('F28 AC-4 harness run: verdict reviews and metrics carry the models called; same standard models → fresh-context', async () => {
  const dir = repo([{ id: 'F1' }, { id: 'F2', tier: 'critical' }], {
    roles: {
      // defaults differ, but for standard features both use m-same
      builder: { adapter: 'claude', model: 'b-default', by_tier: { standard: 'm-same' } },
      evaluator: { adapter: 'claude', model: 'e-default', by_tier: { standard: 'm-same' } },
      'security-reviewer': { adapter: 'claude', model: 's-default' },
    },
  });
  await withFakeClaude(() => runIn(dir));
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed' });
  const v1 = readJson(path.join(dir, '.harness/verdicts/F1-r1.json'));
  assert.equal(v1.independence, 'fresh-context');
  assert.equal(v1.reviews.evaluator.model, 'm-same');
  const v2 = readJson(path.join(dir, '.harness/verdicts/F2-r1.json'));
  assert.equal(v2.independence, 'cross-model');
  assert.equal(v2.reviews.evaluator.model, 'e-default');
  assert.equal(v2.reviews['security-reviewer'].model, 's-default');
  const lines = metricLines(dir);
  const pick = (f, step) => lines.filter((m) => m.feature === f && m.step === step).map((m) => [m.role, m.adapter, m.model]);
  assert.deepEqual(pick('F1', 'build'), [['builder', 'claude', 'm-same']]);
  assert.deepEqual(pick('F1', 'eval'), [['evaluator', 'claude', 'm-same']]);
  assert.deepEqual(pick('F2', 'build'), [['builder', 'claude', 'b-default']]);
  assert.deepEqual(pick('F2', 'eval'), [['evaluator', 'claude', 'e-default']]);
});

test('F28 AC-4 independence counts every builder model the feature used (escalation, conflict resolution)', () => {
  const config = resolveConfig({ roles: { builder: { adapter: 'claude', model: 'b1', escalate: 'e1', conflict_model: 'c1' }, evaluator: { adapter: 'claude', model: 'e1' } } });
  const ev = roleModel(config, 'evaluator', { tier: 'standard' });
  assert.equal(independenceOf(builderModels(config, { tier: 'standard', round: 1 }), ev), 'cross-model');
  assert.equal(independenceOf(builderModels(config, { tier: 'standard', round: 2 }), ev), 'fresh-context', 'round 2 was built by the evaluator model');
  const c = resolveConfig({ roles: { builder: { adapter: 'claude', model: 'b1', conflict_model: 'e1' }, evaluator: { adapter: 'claude', model: 'e1' } } });
  assert.equal(independenceOf(builderModels(c, { round: 1, conflict: false }), ev), 'cross-model');
  assert.equal(independenceOf(builderModels(c, { round: 1, conflict: true }), ev), 'fresh-context');
});

test('F28 AC-4 harness eval: the reviewer is called with its tier model; verdict and eval metrics record it', async () => {
  const dir = repo([{ id: 'F1', tier: 'critical' }], {
    roles: {
      builder: { adapter: 'claude', model: 'b1', by_tier: { critical: 'b-crit' } },
      evaluator: { adapter: 'claude', model: 'e1', by_tier: { critical: 'b-crit' } },
      'security-reviewer': { adapter: 'claude', model: 's1', by_tier: { critical: 's-crit' } },
    },
  });
  const seen = [];
  const json = { scores: { functionality: 9, quality: 9, security: 9, errors: 9, tests: 9 }, findings: [], out_of_scope: [] };
  const runAdapter = async (role, opts) => { seen.push([role, opts.model]); return { ok: true, error: null, text: '', json, costUsd: 0, exitCode: 0 }; };
  const r = await evalAndRecord({ root: dir, featureId: 'F1', base: 'main', config: loadConfig(dir), runAdapter, verifyResult: PASS_VERIFY });
  assert.deepEqual(seen.sort(), [['evaluator', 'b-crit'], ['security-reviewer', 's-crit']]);
  assert.equal(r.independence, 'fresh-context', 'critical builder and evaluator are both b-crit');
  assert.equal(r.reviews.evaluator.model, 'b-crit');
  assert.equal(r.reviews['security-reviewer'].model, 's-crit');
  const lines = metricLines(dir, 'eval.metrics.jsonl');
  assert.deepEqual(lines.map((m) => [m.role, m.model]).sort(), [['evaluator', 'b-crit'], ['security-reviewer', 's-crit']]);
});

// ------------------------------------------------------------------ AC-5

const PROBE = async (adapter) => (adapter.name === 'claude'
  ? { installed: true, version: 'claude fixture', help: CLAUDE_HELP }
  : { installed: false, version: null, help: null });

async function doctorOut(config) {
  const out = [];
  const err = [];
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.harness', 'config.json'), JSON.stringify(config));
  await doctor({ root: dir, out: (s) => out.push(s), err: (s) => err.push(s), probe: PROBE, env: {} });
  return { out: out.join('\n'), err: err.join('\n') };
}

test('F28 AC-5 doctor shows each role model, its tier models and the builder escalate and conflict models, one per line', async () => {
  const { out, err } = await doctorOut({
    roles: {
      builder: { adapter: 'claude', model: 'b1', by_tier: { critical: 'b-crit' }, escalate: 'b-esc', conflict_model: 'b-c' },
      evaluator: { adapter: 'claude', model: 'e1', by_tier: { standard: 'e-std' } },
      'security-reviewer': { adapter: 'claude', model: 's1' },
    },
  });
  const lines = out.split('\n');
  const at = (role) => lines.findIndex((l) => new RegExp(`^  ${role}\\s`).test(l));
  const block = (role, n) => lines.slice(at(role), at(role) + n).join('\n');
  assert.match(block('builder', 5), /^ {2}builder\s+claude\/b1 .*\n\s+critical\s+claude\/b-crit\n\s+standard\s+claude\/b1\n\s+escalate \(r≥2\)\s+claude\/b-esc\n\s+conflict\s+claude\/b-c$/);
  assert.match(block('evaluator', 3), /^ {2}evaluator\s+claude\/e1 .*\n\s+critical\s+claude\/e1\n\s+standard\s+claude\/e-std$/);
  assert.match(block('security-reviewer', 3), /^ {2}security-reviewer\s+claude\/s1 .*\n\s+critical\s+claude\/s1\n\s+standard\s+claude\/s1$/);
  assert.doesNotMatch(err, /fresh-context for/);
});

test('F28 AC-5 doctor warns "fresh-context for <tier>" only for the tier where builder and evaluator models match', async () => {
  const { err } = await doctorOut({
    roles: {
      builder: { adapter: 'claude', model: 'b1', by_tier: { standard: 'same' } },
      evaluator: { adapter: 'claude', model: 'e1', by_tier: { standard: 'same' } },
    },
  });
  assert.match(err, /warning: fresh-context for standard/);
  assert.doesNotMatch(err, /fresh-context for critical/);
  const r = await diagnose({ config: resolveConfig({ roles: { builder: { adapter: 'claude', model: 'b1', by_tier: { critical: 'x' } }, evaluator: { adapter: 'claude', model: 'e1', by_tier: { critical: 'x' } } } }), probe: PROBE, env: {} });
  assert.ok(r.warnings.some((w) => w.startsWith('fresh-context for critical')));
  assert.ok(!r.warnings.some((w) => w.startsWith('fresh-context for standard')));
});

test('F28 AC-5 doctor checks --model when a role sets a model only in by_tier', async () => {
  const noModelFlag = CLAUDE_HELP.split('\n').filter((l) => !/^\s*--model\b/.test(l)).join('\n');
  const r = await diagnose({
    config: resolveConfig({ roles: { builder: { adapter: 'claude', by_tier: { critical: 'x' } } } }),
    probe: async (a) => (a.name === 'claude' ? { installed: true, version: 'v', help: noModelFlag } : { installed: false, version: null, help: null }),
    env: {},
  });
  assert.deepEqual(r.roles.find((x) => x.role === 'builder').missing, ['--model']);
});

// ------------------------------------------------------------------ AC-6

test('F28 AC-6 SPEC §4, §10 and README describe by_tier, escalate, conflict_model and the selection order', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  const section = (n) => {
    const start = spec.search(new RegExp(`^## ${n}\\.`, 'm'));
    assert.ok(start !== -1, `SPEC §${n} exists`);
    const rest = spec.slice(start + 3);
    const end = rest.search(/^## \d+\./m);
    return end === -1 ? rest : rest.slice(0, end);
  };
  for (const [name, text] of [['SPEC §4', section(4)], ['SPEC §10', section(10)], ['README', readme]]) {
    for (const key of ['by_tier', 'escalate', 'conflict_model']) assert.ok(text.includes(key), `${name} mentions ${key}`);
  }
  // the selection order: conflict_model → escalate → by_tier → model → adapters.<name>.model
  for (const [name, text] of [['SPEC §10', section(10)], ['README', readme]]) {
    const from = text.indexOf('선택 순서');
    assert.ok(from !== -1, `${name} has a 선택 순서 (selection order)`);
    const order = ['conflict_model', 'escalate', 'by_tier', 'adapters.<name>.model'].map((k) => text.indexOf(k, from));
    assert.ok(order.every((i) => i !== -1), `${name} gives the selection order`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, `${name} lists the order conflict_model → escalate → by_tier → adapters.<name>.model`);
  }
});

// ------------------------------------------------------------------ SC-1

const BAD_MODELS = [
  ['leading dash', '--dangerously-skip-permissions'],
  ['single dash', '-m'],
  ['space', 'opus x'],
  ['tab', 'opus\tx'],
  ['newline', 'opus\nx'],
  ['carriage return', 'opus\rx'],
  ['NUL', 'opus\u0000x'],
  ['escape', 'opus\u001bx'],
  ['DEL', 'opus\u007fx'],
  ['no-break space', 'opus x'],
];
const MODEL_KEYS = [
  ['roles.builder.model', (m) => ({ roles: { builder: { adapter: 'claude', model: m } } })],
  ['roles.evaluator.by_tier.critical', (m) => ({ roles: { evaluator: { adapter: 'claude', by_tier: { critical: m } } } })],
  ['roles.security-reviewer.by_tier.standard', (m) => ({ roles: { 'security-reviewer': { adapter: 'claude', by_tier: { standard: m } } } })],
  ['roles.builder.escalate', (m) => ({ roles: { builder: { adapter: 'claude', escalate: m } } })],
  ['roles.builder.conflict_model', (m) => ({ roles: { builder: { adapter: 'claude', conflict_model: m } } })],
  ['adapters.claude.model', (m) => ({ adapters: { claude: { model: m } } })],
];

for (const [key, make] of MODEL_KEYS) {
  for (const [what, value] of BAD_MODELS) {
    test(`F28 SC-1 ${key} with ${what} is rejected with config_invalid (exit 2)`, () => {
      const err = (() => { try { resolveConfig(make(value)); return null; } catch (e) { return e; } })();
      assert.ok(err instanceof HarnessError, `accepted ${JSON.stringify(value)}`);
      assert.equal(err.code, 'config_invalid');
      assert.equal(err.exit, 2);
      assert.ok(err.message.includes(key), err.message);
    });
  }
}

test('F28 SC-1 CLI: harness doctor and harness run exit 2 on an unsafe model and no model CLI is called', async () => {
  const dir = repo([{ id: 'F1' }], { roles: { builder: { adapter: 'claude', model: 'b1', escalate: '--dangerously-skip-permissions' } } });
  const { calls } = await withFakeClaude(async () => {
    for (const args of [['doctor'], ['run']]) {
      const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'harness.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 2, `${args}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /roles\.builder\.escalate/);
    }
  });
  assert.deepEqual(calls, []);
  assert.ok(!fs.existsSync(path.join(dir, '.harness', 'wt', 'F1')));
});

test('F28 SC-1 valid model names are accepted and passed as one argument', () => {
  for (const m of ['opus', 'claude-opus-5-5', 'gpt-5.1-codex', 'gemini-2.5-pro', 'us.anthropic.claude-sonnet-5', 'claude-sonnet-5[1m]', 'org/model:tag']) {
    const config = resolveConfig({ roles: { builder: { adapter: 'claude', model: m, by_tier: { critical: m }, escalate: m, conflict_model: m } }, adapters: { claude: { model: m } } });
    assert.equal(roleModel(config, 'builder', { tier: 'critical', round: 2, conflict: true }).model, m);
  }
});

test('F28 SC-1 a run snapshot with an unsafe model is refused on --resume (config_invalid) before any call', async () => {
  const dir = repo([{ id: 'F1' }]);
  const state = {
    version: 1, runId: 'x', startedAt: new Date().toISOString(), scope: null, maxUsd: null,
    config: { ...resolveConfig({ base_branch: 'main' }), roles: { builder: { adapter: 'claude', by_tier: { standard: '-x' } } } },
    maxParallel: 1, costUsd: 0, results: [], active: [], current: null, stopped: null,
  };
  writeFiles(dir, { '.harness/runs/current.json': state });
  const err = await runFeatures({ root: dir, resume: true, deps: { build: async () => { throw new Error('called'); }, evaluate: async () => { throw new Error('called'); }, verify: scriptedVerify() } })
    .then(() => null, (e) => e);
  assert.ok(err instanceof HarnessError, String(err));
  assert.equal(err.code, 'config_invalid');
  assert.match(err.message, /roles\.builder\.by_tier\.standard/);
});

// ------------------------------------------------------------------ ES-1

const INVALID = [
  ['roles.builder.by_tier.low', { roles: { builder: { adapter: 'claude', by_tier: { low: 'x' } } } }],
  ['roles.evaluator.by_tier.critical', { roles: { evaluator: { adapter: 'claude', by_tier: { critical: '' } } } }],
  ['roles.evaluator.by_tier.standard', { roles: { evaluator: { adapter: 'claude', by_tier: { standard: 7 } } } }],
  ['roles.builder.by_tier.critical', { roles: { builder: { adapter: 'claude', by_tier: { critical: null } } } }],
  ['roles.builder.by_tier', { roles: { builder: { adapter: 'claude', by_tier: 'opus' } } }],
  ['roles.builder.by_tier', { roles: { builder: { adapter: 'claude', by_tier: ['opus'] } } }],
  ['roles.builder.escalate', { roles: { builder: { adapter: 'claude', escalate: '' } } }],
  ['roles.builder.escalate', { roles: { builder: { adapter: 'claude', escalate: 42 } } }],
  ['roles.builder.escalate', { roles: { builder: { adapter: 'claude', escalate: null } } }],
  ['roles.builder.conflict_model', { roles: { builder: { adapter: 'claude', conflict_model: '' } } }],
  ['roles.builder.conflict_model', { roles: { builder: { adapter: 'claude', conflict_model: { name: 'x' } } } }],
];

for (const [key, user] of INVALID) {
  test(`F28 ES-1 ${JSON.stringify(user.roles)} → config_invalid naming ${key}`, () => {
    const err = (() => { try { resolveConfig(user); return null; } catch (e) { return e; } })();
    assert.ok(err instanceof HarnessError, 'accepted');
    assert.equal(err.code, 'config_invalid');
    assert.equal(err.exit, 2);
    assert.ok(err.message.includes(`'${key}'`), err.message);
  });
}

test('F28 ES-1 CLI: harness doctor exits 2 and prints roles.builder.by_tier.low', () => {
  const dir = repo([{ id: 'F1' }], { roles: { builder: { adapter: 'claude', by_tier: { low: 'x' } } } });
  const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'harness.mjs'), 'doctor'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /roles\.builder\.by_tier\.low/);
  assert.ok(!r.stderr.includes('    at '), r.stderr);
});

test('F28 ES-1 valid policy keys are accepted', () => {
  const c = resolveConfig({ roles: { builder: { adapter: 'claude', by_tier: { critical: 'a', standard: 'b' }, escalate: 'c', conflict_model: 'd' } } });
  assert.equal(c.roles.builder.escalate, 'c');
});
