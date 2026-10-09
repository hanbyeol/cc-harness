import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { harness, REPO } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { runFeatures } from '../lib/run.mjs';
import * as verifyLib from '../lib/verify.mjs';
import { HarnessError } from '../lib/errors.mjs';

const { verify } = verifyLib;
const execFileP = promisify(execFile);

// F81: verify phase timings (verify/phases event, result phases_ms/total_ms) and the time a
// run's verify waited for a verify pool slot (metrics queue_ms, harness stats).

const PHASE_KEYS = ['integrity', 'commands', 'test_count', 'checks', 'cleanup'];
const DATA_KEYS = ['step', 'total_ms', 'phases_ms', 'test_count_source'];
const SOURCES = new Set(['parsed', 'ran', 'cache']);
const SLOW = 1600; // ms a slow fake command sleeps; the phase it is in must be at least 1500

const SCRIPTS = {
  'scripts/ok.mjs': 'process.exit(0);\n',
  'scripts/fail.mjs': 'process.exit(3);\n',
  'scripts/has.mjs': "import fs from 'node:fs';\nprocess.exit(process.argv.slice(2).every((f) => fs.existsSync(f)) ? 0 : 1);\n",
  // Sleeps argv[2] ms, then prints argv[3] (if given) and exits 0.
  'scripts/slow.mjs': "await new Promise((r) => setTimeout(r, Number(process.argv[2])));\nif (process.argv[3]) console.log(process.argv[3]);\n",
  // node:test-like summary after a sleep, for test_count 'from:commands[0]'.
  'scripts/summary.mjs': "await new Promise((r) => setTimeout(r, Number(process.argv[2])));\nconsole.log('# tests 3');\n",
};

function contract(id, criteria, { approve = false } = {}) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: criteria, security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  if (approve) c.approval = { by: 'test', at: '2026-10-07T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

// A repo on `feature` (base `main`) with a contract F9 whose criteria are `criteria`.
function fixture(criteria = [{ id: 'AC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }], files = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'x', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': contract('F9', criteria),
    '.gitignore': '.harness/events/\n.harness/runs/\n',
    ...SCRIPTS, ...files,
  });
}

// The verify result cache (F87) is off: these tests verify one tree more than once and time
// what runs on the second verify.
const cfg = (verifyCfg = {}) => resolveConfig({ base_branch: 'main', verify: { commands: [], cache: 'off', ...verifyCfg }, budget: { step_timeout_sec: 60 } });

const eventsOf = (dir) => {
  const d = path.join(dir, '.harness', 'events');
  let names = [];
  try { names = fs.readdirSync(d).sort(); } catch { return []; }
  return names.flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
};
const phasesEvents = (dir) => eventsOf(dir).filter((e) => e.stage === 'verify' && e.type === 'phases');

function assertShape(data) {
  assert.deepEqual(Object.keys(data), DATA_KEYS);
  assert.deepEqual(Object.keys(data.phases_ms), PHASE_KEYS);
  for (const k of PHASE_KEYS) assert.ok(Number.isInteger(data.phases_ms[k]) && data.phases_ms[k] >= 0, `${k}: ${data.phases_ms[k]}`);
  assert.ok(Number.isInteger(data.total_ms) && data.total_ms >= 0);
  const sum = PHASE_KEYS.reduce((a, k) => a + data.phases_ms[k], 0);
  assert.ok(sum <= data.total_ms, `sum ${sum} > total ${data.total_ms}`);
}

// ------------------------------------------------------------------ run fixtures

function runFixture(ids, { run } = {}) {
  const state = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...(run ? { run } : {}) },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': {
      features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: 'standard', depends_on: [], status: 'approved' })),
    },
  };
  for (const id of ids) {
    state[`.harness/contracts/${id}.json`] = contract(id, [{ id: 'AC-1', criterion: `${id}.txt exists`, check: `node scripts/has.mjs ${id}.txt`, new: true }], { approve: true });
  }
  return gitRepo({ ...state, ...SCRIPTS }, { branch: null });
}
const runCfg = (run) => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, ...(run ? { run } : {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isIntegration = (cwd) => path.basename(cwd) === '_integration';
const PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const evaluate = async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });
function build() {
  const calls = [];
  const fn = async (a) => {
    const c = { featureId: a.featureId, end: null };
    calls.push(c);
    // Both builds run until both have started (bounded), so both verifies are asked for together.
    for (const t0 = Date.now(); calls.length < 2 && Date.now() - t0 < 30_000;) await sleep(20);
    writeFiles(a.cwd, { [`${a.featureId}.txt`]: 'x\n' });
    c.end = Date.now();
    return { ok: true, costUsd: 0 };
  };
  fn.calls = calls;
  return fn;
}
const metricsLines = (dir) => {
  const d = path.join(dir, '.harness', 'runs');
  return fs.readdirSync(d).filter((n) => n.endsWith('.metrics.jsonl'))
    .flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
};

