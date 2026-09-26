// F23: verify.test_count presets (node-test, go, pytest) run a fixed executable with fixed
// arguments and no shell; init writes a detected preset into a new config.json and doctor
// shows the configured value or a suggestion.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BIN, REPO, tmpdir, harness, readJson, writeJson } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { verify } from '../lib/verify.mjs';
import { HarnessError } from '../lib/errors.mjs';
import { TEST_COUNT_PRESETS, PRESET_NAMES, getPreset, detectPreset } from '../lib/testcount.mjs';
import doctor from '../lib/commands/doctor.mjs';

const RUNNER = path.join(REPO, 'test', 'fixtures', 'fake-runner.mjs');

const CONTRACT = {
  id: 'F9', title: 'fixture', security_tier: 'standard', version: 1,
  acceptance_criteria: [{ id: 'AC-1', criterion: 'check exists', check: 'node check.mjs', new: true }],
  security_criteria: [], error_scenarios: [], out_of_scope: [],
};

// Base branch `main` holds .harness state + `files`; HEAD is `feature` with an untracked
// check.mjs that makes AC-1 pass (and fails on base, so AC-1 is not vacuous).
function fixture(files = {}, config = {}) {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, ...config },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': CONTRACT,
    ...files,
  });
  writeFiles(dir, { 'check.mjs': 'process.exit(0);\n' });
  return dir;
}

const cfg = (testCount) => resolveConfig({ base_branch: 'main', verify: { commands: [], test_count: testCount }, budget: { step_timeout_sec: 60 } });

// Three node:test tests, one of them failing.
const NODE_TESTS = {
  'test/a.test.mjs': [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('one', () => {});",
    "test('two', () => { assert.equal(1, 2); });",
    '',
  ].join('\n'),
  'test/b.test.mjs': "import test from 'node:test';\ntest('three', () => {});\n",
};

// A PATH directory with fake `go` / `python` executables (fixtures/fake-runner.mjs).
function fakeBin(names = ['go', 'python']) {
  const dir = tmpdir('harness-f23-bin-');
  for (const name of names) {
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(dir, `${name}.cmd`), `@"${process.execPath}" "${RUNNER}" ${name} %*\r\n`);
    } else {
      const f = path.join(dir, name);
      fs.writeFileSync(f, `#!/bin/sh\nexec "${process.execPath}" "${RUNNER}" ${name} "$@"\n`);
      fs.chmodSync(f, 0o755);
    }
  }
  return dir;
}

const which = (name) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim();
const GIT_DIR = path.dirname(which('git'));

// A PATH directory holding only `git` and `node` (POSIX symlinks), so a runner that is
// installed on this machine is still absent. Windows uses the node and git directories.
function onlyGitAndNode() {
  if (process.platform === 'win32') return [path.dirname(process.execPath), GIT_DIR].join(path.delimiter);
  const dir = tmpdir('harness-f23-min-');
  fs.symlinkSync(fs.realpathSync(which('git')), path.join(dir, 'git'));
  fs.symlinkSync(process.execPath, path.join(dir, 'node'));
  return dir;
}

// `harness verify F9 --json` with PATH replaced.
function cliVerify(dir, pathValue) {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[pathKey] = pathValue;
  const r = spawnSync(process.execPath, [BIN, 'verify', 'F9', '--json'], { cwd: dir, encoding: 'utf8', env });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* reported by the assertion below */ }
  assert.ok(json, `no JSON from verify (exit ${r.status}): ${r.stdout}${r.stderr}`);
  return { code: r.status, json, stderr: r.stderr };
}

const withFakes = (bin) => [bin, path.dirname(process.execPath), GIT_DIR].join(path.delimiter);

// A repo whose test_count is `preset` and whose fake runner prints `out` (base and head).
function presetRepo(preset, name, out) {
  return fixture({ [`fake-${name}.out`]: out }, { verify: { commands: [], test_count: preset } });
}

