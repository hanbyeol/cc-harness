import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, fakeNodeCli, harness, realTmpdir, readJson } from './helpers.mjs';
import { resolveConfig } from '../lib/config.mjs';

// ------------------------------------------------------------------ fixtures

// Fake `kubeconform`, `kustomize` and `helm` (one script, test/fixtures/fake-k8s.mjs; the tool
// name is its first argument). Each call is appended to $FAKE_K8S_LOG as a JSON line
// { tool, args, cwd, stdin? } (stdin: what kubeconform read for the argument '-').
//   kubeconform exits 1 when a file it reads (or its stdin) contains FAIL_KUBECONFORM.
//   kustomize build <dir> / helm template <dir> print every YAML file under <dir>, or exit 1
//   with an error on stderr when one of them contains FAIL_RENDER.
const FAKE = path.join(REPO, 'test', 'fixtures', 'fake-k8s.mjs');
const TOOLS = ['kubeconform', 'kustomize', 'helm'];
const fakeDir = (tool) => fakeNodeCli(tool, FAKE, [tool]);

const readLog = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const norm = (s) => s.replaceAll('\\', '/');

// A project with `files` ({ 'rel/path': content }); PATH holds only the fakes named in `tools`
// (never the machine's PATH, which may have the real programs).
function fixture(files, { tools = TOOLS } = {}) {
  const root = realTmpdir('harness-f161-');
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
  const log = path.join(realTmpdir('harness-f161-log-'), 'k8s.log');
  const env = { FAKE_K8S_LOG: log, PATH: tools.map(fakeDir).join(path.delimiter) };
  return { root, log, env };
}

const k8sCheck = (f, args = []) => harness(['k8s-check', ...args], { cwd: f.root, env: f.env });
const calls = (f, tool) => readLog(f.log).filter((c) => c.tool === tool).map((c) => ({ ...c, args: c.args.map(norm) }));
const lines = (s) => s.split('\n').map((l) => l.trimEnd()).filter(Boolean);
const DEP = 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n';
// Printed last on stdout when no --scan is given (F163 AC-3).
const NO_SCANNERS = 'k8s-check: no policy scanners (--scan trivy|checkov)';

// ------------------------------------------------------------------ criteria

test('F161 AC-1 ops profile verify is harness k8s-check, listed after tf-check, with --dir and --ignore-missing-schemas', () => {
  assert.deepEqual(resolveConfig({ profile: 'ops' }).verify.commands, ['harness k8s-check']);
  assert.deepEqual(readJson(path.join(REPO, 'profiles', 'ops.json')).verify.commands, ['harness k8s-check']);

  const list = harness(['--help'], { cwd: realTmpdir() });
  const names = lines(list.stdout).map((l) => /^ {2}(\S+) +/.exec(l)?.[1]).filter(Boolean);
  assert.equal(names[names.indexOf('tf-check') + 1], 'k8s-check', list.stdout);

  const help = harness(['k8s-check', '--help'], { cwd: realTmpdir() });
  assert.equal(help.code, 0, help.stderr);
  const options = help.stdout.slice(help.stdout.indexOf('options:'));
  assert.ok(help.stdout.includes('options:'), help.stdout);
  assert.ok(options.includes('--dir'), help.stdout);
  assert.ok(options.includes('--ignore-missing-schemas'), help.stdout);
});

test('F161 AC-1 the default directory is k8s', () => {
  const f = fixture({ 'k8s/app.yaml': DEP, 'other/app.yaml': 'FAIL_KUBECONFORM\n' });
  const r = k8sCheck(f);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), ['ok k8s', NO_SCANNERS]);
  const kc = calls(f, 'kubeconform');
  assert.equal(kc.length, 1);
  assert.deepEqual(kc[0].args, ['-strict', '-summary', 'k8s/app.yaml']);
});

test('F161 AC-2 plain YAML directories are checked with kubeconform -strict -summary <files>; .git, .harness and symlinked dirs are skipped', () => {
  const f = fixture({
    'k8s/a.yaml': DEP,
    'k8s/b.yml': DEP,
    'k8s/notes.txt': 'FAIL_KUBECONFORM\n',
    'k8s/apps/web/svc.yaml': DEP,
    'k8s/.git/x.yaml': 'FAIL_KUBECONFORM\n',
    'k8s/.harness/y.yaml': 'FAIL_KUBECONFORM\n',
  });
  const outside = realTmpdir('harness-f161-outside-');
  fs.writeFileSync(path.join(outside, 'z.yaml'), 'FAIL_KUBECONFORM\n');
  let linked = true;
  try { fs.symlinkSync(outside, path.join(f.root, 'k8s', 'linked'), 'junction'); } catch { linked = false; }

  const r = k8sCheck(f);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), ['ok k8s', 'ok k8s/apps/web', NO_SCANNERS]);
  const kc = calls(f, 'kubeconform');
  assert.deepEqual(kc.map((c) => c.args), [
    ['-strict', '-summary', 'k8s/a.yaml', 'k8s/b.yml'],
    ['-strict', '-summary', 'k8s/apps/web/svc.yaml'],
  ]);
  if (linked) assert.ok(!r.stdout.includes('linked'), r.stdout);
});

