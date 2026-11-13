// F168: a refused role call (stop_reason refusal, F103) is asked once more with the model the
// config names in roles.<role>.refusal_model; the retry is recorded (event, metrics, reviews).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BIN, REPO, tmpdir } from './helpers.mjs';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig, unknownConfigKeys } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { getAdapter } from '../lib/adapters/index.mjs';
import { readEvents } from '../lib/events.mjs';
import { runFeatures } from '../lib/run.mjs';
import doctor from '../lib/commands/doctor.mjs';
import { HarnessError } from '../lib/errors.mjs';

const FIX = path.join(REPO, 'test', 'fixtures');
const FAKE = path.join(FIX, 'fake-cli.mjs');
const PASS_REPLY = JSON.parse(fs.readFileSync(path.join(FIX, 'eval', 'pass.json'), 'utf8'));
// The measured claude refusal wrapper (F103 fixture).
const REFUSAL = JSON.parse(fs.readFileSync(path.join(FIX, 'output', 'claude-json-refusal.json'), 'utf8'));
const CLAUDE_HELP = fs.readFileSync(path.join(FIX, 'help', 'claude-2.1.280.txt'), 'utf8');

const replyFile = (reply) => {
  const f = path.join(tmpdir('harness-f168-reply-'), 'reply.json');
  fs.writeFileSync(f, JSON.stringify(reply));
  return f;
};
// One real claude adapter call against the fake CLI printing the refusal wrapper.
const refused = (opts = {}) => getAdapter('claude').run({ prompt: 'x', cwd: REPO, timeoutSec: 30, ...opts, bin: process.execPath, binArgs: [FAKE, 'print', replyFile(REFUSAL)] });

// ------------------------------------------------------------------ fixtures

function contract(id, tier = 'standard') {
  const c = {
    id, title: `feature ${id}`, security_tier: tier, version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-11-13T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture({ tier = 'standard' } = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: tier, depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract('F1', tier),
    'scripts/ok.mjs': 'process.exit(0);\n',
    'shared.txt': 'original\n',
  }, { branch: null });
}