// ------------------------------------------------------------------ AC-1
test('F81 AC-1: a passing and a failing verify each leave one verify/phases event with the five phases', async () => {
  const dir = fixture();
  const r = await verify({ root: dir, featureId: 'F9', base: 'main', config: cfg() });
  assert.equal(r.pass, true);
  let ev = phasesEvents(dir);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].feature, 'F9');
  assert.equal(ev[0].data.step, null);
  assertShape(ev[0].data);

  const failing = fixture([{ id: 'AC-1', criterion: 'fails', check: 'node scripts/fail.mjs', new: false }]);
  const f = await verify({ root: failing, featureId: 'F9', base: 'main', config: cfg({ commands: ['node scripts/fail.mjs'] }) });
  assert.equal(f.pass, false);
  ev = phasesEvents(failing);
  assert.equal(ev.length, 1);
  assertShape(ev[0].data);
});

test('F81 AC-1: a run labels the phases events with step verify and post_merge_verify', async () => {
  const dir = runFixture(['F1']);
  const r = await runFeatures({ root: dir, config: runCfg({ max_parallel: 1 }), deps: { build: build(), evaluate, cpus: 8 } });
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results));
  const ev = phasesEvents(dir);
  assert.deepEqual(ev.map((e) => e.data.step).sort(), ['post_merge_verify', 'verify']);
  for (const e of ev) {
    assert.equal(e.feature, 'F1');
    assert.equal(e.round, 1);
    assertShape(e.data);
  }
});

// ------------------------------------------------------------------ AC-2
test('F81 AC-2: a slow verify command shows in phases_ms.commands and a slow check in phases_ms.checks', async () => {
  const dir = fixture([{ id: 'AC-1', criterion: 'slow', check: `node scripts/slow.mjs ${SLOW}`, new: false }]);
  // check_parallel 1: above 1 the check runs alongside the command and that time is checks (F94).
  const r = await verify({ root: dir, featureId: 'F9', base: 'main', config: cfg({ commands: [`node scripts/slow.mjs ${SLOW}`], check_parallel: 1 }) });
  assert.equal(r.pass, true, JSON.stringify(r.criteria));
  const [e] = phasesEvents(dir);
  assertShape(e.data);
  assert.ok(e.data.phases_ms.commands >= 1500, JSON.stringify(e.data));
  assert.ok(e.data.phases_ms.checks >= 1500, JSON.stringify(e.data));
});

// ------------------------------------------------------------------ AC-3
test('F81 AC-3: a base test count run without a cache is in phases_ms.test_count; a cache hit names its sources', async () => {
  const dir = fixture();
  const config = cfg({ test_count: `node scripts/slow.mjs ${SLOW} 4`, check_parallel: 1 });
  const first = await verify({ root: dir, featureId: 'F9', base: 'main', config });
  assert.equal(first.integrity.testCount.status, 'ok', JSON.stringify(first.integrity));
  let [e] = phasesEvents(dir);
  assert.deepEqual(e.data.test_count_source, { head: 'ran', base: 'ran' });
  assert.ok(e.data.phases_ms.test_count >= 1500, JSON.stringify(e.data));

  await verify({ root: dir, featureId: 'F9', base: 'main', config });
  e = phasesEvents(dir)[1];
  assert.deepEqual(e.data.test_count_source, { head: 'ran', base: 'cache' });
  assertShape(e.data);
});

test('F81 AC-3: test_count from a verify command is parsed on head and run on base (then cached)', async () => {
  const dir = fixture();
  const config = cfg({ commands: [`node scripts/summary.mjs ${SLOW}`], test_count: 'from:commands[0]' });
  await verify({ root: dir, featureId: 'F9', base: 'main', config });
  let [e] = phasesEvents(dir);
  assert.deepEqual(e.data.test_count_source, { head: 'parsed', base: 'ran' });
  assert.ok(e.data.phases_ms.test_count >= 1500, JSON.stringify(e.data));
  await verify({ root: dir, featureId: 'F9', base: 'main', config });
  e = phasesEvents(dir)[1];
  assert.deepEqual(e.data.test_count_source, { head: 'parsed', base: 'cache' });
  // Without test_count there is no source.
  const plain = fixture();
  await verify({ root: plain, featureId: 'F9', base: 'main', config: cfg() });
  assert.equal(phasesEvents(plain)[0].data.test_count_source, null);
});

