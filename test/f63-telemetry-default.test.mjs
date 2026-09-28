import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { harness, tmpdir, REPO, BIN, TEST_HUB } from './helpers.mjs';
import { git, gitRepo } from './gitfixture.mjs';
import { hashContract } from '../lib/contract.mjs';
import { recordEvent } from '../lib/events.mjs';
import exportCommand from '../lib/commands/export.mjs';
import evalCommand from '../lib/commands/eval.mjs';
import doctor from '../lib/commands/doctor.mjs';

// F63: telemetry on by default — telemetry.share and telemetry.auto_export default to true,
// turned off by an explicit false or CC_HARNESS_TELEMETRY=0|off, with a notice on the first export.

const sha16 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 16);

function contract(id = 'F9') {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'one', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-23T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

// `telemetry` undefined: config.json has no telemetry key at all.
function fixture({ telemetry, config = {}, status = 'approved', title = 'feature F9' } = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...(telemetry === undefined ? {} : { telemetry }), ...config },
    '.harness/features.json': { features: [{ id: 'F9', title, status, depends_on: [] }] },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/contracts/F9.json': contract(),
    'scripts/ok.mjs': 'process.exit(0);\n',
  }, { branch: null });
}

const exportedPath = (dir) => path.join(dir, '.harness', 'events', '.exported');
const projectOf = (dir) => sha16(git(dir, 'rev-parse', '--show-toplevel'));
const listFiles = (d) => {
  try { return fs.readdirSync(d).sort(); } catch { return []; }
};
const bundles = (hub, dir) => listFiles(path.join(hub, projectOf(dir))).map((n) => path.join(hub, projectOf(dir), n));
const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const note = (dir, text, at) => recordEvent(dir, { stage: 'feedback', type: 'intervention', feature: 'F9', data: { kind: 'other', text } }, { now: new Date(at) });
const newHub = () => path.join(tmpdir(), 'hub');
const noticeOf = (hub) => `harness: telemetry is on by default — anonymized events go to ${hub} (local only); `
  + 'set "telemetry": {"share": false} in .harness/config.json or CC_HARNESS_TELEMETRY=0 to turn it off';
// The environment of a child process with telemetry following the config.
const envFor = (hub, extra = {}) => ({ CC_HARNESS_HUB: hub, CC_HARNESS_TELEMETRY: '', ...extra });

const scores = () => ({ functionality: 9, quality: 9, security: 9, errors: 9, tests: 9 });
const PASS_REPLY = () => ({ ok: true, error: null, text: '', json: { scores: scores(), findings: [], out_of_scope: [] }, costUsd: 0, exitCode: 0 });
const PASS_VERIFY = {
  pass: true, commands: [], warnings: [],
  integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } },
  criteria: [{ id: 'AC-1', pass: true }],
};
const EVAL_CONFIG = {
  roles: { builder: 'claude', evaluator: 'generic', 'security-reviewer': 'generic' },
  adapters: { generic: { read_only_command: [process.execPath, '-e', 'process.exit(1)'] } },
};

// eval in this process, with process.env set to `env` for its duration.
async function evalWith(dir, env) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const out = [];
    const err = [];
    const code = await evalCommand({
      root: dir, args: ['F9', '--json'], out: (s) => out.push(s), err: (s) => err.push(s),
      deps: { runAdapter: async () => PASS_REPLY(), verifyResult: PASS_VERIFY },
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------- AC-1 ----------
test('F63 AC-1: export writes the bundle when config has no telemetry or no telemetry.share', () => {
  for (const telemetry of [undefined, {}, { auto_export: false }]) {
    const dir = fixture({ telemetry });
    note(dir, 'x', '2026-09-01T00:00:00Z');
    const hub = newHub();
    const r = harness(['export'], { cwd: dir, env: envFor(hub) });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /is off/, JSON.stringify(telemetry));
    assert.match(r.stdout, /exported 1 line to /);
    assert.equal(bundles(hub, dir).length, 1, JSON.stringify(telemetry));
    assert.ok(fs.existsSync(exportedPath(dir)));
  }
});

test('F63 AC-1: telemetry.share false says it is off and writes nothing (exit 0)', () => {
  const dir = fixture({ telemetry: { share: false } });
  note(dir, 'x', '2026-09-01T00:00:00Z');
  const hub = newHub();
  for (const args of [['export'], ['export', '--dry-run'], ['export', '--hub', hub]]) {
    const r = harness(args, { cwd: dir, env: envFor(hub) });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^telemetry\.share is off /);
    assert.equal(fs.existsSync(hub), false);
    assert.equal(fs.existsSync(exportedPath(dir)), false);
  }
});

