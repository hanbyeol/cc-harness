import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BIN, REPO, tmpdir } from './helpers.mjs';
import { gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { runFeatures } from '../lib/run.mjs';

const FAKE_CLI = path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs');
const POSIX = process.platform !== 'win32'; // the fake inhibitors are shebang scripts

// ------------------------------------------------------------------ fixtures

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-26T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture(ids = ['F1'], { integration = 'harness/integration' } = {}) {
  const files = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', integration_branch: integration, verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: 'standard', depends_on: [], status: 'approved' })) },
    'scripts/ok.mjs': 'process.exit(0);\n',
  };
  for (const id of ids) files[`.harness/contracts/${id}.json`] = contract(id);
  return gitRepo(files, { branch: null });
}

const cfg = (over = {}) => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, ...over });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const statusOf = (dir, id = 'F1') => readJson(path.join(dir, '.harness/features.json')).features.find((f) => f.id === id).status;
const statePath = (dir) => path.join(dir, '.harness/runs/current.json');
const backlog = (dir) => readJson(path.join(dir, '.harness/backlog.json')).items;

const PASSING = { pass: true, commands: [], criteria: [{ id: 'AC-1', pass: true }], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const TIMED_OUT_VERIFY = { ...PASSING, pass: false, commands: [{ cmd: 'npm test', pass: false, timedOut: true, message: 'timed out — process tree killed' }] };
const evalResult = (a, over = {}) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null, ...over });

function fakeBuild(onCall) {
  const calls = [];
  const fn = async (a) => {
    calls.push({ featureId: a.featureId, round: a.round, attempt: a.attempt });
    const r = onCall ? await onCall(a, calls) : null;
    if (r) return r;
    writeFiles(a.cwd, { [`${a.featureId}.txt`]: `built r${a.round}\n` });
    return { ok: true, costUsd: 0 };
  };
  fn.calls = calls;
  return fn;
}

// Wall clock that a test can push forward while the monotonic clock keeps real time:
// the difference is what a system sleep looks like.
function clocks() {
  const c = { offset: 0 };
  c.now = () => new Date(Date.now() + c.offset);
  c.monotonic = () => performance.now();
  c.sleep = (sec) => { c.offset += sec * 1000; };
  return c;
}

/**
 * A directory with fake `caffeinate` and `systemd-inhibit` (sh scripts: they start as fast as
 * the real ones). Each records its name, pid, parent pid and arguments, then stays alive
 * ('stay', exec keeps the pid) or exits at once ('exit').
 */
function fakeInhibitors(mode = 'stay') {
  const dir = tmpdir('harness-inhibit-');
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs);
  for (const name of ['caffeinate', 'systemd-inhibit']) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh
printf '%s\\n' "${name}" "$$" "$PPID" "$@" > "${logs}/$$.tmp" && mv "${logs}/$$.tmp" "${logs}/$$.txt"
${mode === 'exit' ? 'exit 1' : 'exec sleep 1000'}
`);
    fs.chmodSync(file, 0o755);
  }
  const entries = () => fs.readdirSync(logs).filter((n) => n.endsWith('.txt')).map((n) => {
    const [name, pid, ppid, ...argv] = fs.readFileSync(path.join(logs, n), 'utf8').replace(/\n$/, '').split('\n');
    return { name, pid: Number(pid), ppid: Number(ppid), argv };
  });
  return { dir, entries, env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` } };
}

const until = async (fn, ms = 10000) => {
  for (let t = 0; t < ms && !fn(); t += 50) await new Promise((r) => setTimeout(r, 50));
  return fn();
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid, ms = 5000) {
  for (let t = 0; t < ms && alive(pid); t += 100) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}

function run(dir, deps, opts = {}) {
  const logs = [];
  const p = runFeatures({
    root: dir, config: cfg(opts.config),
    deps: { verify: async () => PASSING, evaluate: async (a) => evalResult(a), log: (m) => logs.push(m), ...deps },
    ...opts.run,
  });
  return p.then((r) => ({ ...r, logs, out: logs.join('\n') }));
}

