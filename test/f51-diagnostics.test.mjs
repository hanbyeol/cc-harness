// F51: timeout bound validation (budget.step_timeout_sec, budget.git_timeout_sec,
// verify.vacuity_timeout_sec), doctor's --version→--help fallback, status's three-way
// approval-issue breakdown, `stats --json` with no metrics, repro exit 126, and gemini's
// boolean auth env vars.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  harness, project, writeJson, readJson, tmpdir, REPO,
} from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { HarnessError } from '../lib/errors.mjs';
import { hashContract } from '../lib/contract.mjs';
import { defaultProbe } from '../lib/commands/doctor.mjs';
import { evaluate } from '../lib/eval.mjs';
import { authStatus } from '../lib/adapters/gemini.mjs';

// ---------- AC-1 ----------

const TIMEOUT_KEYS = [
  ['budget.step_timeout_sec', (v) => ({ budget: { step_timeout_sec: v } }), (c) => c.budget.step_timeout_sec],
  ['budget.git_timeout_sec', (v) => ({ budget: { git_timeout_sec: v } }), (c) => c.budget.git_timeout_sec],
  ['verify.vacuity_timeout_sec', (v) => ({ verify: { vacuity_timeout_sec: v } }), (c) => c.verify.vacuity_timeout_sec],
];

function rejectsConfig(user, needle) {
  assert.throws(() => resolveConfig(user), (e) => {
    assert.ok(e instanceof HarnessError, String(e));
    assert.equal(e.code, 'config_invalid', e.message);
    assert.equal(e.exit, 2);
    assert.ok(e.message.includes(needle), `expected '${needle}' in: ${e.message}`);
    return true;
  }, JSON.stringify(user));
}

for (const [key, make, get] of TIMEOUT_KEYS) {
  test(`F51 AC-1 ${key}: a string value is config_invalid (exit 2) naming the key`, () => {
    rejectsConfig(make('60'), key);
  });
  test(`F51 AC-1 ${key}: 0 is config_invalid (exit 2) naming the key`, () => {
    rejectsConfig(make(0), key);
  });
  test(`F51 AC-1 ${key}: 2147484 (one over the max) is config_invalid (exit 2) naming the key`, () => {
    rejectsConfig(make(2147484), key);
  });
  test(`F51 AC-1 ${key}: the bounds 1 and 2147483 are accepted`, () => {
    assert.equal(get(resolveConfig(make(1))), 1);
    assert.equal(get(resolveConfig(make(2147483))), 2147483);
  });
}

// ---------- AC-2 ----------

// A fake CLI whose --version/--help outcomes are configurable.
function fakeVersionHelpCli({ versionOk, helpOk, helpText = 'usage: fakecli [options]' }) {
  const dir = tmpdir('harness-f51-cli-');
  if (process.platform === 'win32') {
    // Shaped like the npm shims of real CLIs (claude.cmd, gemini.cmd): the .cmd only forwards
    // %* to node and the script decides. The core escapes .cmd arguments for exactly this
    // forwarding, so a batch file that compares %1 itself would see ^"--help^" and fail to parse.
    const js = path.join(dir, 'fakecli.js');
    fs.writeFileSync(js, [
      "const a = process.argv[2];",
      `if (a === '--version') { ${versionOk ? "console.log('fakecli 1.0.0');" : 'process.exit(127);'} }`,
      `else if (a === '--help') { ${helpOk ? `console.log(${JSON.stringify(helpText)});` : 'process.exit(127);'} }`,
      '',
    ].join('\n'));
    const file = path.join(dir, 'fakecli.cmd');
    fs.writeFileSync(file, `@echo off\r\n"${process.execPath}" "%~dp0fakecli.js" %*\r\n`);
    return file;
  }
  const file = path.join(dir, 'fakecli');
  const body = `#!/bin/sh
if [ "$1" = "--version" ]; then
  ${versionOk ? 'echo "fakecli 1.0.0"' : 'exit 127'}
elif [ "$1" = "--help" ]; then
  ${helpOk ? `echo "${helpText}"` : 'exit 127'}
fi
`;
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  // macOS checks a new executable on its first run. Under load that check took up to 33 s
  // (measured; a second run took 15 ms), longer than doctor's 30 s probe bound, so --version
  // looked failed. Run the script once here, with a generous bound, so the probe under test
  // starts an executable that has been checked already — as an installed CLI has.
  spawnSync(file, ['--warm-up'], { stdio: 'ignore', timeout: 120_000 });
  return file;
}

