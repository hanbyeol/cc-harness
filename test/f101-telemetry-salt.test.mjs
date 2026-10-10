import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { harness, REPO, BIN, tmpdir } from './helpers.mjs';
import { git, gitRepo } from './gitfixture.mjs';
import { hashContract } from '../lib/contract.mjs';
import { recordEvent } from '../lib/events.mjs';
import { exportLine, telemetryState } from '../lib/telemetry.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { evaluate } from '../lib/eval.mjs';

// F101: telemetry privacy — an installation salt in the exported project id and test name
// hashes, `harness events` redacts again, repro_program redacted before lower-casing, and
// CC_HARNESS_TELEMETRY off values trimmed and case-insensitive.

const sha16 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 16);

function contract(id = 'F9') {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'one', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [{ id: 'SC-1', criterion: 'no secrets', check: 'node scripts/ok.mjs', new: false }],
    error_scenarios: [{ id: 'ES-1', criterion: 'errors reported', check: 'node scripts/ok.mjs', new: false }],
    out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-23T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture({ config = {}, status = 'approved' } = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, telemetry: { share: true }, ...config },
    '.harness/features.json': { features: [{ id: 'F9', title: 'feature F9', status, depends_on: [] }] },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/contracts/F9.json': contract(),
    'scripts/ok.mjs': 'process.exit(0);\n',
  }, { branch: null });
}

const listFiles = (d) => {
  try { return fs.readdirSync(d).sort(); } catch { return []; }
};
const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// Every file under `d` (recursively), as [path, bytes].
const allFiles = (d) => {
  const out = [];
  const walk = (x) => {
    for (const n of listFiles(x)) {
      const p = path.join(x, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out.push([p, fs.readFileSync(p)]);
    }
  };
  walk(d);
  return out;
};
const localId = (dir) => sha16(git(dir, 'rev-parse', '--show-toplevel'));
const saltPath = (home) => path.join(home, '.cc-harness', 'salt');
const readSaltText = (home) => fs.readFileSync(saltPath(home), 'utf8');
const ci = (dir, tests, at) => recordEvent(dir, { stage: 'feedback', type: 'ci', data: { sha: 'abc123', result: 'failure', tests, test: tests[0] } }, { now: new Date(at) });
const homeEnv = (home, hub, extra = {}) => ({ HOME: home, USERPROFILE: home, CC_HARNESS_HUB: hub, CC_HARNESS_TELEMETRY: '', ...extra });
const exportIn = (dir, home, hub, extra) => harness(['export'], { cwd: dir, env: homeEnv(home, hub, extra) });
const bundlesOf = (hub) => listFiles(hub).flatMap((p) => listFiles(path.join(hub, p)).map((n) => path.join(hub, p, n)));

// ---------- AC-1 ----------
test('F101 AC-1: export salts the project id and test name hashes with <home>/.cc-harness/salt', () => {
  const home = tmpdir();
  const hub = path.join(tmpdir(), 'hub');
  const dir = fixture();
  ci(dir, ['test one', 'test two'], '2026-09-01T00:00:00Z');
  const r = exportIn(dir, home, hub);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const salt = readSaltText(home);
  assert.match(salt, /^[0-9a-f]{64}$/);
  const project = sha16(salt + localId(dir));
  assert.notEqual(project, localId(dir));
  // the bundle is under <hub>/<exported project>/
  assert.deepEqual(listFiles(hub), [project]);
  const [line] = readLines(bundlesOf(hub)[0]);
  assert.equal(line.project, project);
  assert.deepEqual(line.data.tests, [sha16(`${salt}test one`), sha16(`${salt}test two`)]);
  assert.equal(line.data.test, sha16(`${salt}test one`));
  assert.notEqual(line.data.test, sha16('test one'));
});

test('F101 AC-1: removing the salt file gives the next export a new salt and a new project id', () => {
  const home = tmpdir();
  const hub = path.join(tmpdir(), 'hub');
  const dir = fixture();
  ci(dir, ['t'], '2026-09-01T00:00:00Z');
  assert.equal(exportIn(dir, home, hub).code, 0);
  const first = readSaltText(home);
  const [p1] = listFiles(hub);
  fs.rmSync(saltPath(home));
  ci(dir, ['t'], '2026-09-02T00:00:00Z');
  const r = exportIn(dir, home, hub);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const second = readSaltText(home);
  assert.match(second, /^[0-9a-f]{64}$/);
  assert.notEqual(second, first);
  const p2 = sha16(second + localId(dir));
  assert.notEqual(p2, p1);
  assert.deepEqual(listFiles(hub), [p1, p2].sort());
});

// ---------- AC-2 ----------
test('F101 AC-2: with the same salt two exports write to the same project directory and hash a test name the same', () => {
  const home = tmpdir();
  const hub = path.join(tmpdir(), 'hub');
  const dir = fixture();
  ci(dir, ['same test'], '2026-09-01T00:00:00Z');
  assert.equal(exportIn(dir, home, hub).code, 0);
  ci(dir, ['same test'], '2026-09-02T00:00:00Z');
  const r = exportIn(dir, home, hub);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(listFiles(hub).length, 1);
  const files = bundlesOf(hub);
  assert.equal(files.length, 2);
  const lines = files.flatMap(readLines);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].project, lines[1].project);
  assert.deepEqual(lines[0].data.tests, lines[1].data.tests);
  assert.equal(lines[0].data.tests[0], sha16(`${readSaltText(home)}same test`));
});

