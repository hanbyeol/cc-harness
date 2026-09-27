import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { harness, REPO, readJson } from './helpers.mjs';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { redactor } from '../lib/failures.mjs';
import { runFeatures } from '../lib/run.mjs';
import { verify, isHarnessPath } from '../lib/verify.mjs';
import { STAGES, recordEvent, readEvents } from '../lib/events.mjs';
import evalCommand from '../lib/commands/eval.mjs';

// F54: the event log .harness/events/YYYY-MM.jsonl, `harness events`, and the plan stage events.

const VERSION = readJson(path.join(REPO, 'package.json')).version;
const SECRET = 'sk-test-secret';
const KEYS = ['ts', 'stage', 'type', 'feature', 'round', 'harness_version', 'profile', 'project', 'data'];

function contract(id = 'F9', { approve = false, criteria, version = 1 } = {}) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version,
    acceptance_criteria: criteria ?? [
      { id: 'AC-1', criterion: 'one', check: 'node scripts/ok.mjs', new: false },
      { id: 'AC-2', criterion: 'two', check: 'node scripts/ok.mjs', new: false },
    ],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  if (approve) c.approval = { by: 'test', at: '2026-09-23T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

// A git repository on `main` with .harness state; `contracts` maps id → contract.
function fixture({ contracts = { F9: contract() }, status = 'todo', config = {}, files = {} } = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...config },
    '.harness/features.json': { features: Object.keys(contracts).map((id) => ({ id, title: `feature ${id}`, status, depends_on: [] })) },
    '.harness/backlog.json': { items: [] },
    ...Object.fromEntries(Object.entries(contracts).map(([id, c]) => [`.harness/contracts/${id}.json`, c])),
    'scripts/ok.mjs': 'process.exit(0);\n',
    ...files,
  }, { branch: null });
}

const eventsDir = (dir) => path.join(dir, '.harness', 'events');
const eventFiles = (dir) => {
  try { return fs.readdirSync(eventsDir(dir)).sort(); } catch { return []; }
};
const eventsText = (dir) => eventFiles(dir).map((n) => fs.readFileSync(path.join(eventsDir(dir), n), 'utf8')).join('');
const events = (dir) => eventsText(dir).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const of = (dir, stage, type) => events(dir).filter((e) => e.stage === stage && e.type === type);
const statusOf = (dir, id = 'F9') => readJson(path.join(dir, '.harness', 'features.json')).features.find((f) => f.id === id).status;
const projectHash = (dir) => crypto.createHash('sha256').update(git(dir, 'rev-parse', '--show-toplevel')).digest('hex').slice(0, 16);

// ---------- AC-1 ----------
test('F54 AC-1: recordEvent appends one line to events/YYYY-MM.jsonl of the UTC month, with the fixed fields', () => {
  const dir = fixture();
  // 23:30 at UTC-5 on Jan 31 is Feb 1 in UTC.
  recordEvent(dir, { stage: 'plan', type: 'lint', feature: 'F9', round: 2, data: { n: 1 } }, { now: new Date('2026-01-31T23:30:00-05:00') });
  recordEvent(dir, { stage: 'feedback', type: 'note', data: { n: 2 } }, { now: new Date('2026-02-03T00:00:00Z') });
  assert.deepEqual(eventFiles(dir), ['2026-02.jsonl']);
  const lines = fs.readFileSync(path.join(eventsDir(dir), '2026-02.jsonl'), 'utf8').split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[2], '');
  const [a, b] = lines.slice(0, 2).map((l) => JSON.parse(l));
  assert.deepEqual(Object.keys(a), KEYS);
  assert.equal(a.ts, '2026-02-01T04:30:00.000Z');
  assert.deepEqual([a.stage, a.type, a.feature, a.round], ['plan', 'lint', 'F9', 2]);
  assert.equal(a.harness_version, VERSION);
  assert.equal(a.profile, 'sdlc');
  assert.equal(a.project, projectHash(dir));
  assert.match(a.project, /^[0-9a-f]{16}$/);
  assert.deepEqual(a.data, { n: 1 });
  // feature and round are optional
  assert.deepEqual(Object.keys(b), KEYS.filter((k) => k !== 'feature' && k !== 'round'));
});

