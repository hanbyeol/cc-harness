import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, REPO } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract, lintContract } from '../lib/contract.mjs';
import { HarnessError } from '../lib/errors.mjs';
import { runFeatures } from '../lib/run.mjs';
import { OUTPUT_SCHEMA, validateOutput } from '../lib/eval.mjs';
import evalCommand from '../lib/commands/eval.mjs';
import statusCommand from '../lib/commands/status.mjs';

const FAKE_CLI = path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs');

const SCRIPTS = {
  'scripts/ok.mjs': 'process.exit(0);\n',
  'scripts/fail.mjs': 'process.exit(3);\n',
  'scripts/has.mjs': "import fs from 'node:fs';\nprocess.exit(process.argv.slice(2).every((f) => fs.existsSync(f)) ? 0 : 1);\n",
};

function contract({ resolves, approve = true } = {}) {
  const c = {
    id: 'F9', title: 'fixture feature', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'one', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [],
    error_scenarios: [],
    out_of_scope: [],
  };
  if (resolves !== undefined) c.resolves = resolves;
  if (approve) c.approval = { by: 'test', at: '2026-09-26T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

// The evaluator CLI fails at once: nothing here reaches a real model CLI.
const FAILING_CLI = {
  roles: { builder: 'claude', evaluator: 'generic', 'security-reviewer': 'generic' },
  adapters: { generic: { read_only_command: [process.execPath, FAKE_CLI, 'exit', '1'] } },
};

function fixture({ items = [], backlogRaw, c = contract(), status = 'approved' } = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...FAILING_CLI },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status, depends_on: [] }] },
    '.harness/contracts/F9.json': c,
    '.harness/backlog.json': backlogRaw !== undefined ? backlogRaw : { items },
    ...SCRIPTS,
  });
}

const PASS_VERIFY = {
  pass: true, commands: [], warnings: [],
  integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } },
  criteria: [{ id: 'AC-1', pass: true }],
};

const scores = (o = {}) => ({ functionality: 9, quality: 9, security: 9, errors: 9, tests: 9, ...o });
const reply = (json) => ({ ok: true, error: null, text: JSON.stringify(json), json, costUsd: 0, exitCode: 0 });
const passWith = (out_of_scope = [], findings = []) => reply({ scores: scores(), findings, out_of_scope });
const failReply = () => reply({
  scores: scores({ functionality: 3 }), out_of_scope: [],
  findings: [{ criterion_id: 'AC-1', dimension: 'functionality', summary: 'broken', repro: 'node scripts/fail.mjs' }],
});

// Adapter answering with the next reply; records the prompts it was given.
function adapter(...replies) {
  const q = [...replies];
  const fn = async (role, opts) => {
    fn.calls += 1;
    fn.prompts.push(opts.prompt);
    if (!q.length) throw new Error('unexpected adapter call');
    return q.shift();
  };
  fn.calls = 0;
  fn.prompts = [];
  return fn;
}

