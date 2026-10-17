// F123: interactive eval counts a verify-failed round by the run's blocking ids, and a critical
// reviewer's usage_limit / refusal does not stop an evaluation that already has a blocking finding.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { HarnessError } from '../lib/errors.mjs';
import { runFeatures, verdictBlockingIds } from '../lib/run.mjs';
import { evaluate } from '../lib/eval.mjs';
import { decideStatus } from '../lib/eval-status.mjs';
import evalCommand from '../lib/commands/eval.mjs';

const SCRIPTS = {
  'scripts/ok.mjs': 'process.exit(0);\n',
  'scripts/fail.mjs': 'process.exit(3);\n',
};

function contract(tier = 'standard') {
  const c = {
    id: 'F9', title: 'fixture feature', security_tier: tier, version: 1,
    acceptance_criteria: [
      { id: 'AC-1', criterion: 'one', check: 'node scripts/ok.mjs', new: false },
      { id: 'AC-2', criterion: 'two', check: 'node scripts/ok.mjs', new: false },
    ],
    security_criteria: [{ id: 'SC-1', criterion: 'three', check: 'node scripts/ok.mjs', new: false }],
    error_scenarios: [],
    out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-17T00:00:00.000Z', hash: hashContract(c) };
  return c;
}
const HASH = hashContract(contract());

function fixture({ tier = 'standard', status = 'approved', verdicts = {} } = {}) {
  const files = {};
  for (const [k, v] of Object.entries(verdicts)) files[`.harness/verdicts/F9-r${k}.json`] = v;
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, max_rounds: 3 },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status, depends_on: [], security_tier: tier }] },
    '.harness/contracts/F9.json': contract(tier),
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    ...files,
    ...SCRIPTS,
  }, { branch: null });
}

const OK_INTEGRITY = { markers: [], harnessPaths: [], testCount: { status: 'unset' } };
const PASS_VERIFY = {
  pass: true, commands: [], warnings: [], integrity: OK_INTEGRITY,
  criteria: [{ id: 'AC-1', pass: true }, { id: 'AC-2', pass: true }, { id: 'SC-1', pass: true }],
};
const failVerify = (over) => ({ ...PASS_VERIFY, pass: false, ...over });
const CRITERION_FAIL = failVerify({
  criteria: [{ id: 'AC-1#a', pass: false, message: 'x', check: 'c' }, { id: 'AC-1#b', pass: false, message: 'y', check: 'c' }, { id: 'AC-2', pass: false, message: 'z', check: 'c' }, { id: 'SC-1', pass: true }],
});
const COMMAND_FAIL = failVerify({ commands: [{ cmd: 'npm test', pass: false, message: 'exit 1' }] });
const INTEGRITY_FAIL = failVerify({ integrity: { ...OK_INTEGRITY, markers: ['x.skip'] } });
const NOTHING_FAIL = failVerify({});

const scores = (o = {}) => ({ functionality: 9, quality: 9, security: 9, errors: 9, tests: 9, ...o });
const reply = (json) => ({ ok: true, error: null, text: JSON.stringify(json), json, costUsd: 0, exitCode: 0 });
const finding = (id) => ({ criterion_id: id, dimension: 'functionality', summary: `${id} broken`, repro: 'node scripts/fail.mjs' });
const passReply = () => reply({ scores: scores(), findings: [], out_of_scope: [] });
const failReply = (...ids) => reply({ scores: scores({ functionality: 3 }), findings: ids.map(finding), out_of_scope: [] });
const limitReply = (error) => ({ ok: false, error, detail: `${error} detail`, text: '', json: null, costUsd: 0, exitCode: 1 });

// An adapter that answers by role.
const byRole = (map) => async (role) => {
  const r = map[role];
  if (!r) throw new Error(`unexpected adapter call for ${role}`);
  return r;
};