// ------------------------------------------------------------------ AC-1
test('F21 AC-1 darwin: caffeinate -i -w <run pid> runs before the first feature and is gone after the run', async () => {
  if (!POSIX) return; // the fake inhibitors are shebang scripts
  const dir = fixture();
  const fk = fakeInhibitors();
  let seenAtBuild = null;
  const build = fakeBuild(async () => {
    await until(() => fk.entries().length > 0); // exec of a fresh script can be slow
    seenAtBuild = fk.entries().map((x) => ({ ...x, alive: alive(x.pid) }));
    return null;
  });
  const r = await run(dir, { build, platform: 'darwin', env: fk.env });
  assert.equal(r.results[0].status, 'passed', r.out);
  assert.equal(seenAtBuild.length, 1, 'caffeinate started before the first build');
  assert.equal(seenAtBuild[0].name, 'caffeinate');
  assert.deepEqual(seenAtBuild[0].argv, ['-i', '-w', String(process.pid)]);
  assert.ok(seenAtBuild[0].alive, 'caffeinate alive during the build');
  assert.ok(await gone(seenAtBuild[0].pid), 'caffeinate still running after the run');
  assert.match(fs.readFileSync(r.report, 'utf8'), /sleep inhibitor: caffeinate -i -w/);
});

// ------------------------------------------------------------------ AC-2
test('F21 AC-2 linux: systemd-inhibit --what=idle:sleep --mode=block is held during the run and ended after it', async () => {
  if (!POSIX) return; // the fake inhibitors are shebang scripts
  const dir = fixture();
  const fk = fakeInhibitors();
  let seenAtBuild = null;
  const build = fakeBuild(async () => {
    await until(() => fk.entries().length > 0); // exec of a fresh script can be slow
    seenAtBuild = fk.entries().map((x) => ({ ...x, alive: alive(x.pid) }));
    return null;
  });
  const r = await run(dir, { build, platform: 'linux', env: fk.env });
  assert.equal(r.results[0].status, 'passed', r.out);
  assert.equal(seenAtBuild.length, 1);
  assert.equal(seenAtBuild[0].name, 'systemd-inhibit');
  assert.ok(seenAtBuild[0].argv.includes('--what=idle:sleep'), JSON.stringify(seenAtBuild[0].argv));
  assert.ok(seenAtBuild[0].argv.includes('--mode=block'), JSON.stringify(seenAtBuild[0].argv));
  assert.ok(seenAtBuild[0].alive, 'systemd-inhibit alive during the build');
  assert.ok(await gone(seenAtBuild[0].pid), 'systemd-inhibit still running after the run');
});

// ------------------------------------------------------------------ AC-3
test('F21 AC-3 inhibitor not on PATH: the run goes on and says "sleep inhibitor unavailable" in output and report', async () => {
  const dir = fixture();
  const empty = tmpdir('harness-empty-path-');
  const build = fakeBuild();
  const r = await run(dir, { build, platform: 'darwin', env: { ...process.env, PATH: empty } });
  assert.equal(r.results[0].status, 'passed', r.out);
  assert.equal(build.calls.length, 1);
  assert.match(r.out, /sleep inhibitor unavailable/);
  assert.match(fs.readFileSync(r.report, 'utf8'), /sleep inhibitor unavailable/);
});

test('F21 AC-3 inhibitor exits right after start: the run goes on and says "sleep inhibitor unavailable" in output and report', async () => {
  if (!POSIX) return; // the fake inhibitors are shebang scripts
  const dir = fixture();
  const fk = fakeInhibitors('exit');
  const logs = [];
  // however long its exit takes, the run notices it: wait for that inside the build
  const build = fakeBuild(async () => { await until(() => logs.some((m) => /sleep inhibitor unavailable/.test(m))); return null; });
  const r = await run(dir, { build, platform: 'darwin', env: fk.env, log: (m) => logs.push(m) });
  r.out = logs.join('\n');
  assert.equal(fk.entries().length, 1, 'the inhibitor was started');
  assert.equal(r.results[0].status, 'passed', r.out);
  assert.match(r.out, /sleep inhibitor unavailable/);
  assert.match(fs.readFileSync(r.report, 'utf8'), /sleep inhibitor unavailable/);
});

