import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { harness, REPO, tmpdir } from './helpers.mjs';
import { git, gitRepo } from './gitfixture.mjs';
import { recordEvent } from '../lib/events.mjs';
import { redactor, redactDeep } from '../lib/failures.mjs';
import { planExport, readSalt, saltFile } from '../lib/telemetry.mjs';
import { runExport } from '../lib/commands/export.mjs';
import { HarnessError } from '../lib/errors.mjs';

// F107: telemetry follow-ups — dry-run creates no salt, the CC_HARNESS_TELEMETRY warning once per
// process, event re-redaction covers keys, salts in either case, planExport needs a salt.

const sha16 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 16);

function fixture(config = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, telemetry: { share: true }, ...config },
    '.harness/features.json': { features: [] },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\nevents/\n',
  }, { branch: null });
}

const listFiles = (d) => {
  try { return fs.readdirSync(d).sort(); } catch { return []; }
};
const localId = (dir) => sha16(git(dir, 'rev-parse', '--show-toplevel'));
const saltPath = (home) => path.join(home, '.cc-harness', 'salt');
const ci = (dir, tests) => recordEvent(dir, { stage: 'feedback', type: 'ci', data: { sha: 'abc123', result: 'failure', tests } }, { now: new Date('2026-09-01T00:00:00Z') });
const homeEnv = (home, hub, extra = {}) => ({ HOME: home, USERPROFILE: home, CC_HARNESS_HUB: hub, CC_HARNESS_TELEMETRY: '', ...extra });
const bundlesOf = (hub) => listFiles(hub).flatMap((p) => listFiles(path.join(hub, p)).map((n) => path.join(hub, p, n)));
const writeSalt = (home, text) => {
  fs.mkdirSync(path.join(home, '.cc-harness'), { recursive: true });
  fs.writeFileSync(saltPath(home), text);
};
const eventText = (dir) => {
  const d = path.join(dir, '.harness', 'events');
  return listFiles(d).filter((n) => n.endsWith('.jsonl')).map((n) => fs.readFileSync(path.join(d, n), 'utf8')).join('');
};

// Runs `fn` with HOME (USERPROFILE on Windows) set to `home`, so os.homedir() is that directory.
function withHome(home, fn) {
  const saved = [process.env.HOME, process.env.USERPROFILE];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn();
  } finally {
    [process.env.HOME, process.env.USERPROFILE] = saved;
  }
}

// ---------- AC-1 ----------
test('F107 AC-1: export --dry-run without a salt file creates neither the salt nor ~/.cc-harness', () => {
  const home = tmpdir();
  const hub = path.join(tmpdir(), 'hub');
  const dir = fixture();
  ci(dir, ['test one']);
  const r = harness(['export', '--dry-run'], { cwd: dir, env: homeEnv(home, hub) });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /salt will be created/);
  assert.match(r.stdout, /dry run: 1 line would be exported/);
  assert.equal(fs.existsSync(path.join(home, '.cc-harness')), false);
  assert.deepEqual(listFiles(home), []);
  assert.equal(fs.existsSync(hub), false);
  assert.equal(fs.existsSync(path.join(dir, '.harness', 'events', '.exported')), false);
  // the real export afterwards creates it
  const real = harness(['export'], { cwd: dir, env: homeEnv(home, hub) });
  assert.equal(real.code, 0, real.stdout + real.stderr);
  assert.match(fs.readFileSync(saltPath(home), 'utf8'), /^[0-9a-f]{64}$/);
});

test('F107 AC-1: export --dry-run with a salt file shows the values computed with that salt', () => {
  const home = tmpdir();
  const hub = path.join(tmpdir(), 'hub');
  const salt = 'cd'.repeat(32);
  writeSalt(home, `${salt}\n`);
  const dir = fixture();
  ci(dir, ['test one']);
  const r = harness(['export', '--dry-run'], { cwd: dir, env: homeEnv(home, hub) });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.includes('salt will be created'), false, r.stdout);
  const project = sha16(salt + localId(dir));
  assert.ok(r.stdout.includes(path.join(hub, project)), r.stdout);
  const preview = r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  assert.equal(preview.length, 1);
  assert.equal(preview[0].project, project);
  assert.deepEqual(preview[0].data.tests, [sha16(`${salt}test one`)]);
  assert.equal(fs.readFileSync(saltPath(home), 'utf8'), `${salt}\n`);
  assert.equal(fs.existsSync(hub), false);
});

