import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, harness } from './helpers.mjs';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig, DEFAULTS } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { readEvents } from '../lib/events.mjs';
import { TEST_COUNT_CACHE } from '../lib/testcount.mjs';
import { verify, affectedTestFiles } from '../lib/verify.mjs';
import * as run from '../lib/run.mjs';
import { runSucceeded } from '../lib/commands/run.mjs';

// ------------------------------------------------------------------ fixtures

const TESTS = 'test/**/*.test.*';
const imp = (spec, name = 'x') => `import { ${name} } from '${spec}';\n`;
const testFile = (spec, n = 1) => `import test from 'node:test';\n${imp(spec)}${Array.from({ length: n }, (_, i) => `test('t${i}', () => {});\n`).join('')}`;

// Counts `test(` lines in the files it is given ('--all': every test file) and prints them as a
// node --test summary. With a MARK file in cwd it leaves ran.marker, to show it ran at all.
const SCRIPTS = {
  'scripts/ok.mjs': 'process.exit(0);\n',
  'scripts/runtests.mjs': [
    "import fs from 'node:fs';",
    'const args = process.argv.slice(2);',
    "const files = args.includes('--all') ? fs.readdirSync('test').filter((f) => f.endsWith('.test.mjs')).map((f) => `test/${f}`) : args;",
    'let n = 0;',
    "for (const f of files) n += (fs.readFileSync(f, 'utf8').match(/^test\\(/gm) || []).length;",
    "if (fs.existsSync('MARK')) fs.writeFileSync('ran.marker', files.join(' '));",
    'console.log(`# tests ${n}`);',
    "process.exit(args.includes('--all') && fs.existsSync('FAIL_ALL') ? 1 : 0);",
    '',
  ].join('\n'),
};

const BASE_FILES = {
  'lib/a.mjs': 'export const a = 1;\n',
  'lib/b.mjs': "import { a } from './a.mjs';\nexport const b = a + 1;\n",
  'lib/c.mjs': 'export const c = 3;\n',
  'test/a.test.mjs': testFile('../lib/a.mjs', 2),
  'test/b.test.mjs': testFile('../lib/b.mjs', 1),
  'test/c.test.mjs': testFile('../lib/c.mjs', 1),
  'README.md': 'docs\n',
  ...SCRIPTS,
};

const VERIFY = {
  commands: ['node scripts/runtests.mjs --all', 'node scripts/ok.mjs'],
  test_count: 'from:commands[0]',
  affected_command: 'node scripts/runtests.mjs {files}',
  test_paths: [TESTS],
  cache: 'off',
};

const contract = (id = 'F9') => {
  const c = {
    id, title: 'fixture', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-11T00:00:00.000Z', hash: hashContract(c) };
  return c;
};

const cfg = (verifyOver = {}) => resolveConfig({
  base_branch: 'main', verify: { ...VERIFY, ...verifyOver }, budget: { step_timeout_sec: 60 },
});

// `main` holds the project; HEAD is `feature` with the working tree the test then edits.
function fixture(files = {}, verifyOver = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { ...VERIFY, ...verifyOver } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': contract('F9'),
    ...BASE_FILES,
    ...files,
  });
}

const runVerify = (dir, over = {}, extra = {}) => verify({ root: dir, featureId: 'F9', base: 'main', config: cfg(over), ...extra });
const commandEvents = (dir) => readEvents(dir).events.filter((e) => e.stage === 'verify' && e.type === 'command');

// ------------------------------------------------------------------ AC-1, ES-1

test('F114 AC-1 verify.affected_command defaults to null and passes through resolveConfig', () => {
  assert.equal(DEFAULTS.verify.affected_command, null);
  assert.equal(resolveConfig({}).verify.affected_command, null);
  const c = resolveConfig({ verify: { commands: ['x'], test_count: 'from:commands[0]', affected_command: 'x {files}' } });
  assert.equal(c.verify.affected_command, 'x {files}');
});

test('F114 ES-1 affected_command without {files}, not a string, or without test_count from:commands[i] is config_invalid', () => {
  const ok = { commands: ['x'], test_count: 'from:commands[0]', affected_command: 'x {files}' };
  const bad = [
    { ...ok, affected_command: 'x' },
    { ...ok, affected_command: 42 },
    { ...ok, affected_command: ['x {files}'] },
    { ...ok, test_count: undefined },
    { ...ok, test_count: 'preset:node-test' },
    { ...ok, test_count: 'echo 1' },
  ];
  for (const v of bad) {
    assert.throws(() => resolveConfig({ verify: v }), (e) => e.code === 'config_invalid' && e.exit === 2 && e.message.includes('verify.affected_command'), JSON.stringify(v));
  }
});