test('F101 AC-2: the local event files keep the unsalted project id', () => {
  const home = tmpdir();
  const hub = path.join(tmpdir(), 'hub');
  const dir = fixture();
  ci(dir, ['x'], '2026-09-01T00:00:00Z');
  assert.equal(exportIn(dir, home, hub).code, 0);
  assert.equal(harness(['note', '--kind', 'other', 'after export'], { cwd: dir, env: homeEnv(home, hub) }).code, 0);
  const events = path.join(dir, '.harness', 'events');
  const lines = listFiles(events).filter((n) => n.endsWith('.jsonl')).flatMap((n) => readLines(path.join(events, n)));
  assert.equal(lines.length, 2);
  for (const l of lines) assert.equal(l.project, localId(dir));
});

// ---------- AC-3 ----------
test('F101 AC-3: harness events redacts every line it prints, text and --json', () => {
  const SECRET = 'sekret-value-12345';
  const ALLOWED = 'allowed-value-777';
  const dir = fixture({ config: { env_allowlist: ['F101_ALLOWED'] } });
  const events = path.join(dir, '.harness', 'events');
  fs.mkdirSync(events, { recursive: true });
  const line = {
    ts: '2026-09-01T00:00:00.000Z', stage: 'feedback', type: 'intervention', feature: 'F9',
    harness_version: '2.0.0', profile: 'sdlc', project: 'aaaaaaaaaaaaaaaa',
    data: { kind: 'other', text: `token ${SECRET} and ${ALLOWED}`, nested: [{ v: SECRET }] },
  };
  fs.writeFileSync(path.join(events, '2026-09.jsonl'), `${JSON.stringify(line)}\n`);
  const env = { F101_SECRET: SECRET, F101_ALLOWED: ALLOWED };
  const text = harness(['events'], { cwd: dir, env });
  assert.equal(text.code, 0, text.stdout + text.stderr);
  assert.equal(text.stdout.trim().split('\n').length, 1);
  const json = harness(['events', '--json'], { cwd: dir, env });
  assert.equal(json.code, 0, json.stdout + json.stderr);
  const [e] = JSON.parse(json.stdout);
  assert.equal(e.data.kind, 'other');
  for (const r of [text, json]) {
    assert.equal((r.stdout + r.stderr).includes(SECRET), false, r.stdout);
    assert.ok(r.stdout.includes('[redacted]'), r.stdout);
    // an allowed variable's value is not redacted
    assert.ok(r.stdout.includes(ALLOWED), r.stdout);
  }
  // the file itself is not changed
  assert.ok(fs.readFileSync(path.join(events, '2026-09.jsonl'), 'utf8').includes(SECRET));
});

// ---------- AC-4 ----------
const PASS_VERIFY = {
  pass: true, commands: [], warnings: [],
  integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } },
  criteria: [{ id: 'AC-1', pass: true }, { id: 'SC-1', pass: true }, { id: 'ES-1', pass: true }],
};
const scores = { functionality: 9, quality: 9, security: 9, errors: 9, tests: 9 };
const reply = (json) => ({ ok: true, error: null, text: JSON.stringify(json), json, costUsd: 0.01, exitCode: 0 });

