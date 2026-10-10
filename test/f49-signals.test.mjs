import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { BIN, FAKE_INHIBIT_LOG, REPO, fakeInhibitorDirs, tmpdir } from './helpers.mjs';
import { gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { runFeatures, builderPrompt } from '../lib/run.mjs';
import { createGenericAdapter } from '../lib/adapters/generic.mjs';

const FAKE_CLI = path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs');
const REPLY_PASS = path.join(REPO, 'test', 'fixtures', 'eval', 'pass.json');
const POSIX = process.platform !== 'win32'; // no POSIX signal delivery to a child on Windows
// The env for the inhibitor test: the real inhibitor path, not the one test/helpers.mjs turns off (F77).
const { HARNESS_TEST_NO_SLEEP_INHIBITOR: _off, ...INHIBITOR_ENV } = process.env;

// ------------------------------------------------------------------ fixtures

const SCRIPTS = {
  'scripts/has.mjs': "import fs from 'node:fs';\nprocess.exit(process.argv.slice(2).every((f) => fs.existsSync(f)) ? 0 : 1);\n",
  // A verify command that writes its pid (argv[2]) and sleeps 30 s: long enough to be
  // interrupted, short enough not to hang a run of this test against the pre-feature code.
  'scripts/slow.mjs': "import fs from 'node:fs';\nfs.writeFileSync(process.argv[2], String(process.pid));\nsetTimeout(() => {}, 30000);\n",
};

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id}.txt exists`, check: `node scripts/has.mjs ${id}.txt`, new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-27T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture(config = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...config },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract('F1'),
    ...SCRIPTS,
  }, { branch: null });
}

// A run whose builder sleeps on its first call (writing its pid to `pidFile`) and writes F1.txt
// on any later call; the evaluator roles reply with a passing verdict.
function runFixture(pidFile) {
  return fixture({
    roles: { builder: 'generic', evaluator: 'generic', 'security-reviewer': 'generic' },
    adapters: { generic: { command: [process.execPath, FAKE_CLI, 'build-once', pidFile, 'F1.txt'], read_only_command: [process.execPath, FAKE_CLI, 'print', REPLY_PASS] } },
  });
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const statusOf = (dir) => readJson(path.join(dir, '.harness/features.json')).features.find((f) => f.id === 'F1').status;
const statePath = (dir) => path.join(dir, '.harness/runs/current.json');

function spawnCli(args, cwd, env = process.env) {
  const child = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited, out: () => out };
}

const until = async (fn, ms = 90000) => {
  for (let t = 0; t < ms && !fn(); t += 100) await new Promise((r) => setTimeout(r, 100));
  return fn();
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid, ms = 30000) {
  for (let t = 0; t < ms && alive(pid); t += 100) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}
const readPid = (file) => (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) || null : null);
const kill = (pid) => { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } };

/**
 * Fake `caffeinate` and `systemd-inhibit` first on PATH (fakeInhibitorDirs) that log their pid
 * in this call's own log directory and stay alive: the sleep inhibitor a run starts on darwin
 * and linux.
 */
function fakeInhibitors() {
  const logs = tmpdir('harness-f49-inhibit-log-');
  const dirs = fakeInhibitorDirs();
  // Each log is name, pid, parent pid and arguments, one per line.
  const pids = () => fs.readdirSync(logs).filter((n) => n.endsWith('.txt')).map((n) => Number(fs.readFileSync(path.join(logs, n), 'utf8').split('\n')[1]));
  return { pids, env: { ...INHIBITOR_ENV, [FAKE_INHIBIT_LOG]: logs, PATH: [...dirs, process.env.PATH].join(path.delimiter) } };
}

/** Starts `harness run` and waits for the slow builder; `stop()` sends `sig` and waits for the exit. */
async function interruptRun(sig, { env } = {}) {
  const pidFile = path.join(tmpdir('harness-pid-'), 'builder.pid');
  const dir = runFixture(pidFile);
  const cli = spawnCli(['run'], dir, env);
  let builderPid = null;
  try {
    await until(() => (builderPid = readPid(pidFile)));
    assert.ok(builderPid, `slow builder never started: ${cli.out()}`);
    return { dir, cli, builderPid, pidFile, stop: () => { cli.child.kill(sig); return cli.exited; } };
  } catch (e) {
    cli.child.kill('SIGKILL');
    kill(builderPid);
    throw e;
  }
}

// ------------------------------------------------------------------ AC-1
for (const sig of ['SIGTERM', 'SIGHUP']) {
  test(`F49 AC-1 run: ${sig} stops the builder's process tree, saves state and exits 130`, { timeout: 180000 }, async () => {
    if (!POSIX) return;
    const x = await interruptRun(sig);
    try {
      const { code, signal } = await x.stop();
      assert.deepEqual({ code, signal }, { code: 130, signal: null }, x.cli.out());
      assert.match(x.cli.out(), /harness run --resume/);
      assert.ok(await gone(x.builderPid), `builder ${x.builderPid} survived ${sig}`);
      const saved = readJson(statePath(x.dir));
      assert.deepEqual([saved.current.feature, saved.current.round, saved.current.stage], ['F1', 1, 'build']);
      assert.equal(statusOf(x.dir), 'in_progress');
    } finally {
      x.cli.child.kill('SIGKILL');
      kill(x.builderPid);
    }
  });

  test(`F49 AC-1 verify: ${sig} stops the running command and exits 130`, { timeout: 180000 }, async () => {
    if (!POSIX) return;
    const pidFile = path.join(tmpdir('harness-pid-'), 'verify.pid');
    const dir = fixture({ verify: { commands: [`node scripts/slow.mjs ${JSON.stringify(pidFile)}`] } });
    const cli = spawnCli(['verify', 'F1'], dir);
    let pid = null;
    try {
      await until(() => (pid = readPid(pidFile)));
      assert.ok(pid, `verify command never started: ${cli.out()}`);
      cli.child.kill(sig);
      const { code, signal } = await cli.exited;
      assert.deepEqual({ code, signal }, { code: 130, signal: null }, cli.out());
      assert.match(cli.out(), /verify interrupted/);
      assert.ok(await gone(pid), `verify command ${pid} survived ${sig}`);
    } finally {
      cli.child.kill('SIGKILL');
      kill(pid);
    }
  });
}