test('F63 AC-1: a telemetry.share that is not a boolean ("true", 1, null) is off', () => {
  for (const share of ['true', 1, null]) {
    const dir = fixture({ telemetry: { share } });
    note(dir, 'x', '2026-09-01T00:00:00Z');
    const hub = newHub();
    const r = harness(['export'], { cwd: dir, env: envFor(hub) });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /telemetry\.share is off/, JSON.stringify(share));
    assert.equal(fs.existsSync(hub), false, JSON.stringify(share));
    assert.equal(fs.existsSync(exportedPath(dir)), false);
  }
});

// ---------- AC-2 ----------
test('F63 AC-2: run exports at the end when config has no telemetry at all', () => {
  // No approved feature: the run starts no builder and ends at once.
  const dir = fixture({ status: 'todo' });
  note(dir, 'before run', '2026-09-01T00:00:00Z');
  const hub = newHub();
  const r = harness(['run'], { cwd: dir, env: envFor(hub) });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no approved, executable features in scope/);
  const files = bundles(hub, dir);
  assert.equal(files.length, 1, r.stderr);
  assert.ok(readLines(files[0]).some((l) => l.stage === 'feedback' && l.type === 'intervention'));
  assert.match(r.stderr, /exported \d+ lines? to /);
  assert.doesNotMatch(r.stdout, /exported/);
});

test('F63 AC-2: run does not export when telemetry.auto_export is false', () => {
  for (const telemetry of [{ auto_export: false }, { share: true, auto_export: false }]) {
    const dir = fixture({ telemetry, status: 'todo' });
    note(dir, 'before run', '2026-09-01T00:00:00Z');
    const hub = newHub();
    const r = harness(['run'], { cwd: dir, env: envFor(hub) });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(fs.existsSync(hub), false, JSON.stringify(telemetry));
    assert.equal(fs.existsSync(exportedPath(dir)), false);
  }
});

test('F63 AC-2: eval exports at the end when config has no telemetry, and not when auto_export is false', async () => {
  const dir = fixture({ config: EVAL_CONFIG });
  const hub = newHub();
  let r = await evalWith(dir, envFor(hub));
  assert.equal(r.code, 0, r.out + r.err);
  JSON.parse(r.out); // stdout is still only the JSON result
  const [file] = bundles(hub, dir);
  assert.ok(file, r.err);
  assert.ok(readLines(file).some((l) => l.stage === 'eval' && l.type === 'status'));

  const off = fixture({ telemetry: { auto_export: false }, config: EVAL_CONFIG });
  const offHub = newHub();
  r = await evalWith(off, envFor(offHub));
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(fs.existsSync(offHub), false);
});

// ---------- AC-3 ----------
test('F63 AC-3: CC_HARNESS_TELEMETRY=0 or off turns export off even with telemetry.share true', () => {
  for (const value of ['0', 'off']) {
    const dir = fixture({ telemetry: { share: true, auto_export: true }, status: 'todo' });
    note(dir, 'x', '2026-09-01T00:00:00Z');
    const hub = newHub();
    for (const args of [['export'], ['export', '--hub', hub]]) {
      const r = harness(args, { cwd: dir, env: envFor(hub, { CC_HARNESS_TELEMETRY: value }) });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /is off \(CC_HARNESS_TELEMETRY\)/);
    }
    const r = harness(['run'], { cwd: dir, env: envFor(hub, { CC_HARNESS_TELEMETRY: value }) });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(fs.existsSync(hub), false, value);
    assert.equal(fs.existsSync(exportedPath(dir)), false, value);
  }
});

test('F63 AC-3: CC_HARNESS_TELEMETRY=0 turns the automatic export of eval off', async () => {
  const dir = fixture({ telemetry: { share: true, auto_export: true }, config: EVAL_CONFIG });
  const hub = newHub();
  const r = await evalWith(dir, envFor(hub, { CC_HARNESS_TELEMETRY: '0' }));
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(fs.existsSync(hub), false);
});