// ---------- AC-1 ----------
test('F23 AC-1: preset:node-test counts the last "# tests N" of node --test --test-reporter=tap (failing tests count)', async () => {
  const dir = fixture(NODE_TESTS);
  const r = await verify({ root: dir, featureId: 'F9', base: 'main', config: cfg('preset:node-test') });
  assert.deepEqual(r.integrity.testCount, { base: 3, head: 3, status: 'ok', source: { head: 'ran', base: 'ran' } });
  assert.equal(r.pass, true, JSON.stringify(r, null, 2));
});

test('F23 AC-1: the node-test preset is node with the fixed TAP arguments and parses the last summary', () => {
  const p = TEST_COUNT_PRESETS['node-test'];
  assert.equal(p.bin, 'node');
  assert.deepEqual([...p.args], ['--test', '--test-reporter=tap']);
  assert.equal(p.parse('TAP version 13\n# Subtest: a\n    # tests 9\nok 1 - a\n1..1\n# tests 1\n# pass 1\n# tests 4\n# fail 0\n'), 4);
  assert.equal(p.parse('ok 1 - a\r\n# tests 2\r\n# pass 2\r\n'), 2);
});

// ---------- AC-2 ----------
const GO_LIST = [
  'TestAlpha', 'TestBeta', 'ExampleGamma', 'FuzzDelta', 'BenchmarkSkip',
  'ok  \texample.com/m\t0.002s',
  'TestInSub',
  'ok  \texample.com/m/sub\t0.001s',
  '?   \texample.com/m/cmd\t[no test files]',
  '',
].join('\n');

test('F23 AC-2: preset:go counts Test/Example/Fuzz lines of `go test -list . ./...` (fake go first on PATH)', () => {
  const dir = presetRepo('preset:go', 'go', GO_LIST);
  const r = cliVerify(dir, withFakes(fakeBin()));
  assert.deepEqual(r.json.integrity.testCount, { base: 5, head: 5, status: 'ok', source: { head: 'ran', base: 'ran' } });
  assert.deepEqual(readJson(path.join(dir, 'go-args.json')), ['test', '-list', '.', './...']);
  assert.equal(r.code, 0, JSON.stringify(r.json, null, 2));
});

test('F23 AC-2: go output with only package lines counts 0, not an error', () => {
  assert.equal(TEST_COUNT_PRESETS.go.parse('?   \texample.com/m\t[no test files]\n'), 0);
  assert.equal(TEST_COUNT_PRESETS.go.parse('ok  \texample.com/m\t0.1s\r\n'), 0);
  assert.equal(TEST_COUNT_PRESETS.go.parse('TestA\r\nTestB\r\nok  \tx\t0.1s\r\n'), 2);
});

// ---------- AC-3 ----------
for (const [label, out, n] of [
  ['plural', 'test_a.py::test_one\ntest_a.py::test_two\ntest_b.py::test_three\n\n3 tests collected in 0.01s\n', 3],
  ['singular', 'test_a.py::test_one\n\n1 test collected in 0.00s\n', 1],
]) {
  test(`F23 AC-3: preset:pytest reads N from '${label}' collect-only output (fake python)`, () => {
    const dir = presetRepo('preset:pytest', 'python', out);
    const r = cliVerify(dir, withFakes(fakeBin()));
    assert.deepEqual(r.json.integrity.testCount, { base: n, head: n, status: 'ok', source: { head: 'ran', base: 'ran' } });
    assert.deepEqual(readJson(path.join(dir, 'python-args.json')), ['-m', 'pytest', '--collect-only', '-q']);
  });
}

test('F23 AC-3: pytest parsing cases', () => {
  const parse = TEST_COUNT_PRESETS.pytest.parse;
  assert.equal(TEST_COUNT_PRESETS.pytest.bin, 'python');
  assert.equal(parse('12 tests collected in 0.05s\n'), 12);
  assert.equal(parse('1 test collected in 0.01s\n'), 1);
  assert.equal(parse('a.py::t\r\n\r\n2 tests collected in 0.01s\r\n'), 2);
  assert.equal(parse('no tests collected in 0.01s\n'), null);
  assert.equal(parse('collected 3 items\n'), null);
});