// ------------------------------------------------------------------ SC-1
test('F49 SC-1 a run ended by SIGTERM leaves neither the sleep inhibitor nor the builder behind', { timeout: 180000 }, async () => {
  if (!['darwin', 'linux'].includes(process.platform)) return; // the platforms with an inhibitor
  const fk = fakeInhibitors();
  const x = await interruptRun('SIGTERM', { env: fk.env });
  try {
    await until(() => fk.pids().length > 0, 60000);
    const inhibitors = fk.pids();
    assert.equal(inhibitors.length, 1, `the run started an inhibitor: ${x.cli.out()}`);
    assert.ok(alive(inhibitors[0]), 'the inhibitor runs while the builder does');
    assert.ok(alive(x.builderPid), 'the builder runs until the signal');
    const { code } = await x.stop();
    assert.equal(code, 130, x.cli.out());
    assert.ok(await gone(inhibitors[0]), `inhibitor ${inhibitors[0]} survived SIGTERM`);
    assert.ok(await gone(x.builderPid), `builder ${x.builderPid} survived SIGTERM`);
  } finally {
    x.cli.child.kill('SIGKILL');
    kill(x.builderPid);
    for (const pid of fk.pids()) kill(pid);
  }
});

// ------------------------------------------------------------------ ES-1
for (const sig of ['SIGTERM', 'SIGHUP']) {
  test(`F49 ES-1 --resume continues a run saved on ${sig} and the feature passes`, { timeout: 240000 }, async () => {
    if (!POSIX) return;
    const x = await interruptRun(sig);
    try {
      const { code } = await x.stop();
      assert.equal(code, 130, x.cli.out());
      assert.ok(fs.existsSync(statePath(x.dir)), 'state saved');
    } finally {
      x.cli.child.kill('SIGKILL');
      kill(x.builderPid);
    }
    const r = spawnSync(process.execPath, [BIN, 'run', '--resume'], { cwd: x.dir, encoding: 'utf8', timeout: 180000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /F1\s+passed/);
    assert.equal(statusOf(x.dir), 'passed');
    assert.ok(!fs.existsSync(statePath(x.dir)), 'the finished run removed its state file');
  });
}

// ------------------------------------------------------------------ AC-2
const SECRET = 'F49sEcReT-7d1c9a0b2e4f6a8c0e2d4b6f8a1c3e5d';
// Every piece of SECRET of 8 or more characters that `text` still holds.
const pieces = (text) => {
  const found = [];
  for (let i = 0; i + 8 <= SECRET.length; i += 1) if (text.includes(SECRET.slice(i, i + 8))) found.push(SECRET.slice(i, i + 8));
  return found;
};
// Adapter stderr in which the last-2000-characters cut falls 20 characters into SECRET.
const STDERR = `${'x'.repeat(100)}${SECRET}${'y'.repeat(2000 - (SECRET.length - 20))}`;

function withSecret(fn) {
  return async () => {
    const before = process.env.F49_SECRET_TOKEN;
    process.env.F49_SECRET_TOKEN = SECRET;
    try { await fn(); } finally {
      if (before === undefined) delete process.env.F49_SECRET_TOKEN; else process.env.F49_SECRET_TOKEN = before;
    }
  };
}

function stderrAdapter() {
  const file = path.join(tmpdir('harness-f49-'), 'stderr.txt');
  fs.writeFileSync(file, STDERR);
  return createGenericAdapter({ adapters: { generic: { command: [process.execPath, FAKE_CLI, 'stderr', file, '1'] } } });
}

test('F49 AC-2 the fixture puts the 2000-character cut inside the secret', () => {
  assert.equal(STDERR.slice(-2000).startsWith(SECRET.slice(20)), true);
  assert.ok(SECRET.slice(20).length >= 8);
});

test('F49 AC-2 an adapter error detail is redacted before it is cut', withSecret(async () => {
  const r = await stderrAdapter().run({ role: 'builder', prompt: 'p', cwd: REPO, timeoutSec: 60 });
  assert.equal(r.error, 'exit_nonzero');
  assert.ok(r.detail.length > 0);
  assert.deepEqual(pieces(r.detail), [], r.detail.slice(0, 80));
}));

test('F49 AC-2 blocked detail, report and state file hold no piece of the secret from an adapter error', withSecret(async () => {
  const dir = fixture();
  const isIntegration = (cwd) => fs.realpathSync.native(cwd).endsWith(`${path.sep}_integration`);
  const OK = { markers: [], harnessPaths: [], testCount: { status: 'unset' } };
  const PASSING = { pass: true, commands: [], criteria: [{ id: 'AC-1', pass: true }], integrity: OK, warnings: [] };
  const FAILING = { pass: false, commands: [{ cmd: 'npm test', pass: false, message: 'exit 1', output: 'boom' }], criteria: [], integrity: OK, warnings: [] };
  const adapter = stderrAdapter();
  // The first build succeeds; the post-merge recovery build is the real adapter failing.
  const build = async (a) => {
    if (a.postMergeFailures) return adapter.run({ role: 'builder', prompt: 'p', cwd: a.cwd, timeoutSec: 60, signal: a.signal });
    writeFiles(a.cwd, { 'F1.txt': 'built\n' });
    return { ok: true, costUsd: 0 };
  };
  const writes = [];
  const writeJsonAtomic = (file, data) => {
    writes.push(JSON.stringify(data));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  };
  const r = await runFeatures({
    root: dir,
    config: resolveConfig({ base_branch: 'main', run: { max_parallel: 1 }, verify: { commands: [] }, budget: { step_timeout_sec: 60 } }),
    deps: {
      build, writeJsonAtomic, cpus: 8,
      verify: async (a) => (isIntegration(a.cwd) ? FAILING : PASSING),
      evaluate: async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null }),
    },
  });
  const f1 = r.results.find((x) => x.feature === 'F1');
  assert.equal(f1.status, 'blocked', JSON.stringify(f1));
  assert.match(f1.detail, /builder exit_nonzero/);
  assert.deepEqual(pieces(f1.detail), [], 'blocked detail');
  assert.deepEqual(pieces(fs.readFileSync(r.report, 'utf8')), [], 'run report');
  assert.ok(writes.length > 0);
  assert.deepEqual(pieces(writes.join('\n')), [], 'state file writes');
  const backlog = fs.readFileSync(path.join(dir, '.harness/backlog.json'), 'utf8');
  assert.deepEqual(pieces(backlog), [], 'backlog');
}));

