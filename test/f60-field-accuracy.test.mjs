import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpdir } from './helpers.mjs';
import { gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { writeJsonAtomic } from '../lib/state.mjs';
import { BASE_ENV_ALLOWLIST } from '../lib/exec.mjs';
import { redactor } from '../lib/failures.mjs';
import { recordEvent } from '../lib/events.mjs';
import { stepEventData } from '../lib/usage.mjs';
import { verify as realVerify } from '../lib/verify.mjs';
import { evaluate } from '../lib/eval.mjs';
import { runFeatures } from '../lib/run.mjs';

// F60: field data accuracy — Windows user and host names are not redacted and a timed-out
// repro says so in timed_out.

function contract(id = 'F9') {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'one', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-27T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture({ telemetry = { share: true }, files = {} } = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, telemetry },
    '.harness/features.json': { features: [{ id: 'F9', title: 'feature F9', status: 'approved', depends_on: [] }] },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/contracts/F9.json': contract(),
    'scripts/ok.mjs': 'process.exit(0);\n',
    ...files,
  }, { branch: null });
}

const eventsDir = (dir) => path.join(dir, '.harness', 'events');
const exportedPath = (dir) => path.join(eventsDir(dir), '.exported');
const eventsText = (dir) => {
  let names = [];
  try { names = fs.readdirSync(eventsDir(dir)).filter((n) => n.endsWith('.jsonl')).sort(); } catch { return ''; }
  return names.map((n) => fs.readFileSync(path.join(eventsDir(dir), n), 'utf8')).join('');
};
const listFiles = (d) => {
  try { return fs.readdirSync(d).sort(); } catch { return []; }
};
const note = (dir, n, at) => recordEvent(dir, { stage: 'feedback', type: 'intervention', feature: 'F9', data: { kind: 'other', n } }, { now: new Date(at) });
// Runs `fn` with `vars` set in process.env, restoring the previous values afterwards.
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------- AC-1 ----------
const HOST_VARS = ['USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'HOSTNAME', 'LOGONSERVER'];
const SESSION = '3c9f0e2a-7b41-4d5e-9a6f-1e2d3c4b5a60';

test('F60 AC-1: USERNAME, USERDOMAIN, COMPUTERNAME, HOSTNAME and LOGONSERVER are on the base allowlist and not redacted', () => {
  for (const k of HOST_VARS) assert.ok(BASE_ENV_ALLOWLIST.includes(k), k);
  const env = { USERNAME: 'runneradmin', USERDOMAIN: 'fv-az123-456', COMPUTERNAME: 'fv-az123-456x', HOSTNAME: 'build-host-01', LOGONSERVER: '\\\\fv-az123-456' };
  const redact = redactor(env, []);
  for (const [k, v] of Object.entries(env)) assert.equal(redact(`${k}=${v}`), `${k}=${v}`, k);
});

test('F60 AC-1: with USERNAME=runneradmin the session log path of a build/step event keeps runneradmin', async () => {
  const dir = fixture();
  // a worktree path with the user name in it, as under C:\Users\runneradmin\… on a Windows runner
  const cwd = path.join(tmpdir(), 'runneradmin');
  fs.mkdirSync(cwd, { recursive: true });
  const data = stepEventData({
    step: 'build', attempt: 1, role: 'builder', adapter: 'claude', model: null, outcome: 'ok',
    startedAt: '2026-09-27T00:00:00Z', endedAt: '2026-09-27T00:00:01Z', costUsd: 0,
    usage: { turns: 1, tokens: null, session_id: SESSION, duration_api_ms: null }, cwd,
  });
  assert.ok(data.session_log.path.includes('runneradmin'), data.session_log.path);
  // as run records it: the redaction of the run's environment (here a runner's, nothing else in it)
  const env = { PATH: process.env.PATH, USERNAME: 'runneradmin', COMPUTERNAME: 'fv-az123-456x', GITHUB_TOKEN: 'ghp_F60githubtokenvalue1234' };
  assert.equal(recordEvent(dir, { stage: 'build', type: 'step', feature: 'F9', round: 1, data }, { redact: redactor(env, []) }), true);
  // with the redaction taken from process.env
  await withEnv({ USERNAME: 'runneradmin' }, () => {
    assert.equal(recordEvent(dir, { stage: 'build', type: 'step', feature: 'F9', round: 2, data }), true);
  });
  const [e, f] = eventsText(dir).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(e.data.session_log.path, data.session_log.path);
  assert.ok(f.data.session_log.path.includes('runneradmin'), f.data.session_log.path);
});

// ---------- AC-4 ----------
const scores = { functionality: 9, quality: 9, security: 9, errors: 9, tests: 9 };
const reply = (json) => ({ ok: true, error: null, text: JSON.stringify(json), json, costUsd: 0, exitCode: 0 });
const PASS_VERIFY = {
  pass: true, commands: [], warnings: [],
  integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } },
  criteria: [{ id: 'AC-1', pass: true }],
};