async function evalCmd(dir, runAdapter, verifyResult = PASS_VERIFY) {
  const out = [];
  const err = [];
  let code;
  try {
    code = await evalCommand({ root: dir, args: ['F9'], out: (s) => out.push(s), err: (s) => err.push(s), deps: { runAdapter, verifyResult } });
  } catch (e) {
    if (!(e instanceof HarnessError)) throw e;
    code = e.exit;
    err.push(e.message);
  }
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const vfile = (dir, k = 1) => path.join(dir, '.harness', 'verdicts', `F9-r${k}.json`);
const statusOf = (dir) => readJson(path.join(dir, '.harness', 'features.json')).features.find((f) => f.id === 'F9').status;
const verdictFiles = (dir) => {
  try { return fs.readdirSync(path.join(dir, '.harness', 'verdicts')).filter((n) => /^F9-r\d+\.json$/.test(n)); } catch { return []; }
};

const failV = (round, { verifyBlocking, ids = [] }) => ({
  verdict: 'fail', round, contract_round: round, verify_pass: verifyBlocking ? false : true,
  ...(verifyBlocking ? { verify_blocking: verifyBlocking } : {}),
  blocking: ids.map((id) => ({ criterion_id: id, summary: id, repro: 'x' })),
});

// ---------- AC-1 ----------
test('F123 AC-1 a verify-failed eval records verify_blocking: failing criterion ids without #n, VERIFY:commands, VERIFY:integrity, else VERIFY', async () => {
  const cases = [
    [CRITERION_FAIL, ['AC-1', 'AC-2']],
    [COMMAND_FAIL, ['VERIFY:commands']],
    [INTEGRITY_FAIL, ['VERIFY:integrity']],
    [NOTHING_FAIL, ['VERIFY']],
    [failVerify({ criteria: CRITERION_FAIL.criteria, commands: COMMAND_FAIL.commands, integrity: INTEGRITY_FAIL.integrity }), ['AC-1', 'AC-2', 'VERIFY:commands', 'VERIFY:integrity']],
  ];
  for (const [vr, want] of cases) {
    const dir = fixture();
    const r = await evalCmd(dir, byRole({ evaluator: passReply() }), vr);
    assert.equal(r.code, 1, r.out + r.err);
    assert.deepEqual(readJson(vfile(dir)).verify_blocking, want);
  }
  // A passing verify records none.
  const dir = fixture();
  await evalCmd(dir, byRole({ evaluator: passReply() }));
  assert.equal('verify_blocking' in readJson(vfile(dir)), false);
});

// ---------- AC-2 ----------
test('F123 AC-2 verify-only fails {AC-1, AC-2, AC-3} then {AC-1} is in_progress, not stall', () => {
  const d = decideStatus({
    verdict: failV(2, { verifyBlocking: ['AC-1'] }),
    prev: failV(1, { verifyBlocking: ['AC-1', 'AC-2', 'AC-3'] }),
    maxRounds: 3,
  });
  assert.equal(d.status, 'in_progress');
  assert.deepEqual(d.ids, ['AC-1']);
});

// ---------- AC-3 ----------
test('F123 AC-3 a verify-only fail then a passing verify with a finding: an id blocking before is in_progress, a new id is divergence', () => {
  const prev = failV(1, { verifyBlocking: ['AC-2', 'AC-3'] });
  const ok = decideStatus({ verdict: { ...failV(2, { ids: ['AC-2'] }), verify_pass: true }, prev, maxRounds: 3 });
  assert.equal(ok.status, 'in_progress');
  const bad = decideStatus({ verdict: { ...failV(2, { ids: ['AC-4'] }), verify_pass: true }, prev, maxRounds: 3 });
  assert.equal(bad.status, 'blocked');
  assert.equal(bad.reason, 'divergence');
  assert.deepEqual(bad.ids, ['AC-4']);
});

// ---------- AC-4 ----------
test('F123 AC-4 a verify-failed verdict blocks with the union of verify_blocking and finding ids', () => {
  const v = failV(1, { verifyBlocking: ['AC-1'], ids: ['AC-3'] });
  assert.deepEqual([...verdictBlockingIds(v)].sort(), ['AC-1', 'AC-3']);
  // A passing verify ignores a stale verify_blocking.
  assert.deepEqual(verdictBlockingIds({ ...v, verify_pass: true }), ['AC-3']);
});

// ---------- AC-5 ----------
test('F123 AC-5 run takes over a verify-only interactive fail {AC-1, AC-2}; a first round failing AC-1 goes on instead of stalling', async () => {
  const carried = {
    feature: 'F9', round: 1, verdict: 'fail', score: 9, verify_pass: false, origin: 'eval',
    contract_hash: HASH, contract_round: 1, blocking: [], backlogged: [], verify_blocking: ['AC-1', 'AC-2'],
  };
  const dir = fixture({ status: 'in_progress', verdicts: { 1: carried } });
  const build = async (a) => {
    build.calls += 1;
    writeFiles(a.cwd, { 'F9.txt': `built ${build.calls}\n` });
    return { ok: true, costUsd: 0 };
  };
  build.calls = 0;
  const only1 = failVerify({ criteria: [{ id: 'AC-1', pass: false, message: 'x', check: 'node scripts/ok.mjs' }, { id: 'AC-2', pass: true }, { id: 'SC-1', pass: true }] });
  const r = await runFeatures({
    root: dir,
    deps: { build, runAdapter: byRole({}), evaluate, verify: async () => only1 },
    config: resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, max_rounds: 3 }),
  });
  // Round 2 (the run's first) ended with AC-1 ⊂ {AC-1, AC-2}; round 3 repeats AC-1 and ends the feature.
  assert.ok(build.calls > 3, `builds ${build.calls} ${JSON.stringify(r.results)}`);
  assert.equal(r.results[0].status, 'blocked');
  assert.equal(r.results[0].rounds, 3, JSON.stringify(r.results));
});

