import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, harness, tmpdir, project, readJson, writeJson } from './helpers.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { writeJsonAtomic } from '../lib/state.mjs';

const ALL = ['init', 'lint-contract', 'approve', 'verify', 'eval', 'run', 'status', 'doctor', 'migrate-v1'];

test('F1 AC-1: --help lists every subcommand and exits 0', () => {
  const r = harness(['--help'], { cwd: tmpdir() });
  assert.equal(r.code, 0);
  for (const c of ALL) assert.match(r.stdout, new RegExp(`^\\s+${c}\\s`, 'm'), c);
});

test('F1 AC-2: init creates state and never overwrites existing files', () => {
  const dir = tmpdir();
  assert.equal(harness(['init'], { cwd: dir }).code, 0);
  for (const f of ['config.json', 'features.json', 'backlog.json']) assert.ok(fs.statSync(path.join(dir, '.harness', f)).isFile(), f);
  for (const d of ['contracts', 'verdicts', 'runs']) assert.ok(fs.statSync(path.join(dir, '.harness', d)).isDirectory(), d);

  const cfg = path.join(dir, '.harness', 'config.json');
  writeJson(cfg, { profile: 'sdlc', custom: 42 });
  assert.equal(harness(['init'], { cwd: dir }).code, 0);
  assert.equal(readJson(cfg).custom, 42);
});

test('F1 AC-3: config loader fills defaults for missing keys', () => {
  const c = resolveConfig({ budget: { run_usd: 5 } });
  assert.equal(c.max_rounds, 3);
  assert.equal(c.threshold, 7);
  assert.equal(c.budget.step_timeout_sec, 1800);
  assert.equal(c.budget.run_usd, 5);
});

test('F1 AC-4: status shows counts per status and the next runnable feature', () => {
  const dir = project([
    { id: 'F1', title: 'a', status: 'passed', depends_on: [] },
    { id: 'F2', title: 'b', status: 'approved', depends_on: ['F1'] },
    { id: 'F3', title: 'c', status: 'approved', depends_on: ['F2'] },
    { id: 'F4', title: 'd', status: 'todo', depends_on: [] },
  ]);
  const r = harness(['status'], { cwd: dir });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /1 passed/);
  assert.match(r.stdout, /2 approved/);
  assert.match(r.stdout, /1 todo/);
  assert.match(r.stdout, /runnable: F2$/m);
  assert.match(harness(['status', '--brief'], { cwd: dir }).stdout, /next: F2/);
});

test('F1 AC-5: package.json has no runtime dependencies and requires node >= 20', () => {
  const pkg = readJson(path.join(REPO, 'package.json'));
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
  assert.match(pkg.engines.node, />=\s*(2\d|[3-9]\d)/);
});

test('F1 AC-6: t.mjs fails when no test matches the id', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'test'));
  fs.copyFileSync(path.join(REPO, 'test', 't.mjs'), path.join(dir, 'test', 't.mjs'));
  fs.writeFileSync(path.join(dir, 'test', 'x.test.mjs'),
    "import test from 'node:test';\ntest('X AC-1: ok', () => {});\ntest('X AC-10: ok', () => {});\n");
  const run = (id) => spawnSync(process.execPath, ['test/t.mjs', id], { cwd: dir, encoding: 'utf8' });
  assert.equal(run('X AC-1').status, 0);
  assert.match(run('X AC-1').stdout, /1 passed/); // AC-1 must not also match AC-10
  assert.equal(run('X AC-2').status, 1);
  assert.equal(run('Y AC-1').status, 1);
});

test('F1 SC-1: an interrupted atomic write leaves the previous file intact', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'features.json');
  writeJson(file, { features: [{ id: 'F1' }] });
  const failingFs = { ...fs, renameSync: () => { throw Object.assign(new Error('boom'), { code: 'EIO' }); } };
  assert.throws(() => writeJsonAtomic(file, { features: [] }, { fsImpl: failingFs }), /write failed/);
  assert.deepEqual(readJson(file), { features: [{ id: 'F1' }] });
  assert.deepEqual(fs.readdirSync(dir), ['features.json']); // temp file cleaned up
});

test('F1 ES-1: corrupted features.json stops every command with exit 2 and is not modified', () => {
  const dir = project([]);
  const file = path.join(dir, '.harness', 'features.json');
  fs.writeFileSync(file, '{ "features": [ broken');
  const before = fs.readFileSync(file, 'utf8');
  for (const cmd of ALL) {
    const r = harness([cmd], { cwd: dir });
    assert.equal(r.code, 2, cmd);
    assert.match(r.stderr, /features\.json: invalid JSON/, cmd);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('F1 ES-2: unknown subcommand points to help and exits 2', () => {
  const r = harness(['frobnicate'], { cwd: tmpdir() });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown command 'frobnicate'.*--help/);
});

test('F1 ES-2 prototype keys: names like constructor are unknown commands too', () => {
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const r = harness([name], { cwd: tmpdir() });
    assert.equal(r.code, 2, name);
    assert.match(r.stderr, new RegExp(`unknown command '${name}'.*--help`), name);
  }
});