const cfg = (roles) => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, roles });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const featureOf = (dir) => readJson(path.join(dir, '.harness/features.json')).features.find((f) => f.id === 'F1');
const verdict = (dir) => readJson(path.join(dir, '.harness/verdicts/F1-r1.json'));
const metrics = (r) => fs.readFileSync(r.report.replace(/\.md$/, '.metrics.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const fallbackEvents = (dir) => readEvents(dir).events.filter((e) => e.type === 'refusal_fallback');

const OK_INTEGRITY = { markers: [], harnessPaths: [], testCount: { status: 'unset' } };
const PASSING = { pass: true, commands: [], criteria: [{ id: 'AC-1', pass: true }], integrity: OK_INTEGRITY, warnings: [] };
const FAILING = { pass: false, commands: [{ cmd: 'npm test', pass: false, message: 'exit 1', output: 'boom' }], criteria: [{ id: 'AC-1', pass: false, message: 'exit 1' }], integrity: OK_INTEGRITY, warnings: [] };
const isIntegration = (cwd) => fs.realpathSync.native(cwd).endsWith(`${path.sep}_integration`);
const intWt = (dir) => path.join(dir, '.harness', 'wt', '_integration');

// verify: passes, except that the integration worktree fails until fixed.txt is there when
// `postMergeFails` is set.
function fakeVerify({ postMergeFails = false } = {}) {
  const calls = [];
  const fn = async (a) => {
    calls.push(a.featureId);
    if (isIntegration(a.cwd) && postMergeFails) return fs.existsSync(path.join(a.cwd, 'fixed.txt')) ? PASSING : FAILING;
    return PASSING;
  };
  fn.calls = calls;
  return fn;
}

// A builder that is refused (through the real claude adapter) when its model is in `refuse`
// for a call of a kind in `kinds`; otherwise a build writes F1.txt (+ `edit`), a conflict
// resolution writes shared.txt and a post-merge recovery writes fixed.txt.
function fakeBuild({ refuse = ['m1'], kinds = ['build'], edit = {}, onCall } = {}) {
  const calls = [];
  const fn = async (a) => {
    const kind = a.postMergeFailures ? 'recover' : a.conflicts ? 'resolve' : 'build';
    calls.push({ kind, model: a.model ?? null });
    if (onCall) await onCall(kind);
    if (kinds.includes(kind) && refuse.includes(a.model)) return refused({ cwd: a.cwd });
    writeFiles(a.cwd, kind === 'recover' ? { 'fixed.txt': 'fixed\n' } : kind === 'resolve' ? { 'shared.txt': 'both\n' } : { 'F1.txt': 'built\n', ...edit });
    return { ok: true, costUsd: 0 };
  };
  fn.calls = calls;
  fn.of = (kind) => calls.filter((c) => c.kind === kind).map((c) => c.model);
  return fn;
}

// Reviewers through `runAdapter`: refused when the role's model is in `refuse[role]`.
function reviewers(refuse = {}) {
  const calls = [];
  const fn = async (role, opts) => {
    calls.push({ role, model: opts.model ?? null });
    if ((refuse[role] || []).includes(opts.model)) return refused({ cwd: opts.cwd, readOnly: true, schema: { type: 'object' } });
    return { ok: true, error: null, text: '', json: PASS_REPLY, costUsd: 0, exitCode: 0 };
  };
  fn.calls = calls;
  fn.of = (role) => calls.filter((c) => c.role === role).map((c) => c.model);
  return fn;
}

const runIt = (dir, roles, deps) => runFeatures({ root: dir, config: cfg(roles), deps: { runAdapter: reviewers(), verify: fakeVerify(), log: () => {}, warn: () => {}, cpus: 8, ...deps } });
const f1 = (r) => r.results.find((x) => x.feature === 'F1');

const ROLES = (over = {}) => ({
  builder: { adapter: 'claude', model: 'm1', refusal_model: 'fb', ...over.builder },
  evaluator: { adapter: 'claude', model: 'e1', ...over.evaluator },
  'security-reviewer': { adapter: 'claude', model: 's1', ...over['security-reviewer'] },
});

// ------------------------------------------------------------------ AC-1

test('F168 AC-1 a refused build is asked once more with refusal_model; on success the feature verifies, evaluates and passes', async () => {
  const dir = fixture();
  const build = fakeBuild();
  const verify = fakeVerify();
  const r = await runIt(dir, ROLES(), { build, verify });
  assert.equal(f1(r)?.status, 'passed', JSON.stringify(f1(r)));
  assert.deepEqual(build.of('build'), ['m1', 'fb']);
  assert.ok(verify.calls.includes('F1'), 'verified');
  assert.equal(featureOf(dir).status, 'passed');
});

// ------------------------------------------------------------------ AC-2

test('F168 AC-2 a refused retry blocks the feature (refusal) after exactly two builder calls and no verify', async () => {
  const dir = fixture();
  const build = fakeBuild({ refuse: ['m1', 'fb'] });
  const verify = fakeVerify();
  const r = await runIt(dir, ROLES(), { build, verify });
  assert.equal(f1(r)?.status, 'blocked');
  assert.equal(f1(r).reason, 'refusal');
  assert.deepEqual(build.of('build'), ['m1', 'fb']);
  assert.ok(!verify.calls.includes('F1'), 'no verify');
  assert.equal(featureOf(dir).blocked_reason, 'refusal');
});

test('F168 AC-2 without refusal_model, or with refusal_model equal to the refused model, the builder is not asked again', async () => {
  for (const builder of [{ refusal_model: undefined }, { refusal_model: 'm1' }]) {
    const dir = fixture();
    const build = fakeBuild();
    const roles = ROLES({ builder });
    if (builder.refusal_model === undefined) delete roles.builder.refusal_model;
    const r = await runIt(dir, roles, { build });
    assert.equal(f1(r)?.status, 'blocked', JSON.stringify(builder));
    assert.equal(f1(r).reason, 'refusal');
    assert.deepEqual(build.of('build'), ['m1'], JSON.stringify(builder));
  }
});

// ------------------------------------------------------------------ AC-3

test('F168 AC-3 a refused evaluator is asked once more with refusal_model; the verdict review records that model', async () => {
  const dir = fixture();
  const runAdapter = reviewers({ evaluator: ['e1'] });
  const r = await runIt(dir, ROLES({ evaluator: { refusal_model: 'fb-e' } }), { build: fakeBuild({ refuse: [] }), runAdapter });
  assert.equal(f1(r)?.status, 'passed', JSON.stringify(f1(r)));
  assert.deepEqual(runAdapter.of('evaluator'), ['e1', 'fb-e']);
  const v = verdict(dir);
  assert.equal(v.reviews.evaluator.model, 'fb-e');
  assert.equal(v.independence, 'cross-model');
});

test('F168 AC-3 a refusal_model equal to the builder model makes the review fresh-context', async () => {
  const dir = fixture();
  const runAdapter = reviewers({ evaluator: ['e1'] });
  await runIt(dir, ROLES({ builder: { refusal_model: undefined }, evaluator: { refusal_model: 'm1' } }), { build: fakeBuild({ refuse: [] }), runAdapter });
  const v = verdict(dir);
  assert.equal(v.reviews.evaluator.model, 'm1');
  assert.equal(v.independence, 'fresh-context');
});

// ------------------------------------------------------------------ AC-4

test('F168 AC-4 a refused security-reviewer of a critical feature is asked once more with refusal_model', async () => {
  const dir = fixture({ tier: 'critical' });
  const runAdapter = reviewers({ 'security-reviewer': ['s1'] });
  const r = await runIt(dir, ROLES({ 'security-reviewer': { refusal_model: 'fb-s' } }), { build: fakeBuild({ refuse: [] }), runAdapter });
  assert.equal(f1(r)?.status, 'passed', JSON.stringify(f1(r)));
  assert.deepEqual(runAdapter.of('security-reviewer'), ['s1', 'fb-s']);
  assert.equal(verdict(dir).reviews['security-reviewer'].model, 'fb-s');
});

// ------------------------------------------------------------------ AC-5

test('F168 AC-5 a refused conflict resolution builder is asked once more with refusal_model and the feature goes on', async () => {
  const dir = fixture();
  const build = fakeBuild({
    kinds: ['resolve'],
    edit: { 'shared.txt': 'changed by F1\n' },
    onCall: (k) => {
      if (k === 'build') {
        writeFiles(intWt(dir), { 'shared.txt': 'changed on integration\n' });
        commitAll(intWt(dir), 'meanwhile on integration');
      }
    },
  });
  const r = await runIt(dir, ROLES(), { build });
  assert.deepEqual(build.of('resolve'), ['m1', 'fb'], JSON.stringify(build.calls));
  assert.equal(f1(r)?.status, 'passed', JSON.stringify(f1(r)));
  assert.equal(fs.readFileSync(path.join(dir, 'shared.txt'), 'utf8').includes('<<<<<<<'), false);
});

test('F168 AC-5 a refused post-merge recovery builder is asked once more with refusal_model and the feature goes on', async () => {
  const dir = fixture();
  const build = fakeBuild({ kinds: ['recover'] });
  const r = await runIt(dir, ROLES(), { build, verify: fakeVerify({ postMergeFails: true }) });
  assert.deepEqual(build.of('recover'), ['m1', 'fb'], JSON.stringify(build.calls));
  assert.equal(f1(r)?.status, 'passed', JSON.stringify(f1(r)));
  assert.ok(git(dir, 'show', 'harness/integration:fixed.txt').includes('fixed'));
});

// ------------------------------------------------------------------ AC-6

test('F168 AC-6 every retry records a refusal_fallback event; metrics keep the refused call and the retry apart', async () => {
  const dir = fixture();
  const r = await runIt(dir, ROLES({ evaluator: { refusal_model: 'fb-e' } }), { build: fakeBuild(), runAdapter: reviewers({ evaluator: ['e1'] }) });
  assert.equal(f1(r)?.status, 'passed', JSON.stringify(f1(r)));
  const ev = fallbackEvents(dir).map((e) => [e.stage, e.feature, e.data]);
  assert.deepEqual(ev, [
    ['build', 'F1', { role: 'builder', from: 'm1', to: 'fb' }],
    ['eval', 'F1', { role: 'evaluator', from: 'e1', to: 'fb-e' }],
  ]);
  const builds = metrics(r).filter((m) => m.feature === 'F1' && m.step === 'build');
  assert.deepEqual(builds.map((m) => [m.model, m.outcome]), [['m1', 'refusal'], ['fb', 'ok']]);
});

test('F168 AC-6 a critical security-reviewer retry is a security-stage event', async () => {
  const dir = fixture({ tier: 'critical' });
  await runIt(dir, ROLES({ 'security-reviewer': { refusal_model: 'fb-s' } }), { build: fakeBuild({ refuse: [] }), runAdapter: reviewers({ 'security-reviewer': ['s1'] }) });
  assert.deepEqual(fallbackEvents(dir).map((e) => [e.stage, e.data]), [['security', { role: 'security-reviewer', from: 's1', to: 'fb-s' }]]);
});

// ------------------------------------------------------------------ AC-7

test('F168 AC-7 doctor shows a refusal line for a role with refusal_model; the key is known', async () => {
  const out = [];
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.harness', 'config.json'), JSON.stringify({ roles: ROLES({ evaluator: { refusal_model: 'fb-e' } }) }));
  const probe = async (adapter) => (adapter.name === 'claude' ? { installed: true, version: 'claude fixture', help: CLAUDE_HELP } : { installed: false, version: null, help: null });
  const code = await doctor({ root: dir, out: (s) => out.push(s), err: () => {}, probe, env: {} });
  const lines = out.join('\n').split('\n');
  assert.equal(code, 0, lines.join('\n'));
  const under = (role) => {
    const at = lines.findIndex((l) => new RegExp(`^  ${role}\\s`).test(l));
    const block = [];
    for (let i = at + 1; i < lines.length && /^ {4}\S/.test(lines[i]); i += 1) block.push(lines[i]);
    return block;
  };
  assert.deepEqual(under('builder').filter((l) => /refusal/.test(l)), ['    refusal          claude/fb']);
  assert.deepEqual(under('evaluator').filter((l) => /refusal/.test(l)), ['    refusal          claude/fb-e']);
  assert.deepEqual(under('security-reviewer').filter((l) => /refusal/.test(l)), []);
  assert.deepEqual(unknownConfigKeys({ roles: ROLES() }), []);
});

// ------------------------------------------------------------------ AC-8

test('F168 AC-8 SPEC §4, §8 and §10 describe refusal_model, the one retry and its records', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const section = (n) => {
    const start = spec.search(new RegExp(`^## ${n}\\.`, 'm'));
    assert.ok(start !== -1, `SPEC §${n}`);
    const rest = spec.slice(start + 3);
    const end = rest.search(/^## \d+\./m);
    return end === -1 ? rest : rest.slice(0, end);
  };
  assert.ok(section(4).includes('refusal_model'), '§4');
  const s8 = section(8);
  for (const word of ['refusal_model', 'refusal_fallback', 'F168']) assert.ok(s8.includes(word), `§8 names ${word}`);
  assert.ok(section(10).includes('refusal_model'), '§10');
  const line = spec.split('\n').find((l) => l.startsWith('모델 거부(refusal)'));
  assert.ok(line, 'the refusal paragraph');
  assert.ok(!/다른 모델로 자동 재시도[^.]*범위 밖/.test(line) || line.includes('F168'), 'the retry is no longer out of scope without F168');
});

// ------------------------------------------------------------------ ES-1

for (const [what, value] of [['"" (empty)', ''], ['3 (number)', 3], ['"-x" (flag-shaped)', '-x'], ['"a b" (whitespace)', 'a b'], ['a control character', 'a\u0001b']]) {
  test(`F168 ES-1 roles.<role>.refusal_model ${what} → config_invalid with the key path`, () => {
    for (const role of ['builder', 'evaluator', 'security-reviewer']) {
      let err = null;
      try { resolveConfig({ roles: { [role]: { adapter: 'claude', refusal_model: value } } }); } catch (e) { err = e; }
      assert.ok(err instanceof HarnessError, `accepted ${JSON.stringify(value)} for ${role}`);
      assert.equal(err.code, 'config_invalid');
      assert.equal(err.exit, 2);
      assert.ok(err.message.includes(`roles.${role}.refusal_model`), err.message);
    }
  });
}

test('F168 ES-1 CLI: harness run exits 2 on an invalid refusal_model and starts nothing', () => {
  const dir = fixture();
  const file = path.join(dir, '.harness', 'config.json');
  fs.writeFileSync(file, JSON.stringify({ ...readJson(file), roles: { builder: { adapter: 'claude', refusal_model: '--max' } } }));
  commitAll(dir, 'bad refusal_model');
  const r = spawnSync(process.execPath, [BIN, 'run'], { cwd: dir, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /roles\.builder\.refusal_model/);
  assert.ok(!fs.existsSync(path.join(dir, '.harness', 'wt', 'F1')), 'no feature worktree');
});

// ------------------------------------------------------------------ ES-2

test('F168 ES-2 refusal_model on a non-claude role → only supported by the claude adapter', () => {
  for (const adapter of ['codex', 'gemini', 'generic']) {
    for (const role of ['builder', 'evaluator']) {
      let err = null;
      try { resolveConfig({ roles: { [role]: { adapter, model: 'm', refusal_model: 'fb' } } }); } catch (e) { err = e; }
      assert.ok(err instanceof HarnessError, `${adapter} ${role}`);
      assert.equal(err.code, 'config_invalid');
      assert.ok(err.message.includes(`roles.${role}.refusal_model`), err.message);
      assert.ok(err.message.includes('only supported by the claude adapter'), err.message);
    }
  }
});
