import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BIN, REPO, tmpdir } from './helpers.mjs';
import { git, gitRepo } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { getAdapter } from '../lib/adapters/index.mjs';
import doctor, { diagnose } from '../lib/commands/doctor.mjs';
import { runFeatures } from '../lib/run.mjs';
import { HarnessError } from '../lib/errors.mjs';

const FIX = path.join(REPO, 'test', 'fixtures');
const FAKE = path.join(FIX, 'fake-cli.mjs');
const ROLE_CLI = path.join(FIX, 'fake-role-cli.mjs');
const help = (f) => fs.readFileSync(path.join(FIX, 'help', f), 'utf8');
const CLAUDE_HELP = help('claude-2.1.280.txt');
const GEMINI_HELP = help('gemini-0.38.1.txt');
const SECRET = 'sk-test-secret';
const AUTH_VARS = ['GEMINI_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA'];

const fixtureProbe = (helps) => async (adapter) => (helps[adapter.name] === undefined
  ? { installed: false, version: null, help: null }
  : { installed: true, version: `${adapter.name} fixture`, help: helps[adapter.name] });
const PROBE = fixtureProbe({ claude: CLAUDE_HELP, gemini: GEMINI_HELP });

// A HOME with an optional ~/.gemini/settings.json (object → JSON, string → raw text).
function home(settings) {
  const dir = tmpdir('harness-home-');
  if (settings !== undefined) {
    fs.mkdirSync(path.join(dir, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gemini', 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
  }
  return dir;
}

const GEMINI_ROLES = resolveConfig({ roles: { builder: 'claude', evaluator: 'gemini', 'security-reviewer': 'claude' } });
const evaluatorOf = async (env) => (await diagnose({ config: GEMINI_ROLES, probe: PROBE, env })).roles.find((r) => r.role === 'evaluator');

// A PATH directory holding fake `claude` / `gemini` executables (fixtures/fake-role-cli.mjs).
function fakeBin(names = ['claude', 'gemini']) {
  const dir = tmpdir('harness-bin-');
  for (const name of names) {
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(dir, `${name}.cmd`), `@"${process.execPath}" "${ROLE_CLI}" ${name} %*\r\n`);
    } else {
      const f = path.join(dir, name);
      fs.writeFileSync(f, `#!/bin/sh\nexec "${process.execPath}" "${ROLE_CLI}" ${name} "$@"\n`);
      fs.chmodSync(f, 0o755);
    }
  }
  return dir;
}

const GIT_DIR = path.dirname(spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim());

// Runs the CLI with no gemini auth variables inherited, HOME replaced and the fake bin first on PATH.
function cli(args, { cwd, homeDir, bin, env = {} }) {
  const base = { ...process.env };
  for (const k of AUTH_VARS) delete base[k];
  const pathKey = Object.keys(base).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const full = { ...base, [pathKey]: [bin, path.dirname(process.execPath), GIT_DIR].join(path.delimiter), HOME: homeDir, USERPROFILE: homeDir, ...env };
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: full });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ------------------------------------------------------------------ run fixtures

function contract(id, tier = 'standard') {
  const c = {
    id, title: `feature ${id}`, security_tier: tier, version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node -e "process.exit(0)"', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-25T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function runRepo(features, config = {}) {
  const files = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, ...config },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': {
      features: features.map((f) => ({ id: f.id, title: `feature ${f.id}`, security_tier: f.tier || 'standard', depends_on: [], status: 'approved' })),
    },
  };
  for (const f of features) files[`.harness/contracts/${f.id}.json`] = contract(f.id, f.tier);
  return gitRepo(files, { branch: null });
}

const PASS_VERIFY = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };

function spies() {
  const calls = { build: [], evaluate: [], diagnose: 0 };
  const build = async (a) => {
    calls.build.push(a.featureId);
    fs.writeFileSync(path.join(a.cwd, `${a.featureId}.txt`), 'built\n');
    return { ok: true, costUsd: 0 };
  };
  const evaluate = async (a) => {
    calls.evaluate.push(a.featureId);
    return { feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null };
  };
  return { calls, build, evaluate };
}

