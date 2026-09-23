import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, REPO } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { HarnessError } from '../lib/errors.mjs';
import { runFeatures } from '../lib/run.mjs';
import { evaluate } from '../lib/eval.mjs';
import evalCommand from '../lib/commands/eval.mjs';

const FAKE_CLI = path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs');

const SCRIPTS = {
  'scripts/ok.mjs': 'process.exit(0);\n',
  'scripts/fail.mjs': 'process.exit(3);\n',
  'scripts/has.mjs': "import fs from 'node:fs';\nprocess.exit(process.argv.slice(2).every((f) => fs.existsSync(f)) ? 0 : 1);\n",
};

// version 1 = the contract the old verdicts were judged against; version 2 = the re-approved one.
function contract(version = 2, { approve = true } = {}) {
  const c = {
    id: 'F9', title: 'fixture feature', security_tier: 'standard', version,
    acceptance_criteria: [
      { id: 'AC-1', criterion: `one (v${version})`, check: 'node scripts/ok.mjs', new: false },
      { id: 'AC-2', criterion: 'two', check: 'node scripts/ok.mjs', new: false },
    ],
    security_criteria: [{ id: 'SC-1', criterion: 'three', check: 'node scripts/ok.mjs', new: false }],
    error_scenarios: [],
    out_of_scope: [],
  };
  if (approve) c.approval = { by: 'test', at: '2026-09-23T00:00:00.000Z', hash: hashContract(c) };
  return c;
}
const OLD_HASH = hashContract(contract(1));

// A CLI evaluator that fails at once: nothing here reaches a real model CLI.
const FAILING_CLI = {
  roles: { builder: 'claude', evaluator: 'generic', 'security-reviewer': 'generic' },
  adapters: { generic: { read_only_command: [process.execPath, FAKE_CLI, 'exit', '1'] } },
};

const oldVerdict = (round, ids, extra = {}) => ({
  feature: 'F9', round, verdict: 'fail', score: 3, verify_pass: true, origin: 'eval', contract_hash: OLD_HASH,
  blocking: ids.map((id) => ({ criterion_id: id, summary: `${id} broken`, repro: 'node scripts/fail.mjs', exit: 3 })),
  backlogged: [], ...extra,
});

// `verdicts`: { k: record | string } written as .harness/verdicts/F9-r{k}.json
function fixture({ status = 'approved', verdicts = {}, config = {}, c = contract(), evalRound } = {}) {
  const files = {};
  for (const [k, v] of Object.entries(verdicts)) files[`.harness/verdicts/F9-r${k}.json`] = v;
  const feature = { id: 'F9', title: 'fixture', status, depends_on: [], ...(evalRound ? { eval_round: evalRound } : {}) };
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...FAILING_CLI, ...config },
    '.harness/features.json': { features: [feature] },
    '.harness/contracts/F9.json': c,
    '.harness/backlog.json': { items: [] },
    ...files,
    ...SCRIPTS,
  });
}

const PASS_VERIFY = {
  pass: true, commands: [], warnings: [],
  integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } },
  criteria: [{ id: 'AC-1', pass: true }, { id: 'AC-2', pass: true }, { id: 'SC-1', pass: true }],
};

const scores = (o = {}) => ({ functionality: 9, quality: 9, security: 9, errors: 9, tests: 9, ...o });
const reply = (json) => ({ ok: true, error: null, text: JSON.stringify(json), json, costUsd: 0, exitCode: 0 });
const finding = (id) => ({ criterion_id: id, dimension: 'functionality', summary: `${id} broken`, repro: 'node scripts/fail.mjs' });
const passReply = () => reply({ scores: scores(), findings: [], out_of_scope: [] });
const failReply = (...ids) => reply({ scores: scores({ functionality: 3 }), findings: ids.map(finding), out_of_scope: [] });

function adapter(...replies) {
  const q = [...replies];
  const fn = async () => {
    fn.calls += 1;
    if (!q.length) throw new Error('unexpected adapter call');
    return q.shift();
  };
  fn.calls = 0;
  return fn;
}