// ------------------------------------------------------------------ AC-4
test('F81 AC-4: harness verify --json carries the same phases_ms and total_ms as the event', () => {
  const dir = fixture();
  const r = harness(['verify', 'F9', '--json'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const [e] = phasesEvents(dir);
  assert.deepEqual(Object.keys(out.phases_ms), PHASE_KEYS);
  assert.deepEqual(out.phases_ms, e.data.phases_ms);
  assert.equal(out.total_ms, e.data.total_ms);
});

test("F81 AC-4: a run's verify results carry the same phases_ms and total_ms as their events", async () => {
  const dir = runFixture(['F1']);
  const results = [];
  const recording = async (a) => {
    const r = await verify(a);
    results.push({ step: a.step, r });
    return r;
  };
  await runFeatures({ root: dir, config: runCfg({ max_parallel: 1 }), deps: { build: build(), verify: recording, evaluate, cpus: 8 } });
  assert.deepEqual(results.map((x) => x.step).sort(), ['post_merge_verify', 'verify']);
  const ev = phasesEvents(dir);
  for (const { step, r } of results) {
    const e = ev.find((x) => x.data.step === step);
    assert.deepEqual(r.phases_ms, e.data.phases_ms, step);
    assert.equal(r.total_ms, e.data.total_ms, step);
  }
});

// ------------------------------------------------------------------ AC-5
test('F81 AC-5: with verify_parallel 1 the later of two concurrent verifies records the wait as queue_ms', async () => {
  const dir = runFixture(['F1', 'F2']);
  const b = build();
  const calls = [];
  const fakeVerify = async (a) => {
    const c = { featureId: a.featureId, integration: isIntegration(a.cwd) };
    calls.push(c);
    // The first feature verify holds the only slot until the other feature's builder changes are
    // committed (bounded) — the run asks for that feature's verify right after the commit, so it
    // is then already waiting for the slot. Waiting only for the build to return would leave the
    // commit's git time out of the measured wait.
    if (!c.integration && calls.filter((x) => !x.integration).length === 1) {
      const other = a.featureId === 'F1' ? 'F2' : 'F1';
      const committed = () => execFileP('git', ['cat-file', '-e', `harness/${other}:${other}.txt`], { cwd: dir }).then(() => true, () => false);
      for (const t0 = Date.now(); !(await committed()) && Date.now() - t0 < 30_000;) await sleep(20);
      // The other feature asks for the slot some time after its commit (longer under load), so
      // hold well past SLOW: its wait must still reach 1500 ms.
      await sleep(SLOW * 2);
    }
    return PASSING;
  };
  await runFeatures({ root: dir, config: runCfg({ max_parallel: 2, verify_parallel: 1 }), deps: { build: b, verify: fakeVerify, evaluate, cpus: 8 } });
  const lines = metricsLines(dir);
  const verifies = lines.filter((l) => l.step === 'verify');
  assert.equal(verifies.length, 2, JSON.stringify(lines));
  for (const l of lines.filter((x) => x.step === 'verify' || x.step === 'post_merge_verify')) {
    assert.ok(Number.isInteger(l.queue_ms) && l.queue_ms >= 0, JSON.stringify(l));
  }
  const first = calls.find((x) => !x.integration).featureId;
  const later = verifies.find((l) => l.feature !== first);
  assert.ok(later.queue_ms >= 1500, JSON.stringify(verifies));
  const others = lines.filter((l) => l.step !== 'verify' && l.step !== 'post_merge_verify');
  assert.ok(others.some((l) => l.step === 'build') && others.some((l) => l.step === 'merge'), JSON.stringify(others));
  for (const l of others) assert.equal(l.queue_ms, null, JSON.stringify(l));
});

// ------------------------------------------------------------------ AC-6
const line = (o) => ({
  feature: 'F1', round: 1, step: 'verify', started_at: '2026-10-01T00:00:00.000Z', ended_at: '2026-10-01T00:00:05.000Z', duration_ms: 5000,
  queue_ms: null, cost_usd: null, role: 'core', adapter: null, model: null, served_model: null, effort: null, outcome: 'pass',
  turns: null, tokens: null, session_id: null, ...o,
});
function statsProject(rows) {
  const dir = fixture();
  const runs = path.join(dir, '.harness', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 'r1.metrics.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return dir;
}
test('F81 AC-6: harness stats shows the queue_ms total per step; lines without queue_ms count as 0', () => {
  const old = line({ step: 'verify' });
  delete old.queue_ms;
  const dir = statsProject([
    line({ queue_ms: 1500 }), line({ queue_ms: 1000 }), old,
    line({ step: 'post_merge_verify', queue_ms: 250 }),
    line({ step: 'build', role: 'builder', queue_ms: null }),
    (() => { const l = line({ step: 'merge' }); delete l.queue_ms; return l; })(),
  ]);
  const json = harness(['stats', '--json'], { cwd: dir });
  assert.equal(json.code, 0, json.stderr);
  const s = JSON.parse(json.stdout);
  assert.deepEqual(s.queue_ms, { build: 0, verify: 2500, merge: 0, post_merge_verify: 250 });
  const text = harness(['stats'], { cwd: dir });
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /steps:\n\s+step\s+count\s+median\s+p90\s+cost\s+avg cost\s+queue\n/);
  assert.match(text.stdout, /\n\s+verify\s+3\s+\S+\s+\S+\s+\$0\.00\s+\$0\.00\s+2\.5s\n/);
  assert.match(text.stdout, /\n\s+post_merge_verify\s+1\s+\S+\s+\S+\s+\$0\.00\s+\$0\.00\s+0\.3s\n/);
  assert.match(text.stdout, /\n\s+build\s+1\s+\S+\s+\S+\s+\$0\.00\s+\$0\.00\s+0\.0s\n/);
  assert.match(text.stdout, /\n\s+merge\s+1\s+\S+\s+\S+\s+\$0\.00\s+\$0\.00\s+0\.0s\n/);
});

// ------------------------------------------------------------------ AC-7
test('F81 AC-7: SPEC describes the phases event, metrics queue_ms and the stats queue_ms totals', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  for (const re of [/verify\/phases/, /`phases_ms`/, /`total_ms`/, /`test_count_source`/,
    ...PHASE_KEYS.map((k) => new RegExp(`\`${k}\``)), /`parsed`·`ran`·`cache`/,
    /`queue_ms`\(`verify`·`post_merge_verify` 줄은/, /verify 풀/, /단계별 `queue_ms` 합계/, /0 으로 집계/]) {
    assert.match(spec, re);
  }
});

// ------------------------------------------------------------------ SC-1
test('F81 SC-1: the phases event data holds numbers, the step name and source strings only', async () => {
  const token = 'F81SECRETVALUE';
  const dir = fixture([{ id: 'AC-1', criterion: 'ok', check: `node scripts/slow.mjs 1 ${token}`, new: false }], { [`${token}/x.txt`]: 'x\n' });
  process.env.F81_SC1_SECRET = token;
  try {
    await verify({ root: dir, featureId: 'F9', base: 'main', config: { ...cfg({ commands: [`node scripts/slow.mjs 1 ${token}`], test_count: `node scripts/slow.mjs 1 3` }), env_allowlist: ['F81_SC1_SECRET'] } });
  } finally {
    delete process.env.F81_SC1_SECRET;
  }
  const [e] = phasesEvents(dir);
  assert.deepEqual(Object.keys(e.data), DATA_KEYS);
  assert.equal(e.data.step, null);
  assert.equal(typeof e.data.total_ms, 'number');
  assert.deepEqual(Object.keys(e.data.phases_ms), PHASE_KEYS);
  assert.deepEqual([...(verifyLib.VERIFY_PHASES ?? [])], PHASE_KEYS);
  for (const v of Object.values(e.data.phases_ms)) assert.equal(typeof v, 'number');
  assert.deepEqual(Object.keys(e.data.test_count_source), ['head', 'base']);
  for (const v of Object.values(e.data.test_count_source)) assert.ok(SOURCES.has(v), v);
  const text = JSON.stringify(e.data);
  for (const bad of [token, 'node', 'scripts', dir, path.basename(dir)]) assert.ok(!text.includes(bad), bad);
});

// ------------------------------------------------------------------ ES-1
test('F81 ES-1: a verify that ends in a HarnessError leaves no phases event and keeps its code and message', async () => {
  const dir = fixture();
  await assert.rejects(verify({ root: dir, featureId: 'F9', base: 'nope', config: cfg() }), (e) => {
    assert.ok(e instanceof HarnessError);
    assert.equal(e.code, 'base_missing');
    assert.match(e.message, /^base ref 'nope' not found in .* — create it or pass --base <ref>$/);
    return true;
  });
  // An error after the verify commands have run: a test_count entry that does not exist
  // (config validation rejects it first, so it is set on the resolved config).
  const late = cfg({ commands: ['node scripts/ok.mjs'] });
  late.verify.test_count = 'from:commands[3]';
  await assert.rejects(verify({ root: dir, featureId: 'F9', base: 'main', config: late }), (e) => {
    assert.equal(e.code, 'config_invalid');
    assert.equal(e.message, "verify.test_count 'from:commands[3]' refers to a missing verify.commands entry");
    return true;
  });
  assert.deepEqual(phasesEvents(dir), []);
  const cli = harness(['verify', 'F9', '--base', 'nope'], { cwd: dir });
  assert.notEqual(cli.code, 0);
  assert.match(cli.stderr, /base ref 'nope' not found/);
  assert.deepEqual(phasesEvents(dir), []);
});