// ------------------------------------------------------------------ AC-2, ES-2

test('F114 AC-2 affectedTestFiles: tests that import a changed file directly or through another file', () => {
  const dir = fixture();
  const mergeBase = git(dir, 'rev-parse', 'main');
  const got = affectedTestFiles({ top: dir, mergeBase, changed: ['lib/a.mjs'], untracked: [], testPaths: [TESTS] });
  assert.deepEqual(got, ['test/a.test.mjs', 'test/b.test.mjs']);
});

test('F114 AC-2 affectedTestFiles: changed and added test files are included, sorted, without duplicates', () => {
  const dir = fixture();
  writeFiles(dir, { 'test/new.test.mjs': testFile('../lib/c.mjs'), 'test/a.test.mjs': testFile('../lib/a.mjs', 3) });
  const got = affectedTestFiles({ top: dir, mergeBase: git(dir, 'rev-parse', 'main'), changed: ['test/a.test.mjs', 'lib/c.mjs'], untracked: ['test/new.test.mjs'], testPaths: [TESTS] });
  assert.deepEqual(got, ['test/a.test.mjs', 'test/c.test.mjs', 'test/new.test.mjs']);
});

test('F114 AC-2 affectedTestFiles: a deleted test file is not affected', () => {
  const dir = fixture();
  fs.rmSync(path.join(dir, 'test/c.test.mjs'));
  const got = affectedTestFiles({ top: dir, mergeBase: git(dir, 'rev-parse', 'main'), changed: ['test/c.test.mjs'], untracked: [], testPaths: [TESTS] });
  assert.deepEqual(got, []);
});

test('F114 AC-2 affectedTestFiles follows export-from, side-effect import, require and dynamic import', () => {
  const dir = fixture({
    'lib/e.mjs': "export * from './a.mjs';\n",
    'test/e.test.mjs': "import '../lib/e.mjs';\n",
    'lib/a.cjs': 'module.exports = 1;\n',
    'lib/r.cjs': "module.exports = require('./a.cjs');\n",
    'test/r.test.cjs': 'const r = require("../lib/r.cjs");\n',
    'lib/dyn.mjs': 'export const d = 1;\n',
    'test/dyn.test.mjs': "const m = await import(\"../lib/dyn.mjs\");\n",
    'lib/multi.mjs': 'export const m1 = 1;\nexport const m2 = 2;\n',
    'test/multi.test.mjs': "import {\n  m1,\n  m2,\n} from '../lib/multi.mjs';\n",
  });
  const at = (f) => affectedTestFiles({ top: dir, mergeBase: git(dir, 'rev-parse', 'main'), changed: [f], untracked: [], testPaths: [TESTS] });
  assert.deepEqual(at('lib/a.mjs'), ['test/a.test.mjs', 'test/b.test.mjs', 'test/e.test.mjs']);
  assert.deepEqual(at('lib/a.cjs'), ['test/r.test.cjs']);
  assert.deepEqual(at('lib/dyn.mjs'), ['test/dyn.test.mjs']);
  assert.deepEqual(at('lib/multi.mjs'), ['test/multi.test.mjs']);
});

test('F114 ES-2 a cycle ends; unreadable files and unresolvable specifiers are skipped', () => {
  const dir = fixture({
    'lib/x.mjs': "import { y } from './y.mjs';\nexport const x = 1;\n",
    'lib/y.mjs': "import { x } from './x.mjs';\nexport const y = 1;\n",
    'test/x.test.mjs': "import { y } from '../lib/y.mjs';\nimport fs from 'node:fs';\nimport pkg from 'pkg';\nimport h from 'http://example.invalid/m.mjs';\nimport z from './missing.mjs';\nimport w from '../../outside.mjs';\n",
  });
  const mergeBase = git(dir, 'rev-parse', 'main');
  const got = affectedTestFiles({ top: dir, mergeBase, changed: ['lib/x.mjs', 'lib/gone.mjs', 'pkg', 'node:fs'], untracked: ['nothing/here.mjs'], testPaths: [TESTS] });
  assert.deepEqual(got, ['test/x.test.mjs']);
});

// ------------------------------------------------------------------ AC-3, SC-1

