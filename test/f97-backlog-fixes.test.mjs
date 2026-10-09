// F97: a batch of backlog fixes — repro_program length cap, note's feature id check, unused
// reviewer findings after an eval_error, export name collisions, learn --json --compare, the
// profile section's anchor, and tests for init's CLAUDE.md warnings and effort-free reviews.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, harness, project, tmpdir } from './helpers.mjs';
import { gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { evaluate, reproProgram } from '../lib/eval.mjs';
import { recordEvent } from '../lib/events.mjs';
import { planExport } from '../lib/telemetry.mjs';
import { runExport } from '../lib/commands/export.mjs';
import { renderBlock, TEMPLATE } from '../lib/claudemd.mjs';

// ------------------------------------------------------------------ eval fixtures

const contract = (over = {}) => ({
  id: 'F9', title: 'fixture feature', security_tier: 'standard', version: 1,
  acceptance_criteria: [{ id: 'AC-1', criterion: 'one', check: 'node scripts/ok.mjs', new: false }],
  security_criteria: [{ id: 'SC-1', criterion: 'no secrets', check: 'node scripts/ok.mjs', new: false }],
  error_scenarios: [],
  out_of_scope: [],
  ...over,
});

function evalFixture(c = contract()) {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': c,
    '.harness/backlog.json': { items: [] },
    'scripts/ok.mjs': 'process.exit(0);\n',
    'scripts/fail.mjs': 'process.exit(3);\n',
  });
  writeFiles(dir, { 'src/app.mjs': 'export const v = 1;\n' });
  commitAll(dir, 'feature commit');
  return dir;
}

const cfg = (roles = { builder: 'claude', evaluator: 'claude', 'security-reviewer': 'claude' }) => resolveConfig({
  base_branch: 'main', roles, verify: { commands: [] }, budget: { step_timeout_sec: 30 },
});

const PASS_VERIFY = {
  pass: true, commands: [], warnings: [],
  integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } },
  criteria: [{ id: 'AC-1', pass: true }, { id: 'SC-1', pass: true }],
};

const scores = (o = {}) => ({ functionality: 9, quality: 9, security: 9, errors: 9, tests: 9, ...o });
const reply = (json) => ({ ok: true, error: null, text: JSON.stringify(json), json, costUsd: 0.01, exitCode: 0 });
const good = (o = {}, findings = []) => reply({ scores: scores(o), findings, out_of_scope: [] });
const finding = (criterion_id, repro, dimension = 'functionality') => ({ criterion_id, dimension, summary: `${criterion_id} defect`, repro });

function scripted(script) {
  const queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]));
  return async (role) => {
    const q = queues[role];
    if (!q || q.length === 0) throw new Error(`unexpected call for role ${role}`);
    return q.shift();
  };
}

const runEval = (dir, script, config = cfg()) => evaluate({
  root: dir, featureId: 'F9', base: 'main', config, verifyResult: PASS_VERIFY, runAdapter: scripted(script),
});

const events = (dir) => {
  const d = path.join(dir, '.harness', 'events');
  let names = [];
  try { names = fs.readdirSync(d).filter((n) => n.endsWith('.jsonl')).sort(); } catch { return []; }
  return names.flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
};
const of = (dir, stage, type) => events(dir).filter((e) => e.stage === stage && e.type === type);

// ------------------------------------------------------------------ AC-1

test('F97 AC-1 reproProgram cuts a program name longer than 100 code points to 100', () => {
  const long = 'a'.repeat(500);
  assert.equal(reproProgram(`${long} --flag`).length, 100);
  assert.equal(reproProgram(`${long} --flag`), 'a'.repeat(100));
  // counted in code points, not UTF-16 units
  const emoji = '😀'.repeat(150);
  assert.equal(Array.from(reproProgram(emoji)).length, 100);
  assert.equal(reproProgram('a'.repeat(100)), 'a'.repeat(100));
  assert.equal(reproProgram('node x.mjs'), 'node');
});

test('F97 AC-1 a finding event keeps a repro_program of length 100 for a 500-character first word', async () => {
  const dir = evalFixture();
  await runEval(dir, { evaluator: [good({ functionality: 3 }, [finding('AC-1', `${'b'.repeat(500)} arg`)])] });
  const [e] = of(dir, 'eval', 'finding');
  assert.equal(e.data.repro_program.length, 100);
});

// ------------------------------------------------------------------ AC-2

test('F97 AC-2 note with an unknown feature id is a usage error naming it and records no event', () => {
  const dir = project([{ id: 'F2', title: 'two', status: 'todo', depends_on: [] }]);
  const r = harness(['note', 'F77', '--kind', 'other', 'typo'], { cwd: dir });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /F77/);
  assert.equal(events(dir).filter((e) => e.type === 'intervention').length, 0);
});

