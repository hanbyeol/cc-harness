import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpdir, realTmpdir } from './helpers.mjs';
import { git, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { CWD_ENV, CI_METADATA_ENV, redactor } from '../lib/failures.mjs';
import { BASE_ENV_ALLOWLIST, filteredEnv } from '../lib/exec.mjs';
import * as run from '../lib/run.mjs';

const CWD = ['PWD', 'OLDPWD', 'INIT_CWD'];

// ------------------------------------------------------------------ fixtures (as in f131)
function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id}.txt exists`, check: `node scripts/has.mjs ${id}.txt`, new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-23T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture() {
  const repo = path.join(fs.realpathSync.native(tmpdir('harness-f142-')), 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(repo, 'config', 'user.name', 'Harness Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks'));
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFiles(repo, {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, run: { max_parallel: 1 } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract('F1'),
    'scripts/has.mjs': "import fs from 'node:fs';\nprocess.exit(process.argv.slice(2).every((f) => fs.existsSync(f)) ? 0 : 1);\n",
  });
  commitAll(repo, 'base');
  return repo;
}

const cfgOf = (repo) => resolveConfig(JSON.parse(fs.readFileSync(path.join(repo, '.harness/config.json'), 'utf8')), { label: 'config' });
const PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const verdict = (v) => async (a) => ({ feature: a.featureId, round: a.round, verdict: v, score: v === 'pass' ? 8 : 5, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });
function fakeBuild() {
  const calls = [];
  const fn = async (a) => {
    calls.push({ featureId: a.featureId, real: fs.realpathSync.native(a.cwd) });
    writeFiles(a.cwd, { [`${a.featureId}.txt`]: 'done\n' });
    return { ok: true, costUsd: 0 };
  };
  fn.calls = calls;
  return fn;
}
const runIn = (repo, deps = {}, opts = {}) => run.runFeatures({
  root: repo, config: cfgOf(repo), ...opts,
  deps: { verify: async () => PASSING, evaluate: verdict('pass'), cpus: 8, build: fakeBuild(), ...deps },
});
async function interrupted(repo, deps = {}) {
  const ac = new AbortController();
  const first = async (a) => { ac.abort(); writeFiles(a.cwd, { 'F1.txt': 'x\n' }); return { ok: true, costUsd: 0 }; };
  const r = await runIn(repo, { build: first, ...deps }, { signal: ac.signal });
  assert.equal(r.interrupted, true);
}
const currentFile = (repo) => path.join(repo, '.harness/runs/current.json');

// ------------------------------------------------------------------ criteria
test('F142 AC-1 CWD_ENV is the frozen three names, CI_METADATA_ENV is unchanged, none is in BASE_ENV_ALLOWLIST', () => {
  assert.ok(Object.isFrozen(CWD_ENV));
  assert.deepEqual([...CWD_ENV], CWD);
  assert.equal(CI_METADATA_ENV.length, 45);
  for (const n of CWD) {
    assert.ok(!CI_METADATA_ENV.includes(n), n);
    assert.ok(!BASE_ENV_ALLOWLIST.includes(n), n);
  }
});

test('F142 AC-2 the redactor leaves the current-directory values and their fragments alone', () => {
  const red = redactor({ PWD: '/x/.harness/wt/_integration', OLDPWD: '/home/u/proj/.harness/wt/F1', INIT_CWD: '/home/u/proj' });
  for (const t of ['integration', '/x/.harness/wt/_integration/a.txt', 'wt/F1 done', 'cwd /home/u/proj']) assert.equal(red(t), t);
});

test('F142 AC-3 F130 AC-5 passes when run from a directory named _integration with PWD set to it', () => {
  const dir = path.join(realTmpdir('harness-f142-cwd-'), '_integration');
  fs.mkdirSync(dir);
  const r = spawnSync(process.execPath, [path.join(REPO, 'test/t.mjs'), 'F130 AC-5'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PWD: dir },
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-2000));
});

test('F142 AC-4 with an env value outside the list, worktreeDir is saved unredacted and --resume continues in it', async () => {
  const repo = fixture();
  const env = { PROJECT_ROOT: repo };
  await interrupted(repo, { env });
  const wtDir = fs.realpathSync.native(path.join(repo, '.harness', 'wt'));
  assert.equal(JSON.parse(fs.readFileSync(currentFile(repo), 'utf8')).worktreeDir, wtDir);
  const build = fakeBuild();
  const r = await runIn(repo, { build, env }, { resume: true });
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results[0]));
  assert.ok(build.calls.every((c) => c.real.startsWith(wtDir)), JSON.stringify(build.calls));
  assert.ok(!fs.existsSync(path.join(repo, '[redacted]')));
});

test('F142 AC-5 SPEC SR-2, SR-8 and §8 describe CWD_ENV and worktreeDir', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs/SPEC.md'), 'utf8');
  const sr = (n) => spec.split('\n').find((l) => l.startsWith(`- SR-${n} `));
  for (const s of ['CWD_ENV', 'PWD', 'OLDPWD', 'INIT_CWD', '가림']) assert.ok(sr(2).includes(s), s);
  assert.ok(sr(8).includes('worktreeDir'));
  const s8 = spec.slice(spec.indexOf('## 8.'), spec.indexOf('\n## 9.'));
  assert.match(s8, /worktreeDir` 가 없거나 절대 경로가 아닌/);
});

