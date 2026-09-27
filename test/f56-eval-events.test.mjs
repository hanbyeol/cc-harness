import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { evaluate, reproProgram } from '../lib/eval.mjs';

// F56: eval and security stage events — one per finding (result, reason, repro exit and time),
// re-asks, and the verdict with each role's scores.

const SECRET = 'sk-test-secret-f56';

const contract = (over = {}) => ({
  id: 'F9', title: 'fixture feature', security_tier: 'standard', version: 1,
  acceptance_criteria: [{ id: 'AC-1', criterion: 'one', check: 'node scripts/ok.mjs', new: false }],
  security_criteria: [{ id: 'SC-1', criterion: 'no secrets', check: 'node scripts/ok.mjs', new: false }],
  error_scenarios: [{ id: 'ES-1', criterion: 'errors reported', check: 'node scripts/ok.mjs', new: false }],
  out_of_scope: [],
  ...over,
});

function fixture(c = contract()) {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': c,
    '.harness/backlog.json': { items: [] },
    'scripts/ok.mjs': 'process.exit(0);\n',
    'scripts/fail.mjs': 'process.exit(3);\n',
    'scripts/sleep.mjs': 'setTimeout(() => {}, 30000);\n',
  });
  writeFiles(dir, { 'src/app.mjs': 'export const v = 1;\n' });
  commitAll(dir, 'feature commit');
  return dir;
}

const cfg = (over = {}) => resolveConfig({
  base_branch: 'main',
  roles: { builder: 'claude', evaluator: 'claude', 'security-reviewer': 'claude' },
  ...over,
  verify: { commands: [] },
  budget: { step_timeout_sec: 30, ...(over.budget || {}) },
});

const PASS_VERIFY = {
  pass: true, commands: [], warnings: [],
  integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } },
  criteria: [{ id: 'AC-1', pass: true }, { id: 'SC-1', pass: true }, { id: 'ES-1', pass: true }],
};

const scores = (o = {}) => ({ functionality: 9, quality: 9, security: 9, errors: 9, tests: 9, ...o });
const reply = (json) => ({ ok: true, error: null, text: JSON.stringify(json), json, costUsd: 0.01, exitCode: 0 });
const good = (o = {}, findings = [], outOfScope = []) => reply({ scores: scores(o), findings, out_of_scope: outOfScope });

function scripted(script) {
  const queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]));
  return async (role) => {
    const q = queues[role];
    if (!q || q.length === 0) throw new Error(`unexpected call for role ${role}`);
    return q.shift();
  };
}

const run = (dir, script, { config, env } = {}) => evaluate({
  root: dir, featureId: 'F9', base: 'main', config: cfg(config), verifyResult: PASS_VERIFY, runAdapter: scripted(script),
  ...(env ? { env } : {}),
});

const eventsDir = (dir) => path.join(dir, '.harness', 'events');
const eventsText = (dir) => {
  let names = [];
  try { names = fs.readdirSync(eventsDir(dir)).sort(); } catch { return ''; }
  return names.map((n) => fs.readFileSync(path.join(eventsDir(dir), n), 'utf8')).join('');
};
const events = (dir) => eventsText(dir).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const of = (dir, stage, type) => events(dir).filter((e) => e.stage === stage && e.type === type);
const finding = (criterion_id, repro, summary = `${criterion_id} defect`, dimension = 'functionality') => ({ criterion_id, dimension, summary, repro });