test('F101 AC-4: repro_program is taken after redaction, so a mixed-case secret is in neither form', async () => {
  const SECRET = 'AbCSecretValue123';
  const dir = fixture();
  const replies = {
    evaluator: [reply({ scores, findings: [{ criterion_id: 'AC-1', dimension: 'functionality', summary: 'defect', repro: `${SECRET} arg` }], out_of_scope: [] })],
    'security-reviewer': [reply({ scores, findings: [], out_of_scope: [] })],
  };
  await evaluate({
    root: dir, featureId: 'F9', base: 'main',
    config: resolveConfig({ base_branch: 'main', roles: { builder: 'claude', evaluator: 'claude', 'security-reviewer': 'claude' }, verify: { commands: [] }, budget: { step_timeout_sec: 30 } }),
    verifyResult: PASS_VERIFY, runAdapter: async (role) => replies[role].shift(),
    env: { ...process.env, F101_TOKEN: SECRET },
  });
  const events = path.join(dir, '.harness', 'events');
  const text = listFiles(events).filter((n) => n.endsWith('.jsonl')).map((n) => fs.readFileSync(path.join(events, n), 'utf8')).join('');
  const findings = text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.stage === 'eval' && e.type === 'finding');
  assert.equal(findings.length, 1);
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes(SECRET.toLowerCase()), false);
  assert.equal(text.toLowerCase().includes(SECRET.toLowerCase()), false);
});

// ---------- AC-5 ----------
for (const value of ['OFF', ' 0 ', 'False', 'NO', 'off', '0', 'false', 'no', '\tOff\n']) {
  test(`F101 AC-5: CC_HARNESS_TELEMETRY=${JSON.stringify(value)} turns telemetry off`, () => {
    assert.deepEqual(telemetryState({ telemetry: { share: true } }, { CC_HARNESS_TELEMETRY: value }), { share: false, autoExport: false, source: 'env' });
    const home = tmpdir();
    const hub = path.join(tmpdir(), 'hub');
    const dir = fixture();
    ci(dir, ['x'], '2026-09-01T00:00:00Z');
    const r = exportIn(dir, home, hub, { CC_HARNESS_TELEMETRY: value });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /telemetry\.share is off \(CC_HARNESS_TELEMETRY\)/);
    assert.equal(r.stderr, '');
    assert.equal(fs.existsSync(hub), false);
  });
}

test('F101 AC-5: any other non-empty value warns once on stderr and follows the config', () => {
  for (const [value, share] of [['maybe', true], ['2', true], ['disable', false]]) {
    const config = { telemetry: { share } };
    const s = telemetryState(config, { CC_HARNESS_TELEMETRY: value });
    assert.equal(s.share, share);
    assert.equal(s.source, 'config');
    assert.match(s.warning, /CC_HARNESS_TELEMETRY/);
    const home = tmpdir();
    const hub = path.join(tmpdir(), 'hub');
    const dir = fixture({ config });
    ci(dir, ['x'], '2026-09-01T00:00:00Z');
    const r = exportIn(dir, home, hub, { CC_HARNESS_TELEMETRY: value });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const warnings = r.stderr.split('\n').filter((l) => l.includes('warning'));
    assert.equal(warnings.length, 1, r.stderr);
    assert.match(warnings[0], /CC_HARNESS_TELEMETRY/);
    assert.equal(bundlesOf(hub).length, share ? 1 : 0, value);
  }
});

test('F101 AC-5: 1, on, yes, an empty value or none follow the config without a warning', () => {
  for (const value of ['1', 'on', 'yes', ' YES ', '', '  ', undefined]) {
    const s = telemetryState({ telemetry: { share: true } }, value === undefined ? {} : { CC_HARNESS_TELEMETRY: value });
    assert.deepEqual(s, { share: true, autoExport: true, source: 'config' }, JSON.stringify(value));
  }
  const home = tmpdir();
  const hub = path.join(tmpdir(), 'hub');
  const dir = fixture();
  ci(dir, ['x'], '2026-09-01T00:00:00Z');
  const r = exportIn(dir, home, hub, { CC_HARNESS_TELEMETRY: 'on' });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(bundlesOf(hub).length, 1);
});

