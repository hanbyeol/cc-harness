import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpdir } from './helpers.mjs';
import { gitRepo, git, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig, loadProfile } from '../lib/config.mjs';
import { verify } from '../lib/verify.mjs';
import { isTestPath } from '../lib/glob.mjs';

// F16: before a new criterion's check runs on base, the feature's added/modified test files
// (verify.test_paths) are placed on the base worktree, so "the feature's test already passes
// on the pre-feature code" is detected even when the test lives in a new file (SPEC §6.3).

const HARNESS = (checks) => ({
  '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
  '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
  '.harness/contracts/F9.json': {
    id: 'F9', title: 'fixture', security_tier: 'standard', version: 1,
    acceptance_criteria: checks.map(([id, check, isNew = true]) => ({ id, criterion: id, check, new: isNew })),
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  },
});

const cfg = (testPaths = ['test/**']) => resolveConfig({
  base_branch: 'main', verify: { commands: [], test_paths: testPaths }, budget: { step_timeout_sec: 30 },
});
const run = (root, config = cfg()) => verify({ root, featureId: 'F9', base: 'main', config });
const byId = (r) => Object.fromEntries(r.criteria.map((c) => [c.id, c]));

// A check script: passes in the main checkout (.git is a directory); on the base worktree
// (.git is a file) it exits 0 only when `cond` (a JS expression over fs) holds.
const BASE_CHECK = (cond) => [
  "import fs from 'node:fs';",
  "if (fs.statSync('.git').isDirectory()) process.exit(0);",
  `process.exit((${cond}) ? 0 : 1);`,
  '',
].join('\n');

// A test file that imports lib/math.mjs and checks `name` (argv[2], default 'add').
const MATH_TEST = (cases) => [
  "import * as m from '../lib/math.mjs';",
  `const cases = { ${cases} };`,
  "const name = process.argv[2] || 'add';",
  'if (!cases[name]) { console.error(`no test ${name}`); process.exit(1); }',
  'process.exit(cases[name](m) ? 0 : 1);',
  '',
].join('\n');
const ADD_CASE = "add: (m) => typeof m.add === 'function' && m.add(1, 2) === 3";
const MUL_CASE = "mul: (m) => typeof m.mul === 'function' && m.mul(2, 3) === 6";
const MATH_FULL = 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n';

// ---------- AC-1 ----------
test('F16 AC-1: a new test file whose behaviour already exists on base is vacuous', async () => {
  const dir = gitRepo({ ...HARNESS([['AC-1', 'node test/math.test.mjs']]), 'lib/math.mjs': MATH_FULL });
  writeFiles(dir, { 'test/math.test.mjs': MATH_TEST(ADD_CASE) });
  commitAll(dir, 'feature adds a test for existing behaviour');
  const c = byId(await run(dir))['AC-1'];
  assert.equal(c.vacuous, true, JSON.stringify(c));
  assert.equal(c.pass, false);
  assert.match(c.message, /already passes on base/);
});

// ---------- AC-2 ----------
test('F16 AC-2: a new test file for behaviour the feature adds is not vacuous', async () => {
  // AC-0 (sub existed on base) proves the file was placed on base in this same run.
  const SUB_CASE = "sub: (m) => typeof m.sub === 'function' && m.sub(3, 1) === 2";
  const dir = gitRepo({
    ...HARNESS([['AC-0', 'node test/math.test.mjs sub'], ['AC-1', 'node test/math.test.mjs']]),
    'lib/math.mjs': 'export const sub = (a, b) => a - b;\n',
  });
  writeFiles(dir, { 'lib/math.mjs': `${MATH_FULL}export const sub = (a, b) => a - b;\n`, 'test/math.test.mjs': MATH_TEST(`${ADD_CASE}, ${SUB_CASE}`) });
  commitAll(dir, 'feature adds add() and its test');
  const r = await run(dir);
  assert.equal(byId(r)['AC-0'].vacuous, true, 'the new test file was placed on base');
  const c = byId(r)['AC-1'];
  assert.equal(c.pass, true, JSON.stringify(c));
  assert.equal(c.vacuous, false);
});

