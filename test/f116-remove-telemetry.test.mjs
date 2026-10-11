import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BIN, REPO, harness, tmpdir, fakeNodeCli } from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';
import { hashContract } from '../lib/contract.mjs';

// F116: telemetry, learn and insights are gone — export, learn, insights, ci-record and note
// are unknown commands, run and eval export nothing, the config key telemetry is ignored, and
// events, stats and decide stay.

const FIX = path.join(REPO, 'test', 'fixtures');
const REMOVED_COMMANDS = ['export', 'learn', 'insights', 'ci-record', 'note'];
const REMOVED_FILES = [
  'lib/telemetry.mjs', 'lib/learn.mjs', 'lib/insights.mjs', 'docs/telemetry.md',
  ...REMOVED_COMMANDS.map((c) => `lib/commands/${c}.mjs`),
];
const REMOVED_MODULES = ['lib/telemetry', 'lib/learn', 'lib/insights', ...REMOVED_COMMANDS.map((c) => `lib/commands/${c}`)];

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-11T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture({ config = {}, features = ['F1'] } = {}) {
  const all = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, roles: { builder: 'claude', evaluator: 'claude', 'security-reviewer': 'claude' }, ...config },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: features.map((id) => ({ id, title: `feature ${id}`, security_tier: 'standard', depends_on: [], status: 'approved' })) },
    'scripts/ok.mjs': 'process.exit(0);\n',
  };
  for (const id of features) all[`.harness/contracts/${id}.json`] = contract(id);
  return gitRepo(all, { branch: null });
}

const gitDir = () => path.dirname(spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim());