// ---------- AC-6 ----------
test('F101 AC-6: SPEC §2 and README describe the salt, re-redaction by events and the off values', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s2 = spec.slice(spec.indexOf('## 2.'), spec.indexOf('## 3.'));
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  for (const [name, text] of [['SPEC §2', s2], ['README', readme]]) {
    for (const s of ['.cc-harness/salt', '0600', '0700', '지우면', '로컬 이벤트', '`false`', '`no`', '대소문자', 'harness events']) {
      assert.ok(text.includes(s), `${name} mentions ${s}`);
    }
  }
  // salt only in exported values; events re-applies the redactor
  assert.ok(s2.includes('salt 는 내보낸 값에만'), 'SPEC: the salt goes into exported values only');
  assert.ok(readme.includes('salt 는 내보낸 값에만'), 'README: the salt goes into exported values only');
  assert.ok(s2.includes('salt 파일을 지우면 다음 export 가 새 salt 를 만들고 같은 저장소도 새 project id'), 'SPEC: removing the salt gives a new id');
  assert.ok(readme.includes('salt 를 지우면 다음 export 부터 새 id'), 'README: removing the salt gives a new id');
  assert.ok(s2.includes('redactor(`process.env`, config `env_allowlist`)를 다시 적용'), 'SPEC: events redacts again');
  assert.ok(readme.includes('다시 가린다'), 'README: events redacts again');
  assert.ok(s2.includes('sha256(salt + 로컬 project id)') && s2.includes('sha256(salt + 테스트 이름)'), 'SPEC: the salted hashes');
});

// ---------- SC-1 ----------
test('F101 SC-1: the salt is in no bundle, hub file or .harness file after run and export', () => {
  const home = tmpdir();
  const hub = path.join(tmpdir(), 'hub');
  const dir = fixture({ status: 'todo' });
  ci(dir, ['x'], '2026-09-01T00:00:00Z');
  const run = harness(['run'], { cwd: dir, env: homeEnv(home, hub) });
  assert.equal(run.code, 0, run.stdout + run.stderr);
  ci(dir, ['y'], '2026-09-02T00:00:00Z');
  const r = exportIn(dir, home, hub);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const salt = readSaltText(home);
  assert.match(salt, /^[0-9a-f]{64}$/);
  const hubFiles = allFiles(hub);
  assert.ok(hubFiles.length >= 2, `bundles of run and export: ${hubFiles.map(([p]) => p)}`);
  const harnessFiles = allFiles(path.join(dir, '.harness'));
  assert.ok(harnessFiles.some(([p]) => p.endsWith('.jsonl')));
  for (const [p, bytes] of [...hubFiles, ...harnessFiles]) {
    assert.equal(bytes.includes(salt), false, `${p} has the salt`);
    assert.equal(p.includes(salt), false, `${p} names the salt`);
  }
  for (const out of [run.stdout, run.stderr, r.stdout, r.stderr]) assert.equal(out.includes(salt), false);
});

// ---------- SC-2 ----------
test('F101 SC-2: an existing salt file is kept as it is', () => {
  const home = tmpdir();
  const hub = path.join(tmpdir(), 'hub');
  const salt = 'ab'.repeat(32);
  fs.mkdirSync(path.join(home, '.cc-harness'));
  fs.writeFileSync(saltPath(home), `${salt}\n`);
  const dir = fixture();
  ci(dir, ['x'], '2026-09-01T00:00:00Z');
  const r = exportIn(dir, home, hub);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(readSaltText(home), `${salt}\n`);
  assert.deepEqual(listFiles(hub), [sha16(salt + localId(dir))]);
});

const BAD_SALTS = [
  ['not hex', 'not-a-hex-salt'],
  ['63 hex characters', 'a'.repeat(63)],
  ['65 hex characters', 'a'.repeat(65)],
  ['empty', ''],
  ['hex with a non-hex character', `${'a'.repeat(63)}g`],
];
for (const [what, content] of BAD_SALTS) {
  test(`F101 SC-2: a salt file that is ${what} — one warning, no bundle, exit 0, file unchanged`, () => {
    const home = tmpdir();
    const hub = path.join(tmpdir(), 'hub');
    fs.mkdirSync(path.join(home, '.cc-harness'));
    fs.writeFileSync(saltPath(home), content);
    const dir = fixture();
    ci(dir, ['x'], '2026-09-01T00:00:00Z');
    const r = exportIn(dir, home, hub);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const warnings = r.stderr.split('\n').filter(Boolean);
    assert.equal(warnings.length, 1, r.stderr);
    assert.match(warnings[0], /^harness: warning: .*salt/);
    assert.equal(bundlesOf(hub).length, 0);
    assert.equal(fs.existsSync(path.join(dir, '.harness', 'events', '.exported')), false);
    assert.equal(readSaltText(home), content);
  });
}

test('F101 SC-2: an unreadable salt (a directory) — one warning, no bundle, exit 0, left as it is', () => {
  const home = tmpdir();
  const hub = path.join(tmpdir(), 'hub');
  fs.mkdirSync(saltPath(home), { recursive: true });
  const dir = fixture();
  ci(dir, ['x'], '2026-09-01T00:00:00Z');
  const r = exportIn(dir, home, hub);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const warnings = r.stderr.split('\n').filter(Boolean);
  assert.equal(warnings.length, 1, r.stderr);
  assert.match(warnings[0], /^harness: warning: .*salt/);
  assert.equal(bundlesOf(hub).length, 0);
  assert.ok(fs.statSync(saltPath(home)).isDirectory());
});

