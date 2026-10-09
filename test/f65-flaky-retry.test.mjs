import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, REPO } from './helpers.mjs';
import { git, gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { verify } from '../lib/verify.mjs';
import { runFeatures } from '../lib/run.mjs';
import { HarnessError } from '../lib/errors.mjs';

// A test command scripted per attempt: plan[n] is the n-th run's outcome — 'p' passes,
// 'f' fails after printing each '|'-separated name as a failed test ('-' prints none),
// 'h' hangs past the step timeout. The attempt counter lives in the named state file.
const SCRIPTS = {
  'scripts/plan.mjs': [
    "import fs from 'node:fs';",
    'const [plan, names, state] = process.argv.slice(2);',
    "const n = fs.existsSync(state) ? Number(fs.readFileSync(state, 'utf8')) : 0;",
    'fs.writeFileSync(state, String(n + 1));',
    "const step = plan[n] ?? 'p';",
    "if (step === 'p') process.exit(0);",
    "if (step === 'h') setTimeout(() => {}, 20000);",
    "else {",
    "  if (names !== '-') for (const name of names.split('|')) console.log(`\\u2716 ${name} (1.5ms)`);",
    '  process.exit(1);',
    '}',
    '',
  ].join('\n'),
  '.gitignore': '*.state\n',
};

const contract = (id = 'F9') => {
  const c = {
    id, title: 'fixture', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'check exists', check: 'node check.mjs', new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-28T00:00:00.000Z', hash: hashContract(c) };
  return c;
};

function fixture() {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': contract(),
    ...SCRIPTS,
  });
  writeFiles(dir, { 'check.mjs': 'process.exit(0);\n' });
  return dir;
}

const planCmd = (plan, names, state = 'a.state') => `node scripts/plan.mjs ${plan} "${names}" ${state}`;
const cfg = (over = {}) => resolveConfig({ base_branch: 'main', ...over, verify: { commands: [], ...(over.verify || {}) }, budget: { step_timeout_sec: 60, ...(over.budget || {}) } });
const run = (dir, over = {}) => verify({ root: dir, featureId: 'F9', base: 'main', config: cfg(over) });
const attemptsRun = (dir, state = 'a.state') => Number(fs.readFileSync(path.join(dir, state), 'utf8'));

const events = (dir) => {
  const d = path.join(dir, '.harness', 'events');
  let names = [];
  try { names = fs.readdirSync(d).sort(); } catch { return []; }
  return names.flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
};
const commandEvents = (dir) => events(dir).filter((e) => e.stage === 'verify' && e.type === 'command');

// ---------- AC-1 ----------
test('F65 AC-1: a command that fails once and then passes twice passes on the third run (retry is the default)', async () => {
  const dir = fixture();
  const r = await run(dir, { verify: { commands: [planCmd('fpp', 'other suite > slow test')] } });
  assert.equal(cfg().verify.flaky, 'retry');
  const c = r.commands[0];
  assert.deepEqual([c.pass, c.attempts, c.flaky, c.flaky_passed], [true, 3, true, true], JSON.stringify(c));
  assert.equal(attemptsRun(dir), 3);
  assert.equal(r.pass, true, JSON.stringify(r, null, 2));
  assert.deepEqual(c.flaky_tests, ['other suite > slow test']);
  assert.deepEqual(r.flaky_tests, ['other suite > slow test']);
  assert.ok(r.warnings.some((w) => w.includes('flaky: passed on retry')), JSON.stringify(r.warnings));
});

test('F65 AC-1: a command that passes first time runs once and leaves no flaky warning', async () => {
  const dir = fixture();
  const r = await run(dir, { verify: { commands: [planCmd('p', '-')] } });
  assert.deepEqual([r.commands[0].pass, r.commands[0].attempts, r.commands[0].flaky_passed], [true, 1, undefined]);
  assert.equal(r.warnings.some((w) => w.includes('flaky')), false);
  assert.equal(r.flaky_tests, undefined);
});

// ---------- AC-2 ----------
test('F65 AC-2: fail, pass, fail — the third run fails the command (attempts 3, flaky true)', async () => {
  const dir = fixture();
  const r = await run(dir, { verify: { commands: [planCmd('fpf', 'other test')] } });
  const c = r.commands[0];
  assert.deepEqual([c.pass, c.attempts, c.flaky, Boolean(c.flaky_passed)], [false, 3, true, false], JSON.stringify(c));
  assert.equal(attemptsRun(dir), 3);
  assert.equal(r.pass, false);
  assert.equal(r.warnings.some((w) => w.includes('flaky: passed on retry')), false);
});