test('F51 AC-2 doctor falls back to --help when --version fails, and reports the CLI installed', async () => {
  const bin = fakeVersionHelpCli({ versionOk: false, helpOk: true });
  const result = await defaultProbe({ bin, helpArgs: ['--help'] });
  assert.equal(result.installed, true, JSON.stringify(result));
  assert.match(result.help, /usage: fakecli/);
});

test('F51 AC-2 doctor still reports not installed when --version and --help both fail', async () => {
  const bin = fakeVersionHelpCli({ versionOk: false, helpOk: false });
  const result = await defaultProbe({ bin, helpArgs: ['--help'] });
  assert.equal(result.installed, false, JSON.stringify(result));
});

test('F51 AC-2 doctor keeps reporting the real version when --version succeeds', async () => {
  const bin = fakeVersionHelpCli({ versionOk: true, helpOk: true });
  const result = await defaultProbe({ bin, helpArgs: ['--help'] });
  assert.equal(result.installed, true);
  assert.match(result.version, /fakecli 1\.0\.0/);
  assert.match(result.help, /usage: fakecli/);
});

// ---------- AC-3 ----------

function statusRepo() {
  const dir = project([
    { id: 'F1', title: 'missing contract', security_tier: 'standard', depends_on: [], status: 'approved' },
    { id: 'F2', title: 'never approved', security_tier: 'standard', depends_on: [], status: 'approved' },
    { id: 'F3', title: 'edited after approval', security_tier: 'standard', depends_on: [], status: 'approved' },
  ]);
  const base = (id) => ({
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'x', check: 'true', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  });
  // F1: no contract file at all — left unwritten.
  // F2: contract present, never approved (no `approval` key).
  writeJson(path.join(dir, '.harness', 'contracts', 'F2.json'), base('F2'));
  // F3: contract approved, then edited afterwards (hash no longer matches).
  const c3 = base('F3');
  c3.approval = { by: 'test', at: '2026-09-27T00:00:00.000Z', hash: hashContract(c3) };
  writeJson(path.join(dir, '.harness', 'contracts', 'F3.json'), c3);
  const edited = readJson(path.join(dir, '.harness', 'contracts', 'F3.json'));
  edited.acceptance_criteria[0].criterion = 'weakened';
  writeJson(path.join(dir, '.harness', 'contracts', 'F3.json'), edited);
  return dir;
}

test('F51 AC-3 status distinguishes contract missing, no approval hash, and changed after approval', () => {
  const dir = statusRepo();
  const r = harness(['status'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('contract missing (run `harness approve` again): F1'), r.stdout);
  assert.ok(r.stdout.includes('no approval hash (run `harness approve` again): F2'), r.stdout);
  assert.ok(r.stdout.includes('changed after approval (run `harness approve` again): F3'), r.stdout);
  assert.doesNotMatch(r.stdout, /runnable: F1|runnable: F2|runnable: F3/);

  const brief = harness(['status', '--brief'], { cwd: dir });
  assert.equal(brief.code, 0, brief.stdout + brief.stderr);
  assert.match(brief.stdout, /re-approve: F1, F2, F3/);
});

// ---------- AC-4 ----------

test('F51 AC-4 harness stats --json with no metrics files prints {"steps":[],"suggestions":[]} and exits 0', () => {
  const dir = project([]);
  const r = harness(['stats', '--json'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { steps: [], suggestions: [] });
});

// ---------- AC-5 ----------

function eval126Fixture() {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': {
      id: 'F9', title: 'fixture', security_tier: 'standard', version: 1,
      acceptance_criteria: [{ id: 'AC-1', criterion: 'check exists', check: 'node -e "process.exit(0)"', new: false }],
      security_criteria: [], error_scenarios: [], out_of_scope: [],
    },
    '.harness/backlog.json': { items: [] },
  });
}

