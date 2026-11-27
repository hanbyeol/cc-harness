import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir, BIN, REPO } from './helpers.mjs';

function autoAllow(command, cwd) {
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });
  const r = spawnSync(process.execPath, [BIN, 'auto-allow'], { cwd, input, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const ALLOW = {
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'cc-harness core command' },
};
function assertAllow(command, cwd, what = command) {
  const r = autoAllow(command, cwd);
  assert.equal(r.code, 0, `${what}: ${r.stderr}`);
  assert.ok(r.stdout, `${what}: expected an allow decision, got nothing`);
  assert.deepEqual(JSON.parse(r.stdout), ALLOW, what);
}
function assertSilent(command, cwd, what = command) {
  const r = autoAllow(command, cwd);
  assert.equal(r.code, 0, `${what}: ${r.stderr}`);
  assert.equal(r.stdout, '', what);
  assert.equal(r.stderr, '', what);
}

// A path to the running bin/harness.mjs that contains a backslash: on win32 the native BIN path;
// elsewhere a symlink to BIN inside a directory whose name contains a backslash. `cwd` is a
// plain project directory; the path is absolute so it does not depend on it.
function backslashBin() {
  const cwd = realTmpdir('f184-');
  if (process.platform === 'win32') return { cwd, p: fs.realpathSync.native(BIN) };
  const d = path.join(cwd, 'D:\\a\\bin');
  fs.mkdirSync(d);
  const p = path.join(d, 'harness.mjs');
  fs.symlinkSync(BIN, p);
  assert.ok(p.includes('\\'));
  return { cwd, p };
}

test('F184 AC-1 a quoted node path with backslashes to the running bin/harness.mjs is allowed', () => {
  const { cwd, p } = backslashBin();
  assertAllow(`node '${p}' status --brief`, cwd, 'single-quoted');
  assertAllow(`node "${p}" status --brief`, cwd, 'double-quoted');
  assertAllow(`node '${p}' verify F1 2>&1 | tail -20`, cwd, 'with 2>&1 and tail');
});

test('F184 SC-1 backslashes anywhere else, or in a path that is not the running harness, print nothing', () => {
  const { cwd, p } = backslashBin();
  assertAllow(`node '${p}' status`, cwd, 'contrast: the AC-1 path');
  for (const c of [
    'node C:\\x\\bin\\harness.mjs status',
    'node "C:\\evil\\harness.mjs" status',
    "node 'C:\\evil\\harness.mjs' status",
    'harness status "a\\b"',
    "harness status 'a\\b'",
    `node '${p}' status 'a\\b'`,
    `node '${p}' "st\\atus"`,
    `node '${p}' st\\atus`,
    'harness\\ status',
    "'harness\\' status",
    'harness status | grep "a\\b"',
    `node '${p}' status | grep 'a\\b'`,
  ]) assertSilent(c, cwd, JSON.stringify(c));
});

test('F184 SC-2 in double quotes a backslash before a quote, backslash, dollar or backtick prints nothing', () => {
  const { cwd, p } = backslashBin();
  const dir = path.dirname(p);
  // Contrast: a backslash followed by a letter or digit in double quotes is allowed.
  assertAllow(`node "${p}" status`, cwd, 'contrast: double-quoted AC-1 path');
  for (const esc of ['\\"', '\\\\', '\\$', '\\`']) {
    assertSilent(`node "${dir}${esc}harness.mjs" status`, cwd, `double quotes with ${esc}`);
    assertSilent(`node "${p}${esc}" status`, cwd, `double quotes ending with ${esc}`);
  }
  assertSilent(`node "${p}\\" status"`, cwd, 'escaped closing quote');
  if (process.platform !== 'win32') {
    // Single quotes are literal: a directory whose name holds `\\` is judged like AC-1.
    const d2 = path.join(cwd, 'x\\\\y');
    fs.mkdirSync(d2);
    fs.symlinkSync(BIN, path.join(d2, 'harness.mjs'));
    assertAllow(`node '${path.join(d2, 'harness.mjs')}' status`, cwd, 'single quotes are literal');
    assertSilent(`node "${path.join(d2, 'harness.mjs')}" status`, cwd, 'same path in double quotes');
  }
});

test('F184 ES-1 a quoted backslash path to a missing file prints nothing and exits 0', () => {
  const { cwd, p } = backslashBin();
  const missing = path.join(path.dirname(p), 'missing\\harness.mjs');
  assertAllow(`node '${p}' status`, cwd, 'contrast: the existing AC-1 path');
  assertSilent(`node '${missing}' status`, cwd);
  assertSilent(`node "${missing}" status`, cwd);
  assertSilent('node "C:\\does\\not\\exist\\harness.mjs" status', cwd);
});

test('F184 AC-3 SPEC 8.13 says backslashes are allowed only in the quoted node <p> path', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const start = spec.indexOf('### 8.13');
  assert.ok(start !== -1);
  const section = spec.slice(start, spec.indexOf('\n## ', start));
  const paras = section.split('\n').filter((l) => /backslash|백슬래시/.test(l) && l.includes('node <p>'));
  assert.ok(paras.length > 0, 'a paragraph of 8.13 names the backslash and node <p>');
});
