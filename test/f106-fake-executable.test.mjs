// F106: fake executables are made once per content (fakeExecutable) and reused.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { FAKE_INHIBIT_LOG, REPO, fakeExecutable, fakeInhibitorDirs, tmpdir } from './helpers.mjs';

const WIN = process.platform === 'win32';
const HELPERS = path.join(REPO, 'test', 'helpers.mjs');
const fileName = (name) => (WIN ? `${name}.cmd` : name);
const exitZero = (pad = '') => (WIN ? `@rem ${pad}\r\n@exit /b 0\r\n` : `#!/bin/sh\n# ${pad}\nexit 0\n`);
const hashDir = (name, content) => path.join(os.tmpdir(),
  `cc-harness-fake-bin-${createHash('sha256').update(`${name}\0${content}`).digest('hex').slice(0, 16)}`);

// The temp-directory variables os.tmpdir() reads, pointed at a fresh empty directory (removed
// at exit) while fn runs, so no fake made here outlives the test.
const TMP_VARS = ['TMPDIR', 'TEMP', 'TMP'];
async function withEmptyTmp(fn) {
  const dir = fs.realpathSync(tmpdir('harness-f106-tmp-'));
  const saved = TMP_VARS.map((k) => process.env[k]);
  for (const k of TMP_VARS) process.env[k] = dir;
  try {
    return await fn(dir);
  } finally {
    TMP_VARS.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  }
}

// Runs a fake: directly on POSIX, through cmd.exe for a .cmd file.
function runFake(file, env = process.env) {
  return WIN
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${file}"`], { env, encoding: 'utf8', windowsVerbatimArguments: true, timeout: 120_000 })
    : spawnSync(file, [], { env, encoding: 'utf8', timeout: 120_000 });
}

const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));

// ------------------------------------------------------------------ AC-1
test('F106 AC-1 fakeExecutable returns <tmpdir>/cc-harness-fake-bin-<sha256 16 hex> holding name (0755, the content as is)', async () => {
  await withEmptyTmp(() => {
    const content = exitZero('ac-1');
    const dir = fakeExecutable('fk', content);
    assert.equal(dir, hashDir('fk', content));
    assert.match(path.basename(dir), /^cc-harness-fake-bin-[0-9a-f]{16}$/);
    const file = path.join(dir, fileName('fk'));
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    if (!WIN) assert.equal(fs.statSync(file).mode & 0o777, 0o755);
    assert.deepEqual(fs.readdirSync(dir), [fileName('fk')]);
    assert.equal(runFake(file).status, 0);
  });
});

test('F106 AC-1 a second call with the same arguments returns the same path and does not rewrite the file', async () => {
  await withEmptyTmp(async () => {
    const content = exitZero('again');
    const dir = fakeExecutable('fk', content);
    const file = path.join(dir, fileName('fk'));
    const before = fs.statSync(file);
    // A rewrite within the same millisecond could keep mtime: let the clock move on first.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fakeExecutable('fk', content), dir);
    const after = fs.statSync(file);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
  });
});

test('F106 AC-1 different arguments give different directories', async () => {
  await withEmptyTmp(() => {
    const a = fakeExecutable('fk', exitZero('a'));
    const b = fakeExecutable('fk', exitZero('b'));
    const c = fakeExecutable('fk2', exitZero('a'));
    assert.equal(new Set([a, b, c]).size, 3);
    assert.equal(fs.readFileSync(path.join(a, fileName('fk')), 'utf8'), exitZero('a'));
    assert.equal(fs.readFileSync(path.join(b, fileName('fk')), 'utf8'), exitZero('b'));
    assert.equal(fs.readFileSync(path.join(c, fileName('fk2')), 'utf8'), exitZero('a'));
  });
});

// ------------------------------------------------------------------ AC-2
// A child that waits for `go`, then calls fakeExecutable and prints the directory. The content
// is large (about 200 KB) so a reader of a half-written file would see a cut-off script.
const CHILD = `
import fs from 'node:fs';
import { fakeExecutable } from ${JSON.stringify(pathToFileURL(HELPERS).href)};
const [ready, go] = process.argv.slice(1);
fs.writeFileSync(ready, '');
for (let t = Date.now(); !fs.existsSync(go) && Date.now() - t < 120000;) await new Promise((r) => setTimeout(r, 5));
const pad = 'x'.repeat(200000);
const content = process.platform === 'win32' ? '@rem ' + pad + '\\r\\n@exit /b 0\\r\\n' : '#!/bin/sh\\n# ' + pad + '\\nexit 0\\n';
process.stdout.write(fakeExecutable('fk-race', content));
`;

test('F106 AC-2 four processes calling fakeExecutable at once in an empty tmpdir all get the same complete file', async () => {
  await withEmptyTmp(async (tmp) => {
    assert.deepEqual(fs.readdirSync(tmp), []);
    const sync = fs.realpathSync(tmpdir('harness-f106-sync-'));
    const go = path.join(sync, 'go');
    const children = [0, 1, 2, 3].map((i) => {
      const ready = path.join(sync, `ready-${i}`);
      const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, ready, go], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (b) => { out += b; });
      child.stderr.on('data', (b) => { err += b; });
      const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })));
      return { ready, done };
    });
    for (let t = Date.now(); !children.every((c) => fs.existsSync(c.ready)) && Date.now() - t < 120_000;) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(children.every((c) => fs.existsSync(c.ready)), 'all four children started');
    fs.writeFileSync(go, '');
    const results = await Promise.all(children.map((c) => c.done));
    for (const r of results) assert.equal(r.code, 0, r.err);
    const dirs = new Set(results.map((r) => r.out));
    assert.equal(dirs.size, 1, [...dirs].join('\n'));
    const [dir] = dirs;
    assert.equal(path.dirname(dir), tmp);
    const file = path.join(dir, fileName('fk-race'));
    for (const r of results) {
      const got = runFake(path.join(r.out, fileName('fk-race')));
      assert.equal(got.status, 0, got.stderr);
    }
    assert.ok(fs.readFileSync(file, 'utf8').length > 200000);
    assert.deepEqual(leftovers(dir), []);
  });
});