// ---------- AC-1 ----------
test('F56 AC-1: eval records one eval/finding event per finding with id, dimension, source, result, reason, exit and time', async () => {
  const dir = fixture();
  const r = await run(dir, { evaluator: [good({ functionality: 3 }, [
    finding('AC-1', 'node scripts/fail.mjs', 'reproduced'),
    finding('', 'node scripts/fail.mjs', 'no id'),
    finding('AC-99', 'node scripts/fail.mjs', 'not in contract'),
    finding('ES-1', 'node scripts/ok.mjs', 'passes', 'errors'),
    finding('AC-1', 'no-such-program-f56 --flag', 'missing program'),
    finding('SC-1', 'git config core.hooksPath x', 'adversarial', 'security'),
    finding('AC-1', '', 'no repro'),
  ], [{ summary: 'later please' }])] });
  assert.equal(r.verdict, 'fail');
  const es = of(dir, 'eval', 'finding');
  assert.equal(es.length, 8);
  for (const e of es) {
    assert.equal(e.feature, 'F9');
    assert.equal(e.round, r.round);
    for (const k of ['criterion_id', 'dimension', 'source', 'result', 'reason', 'repro_exit', 'repro_ms', 'summary']) assert.ok(Object.hasOwn(e.data, k), k);
    assert.equal(e.data.source, 'evaluator');
  }
  const [hit, noId, notIn, notRepro, notRunnable, adv, noRepro, oos] = es.map((e) => e.data);
  assert.deepEqual([hit.criterion_id, hit.dimension, hit.result, hit.reason, hit.repro_exit], ['AC-1', 'functionality', 'blocking', null, 3]);
  assert.ok(Number.isInteger(hit.repro_ms) && hit.repro_ms >= 0);
  assert.deepEqual([noId.result, noId.reason, noId.criterion_id, noId.repro_exit, noId.repro_ms], ['backlogged', 'no_criterion', null, null, null]);
  assert.deepEqual([notIn.result, notIn.reason, notIn.criterion_id], ['backlogged', 'not_in_contract', 'AC-99']);
  assert.deepEqual([notRepro.result, notRepro.reason, notRepro.repro_exit, notRepro.dimension], ['backlogged', 'not_reproduced', 0, 'errors']);
  assert.ok(Number.isInteger(notRepro.repro_ms));
  assert.deepEqual([notRunnable.result, notRunnable.reason], ['backlogged', 'repro_not_runnable']);
  assert.deepEqual([adv.result, adv.reason, adv.repro_exit], ['backlogged', 'adversarial', null]);
  assert.deepEqual([noRepro.result, noRepro.reason], ['backlogged', 'no_repro']);
  assert.deepEqual([oos.result, oos.reason, oos.criterion_id, oos.summary], ['backlogged', 'out_of_scope', null, 'later please']);
});

test('F56 AC-1: an out-of-contract criterion_id is clipped in the finding event', async () => {
  const dir = fixture();
  await run(dir, { evaluator: [good({}, [finding('X'.repeat(5000), 'node scripts/fail.mjs', 's')])] });
  const [e] = of(dir, 'eval', 'finding');
  assert.equal(e.data.reason, 'not_in_contract');
  assert.ok(e.data.criterion_id.length <= 100, String(e.data.criterion_id.length));
  assert.ok(e.data.criterion_id.startsWith('XXX'));
});

test('F56 AC-1: security-reviewer findings are security/finding events with source security-reviewer', async () => {
  const dir = fixture(contract({ security_tier: 'critical' }));
  const r = await run(dir, {
    evaluator: [good()],
    'security-reviewer': [good({ security: 4 }, [finding('SC-1', 'node scripts/fail.mjs', 'leak', 'security')])],
  });
  assert.equal(r.verdict, 'fail');
  assert.equal(of(dir, 'eval', 'finding').length, 0);
  const [e] = of(dir, 'security', 'finding');
  assert.deepEqual([e.data.source, e.data.criterion_id, e.data.dimension, e.data.result, e.data.repro_exit], ['security-reviewer', 'SC-1', 'security', 'blocking', 3]);
});

test('F56 AC-1: findings of an unused security review are recorded as unused', async () => {
  const dir = fixture(contract({ security_tier: 'critical' }));
  await run(dir, {
    evaluator: [good({ functionality: 3 }, [finding('AC-1', 'node scripts/fail.mjs')])],
    'security-reviewer': [good({}, [finding('SC-1', 'node scripts/fail.mjs', 'leak', 'security')])],
  });
  const [e] = of(dir, 'security', 'finding');
  assert.equal(e.data.unused, true);
  assert.equal(of(dir, 'eval', 'finding')[0].data.unused, undefined);
});

// ---------- AC-2 ----------
test('F56 AC-2: a schema mismatch re-ask is an eval/reask event with reason schema_mismatch', async () => {
  const dir = fixture();
  const r = await run(dir, { evaluator: [reply({ scores: {} }), good()] });
  assert.equal(r.verdict, 'pass');
  const [e] = of(dir, 'eval', 'reask');
  assert.equal(e.data.role, 'evaluator');
  assert.equal(e.data.reason, 'schema_mismatch');
  assert.ok(Array.isArray(e.data.problems) && e.data.problems.length > 0);
  assert.equal(of(dir, 'eval', 'reask').length, 1);
});