// ---------- AC-2 ----------
test('F107 AC-2: the unknown CC_HARNESS_TELEMETRY value warning is printed once per process', () => {
  const home = tmpdir();
  const hub = path.join(tmpdir(), 'hub');
  const dir = fixture();
  ci(dir, ['x']);
  const script = path.join(tmpdir(), 'warn-once.mjs');
  const exportUrl = pathToFileURL(path.join(REPO, 'lib', 'commands', 'export.mjs')).href;
  fs.writeFileSync(script, [
    `import { runExport, autoExport } from ${JSON.stringify(exportUrl)};`,
    `const root = ${JSON.stringify(dir)};`,
    'const env = { ...process.env, CC_HARNESS_TELEMETRY: "maybe" };',
    'const err = (l) => process.stderr.write(`${l}\\n`);',
    'for (let i = 0; i < 3; i += 1) {',
    '  runExport({ root, out: () => {}, err, env });',
    '  autoExport({ root, err, env });',
    '}',
    '',
  ].join('\n'));
  const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...homeEnv(home, hub) } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const warnings = r.stderr.split('\n').filter((l) => l.includes('CC_HARNESS_TELEMETRY is not one of'));
  assert.equal(warnings.length, 1, r.stderr);
});

// ---------- AC-3 ----------
const SECRET = 'sekret-value-12345';

test('F107 AC-3: redactDeep redacts object keys too and keeps the values under a keep key', () => {
  const redact = redactor({ F107_SECRET: SECRET });
  const out = redactDeep({ [SECRET]: 'a', nested: [{ [`k-${SECRET}`]: SECRET }], feature: SECRET }, redact, new Set(['feature']));
  assert.equal(JSON.stringify(out).includes('[redacted]'), true);
  assert.deepEqual(Object.keys(out), ['[redacted]', 'nested', 'feature']);
  assert.deepEqual(out.nested, [{ 'k-[redacted]': '[redacted]' }]);
  assert.equal(out.feature, SECRET);
});

test('F107 AC-3: harness events text and --json hide a secret in a data key', () => {
  const dir = fixture();
  const events = path.join(dir, '.harness', 'events');
  fs.mkdirSync(events, { recursive: true });
  const line = {
    ts: '2026-09-01T00:00:00.000Z', stage: 'feedback', type: 'intervention', feature: 'F9',
    harness_version: '2.0.0', profile: 'sdlc', project: 'aaaaaaaaaaaaaaaa',
    data: { kind: 'other', [SECRET]: 'x', nested: { [`path/${SECRET}`]: 1 } },
  };
  fs.writeFileSync(path.join(events, '2026-09.jsonl'), `${JSON.stringify(line)}\n`);
  const env = { F107_SECRET: SECRET };
  for (const args of [['events'], ['events', '--json']]) {
    const r = harness(args, { cwd: dir, env });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal((r.stdout + r.stderr).includes(SECRET), false, r.stdout);
    assert.ok(r.stdout.includes('[redacted]'), r.stdout);
  }
});

test('F107 AC-3: an event written with a secret in a data key does not contain it', () => {
  const dir = fixture();
  process.env.F107_SECRET = SECRET;
  try {
    assert.equal(recordEvent(dir, { stage: 'feedback', type: 'intervention', data: { kind: 'other', [SECRET]: 1, deep: [{ [`a ${SECRET} b`]: true }] } }), true);
  } finally {
    delete process.env.F107_SECRET;
  }
  const text = eventText(dir);
  assert.equal(text.split('\n').filter(Boolean).length, 1);
  assert.equal(text.includes(SECRET), false, text);
  assert.ok(text.includes('[redacted]'), text);
});

// ---------- AC-4 ----------
test('F107 AC-4: readSalt accepts mixed-case hex and returns it in lower case', () => {
  const salt = 'aB'.repeat(32);
  const home = tmpdir();
  writeSalt(home, `${salt}\n`);
  assert.equal(readSalt({ home }), salt.toLowerCase());
  // the file is left as it is
  assert.equal(fs.readFileSync(saltPath(home), 'utf8'), `${salt}\n`);
  const upper = tmpdir();
  writeSalt(upper, 'F'.repeat(64));
  assert.equal(readSalt({ home: upper }), 'f'.repeat(64));
});