test('F63 AC-3: any other CC_HARNESS_TELEMETRY value, or none, follows the config', async () => {
  for (const value of ['1', 'on', '', undefined]) {
    const dir = fixture({ telemetry: { share: true, auto_export: true }, status: 'todo' });
    note(dir, 'x', '2026-09-01T00:00:00Z');
    const hub = newHub();
    const env = { CC_HARNESS_HUB: hub };
    if (value !== undefined) env.CC_HARNESS_TELEMETRY = value;
    const r = harness(['run'], { cwd: dir, env });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(bundles(hub, dir).length, 1, String(value));
  }
  // in process, with the env given to the command
  const dir = fixture({ telemetry: { share: false } });
  note(dir, 'x', '2026-09-01T00:00:00Z');
  const hub = newHub();
  const out = [];
  const code = await exportCommand({ root: dir, args: ['--hub', hub], out: (s) => out.push(s), err: () => {}, env: { CC_HARNESS_TELEMETRY: '1' } });
  assert.equal(code, 0);
  assert.match(out.join('\n'), /^telemetry\.share is off /);
  assert.equal(fs.existsSync(hub), false);
});

// ---------- AC-4 ----------
test('F63 AC-4: the first export with telemetry on by default prints the notice once on stderr', () => {
  const dir = fixture();
  note(dir, 'a', '2026-09-01T00:00:00Z');
  const hub = newHub();
  let r = harness(['export'], { cwd: dir, env: envFor(hub) });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.stderr.split(/\r?\n/).filter(Boolean), [noticeOf(hub)]);
  assert.ok(!r.stdout.includes('telemetry is on by default'));
  // the second export — with a new event and with none — does not
  note(dir, 'b', '2026-09-02T00:00:00Z');
  r = harness(['export'], { cwd: dir, env: envFor(hub) });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /exported 1 line to /);
  assert.doesNotMatch(r.stderr, /telemetry is on by default/);
  r = harness(['export'], { cwd: dir, env: envFor(hub) });
  assert.doesNotMatch(r.stderr, /telemetry is on by default/);
  // --hub: the notice names that hub
  const other = fixture({ telemetry: { auto_export: true } });
  note(other, 'a', '2026-09-01T00:00:00Z');
  const flagHub = newHub();
  r = harness(['export', '--hub', flagHub], { cwd: other, env: envFor(hub) });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stderr.includes(noticeOf(flagHub)), r.stderr);
});

test('F63 AC-4: the automatic export of run prints the notice on its first export only', () => {
  const dir = fixture({ status: 'todo' });
  note(dir, 'a', '2026-09-01T00:00:00Z');
  const hub = newHub();
  let r = harness(['run'], { cwd: dir, env: envFor(hub) });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.stderr.split(noticeOf(hub)).length - 1, 1, r.stderr);
  assert.doesNotMatch(r.stdout, /telemetry is on by default/);
  r = harness(['run'], { cwd: dir, env: envFor(hub) });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /telemetry is on by default/);
});

test('F63 AC-4: no notice when telemetry.share is explicitly true', () => {
  const dir = fixture({ telemetry: { share: true }, status: 'todo' });
  note(dir, 'a', '2026-09-01T00:00:00Z');
  const hub = newHub();
  let r = harness(['export'], { cwd: dir, env: envFor(hub) });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(bundles(hub, dir).length, 1);
  assert.doesNotMatch(r.stderr, /telemetry is on by default/);
  const other = fixture({ telemetry: { share: true }, status: 'todo' });
  note(other, 'a', '2026-09-01T00:00:00Z');
  r = harness(['run'], { cwd: other, env: envFor(hub) });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(bundles(hub, other).length, 1);
  assert.doesNotMatch(r.stderr, /telemetry is on by default/);
});

// ---------- AC-5 ----------
const PROBE = async () => ({ installed: false, version: null, help: null });
async function doctorLines(root, env) {
  const lines = [];
  await doctor({ root, out: (l) => lines.push(l), err: (l) => lines.push(l), probe: PROBE, env });
  return lines;
}