async function evalCmd(dir, runAdapter) {
  const out = [];
  const err = [];
  try {
    const code = await evalCommand({
      root: dir, args: ['F9'], out: (s) => out.push(s), err: (s) => err.push(s),
      deps: { runAdapter, verifyResult: PASS_VERIFY },
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  } catch (e) {
    if (!(e instanceof HarnessError)) throw e;
    return { code: e.exit, out: out.join('\n'), err: [...err, e.message].join('\n'), error: e };
  }
}

async function statusCmd(dir, args = []) {
  const out = [];
  try {
    const code = await statusCommand({ root: dir, args, out: (s) => out.push(s), err: () => {} });
    return { code, out: out.join('\n') };
  } catch (e) {
    if (!(e instanceof HarnessError)) throw e;
    return { code: e.exit, out: out.join('\n'), err: e.message, error: e };
  }
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const backlogFile = (dir) => path.join(dir, '.harness', 'backlog.json');
const backlog = (dir) => readJson(backlogFile(dir)).items;
const statusOf = (dir) => readJson(path.join(dir, '.harness', 'features.json')).features.find((f) => f.id === 'F9').status;

// ---------- AC-1 ----------
test('F22 AC-1 items without an id get B1, B2, … in file order when the core writes the backlog', async () => {
  const dir = fixture({ items: [{ summary: 'old one' }, { summary: 'old two' }] });
  const r = await evalCmd(dir, adapter(passWith([{ summary: 'new three' }])));
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(backlog(dir).map((i) => [i.id, i.summary]), [['B1', 'old one'], ['B2', 'old two'], ['B3', 'new three']]);
});

test('F22 AC-1 existing ids stay; new and id-less items take the numbers after the largest', async () => {
  const dir = fixture({ items: [{ summary: 'a' }, { id: 'B7', summary: 'b' }, { id: 'B2', summary: 'c' }] });
  const r = await evalCmd(dir, adapter(passWith([{ summary: 'd' }, { summary: 'e' }])));
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(backlog(dir).map((i) => [i.id, i.summary]), [['B8', 'a'], ['B7', 'b'], ['B2', 'c'], ['B9', 'd'], ['B10', 'e']]);
});

test('F22 AC-1 a blocked re-scope proposal is written with an id too', async () => {
  const c = contract();
  const dir = fixture({ c, items: [{ id: 'B4', summary: 'x' }] });
  // needs-human: low score without a finding, re-asked once
  const low = () => reply({ scores: scores({ quality: 2 }), findings: [], out_of_scope: [] });
  const r = await evalCmd(dir, adapter(low(), low()));
  assert.equal(statusOf(dir), 'blocked', r.out + r.err);
  const items = backlog(dir);
  assert.equal(items.at(-1).source, 'F9-blocked');
  assert.equal(items.at(-1).id, 'B5');
});

// ---------- AC-2 ----------
test('F22 AC-2 the output schema has an optional severity enum on findings and out_of_scope', () => {
  const f = OUTPUT_SCHEMA.properties.findings.items;
  const o = OUTPUT_SCHEMA.properties.out_of_scope.items;
  for (const s of [f, o]) {
    assert.deepEqual(s.properties.severity, { type: 'string', enum: ['high', 'medium', 'low'] });
    assert.ok(!s.required.includes('severity'));
  }
});

test('F22 AC-2 severity is recorded as priority on backlog items (out_of_scope and non-blocking findings)', async () => {
  const dir = fixture();
  const r = await evalCmd(dir, adapter(passWith(
    [{ summary: 'oos high', severity: 'high' }, { summary: 'oos low', severity: 'low' }],
    [{ criterion_id: 'AC-9', dimension: 'quality', summary: 'finding medium', repro: 'node scripts/fail.mjs', severity: 'medium' }],
  )));
  assert.equal(r.code, 0, r.out + r.err);
  const by = Object.fromEntries(backlog(dir).map((i) => [i.summary, i]));
  assert.equal(by['oos high'].priority, 'high');
  assert.equal(by['oos low'].priority, 'low');
  assert.equal(by['finding medium'].priority, 'medium');
  assert.equal(by['finding medium'].reason, 'criterion_not_in_contract');
});

test('F22 AC-2 a severity outside high|medium|low is ignored: no schema error, no priority', async () => {
  const bad = { scores: scores(), findings: [], out_of_scope: [{ summary: 'weird', severity: 'critical' }, { summary: 'num', severity: 3 }] };
  assert.deepEqual(validateOutput(bad), []);
  const dir = fixture();
  const a = adapter(reply(bad));
  const r = await evalCmd(dir, a);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(a.calls, 1, 'not re-asked for a schema mismatch');
  for (const i of backlog(dir)) assert.ok(!('priority' in i), JSON.stringify(i));
  assert.equal(backlog(dir).length, 2);
});

// ---------- AC-3 ----------
test('F22 AC-3 the prompt lists open items by priority high→medium→low→none, resolved ones left out', async () => {
  const dir = fixture({ items: [
    { id: 'B1', summary: 'none one' },
    { id: 'B2', summary: 'low one', priority: 'low' },
    { id: 'B3', summary: 'high one', priority: 'high' },
    { id: 'B4', summary: 'resolved high', priority: 'high', resolved_by: 'F1' },
    { id: 'B5', summary: 'medium one', priority: 'medium' },
    { id: 'B6', summary: 'high two', priority: 'high' },
  ] });
  const a = adapter(passWith());
  assert.equal((await evalCmd(dir, a)).code, 0);
  const prompt = a.prompts[0];
  assert.match(prompt, /## Open backlog/);
  const order = ['B3', 'B6', 'B5', 'B2', 'B1'].map((id) => prompt.indexOf(`- ${id} `));
  assert.ok(order.every((x) => x !== -1), order.join(','));
  assert.deepEqual([...order].sort((x, y) => x - y), order);
  assert.match(prompt, /- B3 \[high\] high one/);
  assert.match(prompt, /- B1 \[-\] none one/);
  assert.ok(!prompt.includes('resolved high'));
});

test('F22 AC-3 at most 40 open items reach the prompt, the high ones first', async () => {
  const items = [];
  for (let n = 1; n <= 45; n += 1) items.push({ id: `B${n}`, summary: `plain item ${n}.` });
  items.push({ id: 'B46', summary: 'urgent item.', priority: 'high' });
  const dir = fixture({ items });
  const a = adapter(passWith());
  assert.equal((await evalCmd(dir, a)).code, 0);
  const listed = [...a.prompts[0].matchAll(/^- (B\d+) \[/gm)].map((m) => m[1]);
  assert.equal(listed.length, 40);
  assert.equal(listed[0], 'B46');
  assert.ok(!listed.includes('B40') && listed.includes('B39'));
});

test('F22 AC-3 a backlog_id naming an open item bumps seen and adds the feature-round to sources', async () => {
  const dir = fixture({ items: [{ id: 'B1', summary: 'known', sources: ['F3-r1'] }, { id: 'B2', summary: 'other', seen: 4 }] });
  const r = await evalCmd(dir, adapter(passWith(
    [{ summary: 'known again', backlog_id: 'B1' }],
    [{ criterion_id: 'AC-9', dimension: 'quality', summary: 'other again', repro: 'node scripts/fail.mjs', backlog_id: 'B2' }],
  )));
  assert.equal(r.code, 0, r.out + r.err);
  const items = backlog(dir);
  assert.equal(items.length, 2, JSON.stringify(items));
  assert.equal(items[0].seen, 2);
  assert.deepEqual(items[0].sources, ['F3-r1', 'F9-r1']);
  assert.equal(items[1].seen, 5);
  assert.deepEqual(items[1].sources, ['F9-r1']);
});

test('F22 AC-3 the schema offers backlog_id as an optional string', () => {
  for (const s of [OUTPUT_SCHEMA.properties.findings.items, OUTPUT_SCHEMA.properties.out_of_scope.items]) {
    assert.deepEqual(s.properties.backlog_id, { type: 'string' });
    assert.ok(!s.required.includes('backlog_id'));
  }
});

// ---------- AC-4 ----------
test('F22 AC-4 a backlog_id that does not exist adds a new item', async () => {
  const dir = fixture({ items: [{ id: 'B1', summary: 'known' }] });
  const r = await evalCmd(dir, adapter(passWith([{ summary: 'fresh', backlog_id: 'B99' }])));
  assert.equal(r.code, 0, r.out + r.err);
  const items = backlog(dir);
  assert.equal(items.length, 2);
  assert.equal(items[1].summary, 'fresh');
  assert.equal(items[1].id, 'B2');
  assert.equal(items[0].seen, undefined);
});

test('F22 AC-4 a backlog_id naming a resolved item adds a new item and leaves the resolved one', async () => {
  const dir = fixture({ items: [{ id: 'B1', summary: 'done', resolved_by: 'F2' }] });
  const r = await evalCmd(dir, adapter(passWith([{ summary: 'came back', backlog_id: 'B1' }])));
  assert.equal(r.code, 0, r.out + r.err);
  const items = backlog(dir);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { id: 'B1', summary: 'done', resolved_by: 'F2' });
  assert.equal(items[1].summary, 'came back');
  assert.equal(items[1].id, 'B2');
});

// ---------- AC-5 ----------
test('F22 AC-5 harness eval: a pass sets resolved_by on the items in resolves', async () => {
  const dir = fixture({
    c: contract({ resolves: ['B1', 'B3'] }),
    items: [{ id: 'B1', summary: 'a' }, { id: 'B2', summary: 'b' }, { id: 'B3', summary: 'c', resolved_by: 'F1' }],
  });
  const r = await evalCmd(dir, adapter(passWith()));
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(statusOf(dir), 'passed');
  const items = backlog(dir);
  assert.equal(items[0].resolved_by, 'F9');
  assert.equal(items[1].resolved_by, undefined);
  assert.equal(items[2].resolved_by, 'F1', 'an already resolved item keeps its resolver');
});

test('F22 AC-5 harness eval: fail and blocked leave resolves items open', async () => {
  const dir = fixture({ c: contract({ resolves: ['B1'] }), items: [{ id: 'B1', summary: 'a' }] });
  assert.equal((await evalCmd(dir, adapter(failReply()))).code, 1);
  assert.equal(statusOf(dir), 'in_progress');
  assert.equal(backlog(dir)[0].resolved_by, undefined);
  const low = () => reply({ scores: scores({ quality: 2 }), findings: [], out_of_scope: [] });
  await evalCmd(dir, adapter(low(), low()));
  assert.equal(statusOf(dir), 'blocked');
  assert.equal(backlog(dir)[0].resolved_by, undefined);
});

function runFixture(c, items) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': c,
    '.harness/backlog.json': { items },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    ...SCRIPTS,
  }, { branch: null });
}

async function run(dir, runAdapter) {
  return runFeatures({
    root: dir,
    config: resolveConfig({ base_branch: 'main', verify: { commands: [] }, max_rounds: 1, budget: { step_timeout_sec: 60 } }),
    deps: {
      build: async (a) => { writeFiles(a.cwd, { 'F9.txt': 'built\n' }); return { ok: true, costUsd: 0 }; },
      runAdapter,
      verify: async () => PASS_VERIFY,
    },
  });
}

test('F22 AC-5 harness run: a pass sets resolved_by on the items in resolves', async () => {
  const dir = runFixture(contract({ resolves: ['B2'] }), [{ id: 'B1', summary: 'a' }, { id: 'B2', summary: 'b' }]);
  const r = await run(dir, adapter(passWith()));
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results));
  const items = backlog(dir);
  assert.equal(items[0].resolved_by, undefined);
  assert.equal(items[1].resolved_by, 'F9');
});