const PASS_VERIFY_126 = {
  pass: true, commands: [], warnings: [],
  integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } },
  criteria: [{ id: 'AC-1', pass: true }],
};

function scriptedEvaluator(replies) {
  const queue = [...replies];
  return async (role) => {
    if (role !== 'evaluator') throw new Error(`unexpected call for role ${role}`);
    if (!queue.length) throw new Error('no more replies queued');
    return queue.shift();
  };
}

test('F51 AC-5 a repro that exits 126 is repro_not_runnable, not a blocking finding', async () => {
  const dir = eval126Fixture();
  const config = resolveConfig({
    base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 30 },
    roles: { builder: 'claude', evaluator: 'claude', 'security-reviewer': 'claude' },
  });
  const finding = { criterion_id: 'AC-1', dimension: 'functionality', summary: 'looks broken', repro: 'node -e "process.exit(126)"' };
  const json = { scores: { functionality: 9, quality: 9, security: 9, errors: 9, tests: 9 }, findings: [finding], out_of_scope: [] };
  const runAdapter = scriptedEvaluator([{ ok: true, error: null, text: JSON.stringify(json), json, costUsd: 0, exitCode: 0 }]);
  const r = await evaluate({
    root: dir, featureId: 'F9', base: 'main', config, verifyResult: PASS_VERIFY_126, runAdapter,
  });
  assert.equal(r.blocking.length, 0, JSON.stringify(r.blocking));
  assert.equal(r.backlogged.length, 1, JSON.stringify(r.backlogged));
  assert.equal(r.backlogged[0].reason, 'repro_not_runnable');
  assert.equal(r.backlogged[0].exit, 126);
  const items = readJson(path.join(dir, '.harness', 'backlog.json')).items;
  assert.equal(items[0].reason, 'repro_not_runnable');
});

// ---------- AC-6 ----------

const BOOL_AUTH_VARS = ['GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA'];

for (const name of BOOL_AUTH_VARS) {
  for (const value of ['', 'false', 'FALSE', 'False', '0']) {
    test(`F51 AC-6 ${name}=${JSON.stringify(value)} is not authenticated`, () => {
      const env = { HOME: tmpdir('harness-f51-home-'), [name]: value };
      const status = authStatus(env);
      assert.equal(status.ok, false, JSON.stringify(status));
    });
  }
  test(`F51 AC-6 ${name}='1' is authenticated`, () => {
    const env = { HOME: tmpdir('harness-f51-home-'), [name]: '1' };
    const status = authStatus(env);
    assert.equal(status.ok, true, JSON.stringify(status));
    assert.equal(status.via, name);
  });
}

test('F51 AC-6 GEMINI_API_KEY is unaffected by the false/0 boolean rule — it is a secret key, not a flag', () => {
  const env = { HOME: tmpdir('harness-f51-home-'), GEMINI_API_KEY: '0' };
  const status = authStatus(env);
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.via, 'GEMINI_API_KEY');
});

// ---------- ES-1 ----------

const SPEC = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
const section = (n, next = n + 1) => SPEC.slice(SPEC.indexOf(`\n## ${n}. `), SPEC.indexOf(`\n## ${next}. `));

test('F51 ES-1 SPEC §4 documents the shared 1..2147483 bound for the three timeout keys', () => {
  const s4 = section(4);
  for (const s of ['budget.step_timeout_sec', 'budget.git_timeout_sec', 'verify.vacuity_timeout_sec', '2147483', 'config_invalid']) {
    assert.ok(s4.includes(s), `§4 mentions ${s}`);
  }
});

test('F51 ES-1 SPEC §7 documents repro exit 126 as repro_not_runnable', () => {
  const s7 = section(7);
  assert.match(s7, /126/);
  assert.match(s7, /repro_not_runnable/);
});

test('F51 ES-1 SPEC §10 documents the doctor --version/--help fallback and the gemini boolean auth vars', () => {
  const s10 = section(10, 11);
  assert.match(s10, /--help/);
  assert.match(s10, /unknown/);
  for (const s of ['GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA', 'false', '0']) assert.ok(s10.includes(s), `§10 mentions ${s}`);
});
