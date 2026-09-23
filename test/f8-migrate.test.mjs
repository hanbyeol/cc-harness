import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, harness, tmpdir, readJson, writeJson } from './helpers.mjs';

const FIXTURE = path.join(REPO, 'test', 'fixtures', 'v1');

// A throwaway v1 project: progress/feature_list.json + progress/contracts/ from the fixture.
function v1Project() {
  const dir = tmpdir('harness-v1-');
  fs.mkdirSync(path.join(dir, 'progress', 'contracts'), { recursive: true });
  fs.copyFileSync(path.join(FIXTURE, 'feature_list.json'), path.join(dir, 'progress', 'feature_list.json'));
  for (const f of fs.readdirSync(path.join(FIXTURE, 'contracts'))) {
    fs.copyFileSync(path.join(FIXTURE, 'contracts', f), path.join(dir, 'progress', 'contracts', f));
  }
  return dir;
}

// Every file under dir, relative, with contents — to prove "nothing was written".
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

function commands() {
  const r = harness(['--help']);
  return new Set([...r.stdout.matchAll(/^ {2}([a-z][a-z0-9-]*)\s/gm)].map((m) => m[1]));
}

test('F8 AC-1: migrate-v1 converts a v1 feature_list.json fixture into .harness/features.json', () => {
  const dir = v1Project();
  const v1 = readJson(path.join(dir, 'progress', 'feature_list.json')).features;
  const r = harness(['migrate-v1'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /migrated 4 feature\(s\).*2 passed, 2 todo/);

  const { features } = readJson(path.join(dir, '.harness', 'features.json'));
  assert.deepEqual(features.map((f) => f.id), v1.map((f) => f.id));
  for (const [i, f] of features.entries()) {
    assert.equal(f.title, v1[i].name, f.id);
    assert.equal(f.status, v1[i].passes ? 'passed' : 'todo', f.id);
    assert.deepEqual(f.depends_on, [], f.id);
    assert.equal(f.v1.status, v1[i].status, f.id);
    assert.equal(f.v1.passes, v1[i].passes, f.id);
    assert.ok(['standard', 'critical'].includes(f.security_tier), f.id);
  }
  const byId = Object.fromEntries(features.map((f) => [f.id, f]));
  assert.equal(byId.F2.security_tier, 'critical');
  assert.equal(byId.F4.security_tier, 'standard'); // v1 "low" has no v2 equivalent
  assert.equal(byId.F4.v1.security_tier, 'low');
  assert.equal(byId.F63.status, 'todo'); // superseded, passes:false
  assert.equal(byId.F63.v1.status, 'superseded');
  // Contract reference only when the v1 sprint contract file exists; contracts are not converted.
  assert.equal(byId.F2.v1.contract, 'progress/contracts/sprint-1.json');
  assert.equal(byId.F63.v1.contract, undefined);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.harness', 'contracts')), []);

  // .harness/ has the same layout as `harness init`, and the result is valid state.
  for (const f of ['config.json', 'backlog.json', '.gitignore', 'verdicts', 'runs']) {
    assert.ok(fs.existsSync(path.join(dir, '.harness', f)), f);
  }
  const s = harness(['status'], { cwd: dir });
  assert.equal(s.code, 0, s.stderr);
  // v1 files are left in place.
  assert.ok(fs.existsSync(path.join(dir, 'progress', 'feature_list.json')));
});

test('F8 AC-3: README has install, usage, convergence and v1 migration sections', () => {
  const text = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  for (const h of ['## 설치', '## 사용법', '## 수렴 규칙', '## v1에서 마이그레이션']) {
    assert.match(text, new RegExp(`^${h}\\s*$`, 'm'), h);
  }
  const section = (h) => text.split(new RegExp(`^${h}\\s*$`, 'm'))[1].split(/^## /m)[0];
  const install = section('## 설치');
  for (const w of ['Claude Code', 'Gemini', 'Codex', 'AGENTS.md', 'npx cc-harness init']) assert.ok(install.includes(w), `설치: ${w}`);
  const usage = section('## 사용법');
  for (const w of ['spec', 'plan', 'build', 'harness approve', 'harness run']) assert.ok(usage.includes(w), `사용법: ${w}`);
  const conv = section('## 수렴 규칙');
  for (const w of ['criterion_id', 'repro', 'D1', 'blocked', '3']) assert.ok(conv.includes(w), `수렴 규칙: ${w}`);
  const mig = section('## v1에서 마이그레이션');
  for (const w of ['harness migrate-v1', 'v1.39.18-final', '45']) assert.ok(mig.includes(w), `마이그레이션: ${w}`);
  assert.ok(text.split('\n').length <= 200, 'README longer than 200 lines');
});

test('F8 AC-3: every `harness <word>` in README is a real subcommand', () => {
  const known = commands();
  assert.ok(known.has('migrate-v1') && !known.has('deploy'));
  const text = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  let seen = 0;
  for (const m of text.matchAll(/\bharness\s+([a-z][a-z0-9-]*)/g)) {
    seen += 1;
    assert.ok(known.has(m[1]), `README: 'harness ${m[1]}' is not a subcommand`);
  }
  assert.ok(seen >= 9, `expected command references, found ${seen}`);
});

test('F8 AC-4: CI runs node --test on an ubuntu/macos/windows matrix', () => {
  const ci = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  const os = /^\s*os:\s*\[([^\]]*)\]/m.exec(ci);
  assert.ok(os, 'no os matrix');
  const names = os[1].split(',').map((s) => s.trim());
  for (const n of ['ubuntu-latest', 'macos-latest', 'windows-latest']) assert.ok(names.includes(n), n);
  assert.match(ci, /runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}/);
  assert.match(ci, /^\s*node:\s*\[\s*22\s*,\s*24\s*\]/m);
  assert.match(ci, /^\s*(-\s*)?run:\s*node --test\s+"?test\/\S*\.test\.mjs/m);
  assert.match(ci, /^\s*(-\s*)?run:\s*node bin\/harness\.mjs lint-contract\s*$/m);
  assert.match(ci, /branches:\s*\[[^\]]*\bmain\b[^\]]*\bv2\b[^\]]*\]/);
  // v1 shell tooling is gone from CI.
  assert.doesNotMatch(ci, /bats|shellcheck/);
});