test('F161 AC-3 kustomization and Chart.yaml directories are rendered and the output is validated; no descent below them', () => {
  const f = fixture({
    'k8s/overlays/prod/kustomization.yaml': 'resources:\n  - base/deploy.yaml\n',
    'k8s/overlays/prod/base/deploy.yaml': `${DEP}# KUSTOMIZE_PROD\n`,
    'k8s/overlays/dev/kustomization.yml': 'resources: []\n# KUSTOMIZE_DEV\n',
    'k8s/overlays/stage/Kustomization': 'resources: []\n# KUSTOMIZE_STAGE\n',
    'k8s/charts/web/Chart.yaml': 'apiVersion: v2\nname: web\n',
    'k8s/charts/web/templates/deploy.yaml': `${DEP}# HELM_WEB\n`,
  });
  const r = k8sCheck(f);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(lines(r.stdout).sort(), [NO_SCANNERS, 'ok k8s/charts/web', 'ok k8s/overlays/dev', 'ok k8s/overlays/prod', 'ok k8s/overlays/stage']);

  assert.deepEqual(calls(f, 'kustomize').map((c) => c.args).sort(), [
    ['build', 'k8s/overlays/dev'], ['build', 'k8s/overlays/prod'], ['build', 'k8s/overlays/stage'],
  ]);
  assert.deepEqual(calls(f, 'helm').map((c) => c.args), [['template', 'k8s/charts/web']]);

  const kc = calls(f, 'kubeconform');
  assert.equal(kc.length, 4, JSON.stringify(kc));
  for (const c of kc) {
    assert.deepEqual(c.args, ['-strict', '-summary', '-']);
    assert.ok(!c.args.some((a) => a.endsWith('.yaml')), 'template files are not validated on their own');
  }
  const stdins = kc.map((c) => c.stdin).join('\n');
  for (const marker of ['KUSTOMIZE_PROD', 'KUSTOMIZE_DEV', 'KUSTOMIZE_STAGE', 'HELM_WEB']) assert.ok(stdins.includes(marker), marker);
  assert.ok(stdins.includes('# rendered by helm'));
  assert.ok(stdins.includes('# rendered by kustomize'));
});

test('F161 AC-4 a kubeconform failure is reported, the rest is still checked, exit 1 with a final failed list', () => {
  const f = fixture({
    'k8s/a-bad/x.yaml': 'FAIL_KUBECONFORM\n',
    'k8s/b-chart/Chart.yaml': 'name: c\n# FAIL_KUBECONFORM\n',
    'k8s/c-good/y.yaml': DEP,
  });
  const r = k8sCheck(f);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.deepEqual(lines(r.stdout), ['ok k8s/c-good', NO_SCANNERS]);
  const err = lines(r.stderr);
  assert.ok(err.some((l) => l.startsWith('k8s/a-bad: kubeconform failed: ')), r.stderr);
  assert.match(r.stderr, /k8s\/a-bad: kubeconform failed: [^]*Invalid: 1/);
  assert.ok(r.stderr.includes('k8s/b-chart: kubeconform failed: '), r.stderr);
  assert.equal(err.at(-1), 'k8s-check: failed: k8s/a-bad, k8s/b-chart');
  assert.equal(calls(f, 'kubeconform').length, 3);
});

test('F161 AC-5 --ignore-missing-schemas is added to every kubeconform call, and only with the flag', () => {
  const files = {
    'k8s/plain/a.yaml': DEP,
    'k8s/ov/kustomization.yaml': 'resources: []\n',
    'k8s/chart/Chart.yaml': 'name: c\n',
  };
  const without = fixture(files);
  assert.equal(k8sCheck(without).code, 0);
  const kc0 = calls(without, 'kubeconform');
  assert.equal(kc0.length, 3);
  for (const c of kc0) assert.ok(!c.args.includes('-ignore-missing-schemas'), JSON.stringify(c.args));

  const withFlag = fixture(files);
  const r = k8sCheck(withFlag, ['--ignore-missing-schemas']);
  assert.equal(r.code, 0, r.stderr);
  const kc1 = calls(withFlag, 'kubeconform');
  assert.equal(kc1.length, 3);
  for (const c of kc1) {
    assert.ok(c.args.includes('-ignore-missing-schemas'), JSON.stringify(c.args));
    assert.deepEqual(c.args.slice(0, 2), ['-strict', '-summary']);
  }
});