test('F97 AC-2 note with a known feature id or without one is recorded as before', () => {
  const dir = project([{ id: 'F2', title: 'two', status: 'todo', depends_on: [] }]);
  let r = harness(['note', 'F2', '--kind', 'other', 'known'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  r = harness(['note', '--kind', 'environment', 'no feature'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const notes = events(dir).filter((e) => e.type === 'intervention');
  assert.deepEqual(notes.map((e) => [e.feature ?? null, e.data.kind]), [['F2', 'other'], [null, 'environment']]);
});

// ------------------------------------------------------------------ AC-3

test('F97 AC-3 an evaluator eval_error marks the answering reviewer\'s security/finding events unused', async () => {
  const dir = evalFixture(contract({ security_tier: 'critical' }));
  const r = await runEval(dir, {
    evaluator: [reply({}), reply({})],
    'security-reviewer': [good({ security: 4 }, [finding('SC-1', 'node scripts/fail.mjs', 'security'), finding('AC-1', 'node scripts/ok.mjs')])],
  });
  assert.equal(r.verdict, 'eval_error');
  const fs2 = of(dir, 'security', 'finding');
  assert.equal(fs2.length, 2);
  for (const e of fs2) assert.equal(e.data.unused, true);
  assert.equal(of(dir, 'security', 'verdict')[0].data.reviewer, 'unused');
});

test('F97 AC-3 with evaluator and reviewer both answering and no evaluator blocking finding, no unused mark', async () => {
  const dir = evalFixture(contract({ security_tier: 'critical' }));
  await runEval(dir, {
    evaluator: [good()],
    'security-reviewer': [good({ security: 4 }, [finding('SC-1', 'node scripts/fail.mjs', 'security')])],
  });
  const [e] = of(dir, 'security', 'finding');
  assert.equal(Object.hasOwn(e.data, 'unused'), false);
});

test('F97 AC-3 SPEC §7.8 describes the unused mark after an eval_error', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s = spec.slice(spec.indexOf('8. **평가·보안 이벤트**'), spec.indexOf('## 8. '));
  assert.match(s, /eval_error[^\n]*`unused: true`/);
});

// ------------------------------------------------------------------ AC-4 / ES-1

function exportFixture() {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, telemetry: { share: true } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'feature F9', status: 'approved', depends_on: [] }] },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
  }, { branch: null });
  recordEvent(dir, { stage: 'feedback', type: 'intervention', feature: 'F9', data: { kind: 'other', text: 'x' } }, { now: new Date('2026-09-01T00:00:00Z') });
  return dir;
}
const collect = () => {
  const out = [];
  const err = [];
  return { out, err, o: (l) => out.push(l), e: (l) => err.push(l) };
};
const NOW = new Date('2026-10-09T01:02:03.456Z');

test('F97 AC-4 an export whose bundle name exists writes a suffixed bundle and leaves the existing one alone', () => {
  const dir = exportFixture();
  const hub = path.join(tmpdir(), 'hub');
  const { file } = planExport(dir, { hub, now: NOW });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'existing\n');
  const c = collect();
  const code = runExport({ root: dir, hub, out: c.o, err: c.e, now: NOW });
  assert.equal(code, 0, c.err.join('\n'));
  const names = fs.readdirSync(path.dirname(file)).sort();
  assert.equal(names.length, 2, names.join(','));
  assert.equal(fs.readFileSync(file, 'utf8'), 'existing\n');
  const other = path.join(path.dirname(file), names.find((n) => n !== path.basename(file)));
  const lines = fs.readFileSync(other, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.ok(c.out.some((l) => l.includes(other)), c.out.join('\n'));
});

test('F97 ES-1 when the suffixed name exists too the export fails with a warning and changes no file', () => {
  const dir = exportFixture();
  const hub = path.join(tmpdir(), 'hub');
  const { file } = planExport(dir, { hub, now: NOW });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'existing\n');
  const suffixed = file.replace(/\.jsonl$/, '-1.jsonl');
  fs.writeFileSync(suffixed, 'existing too\n');
  const c = collect();
  const code = runExport({ root: dir, hub, out: c.o, err: c.e, now: NOW });
  assert.equal(code, 1);
  assert.match(c.err.join('\n'), /export failed/);
  // the one retry was made: the failure is about the suffixed name
  assert.ok(c.err.join('\n').includes(path.basename(suffixed)), c.err.join('\n'));
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), [path.basename(file), path.basename(suffixed)].sort());
  assert.equal(fs.readFileSync(file, 'utf8'), 'existing\n');
  assert.equal(fs.readFileSync(suffixed, 'utf8'), 'existing too\n');
  assert.equal(fs.existsSync(path.join(dir, '.harness', 'events', '.exported')), false);
});

// ------------------------------------------------------------------ AC-5