test('F54 AC-1: the stage is one of plan, build, verify, eval, security, feedback', () => {
  assert.deepEqual([...STAGES], ['plan', 'build', 'verify', 'eval', 'security', 'feedback']);
  const dir = fixture();
  for (const stage of STAGES) recordEvent(dir, { stage, type: 't' });
  assert.deepEqual(events(dir).map((e) => e.stage), STAGES);
  assert.throws(() => recordEvent(dir, { stage: 'deploy', type: 't' }), /unknown event stage/);
  assert.equal(events(dir).length, STAGES.length);
});

test('F54 AC-1: the project is the sha256 of the repository top level, also from a subdirectory', () => {
  const dir = fixture({ files: { 'pkg/app/.harness/config.json': { profile: 'iac' } } });
  const sub = path.join(dir, 'pkg', 'app');
  recordEvent(sub, { stage: 'plan', type: 't' });
  const [e] = events(sub);
  assert.equal(e.project, projectHash(dir));
  assert.equal(e.profile, 'iac');
});

// ---------- AC-2 ----------
test('F54 AC-2: lint-contract records one plan/lint event per checked contract with rule names, ids and counts', () => {
  const bad = contract('F8', { criteria: [
    { id: 'AC-1', criterion: 'one', check: '' },
    { id: 'AC-2', check: 'node scripts/ok.mjs' },
  ] });
  const dir = fixture({ contracts: { F8: bad, F9: contract() } });
  const r = harness(['lint-contract'], { cwd: dir });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const lint = of(dir, 'plan', 'lint');
  assert.deepEqual(lint.map((e) => e.feature), ['F8', 'F9']);
  assert.deepEqual(lint[0].data, {
    version: 1,
    errors: [{ rule: 'check', id: 'AC-1' }], warnings: [{ rule: 'criterion_text', id: 'AC-2' }],
    error_count: 1, warning_count: 1,
  });
  assert.deepEqual(lint[1].data, { version: 1, errors: [], warnings: [], error_count: 0, warning_count: 0 });
  // Named contracts only; an unreadable contract is not a checked one.
  fs.writeFileSync(path.join(dir, '.harness', 'contracts', 'F7.json'), '{ not json');
  harness(['lint-contract', 'F9', 'F7'], { cwd: dir });
  assert.deepEqual(of(dir, 'plan', 'lint').map((e) => e.feature), ['F8', 'F9', 'F9']);
});

test('F54 AC-2: a contract-level problem has a rule name and a null criterion id', () => {
  const c = { ...contract(), security_tier: 'critical' };
  const dir = fixture({ contracts: { F9: c } });
  harness(['lint-contract'], { cwd: dir });
  const [e] = of(dir, 'plan', 'lint');
  assert.deepEqual(e.data.errors, [{ rule: 'critical_sc', id: null }]);
});