test('F56 AC-2: an unsupported low score re-ask is an eval/reask event with reason unsupported_low_score', async () => {
  const dir = fixture();
  const r = await run(dir, { evaluator: [good({ tests: 3 }), good({ tests: 3 })] });
  assert.equal(r.verdict, 'needs-human');
  const es = of(dir, 'eval', 'reask');
  assert.equal(es.length, 1);
  assert.deepEqual([es[0].data.role, es[0].data.reason, es[0].data.scores.tests], ['evaluator', 'unsupported_low_score', 3]);
});

test('F56 AC-2: both re-asks of one evaluation are recorded, also when the second reply fails the schema', async () => {
  const dir = fixture();
  const r = await run(dir, { evaluator: [good({ tests: 3 }), reply({ nope: 1 }), reply({ nope: 2 })] });
  assert.equal(r.verdict, 'eval_error');
  assert.deepEqual(of(dir, 'eval', 'reask').map((e) => e.data.reason), ['unsupported_low_score', 'schema_mismatch']);
});

test('F56 AC-2: a passing evaluation records no re-ask', async () => {
  const dir = fixture();
  await run(dir, { evaluator: [good()] });
  assert.equal(of(dir, 'eval', 'reask').length, 0);
});

// ---------- AC-3 ----------
test('F56 AC-3: every verdict records eval/verdict with role scores, final score, verdict and independence', async () => {
  const dir = fixture();
  const r = await run(dir, { evaluator: [good({ quality: 8 })] });
  const [e] = of(dir, 'eval', 'verdict');
  assert.equal(e.round, r.round);
  assert.deepEqual(e.data.roles, { evaluator: scores({ quality: 8 }) });
  assert.deepEqual(e.data.scores, scores({ quality: 8 }));
  assert.equal(e.data.score, 8);
  assert.equal(e.data.verdict, 'pass');
  assert.equal(e.data.independence, r.independence);
  assert.ok(['cross-model', 'fresh-context'].includes(e.data.independence));
  assert.equal(of(dir, 'security', 'verdict').length, 0, 'standard tier: no security verdict');
});

test('F56 AC-3: critical records security/verdict with the reviewer scores and the security dimension verdict', async () => {
  const dir = fixture(contract({ security_tier: 'critical' }));
  const r = await run(dir, { evaluator: [good()], 'security-reviewer': [good({ security: 8, quality: 2 })] });
  assert.equal(r.verdict, 'pass');
  const [v] = of(dir, 'eval', 'verdict');
  assert.deepEqual(v.data.roles, { evaluator: scores(), 'security-reviewer': scores({ security: 8, quality: 2 }) });
  assert.equal(v.data.scores.security, 8);
  const [s] = of(dir, 'security', 'verdict');
  assert.deepEqual(s.data.reviewer_scores, scores({ security: 8, quality: 2 }));
  assert.equal(s.data.security, 8);
  assert.equal(s.data.security_verdict, 'pass');
});

test('F56 AC-3: a critical security score below 7 is a failing security dimension verdict', async () => {
  const dir = fixture(contract({ security_tier: 'critical' }));
  const r = await run(dir, {
    evaluator: [good()],
    'security-reviewer': [good({ security: 5 }, [finding('SC-1', 'node scripts/fail.mjs', 'leak', 'security')])],
  });
  assert.equal(r.verdict, 'fail');
  const [s] = of(dir, 'security', 'verdict');
  assert.equal(s.data.security_verdict, 'fail');
  assert.equal(s.data.reviewer_scores.security, 5);
  assert.equal(of(dir, 'eval', 'verdict')[0].data.verdict, 'fail');
});

test('F56 AC-3: an unused security review and an eval_error are recorded as verdicts too', async () => {
  const dir = fixture(contract({ security_tier: 'critical' }));
  await run(dir, {
    evaluator: [good({ functionality: 3 }, [finding('AC-1', 'node scripts/fail.mjs')])],
    'security-reviewer': [good()],
  });
  const [s] = of(dir, 'security', 'verdict');
  assert.equal(s.data.reviewer, 'unused');
  assert.equal(of(dir, 'eval', 'verdict')[0].data.roles['security-reviewer'], 'unused');

  const dir2 = fixture();
  await run(dir2, { evaluator: [reply({}), reply({})] });
  const [v] = of(dir2, 'eval', 'verdict');
  assert.deepEqual([v.data.verdict, v.data.error], ['eval_error', 'schema_mismatch']);
});

