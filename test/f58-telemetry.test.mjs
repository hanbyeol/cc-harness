import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { harness, REPO, tmpdir } from './helpers.mjs';
import { git, gitRepo } from './gitfixture.mjs';
import { hashContract } from '../lib/contract.mjs';
import { recordEvent } from '../lib/events.mjs';
import { LINE_FIELDS, ENUM_FIELDS } from '../lib/telemetry.mjs';
import { runExport } from '../lib/commands/export.mjs';
import evalCommand from '../lib/commands/eval.mjs';

// F58: `harness export` — opt-in export of anonymized events to a local hub directory.

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

const SHARE = { share: true };
function fixture({ telemetry, config = {}, files = {}, status = 'approved' } = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...(telemetry === undefined ? {} : { telemetry }), ...config },
    '.harness/features.json': { features: [{ id: 'F9', title: 'feature F9', status, depends_on: [] }] },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/contracts/F9.json': contract(),
    'scripts/ok.mjs': 'process.exit(0);\n',
    ...files,
  }, { branch: null });
}

const exportedPath = (dir) => path.join(dir, '.harness', 'events', '.exported');
const projectOf = (dir) => sha16(git(dir, 'rev-parse', '--show-toplevel'));
const listFiles = (d) => {
  try { return fs.readdirSync(d).sort(); } catch { return []; }
};
const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// Every bundle under <hub>/<project>/, oldest first.
const bundles = (hub, dir) => listFiles(path.join(hub, projectOf(dir))).map((n) => path.join(hub, projectOf(dir), n));
const hubText = (hub) => {
  const out = [];
  const walk = (d) => {
    for (const n of listFiles(d)) {
      const p = path.join(d, n);
      out.push(n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(hub);
  return out.join('\n');
};
const note = (dir, text, at) => recordEvent(dir, { stage: 'feedback', type: 'intervention', feature: 'F9', data: { kind: 'other', text } }, { now: new Date(at) });
const collect = () => {
  const out = [];
  const err = [];
  return { out, err, o: (s) => out.push(s), e: (s) => err.push(s) };
};

// ---------- AC-1 ----------
test('F58 AC-1: export with telemetry.share unset or false says it is off and writes nothing', () => {
  for (const telemetry of [undefined, { share: false }, { share: 'true', auto_export: true }, {}]) {
    const dir = fixture({ telemetry });
    note(dir, 'x', '2026-09-01T00:00:00Z');
    const hub = path.join(tmpdir(), 'hub');
    for (const args of [['export', '--hub', hub], ['export', '--hub', hub, '--dry-run'], ['export']]) {
      const r = harness(args, { cwd: dir, env: { CC_HARNESS_HUB: hub } });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /telemetry\.share is off/);
      assert.equal(fs.existsSync(hub), false);
      assert.equal(fs.existsSync(exportedPath(dir)), false);
    }
  }
});

test('F58 AC-1: export with telemetry.share true writes the bundle', () => {
  const dir = fixture({ telemetry: SHARE });
  note(dir, 'x', '2026-09-01T00:00:00Z');
  const hub = path.join(tmpdir(), 'hub');
  const r = harness(['export', '--hub', hub], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /is off/);
  assert.equal(bundles(hub, dir).length, 1);
});

// ---------- AC-2 ----------
test('F58 AC-2: export writes <hub>/<project>/<ISO time>.jsonl and records the export time in events/.exported', () => {
  const dir = fixture({ telemetry: SHARE });
  note(dir, 'a', '2026-09-01T00:00:00Z');
  note(dir, 'b', '2026-09-02T00:00:00Z');
  const hub = path.join(tmpdir(), 'hub');
  const c = collect();
  const now = new Date('2026-09-10T01:02:03.456Z');
  assert.equal(runExport({ root: dir, hub, out: c.o, err: c.e, now }), 0, c.err.join('\n'));
  assert.deepEqual(listFiles(hub), [projectOf(dir)]);
  const [file] = bundles(hub, dir);
  assert.equal(path.basename(file), '20260910T010203.456Z.jsonl');
  assert.deepEqual(readLines(file).map((l) => l.ts), ['2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z']);
  assert.equal(fs.readFileSync(exportedPath(dir), 'utf8').trim(), now.toISOString());
  assert.match(c.out.join('\n'), /exported 2 lines to /);
});

test('F58 AC-2: a second export writes only the events after the last export, never one twice', () => {
  const dir = fixture({ telemetry: SHARE });
  const hub = path.join(tmpdir(), 'hub');
  const c = collect();
  note(dir, 'a', '2026-09-01T00:00:00Z');
  assert.equal(runExport({ root: dir, hub, out: c.o, err: c.e, now: new Date('2026-09-05T00:00:00Z') }), 0);
  // nothing new: no bundle, the export time stays
  assert.equal(runExport({ root: dir, hub, out: c.o, err: c.e, now: new Date('2026-09-06T00:00:00Z') }), 0);
  assert.equal(bundles(hub, dir).length, 1);
  assert.match(c.out.at(-1), /nothing to export/);
  assert.equal(fs.readFileSync(exportedPath(dir), 'utf8').trim(), '2026-09-05T00:00:00.000Z');
  // an event at the export time itself belongs to the next export
  note(dir, 'b', '2026-09-05T00:00:00Z');
  note(dir, 'c', '2026-09-07T00:00:00Z');
  note(dir, 'late', '2026-09-09T00:00:00Z'); // after `now` of the next export
  assert.equal(runExport({ root: dir, hub, out: c.o, err: c.e, now: new Date('2026-09-08T00:00:00Z') }), 0);
  const files = bundles(hub, dir);
  assert.equal(files.length, 2);
  assert.deepEqual(readLines(files[0]).map((l) => l.ts), ['2026-09-01T00:00:00.000Z']);
  assert.deepEqual(readLines(files[1]).map((l) => l.ts), ['2026-09-05T00:00:00.000Z', '2026-09-07T00:00:00.000Z']);
  assert.equal(runExport({ root: dir, hub, out: c.o, err: c.e, now: new Date('2026-09-10T00:00:00Z') }), 0);
  const all = bundles(hub, dir).flatMap((f) => readLines(f).map((l) => l.ts));
  assert.equal(new Set(all).size, all.length);
  assert.equal(all.length, 4);
});

test('F58 AC-2: the hub is --hub, else CC_HARNESS_HUB, else <home>/.cc-harness/hub', () => {
  const home = tmpdir();
  const envHub = path.join(tmpdir(), 'env-hub');
  const flagHub = path.join(tmpdir(), 'flag-hub');
  const noHubEnv = { CC_HARNESS_HUB: '', HOME: home, USERPROFILE: home };

  let dir = fixture({ telemetry: SHARE });
  note(dir, 'a', '2026-09-01T00:00:00Z');
  let r = harness(['export'], { cwd: dir, env: noHubEnv });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const homeHub = path.join(home, '.cc-harness', 'hub');
  assert.equal(bundles(homeHub, dir).length, 1);

  dir = fixture({ telemetry: SHARE });
  note(dir, 'a', '2026-09-01T00:00:00Z');
  r = harness(['export'], { cwd: dir, env: { ...noHubEnv, CC_HARNESS_HUB: envHub } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(bundles(envHub, dir).length, 1);

  dir = fixture({ telemetry: SHARE });
  note(dir, 'a', '2026-09-01T00:00:00Z');
  r = harness(['export', '--hub', flagHub], { cwd: dir, env: { ...noHubEnv, CC_HARNESS_HUB: envHub } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(bundles(flagHub, dir).length, 1);
  assert.equal(bundles(envHub, dir).length, 0);

  // bad arguments
  assert.equal(harness(['export', '--hub'], { cwd: dir }).code, 2);
  assert.equal(harness(['export', '--bogus'], { cwd: dir }).code, 2);
});

// ---------- AC-3 ----------
test('F58 AC-3: an exported line keeps only the allowed fields and the numbers, booleans and enumerated values of data', () => {
  const dir = fixture({ telemetry: SHARE });
  const raw = {
    ts: '2026-09-01T00:00:00.000Z', stage: 'eval', type: 'finding', feature: 'F9', round: 2,
    harness_version: '2.0.25', profile: 'sdlc', project: 'x', extra: 'dropped',
    data: {
      duration_ms: 1200, cost_usd: 0.5, ok: true, retried: false,
      outcome: 'backlogged', reason: 'repro_not_reproduced', model: 'claude-opus-5-5', role: 'evaluator',
      dimension: 'security', kind: 'manual-fix', rule: 'check', tests: ['test one', 'test two'], test: 'solo',
      summary: 'text', criterion_id: 'AC-1',
      errors: [{ rule: 'size', id: 'AC-2' }, { rule: 'not-a-rule', id: 'AC-3' }],
      added: ['AC-1'], criteria: { 'AC-1': 'abc' }, empty: [], nested: { turns: 3, note: 'x' },
      bad_enum: { reason: 'free text reason', outcome: 'maybe', role: 'boss', dimension: 'speed', kind: 'rumor', model: '/a/b c' },
    },
  };
  fs.mkdirSync(path.join(dir, '.harness', 'events'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.harness', 'events', '2026-09.jsonl'), `${JSON.stringify(raw)}\n`);
  const hub = path.join(tmpdir(), 'hub');
  const c = collect();
  assert.equal(runExport({ root: dir, hub, out: c.o, err: c.e, now: new Date('2026-09-10T00:00:00Z') }), 0);
  const [line] = readLines(bundles(hub, dir)[0]);
  assert.deepEqual(Object.keys(line), [...LINE_FIELDS, 'data']);
  assert.deepEqual(line, {
    ts: '2026-09-01T00:00:00.000Z', stage: 'eval', type: 'finding', harness_version: '2.0.25', profile: 'sdlc',
    project: projectOf(dir), round: 2,
    data: {
      duration_ms: 1200, cost_usd: 0.5, ok: true, retried: false,
      outcome: 'backlogged', reason: 'repro_not_reproduced', model: 'claude-opus-5-5', role: 'evaluator',
      dimension: 'security', kind: 'manual-fix', rule: 'check', tests: [sha16('test one'), sha16('test two')], test: sha16('solo'),
      errors: [{ rule: 'size' }],
      empty: [], nested: { turns: 3 },
    },
  });
});

test('F58 AC-3: the allowlist in the code is the table in the SPEC', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const start = spec.indexOf('| 내보내는 필드 |');
  assert.ok(start >= 0, 'SPEC has the export allowlist table');
  const after = spec.slice(start).split('\n').slice(2);
  const rows = after.slice(0, after.findIndex((l) => !l.startsWith('|')));
  const specLine = [];
  const specEnum = [];
  for (const row of rows) {
    const [field, kind] = row.split('|').slice(1, 3).map((s) => s.trim());
    const name = /^`([^`]+)`$/.exec(field)?.[1];
    assert.ok(name, `table row names a field: ${row}`);
    if (name.startsWith('data.')) specEnum.push(name.slice(5));
    else specLine.push(name);
    assert.ok(kind, row);
  }
  assert.deepEqual(specLine, [...LINE_FIELDS]);
  assert.deepEqual(specEnum, Object.keys(ENUM_FIELDS));
  for (const [key, values] of Object.entries(ENUM_FIELDS)) {
    if (!Array.isArray(values)) continue;
    const row = rows.find((r) => r.includes(`\`data.${key}\``));
    for (const v of values) assert.ok(row.includes(`\`${v}\``), `SPEC row data.${key} lists ${v}`);
  }
  // numbers and booleans in data are kept under any identifier key: said in the text, not the table
  assert.match(spec, /수치·불리언/);
});

// ---------- AC-4 ----------
test('F58 AC-4: export --dry-run shows the number of lines and the first 3 without writing', () => {
  const dir = fixture({ telemetry: SHARE });
  for (let i = 1; i <= 5; i += 1) note(dir, `n${i}`, `2026-09-0${i}T00:00:00Z`);
  const hub = path.join(tmpdir(), 'hub');
  const r = harness(['export', '--hub', hub, '--dry-run'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /\b5 lines\b/);
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.slice(1).map((l) => JSON.parse(l).ts), ['2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', '2026-09-03T00:00:00.000Z']);
  for (const l of lines.slice(1)) assert.deepEqual(JSON.parse(l).data, { kind: 'other' });
  assert.equal(fs.existsSync(hub), false);
  assert.equal(fs.existsSync(exportedPath(dir)), false);
  // the real export afterwards still has all 5
  assert.equal(harness(['export', '--hub', hub], { cwd: dir }).code, 0);
  assert.equal(readLines(bundles(hub, dir)[0]).length, 5);
});

// ---------- AC-5 ----------
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

async function evalWithHub(dir, hub) {
  const saved = process.env.CC_HARNESS_HUB;
  process.env.CC_HARNESS_HUB = hub;
  try {
    const c = collect();
    const code = await evalCommand({
      root: dir, args: ['F9', '--json'], out: c.o, err: c.e,
      deps: { runAdapter: async () => PASS_REPLY(), verifyResult: PASS_VERIFY },
    });
    return { code, out: c.out.join('\n'), err: c.err.join('\n') };
  } finally {
    if (saved === undefined) delete process.env.CC_HARNESS_HUB;
    else process.env.CC_HARNESS_HUB = saved;
  }
}

test('F58 AC-5: eval exports automatically when telemetry.share and telemetry.auto_export are true', async () => {
  const dir = fixture({ telemetry: { share: true, auto_export: true }, config: EVAL_CONFIG });
  const hub = path.join(tmpdir(), 'hub');
  const r = await evalWithHub(dir, hub);
  assert.equal(r.code, 0, r.out + r.err);
  JSON.parse(r.out); // stdout is still only the JSON result
  const [file] = bundles(hub, dir);
  assert.ok(file, r.err);
  assert.ok(readLines(file).some((l) => l.stage === 'eval' && l.type === 'status'));
  assert.ok(fs.existsSync(exportedPath(dir)));
});

test('F58 AC-5: eval does not export when auto_export or share is not true', async () => {
  for (const telemetry of [{ share: true }, { share: true, auto_export: false }, { share: false, auto_export: true }]) {
    const dir = fixture({ telemetry, config: EVAL_CONFIG });
    const hub = path.join(tmpdir(), 'hub');
    const r = await evalWithHub(dir, hub);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(fs.existsSync(hub), false, JSON.stringify(telemetry));
  }
});

test('F58 AC-5: a failing auto export does not change the eval result', async () => {
  const off = fixture({ config: EVAL_CONFIG });
  const on = fixture({ telemetry: { share: true, auto_export: true }, config: EVAL_CONFIG });
  const blocker = path.join(tmpdir(), 'hub-is-a-file');
  fs.writeFileSync(blocker, 'x');
  const a = await evalWithHub(off, blocker);
  const b = await evalWithHub(on, blocker);
  assert.equal(b.code, a.code);
  assert.equal(b.code, 0);
  const strip = (s) => { const j = JSON.parse(s); delete j.file; delete j.costUsd; delete j.duration_ms; return Object.keys(j).sort(); };
  assert.deepEqual(strip(b.out), strip(a.out));
  assert.equal(JSON.parse(b.out).verdict, JSON.parse(a.out).verdict);
  assert.match(b.err, /export failed/);
  assert.ok(b.err.includes(blocker));
});

test('F58 AC-5: run exports automatically at the end, and a failing export keeps the run exit code', () => {
  // No approved feature: the run starts no builder and ends at once.
  const dir = fixture({ telemetry: { share: true, auto_export: true }, status: 'todo' });
  note(dir, 'before run', '2026-09-01T00:00:00Z');
  const hub = path.join(tmpdir(), 'hub');
  let r = harness(['run'], { cwd: dir, env: { CC_HARNESS_HUB: hub } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no approved, executable features in scope/);
  const [file] = bundles(hub, dir);
  assert.ok(file, r.stdout + r.stderr);
  assert.ok(readLines(file).some((l) => l.stage === 'feedback' && l.type === 'intervention'));
  assert.doesNotMatch(r.stdout, /exported/); // reported on stderr only
  assert.match(r.stderr, /exported \d+ lines? to /);

  const off = fixture({ telemetry: { share: true, auto_export: false }, status: 'todo' });
  note(off, 'before run', '2026-09-01T00:00:00Z');
  const offHub = path.join(tmpdir(), 'hub');
  r = harness(['run'], { cwd: off, env: { CC_HARNESS_HUB: offHub } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(offHub), false);

  const failing = fixture({ telemetry: { share: true, auto_export: true }, status: 'todo' });
  note(failing, 'before run', '2026-09-01T00:00:00Z');
  const blocker = path.join(tmpdir(), 'hub-is-a-file');
  fs.writeFileSync(blocker, 'x');
  r = harness(['run'], { cwd: failing, env: { CC_HARNESS_HUB: blocker } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no approved, executable features in scope/);
  assert.match(r.stderr, /export failed/);
});

// ---------- AC-6 ----------
test('F58 AC-6: SPEC and docs describe the opt-in, the allowed fields and the hub location', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'telemetry.md'), 'utf8');
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  for (const text of [spec, doc]) {
    for (const s of ['harness export', 'telemetry.share', 'telemetry.auto_export', 'opt-in', '--dry-run', '--hub', 'CC_HARNESS_HUB', '.cc-harness/hub', 'events/.exported']) {
      assert.ok(text.includes(s), `mentions ${s}`);
    }
  }
  for (const f of [...LINE_FIELDS, ...Object.keys(ENUM_FIELDS)]) assert.ok(doc.includes(`\`${f}\``) || doc.includes(`\`data.${f}\``), `docs/telemetry.md lists ${f}`);
  assert.ok(readme.includes('harness export'));
  assert.ok(readme.includes('docs/telemetry.md'));
  assert.match(harness(['--help']).stdout, /export\s+export anonymized events/);
});

// ---------- SC-1 ----------
test('F58 SC-1: the bundle has no title, criterion, finding summary, command, file path, session id or env value', () => {
  const M = {
    title: 'MARKtitle-7f3a', criterion: 'MARKcriterion-7f3a', summary: 'MARKsummary-7f3a', command: 'MARKcommand-7f3a',
    path: 'MARKpath-7f3a', session: 'MARKsession-7f3a', env: 'MARKenv-7f3a', test: 'MARKtest-7f3a', note: 'MARKnote-7f3a',
  };
  const dir = fixture({ telemetry: SHARE });
  const filePath = path.join(dir, 'src', `${M.path}.mjs`);
  const raw = [
    {
      ts: '2026-09-01T00:00:00.000Z', stage: 'eval', type: 'finding', feature: 'F9', round: 1, title: M.title, session_id: M.session,
      harness_version: '2.0.25', profile: 'sdlc', project: dir,
      data: {
        title: M.title, criterion: M.criterion, summary: M.summary, repro: `node ${M.command}`, command: M.command, cmd: M.command,
        check: M.command, file: filePath, path: filePath, cwd: dir, session_id: M.session, sessionId: M.session,
        env: { [M.env.toUpperCase()]: M.env, home: M.env }, [M.env]: 1,
        // markers in allowlisted keys with values outside their enumeration
        reason: M.summary, outcome: M.summary, role: M.title, dimension: M.criterion, kind: M.note, rule: M.criterion, model: filePath,
        findings: [{ summary: M.summary, repro: M.command, file: filePath, criterion_id: 'AC-1', dimension: 'security', exit: 3 }],
        criteria: { [M.criterion]: M.criterion },
      },
    },
    {
      ts: '2026-09-02T00:00:00.000Z', stage: 'build', type: M.title, feature: M.title,
      harness_version: M.env, profile: M.path, project: M.path, data: [M.summary],
    },
  ];
  fs.mkdirSync(path.join(dir, '.harness', 'events'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.harness', 'events', '2026-09.jsonl'), raw.map((e) => JSON.stringify(e)).join('\n') + '\n');
  // and through the real commands: a note, a decision and a CI record with marker text
  const env = { [M.env.toUpperCase().replace(/-/g, '_')]: M.env };
  assert.equal(harness(['note', 'F9', '--kind', 'other', `${M.note} ${M.path}`], { cwd: dir, env }).code, 0);
  assert.equal(harness(['decide', 'F9', '--accept-risk', M.summary], { cwd: dir, env }).code, 0);
  assert.equal(harness(['ci-record', '--sha', 'abc123', '--result', 'failure', '--job', M.command, '--test', M.test], { cwd: dir, env }).code, 0);

  const hub = path.join(tmpdir(), 'hub');
  const r = harness(['export', '--hub', hub], { cwd: dir, env });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const text = hubText(hub);
  const lines = bundles(hub, dir).flatMap(readLines);
  assert.equal(lines.length, 5);
  for (const [what, m] of Object.entries(M)) assert.equal(text.toLowerCase().includes(m.toLowerCase()), false, `${what} marker leaked`);
  assert.equal(text.includes('MARK'), false);
  assert.equal(text.includes(dir), false);
  // the CI test name is there only as its hash; the finding's dimension survives
  const ci = lines.find((l) => l.type === 'ci');
  assert.deepEqual(ci.data.tests, [sha16(M.test)]);
  assert.equal(lines[0].data.findings[0].dimension, 'security');
  assert.equal(lines[1].type, null);
  assert.equal(lines[1].profile, null);
  assert.equal(lines[1].harness_version, null);
});

// ---------- SC-2 ----------
test('F58 SC-2: the project is only the path hash; no repository path, git remote or user name in the bundle', () => {
  const dir = fixture({ telemetry: SHARE });
  const remote = 'https://example.invalid/remoteorg-5c1d/remoterepo-5c1d.git';
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'config', 'user.name', 'Username-5c1d');
  git(dir, 'config', 'user.email', 'useremail-5c1d@example.invalid');
  harness(['note', '--kind', 'other', 'x'], { cwd: dir });
  // an event from a subdirectory project records the same top-level hash
  recordEvent(dir, { stage: 'feedback', type: 'intervention', data: { kind: 'other', remote, user: os.userInfo().username } }, { now: new Date('2026-09-01T00:00:00Z') });
  const hub = path.join(tmpdir(), 'hub');
  const r = harness(['export', '--hub', hub], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const project = projectOf(dir);
  assert.match(project, /^[0-9a-f]{16}$/);
  assert.deepEqual(listFiles(hub), [project]);
  const lines = bundles(hub, dir).flatMap(readLines);
  assert.equal(lines.length, 2);
  for (const l of lines) assert.equal(l.project, project);
  const text = hubText(hub);
  const top = git(dir, 'rev-parse', '--show-toplevel');
  for (const s of [dir, top, fs.realpathSync.native(dir), path.basename(dir), remote, 'remoteorg-5c1d', 'remoterepo-5c1d', 'Username-5c1d', 'useremail-5c1d']) {
    assert.equal(text.includes(s), false, `${s} leaked`);
  }
  const user = os.userInfo().username;
  // a short or hex-only user name could occur inside a hash by chance
  if (user.length >= 4 && /[^0-9a-f]/i.test(user)) assert.equal(text.toLowerCase().includes(user.toLowerCase()), false, 'user name leaked');
});

// ---------- ES-1 ----------
test('F58 ES-1: an unwritable hub prints the path and the error, exits 1 and leaves .exported unchanged', () => {
  const dir = fixture({ telemetry: SHARE });
  note(dir, 'a', '2026-09-01T00:00:00Z');
  const blocker = path.join(tmpdir(), 'hub-is-a-file');
  fs.writeFileSync(blocker, 'x');
  let r = harness(['export', '--hub', blocker], { cwd: dir });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.ok(r.stderr.includes(blocker), r.stderr);
  assert.match(r.stderr, /E(EXIST|NOTDIR|ACCES|PERM)/);
  assert.equal(fs.existsSync(exportedPath(dir)), false);

  // with an earlier export time recorded, it stays as it was
  const hub = path.join(tmpdir(), 'hub');
  const c = collect();
  assert.equal(runExport({ root: dir, hub, out: c.o, err: c.e, now: new Date('2026-09-05T00:00:00Z') }), 0);
  const before = fs.readFileSync(exportedPath(dir), 'utf8');
  note(dir, 'b', '2026-09-06T00:00:00Z');
  r = harness(['export', '--hub', path.join(blocker, 'sub')], { cwd: dir });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.ok(r.stderr.includes(path.join(blocker, 'sub')), r.stderr);
  assert.equal(fs.readFileSync(exportedPath(dir), 'utf8'), before);
  // the event is still exported later
  assert.equal(harness(['export', '--hub', hub], { cwd: dir }).code, 0);
  assert.deepEqual(bundles(hub, dir).flatMap(readLines).map((l) => l.ts), ['2026-09-01T00:00:00.000Z', '2026-09-06T00:00:00.000Z']);
});