// ------------------------------------------------------------------ AC-3
const prompt = (extra) => builderPrompt({ rolePrompt: 'ROLE', featureId: 'F1', round: 1, attempt: 2, contract: { id: 'F1' }, config: {}, ...extra });
const listed = (text) => text.split('\n').filter((l) => l.startsWith('- f'));

for (const kind of ['continuation', 'carriedWork']) {
  test(`F49 AC-3 ${kind}: at most 100 changed files are listed, then '… N more'`, () => {
    const files = Array.from({ length: 150 }, (_, i) => `f${String(i).padStart(3, '0')}.txt`);
    const text = prompt({ [kind]: { files } });
    assert.deepEqual(listed(text), files.slice(0, 100).map((f) => `- ${f}`));
    assert.match(text, /^… 50 more$/m);
  });

  test(`F49 AC-3 ${kind}: exactly 100 files are all listed with no '… more' line`, () => {
    const files = Array.from({ length: 100 }, (_, i) => `f${i}.txt`);
    const text = prompt({ [kind]: { files } });
    assert.equal(listed(text).length, 100);
    assert.doesNotMatch(text, /… \d+ more/);
  });

  test(`F49 AC-3 ${kind}: a path with a control character is quoted as a JSON string`, () => {
    const odd = ['fnew\nline.txt', 'fcr\rhere.txt', 'ftab\there.txt', 'fesc\u001b[31m.txt', 'fdel\u007f.txt', 'fc1\u0085.txt', 'fls\u2028.txt'];
    const text = prompt({ [kind]: { files: ['fplain.txt', ...odd] } });
    assert.ok(text.includes('\n- fplain.txt\n'), 'a plain path stays as it is');
    const quoted = text.split('\n').filter((l) => l.startsWith('- "')).map((l) => JSON.parse(l.slice(2)));
    assert.deepEqual(quoted, odd, 'each path with a control character is one JSON string line');
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/, 'no raw control character in the prompt');
    for (const f of odd) assert.ok(!text.includes(f), `${JSON.stringify(f)} does not appear raw`);
  });
}