// ---------- AC-4 ----------
test('F23 AC-4: a feature deleting a node:test test makes the preset count decrease and verify fail', async () => {
  const dir = fixture(NODE_TESTS);
  fs.rmSync(path.join(dir, 'test', 'b.test.mjs'));
  const r = await verify({ root: dir, featureId: 'F9', base: 'main', config: cfg('preset:node-test') });
  assert.deepEqual(r.integrity.testCount, { base: 3, head: 2, status: 'decreased', source: { head: 'ran', base: 'ran' } });
  assert.equal(r.pass, false);
});

// ---------- AC-5 ----------
const initIn = (files) => {
  const dir = tmpdir('harness-f23-init-');
  writeFiles(dir, files);
  const r = harness(['init'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  return readJson(path.join(dir, '.harness', 'config.json'));
};

test('F23 AC-5: init writes preset:node-test when package.json scripts.test runs node --test', () => {
  const c = initIn({ 'package.json': { scripts: { test: 'node --test "test/**/*.test.mjs"' } } });
  assert.equal(c.verify.test_count, 'preset:node-test');
  assert.equal(c.verify.commands, undefined, 'verify.commands stays unset');
  assert.equal(c.profile, 'sdlc');
});

test('F23 AC-5: init writes preset:go when go.mod exists', () => {
  assert.equal(initIn({ 'go.mod': 'module example.com/m\n\ngo 1.22\n' }).verify.test_count, 'preset:go');
});

test('F23 AC-5: init writes preset:pytest for pytest.ini', () => {
  assert.equal(initIn({ 'pytest.ini': '[pytest]\n' }).verify.test_count, 'preset:pytest');
});

test('F23 AC-5: init writes preset:pytest for conftest.py', () => {
  assert.equal(initIn({ 'conftest.py': '' }).verify.test_count, 'preset:pytest');
});

test('F23 AC-5: init writes preset:pytest for pyproject.toml with [tool.pytest.ini_options]', () => {
  assert.equal(initIn({ 'pyproject.toml': '[project]\nname = "x"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n' }).verify.test_count, 'preset:pytest');
});

test('F23 AC-5: init writes no test_count when nothing is detected', () => {
  for (const files of [
    {},
    { 'package.json': { scripts: { test: 'jest' } } },
    { 'package.json': '{ not json' },
    { 'pyproject.toml': '[project]\nname = "x"\n' },
  ]) {
    const c = initIn(files);
    assert.equal(c.verify?.test_count, undefined, JSON.stringify(files));
    assert.deepEqual(c, { profile: 'sdlc', base_branch: 'main' }, JSON.stringify(files));
  }
});

test('F23 AC-5: init never changes an existing config.json', () => {
  const dir = tmpdir('harness-f23-init-');
  writeFiles(dir, { 'go.mod': 'module m\n' });
  writeJson(path.join(dir, '.harness', 'config.json'), { profile: 'sdlc', base_branch: 'main' });
  assert.equal(harness(['init'], { cwd: dir }).code, 0);
  assert.deepEqual(readJson(path.join(dir, '.harness', 'config.json')), { profile: 'sdlc', base_branch: 'main' });
});

test('F23 AC-5: detectPreset cases', () => {
  const at = (files) => { const d = tmpdir('harness-f23-detect-'); writeFiles(d, files); return detectPreset(d); };
  assert.equal(at({ 'package.json': { scripts: { test: 'node --test' } } }), 'preset:node-test');
  assert.equal(at({ 'package.json': { scripts: { test: 'mocha' } }, 'go.mod': 'module m\n' }), 'preset:go');
  assert.equal(at({ 'pyproject.toml': '[tool.pytest]\n' }), null);
  assert.equal(at({ 'package.json': { scripts: {} } }), null);
});

// ---------- AC-6 ----------
const PROBE = async () => ({ installed: false, version: null, help: null });

async function doctorOut(root) {
  const lines = [];
  await doctor({ root, out: (l) => lines.push(l), err: (l) => lines.push(l), probe: PROBE, env: {} });
  return lines.join('\n');
}

test('F23 AC-6: doctor shows the configured test_count value', async () => {
  const dir = tmpdir('harness-f23-doc-');
  harness(['init'], { cwd: dir });
  writeJson(path.join(dir, '.harness', 'config.json'), { profile: 'sdlc', base_branch: 'main', verify: { test_count: 'preset:go' } });
  const out = await doctorOut(dir);
  assert.match(out, /^test count: preset:go$/m);
  assert.doesNotMatch(out, /suggest:/);
});

test('F23 AC-6: doctor shows a configured shell test_count command as is', async () => {
  const dir = tmpdir('harness-f23-doc-');
  harness(['init'], { cwd: dir });
  writeJson(path.join(dir, '.harness', 'config.json'), { profile: 'sdlc', base_branch: 'main', verify: { test_count: 'node test/count.mjs' } });
  assert.match(await doctorOut(dir), /^test count: node test\/count\.mjs$/m);
});

test('F23 AC-6: doctor without test_count says not configured and suggests the detected preset', async () => {
  const dir = tmpdir('harness-f23-doc-');
  harness(['init'], { cwd: dir });
  writeFiles(dir, { 'go.mod': 'module m\n' });
  const out = await doctorOut(dir);
  assert.match(out, /^test count: not configured$/m);
  assert.match(out, /suggest: preset:go\b/);
});

test('F23 AC-6: doctor without test_count and nothing detected prints no suggestion', async () => {
  const dir = tmpdir('harness-f23-doc-');
  harness(['init'], { cwd: dir });
  const out = await doctorOut(dir);
  assert.match(out, /^test count: not configured$/m);
  assert.doesNotMatch(out, /suggest:/);
});

// ---------- AC-7 ----------
test('F23 AC-7: SPEC §4 and §6.2 document the presets, their commands and counting rules, and init detection', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s4 = spec.slice(spec.indexOf('## 4.'), spec.indexOf('## 5.'));
  const s62 = spec.slice(spec.indexOf('### 6.2'), spec.indexOf('### 6.3'));
  for (const p of ['preset:node-test', 'preset:go', 'preset:pytest']) {
    assert.ok(s4.includes(p), `§4 names ${p}`);
    assert.ok(s62.includes(p), `§6.2 names ${p}`);
  }
  for (const s of ['node --test --test-reporter=tap', '# tests N', 'go test -list . ./...', 'Test', 'Example', 'Fuzz',
    'python -m pytest --collect-only -q', 'N tests collected', '1 test collected', 'command not found', 'no test count in output']) {
    assert.ok(s62.includes(s), `§6.2 mentions '${s}'`);
  }
  for (const s of ['package.json', 'node --test', 'go.mod', 'pytest.ini', 'conftest.py', '[tool.pytest.ini_options]']) {
    assert.ok(s4.includes(s), `§4 init detection mentions '${s}'`);
  }
});

// ---------- SC-1 ----------
test('F23 SC-1: presets are a fixed executable and a frozen argument array', () => {
  assert.deepEqual(PRESET_NAMES, ['preset:node-test', 'preset:go', 'preset:pytest']);
  for (const p of Object.values(TEST_COUNT_PRESETS)) {
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.args));
    assert.ok(p.args.every((a) => typeof a === 'string'));
  }
  assert.equal(getPreset('preset:go'), TEST_COUNT_PRESETS.go);
  for (const v of ['preset:node-test; echo pwned', 'preset:go ./x', 'preset:', 'preset:toString', 'preset:__proto__', 'Preset:go']) {
    assert.equal(getPreset(v), null, v);
  }
});

