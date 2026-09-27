// F44: exit 127 is "command not found" only when stderr names the command's first program with
// 'not found'/'No such file'; 'harness …' verify commands and checks run the core's own bin;
// the conflict-marker scan after a conflict resolution does not follow symbolic links.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, BIN, tmpdir } from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { verify } from '../lib/verify.mjs';
import { commandNotFound, firstProgram, builtinInvocation } from '../lib/exec.mjs';
import { conflictMarkedFiles } from '../lib/run.mjs';

const MISSING = 'harness-f44-no-such-prog';
const EXIT127 = 'node -e "process.exit(127)"';
const posix = process.platform !== 'win32';

// A repo on branch `feature` whose F9 contract has `checks` ([id, check, new]).
function fixture(checks = []) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': {
      id: 'F9', title: 'fixture', security_tier: 'standard', version: 1,
      acceptance_criteria: checks.map(([id, check, isNew = false]) => ({ id, criterion: id, check, new: isNew })),
      security_criteria: [], error_scenarios: [], out_of_scope: [],
    },
  });
}
const run = (dir, verifyCfg = {}) => verify({
  root: dir, featureId: 'F9', base: 'main', cpus: 1,
  config: resolveConfig({ base_branch: 'main', verify: { commands: [], ...verifyCfg }, budget: { step_timeout_sec: 60 } }),
});

// ---------- AC-1 ----------
test('F44 AC-1: a verify command that exits 127 by itself (node) is a plain failure', async () => {
  const r = await run(fixture(), { commands: [EXIT127] });
  const c = r.commands[0];
  assert.equal(c.pass, false);
  assert.equal(c.notFound, undefined, JSON.stringify(c));
  assert.equal(c.message, 'exit 127');
});

test('F44 AC-1: a verify command sh -c "exit 127" is a plain failure', async () => {
  if (!posix) return; // cmd.exe has no sh; the node form above covers Windows
  const r = await run(fixture(), { commands: ['sh -c "exit 127"'] });
  const c = r.commands[0];
  assert.equal(c.notFound, undefined, JSON.stringify(c));
  assert.equal(c.message, 'exit 127');
});

test('F44 AC-1: a verify command whose program is missing is command not found', async () => {
  const r = await run(fixture(), { commands: [`${MISSING} --flag`] });
  const c = r.commands[0];
  assert.equal(c.notFound, MISSING, JSON.stringify(c));
  assert.match(c.message, new RegExp(`command not found: ${MISSING}`));
});

test('F44 AC-1: a check that exits 127 by itself is a plain failure', async () => {
  const r = await run(fixture([['AC-1', EXIT127]]));
  const c = r.criteria[0];
  assert.equal(c.pass, false);
  assert.equal(c.notFound, undefined, JSON.stringify(c));
  assert.equal(c.message, 'exit 127');
});

test('F44 AC-1: a check sh -c "exit 127" is a plain failure', async () => {
  if (!posix) return;
  const r = await run(fixture([['AC-1', 'sh -c "exit 127"']]));
  const c = r.criteria[0];
  assert.equal(c.notFound, undefined, JSON.stringify(c));
  assert.equal(c.message, 'exit 127');
});

test('F44 AC-1: a check whose program is missing is command not found', async () => {
  const r = await run(fixture([['AC-1', `${MISSING} AC-1`]]));
  const c = r.criteria[0];
  assert.equal(c.notFound, MISSING, JSON.stringify(c));
  assert.match(c.message, /command not found/);
});

test('F44 AC-1: a test_count command that exits 127 by itself is a plain error', async () => {
  const r = await run(fixture(), { test_count: EXIT127 });
  const tc = r.integrity.testCount;
  assert.equal(tc.status, 'error');
  assert.equal(tc.notFound, undefined, JSON.stringify(tc));
  assert.doesNotMatch(tc.message, /command not found/);
});

test('F44 AC-1: a test_count command whose program is missing is command not found', async () => {
  const r = await run(fixture(), { test_count: MISSING });
  const tc = r.integrity.testCount;
  assert.equal(tc.notFound, MISSING, JSON.stringify(tc));
});

test('F44 AC-1: a new check that exits 127 by itself on base is an ordinary base failure, not base_not_found', async () => {
  const dir = fixture([['AC-1', 'node -e "process.exit(require(\'fs\').existsSync(\'head.txt\') ? 0 : 127)"', true]]);
  fs.writeFileSync(path.join(dir, 'head.txt'), 'x\n');
  const r = await run(dir);
  const c = r.criteria[0];
  assert.equal(c.base_not_found, undefined, JSON.stringify(c));
  assert.equal(c.pass, true, JSON.stringify(c));
});

