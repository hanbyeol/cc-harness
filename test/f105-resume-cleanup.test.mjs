import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BIN, REPO, tmpdir } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { runFeatures } from '../lib/run.mjs';
import { descendantPids, killDescendants } from '../lib/exec.mjs';

const POSIX = process.platform !== 'win32'; // detached-process cleanup is POSIX only (out of scope on Windows)
const REPLY_PASS = path.join(REPO, 'test', 'fixtures', 'eval', 'pass.json');
const FAKE_CLI = path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs');

// ------------------------------------------------------------------ fixtures

const SCRIPTS = {
  'scripts/has.mjs': "import fs from 'node:fs';\nprocess.exit(process.argv.slice(2).every((f) => fs.existsSync(f)) ? 0 : 1);\n",
};

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id}.txt exists`, check: `node scripts/has.mjs ${id}.txt`, new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-10T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture(ids, config = {}) {
  const files = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...config },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: 'standard', depends_on: [], status: 'approved' })) },
    ...SCRIPTS,
  };
  for (const id of ids) files[`.harness/contracts/${id}.json`] = contract(id);
  return gitRepo(files, { branch: null });
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const statePath = (dir) => path.join(dir, '.harness/runs/current.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A bound that does not keep the test process alive once the race is decided.
const bound = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms).unref());
const until = async (fn, ms = 90000) => {
  for (let t = 0; t < ms && !fn(); t += 100) await sleep(100);
  return fn();
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid, ms = 30000) {
  for (let t = 0; t < ms && alive(pid); t += 100) await sleep(100);
  return !alive(pid);
}
const kill = (pid) => { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } };
const readPid = (file) => (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) || null : null);

// ------------------------------------------------------------------ resume (AC-1, AC-2)

const PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const fakeVerify = () => async () => PASSING;
const fakeEvaluate = () => async (a) => ({
  feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null,
});
const cfg = () => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 } });
const SIX = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'];

/** A saved run with all six features in flight in their round-1 build (interrupted by the signal). */
async function sixActive() {
  const dir = fixture(SIX);
  const controller = new AbortController();
  const calls = [];
  const build = async (a) => {
    calls.push({ featureId: a.featureId, round: a.round, attempt: a.attempt });
    if (calls.length === SIX.length) controller.abort();
    for (const t0 = Date.now(); !a.signal.aborted && Date.now() - t0 < 30_000;) await sleep(20);
    return { ok: true, costUsd: 0 };
  };
  const first = await runFeatures({
    root: dir, config: cfg(), parallel: SIX.length, signal: controller.signal,
    deps: { build, verify: fakeVerify(), evaluate: fakeEvaluate() },
  });
  assert.equal(first.interrupted, true);
  const saved = readJson(statePath(dir));
  assert.deepEqual(saved.active.map((e) => e.feature).sort(), SIX);
  return { dir, firstCalls: calls };
}

/** Counts concurrent builds; each build waits (bounded) for `peers` builds to run alongside it. */
function countingBuild(dir, { peers }) {
  let current = 0;
  const seen = { max: 0, calls: [], activeAtStart: [], maxParallelSaved: [] };
  const fn = async (a) => {
    current += 1;
    seen.max = Math.max(seen.max, current);
    seen.calls.push({ featureId: a.featureId, round: a.round, attempt: a.attempt });
    const s = readJson(statePath(dir));
    seen.activeAtStart.push(s.active.length);
    seen.maxParallelSaved.push(s.maxParallel);
    for (const t0 = Date.now(); current < peers && Date.now() - t0 < 2000;) await sleep(20);
    await sleep(100);
    writeFiles(a.cwd, { [`${a.featureId}.txt`]: 'built\n' });
    current -= 1;
    return { ok: true, costUsd: 0 };
  };
  fn.seen = seen;
  return fn;
}

const firstPerFeature = (calls) => Object.fromEntries(SIX.map((id) => {
  const c = calls.find((x) => x.featureId === id);
  return [id, c && [c.round, c.attempt]];
}));

test('F105 AC-1 --resume with 6 active features and a limit of 2 runs at most 2 builds at once and finishes all 6', { timeout: 240000 }, async () => {
  const { dir, firstCalls } = await sixActive();
  const saved = readJson(statePath(dir));
  saved.maxParallel = 2;
  fs.writeFileSync(statePath(dir), JSON.stringify(saved, null, 2));

  const build = countingBuild(dir, { peers: 2 });
  const r = await runFeatures({ root: dir, resume: true, deps: { build, verify: fakeVerify(), evaluate: fakeEvaluate() } });
  assert.equal(r.interrupted, false);
  assert.equal(build.seen.max, 2, 'at most 2 builds at once, and 2 did run together');
  assert.deepEqual(r.results.map((x) => [x.feature, x.status]).sort(), SIX.map((id) => [id, 'passed']));
  // The first two builds started while the other four still waited in state.active.
  assert.deepEqual(build.seen.activeAtStart.slice(0, 2), [6, 6]);
  // A waiting feature kept its round and attempt.
  assert.deepEqual(firstPerFeature(build.seen.calls), firstPerFeature(firstCalls));
  assert.ok(!fs.existsSync(statePath(dir)));
});

test('F105 AC-2 --resume --parallel 1 overrides the saved limit, saves it and runs one build at a time', { timeout: 240000 }, async () => {
  const { dir } = await sixActive();
  assert.equal(readJson(statePath(dir)).maxParallel, SIX.length);
  const build = countingBuild(dir, { peers: 1 });
  const r = await runFeatures({ root: dir, resume: true, parallel: 1, deps: { build, verify: fakeVerify(), evaluate: fakeEvaluate() } });
  assert.equal(r.interrupted, false);
  assert.equal(build.seen.max, 1);
  assert.deepEqual(build.seen.maxParallelSaved, SIX.map(() => 1), 'the state file holds the --parallel value');
  assert.deepEqual(r.results.map((x) => [x.feature, x.status]).sort(), SIX.map((id) => [id, 'passed']));
});

// ------------------------------------------------------------------ detached children (AC-3, AC-4, SC-1, ES-1)

// The fake builder. First call: starts a detached child (its own session: setsid) — `sleep 61`, or
// with 'gone' a process that exits at once — writes the child's pid to <pidFile> and sleeps 60 s.
// Later calls: read stdin and exit 0 without changes.
const DETACH = `import fs from 'node:fs';
import { spawn } from 'node:child_process';
const [pidFile, mode] = process.argv.slice(2);
const writePid = (pid) => { fs.writeFileSync(pidFile + '.tmp', String(pid)); fs.renameSync(pidFile + '.tmp', pidFile); };
if (fs.existsSync(pidFile)) {
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
} else if (mode === 'gone') {
  const c = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' });
  c.on('exit', () => writePid(c.pid));
  setTimeout(() => {}, 60000);
} else {
  const c = spawn('sleep', ['61'], { detached: true, stdio: 'ignore' });
  writePid(c.pid);
  setTimeout(() => {}, 60000);
}
`;

function detachFixture({ mode = 'sleep', config = {} } = {}) {
  const tools = tmpdir('harness-f105-');
  const script = path.join(tools, 'detach.mjs');
  fs.writeFileSync(script, DETACH);
  const pidFile = path.join(tools, 'child.pid');
  const dir = fixture(['F1'], {
    roles: { builder: 'generic', evaluator: 'generic', 'security-reviewer': 'generic' },
    adapters: { generic: { command: [process.execPath, script, pidFile, mode], read_only_command: [process.execPath, FAKE_CLI, 'print', REPLY_PASS] } },
    ...config,
  });
  return { dir, pidFile };
}

function spawnCli(args, cwd) {
  const child = spawn(process.execPath, [BIN, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited, out: () => out };
}

/** Starts `harness run`, waits for the detached child's pid, sends SIGINT and waits for the exit. */
async function interruptedRun(opts) {
  const x = detachFixture(opts);
  const cli = spawnCli(['run'], x.dir);
  let pid = null;
  try {
    await until(() => (pid = readPid(x.pidFile)));
    assert.ok(pid, `the fake builder never started its child: ${cli.out()}`);
    cli.child.kill('SIGINT');
    const exit = await Promise.race([cli.exited, bound(120000, { code: 'hung' })]);
    return { ...x, cli, pid, exit };
  } catch (e) {
    cli.child.kill('SIGKILL');
    kill(pid);
    throw e;
  }
}

test('F105 AC-3 SIGINT ends a detached (setsid) child of the builder before the run exits 130', { timeout: 240000 }, async () => {
  if (!POSIX) return;
  const x = await interruptedRun();
  try {
    assert.deepEqual({ code: x.exit.code, signal: x.exit.signal }, { code: 130, signal: null }, x.cli.out());
    assert.ok(await gone(x.pid), `detached child ${x.pid} survived the interrupt`);
  } finally {
    x.cli.child.kill('SIGKILL');
    kill(x.pid);
  }
});

test('F105 AC-4 a build step timeout ends the builder\'s detached child too', { timeout: 240000 }, async () => {
  if (!POSIX) return;
  const x = detachFixture({ config: { budget: { step_timeout_sec: 3 } } });
  const cli = spawnCli(['run'], x.dir);
  let pid = null;
  try {
    await until(() => (pid = readPid(x.pidFile)));
    assert.ok(pid, `the fake builder never started its child: ${cli.out()}`);
    const exit = await Promise.race([cli.exited, bound(150000, { code: 'hung' })]);
    assert.notEqual(exit.code, 'hung', cli.out());
    assert.match(cli.out(), /F1/);
    assert.ok(await gone(pid), `detached child ${pid} survived the step timeout`);
  } finally {
    cli.child.kill('SIGKILL');
    kill(pid);
  }
});

test('F105 SC-1 the interrupt leaves a same-user `sleep 61` started outside the run alive', { timeout: 240000 }, async () => {
  if (!POSIX) return;
  const outside = spawn('sleep', ['61'], { detached: true, stdio: 'ignore' });
  outside.unref();
  let x = null;
  try {
    x = await interruptedRun();
    assert.equal(x.exit.code, 130, x.cli.out());
    assert.ok(await gone(x.pid), `detached child ${x.pid} survived the interrupt`);
    assert.ok(alive(outside.pid), 'a process outside the run was killed');
  } finally {
    if (x) { x.cli.child.kill('SIGKILL'); kill(x.pid); }
    kill(outside.pid);
  }
});

test('F105 SC-1 descendantPids follows the tree from the root only', () => {
  const table = [[10, 1], [11, 10], [12, 11], [13, 1], [14, 13], [15, 12]];
  assert.deepEqual(descendantPids(10, table).sort(), [11, 12, 15]);
  assert.deepEqual(descendantPids(99, table), []);
});

test('F105 ES-1 a detached child that already ended: the interrupt still exits 130 with the state saved and no warning', { timeout: 240000 }, async () => {
  if (!POSIX) return;
  const x = await interruptedRun({ mode: 'gone' });
  try {
    assert.deepEqual({ code: x.exit.code, signal: x.exit.signal }, { code: 130, signal: null }, x.cli.out());
    assert.match(x.cli.out(), /harness run --resume/);
    assert.doesNotMatch(x.cli.out(), /ESRCH|EPERM|kill|ps:/i);
    const saved = readJson(statePath(x.dir));
    assert.deepEqual([saved.current.feature, saved.current.round, saved.current.stage], ['F1', 1, 'build']);
  } finally {
    x.cli.child.kill('SIGKILL');
    kill(x.pid);
  }
});

test('F105 ES-1 killDescendants skips an unreadable process table and processes it may not kill', () => {
  assert.deepEqual(killDescendants(10, { table: () => { throw new Error('ps: not found'); }, kill: () => assert.fail('nothing to kill') }), []);
  const killed = [];
  const pids = killDescendants(10, {
    table: () => [[11, 10], [12, 10]],
    kill: (pid) => {
      if (pid === 11) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      killed.push(pid);
    },
  });
  assert.deepEqual(pids, [11, 12]);
  assert.deepEqual(killed, [12]);
});

// ------------------------------------------------------------------ AC-5

test('F105 AC-5 SPEC §8 describes the resume limit and the detached-process cleanup', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s8 = spec.slice(spec.indexOf('## 8.'), spec.indexOf('## 9.'));
  assert.match(s8, /--resume.{0,200}병렬 한도만큼만 다시 시작/s);
  assert.match(s8, /기다리는 기능은 `active` 에 남아.{0,200}같은 라운드·같은 시도/s);
  assert.match(s8, /--resume --parallel N.{0,200}상태 파일의 `maxParallel`/s);
  assert.match(s8, /분리된 하위 프로세스.{0,300}(detached|setsid)/s);
  assert.match(s8, /단계 시간 초과/);
});
