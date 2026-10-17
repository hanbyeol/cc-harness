import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, tmpdir, writeJson, readJson, fakeExecutable, REPO } from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';

const NAMES = ['init', 'lint-contract', 'approve', 'verify', 'eval', 'run', 'status', 'stats', 'events', 'decide', 'backlog', 'doctor', 'claude-md', 'tf-check', 'migrate-v1'];
const OPTIONS = {
  init: ['--language'], approve: ['--by', '--extra-round'], verify: ['--base', '--cwd', '--json'],
  eval: ['--round', '--base', '--cwd', '--json'], run: ['--resume', '--fresh', '--max-usd', '--parallel'],
  status: ['--brief', '--todo-v1'], stats: ['--since', '--json'], events: ['--stage', '--feature', '--since', '--json'],
  decide: ['--accept-risk', '--split', '--rewrite'], backlog: ['close', '--resolved', '--obsolete'],
  'claude-md': ['--check'], 'tf-check': ['--dir'], 'migrate-v1': ['--force'],
};

const listed = () => {
  const r = harness(['--help'], { cwd: tmpdir() });
  const map = new Map();
  for (const line of r.stdout.split('\n')) {
    const m = /^ {2}(\S+) +(.+)$/.exec(line);
    if (m) map.set(m[1], m[2]);
  }
  return { map, lines: r.stdout.trimEnd().split('\n') };
};

test('F126 AC-1 every listed command answers --help, -h and <name> F1 --help', () => {
  const { map } = listed();
  assert.deepEqual([...map.keys()], NAMES);
  const cwd = tmpdir();
  for (const name of NAMES) {
    for (const args of [[name, '--help'], [name, '-h'], [name, 'F1', '--help']]) {
      const r = harness(args, { cwd });
      assert.equal(r.code, 0, args.join(' '));
      assert.equal(r.stderr, '', args.join(' '));
      assert.ok(r.stdout.startsWith(`usage: harness ${name}`), `${args.join(' ')}: ${r.stdout}`);
      assert.ok(r.stdout.includes(map.get(name)), `${name} summary`);
    }
  }
});

test('F126 AC-2 help names the options of the command', () => {
  for (const [name, options] of Object.entries(OPTIONS)) {
    const { stdout } = harness([name, '--help'], { cwd: tmpdir() });
    for (const o of options) assert.ok(stdout.includes(o), `${name} lacks ${o}`);
  }
});

// Lists every file under dir (relative path → content), .git included.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out[path.relative(dir, f)] = fs.readFileSync(f).toString('base64');
    }
  };
  walk(dir);
  return out;
}

test('F126 AC-3 --help has no side effects on uninitialized and corrupt repositories', () => {
  const log = path.join(tmpdir(), 'calls.log');
  const win = process.platform === 'win32';
  const content = win ? '@echo off\r\necho %~n0 >> "%FAKE_CALL_LOG%"\r\n' : '#!/bin/sh\necho "$0" >> "$FAKE_CALL_LOG"\n';
  const bins = ['claude', 'codex', 'gemini', 'git', 'terraform'].map((n) => fakeExecutable(n, content.replace('%~n0', n)));
  const env = { PATH: bins.join(path.delimiter) + path.delimiter + process.env.PATH, FAKE_CALL_LOG: log };
  const plain = gitRepo({ 'a.txt': 'a\n' }, { branch: null });
  const corrupt = gitRepo({ 'a.txt': 'a\n', '.harness/config.json': { profile: 'sdlc' } }, { branch: null });
  fs.writeFileSync(path.join(corrupt, '.harness', 'features.json'), 'not json');
  for (const dir of [plain, corrupt]) {
    const before = snapshot(dir);
    for (const name of NAMES) {
      const r = harness([name, '--help'], { cwd: dir, env });
      assert.equal(r.code, 0, `${name}: ${r.stderr}`);
    }
    assert.deepEqual(snapshot(dir), before);
  }
  assert.equal(fs.existsSync(log), false);
});

test('F126 AC-4 help <name> equals <name> --help; the list ends with the pointer', () => {
  const cwd = tmpdir();
  for (const name of NAMES) {
    const a = harness(['help', name], { cwd });
    const b = harness([name, '--help'], { cwd });
    assert.equal(a.code, 0);
    assert.equal(a.stdout, b.stdout);
  }
  for (const args of [['help'], ['--help']]) {
    const r = harness(args, { cwd });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('commands:'));
    assert.ok(r.stdout.trimEnd().split('\n').at(-1).includes('harness <command> --help'));
  }
});

test('F126 AC-5 docs describe command help', () => {
  const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
  const spec = read('docs/SPEC.md');
  for (const s of ['--help', '-h', 'help <command>', '`--` 뒤', 'E6', '모르는 인자']) assert.ok(spec.includes(s), s);
  assert.ok(read('AGENTS.md').includes('harness <command> --help'));
  assert.ok(read('README.md').includes('harness <command> --help'));
});

test('F126 ES-1 unknown command is rejected by help and --help', () => {
  for (const args of [['help', 'nope'], ['nope', '--help']]) {
    const r = harness(args, { cwd: tmpdir() });
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("unknown command 'nope'"));
  }
});

test('F126 ES-2 --help after -- is a value', () => {
  const dir = tmpdir();
  assert.equal(harness(['init'], { cwd: dir }).code, 0);
  writeJson(path.join(dir, '.harness', 'backlog.json'), { items: [{ id: 'B1', summary: 's', priority: 'low' }] });
  const r = harness(['backlog', 'close', 'B1', '--resolved', '--', '--help'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  const item = readJson(path.join(dir, '.harness', 'backlog.json')).items[0];
  assert.equal(item.closed.reason, '--help');
});

test('F126 ES-3 init and doctor reject unknown arguments', () => {
  const dir = gitRepo({}, { branch: null });
  const before = snapshot(dir);
  for (const [args, bad, name] of [[['init', 'extra'], 'extra', 'init'], [['init', '--bogus'], '--bogus', 'init'], [['doctor', '--bogus'], '--bogus', 'doctor']]) {
    const r = harness(args, { cwd: dir });
    assert.equal(r.code, 2, args.join(' '));
    assert.ok(r.stderr.includes(bad));
    assert.ok(r.stderr.includes(`usage: harness ${name}`));
  }
  assert.deepEqual(snapshot(dir), before);
});