// A doctor report where the given roles are unusable.
function fakeDiagnose(calls, unusable = {}) {
  return async () => {
    calls.diagnose += 1;
    const roles = ['builder', 'evaluator', 'security-reviewer'].map((role) => ({
      role, adapter: 'gemini', model: null, readOnly: role !== 'builder',
      usable: !(role in unusable), reason: unusable[role] ?? null, missing: [],
    }));
    return { clis: [], roles, independence: 'cross-model', warnings: [], ok: roles.every((r) => r.usable) };
  };
}

const branches = (dir) => git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split(/\r?\n/).filter(Boolean).sort();

// ------------------------------------------------------------------ AC-1

test('F20 AC-1 run stops with exit 2 before any branch or build when the builder role is not usable', async () => {
  const dir = runRepo([{ id: 'F1' }]);
  const before = branches(dir);
  const { calls, build, evaluate } = spies();
  const err = await runFeatures({ root: dir, deps: { build, evaluate, verify: async () => PASS_VERIFY, diagnose: fakeDiagnose(calls, { builder: 'gemini: not authenticated' }) } })
    .then(() => null, (e) => e);
  assert.ok(err instanceof HarnessError, String(err));
  assert.equal(err.exit, 2);
  assert.match(err.message, /builder/);
  assert.match(err.message, /not authenticated/);
  assert.equal(calls.diagnose, 1);
  assert.deepEqual(calls.build, []);
  assert.deepEqual(branches(dir), before, 'no harness/F1 or integration branch was created');
  assert.ok(!fs.existsSync(path.join(dir, '.harness', 'wt', 'F1')));
  assert.ok(!fs.existsSync(path.join(dir, '.harness', 'runs', 'current.json')), 'no run state was saved');
});

test('F20 AC-1 run stops with exit 2 when the evaluator role is not usable', async () => {
  const dir = runRepo([{ id: 'F1' }]);
  const before = branches(dir);
  const { calls, build, evaluate } = spies();
  const err = await runFeatures({ root: dir, deps: { build, evaluate, verify: async () => PASS_VERIFY, diagnose: fakeDiagnose(calls, { evaluator: 'gemini not installed' }) } })
    .then(() => null, (e) => e);
  assert.ok(err instanceof HarnessError, String(err));
  assert.equal(err.exit, 2);
  assert.match(err.message, /evaluator/);
  assert.match(err.message, /gemini not installed/);
  assert.deepEqual(calls.build, []);
  assert.deepEqual(branches(dir), before);
});

test('F20 AC-1 with a critical feature in scope an unusable security-reviewer stops the run', async () => {
  const dir = runRepo([{ id: 'F1' }, { id: 'F2', tier: 'critical' }]);
  const before = branches(dir);
  const { calls, build, evaluate } = spies();
  const err = await runFeatures({ root: dir, deps: { build, evaluate, verify: async () => PASS_VERIFY, diagnose: fakeDiagnose(calls, { 'security-reviewer': '--help lacks --approval-mode=plan' }) } })
    .then(() => null, (e) => e);
  assert.ok(err instanceof HarnessError, String(err));
  assert.equal(err.exit, 2);
  assert.match(err.message, /security-reviewer/);
  assert.match(err.message, /--help lacks --approval-mode=plan/);
  assert.deepEqual(calls.build, []);
  assert.deepEqual(branches(dir), before);
});