test("F23 SC-1: 'preset:node-test; echo pwned' is rejected as an unknown preset before anything runs", () => {
  const bad = 'preset:node-test; echo pwned > pwned.txt';
  assert.throws(() => resolveConfig({ verify: { test_count: bad } }), (e) => e instanceof HarnessError && e.code === 'config_invalid' && e.message.includes('unknown'));
  const dir = fixture({}, { verify: { commands: [], test_count: bad } });
  const r = harness(['verify', 'F9'], { cwd: dir });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /unknown/);
  assert.equal(fs.existsSync(path.join(dir, 'pwned.txt')), false);
});

test('F23 SC-1: other config values never reach the preset arguments, and no shell interprets them', () => {
  const dir = fixture({ 'fake-go.out': GO_LIST }, {
    verify: { commands: [], test_count: 'preset:go', skip_markers: ['$(touch pwned-marker)'], test_paths: ['test/**'] },
    env_allowlist: ['F23_EXTRA'],
    base_branch: 'main',
  });
  const r = cliVerify(dir, withFakes(fakeBin()));
  assert.equal(r.json.integrity.testCount.status, 'ok');
  assert.deepEqual(readJson(path.join(dir, 'go-args.json')), ['test', '-list', '.', './...']);
  assert.equal(fs.existsSync(path.join(dir, 'pwned-marker')), false);
});