// ------------------------------------------------------------------ AC-4
function assertSleepStop(dir, r, stage) {
  assert.equal(r.interrupted, true, JSON.stringify(r.results));
  assert.deepEqual([r.sleep?.feature, r.sleep?.stage], ['F1', stage]);
  assert.deepEqual(r.results, [], 'no feature result: nothing was blocked');
  assert.match(r.out, /system sleep/);
  assert.match(r.out, /harness run --resume/);
  assert.equal(statusOf(dir), 'in_progress', 'status unchanged by the stop');
  assert.deepEqual(backlog(dir), [], 'no re-scope proposal');
  const saved = readJson(statePath(dir));
  assert.equal(saved.current.feature, 'F1');
  assert.equal(saved.current.round, 1);
  return saved;
}

test('F21 AC-4 build timeout after system sleep: run stops for --resume, not blocked(budget), attempt not consumed', async () => {
  const dir = fixture();
  const c = clocks();
  const build = fakeBuild(() => { c.sleep(120); return { ok: false, error: 'timeout', costUsd: null }; });
  const r = await run(dir, { build, now: c.now, monotonic: c.monotonic });
  const saved = assertSleepStop(dir, r, 'build');
  assert.equal(saved.current.stage, 'build');
  assert.equal(saved.current.attemptsDone ?? 0, 0, 'the build attempt was not used up');
});

test('F21 AC-4 verify timeout after system sleep: run stops for --resume, the attempt is not consumed', async () => {
  const dir = fixture();
  const c = clocks();
  const verify = async () => { c.sleep(120); return TIMED_OUT_VERIFY; };
  const r = await run(dir, { build: fakeBuild(), verify, now: c.now, monotonic: c.monotonic });
  const saved = assertSleepStop(dir, r, 'verify');
  assert.equal(saved.current.attemptsDone ?? 0, 0);
});

test('F21 AC-4 eval timeout after system sleep: run stops for --resume, no eval_error counted', async () => {
  const dir = fixture();
  const c = clocks();
  const evaluate = async (a) => { c.sleep(120); return evalResult(a, { verdict: 'eval_error', error: 'timeout' }); };
  const r = await run(dir, { build: fakeBuild(), evaluate, now: c.now, monotonic: c.monotonic });
  const saved = assertSleepStop(dir, r, 'eval');
  assert.equal(saved.current.stage, 'eval');
  assert.equal(saved.current.evalErrors, 0);
});

test('F21 AC-4 the CLI prints "system sleep" and the --resume hint', { timeout: 60000 }, async () => {
  const { default: runCmd } = await import('../lib/commands/run.mjs');
  const src = fs.readFileSync(path.join(REPO, 'lib', 'commands', 'run.mjs'), 'utf8');
  assert.ok(runCmd && /r\.sleep/.test(src) && /system sleep/.test(src) && /harness run --resume/.test(src));
});

// ------------------------------------------------------------------ AC-5
test('F21 AC-5 resume after a build cut off by sleep redoes the same round and attempt; a good build passes', async () => {
  const dir = fixture();
  const c = clocks();
  const build1 = fakeBuild(() => { c.sleep(120); return { ok: false, error: 'timeout', costUsd: null }; });
  const r1 = await run(dir, { build: build1, now: c.now, monotonic: c.monotonic });
  assert.equal(r1.sleep?.stage, 'build');
  const build2 = fakeBuild();
  const r2 = await run(dir, { build: build2 }, { run: { resume: true } });
  assert.equal(r2.results[0].status, 'passed', r2.out);
  assert.equal(statusOf(dir), 'passed');
  assert.deepEqual(build2.calls.map((x) => [x.round, x.attempt]), [[1, 1]]);
  assert.equal(r2.results[0].rounds, 1);
});