test('F22 AC-5 harness run: a blocked feature leaves resolves items open', async () => {
  const dir = runFixture(contract({ resolves: ['B1'] }), [{ id: 'B1', summary: 'a' }]);
  const r = await run(dir, adapter(failReply()));
  assert.equal(r.results[0].status, 'blocked', JSON.stringify(r.results));
  assert.equal(backlog(dir).find((i) => i.id === 'B1').resolved_by, undefined);
});

// ---------- AC-6 ----------
test('F22 AC-6 lint: resolves that is not an array of strings is an error', () => {
  for (const bad of ['B1', [1], ['B1', null], {}]) {
    const problems = lintContract(contract({ resolves: bad, approve: false }), { backlog: [] });
    assert.ok(problems.some((p) => p.level === 'error' && /resolves/.test(p.message)), JSON.stringify([bad, problems]));
  }
  const ok = lintContract(contract({ resolves: [], approve: false }), { backlog: [] });
  assert.deepEqual(ok, []);
});

test('F22 AC-6 lint-contract warns about a missing or already resolved backlog id', () => {
  const dir = fixture({
    c: contract({ resolves: ['B1', 'B2', 'B5'], approve: false }),
    items: [{ id: 'B1', summary: 'open' }, { id: 'B2', summary: 'done', resolved_by: 'F3' }],
  });
  const r = harness(['lint-contract', 'F9'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /warning: .*B5.*does not exist/);
  assert.match(r.stdout, /warning: .*B2.*already resolved/);
  assert.doesNotMatch(r.stdout, /B1/);
  assert.match(r.stdout, /0 error\(s\), 2 warning\(s\)/);
});

test('F22 AC-6 lint-contract exits 1 on a resolves type error', () => {
  const dir = fixture({ c: contract({ resolves: 'B1', approve: false }) });
  const r = harness(['lint-contract', 'F9'], { cwd: dir });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /error: resolves/);
});