test('F44 AC-1: the rule — the first program and "not found"/"No such file" on one stderr line', () => {
  const p = 'linux';
  assert.equal(commandNotFound('sh -c "exit 127"', { code: 127, stderr: '' }, p), false);
  assert.equal(commandNotFound('npm test', { code: 127, stderr: 'sh: 1: jest: not found\n' }, p), false);
  assert.equal(commandNotFound('jest --ci', { code: 127, stderr: 'sh: 1: jest: not found\n' }, p), true);
  assert.equal(commandNotFound('jest', { code: 127, stderr: 'bash: jest: command not found\n' }, p), true);
  assert.equal(commandNotFound('jest', { code: 127, stderr: 'zsh:1: command not found: jest\n' }, p), true);
  assert.equal(commandNotFound('./run.sh', { code: 127, stderr: 'bash: line 1: ./run.sh: No such file or directory\n' }, p), true);
  assert.equal(commandNotFound('CI=1 FOO="a b" jest', { code: 127, stderr: 'sh: 1: jest: not found\n' }, p), true);
  // the name and the phrase on different lines, or the name only inside a longer word
  assert.equal(commandNotFound('jest', { code: 127, stderr: 'jest\nsomething not found\n' }, p), false);
  assert.equal(commandNotFound('sh x.sh', { code: 127, stderr: 'x.sh: 3: tool: not found\n' }, p), false);
  assert.equal(commandNotFound('jest', { code: 1, stderr: 'sh: 1: jest: not found\n' }, p), false);
  assert.equal(commandNotFound('jest', { code: null, error: 'ENOENT', stderr: '' }, p), true);
  assert.equal(firstProgram('CI=1 FOO="a b" jest --ci'), 'jest');
  assert.equal(firstProgram('  node test/t.mjs'), 'node');
});

