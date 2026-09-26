import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, harness, tmpdir } from './helpers.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { runCommand } from '../lib/exec.mjs';

// ------------------------------------------------------------------ fixtures

// A fake `terraform` (PATH-first). Behaviour is driven by markers in the *.tf files of its cwd:
//   FAIL_INIT / FAIL_VALIDATE  → that subcommand exits 1;  FAIL_FMT → fmt exits 1 (any *.tf below cwd).
// `init` "downloads" the provider unless it is already in $TF_PLUGIN_CACHE_DIR.
// Every call is appended to $FAKE_TF_LOG as one JSON line.
const FAKE = `
import fs from 'node:fs';
import path from 'node:path';
const [sub, ...rest] = process.argv.slice(2);
const cache = process.env.TF_PLUGIN_CACHE_DIR || null;
fs.appendFileSync(process.env.FAKE_TF_LOG, JSON.stringify({ sub, args: rest, cwd: fs.realpathSync(process.cwd()), cache }) + '\\n');
const tfs = (dir, deep) => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.tf')) out.push(fs.readFileSync(path.join(dir, e.name), 'utf8'));
    else if (deep && e.isDirectory() && !e.name.startsWith('.')) out.push(tfs(path.join(dir, e.name), true));
  }
  return out.join('\\n');
};
const has = (text, marker) => text.includes(marker);
if (sub === 'init') {
  const text = tfs('.', false);
  if (has(text, 'FAIL_INIT')) { process.stderr.write('Error: Failed to query available provider packages ' + 'x'.repeat(400) + '\\n'); process.exit(1); }
  if (cache) {
    const provider = path.join(cache, 'fake-provider');
    if (!fs.existsSync(provider)) {
      fs.writeFileSync(provider, 'binary');
      fs.appendFileSync(process.env.FAKE_TF_LOG, JSON.stringify({ sub: 'download' }) + '\\n');
    }
  }
} else if (sub === 'validate') {
  if (has(tfs('.', false), 'FAIL_VALIDATE')) { process.stderr.write('Error: Unsupported argument\\n'); process.exit(1); }
} else if (sub === 'fmt') {
  if (has(tfs('.', true), 'FAIL_FMT')) { process.stdout.write('main.tf\\n'); process.exit(3); }
}
`;

const readLog = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const real = (p) => fs.realpathSync.native(p);

function fakeBin() {
  const dir = tmpdir('harness-f40-bin-');
  fs.writeFileSync(path.join(dir, 'terraform.mjs'), FAKE);
  const script = path.join(dir, 'terraform.mjs');
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'terraform.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    const sh = path.join(dir, 'terraform');
    fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    fs.chmodSync(sh, 0o755);
  }
  return dir;
}

// A project directory with `dirs` ({ 'rel/dir': tf content }); returns { root, log, env }.
function fixture(dirs, { withFake = true } = {}) {
  const root = real(tmpdir('harness-f40-'));
  for (const [rel, content] of Object.entries(dirs)) {
    const d = path.join(root, rel);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'main.tf'), content);
  }
  const home = real(tmpdir('harness-f40-home-'));
  const log = path.join(home, 'tf.log');
  const sep = path.delimiter;
  const env = {
    FAKE_TF_LOG: log,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(home, 'Local'),
    XDG_CACHE_HOME: path.join(home, 'xdg'),
    TF_PLUGIN_CACHE_DIR: '', // replaced below: an empty value means "unset" for the CLI under test
    PATH: withFake ? `${fakeBin()}${sep}${process.env.PATH}` : path.dirname(process.execPath),
  };
  delete env.TF_PLUGIN_CACHE_DIR;
  return { root, home, log, env };
}

// harness() merges over process.env, so a variable the test must not inherit is blanked out
// by removing it from process.env for the duration of the call.
function tfCheck(f, args = [], extraEnv = {}) {
  const saved = process.env.TF_PLUGIN_CACHE_DIR;
  delete process.env.TF_PLUGIN_CACHE_DIR;
  try {
    return harness(['tf-check', ...args], { cwd: f.root, env: { ...f.env, ...extraEnv } });
  } finally {
    if (saved !== undefined) process.env.TF_PLUGIN_CACHE_DIR = saved;
  }
}

// The per-user cache directory the spec names, computed independently of the implementation.
function expectedCacheDir(home) {
  if (process.platform === 'win32') return path.join(home, 'Local', 'cc-harness', 'terraform-plugins');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'cc-harness', 'terraform-plugins');
  return path.join(home, 'xdg', 'cc-harness', 'terraform-plugins');
}

const combined = (r) => `${r.stdout}\n${r.stderr}`;
const norm = (s) => s.replaceAll('\\', '/');

// ------------------------------------------------------------------ criteria