test('F20 AC-1 harness run CLI: an unauthenticated gemini builder stops with exit 2 and names the role', () => {
  const dir = runRepo([{ id: 'F1' }], { roles: { builder: 'gemini', evaluator: 'claude', 'security-reviewer': 'claude' } });
  const before = branches(dir);
  const r = cli(['run'], { cwd: dir, homeDir: home(), bin: fakeBin() });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /builder/);
  assert.match(r.stderr, /not authenticated/);
  assert.ok(!r.stderr.includes('    at '), r.stderr);
  assert.deepEqual(branches(dir), before, 'no harness/F1 or integration branch was created');
  assert.ok(!fs.existsSync(path.join(dir, '.harness', 'wt', 'F1')));
});

// ------------------------------------------------------------------ AC-2

test('F20 AC-2 without a critical feature in scope an unusable security-reviewer does not stop the run', async () => {
  const dir = runRepo([{ id: 'F1' }]);
  const { calls, build, evaluate } = spies();
  const r = await runFeatures({ root: dir, deps: { build, evaluate, verify: async () => PASS_VERIFY, diagnose: fakeDiagnose(calls, { 'security-reviewer': 'codex not installed' }) } });
  assert.equal(calls.diagnose, 1, 'the preflight ran');
  assert.deepEqual(calls.build, ['F1']);
  assert.deepEqual(r.results.map((x) => [x.feature, x.status]), [['F1', 'passed']]);
});

test('F20 AC-2 a critical feature outside the run scope does not require the security-reviewer', async () => {
  const dir = runRepo([{ id: 'F1' }, { id: 'F2', tier: 'critical' }]);
  const { calls, build, evaluate } = spies();
  const r = await runFeatures({ root: dir, ids: ['F1'], deps: { build, evaluate, verify: async () => PASS_VERIFY, diagnose: fakeDiagnose(calls, { 'security-reviewer': 'codex not installed' }) } });
  assert.deepEqual(r.results.map((x) => [x.feature, x.status]), [['F1', 'passed']]);
});

// ------------------------------------------------------------------ AC-3

test('F20 AC-3 gemini with no auth env and no settings.json is not authenticated and not usable', async () => {
  const ev = await evaluatorOf({ HOME: home() });
  assert.equal(ev.usable, false);
  assert.match(ev.reason, /not authenticated/);
});

test('F20 AC-3 settings.json without security.auth.selectedType is not authenticated', async () => {
  for (const s of [{}, { security: {} }, { security: { auth: {} } }, { security: { auth: { selectedType: '' } } }]) {
    const ev = await evaluatorOf({ HOME: home(s) });
    assert.equal(ev.usable, false, JSON.stringify(s));
    assert.match(ev.reason, /not authenticated/);
  }
});

for (const k of AUTH_VARS) {
  test(`F20 AC-3 ${k} set → gemini usable`, async () => {
    const ev = await evaluatorOf({ HOME: home(), [k]: k === 'GEMINI_API_KEY' ? SECRET : 'true' });
    assert.equal(ev.usable, true, ev.reason);
  });
}

test('F20 AC-3 settings.json security.auth.selectedType set → gemini usable', async () => {
  const ev = await evaluatorOf({ HOME: home({ security: { auth: { selectedType: 'oauth-personal' } } }) });
  assert.equal(ev.usable, true, ev.reason);
});

test('F20 AC-3 doctor prints the gemini role as not authenticated and exits 1', async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, '.harness'));
  fs.writeFileSync(path.join(dir, '.harness', 'config.json'), JSON.stringify({ roles: { builder: 'claude', evaluator: 'gemini', 'security-reviewer': 'claude' } }));
  fs.writeFileSync(path.join(dir, '.harness', 'features.json'), JSON.stringify({ features: [] }));
  const lines = [];
  const code = await doctor({ root: dir, args: [], out: (s) => lines.push(s), err: (s) => lines.push(s), probe: PROBE, env: { HOME: home() } });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /evaluator\s+gemini\s+read-only\s+NOT usable: not authenticated/);
});

test('F20 AC-3 claude roles are not subject to the gemini auth check', async () => {
  const report = await diagnose({ config: resolveConfig({}), probe: PROBE, env: { HOME: home() } });
  assert.equal(report.ok, true, JSON.stringify(report.roles));
});