test('F54 AC-2: approve records version, hash and the criteria added, removed or reworded since the last approval', () => {
  const dir = fixture();
  let r = harness(['approve', 'F9', '--by', 'me'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const file = path.join(dir, '.harness', 'contracts', 'F9.json');
  const first = readJson(file).approval.hash;
  let [a] = of(dir, 'plan', 'approve');
  assert.equal(a.feature, 'F9');
  assert.equal(a.data.version, 1);
  assert.equal(a.data.hash, first);
  assert.equal(a.data.previous_hash, null);
  assert.deepEqual([a.data.added, a.data.removed, a.data.changed], [['AC-1', 'AC-2'], [], []]);

  const next = contract('F9', { version: 2, criteria: [
    { id: 'AC-1', criterion: 'one, reworded', check: 'node scripts/ok.mjs', new: false },
    { id: 'AC-3', criterion: 'three', check: 'node scripts/ok.mjs', new: false },
  ] });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  r = harness(['approve', 'F9', '--by', 'me'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  a = of(dir, 'plan', 'approve')[1];
  assert.equal(a.data.version, 2);
  assert.equal(a.data.hash, readJson(file).approval.hash);
  assert.equal(a.data.previous_hash, first);
  assert.deepEqual([a.data.added, a.data.removed, a.data.changed], [['AC-3'], ['AC-2'], ['AC-1']]);

  // Re-approving the same content changes nothing.
  harness(['approve', 'F9', '--by', 'me'], { cwd: dir });
  a = of(dir, 'plan', 'approve')[2];
  assert.deepEqual([a.data.added, a.data.removed, a.data.changed], [[], [], []]);
});

test('F54 AC-2: without an earlier approve event the approval committed at HEAD is the previous one', () => {
  const dir = fixture({ contracts: { F9: contract('F9', { approve: true }) }, status: 'approved' });
  const file = path.join(dir, '.harness', 'contracts', 'F9.json');
  const before = readJson(file).approval.hash;
  const edited = contract('F9', { criteria: [{ id: 'AC-1', criterion: 'one', check: 'node scripts/ok.mjs', new: false }] });
  fs.writeFileSync(file, JSON.stringify(edited, null, 2));
  const r = harness(['approve', 'F9'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const [a] = of(dir, 'plan', 'approve');
  assert.equal(a.data.previous_hash, before);
  assert.deepEqual([a.data.added, a.data.removed, a.data.changed], [[], ['AC-2'], []]);
});

// ---------- AC-3 ----------
test('F54 AC-3: approve records a plan/status event when the status changes, none when it stays approved', () => {
  const dir = fixture();
  harness(['approve', 'F9'], { cwd: dir });
  assert.deepEqual(of(dir, 'plan', 'status').map((e) => [e.feature, e.data]), [['F9', { from: 'todo', to: 'approved', reason: 'approve' }]]);
  harness(['approve', 'F9'], { cwd: dir });
  assert.equal(of(dir, 'plan', 'status').length, 1);
});

const scores = (o = {}) => ({ functionality: 9, quality: 9, security: 9, errors: 9, tests: 9, ...o });
const reply = (json) => ({ ok: true, error: null, text: JSON.stringify(json), json, costUsd: 0, exitCode: 0 });
const PASS_REPLY = () => reply({ scores: scores(), findings: [], out_of_scope: [] });
const FAIL_REPLY = () => reply({ scores: scores({ functionality: 3 }), out_of_scope: [],
  findings: [{ criterion_id: 'AC-1', dimension: 'functionality', summary: 'AC-1 broken', repro: 'node scripts/fail.mjs' }] });
const PASS_VERIFY = {
  pass: true, commands: [], warnings: [],
  integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } },
  criteria: [{ id: 'AC-1', pass: true }, { id: 'AC-2', pass: true }],
};
const EVAL_CONFIG = {
  roles: { builder: 'claude', evaluator: 'generic', 'security-reviewer': 'generic' },
  adapters: { generic: { read_only_command: [process.execPath, '-e', 'process.exit(1)'] } },
};

async function evalCmd(dir, replies) {
  const q = [...replies];
  const out = [];
  const err = [];
  const code = await evalCommand({
    root: dir, args: ['F9'], out: (s) => out.push(s), err: (s) => err.push(s),
    deps: { runAdapter: async () => q.shift(), verifyResult: PASS_VERIFY },
  });
  return { code, out: out.join('\n'), err };
}

function evalFixture() {
  return fixture({
    contracts: { F9: contract('F9', { approve: true }) }, status: 'approved', config: EVAL_CONFIG,
    files: { 'scripts/fail.mjs': 'process.exit(3);\n' },
  });
}

test('F54 AC-3: eval records an eval/status event with from, to and the reason for each status change', async () => {
  const dir = evalFixture();
  let r = await evalCmd(dir, [FAIL_REPLY()]);
  assert.equal(r.code, 1, r.out);
  r = await evalCmd(dir, [PASS_REPLY()]);
  assert.equal(r.code, 0, r.out);
  const st = of(dir, 'eval', 'status');
  assert.deepEqual(st.map((e) => [e.feature, e.round, e.data.from, e.data.to]), [['F9', 1, 'approved', 'in_progress'], ['F9', 2, 'in_progress', 'passed']]);
  for (const e of st) assert.equal(typeof e.data.reason, 'string');
  assert.equal(events(dir).filter((e) => e.stage === 'feedback').length, 0);
});

test('F54 AC-3: an eval that keeps the status (one eval_error) records no status event', async () => {
  const dir = evalFixture();
  const r = await evalCmd(dir, [{ ok: false, error: 'exit_nonzero', detail: 'boom', text: '', json: null, costUsd: 0, exitCode: 1 }]);
  assert.equal(r.code, 2, r.out);
  assert.equal(statusOf(dir), 'approved');
  assert.equal(of(dir, 'eval', 'status').length, 0);
});

// ------ run path
const RUN_PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };

function runFixture(ids, deps = {}) {
  const contracts = {};
  for (const id of ids) {
    contracts[id] = contract(id, { approve: true, criteria: [{ id: 'AC-1', criterion: `${id}.txt exists`, check: 'node scripts/ok.mjs', new: false }] });
  }
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: 'standard', depends_on: deps[id] || [], status: 'approved' })) },
    ...Object.fromEntries(Object.entries(contracts).map(([id, c]) => [`.harness/contracts/${id}.json`, c])),
    'scripts/ok.mjs': 'process.exit(0);\n',
  }, { branch: null });
  return dir;
}