test('F142 SC-1 secrets outside the list are still redacted', () => {
  const secret = 'sk-secret-123456';
  const red = redactor({ PWD: '/x/.harness/wt/_integration', MY_DIR: '/x/.harness/wt/_integration', API_KEY: secret });
  assert.equal(red('integration'), '[redacted]');
  assert.ok(!red(`a ${secret} b`).includes(secret));
  assert.equal(red(`${secret.slice(4)} tail`).startsWith('[redacted]'), true);
  assert.equal(red(`head ${secret.slice(0, 10)}`).endsWith('[redacted]'), true);
});

test('F142 SC-2 CWD_ENV never reaches a command and does not change the cache key', () => {
  assert.deepEqual(filteredEnv([], { PATH: '/bin', PWD: '/a', OLDPWD: '/b', INIT_CWD: '/c' }), { PATH: '/bin' });
});

test('F142 SC-3 KEEP_UNREDACTED is the base 19 keys plus worktreeDir; a root path in verify output stays redacted', async () => {
  const src = fs.readFileSync(path.join(REPO, 'lib/run/common.mjs'), 'utf8');
  const body = src.slice(src.indexOf('export const KEEP_UNREDACTED'), src.indexOf('export const VALUES_ONLY'));
  const keys = [...body.matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1]);
  assert.equal(keys.length, 20, keys.join());
  assert.ok(keys.includes('worktreeDir'));
  assert.equal(new Set(keys).size, 20);
  const repo = fixture();
  const failing = { pass: false, commands: [{ command: 'x', pass: false, output: `boom at ${repo}/a.txt` }], criteria: [], integrity: PASSING.integrity, warnings: [] };
  await interrupted(repo, { env: { PROJECT_ROOT: repo }, verify: async () => failing });
  const raw = fs.readFileSync(currentFile(repo), 'utf8');
  const wtDir = fs.realpathSync.native(path.join(repo, '.harness', 'wt'));
  assert.equal(JSON.parse(raw).worktreeDir, wtDir);
  assert.ok(!raw.replace(JSON.stringify(wtDir), '').includes(`boom at ${repo}`), 'verify output is redacted');
});

test('F142 ES-1 a current.json with worktreeDir "[redacted]/.harness/wt" resumes in <project>/.harness/wt', async () => {
  const repo = fixture();
  await interrupted(repo);
  const state = JSON.parse(fs.readFileSync(currentFile(repo), 'utf8'));
  state.worktreeDir = '[redacted]/.harness/wt';
  fs.writeFileSync(currentFile(repo), JSON.stringify(state));
  const build = fakeBuild();
  const r = await runIn(repo, { build }, { resume: true });
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results[0]));
  assert.ok(build.calls.length > 0 && build.calls.every((c) => c.real.startsWith(path.join(repo, '.harness', 'wt'))), JSON.stringify(build.calls));
  assert.ok(!fs.existsSync(path.join(repo, '[redacted]')));
});

test('F142 ES-2 odd CWD_ENV values and a duplicate allowlist entry leave the text alone', () => {
  const t = 'integration /x/y wt/F1';
  for (const v of ['', 'short', undefined, 12345678, null]) {
    const env = { PWD: v, OLDPWD: v, INIT_CWD: v };
    assert.equal(redactor(env)(t), t);
    assert.equal(redactor(env, ['PWD'])(t), t);
  }
});