// ---------- AC-3 ----------
test('F16 AC-3: a test added to an existing test file is placed on base (vacuous when behaviour exists)', async () => {
  const dir = gitRepo({
    ...HARNESS([['AC-1', 'node test/math.test.mjs mul']]),
    'lib/math.mjs': MATH_FULL,
    'test/math.test.mjs': MATH_TEST(ADD_CASE),
  });
  writeFiles(dir, { 'test/math.test.mjs': MATH_TEST(`${ADD_CASE}, ${MUL_CASE}`) });
  commitAll(dir, 'feature adds a mul test to an existing file');
  const c = byId(await run(dir))['AC-1'];
  assert.equal(c.vacuous, true, JSON.stringify(c));
  assert.equal(c.pass, false);
});

test('F16 AC-3: an untracked new test file is placed on base (vacuous when behaviour exists)', async () => {
  const dir = gitRepo({ ...HARNESS([['AC-1', 'node test/math.test.mjs']]), 'lib/math.mjs': MATH_FULL });
  writeFiles(dir, { 'test/math.test.mjs': MATH_TEST(ADD_CASE) }); // not committed
  const c = byId(await run(dir))['AC-1'];
  assert.equal(c.vacuous, true, JSON.stringify(c));
  assert.equal(c.pass, false);
});

// ---------- AC-4 ----------
test('F16 AC-4: with empty verify.test_paths nothing is placed on base and a warning names verify.test_paths', async () => {
  const dir = gitRepo({ ...HARNESS([['AC-1', 'node test/math.test.mjs']]), 'lib/math.mjs': MATH_FULL });
  writeFiles(dir, { 'test/math.test.mjs': MATH_TEST(ADD_CASE) });
  commitAll(dir, 'feature adds a test for existing behaviour');
  const r = await run(dir, cfg([]));
  const c = byId(r)['AC-1'];
  assert.equal(c.vacuous, false, 'without test_paths the base run lacks the new test file');
  assert.equal(c.pass, true);
  assert.ok(r.warnings.some((w) => w.includes('verify.test_paths')), JSON.stringify(r.warnings));
});

test('F16 AC-4: no test_paths warning when the contract has no new criterion', async () => {
  const dir = gitRepo({ ...HARNESS([['AC-1', 'node test/math.test.mjs', false]]), 'lib/math.mjs': MATH_FULL });
  writeFiles(dir, { 'test/math.test.mjs': MATH_TEST(ADD_CASE) });
  commitAll(dir, 'regression guard');
  const r = await run(dir, cfg([]));
  assert.ok(!r.warnings.some((w) => w.includes('verify.test_paths')), JSON.stringify(r.warnings));
});

// ---------- AC-5 ----------
const SDLC_TEST_PATHS = ['test/**', 'tests/**', '__tests__/**', '*.test.*', '*.spec.*', '*_test.*', 'test_*.py'];

test('F16 AC-5: the sdlc profile defaults verify.test_paths and a user verify block keeps them', () => {
  const profile = loadProfile('sdlc');
  for (const g of SDLC_TEST_PATHS) assert.ok(profile.verify.test_paths.includes(g), g);
  const merged = resolveConfig({ verify: { commands: ['npm test'] } });
  assert.deepEqual(merged.verify.test_paths, profile.verify.test_paths);
});

test('F16 AC-5: test path matching follows the secret_globs rule', () => {
  const globs = SDLC_TEST_PATHS;
  for (const p of ['test/a.mjs', 'test/deep/b.mjs', 'tests/x.py', '__tests__/c.js',
    'src/app.test.ts', 'pkg/a.spec.js', 'cmd/run_test.go', 'py/test_util.py']) {
    assert.equal(isTestPath(p, globs), true, p);
  }
  // '/' patterns anchor at the project root; patterns without '/' match any segment.
  for (const p of ['src/test/a.mjs', 'lib/math.mjs', 'testdata.json', 'docs/tests.md']) {
    assert.equal(isTestPath(p, globs), false, p);
  }
  assert.equal(isTestPath('src/test/a.mjs', ['**/test/**']), true);
  assert.equal(isTestPath('a.mjs', []), false);
});