// ---------- AC-4 ----------
const section = (text, heading) => {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, heading);
  const rest = text.slice(start + heading.length);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
};

test('F56 AC-4: SPEC §7 and docs describe the eval and security events', () => {
  const s7 = section(fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8'), '## 7. ');
  for (const re of [/eval\/finding/, /security\/finding/, /eval\/reask/, /eval\/verdict/, /security\/verdict/,
    /`criterion_id`/, /`dimension`/, /`source`/, /`result`/, /`reason`/, /`repro_exit`/, /`repro_ms`/, /`repro_program`/,
    /no_criterion/, /not_reproduced/, /repro_not_runnable/, /adversarial/, /out_of_scope/,
    /schema_mismatch/, /unsupported_low_score/, /`roles`/, /`independence`/, /`security_verdict`/, /300/]) {
    assert.match(s7, re);
  }
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  assert.match(readme, /eval\/finding/);
});

// ---------- SC-1 ----------
test('F56 SC-1: the summary is redacted before it is cut to 300 characters', async () => {
  const dir = fixture();
  // The secret straddles the 300th character: cutting first would leave a fragment
  // that no longer matches the secret value.
  const summary = `${'x'.repeat(295)}${SECRET} tail`;
  await run(dir, { evaluator: [good({}, [], [{ summary }])] }, { env: { ...process.env, F56_TOKEN: SECRET } });
  const [e] = of(dir, 'eval', 'finding');
  assert.equal(e.data.summary, `${'x'.repeat(295)}[reda`);
  assert.equal(e.data.summary.length, 300);
  assert.equal(eventsText(dir).includes(SECRET.slice(0, 5)), false);
});

test('F56 SC-1: the repro command is not in the event, only its first program name', async () => {
  const dir = fixture();
  const repro = 'node scripts/fail.mjs --token=DISTINCT_REPRO_ARG && echo DISTINCT_TAIL';
  await run(dir, { evaluator: [good({ functionality: 3 }, [finding('AC-1', repro), finding('SC-1', 'F56=1 /usr/bin/env DISTINCT_X')])] });
  const [a, b] = of(dir, 'eval', 'finding').map((e) => e.data);
  assert.equal(a.repro_program, 'node');
  assert.equal(b.repro_program, 'env');
  assert.equal(Object.hasOwn(a, 'repro'), false);
  const text = eventsText(dir);
  for (const s of ['DISTINCT_REPRO_ARG', 'DISTINCT_TAIL', 'scripts/fail.mjs', 'DISTINCT_X']) assert.equal(text.includes(s), false, s);
});

test('F56 SC-1: reproProgram takes the first program name of the first command', () => {
  assert.equal(reproProgram('node test/t.mjs "F1 AC-1"'), 'node');
  assert.equal(reproProgram('A=1 B="x y" ./bin/run.sh arg'), 'run.sh');
  assert.equal(reproProgram('C:\\tools\\Node.EXE x'), 'node');
  assert.equal(reproProgram('cd sub && npm test'), 'cd');
  assert.equal(reproProgram(''), null);
  assert.equal(reproProgram(undefined), null);
});

// ---------- ES-1 ----------
test('F56 ES-1: a repro that times out is still recorded, backlogged as repro_timeout like before', async () => {
  const dir = fixture();
  const r = await run(dir, { evaluator: [good({}, [finding('AC-1', 'node scripts/sleep.mjs')])] }, { config: { budget: { step_timeout_sec: 1 } } });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.blocking.length, 0);
  assert.equal(r.backlogged[0].reason, 'repro_timeout');
  const [e] = of(dir, 'eval', 'finding');
  assert.deepEqual([e.data.result, e.data.reason, e.data.criterion_id, e.data.repro_exit, e.data.repro_program], ['backlogged', 'repro_timeout', 'AC-1', null, 'node']);
  assert.ok(Number.isInteger(e.data.repro_ms) && e.data.repro_ms >= 0);
});
