import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, fakeNodeCli, harness, realTmpdir } from './helpers.mjs';

// ------------------------------------------------------------------ fixtures

// The fake terraform of test/f40-tf-check.test.mjs: `test` fails when a *.tftest.hcl/json in
// the cwd or cwd/tests holds FAIL_TEST. The fake scanners (test/fixtures/fake-scanner.mjs) log
// { scanner, args, cwd } to the same $FAKE_TF_LOG, so the order of all calls is in one file;
// $FAKE_SCAN_EXIT_<NAME> sets a scanner's exit code.
const FAKE_TF = path.join(REPO, 'test', 'fixtures', 'fake-terraform.mjs');
const FAKE_SCANNER = path.join(REPO, 'test', 'fixtures', 'fake-scanner.mjs');
const SCANNERS = ['tflint', 'trivy', 'checkov'];

const readLog = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const real = (p) => fs.realpathSync.native(p);
const combined = (r) => `${r.stdout}\n${r.stderr}`;
const norm = (s) => s.replaceAll('\\', '/');

// System directories only, so a real tflint/trivy/checkov installed on this machine is never found.
const systemPath = () => (process.platform === 'win32'
  ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')]
  : ['/usr/bin', '/bin']);

// A project with `files` ({ 'rel/path': content }); `scanners` are the fake scanners on PATH.
function fixture(files, { scanners = SCANNERS, terraform = true } = {}) {
  const root = realTmpdir('harness-f160-');
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  const home = realTmpdir('harness-f160-home-');
  const log = path.join(home, 'tf.log');
  const dirs = [
    ...(terraform ? [fakeNodeCli('terraform', FAKE_TF)] : []),
    ...scanners.map((s) => fakeNodeCli(s, FAKE_SCANNER, [s])),
    path.dirname(process.execPath),
    ...systemPath(),
  ];
  const env = {
    FAKE_TF_LOG: log,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(home, 'Local'),
    XDG_CACHE_HOME: path.join(home, 'xdg'),
    TF_PLUGIN_CACHE_DIR: path.join(home, 'cache'),
    PATH: dirs.join(path.delimiter),
  };
  fs.mkdirSync(env.TF_PLUGIN_CACHE_DIR);
  return { root, log, env };
}

const tfCheck = (f, args = [], extraEnv = {}) => harness(['tf-check', ...args], { cwd: f.root, env: { ...f.env, ...extraEnv } });
const rel = (f, c) => path.relative(f.root, c.cwd).split(path.sep).join('/') || '.';

const OK = 'resource "a" {}\n';
const TEST_OK = 'run "check" {}\n';
const TEST_FAIL = 'run "check" {} # FAIL_TEST\n';

// ------------------------------------------------------------------ criteria

test('F160 AC-1 terraform test runs after init and validate in each module that has test files, and ok test <path> is printed', () => {
  const f = fixture({
    'modules/a/main.tf': OK,
    'modules/a/a.tftest.hcl': TEST_OK,
    'modules/b/main.tf': OK,
    'modules/b/tests/b.tftest.json': '{}\n',
    'modules/c/main.tf': OK,
  });
  const r = tfCheck(f);
  assert.equal(r.code, 0, combined(r));
  const out = norm(r.stdout);
  assert.match(out, /^ok test modules\/a$/m);
  assert.match(out, /^ok test modules\/b$/m);
  assert.doesNotMatch(out, /ok test modules\/c/);

  const calls = readLog(f.log);
  const tests = calls.filter((c) => c.sub === 'test');
  assert.deepEqual(tests.map((c) => rel(f, c)).sort(), ['modules/a', 'modules/b']);
  for (const t of tests) {
    assert.deepEqual(t.args, ['-no-color']);
    const i = calls.indexOf(t);
    const before = calls.slice(0, i).filter((c) => c.cwd === t.cwd).map((c) => c.sub);
    assert.deepEqual(before.filter((s) => s === 'init' || s === 'validate'), ['init', 'validate'], 'init and validate run first in that directory');
  }
});

test('F160 AC-1 a test file in the top directory itself is found and its path is .', () => {
  const f = fixture({ 'main.tf': OK, 'tests/x.tftest.hcl': TEST_OK });
  const r = tfCheck(f);
  assert.equal(r.code, 0, combined(r));
  assert.match(r.stdout, /^ok test \.$/m);
});