test('F65 AC-2: failing twice never runs a third time (attempts 2, not flaky)', async () => {
  const dir = fixture();
  const r = await run(dir, { verify: { commands: [planCmd('ffp', 'other test')] } });
  const c = r.commands[0];
  assert.deepEqual([c.pass, c.attempts, c.flaky], [false, 2, false], JSON.stringify(c));
  assert.equal(attemptsRun(dir), 2);
  assert.equal(r.pass, false);
});

// ---------- AC-3 ----------
test("F65 AC-3: a flaky failure of the feature's own test stays a fail whatever the third run does", async () => {
  const dir = fixture();
  const r = await run(dir, { verify: { commands: [planCmd('fpp', 'other test|F9 AC-1: own test', 'a.state')] } });
  const c = r.commands[0];
  assert.equal(c.pass, false, JSON.stringify(c));
  // F89: the own test failed, so no re-run can pass the command — it is not re-run at all
  assert.equal(c.flaky, false);
  assert.equal(Boolean(c.flaky_passed), false);
  assert.deepEqual([c.flaky_tests, c.retry_skipped, attemptsRun(dir)], [undefined, 'own_test', 1]);
  assert.equal(r.pass, false);
});

test('F65 AC-3: a flaky failure without failed test names in the output stays a fail', async () => {
  const dir = fixture();
  const r = await run(dir, { verify: { commands: [planCmd('fpp', '-')] } });
  const c = r.commands[0];
  // F89: no failed test names, so the command is not re-run
  assert.deepEqual([c.pass, c.flaky, Boolean(c.flaky_passed), c.retry_skipped], [false, false, false, 'no_test_names'], JSON.stringify(c));
  assert.equal(r.pass, false);
});

test("F65 AC-3: another feature's id prefix ('F90 …', 'F9x') is not the feature's own test", async () => {
  const dir = fixture();
  const r = await run(dir, { verify: { commands: [planCmd('fpp', 'F90 AC-1 x|F9x y')] } });
  assert.equal(r.commands[0].pass, true, JSON.stringify(r.commands[0]));
  assert.equal(r.commands[0].flaky_passed, true);
});

// ---------- AC-4 ----------
test("F65 AC-4: verify.flaky 'fail' keeps a flaky command failed without a third run", async () => {
  const dir = fixture();
  const r = await run(dir, { verify: { commands: [planCmd('fpp', 'other test')], flaky: 'fail' } });
  const c = r.commands[0];
  assert.deepEqual([c.pass, c.attempts, c.flaky, Boolean(c.flaky_passed)], [false, 2, true, false], JSON.stringify(c));
  assert.equal(attemptsRun(dir), 2);
  assert.deepEqual(c.flaky_tests, ['other test']);
  assert.equal(r.pass, false);
});

test("F65 AC-4: a verify.flaky value other than 'retry' or 'fail' is config_invalid naming verify.flaky (exit 2)", () => {
  for (const bad of ['maybe', true, 3, null, '']) {
    assert.throws(() => cfg({ verify: { flaky: bad } }), (e) => e instanceof HarnessError && e.code === 'config_invalid' && e.exit === 2 && /verify\.flaky/.test(e.message), String(bad));
  }
  for (const good of ['retry', 'fail']) assert.equal(cfg({ verify: { flaky: good } }).verify.flaky, good);
  const dir = fixture();
  writeFiles(dir, { '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [], flaky: 'sometimes' } } });
  const r = harness(['verify', 'F9'], { cwd: dir });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /verify\.flaky/);
});

// ---------- AC-5 ----------
test('F65 AC-5: a command passed on retry is recorded with attempts 3 and data.flaky_passed true', async () => {
  const dir = fixture();
  await run(dir, { verify: { commands: [planCmd('fpp', 'other test', 'a.state'), planCmd('fpf', 'other test', 'b.state')] } });
  const cmds = commandEvents(dir);
  assert.equal(cmds.length, 2);
  assert.deepEqual([cmds[0].data.pass, cmds[0].data.attempts, cmds[0].data.flaky, cmds[0].data.flaky_passed], [true, 3, true, true]);
  assert.deepEqual([cmds[1].data.pass, cmds[1].data.attempts, cmds[1].data.flaky, Boolean(cmds[1].data.flaky_passed)], [false, 3, true, false]);
});

function runFixture(items = []) {
  const c = contract('F1');
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': c,
  }, { branch: null });
}