async function evalCmd(dir, runAdapter, args = []) {
  const out = [];
  const err = [];
  try {
    const code = await evalCommand({
      root: dir, args: ['F9', ...args], out: (s) => out.push(s), err: (s) => err.push(s),
      deps: { runAdapter, verifyResult: PASS_VERIFY },
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  } catch (e) {
    if (!(e instanceof HarnessError)) throw e;
    return { code: e.exit, out: out.join('\n'), err: [...err, e.message].join('\n'), error: e };
  }
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const vfile = (dir, k) => path.join(dir, '.harness', 'verdicts', `F9-r${k}.json`);
const statusOf = (dir) => readJson(path.join(dir, '.harness', 'features.json')).features.find((f) => f.id === 'F9').status;
const verdictFiles = (dir) => {
  try { return fs.readdirSync(path.join(dir, '.harness', 'verdicts')).filter((n) => /^F9-r\d+\.json$/.test(n)).sort(); } catch { return []; }
};
const OLD_BLOCKED = { 1: oldVerdict(1, ['AC-1', 'AC-2', 'SC-1']), 2: oldVerdict(2, ['AC-1', 'AC-2']), 3: oldVerdict(3, ['AC-1']) };

// ---------- AC-1 ----------
test('F18 AC-1 blocked after r1-r3, re-approved with a new version: a failing eval writes r4, in_progress, max_rounds-1 left', async () => {
  const dir = fixture({ status: 'blocked', verdicts: OLD_BLOCKED, c: contract(1), evalRound: 3 });
  // The user revises the contract and re-approves it (the real approve command).
  writeFiles(dir, { '.harness/contracts/F9.json': contract(2, { approve: false }) });
  const ap = harness(['approve', 'F9', '--by', 'test'], { cwd: dir });
  assert.equal(ap.code, 0, ap.stdout + ap.stderr);
  assert.equal(statusOf(dir), 'approved');

  const r = await evalCmd(dir, adapter(failReply('AC-1')));
  assert.equal(r.code, 1, r.out + r.err);
  assert.deepEqual(verdictFiles(dir), ['F9-r1.json', 'F9-r2.json', 'F9-r3.json', 'F9-r4.json']);
  assert.equal(readJson(vfile(dir, 4)).verdict, 'fail');
  assert.equal(statusOf(dir), 'in_progress');
  assert.match(r.out, /rounds left: 2\b/);
});

test('F18 AC-1 rounds left follows max_rounds from config after re-approval', async () => {
  const dir = fixture({ verdicts: OLD_BLOCKED, config: { max_rounds: 5 } });
  const r = await evalCmd(dir, adapter(failReply('AC-1')));
  assert.equal(r.code, 1, r.out + r.err);
  assert.ok(fs.existsSync(vfile(dir, 4)));
  assert.equal(statusOf(dir), 'in_progress');
  assert.match(r.out, /rounds left: 4\b/);
});

// ---------- AC-2 ----------
test('F18 AC-2 convergence ignores verdicts of another contract hash: old {AC-1}, new first {AC-2} → in_progress, not divergence', async () => {
  const dir = fixture({ verdicts: { 1: oldVerdict(1, ['AC-1']) } });
  const r = await evalCmd(dir, adapter(failReply('AC-2')));
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(statusOf(dir), 'in_progress');
  assert.doesNotMatch(r.out, /divergence/);
  assert.deepEqual(readJson(path.join(dir, '.harness', 'backlog.json')).items.filter((i) => i.source === 'F9-blocked'), []);
});

test('F18 AC-2 the second verdict of the new hash is compared with the first one of the same hash', async () => {
  const dir = fixture({ verdicts: { 1: oldVerdict(1, ['AC-1']) } });
  await evalCmd(dir, adapter(failReply('AC-2')));
  const r = await evalCmd(dir, adapter(failReply('SC-1')));
  assert.equal(r.code, 1);
  assert.equal(statusOf(dir), 'blocked');
  assert.match(r.out, /divergence/);
});

// ---------- AC-3 ----------
test('F18 AC-3 max_rounds counts per contract hash: blocked(rounds) at the max_rounds-th fail of the new hash, not before', async () => {
  const dir = fixture({ verdicts: OLD_BLOCKED });
  const r1 = await evalCmd(dir, adapter(failReply('AC-1', 'AC-2', 'SC-1')));
  assert.equal(statusOf(dir), 'in_progress', r1.out + r1.err);
  const r2 = await evalCmd(dir, adapter(failReply('AC-1', 'AC-2')));
  assert.equal(statusOf(dir), 'in_progress', r2.out + r2.err);
  assert.match(r2.out, /rounds left: 1\b/);
  const r3 = await evalCmd(dir, adapter(failReply('AC-1')));
  assert.equal(statusOf(dir), 'blocked', r3.out + r3.err);
  const items = readJson(path.join(dir, '.harness', 'backlog.json')).items.filter((i) => i.source === 'F9-blocked');
  assert.deepEqual(items.map((i) => i.reason), ['rounds']);
  assert.deepEqual(verdictFiles(dir), [1, 2, 3, 4, 5, 6].map((k) => `F9-r${k}.json`));
});

test('F18 AC-3 max_rounds 1: the first fail of the new hash blocks with rounds', async () => {
  const dir = fixture({ verdicts: OLD_BLOCKED, config: { max_rounds: 1 } });
  await evalCmd(dir, adapter(failReply('AC-1')));
  assert.equal(statusOf(dir), 'blocked');
});

// ---------- AC-4 ----------
test('F18 AC-4 the verdict records contract_round and the output prints round <contract_round>/<max_rounds>', async () => {
  const dir = fixture({ verdicts: OLD_BLOCKED });
  const r1 = await evalCmd(dir, adapter(failReply('AC-1', 'AC-2')));
  assert.equal(readJson(vfile(dir, 4)).contract_round, 1);
  assert.equal(readJson(vfile(dir, 4)).round, 4);
  assert.match(r1.out, /round 1\/3\b/);
  const r2 = await evalCmd(dir, adapter(failReply('AC-1')));
  assert.equal(readJson(vfile(dir, 5)).contract_round, 2);
  assert.match(r2.out, /round 2\/3\b/);
});

test('F18 AC-4 --json output carries contract_round and max_rounds', async () => {
  const dir = fixture({ verdicts: { 1: oldVerdict(1, ['AC-1']) }, config: { max_rounds: 4 } });
  const r = await evalCmd(dir, adapter(failReply('AC-1')), ['--json']);
  const j = JSON.parse(r.out);
  assert.equal(j.contract_round, 1);
  assert.equal(j.max_rounds, 4);
  assert.equal(j.round, 2);
});

// ---------- AC-5 / SC-1 (run) ----------
async function runOnce(dir) {
  const deps = {
    build: async (a) => { writeFiles(a.cwd, { 'F9.txt': 'built\n' }); return { ok: true, costUsd: 0 }; },
    runAdapter: adapter(failReply('AC-1'), passReply()),
    evaluate,
    verify: async () => PASS_VERIFY,
  };
  return runFeatures({
    root: dir, deps,
    config: resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, max_rounds: 1 }),
  });
}

function runFixture(verdicts) {
  const files = {};
  for (const [k, v] of Object.entries(verdicts)) files[`.harness/verdicts/F9-r${k}.json`] = v;
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': contract(),
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    ...files,
    ...SCRIPTS,
  }, { branch: null });
}