test('F114 AC-3 verify runs affected_command on the affected files in place of the test_count command', async () => {
  const dir = fixture();
  writeFiles(dir, { 'lib/a.mjs': 'export const a = 2;\n' });
  const r = await runVerify(dir);
  assert.equal(r.pass, true, JSON.stringify(r, null, 1));
  assert.equal(r.commands.length, 2);
  assert.equal(r.commands[0].cmd, 'node scripts/runtests.mjs "test/a.test.mjs" "test/b.test.mjs"');
  assert.equal(r.commands[0].scope, 'affected');
  assert.equal(r.commands[0].files, 2);
  assert.equal(r.commands[1].cmd, 'node scripts/ok.mjs');
  assert.equal(r.commands[1].scope, undefined);
  const ev = commandEvents(dir);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].data.scope, 'affected');
  assert.equal(ev[0].data.files, 2);
  assert.equal(ev[1].data.scope, undefined);
});

test('F114 AC-3 no affected files: the command does not run, passes and says skipped', async () => {
  const dir = fixture({ MARK: '1\n' });
  writeFiles(dir, { 'README.md': 'changed\n' });
  const r = await runVerify(dir);
  assert.equal(r.pass, true, JSON.stringify(r, null, 1));
  assert.equal(r.commands[0].pass, true);
  assert.equal(r.commands[0].skipped, 'no affected tests');
  assert.equal(r.commands[0].scope, 'affected');
  assert.equal(r.commands[0].files, 0);
  assert.equal(fs.existsSync(path.join(dir, 'ran.marker')), false);
  assert.equal(r.commands[1].pass, true);
  assert.equal(commandEvents(dir)[0].data.files, 0);
});

test('F114 SC-1 an affected path with a shell-significant character is never run and is named', async () => {
  for (const name of ['test/a b.test.mjs', 'test/a;b.test.mjs', 'test/a$b.test.mjs', 'test/a`b.test.mjs']) {
    const dir = fixture({ MARK: '1\n' });
    writeFiles(dir, { [name]: testFile('../lib/a.mjs') });
    const r = await runVerify(dir);
    assert.equal(r.pass, false, name);
    assert.equal(r.commands[0].pass, false, name);
    assert.ok(r.commands[0].message.includes(name), `${name}: ${r.commands[0].message}`);
    assert.equal(fs.existsSync(path.join(dir, 'ran.marker')), false, `${name}: the command ran`);
    assert.equal(r.commands[0].attempts, 0);
  }
});

// ------------------------------------------------------------------ AC-4, SC-2

test('F114 AC-4 test count: head from the affected run, base from the same command on the affected files base has', async () => {
  const dir = fixture();
  writeFiles(dir, { 'lib/a.mjs': 'export const a = 2;\n', 'test/new.test.mjs': testFile('../lib/a.mjs', 5) });
  const r = await runVerify(dir);
  assert.equal(r.pass, true, JSON.stringify(r.integrity, null, 1));
  const tc = r.integrity.testCount;
  // base: a (2) + b (1); head: a (2) + b (1) + new (5)
  assert.deepEqual({ base: tc.base, head: tc.head, status: tc.status }, { base: 3, head: 8, status: 'ok' });
  assert.deepEqual(tc.source, { head: 'parsed', base: 'ran' });
  assert.equal(fs.existsSync(path.join(dir, '.harness', 'runs', TEST_COUNT_CACHE)), false, 'the count cache is not written');
});

test('F114 AC-4 fewer tests than base on the affected files fails verify as decreased', async () => {
  const dir = fixture();
  writeFiles(dir, { 'test/a.test.mjs': testFile('../lib/a.mjs', 1) });
  const r = await runVerify(dir);
  assert.equal(r.integrity.testCount.status, 'decreased');
  // only the changed test file is affected: base had 2 tests in it, head has 1
  assert.equal(r.integrity.testCount.head, 1);
  assert.equal(r.integrity.testCount.base, 2);
  assert.equal(r.pass, false);
  assert.equal(fs.existsSync(path.join(dir, '.harness', 'runs', TEST_COUNT_CACHE)), false);
});

test('F114 AC-4 the count cache is not read: a stored base count is ignored', async () => {
  const dir = fixture();
  writeFiles(dir, { 'lib/a.mjs': 'export const a = 2;\n' });
  const first = await runVerify(dir);
  assert.equal(first.integrity.testCount.base, 3);
  const cacheDir = path.join(dir, '.harness', 'runs');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, TEST_COUNT_CACHE), '{"entries":[{"base":"x","count":99}]}\n');
  const second = await runVerify(dir);
  assert.equal(second.integrity.testCount.base, 3);
  assert.equal(second.integrity.testCount.source.base, 'ran');
});

