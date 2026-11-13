import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, REPO, realTmpdir } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { verify } from '../lib/verify.mjs';
import { runFeatures } from '../lib/run.mjs';
import { failedTestNames, failedTestExcerpts, redactor } from '../lib/failures.mjs';
import { recordFlakyTests } from '../lib/backlog.mjs';

const TAP = [
  'TAP version 13',
  '# Subtest: boom one',
  'not ok 1 - boom one',
  '  ---',
  '  duration_ms: 3.8',
  "  type: 'test'",
  "  location: '/tmp/x/a.test.mjs:2:1'",
  '  error: |-',
  '    Expected values to be strictly equal:',
  '    ',
  '    2 !== 3',
  '  stack: |-',
  '    Test.runInAsyncScope (node:async_hooks:214:14)',
  '    Test.run (node:internal/test_runner/test:1047:25)',
  '  ...',
  '# Subtest: fine',
  'ok 2 - fine',
  '1..2',
].join('\n');

const SPEC = [
  '✖ boom (1.2ms)',
  '✖ hollow (0.5ms)',
  'ℹ tests 2',
  '',
  '✖ failing tests:',
  '',
  'test at a.test.mjs:2:1',
  '✖ boom (1.2ms)',
  '  AssertionError: nope',
  '',
  '    at Test.run (node:x:1:1)',
  '',
  'test at a.test.mjs:3:1',
  '✖ hollow (0.5ms)',
  '',
].join('\n');

test('F177 AC-1: failedTestExcerpts gives the failure block of a TAP failure without its noise and stack', () => {
  const ex = failedTestExcerpts(TAP);
  assert.deepEqual(ex.map((x) => x.test), failedTestNames(TAP));
  assert.equal(ex.length, 1);
  assert.match(ex[0].excerpt, /location: '\/tmp\/x\/a\.test\.mjs:2:1'/);
  assert.match(ex[0].excerpt, /2 !== 3/);
  assert.doesNotMatch(ex[0].excerpt, /runInAsyncScope|duration_ms|type:|stack:|---|\.\.\./);
  assert.match(ex[0].excerpt, /^location:/); // common indentation removed
  // ANSI is removed
  assert.doesNotMatch(failedTestExcerpts(TAP.replace('2 !== 3', '\x1b[31m2 !== 3\x1b[0m'))[0].excerpt, /\x1b/);
});

test('F177 AC-2: spec reporter output gives one entry per test from the first block with content', () => {
  const ex = failedTestExcerpts(SPEC);
  assert.deepEqual(failedTestNames(SPEC), ['boom', 'hollow']);
  assert.deepEqual(ex.map((x) => x.test), ['boom']); // hollow has no block
  assert.match(ex[0].excerpt, /^AssertionError: nope/);
});

test('F177 AC-2: an excerpt has at most 12 lines and 600 characters and a cut ends in an ellipsis', () => {
  const many = ['not ok 1 - t', ...Array.from({ length: 30 }, (_, i) => `  line ${i}`)].join('\n');
  const a = failedTestExcerpts(many)[0].excerpt;
  assert.equal(a.split('\n').length, 12);
  assert.ok(a.endsWith('…'));
  const wide = `not ok 1 - t\n  ${'x'.repeat(2000)}`;
  const b = failedTestExcerpts(wide)[0].excerpt;
  assert.ok(b.length <= 600 && b.endsWith('…'), String(b.length));
  const short = failedTestExcerpts('not ok 1 - t\n  fine')[0].excerpt;
  assert.equal(short, 'fine'); // contrast: no cut, no ellipsis
});

// ---- verify() ----
const contract = () => {
  const c = {
    id: 'F9', title: 'fixture', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'check exists', check: 'node check.mjs', new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-28T00:00:00.000Z', hash: hashContract(c) };
  return c;
};
// plan: first char of each run's outcome ('p' pass, 'f' fail). Failing runs print `mode` output.
const SCRIPT = [
  "import fs from 'node:fs';",
  'const [plan, mode, state] = process.argv.slice(2);',
  "const n = fs.existsSync(state) ? Number(fs.readFileSync(state, 'utf8')) : 0;",
  'fs.writeFileSync(state, String(n + 1));',
  "if ((plan[n] ?? 'p') === 'p') process.exit(0);",
  "if (mode === 'named') console.log(`\\u2716 flaky one (1ms)\\n  AssertionError: expected hunter2-hunter2-value got 2\\n  at x`);",
  "if (mode === 'bare') console.log('something broke');",
  'process.exit(1);',
  '',
].join('\n');
function fixture() {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': contract(),
    'scripts/plan.mjs': SCRIPT, '.gitignore': '*.state\n',
  });
  writeFiles(dir, { 'check.mjs': 'process.exit(0);\n' });
  return dir;
}
const cfg = (cmds) => resolveConfig({ base_branch: 'main', verify: { commands: cmds }, budget: { step_timeout_sec: 60 } });
const cmd = (plan, mode, state = 'a.state') => `node scripts/plan.mjs ${plan} ${mode} ${state}`;