test('F40 AC-1 iac profile runs one command, tf-check, which checks every module directory and fmt once', () => {
  assert.deepEqual(resolveConfig({ profile: 'iac' }).verify.commands, ['harness tf-check']);

  const f = fixture({
    'modules/a': 'resource "a" {}\n',
    'modules/bad': '# FAIL_VALIDATE\n',
    'envs/prod': 'module "a" {}\n',
    'modules/a/.terraform/modules/x': 'FAIL_VALIDATE\n', // excluded
    '.harness/wt/F1': 'FAIL_VALIDATE\n', // excluded
  });
  // `.harness/` is project state: the CLI wants a complete one, and tf-check must skip it.
  assert.equal(harness(['init'], { cwd: f.root }).code, 0);
  const r = tfCheck(f);
  assert.equal(r.code, 1, combined(r));
  assert.match(norm(combined(r)), /modules\/bad/);
  assert.doesNotMatch(norm(combined(r)), /\.harness/);
  assert.doesNotMatch(norm(combined(r)), /\.terraform\/modules/);

  const calls = readLog(f.log);
  const dirs = (sub) => calls.filter((c) => c.sub === sub).map((c) => path.relative(f.root, c.cwd).split(path.sep).join('/')).sort();
  assert.deepEqual(dirs('init'), ['envs/prod', 'modules/a', 'modules/bad']);
  assert.deepEqual(dirs('validate'), ['envs/prod', 'modules/a', 'modules/bad']);
  for (const c of calls.filter((x) => x.sub === 'init')) assert.deepEqual(c.args, ['-backend=false', '-input=false']);
  const fmt = calls.filter((c) => c.sub === 'fmt');
  assert.equal(fmt.length, 1);
  assert.deepEqual(fmt[0].args, ['-check', '-recursive']);
  assert.equal(fmt[0].cwd, f.root);
});

test('F40 AC-1 passes with exit 0 when every module is valid and fmt is clean', () => {
  const f = fixture({ 'modules/a': 'resource "a" {}\n', 'modules/b': 'resource "b" {}\n' });
  const r = tfCheck(f);
  assert.equal(r.code, 0, combined(r));
});

test('F40 AC-1 a fmt failure makes tf-check exit 1 and is reported', () => {
  const f = fixture({ 'modules/a': '# FAIL_FMT\n' });
  const r = tfCheck(f);
  assert.equal(r.code, 1, combined(r));
  assert.match(combined(r), /fmt/);
});

test('F40 AC-2 tf-check creates <user cache dir>/cc-harness/terraform-plugins and a second run does not download again', () => {
  const f = fixture({ 'modules/a': 'resource "a" {}\n' });
  const cache = expectedCacheDir(f.home);
  assert.equal(fs.existsSync(cache), false);

  assert.equal(tfCheck(f).code, 0);
  assert.equal(fs.statSync(cache).isDirectory(), true);
  assert.equal(tfCheck(f).code, 0);

  const calls = readLog(f.log);
  const seen = calls.filter((c) => c.sub === 'init' || c.sub === 'validate' || c.sub === 'fmt');
  assert.ok(seen.length >= 6);
  for (const c of seen) assert.equal(real(c.cache), real(cache));
  assert.equal(calls.filter((c) => c.sub === 'download').length, 1);
});

test('F40 AC-2 a TF_PLUGIN_CACHE_DIR already set is kept and no default directory is created', () => {
  const f = fixture({ 'modules/a': 'resource "a" {}\n' });
  const mine = path.join(f.home, 'mine');
  fs.mkdirSync(mine);
  assert.equal(tfCheck(f, [], { TF_PLUGIN_CACHE_DIR: mine }).code, 0);
  for (const c of readLog(f.log).filter((x) => x.sub === 'init')) assert.equal(real(c.cache), real(mine));
  assert.equal(fs.existsSync(expectedCacheDir(f.home)), false);
});

test('F40 AC-3 iac profile env_allowlist carries TF_PLUGIN_CACHE_DIR to verify commands', async () => {
  const cfg = resolveConfig({ profile: 'iac' });
  assert.ok(cfg.env_allowlist.includes('TF_PLUGIN_CACHE_DIR'));

  const saved = process.env.TF_PLUGIN_CACHE_DIR;
  process.env.TF_PLUGIN_CACHE_DIR = 'f40-cache-value';
  try {
    const show = `"${process.execPath}" -e "process.stdout.write(process.env.TF_PLUGIN_CACHE_DIR || 'unset')"`;
    const withList = await runCommand(show, { cwd: os.tmpdir(), envExtra: cfg.env_allowlist });
    assert.equal(withList.stdout, 'f40-cache-value');
    const without = await runCommand(show, { cwd: os.tmpdir(), envExtra: resolveConfig({ profile: 'sdlc' }).env_allowlist });
    assert.equal(without.stdout, 'unset');
  } finally {
    if (saved === undefined) delete process.env.TF_PLUGIN_CACHE_DIR; else process.env.TF_PLUGIN_CACHE_DIR = saved;
  }
});

