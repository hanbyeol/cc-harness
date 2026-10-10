import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpdir } from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';
import { resolveConfig, loadConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { verify } from '../lib/verify.mjs';
import { partialRetry, failedTestFiles, parseNodeTest, shellQuote } from '../lib/retryfiles.mjs';

// Test files that append a label to runs.log in the command's cwd each time they run. The
// flaky file fails its first run only (it counts its own earlier runs in the log).
const logger = (label, body) => [
  "import test from 'node:test';",
  "import fs from 'node:fs';",
  "const log = (s) => fs.appendFileSync('runs.log', s + '\\n');",
  `const label = ${JSON.stringify(label)};`,
  "const runs = () => fs.readFileSync('runs.log', 'utf8').split('\\n').filter((l) => l === label).length;",
  body,
  '',
].join('\n');
const STABLE = logger('a', "test('a first passes', () => { log(label); });\ntest('a second passes', () => {});");
const FLAKY = logger('b', "test('b flaky', () => { log(label); if (runs() === 1) throw new Error('first run fails'); });");
const OWN = logger('o', "test('F9 AC-1 own test', () => { log(label); if (runs() === 1) throw new Error('first run fails'); });");
const FLAKY_FILE = path.join('tests', 'sub dir', "it's b.test.mjs");

const contract = (id) => {
  const c = {
    id, title: 'fixture', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'check exists', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-09T00:00:00.000Z', hash: hashContract(c) };
  return c;
};

function fixture(tests = { 'tests/a.test.mjs': STABLE, [FLAKY_FILE]: FLAKY }) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', security_tier: 'standard', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': contract('F9'),
    'scripts/ok.mjs': 'process.exit(0);\n',
    // Not a `node --test` command: runs the same tests through a child process.
    'scripts/wrap.mjs': "import { spawnSync } from 'node:child_process';\n"
      + "const r = spawnSync(process.execPath, ['--test', 'tests/**/*.test.mjs'], { stdio: 'inherit' });\nprocess.exit(r.status ?? 1);\n",
    '.gitignore': 'runs.log\n',
    ...tests,
  });
}

const NODE_TEST = 'node --test "tests/**/*.test.mjs"';
const cfg = (verifyOver = {}) => resolveConfig({ base_branch: 'main', verify: { commands: [NODE_TEST], ...verifyOver }, budget: { step_timeout_sec: 120 } });
const run = (dir, verifyOver) => verify({ root: dir, featureId: 'F9', base: 'main', config: cfg(verifyOver) });
// One entry per test file run, in order: 'a' for the stable file, 'b' for the flaky one.
const runsLog = (dir) => fs.readFileSync(path.join(dir, 'runs.log'), 'utf8').split('\n').filter(Boolean);

const commandEvents = (dir) => {
  const d = path.join(dir, '.harness', 'events');
  let names = [];
  try { names = fs.readdirSync(d).sort(); } catch { return []; }
  return names.flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    .filter((e) => e.stage === 'verify' && e.type === 'command');
};

// A spec reporter output naming failed tests at the given locations.
const specOutput = (entries) => [
  '✖ x (1ms)', 'ℹ tests 3', 'ℹ fail 1', '', '✖ failing tests:', '',
  ...entries.flatMap(([at, name]) => [...(at === null ? [] : [`test at ${at}`]), `✖ ${name} (1.2ms)`, '  Error: boom', '']),
].join('\n');

// ---------- AC-1 ----------
test('F100 AC-1: the re-runs of a failed node --test command run only the file with the failed test', async () => {
  const dir = fixture();
  const r = await run(dir);
  const c = r.commands[0];
  assert.equal(c.pass, true, JSON.stringify(c));
  // First run: both files; second and third: only the flaky one.
  const log = runsLog(dir);
  assert.equal(log.filter((l) => l === 'a').length, 1, log.join(','));
  assert.equal(log.filter((l) => l === 'b').length, 3, log.join(','));
  assert.deepEqual(c.retry_files, [FLAKY_FILE]);
});