// ---------- AC-6 ----------
for (const [label, value, key] of [
  ['a string', 'test/**', "'verify.test_paths'"],
  ['an empty-string element', ['test/**', ''], "'verify.test_paths[1]'"],
  ['a non-string element', [3], "'verify.test_paths[0]'"],
]) {
  test(`F16 AC-6: verify.test_paths as ${label} is config_invalid (exit 2)`, () => {
    const dir = tmpdir('harness-f16-cfg-');
    writeFiles(dir, {
      '.harness/config.json': { verify: { test_paths: value } },
      '.harness/features.json': { features: [] },
    });
    const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'harness.mjs'), 'status'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 2, r.stderr);
    assert.ok(r.stderr.includes(key), r.stderr);
    assert.ok(!r.stderr.includes('    at '), r.stderr);
  });
}

// ---------- AC-7 ----------
test('F16 AC-7: SPEC documents the base-side test overlay and verify.test_paths', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s63 = spec.slice(spec.indexOf('### 6.3'), spec.indexOf('## 7.'));
  assert.ok(s63.includes('verify.test_paths'), '§6.3 names verify.test_paths');
  assert.ok(s63.includes('얹는다'), '§6.3 describes placing the feature tests on base');
  assert.ok(/test_count[^\n]*얹기 전/.test(s63), '§6.3 says test_count runs on base before the overlay');
  assert.ok(/`verify\.test_paths`[^|]*빈 문자열이 아닌 문자열의 배열/.test(spec), 'config shape rule lists verify.test_paths');
});

// ---------- SC-1 ----------
test('F16 SC-1: a base-side symlinked test path is replaced, never written through', async (t) => {
  if (process.platform === 'win32') return; // symlink creation needs privileges on Windows
  const outside = fs.realpathSync(tmpdir('harness-f16-outside-'));
  const target = path.join(outside, 'target.txt');
  fs.writeFileSync(target, 'OUTSIDE ORIGINAL\n');
  const dir = gitRepo({ ...HARNESS([['AC-1', 'node check.mjs']]),
    'check.mjs': BASE_CHECK("fs.lstatSync('test/link.test.mjs').isFile() && fs.readFileSync('test/link.test.mjs', 'utf8') === 'FEATURE CONTENT\\n'") });
  git(dir, 'checkout', '-q', 'main');
  fs.mkdirSync(path.join(dir, 'test'));
  fs.symlinkSync(target, path.join(dir, 'test', 'link.test.mjs'));
  commitAll(dir, 'base has a symlinked test path');
  git(dir, 'checkout', '-q', '-b', 'f16');
  fs.rmSync(path.join(dir, 'test', 'link.test.mjs'));
  writeFiles(dir, { 'test/link.test.mjs': 'FEATURE CONTENT\n' });
  commitAll(dir, 'feature turns the symlink into a regular file');
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const r = await run(dir);
  assert.equal(byId(r)['AC-1'].vacuous, true, 'base got the feature file as a regular file');
  assert.equal(fs.readFileSync(target, 'utf8'), 'OUTSIDE ORIGINAL\n');
});

test('F16 SC-1: a base-side symlinked test directory is replaced, never written through', async (t) => {
  if (process.platform === 'win32') return;
  const outside = fs.realpathSync(tmpdir('harness-f16-outside-'));
  const dir = gitRepo({ ...HARNESS([['AC-1', 'node check.mjs']]),
    'check.mjs': BASE_CHECK("!fs.lstatSync('test').isSymbolicLink() && fs.existsSync('test/new.test.mjs')") });
  git(dir, 'checkout', '-q', 'main');
  fs.symlinkSync(outside, path.join(dir, 'test'));
  commitAll(dir, 'base has a symlinked test directory');
  git(dir, 'checkout', '-q', '-b', 'f16');
  fs.rmSync(path.join(dir, 'test'));
  writeFiles(dir, { 'test/new.test.mjs': 'FEATURE CONTENT\n' });
  commitAll(dir, 'feature makes test/ a real directory');
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const r = await run(dir);
  assert.equal(byId(r)['AC-1'].vacuous, true, 'base got a real test/ directory with the feature file');
  assert.deepEqual(fs.readdirSync(outside), []);
});

