import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, fakeNodeCli, harness, realTmpdir, readJson } from './helpers.mjs';

// ------------------------------------------------------------------ fixtures

// The fake kubeconform/kustomize/helm of test/f161-k8s-check.test.mjs (test/fixtures/fake-k8s.mjs)
// log { tool, args, cwd, stdin? } to $FAKE_K8S_LOG; the fake scanners of test/f160 (test/fixtures/
// fake-scanner.mjs) log { scanner, args, cwd } to $FAKE_TF_LOG. Both point at one file, so the
// order of every call is in it. $FAKE_SCAN_EXIT_<NAME> sets a scanner's exit code.
const FAKE_K8S = path.join(REPO, 'test', 'fixtures', 'fake-k8s.mjs');
const FAKE_SCANNER = path.join(REPO, 'test', 'fixtures', 'fake-scanner.mjs');
const TOOLS = ['kubeconform', 'kustomize', 'helm'];
const SCANNERS = ['trivy', 'checkov'];
const NO_SCANNERS = 'k8s-check: no policy scanners (--scan trivy|checkov)';

const readLog = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const norm = (s) => s.replaceAll('\\', '/');
const lines = (s) => s.split('\n').map((l) => l.trimEnd()).filter(Boolean);
const combined = (r) => `${r.stdout}\n${r.stderr}`;
const real = (p) => fs.realpathSync.native(p);

// A project with `files`; PATH holds only the fakes named in `tools` and `scanners`.
function fixture(files, { tools = TOOLS, scanners = SCANNERS } = {}) {
  const root = realTmpdir('harness-f163-');
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
  const log = path.join(realTmpdir('harness-f163-log-'), 'calls.log');
  const dirs = [
    ...tools.map((t) => fakeNodeCli(t, FAKE_K8S, [t])),
    ...scanners.map((s) => fakeNodeCli(s, FAKE_SCANNER, [s])),
  ];
  const env = { FAKE_K8S_LOG: log, FAKE_TF_LOG: log, PATH: dirs.join(path.delimiter) };
  return { root, log, env };
}

const k8sCheck = (f, args = [], extraEnv = {}) => harness(['k8s-check', ...args], { cwd: f.root, env: { ...f.env, ...extraEnv } });
const scans = (f) => readLog(f.log).filter((c) => c.scanner).map((c) => ({ ...c, args: c.args.map(norm) }));
const DEP = 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n';
const EXPECTED_ARGS = (dir) => ({
  trivy: ['config', '--quiet', '--exit-code', '1', dir],
  checkov: ['-d', dir, '--quiet', '--compact', '--framework', 'kubernetes', 'helm', 'kustomize'],
});

// ------------------------------------------------------------------ criteria

test('F163 AC-1 --scan runs each named scanner once, in the given order, at the project root after kubeconform', () => {
  const f = fixture({ 'deploy/a.yaml': DEP, 'deploy/chart/Chart.yaml': 'name: c\n', 'k8s/x.yaml': DEP });
  const r = k8sCheck(f, ['--dir', 'deploy', '--scan', 'checkov', '--scan=trivy']);
  assert.equal(r.code, 0, combined(r));
  const out = lines(r.stdout);
  assert.ok(out.includes('ok scan trivy') && out.includes('ok scan checkov'), r.stdout);
  assert.ok(!r.stdout.includes('no policy scanners'), r.stdout);
  assert.ok(out.indexOf('ok deploy') < out.indexOf('ok scan checkov'), r.stdout);
  assert.ok(out.indexOf('ok scan checkov') < out.indexOf('ok scan trivy'), r.stdout);

  const all = readLog(f.log);
  const s = scans(f);
  assert.deepEqual(s.map((c) => c.scanner), ['checkov', 'trivy']);
  const expected = EXPECTED_ARGS('deploy');
  for (const c of s) {
    assert.deepEqual(c.args, expected[c.scanner]);
    assert.equal(c.cwd, real(f.root));
  }
  const lastTool = all.map((c) => Boolean(c.tool)).lastIndexOf(true);
  const firstScan = all.findIndex((c) => c.scanner);
  assert.ok(lastTool >= 0 && lastTool < firstScan, 'scanners run after every kubeconform, kustomize and helm call');
});