test('F100 AC-1: the re-run keeps the options before --test and the -- arguments after it, and drops the other arguments', () => {
  const cwd = fs.realpathSync.native(tmpdir('harness-f100-'));
  fs.mkdirSync(path.join(cwd, 'tests'));
  fs.writeFileSync(path.join(cwd, 'tests', 'x.test.mjs'), '');
  const out = specOutput([['tests/x.test.mjs:3:1', 'x fails']]);
  const p = partialRetry('node --no-warnings --test --test-reporter=spec "tests/**/*.test.mjs" --test-concurrency=1', out, cwd, { platform: 'linux' });
  assert.deepEqual(p, { cmd: `node --no-warnings --test --test-reporter=spec --test-concurrency=1 ${path.join('tests', 'x.test.mjs')}`, files: [path.join('tests', 'x.test.mjs')] });
  // An absolute location inside cwd and a file URL become paths relative to cwd, once each.
  const abs = path.join(cwd, 'tests', 'x.test.mjs');
  const twice = specOutput([[`${abs}:3:1`, 'one'], [`${new URL(`file://${abs.startsWith('/') ? '' : '/'}${abs.replace(/\\/g, '/')}`).href}:9:1`, 'two']]);
  assert.deepEqual(failedTestFiles(twice, cwd), { files: [path.join('tests', 'x.test.mjs')] });
});

// ---------- AC-2 ----------
test('F100 AC-2: a pass through the partial re-run is recorded like any re-run pass, with retry_files', async () => {
  const partialDir = fixture();
  const p = await run(partialDir);
  const wholeDir = fixture();
  const w = await run(wholeDir, { retry_scope: 'command' });
  const pick = (c) => [c.pass, c.attempts, c.flaky, c.flaky_passed, c.flaky_tests];
  assert.deepEqual(pick(p.commands[0]), [true, 3, true, true, ['b flaky']], JSON.stringify(p.commands[0]));
  assert.deepEqual(pick(p.commands[0]), pick(w.commands[0]));
  assert.deepEqual(p.flaky_tests, w.flaky_tests);
  assert.equal(p.pass, w.pass);
  assert.ok(p.warnings.some((x) => x.startsWith('flaky: passed on retry')), p.warnings.join('\n'));
  assert.deepEqual(p.commands[0].retry_files, [FLAKY_FILE]);
  assert.equal('retry_files' in w.commands[0], false);
  const ev = commandEvents(partialDir);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.retry_files, 1, JSON.stringify(ev[0].data));
  assert.equal(ev[0].data.flaky_passed, true);
  assert.equal('retry_files' in commandEvents(wholeDir)[0].data, false);
});

// ---------- AC-3 ----------
test('F100 AC-3: with a partial re-run the head test count is the first run total, not the re-run count', async () => {
  const dir = fixture();
  const r = await run(dir, { test_count: 'from:commands[0]' });
  assert.deepEqual(r.commands[0].retry_files, [FLAKY_FILE]);
  assert.equal(r.integrity.testCount.head, 3, JSON.stringify(r.integrity.testCount));
  assert.equal(r.integrity.testCount.status, 'ok', JSON.stringify(r.integrity.testCount));
});

// ---------- AC-4 ----------
test('F100 AC-4: a command that is not node --test is re-run whole', async () => {
  for (const cmd of ['node scripts/wrap.mjs', `${NODE_TEST} && node scripts/ok.mjs`]) {
    const dir = fixture();
    const r = await run(dir, { commands: [cmd] });
    const log = runsLog(dir);
    assert.equal(r.commands[0].attempts, 3, `${cmd}: ${JSON.stringify(r.commands[0])}`);
    assert.equal(log.filter((l) => l === 'a').length, 3, `${cmd}: ${log.join(',')}`);
    assert.equal('retry_files' in r.commands[0], false, cmd);
  }
  for (const cmd of ['npm test', 'npx node --test x', 'node x.mjs --test', 'node -r x --test a', 'NODE_ENV=x node --test a',
    'node --test a; rm b', 'node --test a | cat', 'node --test $(ls)', 'node --test --test-name-pattern x a', 'node --test -- a']) {
    assert.equal(parseNodeTest(cmd), null, cmd);
  }
});

test('F100 AC-4: an output that locates no file is re-run whole (TAP reporter)', async () => {
  const dir = fixture();
  const r = await run(dir, { commands: ['node --test --test-reporter=tap "tests/**/*.test.mjs"'] });
  const log = runsLog(dir);
  assert.equal(r.commands[0].attempts, 3, JSON.stringify(r.commands[0]));
  assert.equal(log.filter((l) => l === 'a').length, 3, log.join(','));
  assert.equal('retry_files' in r.commands[0], false);
  const cwd = tmpdir('harness-f100-');
  assert.deepEqual(failedTestFiles('✖ a (1ms)\nℹ fail 1\n', cwd), { reason: 'no_files' });
  assert.deepEqual(failedTestFiles(specOutput([]), cwd), { reason: 'no_files' });
});

test('F100 AC-4: a located file outside cwd or missing makes the re-run whole', () => {
  const root = fs.realpathSync.native(tmpdir('harness-f100-'));
  const cwd = path.join(root, 'project');
  fs.mkdirSync(path.join(cwd, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'tests', 'in.test.mjs'), '');
  fs.writeFileSync(path.join(root, 'out.test.mjs'), '');
  const inside = ['tests/in.test.mjs:1:1', 'in fails'];
  for (const at of ['../out.test.mjs:1:1', `${path.join(root, 'out.test.mjs')}:1:1`, 'tests/gone.test.mjs:1:1', 'tests:1:1']) {
    const out = specOutput([inside, [at, 'other fails']]);
    assert.equal(failedTestFiles(out, cwd).reason, 'unknown_file', at);
    assert.equal(partialRetry(NODE_TEST, out, cwd), null, at);
  }
  assert.deepEqual(partialRetry(NODE_TEST, specOutput([inside]), cwd, { platform: 'linux' }).files, [path.join('tests', 'in.test.mjs')]);
});

test('F100 AC-4: more failed tests than locations makes the re-run whole', () => {
  const cwd = fs.realpathSync.native(tmpdir('harness-f100-'));
  fs.writeFileSync(path.join(cwd, 'x.test.mjs'), '');
  const out = specOutput([['x.test.mjs:1:1', 'located'], [null, 'not located']]);
  assert.deepEqual(failedTestFiles(out, cwd), { reason: 'unlocated_failures' });
  assert.equal(partialRetry(NODE_TEST, out, cwd), null);
});

test("F100 AC-4: verify.retry_scope 'command' re-runs the whole command", async () => {
  const dir = fixture();
  const r = await run(dir, { retry_scope: 'command' });
  const log = runsLog(dir);
  assert.equal(r.commands[0].attempts, 3);
  assert.equal(log.filter((l) => l === 'a').length, 3, log.join(','));
  assert.equal('retry_files' in r.commands[0], false);
  const cwd = fs.realpathSync.native(tmpdir('harness-f100-'));
  fs.writeFileSync(path.join(cwd, 'x.test.mjs'), '');
  assert.equal(partialRetry(NODE_TEST, specOutput([['x.test.mjs:1:1', 'x']]), cwd, { scope: 'command' }), null);
});

// ---------- AC-5 ----------
test("F100 AC-5: verify.retry_scope accepts 'failed_files' (default) and 'command' only", () => {
  assert.equal(resolveConfig({}).verify.retry_scope, 'failed_files');
  for (const v of ['failed_files', 'command']) assert.equal(resolveConfig({ verify: { retry_scope: v } }).verify.retry_scope, v);
  for (const v of ['files', 'Command', '', null, 1, ['command']]) {
    assert.throws(() => resolveConfig({ verify: { retry_scope: v } }), (e) => e.code === 'config_invalid'
      && e.message.includes('verify.retry_scope') && e.message.includes("'failed_files'") && e.message.includes("'command'"), JSON.stringify(v));
  }
});

test('F100 AC-5: an invalid verify.retry_scope in config.json exits 2', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = fixture();
  fs.writeFileSync(path.join(dir, '.harness', 'config.json'), JSON.stringify({ profile: 'sdlc', base_branch: 'main', verify: { retry_scope: 'all' } }));
  assert.throws(() => loadConfig(dir), (e) => e.code === 'config_invalid');
  const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'harness.mjs'), 'verify', 'F9'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /verify\.retry_scope/);
});