test('F63 AC-5: doctor shows the telemetry state and the hub on one line', async () => {
  const hub = newHub();
  const cases = [
    [undefined, {}, 'on (default)'],
    [{ auto_export: false }, {}, 'on (default)'],
    [{ share: true }, {}, 'on (config)'],
    [{ share: false }, {}, 'off (config)'],
    [{ share: 'true' }, {}, 'off (config)'],
    [{ share: true }, { CC_HARNESS_TELEMETRY: 'off' }, 'off (CC_HARNESS_TELEMETRY)'],
    [undefined, { CC_HARNESS_TELEMETRY: '0' }, 'off (CC_HARNESS_TELEMETRY)'],
  ];
  for (const [telemetry, env, state] of cases) {
    const dir = fixture({ telemetry });
    const lines = (await doctorLines(dir, { CC_HARNESS_HUB: hub, ...env })).filter((l) => l.startsWith('telemetry:'));
    assert.deepEqual(lines, [`telemetry: ${state} — hub ${hub}`], JSON.stringify([telemetry, env]));
  }
  // through the CLI, with the hub in <home>/.cc-harness/hub
  const home = tmpdir();
  const r = harness(['doctor'], { cwd: fixture(), env: { CC_HARNESS_HUB: '', CC_HARNESS_TELEMETRY: '', HOME: home, USERPROFILE: home, PATH: '' } });
  assert.ok(r.stdout.split(/\r?\n/).includes(`telemetry: on (default) — hub ${path.join(home, '.cc-harness', 'hub')}`), r.stdout + r.stderr);
});

// ---------- AC-6 ----------
test('F63 AC-6: tests export to a hub of their own, never to <HOME>/.cc-harness/hub', () => {
  const hub = process.env.CC_HARNESS_HUB;
  assert.ok(hub, 'test/helpers.mjs sets CC_HARNESS_HUB');
  assert.equal(hub, TEST_HUB);
  const tmpRoot = fs.realpathSync.native(os.tmpdir());
  assert.ok(fs.realpathSync.native(path.dirname(hub)).startsWith(tmpRoot + path.sep), `${hub} is under ${tmpRoot}`);
  const home = tmpdir();
  const dir = fixture({ status: 'todo' });
  note(dir, 'a', '2026-09-01T00:00:00Z');
  const r = harness(['run'], { cwd: dir, env: { HOME: home, USERPROFILE: home } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(path.join(home, '.cc-harness', 'hub')), false);
  assert.equal(fs.existsSync(path.join(home, '.cc-harness')), false);
  // the export went to the test hub
  assert.equal(bundles(hub, dir).length, 1, r.stderr);
});

// ---------- AC-7 ----------
test('F63 AC-7: SPEC, docs/telemetry.md and README describe telemetry on by default and how to turn it off', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'telemetry.md'), 'utf8');
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  const start = spec.indexOf('**현장 데이터 내보내기**');
  assert.ok(start >= 0, 'SPEC has the field data export section');
  const section = spec.slice(start, spec.indexOf('| 내보내는 필드 |', start));
  for (const [name, text] of [['SPEC export section', section], ['docs/telemetry.md', doc], ['README', readme]]) {
    for (const s of ['기본', '"share": false', 'CC_HARNESS_TELEMETRY']) assert.ok(text.includes(s), `${name} mentions ${s}`);
  }
  for (const [name, text] of [['SPEC export section', section], ['docs/telemetry.md', doc]]) {
    for (const s of ['telemetry is on by default', '.exported', 'CC_HARNESS_TELEMETRY=0', '`off`', 'harness doctor']) assert.ok(text.includes(s), `${name} mentions ${s}`);
  }
  assert.ok(readme.includes('telemetry is on by default') || readme.includes('안내'), 'README mentions the first-export notice');
  for (const [name, text] of [['docs/SPEC.md', spec], ['docs/telemetry.md', doc], ['README.md', readme]]) {
    assert.ok(!/opt-in|opt in/i.test(text), `${name} still says opt-in`);
  }
});

