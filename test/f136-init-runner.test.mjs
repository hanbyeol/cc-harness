import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { harness, realTmpdir, REPO } from './helpers.mjs';
import { renderBlock } from '../lib/claudemd.mjs';

const RUNNER = path.join(REPO, 'test', 't.mjs');

function dir(files = { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) }) {
  const d = realTmpdir('harness-f136-');
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  return d;
}
const lines = (r) => r.stdout.split('\n');

test('F136 AC-1 package.json files lists the runner', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('test/t.mjs'));
  for (const f of ['bin/', 'lib/', 'agents/', 'skills/', 'profiles/', 'templates/', 'hooks/hooks.json', 'AGENTS.md', '.claude-plugin/', 'gemini-extension.json']) assert.ok(pkg.files.includes(f), f);
  assert.ok(fs.existsSync(RUNNER));
});

test('F136 AC-2 init creates the runner in a node --test project', () => {
  const d = dir();
  const r = harness(['init'], { cwd: d });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(lines(r).includes('created test/t.mjs'));
  assert.ok(fs.readFileSync(path.join(d, 'test', 't.mjs')).equals(fs.readFileSync(RUNNER)));
  fs.writeFileSync(path.join(d, 'a.test.mjs'), "import test from 'node:test';\ntest('F1 AC-1 ok', () => {});\n");
  fs.mkdirSync(path.join(d, 'test'), { recursive: true });
  fs.renameSync(path.join(d, 'a.test.mjs'), path.join(d, 'test', 'a.test.mjs'));
  const run = spawnSync(process.execPath, ['test/t.mjs', 'F1 AC-1'], { cwd: d, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('F136 AC-3 init keeps an existing runner', () => {
  const d = dir();
  fs.mkdirSync(path.join(d, 'test'));
  fs.writeFileSync(path.join(d, 'test', 't.mjs'), 'mine\n');
  const r = harness(['init'], { cwd: d });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(lines(r).includes('kept    test/t.mjs'));
  assert.equal(fs.readFileSync(path.join(d, 'test', 't.mjs'), 'utf8'), 'mine\n');
});

test('F136 AC-4 init prints one hint before next for other runners', () => {
  const cases = [
    [{ 'go.mod': 'module x\n' }, 'go test -run F3AC1'],
    [{ 'pytest.ini': '[pytest]\n' }, 'pytest -k F3_AC_1'],
    [{}, '"F3 AC-1"'],
  ];
  for (const [files, want] of cases) {
    const d = dir(files);
    const r = harness(['init'], { cwd: d });
    assert.equal(r.code, 0, r.stderr);
    const ls = lines(r);
    const hints = ls.filter((l) => l.startsWith('hint: '));
    assert.equal(hints.length, 1);
    assert.ok(hints[0].includes(want), hints[0]);
    assert.ok(ls.indexOf(hints[0]) < ls.findIndex((l) => l.startsWith('next:')));
    assert.ok(!fs.existsSync(path.join(d, 'test')));
  }
});

test('F136 AC-5 generalized SPEC-gap rule in the block', () => {
  const want = "- A gap in the project's spec or requirements document (if it has one) found during implementation is fixed in that document in the same change.";
  for (const profile of ['sdlc', 'iac', 'ops']) {
    const b = renderBlock({ profile });
    assert.ok(!b.includes('A gap in the SPEC'), profile);
    const ls = b.split('\n');
    const i = ls.indexOf(want);
    assert.ok(i > 0, profile);
    assert.equal(ls[i + 1], '');
    assert.equal(ls[i + 2], '## Prohibited');
  }
  const r = harness(['claude-md', '--check'], { cwd: REPO });
  assert.equal(r.code, 0, r.stdout + r.stderr);
});

test('F136 AC-6 docs describe the runner', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const skill = fs.readFileSync(path.join(REPO, 'skills', 'spec', 'SKILL.md'), 'utf8');
  for (const s of ['created test/t.mjs', 'kept    test/t.mjs', 'hint: ', 'go test -run F3AC1', 'pytest -k F3_AC_1', '"F3 AC-1"']) assert.ok(spec.includes(s), s);
  assert.ok(/^test\/t\.mjs /m.test(spec));
  assert.ok(/init.*creates.*test\/t\.mjs/s.test(skill));
});

test('F136 ES-1 init does not write through a symlinked runner', (t) => {
  const d = dir();
  const outside = path.join(realTmpdir('harness-f136-out-'), 'target');
  fs.mkdirSync(path.join(d, 'test'));
  const link = path.join(d, 'test', 't.mjs');
  for (const withTarget of [false, true]) {
    if (withTarget) fs.writeFileSync(outside, 'orig\n');
    try { fs.symlinkSync(outside, link); } catch (e) { t.diagnostic(`cannot create symlink: ${e.code}`); return; }
    const r = harness(['init'], { cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(lines(r).includes('kept    test/t.mjs'));
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.existsSync(outside), withTarget);
    if (withTarget) assert.equal(fs.readFileSync(outside, 'utf8'), 'orig\n');
    fs.unlinkSync(link);
  }
});

test('F136 ES-2 init warns when test is a regular file', () => {
  const d = dir({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }), test: 'file\n' });
  const r = harness(['init'], { cwd: d });
  assert.equal(r.code, 0, r.stderr);
  const w = r.stderr.split('\n').find((l) => l.startsWith('harness: warning: ') && l.includes('test/t.mjs') && l.includes('not created'));
  assert.ok(w, r.stderr);
  assert.equal(fs.readFileSync(path.join(d, 'test'), 'utf8'), 'file\n');
  assert.ok(fs.existsSync(path.join(d, '.harness', 'config.json')));
  assert.ok(fs.existsSync(path.join(d, 'CLAUDE.md')));
});