test('F21 AC-5 resume after a verify cut off by sleep redoes verify in the same round without rebuilding', async () => {
  const dir = fixture();
  const c = clocks();
  const build1 = fakeBuild();
  const r1 = await run(dir, { build: build1, verify: async () => { c.sleep(120); return TIMED_OUT_VERIFY; }, now: c.now, monotonic: c.monotonic });
  assert.equal(r1.sleep?.stage, 'verify');
  const build2 = fakeBuild();
  let verifies = 0;
  const r2 = await run(dir, { build: build2, verify: async () => { verifies += 1; return PASSING; } }, { run: { resume: true } });
  assert.equal(r2.results[0].status, 'passed', r2.out);
  assert.equal(build2.calls.length, 0, 'the finished build is not redone');
  assert.ok(verifies >= 1);
  assert.equal(r2.results[0].rounds, 1);
});

test('F21 AC-5 resume after an eval cut off by sleep re-evaluates the same round and passes', async () => {
  const dir = fixture();
  const c = clocks();
  const r1 = await run(dir, {
    build: fakeBuild(), now: c.now, monotonic: c.monotonic,
    evaluate: async (a) => { c.sleep(120); return evalResult(a, { verdict: 'eval_error', error: 'timeout' }); },
  });
  assert.equal(r1.sleep?.stage, 'eval');
  const rounds = [];
  const build2 = fakeBuild();
  const r2 = await run(dir, { build: build2, evaluate: async (a) => { rounds.push(a.round); return evalResult(a); } }, { run: { resume: true } });
  assert.equal(r2.results[0].status, 'passed', r2.out);
  assert.deepEqual(rounds, [1]);
  assert.equal(build2.calls.length, 0);
});

// ------------------------------------------------------------------ AC-6
test('F21 AC-6 a build timeout without sleep is blocked(budget) as before', async () => {
  const dir = fixture();
  const c = clocks();
  const build = fakeBuild(() => ({ ok: false, error: 'timeout', costUsd: null }));
  const r = await run(dir, { build, now: c.now, monotonic: c.monotonic });
  assert.equal(r.interrupted, false);
  assert.deepEqual([r.results[0].status, r.results[0].reason], ['blocked', 'budget']);
  assert.equal(statusOf(dir), 'blocked');
  assert.equal(build.calls.length, 1);
});

test('F21 AC-6 a build timeout with less than 60s of sleep is blocked(budget)', async () => {
  const dir = fixture();
  const c = clocks();
  const build = fakeBuild(() => { c.sleep(30); return { ok: false, error: 'timeout', costUsd: null }; });
  const r = await run(dir, { build, now: c.now, monotonic: c.monotonic });
  assert.deepEqual([r.results[0].status, r.results[0].reason], ['blocked', 'budget']);
});

test('F21 AC-6 sleep without a timeout changes nothing: the feature passes', async () => {
  const dir = fixture();
  const c = clocks();
  const build = fakeBuild(() => { c.sleep(600); return null; });
  const r = await run(dir, { build, now: c.now, monotonic: c.monotonic });
  assert.equal(r.results[0].status, 'passed', r.out);
});

// ------------------------------------------------------------------ AC-7
test('F21 AC-7 SPEC §8 describes the sleep inhibitor (darwin, linux) and the stop/resume rule for steps cut off by sleep', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s = spec.slice(spec.indexOf('## 8.'), spec.indexOf('## 9.'));
  const line = s.split('\n').find((l) => l.includes('잠자기 방지'));
  assert.ok(line, 'no sleep-inhibitor paragraph in §8');
  for (const w of ['caffeinate -i -w', 'systemd-inhibit', 'darwin', 'linux', 'sleep inhibitor unavailable']) assert.ok(line.includes(w), w);
  const stop = s.split('\n').find((l) => l.includes('잠자기로 끊긴 단계'));
  assert.ok(stop, 'no rule for a step cut off by sleep');
  for (const w of ['60초', 'timeout', 'budget', 'harness run --resume', '시도']) assert.ok(stop.includes(w), w);
});