test('F101 SC-2: an unreadable salt file (mode 000) — one warning, no bundle, exit 0, unchanged', () => {
  // POSIX permissions; root reads any file
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const home = tmpdir();
  const hub = path.join(tmpdir(), 'hub');
  const salt = 'cd'.repeat(32);
  fs.mkdirSync(path.join(home, '.cc-harness'));
  fs.writeFileSync(saltPath(home), salt);
  fs.chmodSync(saltPath(home), 0o000);
  try {
    const dir = fixture();
    ci(dir, ['x'], '2026-09-01T00:00:00Z');
    const r = exportIn(dir, home, hub);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const warnings = r.stderr.split('\n').filter(Boolean);
    assert.equal(warnings.length, 1, r.stderr);
    assert.match(warnings[0], /^harness: warning: .*salt/);
    assert.equal(bundlesOf(hub).length, 0);
  } finally {
    fs.chmodSync(saltPath(home), 0o600);
  }
  assert.equal(readSaltText(home), salt);
});

// ---------- SC-3 ----------
test('F101 SC-3: a new salt file is 0600 and a new ~/.cc-harness 0700 under umask 022', () => {
  if (process.platform === 'win32') return; // POSIX modes only
  for (const hubInHome of [false, true]) {
    const home = tmpdir();
    const dir = fixture();
    ci(dir, ['x'], '2026-09-01T00:00:00Z');
    const env = { ...process.env, ...homeEnv(home, hubInHome ? '' : path.join(tmpdir(), 'hub')) };
    const r = spawnSync('/bin/sh', ['-c', 'umask 022 && exec "$0" "$1" export', process.execPath, BIN], { cwd: dir, encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const mode = (p) => fs.statSync(p).mode & 0o777;
    assert.equal(mode(path.join(home, '.cc-harness')), 0o700, `hub in home: ${hubInHome}`);
    assert.equal(mode(saltPath(home)), 0o600, `hub in home: ${hubInHome}`);
  }
});

// ---------- ES-1 ----------
test('F101 ES-1: learn reads salted bundles and bundles from before this feature together', () => {
  const home = tmpdir();
  const hub = path.join(tmpdir(), 'hub');
  const dir = fixture();
  ci(dir, ['x'], '2026-09-02T00:00:00Z');
  ci(dir, ['y'], '2026-09-03T00:00:00Z');
  // a bundle as export wrote it before F101: the unsalted project and test name hashes, an older version
  const OLD = '2.0.50';
  const old = [
    exportLine({ ts: '2026-09-01T00:00:00Z', stage: 'feedback', type: 'ci', harness_version: OLD, profile: 'sdlc', data: { result: 'failure', tests: ['x'] } }, { project: localId(dir) }),
    exportLine({ ts: '2026-09-01T01:00:00Z', stage: 'feedback', type: 'intervention', harness_version: OLD, profile: 'sdlc', data: { kind: 'other' } }, { project: localId(dir) }),
  ];
  assert.deepEqual(old[0].data.tests, [sha16('x')]);
  fs.mkdirSync(path.join(hub, localId(dir)), { recursive: true });
  fs.writeFileSync(path.join(hub, localId(dir), '20260901T020000.000Z.jsonl'), old.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const r = exportIn(dir, home, hub);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(listFiles(hub).length, 2);
  const current = readLines(bundlesOf(hub).find((f) => !f.includes(localId(dir))))[0].harness_version;
  assert.notEqual(current, OLD);
  const l = harness(['learn', '--hub', hub, '--json'], { cwd: dir, env: homeEnv(home, hub) });
  assert.equal(l.code, 0, l.stdout + l.stderr);
  assert.equal(l.stderr, '');
  const report = JSON.parse(l.stdout);
  assert.equal(report.events, 4);
  assert.equal(report.projects, 2);
  const byVersion = Object.fromEntries(report.versions.map((v) => [v.version, v]));
  assert.equal(byVersion[OLD].events, 2);
  assert.equal(byVersion[current].events, 2);
  const text = harness(['learn', '--hub', hub], { cwd: dir, env: homeEnv(home, hub) });
  assert.equal(text.code, 0, text.stdout + text.stderr);
  assert.equal(text.stderr, '');
  assert.match(text.stdout, /^learn: 2 projects, 4 events/);
});