// ---------- AC-7 ----------
const STATUS_ITEMS = [
  { id: 'B1', summary: 'h1 ' + 'x'.repeat(150), priority: 'high' },
  { id: 'B2', summary: 'm1', priority: 'medium' },
  { id: 'B3', summary: 'h2', priority: 'high' },
  { id: 'B4', summary: 'l1', priority: 'low' },
  { id: 'B5', summary: 'n1' },
  { id: 'B6', summary: 'h3', priority: 'high' },
  { id: 'B7', summary: 'h4', priority: 'high' },
  { id: 'B8', summary: 'h5', priority: 'high' },
  { id: 'B9', summary: 'h6', priority: 'high' },
  { id: 'B10', summary: 'resolved high', priority: 'high', resolved_by: 'F1' },
];

test('F22 AC-7 status shows open counts by priority and at most 5 high items (id and 100 chars)', async () => {
  const dir = fixture({ items: STATUS_ITEMS });
  const r = await statusCmd(dir);
  assert.equal(r.code, 0);
  assert.match(r.out, /backlog: 9 open \(high 6 · medium 1 · low 1 · none 1\)/);
  const lines = r.out.split('\n');
  const shown = ['B1', 'B3', 'B6', 'B7', 'B8'].map((id) => lines.find((l) => new RegExp(`^\\s+${id}\\s`).test(l)));
  assert.ok(shown.every(Boolean), r.out);
  assert.ok(!lines.some((l) => /^\s+B9\s/.test(l)), 'only 5 high items listed');
  assert.ok(!lines.some((l) => /^\s+B10\s/.test(l)), 'resolved items not listed');
  assert.ok(shown[0].endsWith(STATUS_ITEMS[0].summary.slice(0, 100)));
  assert.ok(!shown[0].includes(STATUS_ITEMS[0].summary.slice(0, 101)));
});

