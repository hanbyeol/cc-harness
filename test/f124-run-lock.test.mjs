import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { runFeatures, isProcessAlive, git as realGit } from '../lib/run.mjs';

const SCRIPT = "import fs from 'node:fs';\nprocess.exit(process.argv.slice(2).every((f) => fs.existsSync(f)) ? 0 : 1);\n";

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id}.txt exists`, check: `node scripts/has.mjs ${id}.txt`, new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-10T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture(ids = ['F1']) {
  const files = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: 'standard', depends_on: [], status: 'approved' })) },
    'scripts/has.mjs': SCRIPT,
  };
  for (const id of ids) files[`.harness/contracts/${id}.json`] = contract(id);
  return gitRepo(files, { branch: null });
}

const PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const verify = async () => PASSING;
const evaluate = async (a) => ({
  feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null,
});
const usable = async () => ({ roles: ['builder', 'evaluator', 'security-reviewer'].map((role) => ({ role, usable: true })) });
const cfg = () => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 } });
const lockPath = (dir) => path.join(dir, '.harness/runs/run.lock');
const statePath = (dir) => path.join(dir, '.harness/runs/current.json');
const readLock = (dir) => JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'));
const okBuild = async (a) => { writeFiles(a.cwd, { [`${a.featureId}.txt`]: 'built\n' }); return { ok: true, costUsd: 0 }; };
const deadPid = () => {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(r.stdout.toString());
};
const putLock = (dir, lock) => {
  fs.mkdirSync(path.dirname(lockPath(dir)), { recursive: true });
  fs.writeFileSync(lockPath(dir), typeof lock === 'string' ? lock : JSON.stringify(lock));
};
const base = { build: okBuild, verify, evaluate, diagnose: usable, cpus: 8, log: () => {}, warn: () => {} };

test('F124 AC-1 a new run takes run.lock with pid, host and startedAt before the preflight', async () => {
  const dir = fixture();
  let seen = null;
  const diagnose = async (a) => { seen = readLock(dir); return usable(a); };
  const r = await runFeatures({ root: dir, config: cfg(), deps: { ...base, diagnose } });
  assert.equal(r.interrupted, false);
  assert.equal(seen.pid, process.pid);
  assert.equal(seen.host, os.hostname());
  assert.ok(!Number.isNaN(Date.parse(seen.startedAt)));
});

test('F124 AC-1 run --resume takes the lock before any other work', async () => {
  const dir = fixture();
  const ctl = new AbortController();
  const build = async (a) => { ctl.abort(); return okBuild(a); };
  const first = await runFeatures({ root: dir, config: cfg(), signal: ctl.signal, deps: { ...base, build } });
  assert.equal(first.interrupted, true);
  let seen = null;
  const git = (args, cwd, o) => { seen ??= readLock(dir); return realGit(args, cwd, o); };
  await runFeatures({ root: dir, resume: true, deps: { ...base, git } });
  assert.equal(seen.pid, process.pid);
  assert.equal(seen.host, os.hostname());
});

test('F124 AC-2 the lock is gone after a normal end and after errors', async () => {
  const dir = fixture();
  const r = await runFeatures({ root: dir, config: cfg(), deps: base });
  assert.ok(r.report);
  assert.ok(!fs.existsSync(statePath(dir)));
  assert.ok(!fs.existsSync(lockPath(dir)));

  const bad = fixture();
  await assert.rejects(runFeatures({ root: bad, config: cfg(), deps: { ...base, diagnose: async () => ({ roles: [] }) } }), { exit: 2 });
  assert.ok(!fs.existsSync(lockPath(bad)));

  const unknown = fixture();
  await assert.rejects(runFeatures({ root: unknown, config: cfg(), ids: ['F99'], deps: base }), /unknown feature/);
  assert.ok(!fs.existsSync(lockPath(unknown)));

  const pending = fixture();
  fs.mkdirSync(path.join(pending, '.harness/runs'), { recursive: true });
  fs.writeFileSync(statePath(pending), '{}');
  await assert.rejects(runFeatures({ root: pending, config: cfg(), deps: base }), { code: 'run_in_progress' });
  assert.ok(!fs.existsSync(lockPath(pending)));
});

test('F124 AC-3 an interrupted run releases the lock and --resume continues', async () => {
  const dir = fixture();
  const ctl = new AbortController();
  const build = async (a) => { ctl.abort(); return okBuild(a); };
  const first = await runFeatures({ root: dir, config: cfg(), signal: ctl.signal, deps: { ...base, build } });
  assert.equal(first.interrupted, true);
  assert.ok(fs.existsSync(statePath(dir)));
  assert.ok(!fs.existsSync(lockPath(dir)));
  const second = await runFeatures({ root: dir, resume: true, deps: base });
  assert.equal(second.interrupted, false);
  assert.ok(!fs.existsSync(lockPath(dir)));
});

test('F124 AC-4 SPEC §8 and §12 describe run.lock', () => {
  const spec = fs.readFileSync(new URL('../docs/SPEC.md', import.meta.url), 'utf8');
  const recovery = spec.split('\n').find((l) => l.startsWith('실행 잠금:'));
  assert.ok(recovery);
  for (const word of ['runs/run.lock', 'pid', 'host', 'startedAt', 'wx', 'run_locked', 'stale run lock', '해제']) {
    assert.ok(recovery.includes(word), `§8 mentions ${word}`);
  }
  const section = spec.slice(spec.indexOf('## 12.'), spec.indexOf('## 13.'));
  const row = section.split('\n').find((l) => l.startsWith('|') && l.includes('run.lock'));
  assert.ok(row && row.includes('run_locked'));
});

test('F124 SC-1 a live lock of this host refuses a new run and --resume without touching anything', async () => {
  for (const resume of [false, true]) {
    const dir = fixture();
    const lock = { pid: process.pid, host: os.hostname(), startedAt: '2026-10-10T00:00:00.000Z' };
    putLock(dir, lock);
    if (resume) fs.writeFileSync(statePath(dir), '{"saved":true}');
    const calls = [];
    const deps = { ...base, git: (...a) => { calls.push('git'); return realGit(...a); }, build: async () => { calls.push('build'); return { ok: true }; } };
    await assert.rejects(runFeatures({ root: dir, config: resume ? undefined : cfg(), resume, deps }), (e) => {
      assert.equal(e.code, 'run_locked');
      assert.equal(e.exit, 2);
      assert.ok(e.message.includes(lockPath(dir)));
      assert.ok(e.message.includes(String(process.pid)));
      assert.ok(e.message.includes(os.hostname()));
      return true;
    });
    assert.deepEqual(readLock(dir), lock);
    if (resume) assert.equal(fs.readFileSync(statePath(dir), 'utf8'), '{"saved":true}');
    assert.deepEqual(calls, []);
  }
});

test('F124 SC-2 of two concurrent runs exactly one is refused', async () => {
  const dir = fixture();
  let builds = 0;
  const build = async (a) => { builds += 1; return okBuild(a); };
  const start = () => runFeatures({ root: dir, config: cfg(), deps: { ...base, build } });
  const results = await Promise.allSettled([start(), start()]);
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'run_locked');
  assert.equal(results.filter((r) => r.status === 'fulfilled' && !r.value.interrupted).length, 1);
  assert.equal(builds, 1);
});

test('F124 SC-3 foreign-host and malformed locks are refused and left alone', async () => {
  const cases = [
    JSON.stringify({ pid: process.pid, host: `${os.hostname()}-other`, startedAt: 'x' }),
    'not json',
    JSON.stringify({ pid: 0, host: os.hostname(), startedAt: 'x' }),
    JSON.stringify({ pid: 'abc', host: os.hostname(), startedAt: 'x' }),
    JSON.stringify({ pid: -5, host: os.hostname(), startedAt: 'x' }),
  ];
  for (const text of cases) {
    const dir = fixture();
    putLock(dir, text);
    await assert.rejects(runFeatures({ root: dir, config: cfg(), deps: base }), (e) => {
      assert.equal(e.code, 'run_locked');
      assert.equal(e.exit, 2);
      assert.ok(e.message.includes(lockPath(dir)));
      assert.ok(e.message.includes('delete it if no run is active'));
      return true;
    });
    assert.equal(fs.readFileSync(lockPath(dir), 'utf8'), text);
  }
});

test('F124 ES-1 a stale lock of this host is taken over with a warning', async () => {
  const dir = fixture();
  const pid = deadPid();
  putLock(dir, { pid, host: os.hostname(), startedAt: '2026-10-10T00:00:00.000Z' });
  const warnings = [];
  let seen = null;
  const diagnose = async (a) => { seen = readLock(dir); return usable(a); };
  const r = await runFeatures({ root: dir, config: cfg(), deps: { ...base, diagnose, warn: (m) => warnings.push(m) } });
  assert.equal(r.interrupted, false);
  assert.equal(seen.pid, process.pid);
  assert.notEqual(seen.startedAt, '2026-10-10T00:00:00.000Z');
  assert.ok(warnings.some((m) => m.includes('stale run lock') && m.includes(String(pid))));
});

test('F124 ES-2 isProcessAlive: own pid, ended child, EPERM', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(deadPid()), false);
  const eperm = () => { throw Object.assign(new Error('no'), { code: 'EPERM' }); };
  assert.equal(isProcessAlive(1, eperm), true);
});