// ---------- AC-2 / SC-1 ----------
// A child `harness verify` with a PATH made of the directory holding git plus `extra` dirs.
const pathKeys = (env) => Object.keys(env).filter((k) => k.toUpperCase() === 'PATH');
function gitDir() {
  const exe = posix ? ['git'] : ['git.exe', 'git.cmd'];
  for (const d of (process.env[pathKeys(process.env)[0]] || '').split(path.delimiter).filter(Boolean)) {
    if (exe.some((e) => fs.existsSync(path.join(d, e)))) return d;
  }
  throw new Error('git not found on PATH');
}
function childVerify(dir, extra) {
  const env = { ...process.env };
  for (const k of pathKeys(env)) delete env[k];
  env.PATH = [...extra, gitDir()].join(path.delimiter);
  const r = spawnSync(process.execPath, [BIN, 'verify', 'F9', '--json'], { cwd: dir, env, encoding: 'utf8' });
  assert.ok(r.stdout.trim().startsWith('{'), `${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout);
}
// A PATH-first program `name` that appends its name to `<cwd>/ran.txt` and exits `exit`.
function fakeProgram(dir, name, exit) {
  const script = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(script, `require('node:fs').appendFileSync('ran.txt', '${name}\\n'); process.exit(${exit});\n`);
  if (posix) {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  } else {
    fs.writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  }
}
const withConfig = (dir, verifyCfg) => fs.writeFileSync(path.join(dir, '.harness/config.json'),
  JSON.stringify({ profile: 'sdlc', base_branch: 'main', verify: { commands: [], ...verifyCfg } }));
const ranIn = (dir) => (fs.existsSync(path.join(dir, 'ran.txt')) ? fs.readFileSync(path.join(dir, 'ran.txt'), 'utf8').split('\n').filter(Boolean) : []);
const noHarnessIn = (d) => ['harness', 'harness.cmd', 'harness.exe', 'harness.ps1'].every((n) => !fs.existsSync(path.join(d, n)));

test('F44 AC-2: "harness tf-check" as a verify command runs the core itself when PATH has no harness', () => {
  const bin = tmpdir('harness-f44-bin-');
  fakeProgram(bin, 'terraform', 0); // tf-check's fmt -check passes
  assert.ok(noHarnessIn(bin) && noHarnessIn(gitDir()), 'fixture PATH has no harness');
  const dir = fixture([['AC-1', 'harness tf-check']]);
  withConfig(dir, { commands: ['harness tf-check'] });
  const r = childVerify(dir, [bin]);
  assert.equal(r.commands[0].pass, true, JSON.stringify(r.commands[0]));
  assert.equal(r.criteria[0].pass, true, JSON.stringify(r.criteria[0]));
  assert.deepEqual(ranIn(dir), ['terraform', 'terraform'], 'tf-check ran terraform once per run');
});

test('F44 AC-2: a "harness" on PATH is not used for a "harness …" verify command', () => {
  const bin = tmpdir('harness-f44-bin-');
  fakeProgram(bin, 'terraform', 0);
  fakeProgram(bin, 'harness', 3); // a decoy: running it would fail the command
  const dir = fixture();
  withConfig(dir, { commands: ['harness tf-check'] });
  const r = childVerify(dir, [bin]);
  assert.equal(r.commands[0].pass, true, JSON.stringify(r.commands[0]));
  assert.ok(!ranIn(dir).includes('harness'), 'the decoy did not run');
});

test('F44 AC-2: builtinInvocation runs bin/harness.mjs under the current node with the words as arguments', () => {
  assert.deepEqual(builtinInvocation('harness tf-check --dir modules/a'),
    { file: process.execPath, args: [BIN, 'tf-check', '--dir', 'modules/a'] });
  assert.deepEqual(builtinInvocation('harness  verify   F1'), { file: process.execPath, args: [BIN, 'verify', 'F1'] });
});

test('F44 SC-1: "harness tf-check; echo pwned" is not run built in — the shell handles it', () => {
  assert.equal(builtinInvocation('harness tf-check; echo pwned'), null);
  const bin = tmpdir('harness-f44-bin-');
  fakeProgram(bin, 'harness', 0);
  const dir = fixture();
  withConfig(dir, { commands: ['harness tf-check; echo pwned > pwned.txt'] });
  const r = childVerify(dir, [bin]);
  assert.equal(r.commands[0].pass, true, JSON.stringify(r.commands[0]));
  assert.deepEqual(ranIn(dir), ['harness'], 'the PATH harness ran through the shell');
  assert.ok(fs.existsSync(path.join(dir, 'pwned.txt')), 'the shell ran the second command');
});

test('F44 SC-1: only an exact "harness " prefix with plain words is built in', () => {
  for (const cmd of [
    'harness tf-check && echo x', 'harness tf-check | cat', 'harness tf-check > out', 'harness tf-check < in',
    'harness $(echo tf-check)', 'harness `echo tf-check`', 'harness "tf-check"', "harness 'tf-check'",
    'harness tf-check\necho x', 'harness tf-check\techo', 'harness %PATH%', 'harness ~/x', 'harness a\\b',
    'harness $HOME', 'harness tf-check &', 'harness a*', ' harness tf-check', 'harness', 'harness ', 'harnessx tf-check',
    'HARNESS tf-check', 'harness\ttf-check', 'npx harness tf-check', 'harness a;b',
  ]) {
    assert.equal(builtinInvocation(cmd), null, JSON.stringify(cmd));
  }
});

// ---------- AC-3 ----------
test('F44 AC-3: the conflict-marker scan does not follow a link to a file outside the repository', (t) => {
  const outside = tmpdir('harness-f44-outside-');
  const secret = path.join(outside, 'secret.txt');
  fs.writeFileSync(secret, '<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n');
  const wt = tmpdir('harness-f44-wt-');
  fs.writeFileSync(path.join(wt, 'real.txt'), '<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n');
  fs.writeFileSync(path.join(wt, 'clean.txt'), 'ok\n');
  try {
    fs.symlinkSync(secret, path.join(wt, 'link.txt'), 'file');
  } catch (e) {
    if (e.code === 'EPERM' && !posix) return; // Windows without symlink privilege cannot build the fixture
    throw e;
  }
  const read = [];
  const orig = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...rest) {
    read.push(String(file));
    return orig.call(fs, file, ...rest);
  });
  const marked = conflictMarkedFiles(wt, ['link.txt', 'real.txt', 'clean.txt', 'gone.txt']);
  assert.deepEqual(marked, ['real.txt']);
  assert.ok(!read.some((f) => f.endsWith('link.txt') || f.endsWith('secret.txt')), `read: ${read.join(', ')}`);
});

// ---------- AC-4 ----------
test('F44 AC-4: SPEC §6 and §8 describe the 127 rule, the built-in harness run and the lstat marker scan', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s6 = spec.slice(spec.indexOf('\n## 6. '), spec.indexOf('\n## 7. '));
  const s8 = spec.slice(spec.indexOf('\n## 8. '), spec.indexOf('\n## 9. '));
  const rule127 = s6.split('\n').find((l) => l.includes('exit 127') && l.includes('첫 프로그램'));
  assert.ok(rule127 && rule127.includes('not found') && rule127.includes('No such file') && rule127.includes('일반 실패'), 'SPEC §6: 127 rule');
  assert.ok(rule127.includes('9009'), 'SPEC §6: Windows rule unchanged');
  const builtin = s6.split('\n').find((l) => l.includes('`harness `') && l.includes('bin/harness.mjs'));
  assert.ok(builtin && builtin.includes('셸 없이') && builtin.includes('harness tf-check; echo pwned'), 'SPEC §6: built-in harness');
  const env8 = s8.split('\n').find((l) => l.startsWith('환경 실패'));
  assert.ok(env8 && env8.includes('첫 프로그램'), 'SPEC §8: environment failure follows the 127 rule');
  const marker8 = s8.split('\n').find((l) => l.includes('**충돌 표시**'));
  assert.ok(marker8 && marker8.includes('lstat') && marker8.includes('심볼릭 링크'), 'SPEC §8: lstat marker scan');
});

// ---------- ES-1 ----------
test('F44 ES-1: the Windows forms (exit 9009, "is not recognized") are judged as before', () => {
  const WIN = "'jest' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n";
  assert.equal(commandNotFound('npm test', { code: 9009, stderr: '' }, 'win32'), true);
  assert.equal(commandNotFound('npm test', { code: 1, stderr: WIN }, 'win32'), true);
  assert.equal(commandNotFound('npm test', { code: 1, stderr: `output\n${WIN}` }, 'win32'), false);
  assert.equal(commandNotFound('npm test', { code: 1, stderr: WIN }, 'linux'), false);
  assert.equal(commandNotFound('jest', { code: null, error: 'ENOENT', stderr: '' }, 'win32'), true);
});