test('F22 AC-7 status --brief appends only the open high count, omitted when 0', async () => {
  const dir = fixture({ items: STATUS_ITEMS });
  const r = await statusCmd(dir, ['--brief']);
  assert.equal(r.code, 0);
  assert.match(r.out, / — backlog high: 6$/);
  assert.equal(r.out.split('\n').length, 1);
  const none = fixture({ items: [{ id: 'B1', summary: 'm', priority: 'medium' }, { id: 'B2', summary: 'h', priority: 'high', resolved_by: 'F1' }] });
  const r2 = await statusCmd(none, ['--brief']);
  assert.equal(r2.code, 0);
  assert.doesNotMatch(r2.out, /backlog/);
});

// ---------- AC-8 ----------
test('F22 AC-8 SPEC describes backlog ids, severity, backlog_id, resolves and the spec-time review', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s7 = spec.slice(spec.indexOf('## 7.'), spec.indexOf('## 8.'));
  for (const w of ['`B1`', '`severity`', '`priority`', '`backlog_id`', '`seen`', '`sources`', '`resolves`', '`resolved_by`', '40']) {
    assert.ok(s7.includes(w), `SPEC §7 mentions ${w}`);
  }
  assert.match(s7, /spec skill/);
  const s5 = spec.slice(spec.indexOf('## 5.'), spec.indexOf('## 6.'));
  assert.ok(s5.includes('`resolves`'), 'SPEC §5 documents resolves');
});

test('F22 AC-8 skills/spec/SKILL.md tells the contract writer to review open high items into resolves', () => {
  const skill = fs.readFileSync(path.join(REPO, 'skills', 'spec', 'SKILL.md'), 'utf8');
  for (const w of ['`resolves`', '`high`', '`severity`', '`backlog_id`', '`resolved_by`', '`B1`', 'backlog.json']) {
    assert.ok(skill.includes(w), `spec skill mentions ${w}`);
  }
  assert.match(skill, /Review the open `high` items/);
});