test('F163 AC-1 the default directory is passed as k8s, and a scanner named twice runs once', () => {
  const f = fixture({ 'k8s/a.yaml': DEP });
  const r = k8sCheck(f, ['--scan', 'trivy', '--scan', 'trivy', '--scan=checkov', '--scan', 'checkov']);
  assert.equal(r.code, 0, combined(r));
  assert.deepEqual(lines(r.stdout), ['ok k8s', 'ok scan trivy', 'ok scan checkov']);
  const s = scans(f);
  assert.deepEqual(s.map((c) => c.scanner), ['trivy', 'checkov']);
  const expected = EXPECTED_ARGS('k8s');
  for (const c of s) assert.deepEqual(c.args, expected[c.scanner]);

  // --dir . passes '.'.
  const g = fixture({ 'a.yaml': DEP });
  const t = k8sCheck(g, ['--dir', '.', '--scan', 'trivy']);
  assert.equal(t.code, 0, combined(t));
  assert.deepEqual(scans(g).map((c) => c.args), [EXPECTED_ARGS('.').trivy]);
});

test('F163 AC-2 a scanner that exits non-zero fails k8s-check with scan <name> failed: <tail> and lists scan <name>', () => {
  const f = fixture({ 'k8s/a.yaml': DEP });
  const r = k8sCheck(f, ['--scan', 'trivy', '--scan', 'checkov'], { FAKE_SCAN_EXIT_TRIVY: '1' });
  assert.equal(r.code, 1, combined(r));
  assert.match(r.stderr, /^scan trivy failed: [\s\S]*SCAN_TAIL_trivy/m);
  assert.ok(lines(r.stdout).includes('ok scan checkov'), r.stdout);
  const failLine = lines(r.stderr).find((l) => l.startsWith('scan trivy failed: '));
  // The tail is bounded: the fake prints about 4000 characters.
  assert.ok(r.stderr.length < 2200, `tail length ${r.stderr.length}`);
  assert.ok(failLine, r.stderr);
  assert.equal(lines(r.stderr).at(-1), 'k8s-check: failed: scan trivy');

  const g = fixture({ 'k8s/a.yaml': DEP });
  const c = k8sCheck(g, ['--scan=checkov'], { FAKE_SCAN_EXIT_CHECKOV: '1' });
  assert.equal(c.code, 1, combined(c));
  assert.equal(lines(c.stderr).at(-1), 'k8s-check: failed: scan checkov');
});

test('F163 AC-2 scanners still run when kubeconform fails, and both failures are listed', () => {
  const f = fixture({ 'k8s/bad/x.yaml': 'FAIL_KUBECONFORM\n', 'k8s/good/y.yaml': DEP });
  const r = k8sCheck(f, ['--scan', 'trivy', '--scan', 'checkov'], { FAKE_SCAN_EXIT_CHECKOV: '1' });
  assert.equal(r.code, 1, combined(r));
  assert.ok(r.stderr.includes('k8s/bad: kubeconform failed: '), r.stderr);
  assert.ok(lines(r.stdout).includes('ok scan trivy'), r.stdout);
  assert.match(r.stderr, /^scan checkov failed: [\s\S]*SCAN_TAIL_checkov/m);
  assert.equal(lines(r.stderr).at(-1), 'k8s-check: failed: k8s/bad, scan checkov');
  assert.deepEqual(scans(f).map((c) => c.scanner), ['trivy', 'checkov']);
});

test('F163 AC-3 without --scan one line says there are no policy scanners; other output and exit codes are unchanged', () => {
  const f = fixture({ 'k8s/a.yaml': DEP });
  const r = k8sCheck(f);
  assert.equal(r.code, 0, combined(r));
  assert.deepEqual(lines(r.stdout), ['ok k8s', NO_SCANNERS]);
  assert.equal(scans(f).length, 0);

  const g = fixture({ 'k8s/bad/x.yaml': 'FAIL_KUBECONFORM\n' });
  const b = k8sCheck(g);
  assert.equal(b.code, 1, combined(b));
  assert.deepEqual(lines(b.stdout), [NO_SCANNERS]);
  assert.equal(lines(b.stderr).at(-1), 'k8s-check: failed: k8s/bad');
  assert.equal(scans(g).length, 0);
});