// ------------------------------------------------------------------ AC-3
test('F106 AC-3 one fake caffeinate / systemd-inhibit logs to the directory in HARNESS_FAKE_INHIBIT_LOG of each run', async (t) => {
  if (WIN) { t.diagnostic('the fake inhibitors are shebang scripts'); return; }
  const dirs = fakeInhibitorDirs('exit');
  assert.deepEqual(fakeInhibitorDirs('exit'), dirs, 'the same fakes are reused');
  for (const [i, name] of ['caffeinate', 'systemd-inhibit'].entries()) {
    const file = path.join(dirs[i], name);
    const logs = [tmpdir('harness-f106-log-a-'), tmpdir('harness-f106-log-b-')];
    for (const [j, log] of logs.entries()) {
      const r = spawnSync(file, ['-i', `run-${j}`], { env: { ...process.env, [FAKE_INHIBIT_LOG]: log }, encoding: 'utf8', timeout: 120_000 });
      assert.equal(r.status, 1, r.stderr); // 'exit' mode
    }
    for (const [j, log] of logs.entries()) {
      const entries = fs.readdirSync(log).filter((n) => n.endsWith('.txt'));
      assert.equal(entries.length, 1, `${name} logged once in ${log}: ${entries}`);
      const [logged, pid, , ...argv] = fs.readFileSync(path.join(log, entries[0]), 'utf8').replace(/\n$/, '').split('\n');
      assert.equal(logged, name);
      assert.ok(Number(pid) > 0);
      assert.deepEqual(argv, ['-i', `run-${j}`]);
    }
    assert.ok(!fs.readFileSync(file, 'utf8').includes(logs[0]), 'the log place is not in the fake');
  }
});

// ------------------------------------------------------------------ AC-4
const EXEC_SHAPES = ['harness-' + 'inhibit-', 'harness-' + 'bin-'];
// A chmodSync whose mode is a number literal; the mode gives execute permission when it has the
// owner execute bit, except 0o555 (taking write permission away from a directory).
const CHMOD = /chmodSync\(([^()]|\([^()]*\))*?,\s*(0o[0-7]+|0x[0-9a-fA-F]+|\d+)\s*\)/g;
const grantsExec = (literal) => {
  const mode = Number(literal.startsWith('0') && /^0[0-7]+$/.test(literal) ? `0o${literal.slice(1)}` : literal);
  return (mode & 0o100) !== 0 && mode !== 0o555;
};

function testSources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.test.mjs')) out.push(p);
    }
  };
  walk(path.join(REPO, 'test'));
  return out;
}

test('F106 AC-4 the source check flags execute modes and keeps the permission-removing ones', () => {
  const flagged = (src) => [...src.matchAll(CHMOD)].filter((m) => grantsExec(m[2])).map((m) => m[2]);
  for (const mode of ['0o755', '0o775', '0o700', '0o711', '0o100', '0o744', '493']) {
    assert.deepEqual(flagged(`fs.chmodSync(path.join(dir, 'git'), ${mode});`), [mode]);
  }
  for (const mode of ['0', '0o000', '0o555', '0o644', '0o600', '0o444']) {
    assert.deepEqual(flagged(`fs.chmodSync(file, ${mode});`), []);
  }
});

test('F106 AC-4 no test file gives execute permission with chmodSync or makes harness-inhibit-/harness-bin- temp dirs', () => {
  const files = testSources();
  assert.ok(files.length > 50, `test files found: ${files.length}`);
  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(CHMOD)) if (grantsExec(m[2])) hits.push(`${path.basename(f)}: ${m[0]}`);
    for (const shape of EXEC_SHAPES) if (src.includes(`'${shape}`) || src.includes(`"${shape}`) || src.includes(`\`${shape}`)) hits.push(`${path.basename(f)}: ${shape}`);
  }
  assert.deepEqual(hits, []);
});

// ------------------------------------------------------------------ ES-1
test('F106 ES-1 a damaged file in the hash directory (other content) is replaced atomically by the right one', async () => {
  await withEmptyTmp(() => {
    const content = exitZero('es-1');
    const dir = fakeExecutable('fk', content);
    const file = path.join(dir, fileName('fk'));
    fs.writeFileSync(file, content.slice(0, 5)); // cut off, as a crash mid-write would leave it
    const before = fs.statSync(file).ino;
    assert.equal(fakeExecutable('fk', content), dir);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    if (!WIN) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o755);
      assert.notEqual(fs.statSync(file).ino, before, 'a new file renamed into place, not written in place');
    }
    assert.deepEqual(leftovers(dir), []);
    assert.equal(runFake(file).status, 0);
  });
});

test('F106 ES-1 a file in the hash directory with the wrong mode is replaced by an executable one', async (t) => {
  if (WIN) { t.diagnostic('file modes do not apply here'); return; }
  await withEmptyTmp(() => {
    const content = exitZero('es-1-mode');
    const dir = fakeExecutable('fk', content);
    const file = path.join(dir, 'fk');
    fs.chmodSync(file, 0o644);
    assert.equal(fakeExecutable('fk', content), dir);
    assert.equal(fs.statSync(file).mode & 0o777, 0o755);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    assert.deepEqual(leftovers(dir), []);
    assert.equal(runFake(file).status, 0);
  });
});