// ---------- ES-1 ----------
for (const [name, raw] of [['an array', []], ['items not an array', { items: {} }], ['null', null]]) {
  test(`F22 ES-1 backlog.json that is ${name}: eval stops with state_corrupt before any adapter call or write`, async () => {
    const dir = fixture({ backlogRaw: raw });
    const before = fs.readFileSync(backlogFile(dir), 'utf8');
    const a = adapter(passWith());
    const r = await evalCmd(dir, a);
    assert.equal(r.code, 2, r.out + r.err);
    assert.equal(r.error.code, 'state_corrupt');
    assert.equal(a.calls, 0);
    assert.ok(r.err.includes(backlogFile(dir)), r.err);
    assert.equal(fs.readFileSync(backlogFile(dir), 'utf8'), before);
    assert.equal(statusOf(dir), 'approved');
    assert.ok(!fs.existsSync(path.join(dir, '.harness', 'verdicts', 'F9-r1.json')));
  });

  test(`F22 ES-1 backlog.json that is ${name}: status exits 2 with the path and no stack trace`, () => {
    const dir = fixture({ backlogRaw: raw });
    const before = fs.readFileSync(backlogFile(dir), 'utf8');
    for (const args of [['status'], ['status', '--brief']]) {
      const r = harness(args, { cwd: dir });
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.ok(r.stderr.includes(path.join('.harness', 'backlog.json')), r.stderr);
      assert.ok(!r.stderr.includes('    at '), r.stderr);
    }
    assert.equal(fs.readFileSync(backlogFile(dir), 'utf8'), before);
  });
}

// ---------- ES-2 ----------
test('F22 ES-2 duplicate backlog ids: status exits 2 (state_corrupt) naming the id and leaves the file', async () => {
  const dir = fixture({ items: [{ id: 'B1', summary: 'a' }, { id: 'B2', summary: 'b' }, { id: 'B2', summary: 'c' }, { summary: 'no id' }] });
  const before = fs.readFileSync(backlogFile(dir), 'utf8');
  const r = await statusCmd(dir);
  assert.equal(r.code, 2);
  assert.equal(r.error.code, 'state_corrupt');
  assert.match(r.err, /duplicate item id B2/);
  const cli = harness(['status'], { cwd: dir });
  assert.equal(cli.code, 2);
  assert.match(cli.stderr, /B2/);
  assert.ok(!cli.stderr.includes('    at '));
  assert.equal(fs.readFileSync(backlogFile(dir), 'utf8'), before);
});

// ---------- regression: items written before ids existed ----------
test('F22 AC-7 regression: open items without an id are counted and listed with the ids a write would give', async () => {
  const dir = fixture({ items: [{ summary: 'old', priority: 'high' }, { summary: 'older' }, { id: 'B3', summary: 'has id', priority: 'high' }] });
  const before = fs.readFileSync(backlogFile(dir), 'utf8');
  const r = await statusCmd(dir);
  assert.equal(r.code, 0);
  assert.match(r.out, /backlog: 3 open \(high 2 · medium 0 · low 0 · none 1\)/);
  assert.match(r.out, /^\s+B4\s+old$/m);
  assert.equal(fs.readFileSync(backlogFile(dir), 'utf8'), before, 'status does not write');
});

test('F22 AC-3 regression: id-less open items reach the prompt under the ids the write then persists', async () => {
  const dir = fixture({ items: [{ summary: 'legacy item', priority: 'high' }] });
  const a = adapter(passWith([{ summary: 'legacy again', backlog_id: 'B1' }]));
  assert.equal((await evalCmd(dir, a)).code, 0);
  assert.match(a.prompts[0], /- B1 \[high\] legacy item/);
  const items = backlog(dir);
  assert.equal(items.length, 1, JSON.stringify(items));
  assert.equal(items[0].id, 'B1');
  assert.equal(items[0].seen, 2);
});