test('F40 AC-4 tf-check --dir checks only that directory subtree', () => {
  const f = fixture({
    'infra/a': 'resource "a" {}\n',
    'infra/deep/b': 'resource "b" {}\n',
    'other/bad': '# FAIL_VALIDATE\n',
  });
  const r = tfCheck(f, ['--dir', 'infra']);
  assert.equal(r.code, 0, combined(r));
  const calls = readLog(f.log);
  const rel = (c) => path.relative(f.root, c.cwd).split(path.sep).join('/');
  assert.deepEqual(calls.filter((c) => c.sub === 'init').map(rel).sort(), ['infra/a', 'infra/deep/b']);
  const fmt = calls.filter((c) => c.sub === 'fmt');
  assert.equal(fmt.length, 1);
  assert.equal(rel(fmt[0]), 'infra');
  assert.equal(calls.filter((c) => c.cwd).some((c) => rel(c).startsWith('other')), false);

  // The same directory through --dir=<path> and an absolute path.
  assert.equal(tfCheck(f, [`--dir=${path.join(f.root, 'infra')}`]).code, 0);
  // Outside --dir the failing module is not looked at, inside it is.
  assert.equal(tfCheck(f, ['--dir', 'other']).code, 1);
});

test('F40 AC-4 tf-check --dir with a missing directory is a usage error (exit 2)', () => {
  const f = fixture({ 'a': 'resource "a" {}\n' });
  const r = tfCheck(f, ['--dir', 'nope']);
  assert.equal(r.code, 2, combined(r));
  assert.match(r.stderr, /nope/);
  assert.equal(readLog(f.log).length, 0);
});

test('F40 AC-5 SPEC §4 and docs describe tf-check and the provider cache', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'iac.md'), 'utf8');
  const start = spec.indexOf('## 4.');
  const end = spec.indexOf('\n## 5.');
  const section4 = spec.slice(start, end);
  for (const [label, text] of [['SPEC §4', section4], ['docs/iac.md', doc]]) {
    for (const needle of ['tf-check', 'TF_PLUGIN_CACHE_DIR', 'cc-harness/terraform-plugins', '--dir', 'init -backend=false', 'fmt -check -recursive']) {
      assert.ok(text.includes(needle), `${label} must mention ${needle}`);
    }
  }
  assert.match(fs.readFileSync(path.join(REPO, 'README.md'), 'utf8'), /tf-check/);
});

test('F40 ES-1 tf-check without terraform on PATH prints "command not found: terraform" and exits 127', () => {
  const f = fixture({ 'modules/a': 'resource "a" {}\n' }, { withFake: false });
  const r = tfCheck(f);
  assert.equal(r.code, 127, combined(r));
  assert.match(r.stderr, /command not found: terraform/);
});

test('F40 ES-1 the missing terraform is an environment stop for verify: 127 with the program named in stderr', async () => {
  const f = fixture({ 'modules/a': 'resource "a" {}\n' }, { withFake: false });
  const { isNotFound } = await import('../lib/exec.mjs');
  const { missingProgram } = await import('../lib/verify.mjs');
  const r = tfCheck(f);
  assert.equal(isNotFound({ code: r.code, stderr: r.stderr }), true);
  assert.equal(missingProgram('harness tf-check', r), 'terraform');
});

test('F40 ES-2 a failed init prints the path and the first 300 chars of its error, the rest is still checked, exit 1', () => {
  const f = fixture({
    'modules/broken': '# FAIL_INIT\n',
    'modules/ok': 'resource "a" {}\n',
    'modules/zbad': '# FAIL_VALIDATE\n',
  });
  const r = tfCheck(f);
  assert.equal(r.code, 1, combined(r));
  const out = norm(combined(r));
  assert.match(out, /modules\/broken/);
  const errText = `Error: Failed to query available provider packages ${'x'.repeat(400)}`;
  assert.ok(out.includes(errText.slice(0, 300)), 'first 300 chars of the init error');
  assert.ok(!out.includes(errText.slice(0, 301)), 'and no more than 300');
  assert.match(out, /modules\/zbad/);

  const calls = readLog(f.log);
  const rel = (c) => path.relative(f.root, c.cwd).split(path.sep).join('/');
  assert.deepEqual(calls.filter((c) => c.sub === 'init').map(rel).sort(), ['modules/broken', 'modules/ok', 'modules/zbad']);
  // validate is skipped where init failed, and runs for the modules after it.
  assert.deepEqual(calls.filter((c) => c.sub === 'validate').map(rel).sort(), ['modules/ok', 'modules/zbad']);
  assert.equal(calls.filter((c) => c.sub === 'fmt').length, 1);
});