// ------------------------------------------------------------------ AC-4

const fake = (mode, arg) => ({ bin: process.execPath, binArgs: [FAKE, mode, arg] });

test('F20 AC-4 gemini exit 41 is adapter_unavailable with an authentication detail', async () => {
  const r = await getAdapter('gemini').run({ prompt: 'x', cwd: REPO, readOnly: true, timeoutSec: 30, ...fake('exit', '41') });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'adapter_unavailable');
  assert.equal(r.exitCode, 41);
  assert.match(r.detail, /authentication/);
});

test('F20 AC-4 other gemini exit codes, and exit 41 from other adapters, stay exit_nonzero', async () => {
  const other = await getAdapter('gemini').run({ prompt: 'x', cwd: REPO, timeoutSec: 30, ...fake('exit', '42') });
  assert.equal(other.error, 'exit_nonzero');
  const claude = await getAdapter('claude').run({ prompt: 'x', cwd: REPO, timeoutSec: 30, ...fake('exit', '41') });
  assert.equal(claude.error, 'exit_nonzero');
});

// ------------------------------------------------------------------ AC-5

test('F20 AC-5 evaluator adapter_unavailable blocks the feature at once and stops the run', async () => {
  const dir = runRepo([{ id: 'F1' }, { id: 'F2' }]);
  const { calls, build } = spies();
  const evaluate = async (a) => {
    calls.evaluate.push(a.featureId);
    return { feature: a.featureId, round: a.round, verdict: 'eval_error', error: 'adapter_unavailable', detail: 'gemini: authentication failed (exit 41)', consecutive: 1, blocking: [], costUsd: 0 };
  };
  const r = await runFeatures({ root: dir, parallel: 1, deps: { build, evaluate, verify: async () => PASS_VERIFY } });
  assert.deepEqual(calls.evaluate, ['F1'], 'evaluated once — no second eval_error attempt');
  assert.deepEqual(calls.build, ['F1'], 'F2 was not started');
  assert.deepEqual(r.results.map((x) => [x.feature, x.status, x.reason]), [['F1', 'blocked', 'adapter_unavailable']]);
  assert.equal(r.stopped?.reason, 'adapter_unavailable');
  const features = JSON.parse(fs.readFileSync(path.join(dir, '.harness', 'features.json'), 'utf8')).features;
  assert.deepEqual(features.map((f) => [f.id, f.status]), [['F1', 'blocked'], ['F2', 'approved']]);
  assert.match(fs.readFileSync(r.report, 'utf8'), /stopped: adapter_unavailable/);
});

test('F20 AC-5 through the real evaluate: an unavailable evaluator adapter blocks without a retry', async () => {
  const dir = runRepo([{ id: 'F1' }, { id: 'F2' }]);
  const { calls, build } = spies();
  const adapterCalls = [];
  const runAdapter = async (role) => {
    adapterCalls.push(role);
    return { ok: false, error: 'adapter_unavailable', text: '', json: null, costUsd: null, exitCode: 41, detail: 'gemini: authentication failed (exit 41)' };
  };
  const r = await runFeatures({ root: dir, parallel: 1, deps: { build, runAdapter, verify: async () => PASS_VERIFY } });
  assert.deepEqual(adapterCalls, ['evaluator']);
  assert.deepEqual(r.results.map((x) => [x.feature, x.status, x.reason]), [['F1', 'blocked', 'adapter_unavailable']]);
  assert.match(r.results[0].detail, /authentication/);
  assert.equal(r.stopped?.reason, 'adapter_unavailable');
  assert.deepEqual(calls.build, ['F1']);
});

// ------------------------------------------------------------------ AC-6