// ---------- SC-1 ----------
test('F63 SC-1: with telemetry on by default the bundle has no secret, path, remote, user name, title or criterion', () => {
  const M = {
    aws: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYFAKEKEY63', github: 'ghp_FAKEf63tokenAbCdEf0123456789abcdefGHIJ',
    remote: 'https://github.com/mark-f63-org/mark-f63-repo.git', title: 'MARKtitle-f63 secret feature', criterion: 'MARKcriterion-f63 the login works',
  };
  const dir = fixture({ title: M.title });
  git(dir, 'remote', 'add', 'origin', M.remote);
  const user = os.userInfo().username;
  const raw = {
    ts: '2026-09-01T00:00:00.000Z', stage: 'eval', type: 'finding', feature: 'F9', round: 1, title: M.title,
    harness_version: '2.0.29', profile: 'sdlc', project: dir, remote: M.remote, user,
    data: {
      duration_ms: 5,
      env: { AWS_SECRET_ACCESS_KEY: M.aws, GITHUB_TOKEN: M.github, aws_secret_access_key: M.aws, github_token: M.github },
      aws_secret_access_key: M.aws, github_token: M.github, secrets: [M.aws, M.github],
      cwd: dir, root: dir, path: path.join(dir, 'src', 'a.mjs'), remote: M.remote, remote_url: M.remote, origin: M.remote,
      user, username: user, owner: user, home: os.homedir(),
      title: M.title, criterion: M.criterion, criteria: [{ criterion: M.criterion, title: M.title }],
      // allowlisted keys with values outside their enumeration
      reason: M.criterion, kind: M.title, model: M.remote, role: user, outcome: dir, dimension: M.aws, rule: M.github,
    },
  };
  fs.mkdirSync(path.join(dir, '.harness', 'events'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.harness', 'events', '2026-09.jsonl'), `${JSON.stringify(raw)}\n`);
  const env = { AWS_SECRET_ACCESS_KEY: M.aws, GITHUB_TOKEN: M.github };
  // real commands add events too, with the secrets in their environment
  assert.equal(harness(['note', 'F9', '--kind', 'other', `${M.criterion} ${M.aws}`], { cwd: dir, env }).code, 0);
  const hub = newHub();
  const r = harness(['export'], { cwd: dir, env: envFor(hub, env) });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const files = bundles(hub, dir);
  assert.equal(files.length, 1, r.stdout + r.stderr);
  const bytes = fs.readFileSync(files[0]);
  assert.ok(readLines(files[0]).length >= 2);
  const values = {
    AWS_SECRET_ACCESS_KEY: M.aws, GITHUB_TOKEN: M.github, 'repository path': dir, 'repository path (real)': fs.realpathSync.native(dir),
    'git remote URL': M.remote, 'remote host path': 'mark-f63-org', 'feature title': M.title, 'title marker': 'MARKtitle', criterion: M.criterion, 'criterion marker': 'MARKcriterion',
  };
  // a very short user name could occur by chance inside a hash or an enumerated value
  if (user.length >= 5) values['OS user name'] = user;
  for (const [name, v] of Object.entries(values)) assert.equal(bytes.indexOf(Buffer.from(v)), -1, `${name} is not in the bundle`);
});

// ---------- SC-2 ----------
test('F63 SC-2: export creates the hub and project directories 0700 and the bundle 0600 under umask 022', () => {
  if (process.platform === 'win32') return; // POSIX modes only
  const dir = fixture();
  note(dir, 'a', '2026-09-01T00:00:00Z');
  const hub = path.join(tmpdir(), 'nested', 'hub');
  const r = spawnSync('/bin/sh', ['-c', 'umask 022 && exec "$0" "$1" export', process.execPath, BIN], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, CC_HARNESS_HUB: hub, CC_HARNESS_TELEMETRY: '' },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const mode = (p) => fs.statSync(p).mode & 0o777;
  assert.equal(mode(hub), 0o700);
  assert.equal(mode(path.join(hub, projectOf(dir))), 0o700);
  const files = bundles(hub, dir);
  assert.equal(files.length, 1);
  assert.equal(mode(files[0]), 0o600);
  // a later bundle in the existing directories is 0600 too
  note(dir, 'b', '2026-09-02T00:00:00Z');
  const again = spawnSync('/bin/sh', ['-c', 'umask 022 && exec "$0" "$1" export', process.execPath, BIN], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, CC_HARNESS_HUB: hub, CC_HARNESS_TELEMETRY: '' },
  });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  for (const f of bundles(hub, dir)) assert.equal(mode(f), 0o600);
});

// ---------- SC-3 ----------
const NET_MODULES = ['net', 'http', 'https', 'dgram', 'tls', 'http2'];