const runCfg = () => resolveConfig({ base_branch: 'main', run: { max_parallel: 1 }, verify: { commands: [] }, budget: { step_timeout_sec: 60 } });
const build = async (a) => { writeFiles(a.cwd, { [`${a.featureId}.txt`]: 'x\n' }); return { ok: true, costUsd: 0 }; };
const evaluateAs = (verdicts) => async (a) => ({
  feature: a.featureId, round: a.round, score: 8, scores: {}, backlogged: [], independence: 'cross-model', costUsd: 0, file: null,
  verdict: verdicts[a.featureId] ?? 'pass', blocking: [],
});

test('F54 AC-3: run records build/status on start and eval/status when the feature passes', async () => {
  const dir = runFixture(['F1']);
  const warn = [];
  await runFeatures({ root: dir, config: runCfg(), deps: { build, verify: async () => RUN_PASSING, evaluate: evaluateAs({}), warn: (m) => warn.push(m) } });
  assert.equal(statusOf(dir, 'F1'), 'passed');
  const st = events(dir).filter((e) => e.type === 'status');
  assert.deepEqual(st.map((e) => [e.stage, e.feature, e.data.from, e.data.to, e.data.reason]), [
    ['build', 'F1', 'approved', 'in_progress', 'run_start'],
    ['eval', 'F1', 'in_progress', 'passed', 'pass'],
  ]);
  assert.deepEqual(warn, []);
});

test('F54 AC-3: run records the blocked feature and each dependent it skips', async () => {
  const dir = runFixture(['F1', 'F2'], { F2: ['F1'] });
  await runFeatures({ root: dir, config: runCfg(), deps: { build, verify: async () => RUN_PASSING, evaluate: evaluateAs({ F1: 'needs-human' }) } });
  assert.deepEqual([statusOf(dir, 'F1'), statusOf(dir, 'F2')], ['blocked', 'skipped']);
  const st = events(dir).filter((e) => e.type === 'status');
  assert.deepEqual(st.map((e) => [e.stage, e.feature, e.data.from, e.data.to]), [
    ['build', 'F1', 'approved', 'in_progress'],
    ['eval', 'F1', 'in_progress', 'blocked'],
    ['build', 'F2', 'approved', 'skipped'],
  ]);
  assert.equal(st[1].data.reason, 'needs-human');
  assert.equal(st[2].data.blocked_by, 'F1');
  assert.ok(st.every((e) => e.stage !== 'feedback'));
});