test('F18 AC-5 harness run with r1 and r2 present writes the new verdict to r3; the report counts this contract’s round (1)', async () => {
  const dir = runFixture({ 1: oldVerdict(1, ['AC-1', 'AC-2']), 2: oldVerdict(2, ['AC-1']) });
  const r = await runOnce(dir);
  assert.equal(r.results[0].rounds, 1, JSON.stringify(r.results));
  assert.deepEqual(verdictFiles(dir), ['F9-r1.json', 'F9-r2.json', 'F9-r3.json']);
  const v3 = readJson(vfile(dir, 3));
  assert.equal(v3.origin, 'run');
  assert.equal(v3.contract_round, 1);
  const md = fs.readFileSync(r.report, 'utf8');
  assert.match(md, /\| F9 fixture \| blocked \| 1 \|/);
});

test('F18 SC-1 harness run does not overwrite an existing verdict file (r1 bytes unchanged)', async () => {
  const dir = runFixture({ 1: oldVerdict(1, ['AC-1']) });
  const before = fs.readFileSync(vfile(dir, 1));
  await runOnce(dir);
  assert.ok(fs.readFileSync(vfile(dir, 1)).equals(before), 'r1 rewritten by run');
  assert.ok(fs.existsSync(vfile(dir, 2)));
});

test('F18 SC-1 harness eval does not overwrite an existing verdict file (r1 bytes unchanged)', async () => {
  const dir = fixture({ verdicts: { 1: oldVerdict(1, ['AC-1']) } });
  const before = fs.readFileSync(vfile(dir, 1));
  const r = await evalCmd(dir, adapter(failReply('AC-2')));
  assert.equal(r.code, 1, r.out + r.err);
  assert.ok(fs.readFileSync(vfile(dir, 1)).equals(before), 'r1 rewritten by eval');
  assert.ok(fs.existsSync(vfile(dir, 2)));
});

test('F18 SC-1 evaluate refuses an explicit round whose verdict exists, before any adapter call', async () => {
  const dir = fixture({ verdicts: { 1: oldVerdict(1, ['AC-1']) } });
  const before = fs.readFileSync(vfile(dir, 1));
  const ra = adapter(passReply());
  await assert.rejects(
    evaluate({ root: dir, featureId: 'F9', round: 1, base: 'main', config: resolveConfig({}), verifyResult: PASS_VERIFY, runAdapter: ra }),
    (e) => e instanceof HarnessError && e.code === 'round_exists',
  );
  assert.equal(ra.calls, 0);
  assert.ok(fs.readFileSync(vfile(dir, 1)).equals(before));
});

