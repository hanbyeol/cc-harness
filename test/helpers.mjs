import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(REPO, 'bin', 'harness.mjs');

// Temp dirs are removed when the test process exits (node --test runs one process per file):
// left behind, ~240k of them filled $TMPDIR until git could no longer create temp files.
// HARNESS_KEEP_TMP=1 keeps them for debugging.
const created = [];
process.on('exit', () => {
  if (process.env.HARNESS_KEEP_TMP === '1') return;
  for (const d of created) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

export function tmpdir(prefix = 'harness-test-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(d);
  return d;
}

// Telemetry is on by default (F63): every run and eval exports to the hub. Tests export to a hub
// of their own, never to the user's (<home>/.cc-harness/hub or a CC_HARNESS_HUB they set).
// Child processes inherit it; a test that needs another hub passes CC_HARNESS_HUB itself.
export const TEST_HUB = path.join(tmpdir('harness-test-hub-'), 'hub');
process.env.CC_HARNESS_HUB = TEST_HUB;

// An export creates the installation's salt in <home>/.cc-harness/salt (F101): tests use a home
// of their own (HOME, and USERPROFILE on Windows), never the user's.
export const TEST_HOME = tmpdir('harness-test-home-');
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

// Every `harness run` in the tests would otherwise start a real caffeinate (F77). Tests that
// check the inhibitor itself remove this from the env they pass.
process.env.HARNESS_TEST_NO_SLEEP_INHIBITOR = '1';

// Runs the real CLI as a child process.
export function harness(args, { cwd, env } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// A project directory with initialized .harness state.
export function project(features = []) {
  const dir = tmpdir();
  harness(['init'], { cwd: dir });
  writeJson(path.join(dir, '.harness', 'features.json'), { features });
  return dir;
}

// A PATH directory holding one fake executable `name` (Windows: `name.cmd`) with `content`,
// created once per content in <tmpdir>/cc-harness-fake-bin-<hash> and reused (F106): macOS
// checks every new executable on its first run ("verifying ..." window, up to 33 s under load),
// so a fresh file per test made that check run again and again. Per-test data (log paths)
// goes in environment variables or beside a fakeExecutableLink, not in `content`. Not removed
// at exit — reuse is the point.
export function fakeExecutable(name, content) {
  const hash = createHash('sha256').update(`${name}\0${content}`).digest('hex').slice(0, 16);
  const dir = path.join(os.tmpdir(), `cc-harness-fake-bin-${hash}`);
  const file = path.join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
  if (intactFake(file, content)) return dir;
  fs.mkdirSync(dir, { recursive: true });
  // Written under a temporary name and renamed: a concurrent caller sees no file or a whole one.
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o755 });
    fs.chmodSync(tmp, 0o755); // the umask may have cleared bits of the mode above
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    // Windows refuses to replace a file another process has open; a whole one is fine.
    if (!intactFake(file, content)) throw e;
  }
  return dir;
}

function intactFake(file, content) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (process.platform !== 'win32' && (st.mode & 0o777) !== 0o755) return false;
    return fs.readFileSync(file, 'utf8') === content;
  } catch {
    return false;
  }
}

// The variable the fake sleep inhibitors write their logs to (a directory).
export const FAKE_INHIBIT_LOG = 'HARNESS_FAKE_INHIBIT_LOG';

/**
 * Fake `caffeinate` and `systemd-inhibit` (sh scripts: they start as fast as the real ones),
 * each in its own fakeExecutable directory; returns those directories, to put first on PATH.
 * Each writes its name, pid, parent pid and arguments to $HARNESS_FAKE_INHIBIT_LOG/<pid>.txt,
 * then stays alive ('stay', exec keeps the pid) or exits at once ('exit'). `--warm-up` exits 0
 * without logging.
 */
export function fakeInhibitorDirs(mode = 'stay') {
  return ['caffeinate', 'systemd-inhibit'].map((name) => fakeExecutable(name, `#!/bin/sh
[ "$1" = "--warm-up" ] && exit 0
printf '%s\\n' "${name}" "$$" "$PPID" "$@" > "$${FAKE_INHIBIT_LOG}/$$.tmp" && mv "$${FAKE_INHIBIT_LOG}/$$.tmp" "$${FAKE_INHIBIT_LOG}/$$.txt"
${mode === 'exit' ? 'exit 1' : 'exec sleep 1000'}
`));
}

// A fakeExecutable `name` that runs the node script `script` with `args` before its own
// arguments (Windows: a .cmd wrapper, elsewhere a sh wrapper). Returns its directory.
export function fakeNodeCli(name, script, args = []) {
  const pre = args.map((a) => ` ${a}`).join('');
  return fakeExecutable(name, process.platform === 'win32'
    ? `@"${process.execPath}" "${script}"${pre} %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}"${pre} "$@"\n`);
}

// A fresh directory (realpath, removed at exit) holding a symlink `name` to the fakeExecutable
// for `content`, for fakes whose per-test data cannot come from the environment (the core passes
// git only allowlisted variables) or that need a PATH entry of their own: the file is still
// checked once, while `$(dirname "$0")` in the script is this directory, a place for that
// test's logs. POSIX only (symlinks).
export function fakeExecutableLink(name, content, prefix = 'harness-fake-link-') {
  const dir = fs.realpathSync(tmpdir(prefix));
  fs.symlinkSync(path.join(fakeExecutable(name, content), name), path.join(dir, name));
  return dir;
}