test('F114 SC-2 affected mode still fails on an added skip marker', async () => {
  const dir = fixture();
  writeFiles(dir, { 'test/a.test.mjs': `${testFile('../lib/a.mjs', 2)}test.sk${'ip'}('later', () => {});\n` });
  const r = await runVerify(dir);
  assert.equal(r.pass, false);
  assert.ok(r.integrity.markers.length > 0);
});

// ------------------------------------------------------------------ AC-7

test('F114 AC-7 --full runs verify.commands unsubstituted with scope full', async () => {
  const dir = fixture();
  writeFiles(dir, { 'lib/a.mjs': 'export const a = 2;\n' });
  const r = await runVerify(dir, {}, { full: true });
  assert.equal(r.commands[0].cmd, 'node scripts/runtests.mjs --all');
  assert.equal(r.commands[0].scope, 'full');
  assert.equal(r.commands[0].files, undefined);
  assert.equal(r.integrity.testCount.source.head, 'parsed');
});

test('F114 AC-7 harness verify prints the affected scope line, --full does not, --json carries scope', () => {
  const dir = fixture();
  writeFiles(dir, { 'lib/a.mjs': 'export const a = 2;\n' });
  const plain = harness(['verify', 'F9', '--base', 'main'], { cwd: dir });
  assert.equal(plain.code, 0, plain.stdout + plain.stderr);
  assert.ok(plain.stdout.split('\n').includes('scope: affected (2 files)'), plain.stdout);
  const full = harness(['verify', 'F9', '--base', 'main', '--full', '--json'], { cwd: dir });
  assert.equal(full.code, 0, full.stdout + full.stderr);
  assert.equal(JSON.parse(full.stdout).commands[0].scope, 'full');
  const fullText = harness(['verify', 'F9', '--base', 'main', '--full'], { cwd: dir });
  assert.equal(fullText.stdout.includes('scope: affected'), false);
  const asJson = harness(['verify', 'F9', '--base', 'main', '--json'], { cwd: dir });
  assert.equal(JSON.parse(asJson.stdout).commands[0].scope, 'affected');
});

// ------------------------------------------------------------------ runs: AC-5, AC-6, ES-3

const intWt = (dir) => path.join(dir, '.harness', 'wt', '_integration');
const readText = (f) => fs.readFileSync(f, 'utf8');

function runFixture(verifyOver = {}, files = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract('F1'),
    ...BASE_FILES,
    ...files,
  }, { branch: null });
}

const runCfg = (verifyOver = {}) => resolveConfig({
  base_branch: 'main', run: { max_parallel: 1 }, verify: { ...VERIFY, ...verifyOver }, budget: { step_timeout_sec: 60 },
});

const evaluatePass = async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });

// The builder changes lib/a.mjs; with `land`, a commit meanwhile lands on integration so the
// feature is verified against the moved integration before it merges.
function builder({ dir, land = false } = {}) {
  return async (a) => {
    if (land) {
      writeFiles(intWt(dir), { 'docs/meanwhile.txt': 'x\n' });
      commitAll(intWt(dir), 'meanwhile on integration');
    }
    writeFiles(a.cwd, { 'lib/a.mjs': 'export const a = 2;\n', 'F1.txt': 'built\n' });
    return { ok: true, costUsd: 0 };
  };
}

const runF = (dir, config, build) => run.runFeatures({ root: dir, config, deps: { build, evaluate: evaluatePass, cpus: 8, log: () => {}, warn: () => {} } });
const stepsOf = (dir, index = 0) => readEvents(dir).events
  .filter((e) => e.stage === 'verify' && e.type === 'command' && e.data.index === index)
  .map((e) => [e.data.step, e.data.scope]);
const metricSteps = (dir) => fs.readdirSync(path.join(dir, '.harness', 'runs')).filter((f) => f.endsWith('.metrics.jsonl'))
  .flatMap((f) => readText(path.join(dir, '.harness', 'runs', f)).trim().split('\n').map((l) => JSON.parse(l).step));

test('F114 AC-5 pre-merge and post-merge verify of a run use the affected files', { timeout: 240000 }, async () => {
  const dir = runFixture();
  const r = await runF(dir, runCfg(), builder({ dir, land: true }));
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results[0]));
  const steps = stepsOf(dir);
  for (const step of ['verify', 'pre_merge_verify', 'post_merge_verify']) {
    assert.ok(steps.some(([s, scope]) => s === step && scope === 'affected'), `${step}: ${JSON.stringify(steps)}`);
  }
});