// ---------- SC-2 ----------
test('F16 SC-2: a working-tree symlinked test path is not placed on base', async (t) => {
  if (process.platform === 'win32') return;
  const outside = fs.realpathSync(tmpdir('harness-f16-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE CONTENT\n');
  // On base, check.mjs passes only if the regular test file was placed and the symlinked one was not.
  const dir = gitRepo({ ...HARNESS([['AC-1', 'node check.mjs']]),
    'check.mjs': BASE_CHECK("fs.existsSync('test/real.test.mjs') && !fs.existsSync('test/evil.test.mjs')") });
  writeFiles(dir, { 'test/real.test.mjs': 'process.exit(0);\n' });
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'test', 'evil.test.mjs'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const c = byId(await run(dir))['AC-1'];
  assert.equal(c.vacuous, true, JSON.stringify(c));
});

// ---------- SC-3 ----------
test('F16 SC-3: the working tree is unchanged and the base worktree is removed after an overlay run', async () => {
  const dir = gitRepo({ ...HARNESS([['AC-1', 'node test/math.test.mjs']]), 'lib/math.mjs': MATH_FULL });
  writeFiles(dir, { 'test/math.test.mjs': MATH_TEST(ADD_CASE) });
  commitAll(dir, 'feature');
  writeFiles(dir, { 'test/extra.test.mjs': 'process.exit(0);\n', 'lib/math.mjs': `${MATH_FULL}// wip\n` });
  const status = () => git(dir, 'status', '--porcelain', '-uall');
  const before = status();
  const r = await run(dir);
  assert.equal(byId(r)['AC-1'].vacuous, true, 'the overlay ran');
  assert.equal(status(), before);
  const worktrees = git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));
  assert.equal(worktrees.length, 1, worktrees.join('\n'));
});

// ---------- ES-1 ----------
test('F16 ES-1: a test file deleted by the feature stays on base and verify completes', async () => {
  const dir = gitRepo({
    ...HARNESS([['AC-1', 'node check.mjs']]),
    'check.mjs': BASE_CHECK("fs.existsSync('test/old.test.mjs') && fs.existsSync('test/new.test.mjs')"),
    'test/old.test.mjs': 'process.exit(0);\n',
  });
  git(dir, 'rm', '-q', 'test/old.test.mjs');
  writeFiles(dir, { 'test/new.test.mjs': 'process.exit(0);\n' });
  commitAll(dir, 'feature deletes one test file and adds another');
  const c = byId(await run(dir))['AC-1'];
  assert.equal(c.vacuous, true, 'on base test/old.test.mjs is kept and test/new.test.mjs is placed');
});

// ---------- ES-2 ----------
test('F16 ES-2: a base directory that became a test file is replaced; verify exits 0 or 1 without a stack', () => {
  const dir = gitRepo({
    ...HARNESS([['AC-1', 'node test/case']]),
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [], test_paths: ['test/**'] } },
    'test/case/a.mjs': 'process.exit(1);\n',
  });
  git(dir, 'rm', '-q', '-r', 'test/case');
  writeFiles(dir, { 'test/case': 'process.exit(0);\n' });
  commitAll(dir, 'feature turns a directory into a file');
  const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'harness.mjs'), 'verify', 'F9', '--base', 'main', '--json'],
    { cwd: dir, encoding: 'utf8' });
  assert.ok(r.status === 0 || r.status === 1, `exit ${r.status}: ${r.stderr}`);
  assert.ok(!`${r.stdout}${r.stderr}`.includes('    at '), r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.criteria[0].vacuous, true, 'the file replaced the directory on base');
});