test('F100 AC-5: retry_scope is part of the verify result cache key', async () => {
  // No runs.log: an ignored file would skip the cache.
  const dir = fixture({ 'tests/a.test.mjs': "import test from 'node:test';\ntest('a passes', () => {});\n" });
  const first = await run(dir);
  assert.equal(first.pass, true, JSON.stringify(first.commands));
  assert.equal(first.cache.status, 'miss', JSON.stringify(first.cache));
  assert.equal((await run(dir)).cache.status, 'hit');
  assert.equal((await run(dir, { retry_scope: 'command' })).cache.status, 'miss');
});

// ---------- AC-6 ----------
test('F100 AC-6: SPEC §6.1 describes the partial re-run', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s61 = spec.slice(spec.indexOf('### 6.1 '), spec.indexOf('### 6.2 '));
  for (const needle of ['verify.retry_scope', "'failed_files'", "'command'", 'test at', 'retry_files', '--test', '✖ failing tests:', 'from:commands[i]']) {
    assert.ok(s61.includes(needle), needle);
  }
  assert.match(s61, /1차 실행 출력/);
  const s64 = spec.slice(spec.indexOf('### 6.4 '));
  assert.ok(s64.slice(0, 3000).includes('verify.retry_scope'), '§6.4 cache key');
});

