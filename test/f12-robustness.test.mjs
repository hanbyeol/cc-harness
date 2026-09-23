import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harness, tmpdir, project, readJson, writeJson } from './helpers.mjs';
import { writeJsonAtomic, loadFeatures } from '../lib/state.mjs';
import { HarnessError } from '../lib/errors.mjs';

// Commands that read config.json before doing anything else.
const CONFIG_READERS = ['status', 'doctor', 'lint-contract', 'approve', 'verify', 'eval', 'run'];

test('F12 AC-1: init completes a .harness/ that only has contracts/, keeping the contracts', () => {
  const dir = tmpdir();
  const contract = path.join(dir, '.harness', 'contracts', 'F1.json');
  fs.mkdirSync(path.dirname(contract), { recursive: true });
  const text = '{ "id": "F1", "note": "kept byte for byte" }\n';
  fs.writeFileSync(contract, text);

  const r = harness(['init'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readJson(path.join(dir, '.harness', 'config.json')).profile, 'sdlc');
  assert.deepEqual(readJson(path.join(dir, '.harness', 'features.json')), { features: [] });
  assert.deepEqual(readJson(path.join(dir, '.harness', 'backlog.json')), { items: [] });
  for (const d of ['verdicts', 'runs']) assert.ok(fs.statSync(path.join(dir, '.harness', d)).isDirectory(), d);
  assert.equal(fs.readFileSync(contract, 'utf8'), text);
  assert.deepEqual(fs.readdirSync(path.dirname(contract)), ['F1.json']);
  // Afterwards the project is usable.
  assert.equal(harness(['status'], { cwd: dir }).code, 0);
});

test('F12 AC-1 partial: init still refuses a corrupted file that does exist', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, '.harness', 'contracts'), { recursive: true });
  const features = path.join(dir, '.harness', 'features.json');
  fs.writeFileSync(features, '{ broken');
  const r = harness(['init'], { cwd: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /features\.json: invalid JSON/);
  assert.equal(fs.readFileSync(features, 'utf8'), '{ broken');
  assert.equal(fs.existsSync(path.join(dir, '.harness', 'config.json')), false);
});

test('F12 AC-2: a failure while writing the temp file removes it and keeps the target', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'features.json');
  writeJson(file, { features: [{ id: 'F1' }] });
  const before = fs.readFileSync(file, 'utf8');
  const failingFs = {
    ...fs,
    // The temp file is created and partly written, then the disk fills up.
    writeFileSync: (p, text) => {
      fs.writeFileSync(p, String(text).slice(0, 3));
      throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    },
  };
  assert.throws(() => writeJsonAtomic(file, { features: [] }, { fsImpl: failingFs }),
    (e) => e instanceof HarnessError && e.code === 'io' && /ENOSPC/.test(e.message));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir), ['features.json']); // no .tmp-* left behind
});

test('F12 ES-1: a config.json that is null, an array or a number exits 2 naming the file', () => {
  for (const bad of ['null', '[]', '[{"profile":"sdlc"}]', '42']) {
    const dir = project([]);
    const cfg = path.join(dir, '.harness', 'config.json');
    fs.writeFileSync(cfg, bad);
    for (const cmd of CONFIG_READERS) {
      const r = harness([cmd], { cwd: dir });
      assert.equal(r.code, 2, `${bad} ${cmd}: ${r.stderr}`);
      assert.ok(r.stderr.includes(cfg), `${bad} ${cmd}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /internal error/, `${bad} ${cmd}`);
    }
    assert.equal(fs.readFileSync(cfg, 'utf8'), bad);
  }
});

test('F12 ES-2: a budget that is null or not an object exits 2 naming budget', () => {
  for (const budget of [null, 5, 'x', [1], true]) {
    const dir = project([]);
    const cfg = path.join(dir, '.harness', 'config.json');
    writeJson(cfg, { profile: 'sdlc', budget });
    for (const cmd of CONFIG_READERS) {
      const r = harness([cmd], { cwd: dir });
      assert.equal(r.code, 2, `${JSON.stringify(budget)} ${cmd}: ${r.stderr}`);
      assert.match(r.stderr, /\bbudget\b/, `${JSON.stringify(budget)} ${cmd}`);
      assert.ok(r.stderr.includes(cfg), `${JSON.stringify(budget)} ${cmd}: ${r.stderr}`);
    }
  }
  // A valid partial budget still works.
  const dir = project([]);
  writeJson(path.join(dir, '.harness', 'config.json'), { profile: 'sdlc', budget: { run_usd: 5 } });
  assert.equal(harness(['status'], { cwd: dir }).code, 0);
});

test('F12 ES-3: a features.json entry without a string id, status or title exits 2 with its index', () => {
  const ok = { id: 'F1', title: 'a', status: 'todo', depends_on: [] };
  const cases = [
    [{ title: 'b', status: 'todo' }, 'id'],
    [{ id: 'F2', title: 'b' }, 'status'],
    [{ id: 'F2', status: 'todo' }, 'title'],
    [{ id: 2, title: 'b', status: 'todo' }, 'id'],
    [{ id: 'F2', title: null, status: 'todo' }, 'title'],
    [{ id: 'F2', title: 'b', status: ['todo'] }, 'status'],
  ];
  for (const [entry, field] of cases) {
    const dir = project([ok, entry]);
    const file = path.join(dir, '.harness', 'features.json');
    const before = fs.readFileSync(file, 'utf8');
    const r = harness(['status'], { cwd: dir });
    assert.equal(r.code, 2, `${JSON.stringify(entry)}: ${r.stderr}`);
    assert.match(r.stderr, /features\.json/);
    assert.match(r.stderr, /features\[1\]/, r.stderr);
    assert.match(r.stderr, new RegExp(`\\b${field}\\b`), r.stderr);
    assert.doesNotMatch(r.stderr, /internal error/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.throws(() => loadFeatures(dir), (e) => e instanceof HarnessError && e.code === 'state_corrupt');
  }
  for (const entry of [null, 'F2', [1]]) {
    const r = harness(['status'], { cwd: project([ok, entry]) });
    assert.equal(r.code, 2, JSON.stringify(entry));
    assert.match(r.stderr, /features\[1\]/);
  }
});

// Round 2: creating the parent directory is a step of the write too.
test('F12 AC-2 mkdir: a failing parent-directory creation throws HarnessError(io), not a raw error', () => {
  const failingFs = { mkdirSync: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } };
  assert.throws(() => writeJsonAtomic(path.join(os.tmpdir(), 'harness-f12-none', 'x.json'), { a: 1 }, { fsImpl: failingFs }),
    (e) => e instanceof HarnessError && e.code === 'io');
});