// ---------- ES-1 ----------
test('F18 ES-1 verdicts without contract_hash count for the file number only, not for rounds or convergence', async () => {
  const legacy = (round, ids) => { const v = oldVerdict(round, ids); delete v.contract_hash; return v; };
  const dir = fixture({ verdicts: { 1: legacy(1, ['AC-1', 'AC-2']), 2: legacy(2, ['AC-1']) } });
  const r = await evalCmd(dir, adapter(failReply('SC-1')));
  assert.equal(r.code, 1, r.out + r.err);
  assert.ok(fs.existsSync(vfile(dir, 3)), 'numbered after the legacy verdicts');
  assert.equal(readJson(vfile(dir, 3)).contract_round, 1);
  assert.equal(statusOf(dir), 'in_progress', 'SC-1 is not divergence against a legacy verdict');
  assert.match(r.out, /round 1\/3\b/);
  assert.match(r.out, /rounds left: 2\b/);
});

// ---------- ES-2 ----------
test('F18 ES-2 unreadable previous verdict of the current hash: no adapter call, exit 2 state_corrupt, path in message, no stack', async () => {
  const dir = fixture({ status: 'in_progress', verdicts: { 1: oldVerdict(1, ['AC-1']), 2: '{ not json' } });
  const ra = adapter(passReply());
  const r = await evalCmd(dir, ra);
  assert.equal(r.code, 2);
  assert.equal(r.error.code, 'state_corrupt');
  assert.equal(ra.calls, 0);
  assert.ok(r.err.includes(vfile(dir, 2)), r.err);
  assert.deepEqual(verdictFiles(dir), ['F9-r1.json', 'F9-r2.json']);

  const cli = harness(['eval', 'F9'], { cwd: dir });
  assert.equal(cli.code, 2, cli.stdout + cli.stderr);
  assert.ok(cli.stderr.includes('F9-r2.json'), cli.stderr);
  assert.ok(!cli.stderr.includes('    at '), cli.stderr);
  assert.equal(statusOf(dir), 'in_progress');
});

test('F18 ES-2 harness run: an unreadable verdict stops with exit 2 state_corrupt before the evaluator is called', async () => {
  const dir = runFixture({ 1: oldVerdict(1, ['AC-1']), 2: '{ not json' });
  const before = fs.readFileSync(vfile(dir, 2));
  const ra = adapter(failReply('AC-1'));
  const err = await runFeatures({
    root: dir,
    deps: {
      build: async (a) => { writeFiles(a.cwd, { 'F9.txt': 'built\n' }); return { ok: true, costUsd: 0 }; },
      runAdapter: ra, evaluate, verify: async () => PASS_VERIFY,
    },
    config: resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, max_rounds: 1 }),
  }).then(() => null, (e) => e);
  assert.ok(err instanceof HarnessError, String(err));
  assert.equal(err.code, 'state_corrupt');
  assert.equal(err.exit, 2);
  assert.ok(err.message.includes(vfile(dir, 2)), err.message);
  assert.ok(!err.message.includes('    at '), err.message);
  assert.equal(ra.calls, 0);
  assert.ok(fs.readFileSync(vfile(dir, 2)).equals(before));
});

// ---------- AC-6 ----------
const SPEC = () => fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
const section = (s, from, to) => s.slice(s.indexOf(from), s.indexOf(to));

test('F18 AC-6 SPEC §7 explains per-feature verdict numbering and per-contract-hash rounds and convergence', () => {
  const s = section(SPEC(), '## 7.', '## 8.');
  assert.match(s, /판정 파일 번호는 기능별로 계속 증가/);
  assert.match(s, /`contract_round`/);
  assert.match(s, /라운드 상한[^\n]*계약 해시/);
  assert.match(s, /수렴 비교[^\n]*계약 해시/);
  assert.match(s, /`contract_hash` 가 없는/);
});

test('F18 AC-6 SPEC §8 explains per-feature verdict numbering and per-contract-hash rounds and convergence', () => {
  const s = section(SPEC(), '## 8.', '## 9.');
  assert.match(s, /판정 파일 번호는 기능별로 계속 증가/);
  assert.match(s, /라운드 상한[^\n]*계약 해시/);
  assert.match(s, /수렴 비교[^\n]*계약 해시/);
});