const PASS = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const flakyPass = (names) => ({
  ...PASS, flaky_tests: names,
  commands: [{ cmd: 'npm test', code: 0, pass: true, flaky: true, flaky_passed: true, attempts: 3, flaky_tests: names }],
});
// A flaky command that failed (the feature's own test): reported, never backlogged.
const flakyFail = (names) => ({ ...PASS, flaky_tests: names, commands: [{ cmd: 'npm run lint', code: 0, pass: true, flaky: true, attempts: 2, flaky_tests: names }] });

async function runOnce(dir, verifies) {
  let n = 0;
  return runFeatures({
    root: dir,
    config: resolveConfig({ base_branch: 'main', run: { max_parallel: 1 }, verify: { commands: [] }, budget: { step_timeout_sec: 60 } }),
    deps: {
      build: async (a) => { writeFiles(a.cwd, { 'F1.txt': 'x\n' }); return { ok: true, costUsd: 0 }; },
      verify: async () => verifies[n++] ?? PASS,
      evaluate: async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null }),
    },
  });
}
const backlog = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.harness/backlog.json'), 'utf8')).items;

test('F65 AC-5: harness run adds one low-priority flaky_test backlog item per test passed on retry', async () => {
  const dir = runFixture();
  await runOnce(dir, [{ ...flakyPass(['t one', 't two']), commands: [...flakyPass(['t one', 't two']).commands, ...flakyFail(['F1 AC-1 x']).commands] }]);
  const items = backlog(dir).filter((i) => i.reason === 'flaky_test');
  assert.deepEqual(items.map((i) => [i.test, i.priority, i.feature, i.seen]), [['t one', 'low', 'F1', 1], ['t two', 'low', 'F1', 1]], JSON.stringify(backlog(dir)));
  for (const i of items) assert.match(i.id, /^B\d+$/);
});

test('F65 AC-5: a test that already has an open flaky_test item bumps its seen instead of adding another', async () => {
  const dir = runFixture([
    { id: 'B1', reason: 'flaky_test', priority: 'low', test: 't one', feature: 'F0', seen: 2, sources: ['F0-r1'] },
    { id: 'B2', reason: 'flaky_test', priority: 'low', test: 't two', feature: 'F0', seen: 1, resolved_by: 'F0' },
  ]);
  // verify, then post-merge verify: both report the same flaky pass
  await runOnce(dir, [flakyPass(['t one', 't two']), flakyPass(['t one'])]);
  const items = backlog(dir).filter((i) => i.reason === 'flaky_test');
  const one = items.filter((i) => i.test === 't one');
  assert.equal(one.length, 1, JSON.stringify(items));
  assert.equal(one[0].seen, 4);
  assert.ok(one[0].sources.includes('F1-r1'));
  // the resolved item is not reopened; a new item is added
  const two = items.filter((i) => i.test === 't two');
  assert.deepEqual(two.map((i) => [i.id, i.seen, i.resolved_by ?? null]), [['B2', 1, 'F0'], ['B3', 1, null]]);
});

// ---------- AC-6 ----------
test('F65 AC-6: SPEC §6.1 and README describe verify.flaky, the third run and the own-test exception', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs/SPEC.md'), 'utf8');
  const start = spec.indexOf('### 6.1');
  assert.ok(start !== -1);
  const next = spec.indexOf('\n### ', start + 1);
  const s61 = spec.slice(start, next === -1 ? undefined : next);
  for (const re of [/verify\.flaky/, /'retry'/, /'fail'/, /3차/, /flaky: passed on retry/, /flaky_passed/, /flaky_test/, /<기능 id> /, /config_invalid/]) {
    assert.match(s61, re, `SPEC §6.1 lacks ${re}`);
  }
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  for (const re of [/verify\.flaky/, /3차/, /기능 자신의 테스트/]) assert.match(readme, re, `README lacks ${re}`);
});

// ---------- ES-1 ----------
test('F65 ES-1: a third run that hits the step time limit fails the command and records timed_out', async () => {
  const dir = fixture();
  const r = await run(dir, { verify: { commands: [planCmd('fph', 'other test')] }, budget: { step_timeout_sec: 8 } });
  const c = r.commands[0];
  assert.deepEqual([c.pass, c.attempts, c.timedOut], [false, 3, true], JSON.stringify(c));
  assert.match(c.message, /timed out/);
  assert.equal(r.pass, false);
  const ev = commandEvents(dir);
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].data.pass, ev[0].data.attempts, ev[0].data.timed_out], [false, 3, true]);
  git(dir, 'status', '--short'); // the killed run left the worktree usable
});
