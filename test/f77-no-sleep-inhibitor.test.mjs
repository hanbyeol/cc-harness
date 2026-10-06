import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BIN, REPO, tmpdir } from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';
import { hashContract } from '../lib/contract.mjs';
import { startSleepInhibitor } from '../lib/sleep.mjs';

const FAKE_CLI = path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs');
const REPLY_PASS = path.join(REPO, 'test', 'fixtures', 'eval', 'pass.json');
const POSIX = process.platform !== 'win32'; // the fake inhibitors are shebang scripts
const VAR = 'HARNESS_TEST_NO_SLEEP_INHIBITOR';
const DISABLED = `disabled by ${VAR}`;

/**
 * A directory with fake `caffeinate` and `systemd-inhibit` (sh scripts) that log their name and
 * pid, then stay alive. `env(value)` puts them first on PATH with VAR set to `value`
 * (undefined: VAR absent).
 */
function fakeInhibitors() {
  const dir = tmpdir('harness-inhibit-');
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs);
  for (const name of ['caffeinate', 'systemd-inhibit']) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "${name}" "$$" > "${logs}/$$.tmp" && mv "${logs}/$$.tmp" "${logs}/$$.txt"\nexec sleep 1000\n`);
    fs.chmodSync(file, 0o755);
  }
  const entries = () => fs.readdirSync(logs).filter((n) => n.endsWith('.txt')).map((n) => {
    const [name, pid] = fs.readFileSync(path.join(logs, n), 'utf8').trim().split('\n');
    return { name, pid: Number(pid) };
  });
  const env = (value) => {
    const e = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` };
    delete e[VAR];
    if (value !== undefined) e[VAR] = value;
    return e;
  };
  const killAll = () => { for (const x of entries()) { try { process.kill(x.pid, 'SIGKILL'); } catch { /* gone */ } } };
  return { entries, env, killAll };
}

const until = async (fn, ms = 60000) => {
  for (let t = 0; t < ms && !fn(); t += 50) await new Promise((r) => setTimeout(r, 50));
  return fn();
};

// ------------------------------------------------------------------ AC-1
test('F77 AC-1 HARNESS_TEST_NO_SLEEP_INHIBITOR=1: no inhibitor is started, {ok:false, label:"disabled by ..."}', async () => {
  const fk = fakeInhibitors();
  try {
    for (const platform of ['darwin', 'linux']) {
      const r = await startSleepInhibitor({ platform, env: fk.env('1') });
      r.stop();
      assert.equal(r.ok, false, platform);
      assert.equal(r.label, DISABLED, platform);
    }
    if (POSIX) {
      // a started fake logs within moments; give it ample time before checking nothing ran
      await new Promise((r) => setTimeout(r, 1000));
      assert.deepEqual(fk.entries(), [], 'no inhibitor was executed');
    }
  } finally {
    fk.killAll();
  }
});

// ------------------------------------------------------------------ AC-2
test('F77 AC-2 HARNESS_TEST_NO_SLEEP_INHIBITOR absent or not "1" ("0", "", "true"): the inhibitor starts as before', async () => {
  if (!POSIX) return; // the fake inhibitors are shebang scripts
  // the contrast: the variable is read, and only '1' turns the inhibitor off
  const off = await startSleepInhibitor({ platform: 'darwin', env: fakeInhibitors().env('1') });
  off.stop();
  assert.equal(off.label, DISABLED);
  for (const value of [undefined, '0', '', 'true']) {
    for (const platform of ['darwin', 'linux']) {
      const fk = fakeInhibitors();
      const r = await startSleepInhibitor({ platform, env: fk.env(value) });
      try {
        const name = platform === 'darwin' ? 'caffeinate' : 'systemd-inhibit';
        assert.equal(r.ok, true, `${platform} ${JSON.stringify(value)}: ${r.label}`);
        assert.ok(r.label.startsWith(name), r.label);
        assert.ok(await until(() => fk.entries().length > 0), `${platform} ${JSON.stringify(value)}: inhibitor never ran`);
        assert.deepEqual(fk.entries().map((x) => x.name), [name]);
      } finally {
        r.stop();
        fk.killAll();
      }
    }
  }
});

// ------------------------------------------------------------------ AC-3 / ES-1
function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id}.txt exists`, check: `node scripts/has.mjs ${id}.txt`, new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-06T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

// A project whose builder writes F1.txt at once (its pid file already exists) and whose
// evaluator roles reply with a passing verdict.
function runFixture() {
  const pidFile = path.join(tmpdir('harness-pid-'), 'builder.pid');
  fs.writeFileSync(pidFile, '0');
  return gitRepo({
    '.harness/config.json': {
      profile: 'sdlc', base_branch: 'main', verify: { commands: [] },
      roles: { builder: 'generic', evaluator: 'generic', 'security-reviewer': 'generic' },
      adapters: { generic: { command: [process.execPath, FAKE_CLI, 'build-once', pidFile, 'F1.txt'], read_only_command: [process.execPath, FAKE_CLI, 'print', REPLY_PASS] } },
    },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract('F1'),
    'scripts/has.mjs': "import fs from 'node:fs';\nprocess.exit(process.argv.slice(2).every((f) => fs.existsSync(f)) ? 0 : 1);\n",
  }, { branch: null });
}

// `harness run` as a child that inherits this process's environment (no env passed).
function cliRun(dir) {
  const r = spawnSync(process.execPath, [BIN, 'run'], { cwd: dir, encoding: 'utf8', timeout: 180000 });
  const runs = path.join(dir, '.harness', 'runs');
  const reports = fs.existsSync(runs) ? fs.readdirSync(runs).filter((n) => n.endsWith('.md')) : [];
  const report = reports.length === 1 ? fs.readFileSync(path.join(runs, reports[0]), 'utf8') : '';
  const status = JSON.parse(fs.readFileSync(path.join(dir, '.harness/features.json'), 'utf8')).features.find((f) => f.id === 'F1').status;
  return { code: r.status, out: r.stdout + r.stderr, report, status };
}

test('F77 AC-3 test/helpers.mjs sets HARNESS_TEST_NO_SLEEP_INHIBITOR=1 and a harness run child inherits it', () => {
  assert.equal(process.env[VAR], '1');
  const r = cliRun(runFixture());
  assert.match(r.report, new RegExp(`sleep inhibitor unavailable: ${DISABLED}`), r.out);
});

test('F77 ES-1 a run with the inhibitor disabled goes on: the output names it and the feature passes', () => {
  const r = cliRun(runFixture());
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(`sleep inhibitor unavailable: ${DISABLED}`), r.out);
  assert.equal(r.status, 'passed', r.out);
});

// ------------------------------------------------------------------ AC-5
test('F77 AC-5 SPEC §8 says HARNESS_TEST_NO_SLEEP_INHIBITOR is test-only, disables the inhibitor only at "1", and gives the label', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s = spec.slice(spec.indexOf('## 8.'), spec.indexOf('## 9.'));
  const line = s.split('\n').find((l) => l.includes('잠자기 방지') && l.includes(VAR));
  assert.ok(line, `no sleep-inhibitor paragraph in §8 mentions ${VAR}`);
  for (const w of ['테스트', `${VAR}=1`, DISABLED]) assert.ok(line.includes(w), w);
});