// ------------------------------------------------------------------ SC-1
test('F21 SC-1 SIGINT during a run leaves no sleep inhibitor behind', { timeout: 60000 }, async () => {
  if (!['darwin', 'linux'].includes(process.platform)) return; // no POSIX signal delivery to a child on Windows
  const dir = fixture();
  const fk = fakeInhibitors();
  const pidFile = path.join(tmpdir('harness-pid-'), 'builder.pid');
  writeFiles(dir, {
    '.harness/config.json': {
      profile: 'sdlc', base_branch: 'main', verify: { commands: [] },
      roles: { builder: 'generic', evaluator: 'generic', 'security-reviewer': 'generic' },
      adapters: { generic: { command: [process.execPath, FAKE_CLI, 'sleep', pidFile], read_only_command: [process.execPath, FAKE_CLI, 'echo-args'] } },
    },
  });
  commitAll(dir, 'slow builder config');
  const child = spawn(process.execPath, [BIN, 'run'], { cwd: dir, env: fk.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  let builderPid = null;
  try {
    for (let i = 0; i < 300 && !builderPid; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      if (fs.existsSync(pidFile)) builderPid = Number(fs.readFileSync(pidFile, 'utf8')) || null;
    }
    assert.ok(builderPid, `slow builder never started: ${out}`);
    await until(() => fk.entries().length > 0);
    const inhibitors = fk.entries();
    assert.equal(inhibitors.length, 1, 'the run started an inhibitor');
    assert.ok(alive(inhibitors[0].pid));
    child.kill('SIGINT');
    assert.equal(await exited, 130, out);
    assert.ok(await gone(inhibitors[0].pid), `inhibitor ${inhibitors[0].pid} survived the interrupted run`);
  } finally {
    child.kill('SIGKILL');
    if (builderPid) { try { process.kill(builderPid, 'SIGKILL'); } catch { /* gone */ } }
    for (const x of fk.entries()) { try { process.kill(x.pid, 'SIGKILL'); } catch { /* gone */ } }
  }
});

// ------------------------------------------------------------------ SC-2
test('F21 SC-2 the inhibitor is the fixed name with fixed arguments, no shell, no config values or feature ids', async () => {
  if (!POSIX) return; // the fake inhibitors are shebang scripts
  for (const platform of ['darwin', 'linux']) {
    const dir = fixture(['F7'], { integration: 'zzmarker-integ' });
    const fk = fakeInhibitors();
    const r = await run(dir, { build: fakeBuild(), platform, env: fk.env }, {
      config: { integration_branch: 'zzmarker-integ', protected_branches: ['zzmarker-prot'], env_allowlist: ['ZZMARKER_ENV'] },
    });
    assert.equal(r.results[0].status, 'passed', r.out);
    const [x, ...more] = fk.entries();
    assert.equal(more.length, 0);
    assert.equal(x.name, platform === 'darwin' ? 'caffeinate' : 'systemd-inhibit');
    assert.equal(x.ppid, process.pid, 'started directly by the run, not through a shell');
    const argv = JSON.stringify(x.argv);
    for (const bad of ['zzmarker', 'F7', dir]) assert.ok(!argv.includes(bad), `${bad} in ${argv}`);
    if (platform === 'darwin') assert.deepEqual(x.argv, ['-i', '-w', String(process.pid)]);
    else {
      assert.deepEqual(x.argv.slice(0, 4), ['--what=idle:sleep', '--mode=block', '--who=cc-harness', '--why=harness run in progress']);
      assert.equal(x.argv[x.argv.length - 1], String(process.pid));
    }
  }
  const src = fs.readFileSync(path.join(REPO, 'lib', 'sleep.mjs'), 'utf8');
  assert.match(src, /shell: false/);
});

// ------------------------------------------------------------------ ES-1
test('F21 ES-1 win32: no inhibitor is tried, the report says "sleep inhibitor unavailable" and the run goes on', async () => {
  const dir = fixture();
  const fk = fakeInhibitors();
  const r = await run(dir, { build: fakeBuild(), platform: 'win32', env: fk.env });
  assert.equal(r.results[0].status, 'passed', r.out);
  assert.deepEqual(fk.entries(), [], 'nothing was started');
  assert.match(fs.readFileSync(r.report, 'utf8'), /sleep inhibitor unavailable/);
});