test('F97 AC-5 learn --json --compare on an empty hub prints the same empty JSON as --json', () => {
  const hub = tmpdir();
  const cwd = tmpdir();
  const plain = harness(['learn', '--hub', hub, '--json'], { cwd });
  const cmp = harness(['learn', '--hub', hub, '--json', '--compare', '2.0.1', '2.0.2'], { cwd });
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(cmp.code, 0, cmp.stderr);
  const j = JSON.parse(cmp.stdout);
  assert.equal(j.message, 'no field data');
  assert.deepEqual(j, JSON.parse(plain.stdout));
});

// ------------------------------------------------------------------ AC-6

test('F97 AC-6 the profile section goes right before the "This block is managed by" paragraph', () => {
  const block = renderBlock({ profile: 'iac' });
  const at = block.indexOf('## Profile: iac');
  const closing = block.indexOf('\n\nThis block is managed by');
  assert.ok(at !== -1 && closing !== -1);
  assert.ok(at < closing);
  // nothing but the section between it and the closing paragraph
  assert.equal(block.slice(at, closing).includes('\n\n## '), false);
  const src = fs.readFileSync(path.join(REPO, 'lib', 'claudemd.mjs'), 'utf8');
  assert.equal(/lastIndexOf\(\s*'\\n\\n'\s*\)/.test(src), false);
});

test('F97 AC-6 a closing paragraph followed by more text still gets the section before it', () => {
  const dir = tmpdir();
  const t = path.join(dir, 'block.md');
  const text = fs.readFileSync(TEMPLATE, 'utf8').replace(/\n+$/, '');
  fs.writeFileSync(t, `${text}\n\n## Trailing\nmore text\n`);
  const block = renderBlock({ profile: 'iac', template: t });
  const at = block.indexOf('## Profile: iac');
  const closing = block.indexOf('\n\nThis block is managed by');
  assert.ok(at < closing);
  assert.ok(block.indexOf('## Trailing') > closing);
});

test('F97 AC-6 a template without the closing paragraph gets the section at the end of the body', () => {
  const dir = tmpdir();
  const t = path.join(dir, 'block.md');
  fs.writeFileSync(t, '## Language\n{{language}}\n\n## Rules\nsome rules\n');
  const block = renderBlock({ profile: 'iac', template: t });
  const body = block.slice(block.indexOf('\n') + 1, block.lastIndexOf('\n'));
  assert.ok(body.startsWith('## Language\n'));
  assert.ok(body.indexOf('## Profile: iac') > body.indexOf('some rules'));
  assert.ok(body.trimEnd().endsWith(fs.readFileSync(path.join(REPO, 'templates', 'profile-iac.md'), 'utf8').replace(/\r\n/g, '\n').trimEnd()));
});

// ------------------------------------------------------------------ AC-7

const initDone = (dir, r) => {
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /harness: warning: CLAUDE\.md not changed/);
  assert.ok(fs.existsSync(path.join(dir, '.harness', 'config.json')));
  assert.ok(fs.existsSync(path.join(dir, '.harness', 'features.json')));
};

test('F97 AC-7 init with a symbolic-link CLAUDE.md warns on stderr and finishes', (t) => {
  if (process.platform === 'win32') { t.diagnostic('symbolic links are POSIX only here'); return; }
  const dir = tmpdir();
  const target = path.join(tmpdir(), 'elsewhere.md');
  fs.writeFileSync(target, '# not yours\n');
  fs.symlinkSync(target, path.join(dir, 'CLAUDE.md'));
  const r = harness(['init'], { cwd: dir });
  initDone(dir, r);
  assert.match(r.stderr, /symbolic link/);
  assert.equal(fs.readFileSync(target, 'utf8'), '# not yours\n');
});

test('F97 AC-7 init with malformed CLAUDE.md markers warns on stderr and finishes', () => {
  const dir = tmpdir();
  const content = '# mine\n<!-- cc-harness:begin -->\nhalf a block\n';
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), content);
  const r = harness(['init'], { cwd: dir });
  initDone(dir, r);
  assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), content);
});

// ------------------------------------------------------------------ AC-8

test('F97 AC-8 verdict reviews name adapter and model only, never the effort', async () => {
  const dir = evalFixture(contract({ security_tier: 'critical' }));
  const config = cfg({
    builder: { adapter: 'claude', model: 'b1', effort: 'high' },
    evaluator: { adapter: 'claude', model: 'e1', effort: 'medium' },
    'security-reviewer': { adapter: 'claude', model: 's1', effort: 'max' },
  });
  const r = await runEval(dir, { evaluator: [good()], 'security-reviewer': [good()] }, config);
  const saved = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  for (const [role, model] of [['evaluator', 'e1'], ['security-reviewer', 's1']]) {
    const rv = saved.reviews[role];
    assert.equal(Object.hasOwn(rv, 'effort'), false, role);
    const rest = Object.keys(rv).filter((k) => k !== 'scores' && k !== 'reasked').sort();
    assert.deepEqual(rest, ['adapter', 'model'], role);
    assert.deepEqual([rv.adapter, rv.model], ['claude', model]);
  }
});