// ---------- ES-1 ----------
test("F23 ES-1: an unknown preset exits 2 (config_invalid) naming verify.test_count and the available presets", () => {
  assert.throws(() => resolveConfig({ verify: { test_count: 'preset:foo' } }, { label: 'cfg' }), (e) => {
    assert.ok(e instanceof HarnessError);
    assert.equal(e.code, 'config_invalid');
    assert.equal(e.exit, 2);
    for (const s of ['verify.test_count', 'preset:foo', 'preset:node-test', 'preset:go', 'preset:pytest']) assert.ok(e.message.includes(s), `${s} in ${e.message}`);
    return true;
  });
  const dir = tmpdir('harness-f23-es1-');
  harness(['init'], { cwd: dir });
  writeJson(path.join(dir, '.harness', 'config.json'), { profile: 'sdlc', base_branch: 'main', verify: { test_count: 'preset:foo' } });
  const r = harness(['status'], { cwd: dir });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  for (const s of ['verify.test_count', 'preset:node-test', 'preset:go', 'preset:pytest']) assert.ok(r.stderr.includes(s), r.stderr);
  assert.doesNotMatch(r.stderr, /^ {4}at /m);
});

// ---------- ES-2 ----------
test('F23 ES-2: a preset executable missing from PATH is a test count error "command not found: <name>" and verify fails', () => {
  const dir = presetRepo('preset:pytest', 'python', '1 test collected in 0.01s\n');
  const r = cliVerify(dir, onlyGitAndNode());
  assert.equal(r.json.integrity.testCount.status, 'error');
  assert.match(r.json.integrity.testCount.message, /command not found: python/);
  assert.equal(r.json.pass, false);
  assert.equal(r.code, 1);
});

test('F23 ES-2: the text summary reports the missing executable', () => {
  const dir = presetRepo('preset:go', 'go', GO_LIST);
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[pathKey] = onlyGitAndNode();
  const r = spawnSync(process.execPath, [BIN, 'verify', 'F9'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL test count: error .*command not found: go/);
});

// ---------- ES-3 ----------
test('F23 ES-3: preset output without a count is a test count error "no test count in output"', () => {
  const dir = presetRepo('preset:go', 'go', 'go: cannot find main module\n');
  const r = cliVerify(dir, withFakes(fakeBin()));
  assert.equal(r.json.integrity.testCount.status, 'error');
  assert.match(r.json.integrity.testCount.message, /no test count in output/);
  assert.equal(r.json.pass, false);
});

test('F23 ES-3: pytest output without "N tests collected" is an error too', () => {
  const dir = presetRepo('preset:pytest', 'python', 'no tests collected in 0.01s\n');
  const r = cliVerify(dir, withFakes(fakeBin()));
  assert.equal(r.json.integrity.testCount.status, 'error');
  assert.match(r.json.integrity.testCount.message, /no test count in output/);
});

test('F23 ES-3: node --test output without a summary has no count', () => {
  assert.equal(TEST_COUNT_PRESETS['node-test'].parse('TAP version 13\n'), null);
  assert.equal(TEST_COUNT_PRESETS['node-test'].parse('    # tests 3\n'), null);
});