// The real CLI with a fake claude first on PATH printing the evaluator's pass reply, and HOME a
// directory of its own.
function cli(args, dir, home) {
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const reply = path.join(tmpdir('harness-f116-reply-'), 'reply.json');
  fs.writeFileSync(reply, fs.readFileSync(path.join(FIX, 'eval', 'pass.json'), 'utf8'));
  const env = {
    ...process.env, HOME: home, USERPROFILE: home,
    [pathKey]: [fakeNodeCli('claude', path.join(FIX, 'fake-claude.mjs')), path.dirname(process.execPath), gitDir()].join(path.delimiter),
    FAKE_CLAUDE_REPLY: reply, FAKE_CLAUDE_EXIT: '0',
  };
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, env, encoding: 'utf8', timeout: 180000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const specifiers = (src) => [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"]+)\1/g)].map((m) => m[2]);

// ---------- AC-1 ----------
test('F116 AC-1: export, learn, insights, ci-record and note are unknown commands and not in --help', () => {
  const dir = fixture();
  const help = harness(['--help'], { cwd: dir });
  assert.equal(help.code, 0);
  const listed = help.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]);
  for (const c of REMOVED_COMMANDS) {
    const r = harness([c], { cwd: dir });
    assert.equal(r.code, 2, `${c}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /unknown command/, c);
    assert.equal(listed.includes(c), false, `${c} listed in --help`);
  }
});

test('F116 AC-1: the telemetry, learn and insights files are gone and no lib or bin file imports them', () => {
  for (const f of REMOVED_FILES) assert.equal(fs.existsSync(path.join(REPO, f)), false, f);
  const files = [...walk(path.join(REPO, 'lib')), ...walk(path.join(REPO, 'bin'))].filter((f) => f.endsWith('.mjs'));
  assert.ok(files.length > 20);
  for (const file of files) {
    for (const spec of specifiers(fs.readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) continue;
      const target = path.relative(REPO, path.resolve(path.dirname(file), spec)).split(path.sep).join('/').replace(/\.mjs$/, '');
      assert.equal(REMOVED_MODULES.includes(target), false, `${path.relative(REPO, file)} imports ${spec}`);
    }
  }
});

// ---------- AC-2 ----------
test('F116 AC-2: run and eval export nothing — no <HOME>/.cc-harness and no telemetry or exported on stderr', () => {
  const home = tmpdir('harness-f116-home-');
  const dir = fixture();
  const e = cli(['eval', 'F1'], dir, home);
  const r = cli(['run', 'F1'], dir, home);
  for (const x of [e, r]) {
    assert.doesNotMatch(x.stderr, /telemetry|exported/i, x.stderr);
    assert.doesNotMatch(x.stdout, /telemetry|exported/i, x.stdout);
  }
  assert.equal(fs.existsSync(path.join(home, '.cc-harness')), false);
});

test('F116 AC-2: harness doctor prints no telemetry line', () => {
  const dir = fixture();
  const r = harness(['doctor'], { cwd: dir });
  assert.doesNotMatch(r.stdout, /^telemetry:/m, r.stdout);
  assert.doesNotMatch(r.stdout + r.stderr, /telemetry/i);
});

// ---------- AC-3 ----------
test('F116 AC-3: a telemetry key in the config is ignored — status, verify and doctor give no config_invalid', () => {
  const dir = fixture({ config: { telemetry: { share: true, auto_export: true } } });
  for (const args of [['status'], ['verify', 'F1'], ['doctor']]) {
    const r = harness(args, { cwd: dir });
    assert.doesNotMatch(r.stdout + r.stderr, /config_invalid|unknown key|telemetry/i, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.notEqual(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  }
});

// ---------- AC-4 ----------
test('F116 AC-4: decide records a decision backlog item and a feedback/decision event; events and stats still run', () => {
  const dir = fixture();
  const d = harness(['decide', 'F1', '--accept-risk', 'known gap'], { cwd: dir });
  assert.equal(d.code, 0, d.stdout + d.stderr);
  const items = JSON.parse(fs.readFileSync(path.join(dir, '.harness', 'backlog.json'), 'utf8')).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'decision');
  const events = harness(['events', '--stage', 'feedback', '--json'], { cwd: dir });
  assert.equal(events.code, 0, events.stdout + events.stderr);
  const [e] = JSON.parse(events.stdout);
  assert.equal(e.type, 'decision');
  assert.equal(e.data.decision, 'accept-risk');
  assert.equal(harness(['stats'], { cwd: dir }).code, 0);
  // the event log is read by events, not by an insights command
  assert.equal(harness(['insights'], { cwd: dir }).code, 2);
});

test('F116 AC-4: decide with an empty reason exits 2 and records nothing', () => {
  const dir = fixture();
  const r = harness(['decide', 'F1', '--split', '  '], { cwd: dir });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.harness', 'backlog.json'), 'utf8')).items, []);
  assert.equal(fs.existsSync(path.join(dir, '.harness', 'events')) && walk(path.join(dir, '.harness', 'events')).some((f) => fs.readFileSync(f, 'utf8').includes('"decision"')), false);
});

// ---------- AC-7 ----------
test('F116 AC-7: the docs name none of the removed commands and SPEC §2 says telemetry left in v2.0.65', () => {
  const forbidden = ['harness export', 'harness learn', 'harness insights', 'ci-record', 'harness note', 'CC_HARNESS_TELEMETRY', 'docs/telemetry.md'];
  for (const f of ['docs/SPEC.md', 'README.md', 'AGENTS.md', 'docs/MAP.md']) {
    const text = fs.readFileSync(path.join(REPO, f), 'utf8');
    for (const w of forbidden) assert.equal(text.includes(w), false, `${f} mentions ${w}`);
  }
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const section = spec.slice(spec.indexOf('## 2. '), spec.indexOf('## 3. '));
  assert.ok(section.split('\n').some((l) => l.includes('telemetry') && l.includes('v2.0.65') && l.includes('무시')), 'the one sentence in §2');
});

// ---------- ES-1 ----------
test('F116 ES-1: an earlier bundle in <HOME>/.cc-harness/hub keeps its content and mtime through run, eval and doctor', () => {
  const home = tmpdir('harness-f116-home-');
  const hub = path.join(home, '.cc-harness', 'hub', '0123456789abcdef');
  fs.mkdirSync(hub, { recursive: true });
  const bundle = path.join(hub, '20260928T123456.789Z.jsonl');
  fs.writeFileSync(bundle, '{"ts":"2026-09-28T12:34:56.789Z","stage":"plan"}\n');
  const old = new Date('2026-09-28T12:34:56.789Z');
  fs.utimesSync(bundle, old, old);
  const before = { text: fs.readFileSync(bundle, 'utf8'), mtime: fs.statSync(bundle).mtimeMs, names: walk(path.join(home, '.cc-harness')) };
  const dir = fixture();
  cli(['eval', 'F1'], dir, home);
  cli(['run', 'F1'], dir, home);
  cli(['doctor'], dir, home);
  assert.equal(fs.readFileSync(bundle, 'utf8'), before.text);
  assert.equal(fs.statSync(bundle).mtimeMs, before.mtime);
  assert.deepEqual(walk(path.join(home, '.cc-harness')), before.names);
});
