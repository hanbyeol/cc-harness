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
import { runExport } from '../lib/commands/export.mjs';

// F60: field data accuracy — Windows user and host names are not redacted, export goes by the
// byte position in each event file, and a timed-out repro says so in timed_out.

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
// Every bundle line in the hub, bundles oldest first.
const hubLines = (hub) => listFiles(hub).flatMap((p) => listFiles(path.join(hub, p)).flatMap((n) =>
  fs.readFileSync(path.join(hub, p, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))));
const bundleCount = (hub) => listFiles(hub).reduce((n, p) => n + listFiles(path.join(hub, p)).length, 0);
const note = (dir, n, at) => recordEvent(dir, { stage: 'feedback', type: 'intervention', feature: 'F9', data: { kind: 'other', n } }, { now: new Date(at) });
const collect = () => {
  const out = [];
  const err = [];
  return { out, err, o: (s) => out.push(s), e: (s) => err.push(s) };
};
const exportAt = (dir, hub, at, c = collect()) => ({ code: runExport({ root: dir, hub, out: c.o, err: c.e, now: new Date(at) }), ...c });

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

// ---------- AC-2 ----------
test('F60 AC-2: export records the byte position of each event file in .exported', () => {
  const dir = fixture();
  note(dir, 1, '2026-08-31T00:00:00Z');
  note(dir, 2, '2026-09-01T00:00:00Z');
  const hub = path.join(tmpdir(), 'hub');
  const r = exportAt(dir, hub, '2026-09-10T00:00:00Z');
  assert.equal(r.code, 0, r.err.join('\n'));
  const marker = JSON.parse(fs.readFileSync(exportedPath(dir), 'utf8'));
  assert.equal(marker.at, '2026-09-10T00:00:00.000Z');
  assert.deepEqual(marker.files, {
    '2026-08.jsonl': fs.statSync(path.join(eventsDir(dir), '2026-08.jsonl')).size,
    '2026-09.jsonl': fs.statSync(path.join(eventsDir(dir), '2026-09.jsonl')).size,
  });
});

test('F60 AC-2: a new event with the same millisecond ts as an exported one, or before the export time, goes to the next export', () => {
  const dir = fixture();
  const hub = path.join(tmpdir(), 'hub');
  note(dir, 1, '2026-09-01T00:00:00.123Z');
  assert.equal(exportAt(dir, hub, '2026-09-01T00:00:00.123Z').code, 0);
  // recorded after that export, with the same millisecond as the exported event and the export
  note(dir, 2, '2026-09-01T00:00:00.123Z');
  note(dir, 3, '2026-09-01T00:00:00.122Z');
  const r = exportAt(dir, hub, '2026-09-01T00:00:00.124Z');
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.equal(bundleCount(hub), 2);
  assert.deepEqual(hubLines(hub).map((l) => l.ts), ['2026-09-01T00:00:00.123Z', '2026-09-01T00:00:00.122Z', '2026-09-01T00:00:00.123Z']);
  // nothing new: no third bundle, nothing sent twice
  const again = exportAt(dir, hub, '2026-09-02T00:00:00Z');
  assert.match(again.out.at(-1), /nothing to export/);
  assert.equal(bundleCount(hub), 2);
});

test('F60 AC-2: a line still being written (no newline yet) is left for the next export', () => {
  const dir = fixture();
  const hub = path.join(tmpdir(), 'hub');
  note(dir, 1, '2026-09-01T00:00:00Z');
  const file = path.join(eventsDir(dir), '2026-09.jsonl');
  const whole = fs.readFileSync(file, 'utf8');
  note(dir, 2, '2026-09-02T00:00:00Z');
  const second = fs.readFileSync(file, 'utf8').slice(whole.length);
  fs.writeFileSync(file, whole + second.slice(0, 10));
  assert.equal(exportAt(dir, hub, '2026-09-03T00:00:00Z').code, 0);
  assert.deepEqual(hubLines(hub).map((l) => l.ts), ['2026-09-01T00:00:00.000Z']);
  fs.writeFileSync(file, whole + second);
  assert.equal(exportAt(dir, hub, '2026-09-04T00:00:00Z').code, 0);
  assert.deepEqual(hubLines(hub).map((l) => l.ts), ['2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z']);
});