test('F20 AC-6 SPEC §8 and §10 describe the run preflight and the gemini auth rule', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const section = (n) => {
    const start = spec.search(new RegExp(`^## ${n}\\. `, 'm'));
    assert.ok(start >= 0, `§${n} exists`);
    const rest = spec.slice(start + 1);
    const end = rest.search(/^## \d+\. /m);
    return end === -1 ? rest : rest.slice(0, end);
  };
  const s8 = section(8);
  assert.match(s8, /사전 점검/);
  assert.match(s8, /security-reviewer/);
  assert.match(s8, /usable/);
  assert.match(s8, /adapter_unavailable/);
  const s10 = section(10);
  for (const k of [...AUTH_VARS, 'selectedType', 'settings.json', 'not authenticated', '41', 'adapter_unavailable']) {
    assert.ok(s10.includes(k), `§10 mentions ${k}`);
  }
});

// ------------------------------------------------------------------ SC-1

test('F20 SC-1 doctor never prints the value of GEMINI_API_KEY', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, '.harness'));
  fs.writeFileSync(path.join(dir, '.harness', 'config.json'), JSON.stringify({ roles: { builder: 'gemini', evaluator: 'gemini', 'security-reviewer': 'gemini' } }));
  fs.writeFileSync(path.join(dir, '.harness', 'features.json'), JSON.stringify({ features: [] }));
  const r = cli(['doctor'], { cwd: dir, homeDir: home(), bin: fakeBin(), env: { GEMINI_API_KEY: SECRET } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /evaluator\s+gemini\s+read-only\s+usable/);
  assert.ok(!(r.stdout + r.stderr).includes(SECRET));
});

test('F20 SC-1 harness run output and report never contain the value of GEMINI_API_KEY', () => {
  // The fake gemini passes the preflight (key present), then fails the build with exit 41
  // and echoes the key on stderr — the run must still not repeat it.
  const dir = runRepo([{ id: 'F1' }], { roles: { builder: 'gemini', evaluator: 'gemini', 'security-reviewer': 'gemini' } });
  const r = cli(['run'], { cwd: dir, homeDir: home(), bin: fakeBin(), env: { GEMINI_API_KEY: SECRET } });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /F1\s+blocked \(adapter_unavailable\)/);
  assert.ok(!(r.stdout + r.stderr).includes(SECRET), r.stdout + r.stderr);
  const runs = path.join(dir, '.harness', 'runs');
  const reports = fs.readdirSync(runs).filter((f) => f.endsWith('.md'));
  assert.equal(reports.length, 1);
  const report = fs.readFileSync(path.join(runs, reports[0]), 'utf8');
  assert.match(report, /authentication/);
  assert.ok(!report.includes(SECRET));
  assert.ok(!fs.readFileSync(path.join(dir, '.harness', 'backlog.json'), 'utf8').includes(SECRET));
});

// ------------------------------------------------------------------ ES-1

test('F20 ES-1 an unreadable gemini settings.json is reported without a stack trace and doctor exits 0', async () => {
  const lines = [];
  const code = await doctor({ root: tmpdir(), args: [], out: (s) => lines.push(s), err: (s) => lines.push(s), probe: PROBE, env: { HOME: home('{ not json') } });
  const text = lines.join('\n');
  assert.equal(code, 0, text);
  assert.match(text, /gemini\s+gemini fixture\s+not authenticated \(settings\.json unreadable\)/);
  assert.ok(!text.includes('    at '), text);
});

test('F20 ES-1 harness doctor CLI: unreadable settings.json → not authenticated (settings.json unreadable), exit 0', () => {
  const r = cli(['doctor'], { cwd: tmpdir(), homeDir: home('{ not json'), bin: fakeBin() });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /not authenticated \(settings\.json unreadable\)/);
  assert.ok(!(r.stdout + r.stderr).includes('    at '), r.stderr);
});

test('F20 ES-1 a gemini role with an unreadable settings.json is not usable (same reason)', async () => {
  const ev = await evaluatorOf({ HOME: home('{ not json') });
  assert.equal(ev.usable, false);
  assert.equal(ev.reason, 'not authenticated (settings.json unreadable)');
});