test('F160 AC-2 a failing terraform test exits 1, prints <path>: test failed: <tail> and lists test <path>; other modules and fmt still run', () => {
  const f = fixture({
    'modules/a/main.tf': OK,
    'modules/a/tests/a.tftest.hcl': TEST_FAIL,
    'modules/b/main.tf': OK,
    'modules/b/b.tftest.hcl': TEST_OK,
  });
  const r = tfCheck(f);
  assert.equal(r.code, 1, combined(r));
  const errText = norm(r.stderr);
  assert.match(errText, /^modules\/a: test failed: [\s\S]*TAIL_OF_TEST_OUTPUT/m);
  const last = errText.trim().split('\n').at(-1);
  assert.match(last, /^tf-check: failed: /);
  assert.ok(last.slice('tf-check: failed: '.length).split(', ').includes('test modules/a'), last);
  assert.match(norm(r.stdout), /^ok test modules\/b$/m);
  assert.match(r.stdout, /^ok fmt$/m);
  const calls = readLog(f.log);
  assert.deepEqual(calls.filter((c) => c.sub === 'test').map((c) => rel(f, c)).sort(), ['modules/a', 'modules/b']);
  assert.equal(calls.filter((c) => c.sub === 'fmt').length, 1);
});

test('F160 AC-3 terraform test is not run where there are no test files or init or validate failed', () => {
  const f = fixture({
    'modules/none/main.tf': OK,
    'modules/badinit/main.tf': '# FAIL_INIT\n',
    'modules/badinit/t.tftest.hcl': TEST_OK,
    'modules/badval/main.tf': '# FAIL_VALIDATE\n',
    'modules/badval/tests/t.tftest.hcl': TEST_OK,
    'modules/ok/main.tf': OK,
    'modules/ok/t.tftest.hcl': TEST_OK,
  });
  const r = tfCheck(f);
  assert.equal(r.code, 1, combined(r));
  const calls = readLog(f.log);
  assert.deepEqual(calls.filter((c) => c.sub === 'test').map((c) => rel(f, c)), ['modules/ok']);
  // A test file somewhere other than the directory or its tests/ is not one of its tests.
  const g = fixture({ 'm/main.tf': OK, 'm/other/x.tftest.hcl': TEST_OK });
  assert.equal(tfCheck(g).code, 0);
  assert.equal(readLog(g.log).filter((c) => c.sub === 'test').length, 0);
});

test('F160 AC-4 --scan runs each named scanner once, in the given order, at the top directory after fmt', () => {
  const f = fixture({ 'infra/a/main.tf': OK, 'infra/b/main.tf': OK, 'other/main.tf': OK });
  const r = tfCheck(f, ['--dir', 'infra', '--scan', 'checkov', '--scan', 'tflint', '--scan=trivy']);
  assert.equal(r.code, 0, combined(r));
  for (const s of SCANNERS) assert.match(r.stdout, new RegExp(`^ok scan ${s}$`, 'm'));
  assert.doesNotMatch(r.stdout, /no policy scanners/);

  const calls = readLog(f.log);
  const scans = calls.filter((c) => c.scanner);
  assert.deepEqual(scans.map((c) => c.scanner), ['checkov', 'tflint', 'trivy']);
  const expected = {
    tflint: ['--recursive', '--no-color'],
    trivy: ['config', '--quiet', '--exit-code', '1', '.'],
    checkov: ['-d', '.', '--quiet', '--compact'],
  };
  for (const c of scans) {
    assert.deepEqual(c.args, expected[c.scanner]);
    assert.equal(c.cwd, real(path.join(f.root, 'infra')));
  }
  const fmtAt = calls.findIndex((c) => c.sub === 'fmt');
  assert.ok(fmtAt >= 0 && fmtAt < calls.indexOf(scans[0]), 'scanners run after fmt');
  // stdout order matches: ok fmt before the first ok scan.
  assert.ok(r.stdout.indexOf('ok fmt') < r.stdout.indexOf('ok scan checkov'));
});

test('F160 AC-4 a scanner named twice runs once', () => {
  const f = fixture({ 'main.tf': OK });
  const r = tfCheck(f, ['--scan', 'tflint', '--scan', 'tflint']);
  assert.equal(r.code, 0, combined(r));
  assert.equal(readLog(f.log).filter((c) => c.scanner === 'tflint').length, 1);
});

test('F160 AC-5 a scanner that exits non-zero (tflint exit 2) fails tf-check with scan <name> failed and lists scan <name>', () => {
  const f = fixture({ 'main.tf': OK });
  const r = tfCheck(f, ['--scan', 'tflint', '--scan', 'trivy', '--scan', 'checkov'], { FAKE_SCAN_EXIT_TFLINT: '2', FAKE_SCAN_EXIT_CHECKOV: '1' });
  assert.equal(r.code, 1, combined(r));
  assert.match(r.stderr, /^scan tflint failed: [\s\S]*SCAN_TAIL_tflint/m);
  assert.match(r.stderr, /^scan checkov failed: [\s\S]*SCAN_TAIL_checkov/m);
  assert.match(r.stdout, /^ok scan trivy$/m);
  const last = r.stderr.trim().split('\n').at(-1);
  assert.match(last, /^tf-check: failed: /);
  const listed = last.slice('tf-check: failed: '.length).split(', ');
  assert.ok(listed.includes('scan tflint') && listed.includes('scan checkov'), last);
  assert.ok(!listed.includes('scan trivy'), last);
});