test('F8 ES-1: migrate-v1 without v1 state prints guidance, writes nothing and exits 2', () => {
  const dir = tmpdir();
  const r = harness(['migrate-v1'], { cwd: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /progress\/feature_list\.json/);
  assert.match(r.stderr, /harness init/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('F8 ES-1: corrupted v1 feature_list.json exits 2 and writes nothing', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'progress'));
  fs.writeFileSync(path.join(dir, 'progress', 'feature_list.json'), '{ "features": [ broken');
  const before = snapshot(dir);
  const r = harness(['migrate-v1'], { cwd: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /invalid JSON/);
  assert.deepEqual(snapshot(dir), before);
});

test('F8 ES-2: existing .harness/features.json is not overwritten without --force', () => {
  const dir = v1Project();
  harness(['init'], { cwd: dir });
  const existing = { features: [{ id: 'F1', title: 'kept', security_tier: 'standard', depends_on: [], status: 'approved' }] };
  writeJson(path.join(dir, '.harness', 'features.json'), existing);
  const before = snapshot(dir);

  const r = harness(['migrate-v1'], { cwd: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /already exists.*refusing/);
  assert.match(r.stderr, /--force/);
  assert.deepEqual(snapshot(dir), before);

  const f = harness(['migrate-v1', '--force'], { cwd: dir });
  assert.equal(f.code, 0, f.stderr);
  assert.deepEqual(readJson(path.join(dir, '.harness', 'features.json')).features.map((x) => x.id), ['F2', 'F4', 'F63', 'F66']);
});

test('F8 ES-2: unknown option exits 2 and writes nothing', () => {
  const dir = v1Project();
  const before = snapshot(dir);
  const r = harness(['migrate-v1', '--forse'], { cwd: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: harness migrate-v1 \[--force\]/);
  assert.deepEqual(snapshot(dir), before);
});