test('F177 AC-3: a command whose first run failed has failure_excerpts, flaky-passed or failing, and the CLI shows them', async () => {
  const dir = fixture();
  const r = await verify({ root: dir, featureId: 'F9', base: 'main', config: cfg([cmd('fpp', 'named'), cmd('ffff', 'named', 'b.state')]) });
  const [flakyPassed, failing] = r.commands;
  assert.equal(flakyPassed.flaky_passed, true);
  for (const c of [flakyPassed, failing]) {
    assert.deepEqual(c.failure_excerpts.map((x) => x.test), ['flaky one']);
    assert.match(c.failure_excerpts[0].excerpt, /AssertionError/);
  }
  fs.rmSync(path.join(dir, 'a.state')); fs.rmSync(path.join(dir, 'b.state'));
  writeFiles(dir, { '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [cmd('ffff', 'named', 'c.state')] } } });
  const out = harness(['verify', 'F9'], { cwd: dir });
  assert.match(out.stdout, /^ {7}flaky one\n {9}AssertionError/m, out.stdout);
  const json = JSON.parse(harness(['verify', 'F9', '--json'], { cwd: dir }).stdout);
  assert.deepEqual(json.commands[0].failure_excerpts.map((x) => x.test), ['flaky one']);
});

test('F177 ES-1: a secret in the failed test output is redacted in failure_excerpts and the other text stays', async () => {
  const dir = fixture();
  const r = await verify({ root: dir, featureId: 'F9', base: 'main', config: cfg([cmd('fpp', 'named')]), redact: redactor({ SECRET_TOKEN_X: 'hunter2-hunter2-value' }) });
  const ex = r.commands[0].failure_excerpts[0].excerpt;
  assert.doesNotMatch(JSON.stringify(r.commands[0].failure_excerpts), /hunter2-hunter2-value/);
  assert.match(ex, /AssertionError: expected \[redacted\] got 2/);
});

test('F177 ES-2: output without test names gives no failure_excerpts key, while a named one does', async () => {
  const dir = fixture();
  const r = await verify({ root: dir, featureId: 'F9', base: 'main', config: cfg([cmd('ff', 'bare'), cmd('ff', 'named', 'b.state')]) });
  assert.equal('failure_excerpts' in r.commands[0], false);
  assert.equal(r.commands[1].failure_excerpts.length, 1);
});

// ---- backlog ----
test('F177 AC-4: recordFlakyTests puts the excerpt on a new item and replaces it on an open one', () => {
  const dir = realTmpdir('f177-');
  try {
    const file = path.join(dir, 'backlog.json');
    fs.writeFileSync(file, JSON.stringify({ items: [] }));
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8')).items;
    recordFlakyTests(file, ['a', 'b'], { feature: 'F1', round: 1, at: 'now', excerpts: { a: 'first' } });
    assert.equal(read()[0].excerpt, 'first');
    assert.equal('excerpt' in read()[1], false); // contrast: no excerpt for b
    recordFlakyTests(file, ['a'], { feature: 'F2', round: 1, at: 'now', excerpts: { a: 'second' } });
    const [a] = read();
    assert.deepEqual([a.excerpt, a.seen, a.sources], ['second', 2, ['F1-r1', 'F2-r1']]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- run ----
function runFixture() {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': (() => { const c = contract(); c.id = 'F1'; c.approval.hash = hashContract({ ...c, approval: undefined }); return c; })(),
  }, { branch: null });
}
const PASS = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const FAIL = (cmds) => ({ ...PASS, pass: false, commands: cmds });
const failedCmd = (excerpt, extra = {}) => ({ cmd: 'npm test', code: 1, pass: false, flaky: false, attempts: 2, message: 'exit 1', output: 'out', failure_excerpts: [{ test: 'T one', excerpt }], ...extra });
async function runWith(dir, verifies, env = {}) {
  let n = 0;
  const res = await runFeatures({
    root: dir,
    config: resolveConfig({ base_branch: 'main', run: { max_parallel: 1 }, verify: { commands: [] }, budget: { step_timeout_sec: 60 } }),
    deps: {
      env,
      build: async (a) => { writeFiles(a.cwd, { 'F1.txt': 'x\n' }); return { ok: true, costUsd: 0 }; },
      verify: async () => verifies[n++] ?? PASS,
      evaluate: async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null }),
    },
  });
  const runs = path.join(dir, '.harness/runs');
  const md = fs.readdirSync(runs).filter((f) => f.endsWith('.md')).map((f) => fs.readFileSync(path.join(runs, f), 'utf8'))[0];
  return { res, md };
}

test('F177 AC-5: the run report shows flaky excerpts in fenced blocks and the result carries flaky_excerpts', async () => {
  const dir = runFixture();
  const flaky = { ...PASS, flaky_tests: ['T one'], commands: [{ cmd: 'npm test', code: 0, pass: true, flaky: true, flaky_passed: true, attempts: 3, flaky_tests: ['T one'], failure_excerpts: [{ test: 'T one', excerpt: 'bad ``` fence\nline 2' }] }] };
  const { res, md } = await runWith(dir, [flaky]);
  assert.deepEqual(res.results[0].flaky_excerpts, [{ test: 'T one', excerpt: 'bad ``` fence\nline 2' }]);
  assert.match(md, /- F1: `T one`\n {2}- `T one`:\n {4}```text\n {4}bad ''' fence\n {4}line 2\n {4}```\n/);
  const items = JSON.parse(fs.readFileSync(path.join(dir, '.harness/backlog.json'), 'utf8')).items;
  assert.equal(items.find((i) => i.reason === 'flaky_test').excerpt, 'bad ``` fence\nline 2');
});

test('F177 AC-6: every failed verify is listed under Verify failures; none, no section', async () => {
  const dir = runFixture();
  const { md } = await runWith(dir, [FAIL([failedCmd('boom line')]), PASS]);
  assert.match(md, /## Verify failures/);
  assert.match(md, /- F1 round 1 verify:\n {2}- `npm test` — exit 1: out\n {2}- `T one`:\n {4}```text\n {4}boom line\n {4}```/);
  const clean = await runWith(runFixture(), [PASS]);
  assert.doesNotMatch(clean.md, /Verify failures/);
});

test('F177 AC-6: the run state keeps at most 30 failures and survives --resume', async () => {
  const dir = runFixture();
  const { res } = await runWith(dir, [FAIL([failedCmd('x')]), PASS]);
  assert.ok(res);
  const src = fs.readFileSync(path.join(REPO, 'lib/run/state.mjs'), 'utf8');
  assert.match(src, /MAX_VERIFY_FAILURES = 30/);
  assert.match(src, /state\.verifyFailures \?\?= \[\]/);
});

test('F177 ES-1: a secret in an excerpt is redacted in the backlog and both report sections', async () => {
  const dir = runFixture();
  const secret = 'hunter2-hunter2-value';
  const ex = `expected ${secret} got 2`;
  const flaky = { ...PASS, flaky_tests: ['T one'], commands: [{ cmd: 'npm test', code: 0, pass: true, flaky: true, flaky_passed: true, attempts: 3, flaky_tests: ['T one'], failure_excerpts: [{ test: 'T one', excerpt: ex }] }] };
  const { md } = await runWith(dir, [FAIL([failedCmd(ex)]), flaky], { SECRET_TOKEN_X: secret });
  const backlogText = fs.readFileSync(path.join(dir, '.harness/backlog.json'), 'utf8');
  for (const t of [md, backlogText]) assert.doesNotMatch(t, new RegExp(secret));
  assert.match(md, /expected \[redacted\] got 2/);
});

test('F177 ES-2: a failed command without excerpts shows only its message under Verify failures', async () => {
  const dir = runFixture();
  const bare = { cmd: 'npm test', code: 1, pass: false, flaky: false, attempts: 1, message: 'exit 1', output: 'plain' };
  const { md } = await runWith(dir, [FAIL([bare]), PASS]);
  assert.match(md, /- F1 round 1 verify:\n {2}- `npm test` — exit 1: plain\n/);
  assert.doesNotMatch(md, /```text/);
});

test('F177 AC-7: SPEC §6.1 and §8 describe failure_excerpts, the excerpt rules and Verify failures', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs/SPEC.md'), 'utf8');
  for (const s of ['failure_excerpts', 'F177', '12줄', '600자', '## Verify failures', 'excerpt']) assert.ok(spec.includes(s), s);
});