// ---------- AC-4 ----------
function eventsProject(files) {
  const dir = fixture();
  for (const [name, list] of Object.entries(files)) {
    fs.mkdirSync(eventsDir(dir), { recursive: true });
    fs.writeFileSync(path.join(eventsDir(dir), name), list.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  }
  return dir;
}
const ev = (ts, stage, type, feature, data = {}) => ({ ts, stage, type, ...(feature ? { feature } : {}), harness_version: VERSION, profile: 'sdlc', project: 'p', data });

test('F54 AC-4: harness events lists events oldest first across month files, filtered by stage, feature and since', () => {
  const dir = eventsProject({
    '2026-09.jsonl': [ev('2026-09-02T00:00:00.000Z', 'eval', 'status', 'F2', { to: 'passed' }), ev('2026-09-01T00:00:00.000Z', 'plan', 'lint', 'F1')],
    '2026-08.jsonl': [ev('2026-08-31T23:59:59.000Z', 'plan', 'approve', 'F2')],
  });
  let r = harness(['events'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^2026-08-31T23:59:59\.000Z plan\/approve F2\b/);
  assert.match(lines[1], /^2026-09-01T00:00:00\.000Z plan\/lint F1\b/);
  assert.match(lines[2], /^2026-09-02T00:00:00\.000Z eval\/status F2 \{"to":"passed"\}$/);

  const json = (args) => JSON.parse(harness(['events', ...args, '--json'], { cwd: dir }).stdout).map((e) => `${e.stage}/${e.type}/${e.feature}`);
  assert.deepEqual(json([]), ['plan/approve/F2', 'plan/lint/F1', 'eval/status/F2']);
  assert.deepEqual(json(['--stage', 'plan']), ['plan/approve/F2', 'plan/lint/F1']);
  assert.deepEqual(json(['--feature', 'F2']), ['plan/approve/F2', 'eval/status/F2']);
  assert.deepEqual(json(['--since', '2026-09-01']), ['plan/lint/F1', 'eval/status/F2']);
  assert.deepEqual(json(['--stage', 'plan', '--feature', 'F2', '--since', '2026-08-01']), ['plan/approve/F2']);
  assert.deepEqual(json(['--stage', 'build']), []);
  r = harness(['events', '--stage', 'build'], { cwd: dir });
  assert.equal(r.stdout.trim(), 'no matching events');
});

test('F54 AC-4: harness events rejects bad options with exit 2 and says so when there are no events', () => {
  const dir = fixture();
  let r = harness(['events'], { cwd: dir });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), 'no events yet');
  assert.deepEqual(JSON.parse(harness(['events', '--json'], { cwd: dir }).stdout), []);
  for (const args of [['--stage', 'deploy'], ['--since', '2026-13-45'], ['--since'], ['--feature', 'x'], ['--bogus']]) {
    r = harness(['events', ...args], { cwd: dir });
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  }
  assert.match(harness(['--help'], { cwd: dir }).stdout, /\bevents\b/);
});

test('F54 AC-4: events recorded by lint-contract and approve show up in harness events', () => {
  const dir = fixture();
  harness(['lint-contract'], { cwd: dir });
  harness(['approve', 'F9'], { cwd: dir });
  const r = harness(['events', '--feature', 'F9', '--json'], { cwd: dir });
  assert.deepEqual(JSON.parse(r.stdout).map((e) => `${e.stage}/${e.type}`), ['plan/lint', 'plan/approve', 'plan/status']);
});

// ---------- AC-5 ----------
test('F54 AC-5: .harness/events/** is exempt from the integrity check, like verdicts, backlog and runs', () => {
  for (const p of ['.harness/events/2026-09.jsonl', '.harness/events/x/y.jsonl', 'pkg/.harness/events/a.jsonl']) {
    assert.equal(isHarnessPath(p, p.startsWith('pkg/') ? 'pkg/.harness' : '.harness'), false, p);
  }
  for (const p of ['.harness/events', '.harness/events-x/a.jsonl', '.harness/eventsa.jsonl', '.harness/contracts/F1.json']) {
    assert.equal(isHarnessPath(p), true, p);
  }
});