// ---------- ES-1 ----------
test('F100 ES-1: a file name with spaces and quotes is one argument of the re-run', async () => {
  assert.equal(shellQuote("sub dir/it's b.mjs", 'linux'), "'sub dir/it'\\''s b.mjs'");
  assert.equal(shellQuote("sub dir\\it's b.mjs", 'win32'), '"sub dir\\it\'s b.mjs"');
  assert.equal(shellQuote('plain/x.test.mjs', 'win32'), 'plain/x.test.mjs');
  assert.equal(shellQuote('%PATH%.mjs', 'win32'), null);
  // The fixture's flaky file is tests/sub dir/it's b.test.mjs: the re-run found and ran it.
  const dir = fixture();
  const r = await run(dir);
  assert.deepEqual(r.commands[0].retry_files, [FLAKY_FILE]);
  assert.deepEqual(runsLog(dir).filter((l) => l === 'b').length, 3);
  assert.equal(r.commands[0].pass, true, JSON.stringify(r.commands[0]));
});

// ---------- ES-2 ----------
test("F100 ES-2: verify.flaky 'fail' re-runs the whole command once, as before", async () => {
  const dir = fixture();
  const r = await run(dir, { flaky: 'fail' });
  const c = r.commands[0];
  assert.deepEqual([c.pass, c.attempts, c.flaky], [false, 2, true], JSON.stringify(c));
  assert.equal(runsLog(dir).filter((l) => l === 'a').length, 2);
  assert.equal('retry_files' in c, false);
});

test("F100 ES-2: a failed own test or no test names still skips the re-run", async () => {
  const own = fixture({ 'tests/a.test.mjs': STABLE, 'tests/own.test.mjs': OWN });
  const r = await run(own);
  assert.deepEqual([r.commands[0].attempts, r.commands[0].retry_skipped], [1, 'own_test'], JSON.stringify(r.commands[0]));
  assert.deepEqual(runsLog(own).sort(), ['a', 'o']);
  const none = fixture();
  const n = await run(none, { commands: ['node --test tests/missing.test.mjs'] });
  assert.deepEqual([n.commands[0].attempts, n.commands[0].retry_skipped], [1, 'no_test_names'], JSON.stringify(n.commands[0]));
  assert.equal('retry_files' in n.commands[0], false);
});