// ---------- AC-6 ----------
test('F123 AC-6 critical: a blocking evaluator finding and a reviewer usage_limit / refusal write a fail verdict, reviewer unused, exit 1, in_progress', async () => {
  for (const error of ['usage_limit', 'refusal']) {
    const dir = fixture({ tier: 'critical' });
    const r = await evalCmd(dir, byRole({ evaluator: failReply('AC-1'), 'security-reviewer': limitReply(error) }));
    assert.equal(r.code, 1, `${error}: ${r.out}${r.err}`);
    const v = readJson(vfile(dir));
    assert.equal(v.verdict, 'fail', error);
    assert.equal(v.reviews['security-reviewer'], 'unused', error);
    assert.equal(statusOf(dir), 'in_progress', error);
  }
});

// ---------- SC-1 ----------
test('F123 SC-1 critical: no blocking evaluator finding and a reviewer usage_limit / refusal: no verdict file, exit 1, status unchanged', async () => {
  for (const error of ['usage_limit', 'refusal']) {
    const dir = fixture({ tier: 'critical' });
    const r = await evalCmd(dir, byRole({ evaluator: passReply(), 'security-reviewer': limitReply(error) }));
    assert.equal(r.code, 1, `${error}: ${r.out}${r.err}`);
    assert.match(r.err, new RegExp(error === 'usage_limit' ? 'usage limit' : 'refusal'));
    assert.deepEqual(verdictFiles(dir), [], error);
    assert.equal(statusOf(dir), 'approved', error);
  }
  // The evaluator's own limit stops even with a reviewer that answered.
  const dir = fixture({ tier: 'critical' });
  const r = await evalCmd(dir, byRole({ evaluator: limitReply('usage_limit'), 'security-reviewer': passReply() }));
  assert.equal(r.code, 1);
  assert.deepEqual(verdictFiles(dir), []);
});

// ---------- SC-2 ----------
test('F123 SC-2 a verify-failed eval is fail with a perfect evaluator score and non-empty verdictBlockingIds', async () => {
  for (const vr of [CRITERION_FAIL, COMMAND_FAIL, INTEGRITY_FAIL]) {
    const dir = fixture();
    const r = await evalCmd(dir, byRole({ evaluator: passReply() }), vr);
    assert.equal(r.code, 1, r.out + r.err);
    const v = readJson(vfile(dir));
    assert.equal(v.verdict, 'fail');
    assert.ok(verdictBlockingIds(v).length > 0);
  }
});

// ---------- ES-1 ----------
test('F123 ES-1 an older verify-failed verdict, or a malformed verify_blocking, reads as VERIFY without throwing', () => {
  const base = { verdict: 'fail', verify_pass: false, blocking: [] };
  assert.deepEqual(verdictBlockingIds(base), ['VERIFY']);
  for (const bad of ['AC-1', null, 7, {}, [1, null, {}, ''], []]) {
    assert.deepEqual(verdictBlockingIds({ ...base, verify_blocking: bad }), ['VERIFY'], JSON.stringify(bad));
  }
});

// ---------- AC-7 / AC-8 ----------
const SPEC = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
const between = (from, to) => {
  const a = SPEC.indexOf(from);
  const b = SPEC.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} … ${to}`);
  return SPEC.slice(a, b);
};

test('F123 AC-7 SPEC §7.6 names verify_blocking and its ids, §7.4 counts reviewer usage_limit and refusal', () => {
  const s76 = between('6. **대화형 eval 의 상태 기록**', '7. **backlog 정리 루프**');
  for (const w of ['verify_blocking', 'VERIFY:commands', 'VERIFY:integrity', '`VERIFY`', '합집합']) assert.ok(s76.includes(w), w);
  const s74 = between('4. critical: security-reviewer', '5. `independence`');
  assert.ok(s74.includes('`usage_limit`') && s74.includes('`refusal`'));
});

test('F123 AC-8 SPEC §8 divergence reads "k-1 에서 차단이 아니던 id", not the passed-criterion wording', () => {
  const s8 = SPEC.slice(SPEC.indexOf('## 8. 자율 실행'));
  assert.ok(s8.includes('k-1 에서 차단이 아니던 id'));
  assert.ok(!SPEC.includes('k-1에서 통과한 기준 id'));
});