test('F163 AC-3 in a directory with no manifests the scanners are not run', () => {
  const f = fixture({ 'k8s/README.md': '# nothing\n' });
  const r = k8sCheck(f, ['--scan', 'trivy', '--scan', 'checkov'], { FAKE_SCAN_EXIT_TRIVY: '1' });
  assert.equal(r.code, 0, combined(r));
  assert.ok(lines(r.stdout).includes('k8s-check: no manifests under k8s'), r.stdout);
  assert.ok(!r.stdout.includes('scan'), r.stdout);
  assert.deepEqual(readLog(f.log), []);
});

test('F163 AC-4 ops rubric.security names k8s-check --scan; k8s-check --help shows --scan <name>; SPEC §4 names both scanner commands', () => {
  const profile = readJson(path.join(REPO, 'profiles', 'ops.json'));
  assert.ok(profile.rubric.security.includes('k8s-check --scan'), profile.rubric.security);

  const r = harness(['k8s-check', '--help'], { cwd: realTmpdir('harness-f163-help-') });
  assert.equal(r.code, 0, combined(r));
  const help = r.stdout.split('\n');
  assert.ok(help[0].startsWith('usage: harness k8s-check') && help[0].includes('--scan <name>'), help[0]);
  assert.ok(help.includes('options:'), r.stdout);
  const options = help.slice(help.indexOf('options:') + 1);
  assert.ok(options.some((l) => l.trim().startsWith('--scan <name>')), r.stdout);

  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s4 = spec.slice(spec.indexOf('\n## 4.'), spec.indexOf('\n## 5.'));
  const at = s4.indexOf('ops 프로필의 기본값');
  assert.ok(at !== -1, 'ops profile defaults paragraph');
  const ops = s4.slice(at);
  for (const w of ['--scan', 'trivy config --quiet --exit-code 1 <', 'checkov -d <', '--quiet --compact --framework kubernetes helm kustomize', 'k8s-check: no policy scanners (--scan trivy|checkov)']) {
    assert.ok(ops.includes(w), w);
  }
});

test('F163 ES-1 --scan without a value or with an unknown name is a usage error (exit 2) listing the allowed names; nothing runs', () => {
  const f = fixture({ 'k8s/a.yaml': DEP, 'k8s/ov/kustomization.yaml': 'resources: []\n', 'k8s/chart/Chart.yaml': 'name: c\n' });
  for (const args of [['--scan'], ['--scan='], ['--scan', 'rm'], ['--scan=rm'], ['--scan', 'trivy', '--scan', 'TRIVY'], ['--scan', 'tflint'], ['--scan', '--dir', 'k8s']]) {
    const r = k8sCheck(f, args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${combined(r)}`);
    assert.match(r.stderr, /trivy, checkov/, args.join(' '));
  }
  assert.deepEqual(readLog(f.log), []);
});

test('F163 ES-2 a scanner named with --scan that is not on PATH: command not found: <name>, exit 127, before kubeconform runs', async () => {
  const f = fixture({ 'k8s/a.yaml': DEP }, { scanners: ['trivy'] });
  const r = k8sCheck(f, ['--scan', 'trivy', '--scan', 'checkov']);
  assert.equal(r.code, 127, combined(r));
  assert.ok(lines(r.stderr).includes('harness k8s-check: command not found: checkov'), r.stderr);
  assert.deepEqual(readLog(f.log), [], 'neither kubeconform nor any scanner ran');

  const g = fixture({ 'k8s/a.yaml': DEP }, { scanners: [] });
  const t = k8sCheck(g, ['--scan=trivy']);
  assert.equal(t.code, 127, combined(t));
  assert.ok(lines(t.stderr).includes('harness k8s-check: command not found: trivy'), t.stderr);
  assert.deepEqual(readLog(g.log), []);

  const { isNotFound } = await import('../lib/exec.mjs');
  const { missingProgram } = await import('../lib/verify.mjs');
  assert.equal(isNotFound({ code: r.code, stderr: r.stderr }), true);
  assert.equal(missingProgram('harness k8s-check --scan trivy --scan checkov', r), 'checkov');
});