test('F161 AC-6 templates/profile-ops.md names harness k8s-check and ops rubric.tests names k8s-check', () => {
  const t = fs.readFileSync(path.join(REPO, 'templates', 'profile-ops.md'), 'utf8');
  assert.ok(t.includes('`harness k8s-check`'), t);
  assert.ok(t.includes('`kubeconform`'), t);
  for (const w of ['kustomize', 'helm', 'offline', 'verify']) assert.ok(t.includes(w), w);
  assert.ok(t.replace(/\n+$/, '').split('\n').length <= 30);
  assert.ok(readJson(path.join(REPO, 'profiles', 'ops.json')).rubric.tests.includes('k8s-check'));
});

test('F161 AC-7 SPEC §4 has the ops profile defaults for harness k8s-check', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s4 = spec.slice(spec.indexOf('\n## 4.'), spec.indexOf('\n## 5.'));
  const at = s4.indexOf('ops 프로필의 기본값');
  assert.ok(at !== -1, 'ops profile defaults paragraph');
  const ops = s4.slice(at);
  for (const w of ['harness k8s-check', 'kubeconform -strict -summary', 'kustomize build', 'helm template', '--dir', '--ignore-missing-schemas', '127']) {
    assert.ok(ops.includes(w), w);
  }
});

test('F161 ES-1 a missing kubeconform, kustomize or helm is exit 127 before any tool runs', () => {
  const files = { 'k8s/plain/a.yaml': DEP, 'k8s/ov/kustomization.yaml': 'resources: []\n', 'k8s/chart/Chart.yaml': 'name: c\n' };
  for (const missing of TOOLS) {
    const f = fixture(files, { tools: TOOLS.filter((t) => t !== missing) });
    const r = k8sCheck(f);
    assert.equal(r.code, 127, `${missing}: ${r.stdout}${r.stderr}`);
    assert.ok(lines(r.stderr).includes(`harness k8s-check: command not found: ${missing}`), r.stderr);
    assert.deepEqual(readLog(f.log), [], `${missing}: nothing ran`);
  }

  // kustomize and helm are needed only when such directories exist.
  const plain = fixture({ 'k8s/a.yaml': DEP }, { tools: ['kubeconform'] });
  const r = k8sCheck(plain);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), ['ok k8s', NO_SCANNERS]);
});

test('F161 ES-2 a failed render is reported, not validated, and the run ends with exit 1', () => {
  const f = fixture({
    'k8s/a-ov/kustomization.yaml': 'resources: []\n# FAIL_RENDER\n',
    'k8s/b-chart/Chart.yaml': 'name: c\n',
    'k8s/b-chart/templates/x.yaml': '# FAIL_RENDER\n',
    'k8s/c-good/kustomization.yaml': 'resources: []\n# GOOD_RENDER\n',
  });
  const r = k8sCheck(f);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const err = lines(r.stderr);
  assert.ok(err.some((l) => l.startsWith('k8s/a-ov: render failed: ') && l.includes('kustomize cannot render')), r.stderr);
  assert.ok(err.some((l) => l.startsWith('k8s/b-chart: render failed: ') && l.includes('helm cannot render')), r.stderr);
  assert.equal(err.at(-1), 'k8s-check: failed: k8s/a-ov, k8s/b-chart');
  assert.deepEqual(lines(r.stdout), ['ok k8s/c-good', NO_SCANNERS]);
  const kc = calls(f, 'kubeconform');
  assert.equal(kc.length, 1);
  assert.ok(kc[0].stdin.includes('GOOD_RENDER'));
});

test('F161 ES-3 a missing directory and an unknown argument are usage errors; no manifests is exit 0', () => {
  const none = fixture({ 'other/a.yaml': DEP });
  let r = k8sCheck(none);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.ok(r.stderr.includes('k8s: not a directory'), r.stderr);

  r = k8sCheck(none, ['--dir', 'nope']);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes('nope: not a directory'), r.stderr);

  r = k8sCheck(none, ['--dir', 'other/a.yaml']);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes('other/a.yaml: not a directory'), r.stderr);

  r = k8sCheck(none, ['--bogus']);
  assert.equal(r.code, 2, r.stderr);
  r = k8sCheck(none, ['--dir']);
  assert.equal(r.code, 2, r.stderr);
  assert.deepEqual(readLog(none.log), []);

  r = k8sCheck(none, ['--dir', 'other']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), ['ok other', NO_SCANNERS]);

  const empty = fixture({ 'k8s/README.md': '# nothing\n', 'k8s/sub/notes.txt': 'x\n' });
  r = k8sCheck(empty);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), ['k8s-check: no manifests under k8s', NO_SCANNERS]);
  assert.deepEqual(readLog(empty.log), []);
});