test('F60 AC-4: a timed-out repro has timed_out true and an exit of null or a number; one that ran to the end has timed_out false', async () => {
  const dir = fixture({ files: {
    'scripts/fail.mjs': 'process.exit(3);\n',
    'scripts/sleep.mjs': 'setTimeout(() => {}, 12000);\n', // a few seconds past the 5 s timeout
  } });
  writeFiles(dir, { 'src/app.mjs': 'export const v = 1;\n' });
  commitAll(dir, 'feature commit');
  const json = { scores, out_of_scope: [], findings: [
    { criterion_id: 'AC-1', dimension: 'functionality', summary: 'hangs', repro: 'node scripts/sleep.mjs' },
    { criterion_id: 'AC-1', dimension: 'functionality', summary: 'fails', repro: 'node scripts/fail.mjs' },
  ] };
  const config = resolveConfig({ base_branch: 'main', roles: { builder: 'claude', evaluator: 'claude', 'security-reviewer': 'claude' }, verify: { commands: [] }, budget: { step_timeout_sec: 5 } }); // 5 s: fail.mjs must finish in time on a loaded machine
  const r = await evaluate({ root: dir, featureId: 'F9', base: 'main', config, verifyResult: PASS_VERIFY, runAdapter: async () => reply(json) });
  assert.equal(r.backlogged[0].reason, 'repro_timeout'); // judged as before
  assert.equal(r.blocking.length, 1);
  const found = eventsText(dir).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.stage === 'eval' && e.type === 'finding');
  const hung = found.find((e) => e.data.reason === 'repro_timeout');
  assert.equal(hung.data.timed_out, true);
  assert.ok(hung.data.repro_exit === null || Number.isInteger(hung.data.repro_exit), String(hung.data.repro_exit));
  const failed = found.find((e) => e.data.result === 'blocking');
  assert.equal(failed.data.timed_out, false);
  assert.equal(failed.data.repro_exit, 3);
});

test('F60 AC-4: the F56 ES-1 test checks timed_out instead of the exit value', () => {
  const text = fs.readFileSync(path.join(REPO, 'test', 'f56-eval-events.test.mjs'), 'utf8');
  const es1 = text.slice(text.indexOf("test('F56 ES-1"));
  const body = es1.slice(0, es1.indexOf('\n});'));
  assert.match(body, /e\.data\.timed_out/);
  assert.doesNotMatch(body, /'AC-1', null, 'node'/); // no longer asserts a null exit
});

// ---------- SC-1 ----------
const SECRETS = {
  GEMINI_API_KEY: 'AIzaF60-gemini-secret-value',
  AWS_SECRET_ACCESS_KEY: 'wJalrF60/aws+secret+access',
  GITHUB_TOKEN: 'ghp_F60githubtokenvalue1234',
};

function leakFixture(name) {
  return fixture({ files: {
    'scripts/leak.mjs': `console.log(${JSON.stringify(`${name}=${SECRETS[name]}`)});\nprocess.exit(1);\n`,
  } });
}

async function assertRedacted(name) {
  const secret = SECRETS[name];
  assert.ok(secret.length >= 8);
  const env = { ...process.env, USERNAME: 'runneradmin', [name]: secret };
  // run: state file writes and the report of a blocked run
  const dir = leakFixture(name);
  const writes = [];
  const spy = (file, data, opts) => {
    writes.push(JSON.stringify(data));
    return writeJsonAtomic(file, data, opts);
  };
  const build = async (a) => { writeFiles(a.cwd, { 'F9.txt': `built ${a.attempt}\n` }); return { ok: true, costUsd: 0 }; };
  const evalPass = (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });
  const r = await runFeatures({
    root: dir, config: resolveConfig({ base_branch: 'main', verify: { commands: ['node scripts/leak.mjs'] }, budget: { step_timeout_sec: 60 }, max_rounds: 1 }),
    deps: { build, verify: realVerify, evaluate: async (a) => evalPass(a), env, writeJsonAtomic: spy },
  });
  assert.equal(r.results[0].status, 'blocked', JSON.stringify(r.results));
  assert.ok(writes.some((w) => w.includes(`${name}=[redacted]`)), 'the failed verify was saved, redacted');
  for (const w of writes) assert.ok(!w.includes(secret), w);
  const report = fs.readFileSync(r.report, 'utf8');
  assert.ok(report.includes(`${name}=[redacted]`), report);
  assert.ok(!report.includes(secret));
  assert.ok(!eventsText(dir).includes(secret));
  // events recorded with the process environment
  await withEnv({ USERNAME: 'runneradmin', [name]: secret }, () => {
    recordEvent(dir, { stage: 'feedback', type: 'intervention', feature: 'F9', data: { kind: 'other', text: `${name}=${secret}` } });
  });
  const text = eventsText(dir);
  assert.ok(text.includes(`${name}=[redacted]`), text);
  assert.ok(!text.includes(secret));
}

for (const name of Object.keys(SECRETS)) {
  test(`F60 SC-1: ${name} is redacted in events, the report and the state file after the allowlist grew`, async () => {
    await assertRedacted(name);
  });
}