// Every module specifier a source imports: static `import … from`, `import '…'`, `export … from`,
// dynamic `import(…)` and `require(…)`.
function importsOf(source) {
  const specs = [];
  const patterns = [
    /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*([^)]*)\)/g,
    /\brequire\s*\(\s*([^)]*)\)/g,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) specs.push(m[1].trim().replace(/^['"`]|['"`]$/g, ''));
  return specs;
}

test('F63 SC-3: telemetry.mjs and commands/export.mjs import no network module and never call fetch', () => {
  // the checker itself finds each form it looks for
  const sample = "import http from 'node:http';\nimport { connect } from \"net\";\nexport { x } from 'node:tls';\nconst d = await import('dgram');\nrequire('https');\n";
  assert.deepEqual(importsOf(sample).sort(), ['dgram', 'https', 'net', 'node:http', 'node:tls']);
  const banned = new Set(NET_MODULES.flatMap((m) => [m, `node:${m}`]));
  for (const rel of ['lib/telemetry.mjs', 'lib/commands/export.mjs']) {
    const source = fs.readFileSync(path.join(REPO, rel), 'utf8');
    const specs = importsOf(source);
    assert.ok(specs.length > 0, `${rel} imports something`);
    for (const s of specs) {
      assert.ok(!banned.has(s), `${rel} imports ${s}`);
      assert.ok(s.startsWith('node:') || s.startsWith('.'), `${rel} imports only node: builtins and local modules, not ${s}`);
    }
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${rel} calls fetch(`);
  }
});

test('F63 SC-3: the default-on export completes locally with fetch unavailable', async () => {
  const dir = fixture();
  note(dir, 'a', '2026-09-01T00:00:00Z');
  const hub = newHub();
  const saved = globalThis.fetch;
  let called = false;
  globalThis.fetch = () => { called = true; throw new Error('network is not allowed'); };
  try {
    const out = [];
    const err = [];
    const code = await exportCommand({ root: dir, args: ['--hub', hub], out: (s) => out.push(s), err: (s) => err.push(s), env: {} });
    assert.equal(code, 0, out.concat(err).join('\n'));
  } finally {
    globalThis.fetch = saved;
  }
  assert.equal(called, false);
  assert.equal(bundles(hub, dir).length, 1);
});

// ---------- ES-1 ----------
test('F63 ES-1: a failing default-on automatic export of run keeps its result and leaves one "export failed" line', () => {
  const blocker = path.join(tmpdir(), 'hub-is-a-file');
  fs.writeFileSync(blocker, 'x');
  const results = [];
  for (const telemetry of [{ share: false }, undefined]) {
    const dir = fixture({ telemetry, status: 'todo' });
    note(dir, 'before run', '2026-09-01T00:00:00Z');
    results.push(harness(['run'], { cwd: dir, env: envFor(blocker) }));
  }
  const [off, on] = results;
  assert.equal(on.code, off.code);
  assert.equal(on.code, 0, on.stdout + on.stderr);
  const report = (s) => s.replace(/runs[\\/][^\s]+\.md/g, 'runs/<time>.md');
  assert.equal(report(on.stdout), report(off.stdout));
  const added = on.stderr.split(/\r?\n/).filter(Boolean).filter((l) => !off.stderr.includes(l));
  assert.equal(added.length, 1, on.stderr);
  assert.match(added[0], /^harness: export failed: cannot write /);
  assert.ok(added[0].includes(blocker));
});

test('F63 ES-1: a failing default-on automatic export of eval keeps its result and leaves one "export failed" line', async () => {
  const blocker = path.join(tmpdir(), 'hub-is-a-file');
  fs.writeFileSync(blocker, 'x');
  const a = await evalWith(fixture({ telemetry: { share: false }, config: EVAL_CONFIG }), envFor(blocker));
  const b = await evalWith(fixture({ config: EVAL_CONFIG }), envFor(blocker));
  assert.equal(b.code, a.code);
  assert.equal(b.code, 0, b.out + b.err);
  const strip = (s) => { const j = JSON.parse(s); delete j.file; delete j.costUsd; delete j.duration_ms; return j; };
  assert.deepEqual(Object.keys(strip(b.out)).sort(), Object.keys(strip(a.out)).sort());
  assert.equal(strip(b.out).verdict, strip(a.out).verdict);
  const added = b.err.split(/\r?\n/).filter(Boolean).filter((l) => !a.err.includes(l));
  assert.equal(added.length, 1, b.err);
  assert.match(added[0], /^harness: export failed: cannot write /);
});
