// F14: Windows portability found by the first windows-latest CI run. Platform-specific
// behaviour is injected (platform, path implementation) so every OS runs every test.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isNotFound, runCommand } from '../lib/exec.mjs';
import { noV1Message } from '../lib/commands/migrate-v1.mjs';

const WIN_MSG = "'harness-no-such-exe-7d1' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n";

test('F14 AC-1 win32: exit 1 with the cmd.exe not-recognized message is command not found', () => {
  assert.equal(isNotFound({ code: 1, stderr: WIN_MSG }, 'win32'), true);
});

test('F14 AC-2 POSIX 127, cmd.exe 9009 and ENOENT stay command not found', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.equal(isNotFound({ code: 127, stderr: '' }, platform), true);
    assert.equal(isNotFound({ code: 9009, stderr: '' }, platform), true);
    assert.equal(isNotFound({ code: null, error: 'ENOENT', stderr: '' }, platform), true);
  }
});

test('F14 AC-3 exit 1 without the message, or off win32, is a plain failure', () => {
  assert.equal(isNotFound({ code: 1, stderr: 'boom\n' }, 'win32'), false);
  assert.equal(isNotFound({ code: 1, stderr: WIN_MSG }, 'linux'), false);
  assert.equal(isNotFound({ code: 2, stderr: WIN_MSG }, 'win32'), false);
});

test('F14 AC-4 migrate-v1 shows progress/feature_list.json with slashes under a win32 path implementation', () => {
  const lines = noV1Message('C:\\work\\proj', path.win32);
  assert.match(lines[0], /progress\/feature_list\.json does not exist in C:\\work\\proj/);
  assert.match(noV1Message('/work/proj', path.posix)[0], /progress\/feature_list\.json/);
});

test('F14 SC-1 a leftover child cannot stall runCommand on any platform', async () => {
  const leftover = { file: process.execPath, args: ['-e', "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit' }).unref(); console.log('started')"] };
  const started = Date.now();
  const r = await runCommand(leftover, { cwd: process.cwd(), timeoutSec: 1 });
  assert.ok(Date.now() - started < 5000, `returned after ${Date.now() - started} ms`);
  if (process.platform === 'win32') assert.equal(r.timedOut, false); // pipes are not held there
  else assert.equal(r.timedOut, true);
});

test('F14 ES-1 a non-English cmd.exe message with exit 1 is a plain failure, no throw', () => {
  const localized = "'x'은(는) 내부 또는 외부 명령, 실행할 수 있는 프로그램, 또는 배치 파일이 아닙니다.\r\n";
  assert.doesNotThrow(() => isNotFound({ code: 1, stderr: localized }, 'win32'));
  assert.equal(isNotFound({ code: 1, stderr: localized }, 'win32'), false);
  assert.equal(isNotFound({ code: 1 }, 'win32'), false); // no stderr at all
});