test('F54 AC-5: verify passes with new and changed event files (committed or not)', async () => {
  const c = contract('F9', { criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }] });
  const dir = fixture({ contracts: { F9: c }, status: 'approved', files: { '.harness/events/2026-08.jsonl': '{}\n' } });
  git(dir, 'checkout', '-q', '-b', 'feature');
  writeFiles(dir, { '.harness/events/2026-08.jsonl': '{}\n{}\n', '.harness/events/2026-09.jsonl': '{}\n' });
  const config = resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 30 } });
  let r = await verify({ root: dir, featureId: 'F9', base: 'main', config });
  assert.deepEqual(r.integrity.harnessPaths, []);
  assert.equal(r.pass, true, JSON.stringify(r, null, 2));
  commitAll(dir, 'events');
  r = await verify({ root: dir, featureId: 'F9', base: 'main', config });
  assert.deepEqual(r.integrity.harnessPaths, []);
  assert.equal(r.pass, true, JSON.stringify(r, null, 2));
});

test('F54 AC-5: run does not commit events recorded inside a feature worktree (no merge conflicts between features)', async () => {
  const dir = runFixture(['F1', 'F2']);
  const writeEvent = async (a) => {
    recordEvent(a.cwd, { stage: 'plan', type: 'lint', feature: a.featureId });
    return build(a);
  };
  await runFeatures({ root: dir, config: runCfg(), deps: { build: writeEvent, verify: async () => RUN_PASSING, evaluate: evaluateAs({}) } });
  assert.deepEqual([statusOf(dir, 'F1'), statusOf(dir, 'F2')], ['passed', 'passed']);
  const tree = git(dir, 'ls-tree', '-r', '--name-only', 'harness/integration').split('\n');
  assert.ok(tree.includes('F1.txt') && tree.includes('F2.txt'), tree.join('\n'));
  assert.deepEqual(tree.filter((f) => f.startsWith('.harness/events')), []);
});

const section = (text, heading) => {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, heading);
  const rest = text.slice(start + heading.length);
  const end = rest.search(/\n##+ /);
  return end === -1 ? rest : rest.slice(0, end);
};