// ---------- AC-3 ----------
test('F60 AC-3: an .exported of the earlier form (a time only) exports the events since that time once, then is rewritten with positions', () => {
  const dir = fixture();
  const hub = path.join(tmpdir(), 'hub');
  note(dir, 1, '2026-09-01T00:00:00Z');
  note(dir, 2, '2026-09-05T00:00:00Z');
  note(dir, 3, '2026-09-06T00:00:00Z');
  fs.writeFileSync(exportedPath(dir), '2026-09-05T00:00:00.000Z\n');
  assert.equal(exportAt(dir, hub, '2026-09-07T00:00:00Z').code, 0);
  assert.deepEqual(hubLines(hub).map((l) => l.ts), ['2026-09-05T00:00:00.000Z', '2026-09-06T00:00:00.000Z']);
  const marker = JSON.parse(fs.readFileSync(exportedPath(dir), 'utf8'));
  assert.equal(marker.at, '2026-09-07T00:00:00.000Z');
  assert.deepEqual(marker.files, { '2026-09.jsonl': fs.statSync(path.join(eventsDir(dir), '2026-09.jsonl')).size });
  // from now on positions decide: an older ts recorded later is exported, nothing twice
  note(dir, 4, '2026-09-02T00:00:00Z');
  assert.equal(exportAt(dir, hub, '2026-09-08T00:00:00Z').code, 0);
  assert.deepEqual(hubLines(hub).map((l) => l.ts), ['2026-09-05T00:00:00.000Z', '2026-09-06T00:00:00.000Z', '2026-09-02T00:00:00.000Z']);
});

test('F60 AC-3: an .exported of the earlier form with no event after it is still rewritten with positions', () => {
  const dir = fixture();
  const hub = path.join(tmpdir(), 'hub');
  note(dir, 1, '2026-09-01T00:00:00Z');
  fs.writeFileSync(exportedPath(dir), '2026-09-05T00:00:00.000Z\n');
  const r = exportAt(dir, hub, '2026-09-07T00:00:00Z');
  assert.equal(r.code, 0);
  assert.match(r.out.at(-1), /nothing to export/);
  assert.equal(bundleCount(hub), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(exportedPath(dir), 'utf8')).files, { '2026-09.jsonl': fs.statSync(path.join(eventsDir(dir), '2026-09.jsonl')).size });
  note(dir, 2, '2026-09-02T00:00:00Z');
  assert.equal(exportAt(dir, hub, '2026-09-08T00:00:00Z').code, 0);
  assert.deepEqual(hubLines(hub).map((l) => l.ts), ['2026-09-02T00:00:00.000Z']);
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

// ---------- AC-5 ----------
test('F60 AC-5: SPEC describes the extended allowlist in the redaction rules and the byte positions of export', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const sr2 = spec.split('\n').find((l) => l.startsWith('- SR-2 '));
  for (const k of HOST_VARS) assert.ok(sr2.includes(k), k);
  assert.match(sr2, /가리지 않는다/);
  const ex = spec.slice(spec.indexOf('**현장 데이터 내보내기**'), spec.indexOf('- `--dry-run`'));
  for (const s of ['.exported', '바이트 위치', '"files"', '같은 밀리초', '이전 형식', '처음부터', '경고']) assert.ok(ex.includes(s), s);
  assert.match(spec, /`timed_out`/);
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

// ---------- ES-1 ----------
test('F60 ES-1: an event file shorter than its export position is exported from the start, with a warning', () => {
  const dir = fixture();
  const hub = path.join(tmpdir(), 'hub');
  note(dir, 1, '2026-09-01T00:00:00Z');
  note(dir, 2, '2026-09-02T00:00:00Z');
  assert.equal(exportAt(dir, hub, '2026-09-03T00:00:00Z').code, 0);
  // the file is replaced by a shorter one
  const file = path.join(eventsDir(dir), '2026-09.jsonl');
  fs.writeFileSync(file, '');
  note(dir, 3, '2026-09-04T00:00:00Z');
  const r = exportAt(dir, hub, '2026-09-05T00:00:00Z');
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.ok(r.err.some((l) => /^harness: warning: events\/2026-09\.jsonl is shorter than/.test(l)), r.err.join('\n'));
  assert.deepEqual(hubLines(hub).map((l) => l.ts), ['2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', '2026-09-04T00:00:00.000Z']);
  assert.deepEqual(JSON.parse(fs.readFileSync(exportedPath(dir), 'utf8')).files, { '2026-09.jsonl': fs.statSync(file).size });
});

test('F60 ES-1: a truncated event file with no new line still gets its position reset, with a warning', () => {
  const dir = fixture();
  const hub = path.join(tmpdir(), 'hub');
  note(dir, 1, '2026-09-01T00:00:00Z');
  assert.equal(exportAt(dir, hub, '2026-09-03T00:00:00Z').code, 0);
  const file = path.join(eventsDir(dir), '2026-09.jsonl');
  fs.writeFileSync(file, '');
  const r = exportAt(dir, hub, '2026-09-05T00:00:00Z');
  assert.equal(r.code, 0);
  assert.ok(r.err.some((l) => l.includes('events/2026-09.jsonl')), r.err.join('\n'));
  assert.deepEqual(JSON.parse(fs.readFileSync(exportedPath(dir), 'utf8')).files, { '2026-09.jsonl': 0 });
  // later events in the replaced file are exported
  note(dir, 2, '2026-09-06T00:00:00Z');
  const again = exportAt(dir, hub, '2026-09-07T00:00:00Z');
  assert.deepEqual(again.err, []);
  assert.deepEqual(hubLines(hub).map((l) => l.ts), ['2026-09-01T00:00:00.000Z', '2026-09-06T00:00:00.000Z']);
});