test('F114 AC-6 an affected-mode run ends with one final verify of the whole commands', { timeout: 240000 }, async () => {
  const dir = runFixture();
  const r = await runF(dir, runCfg(), builder({ dir }));
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results[0]));
  assert.deepEqual(r.finalVerify && r.finalVerify.pass, true);
  const finals = readEvents(dir).events.filter((e) => e.stage === 'verify' && e.type === 'command' && e.data.step === 'final_verify');
  assert.equal(finals.length, 2, 'both verify.commands ran, once');
  assert.deepEqual(finals.map((e) => e.data.scope), ['full', 'full']);
  assert.equal(metricSteps(dir).filter((s) => s === 'final_verify').length, 1);
  const report = readText(r.report);
  assert.match(report, /\n## Final verify\n\npass\n/);
  assert.equal(report.includes('final verify failed'), false);
});

test('F114 AC-6 no final verify without a merged feature, or without affected mode', { timeout: 240000 }, async () => {
  const none = runFixture();
  const failVerdict = async (a) => ({ ...(await evaluatePass(a)), verdict: 'fail', score: 3, blocking: [{ criterion_id: 'AC-1', summary: 'broken' }] });
  const r1 = await run.runFeatures({ root: none, config: runCfg(), deps: { build: builder({ dir: none }), evaluate: failVerdict, cpus: 8, log: () => {}, warn: () => {} } });
  assert.notEqual(r1.results[0].status, 'passed');
  assert.equal(readText(r1.report).includes('## Final verify'), false);
  assert.equal(metricSteps(none).includes('final_verify'), false);

  const plain = runFixture();
  const r2 = await runF(plain, runCfg({ affected_command: null }), builder({ dir: plain }));
  assert.equal(r2.results[0].status, 'passed', JSON.stringify(r2.results[0]));
  assert.equal(readText(r2.report).includes('## Final verify'), false);
  assert.equal(readEvents(plain).events.some((e) => e.data?.step === 'final_verify'), false);
  assert.equal(r2.finalVerify, null);
});

test('F114 ES-3 a failing final verify exits 1 and reports it, leaving statuses and integration alone', { timeout: 240000 }, async () => {
  const dir = runFixture({}, { FAIL_ALL: '1\n' });
  const r = await runF(dir, runCfg(), builder({ dir }));
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results[0]));
  assert.equal(r.finalVerify.pass, false);
  assert.equal(runSucceeded(r), false);
  const report = readText(r.report);
  const needs = report.slice(report.indexOf('## Needs you'), report.indexOf('## Features'));
  assert.ok(needs.includes('final verify failed on harness/integration'), needs);
  const section = report.slice(report.indexOf('## Final verify'));
  assert.ok(section.includes('node scripts/runtests.mjs --all'), section);
  assert.ok(section.includes('exit 1'), section);
  const status = JSON.parse(readText(path.join(dir, '.harness', 'features.json'))).features[0].status;
  assert.equal(status, 'passed');
  assert.match(git(dir, 'log', '-1', '--format=%s', 'harness/integration'), /^harness: merge F1/);
});

test('F114 ES-3 runSucceeded: a passing final verify or none does not change the exit code', () => {
  const base = { stopped: null, results: [{ status: 'passed' }] };
  assert.equal(runSucceeded({ ...base, finalVerify: { pass: true } }), true);
  assert.equal(runSucceeded({ ...base, finalVerify: null }), true);
  assert.equal(runSucceeded({ ...base, finalVerify: { pass: false } }), false);
  assert.equal(runSucceeded({ ...base, results: [{ status: 'blocked' }] }), false);
});

// ------------------------------------------------------------------ AC-9

test('F114 AC-9 SPEC §6.1 and §8 describe affected_command and final_verify', () => {
  const spec = readText(path.join(REPO, 'docs', 'SPEC.md'));
  const section = (from, to) => spec.slice(spec.indexOf(from), spec.indexOf(to));
  const s61 = section('### 6.1', '### 6.2');
  for (const word of ['verify.affected_command', '{files}', 'from:commands[i]', 'affectedTestFiles', '[A-Za-z0-9_./-]', 'no affected tests', 'decreased', '--full', 'scope: affected']) {
    assert.ok(s61.includes(word), `§6.1 lacks ${word}`);
  }
  const s8 = section('## 8.', '## 9.');
  for (const word of ['final_verify', '## Final verify', 'final verify failed on', '300']) {
    assert.ok(s8.includes(word), `§8 lacks ${word}`);
  }
});