test('F54 AC-5: SPEC §2 and §6.2 and the README describe the event format and the exemption', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s2 = section(spec, '## 2. ');
  for (const re of [/\.harness\/events\/YYYY-MM\.jsonl/, /UTC/, /harness events/, /--stage/, /--feature/, /--since/, /--json/,
    ...KEYS.map((k) => new RegExp(`\`${k}\``)), /plan·build·verify·eval·security·feedback/, /package\.json/, /sha256/, /16/,
    /plan\/lint/, /plan\/approve/, /status/, /가린다|가려/, /경고/]) {
    assert.match(s2, re);
  }
  const s62 = section(spec, '### 6.2 ');
  assert.match(s62, /`verdicts\/\*\*`, `backlog\.json`, `runs\/\*\*`, `events\/\*\*`/);
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  for (const re of [/\.harness\/events\//, /harness events/, /--stage/]) assert.match(readme, re);
});

// ---------- SC-1 ----------
test('F54 SC-1: a secret in a linted contract does not reach the event file', () => {
  const leaky = contract('F9', { criteria: [
    { id: `AC-${SECRET}`, criterion: `uses ${SECRET} and is never logged`, check: `SECRET=${SECRET} node scripts/ok.mjs` },
  ] });
  const dir = fixture({ contracts: { F9: leaky } });
  const r = harness(['lint-contract'], { cwd: dir, env: { GEMINI_API_KEY: SECRET } });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const text = eventsText(dir);
  assert.ok(text.length > 0);
  assert.equal(text.includes(SECRET), false, text);
  const [e] = of(dir, 'plan', 'lint');
  assert.deepEqual(e.data.errors.map((x) => [x.rule, x.id]), [['id', 'AC-[redacted]'], ['universal', 'AC-[redacted]']]);
});

test('F54 SC-1: event data is redacted with the run report rule (env values outside env_allowlist)', () => {
  const env = { GEMINI_API_KEY: SECRET, KEPT_VALUE: 'visible-value-123' };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const dir = fixture({ config: { env_allowlist: ['KEPT_VALUE'] } });
    const data = { text: `key ${SECRET} and visible-value-123`, nested: [{ cut: SECRET.slice(3) + ' tail' }] };
    recordEvent(dir, { stage: 'plan', type: 't', data });
    const [e] = events(dir);
    const redact = redactor(process.env, ['KEPT_VALUE']);
    assert.deepEqual(e.data, { text: redact(data.text), nested: [{ cut: redact(data.nested[0].cut) }] });
    assert.equal(e.data.text, 'key [redacted] and visible-value-123');
    assert.equal(eventsText(dir).includes(SECRET), false);
  } finally {
    for (const k of Object.keys(env)) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

// ---------- ES-1 ----------
// .harness/events as a regular file: every event write fails.
const blockEvents = (dir) => fs.writeFileSync(eventsDir(dir), 'not a directory\n');
const warnings = (stderr) => stderr.split('\n').filter((l) => /could not record event/.test(l));

test('F54 ES-1: lint-contract and approve give the same result when the event file cannot be written, with one warning line', () => {
  const bad = contract('F8', { criteria: [{ id: 'AC-1', criterion: 'one', check: '' }] });
  const make = () => fixture({ contracts: { F8: bad, F9: contract() } });
  const ok = make();
  const broken = make();
  blockEvents(broken);

  const a = harness(['lint-contract'], { cwd: ok });
  const b = harness(['lint-contract'], { cwd: broken });
  assert.equal(b.code, a.code);
  assert.equal(b.code, 1);
  assert.equal(b.stdout, a.stdout);
  assert.equal(a.stderr, '');
  assert.equal(b.stderr.trim().split('\n').length, 1, b.stderr);
  assert.equal(warnings(b.stderr).length, 1, b.stderr);

  const c = harness(['approve', 'F9', '--by', 'me'], { cwd: broken });
  assert.equal(c.code, 0, c.stdout + c.stderr);
  assert.match(c.stdout, /approved F9/);
  assert.equal(statusOf(broken), 'approved');
  assert.equal(typeof readJson(path.join(broken, '.harness', 'contracts', 'F9.json')).approval.hash, 'string');
  assert.equal(c.stderr.trim().split('\n').length, 1, c.stderr);
  assert.equal(warnings(c.stderr).length, 1, c.stderr);
});

test('F54 ES-1: eval records its status and exit code when the event file cannot be written', async () => {
  const dir = evalFixture();
  blockEvents(dir);
  const r = await evalCmd(dir, [PASS_REPLY()]);
  assert.equal(r.code, 0, r.out);
  assert.equal(statusOf(dir), 'passed');
  assert.match(r.out, /status: passed/);
  assert.equal(r.err.length, 1, r.err.join('\n'));
  assert.match(r.err[0], /could not record event/);
});

test('F54 ES-1: run gives the same statuses when the event file cannot be written, with one warning line', async () => {
  const dir = runFixture(['F1', 'F2'], { F2: ['F1'] });
  blockEvents(dir);
  const warn = [];
  const r = await runFeatures({ root: dir, config: runCfg(), deps: { build, verify: async () => RUN_PASSING, evaluate: evaluateAs({ F1: 'needs-human' }), warn: (m) => warn.push(m) } });
  assert.deepEqual([statusOf(dir, 'F1'), statusOf(dir, 'F2')], ['blocked', 'skipped']);
  assert.deepEqual(r.results.map((x) => [x.feature, x.status]), [['F1', 'blocked'], ['F2', 'skipped']]);
  assert.equal(warn.length, 1, warn.join('\n'));
  assert.match(warn[0], /could not record event/);
});

// ---------- ES-2 ----------
test('F54 ES-2: harness events skips a line that is not JSON and warns with the file and line number', () => {
  const dir = eventsProject({
    '2026-09.jsonl': [ev('2026-09-01T00:00:00.000Z', 'plan', 'lint', 'F1'), '{ broken', '[1,2]', ev('2026-09-02T00:00:00.000Z', 'plan', 'lint', 'F2')],
  });
  const r = harness(['events'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').length, 2);
  assert.match(r.stderr, /events\/2026-09\.jsonl:2: .*skipped/);
  assert.match(r.stderr, /events\/2026-09\.jsonl:3: .*skipped/);
  assert.equal(r.stderr.trim().split('\n').length, 2);
  const { events: list, warnings: w } = readEvents(dir);
  assert.equal(list.length, 2);
  assert.equal(w.length, 2);
  const j = harness(['events', '--json'], { cwd: dir });
  assert.equal(JSON.parse(j.stdout).length, 2);
});