test('F160 AC-5 trivy exit 1 alone fails tf-check', () => {
  const f = fixture({ 'main.tf': OK });
  const r = tfCheck(f, ['--scan', 'trivy'], { FAKE_SCAN_EXIT_TRIVY: '1' });
  assert.equal(r.code, 1, combined(r));
  assert.match(r.stderr.trim().split('\n').at(-1), /^tf-check: failed: scan trivy$/);
});

test('F160 AC-6 without --scan one line says there are no policy scanners; results and exit codes are unchanged', () => {
  const f = fixture({ 'modules/a/main.tf': OK });
  const r = tfCheck(f);
  assert.equal(r.code, 0, combined(r));
  const lines = r.stdout.split('\n').filter((l) => l === 'tf-check: no policy scanners (--scan tflint|trivy|checkov)');
  assert.equal(lines.length, 1, r.stdout);
  assert.match(norm(r.stdout), /^ok modules\/a$/m);
  assert.match(r.stdout, /^ok fmt$/m);
  assert.equal(readLog(f.log).filter((c) => c.scanner).length, 0);

  const g = fixture({ 'modules/bad/main.tf': '# FAIL_VALIDATE\n' });
  const b = tfCheck(g);
  assert.equal(b.code, 1, combined(b));
  assert.match(b.stdout, /^tf-check: no policy scanners \(--scan tflint\|trivy\|checkov\)$/m);
  assert.equal(norm(b.stderr).trim().split('\n').at(-1), 'tf-check: failed: modules/bad');
});

test('F160 AC-7 iac rubric names tf-check --scan and terraform test; tf-check --help shows --scan <name>', () => {
  const profile = JSON.parse(fs.readFileSync(path.join(REPO, 'profiles', 'iac.json'), 'utf8'));
  assert.ok(profile.rubric.security.includes('tf-check --scan'), profile.rubric.security);
  assert.ok(profile.rubric.tests.includes('tf-check --scan'), profile.rubric.tests);
  assert.ok(profile.rubric.tests.includes('terraform test'), profile.rubric.tests);

  const r = harness(['tf-check', '--help'], { cwd: realTmpdir('harness-f160-help-') });
  assert.equal(r.code, 0, combined(r));
  const lines = r.stdout.split('\n');
  assert.ok(lines[0].startsWith('usage: harness tf-check') && lines[0].includes('--scan <name>'), lines[0]);
  const options = lines.slice(lines.indexOf('options:') + 1);
  assert.ok(lines.includes('options:'));
  assert.ok(options.some((l) => l.trim().startsWith('--scan <name>')), r.stdout);
});

test('F160 AC-8 SPEC §4 and docs/iac.md describe terraform test and the three scanner commands', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'iac.md'), 'utf8');
  const section4 = spec.slice(spec.indexOf('## 4.'), spec.indexOf('\n## 5.'));
  for (const [label, text] of [['SPEC §4', section4], ['docs/iac.md', doc]]) {
    for (const needle of ['terraform test -no-color', '*.tftest.hcl', '*.tftest.json', 'tests/', '--scan',
      'tflint --recursive --no-color', 'trivy config --quiet --exit-code 1 .', 'checkov -d . --quiet --compact']) {
      assert.ok(text.includes(needle), `${label} must mention ${needle}`);
    }
  }
  assert.ok(!section4.includes('정책 스캐너는 실행하지 않는다'), 'SPEC §4 no longer says policy scanners are not run');
});

test('F160 ES-1 --scan without a value or with an unknown name is a usage error (exit 2) listing the allowed names; nothing runs', () => {
  const f = fixture({ 'main.tf': OK });
  for (const args of [['--scan'], ['--scan='], ['--scan', 'rm'], ['--scan=rm'], ['--scan', 'tflint', '--scan', 'TFLINT'], ['--scan', '--dir']]) {
    const r = tfCheck(f, args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${combined(r)}`);
    assert.match(r.stderr, /tflint, trivy, checkov/, args.join(' '));
  }
  assert.equal(readLog(f.log).length, 0);
});

test('F160 ES-2 a scanner named with --scan that is not on PATH: command not found: <name>, exit 127, before terraform runs', async () => {
  const f = fixture({ 'main.tf': OK }, { scanners: ['tflint'] });
  const r = tfCheck(f, ['--scan', 'tflint', '--scan', 'checkov']);
  assert.equal(r.code, 127, combined(r));
  assert.match(r.stderr, /^harness tf-check: command not found: checkov$/m);
  assert.equal(readLog(f.log).length, 0, 'neither terraform nor any scanner ran');

  const { isNotFound } = await import('../lib/exec.mjs');
  const { missingProgram } = await import('../lib/verify.mjs');
  assert.equal(isNotFound({ code: r.code, stderr: r.stderr }), true);
  assert.equal(missingProgram('harness tf-check --scan tflint --scan checkov', r), 'checkov');
});