test('F107 AC-4: two salts that differ only in case export the same hashes', () => {
  const dir = fixture();
  ci(dir, ['same test']);
  const results = [];
  for (const salt of ['Ab'.repeat(32), 'ab'.repeat(32)]) {
    const home = tmpdir();
    const hub = path.join(tmpdir(), 'hub');
    writeSalt(home, salt);
    fs.rmSync(path.join(dir, '.harness', 'events', '.exported'), { force: true });
    const r = harness(['export'], { cwd: dir, env: homeEnv(home, hub) });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const [bundle] = bundlesOf(hub);
    const lines = fs.readFileSync(bundle, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    results.push({ dirs: listFiles(hub), project: lines[0].project, tests: lines[0].data.tests });
  }
  const lower = 'ab'.repeat(32);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].project, sha16(lower + localId(dir)));
  assert.deepEqual(results[0].tests, [sha16(`${lower}same test`)]);
});

test('F107 AC-4: SPEC §2 says the salt is accepted in either case and used in lower case', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s2 = spec.slice(spec.indexOf('## 2.'), spec.indexOf('## 3.'));
  assert.match(s2, /salt 파일의 hex 는 대문자·소문자 모두 받고 소문자로 바꾼 값으로 해시를 계산한다/);
});

// ---------- AC-5 ----------
test('F107 AC-5: planExport without a salt throws a HarnessError and creates no salt file', () => {
  const home = tmpdir();
  const dir = fixture();
  ci(dir, ['x']);
  const hub = path.join(tmpdir(), 'hub');
  withHome(home, () => {
    for (const opts of [{ hub }, { hub, salt: undefined }, {}]) {
      assert.throws(() => planExport(dir, opts), (e) => e instanceof HarnessError && ['usage', 'internal'].includes(e.code));
    }
    assert.throws(() => planExport(dir), (e) => e instanceof HarnessError && ['usage', 'internal'].includes(e.code));
  });
  assert.equal(fs.existsSync(saltFile(home)), false);
  assert.deepEqual(listFiles(home), []);
  // with a salt it plans as before
  const salt = '12'.repeat(32);
  const plan = planExport(dir, { hub, salt });
  assert.equal(plan.lines.length, 1);
  assert.equal(plan.lines[0].project, sha16(salt + localId(dir)));
});

test('F107 AC-5: runExport still reads the salt and passes it on', () => {
  const home = tmpdir();
  const hub = path.join(tmpdir(), 'hub');
  const dir = fixture();
  ci(dir, ['x']);
  const out = [];
  const err = [];
  const code = withHome(home, () => runExport({ root: dir, hub, out: (l) => out.push(l), err: (l) => err.push(l) }));
  assert.equal(code, 0, err.join('\n'));
  const salt = fs.readFileSync(saltFile(home), 'utf8');
  assert.match(salt, /^[0-9a-f]{64}$/);
  assert.deepEqual(listFiles(hub), [sha16(salt + localId(dir))]);
});

// ---------- SC-1 ----------
test('F107 SC-1: two secret keys that redact to the same key are still recorded, neither secret in the file', () => {
  const S1 = 'first-secret-aaaa';
  const S2 = 'second-secret-bbbb';
  const dir = fixture();
  process.env.F107_S1 = S1;
  process.env.F107_S2 = S2;
  try {
    assert.equal(recordEvent(dir, { stage: 'feedback', type: 'intervention', data: { [`${S1}값`]: 1, [`${S2}값`]: 2 } }), true);
  } finally {
    delete process.env.F107_S1;
    delete process.env.F107_S2;
  }
  const text = eventText(dir);
  const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(lines[0].data), ['[redacted]값']);
  assert.equal(text.includes(S1), false, text);
  assert.equal(text.includes(S2), false, text);
  // harness events shows the line without either secret
  const r = harness(['events', '--json'], { cwd: dir, env: { F107_S1: S1, F107_S2: S2 } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).length, 1);
  assert.equal(r.stdout.includes(S1) || r.stdout.includes(S2), false, r.stdout);
});

// ---------- ES-1 ----------
for (const [what, content] of [['not hex', 'not-a-hex-salt'], ['63 hex characters', 'a'.repeat(63)], ['empty', '']]) {
  test(`F107 ES-1: export --dry-run with a salt file that is ${what} — one warning, exit 0, file unchanged`, () => {
    const home = tmpdir();
    const hub = path.join(tmpdir(), 'hub');
    writeSalt(home, content);
    const dir = fixture();
    ci(dir, ['x']);
    const r = harness(['export', '--dry-run'], { cwd: dir, env: homeEnv(home, hub) });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const warnings = r.stderr.split('\n').filter(Boolean);
    assert.equal(warnings.length, 1, r.stderr);
    assert.match(warnings[0], /^harness: warning: .*salt/);
    assert.equal(fs.readFileSync(saltPath(home), 'utf8'), content);
    assert.equal(fs.existsSync(hub), false);
  });
}
