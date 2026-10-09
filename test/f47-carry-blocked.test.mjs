import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { BIN, REPO, tmpdir } from './helpers.mjs';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import * as run from '../lib/run.mjs';
import { parseArgs } from '../lib/commands/run.mjs';

const FAKE_CLI = path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs');

// ------------------------------------------------------------------ fixtures

const SCRIPTS = {
  'scripts/has.mjs': "import fs from 'node:fs';\nprocess.exit(process.argv.slice(2).every((f) => fs.existsSync(f)) ? 0 : 1);\n",
  // Records where it ran (argv[2] is a marker directory); on the base worktree it then sleeps
  // 20 s, long enough to be interrupted and short enough not to hang a vacuity run.
  'scripts/slow.mjs': [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const base = path.basename(process.cwd()).startsWith('harness-base-');",
    "fs.writeFileSync(path.join(process.argv[2], base ? 'base' : 'head'), process.cwd());",
    'if (base) setTimeout(() => process.exit(1), 20000);',
    '',
  ].join('\n'),
};

function contract(id, check = `node scripts/has.mjs ${id}.txt`) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id}.txt exists`, check, new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-23T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture(ids = ['F1'], { check } = {}) {
  const files = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: 'standard', depends_on: [], status: 'approved' })) },
    ...SCRIPTS,
  };
  for (const id of ids) files[`.harness/contracts/${id}.json`] = contract(id, check);
  return gitRepo(files, { branch: null });
}

const cfg = () => resolveConfig({
  base_branch: 'main', run: { max_parallel: 1 }, verify: { commands: [] }, budget: { step_timeout_sec: 60 },
});
const INTEG = cfg().integration_branch;

const PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const verify = async () => PASSING;
const verdict = (v) => async (a) => ({ feature: a.featureId, round: a.round, verdict: v, score: v === 'pass' ? 8 : 5, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });

// Fake builder: `script(a)` runs in the worktree (default: writes <id>.txt); every call records
// its arguments, the prompt the real builderPrompt renders from them, and what the worktree
// held before the builder touched it.
function fakeBuild(script) {
  const calls = [];
  const fn = async (a) => {
    calls.push({
      featureId: a.featureId, cwd: a.cwd, real: fs.realpathSync.native(a.cwd), carriedWork: a.carriedWork,
      prompt: run.builderPrompt({ rolePrompt: 'ROLE', ...a }),
      had: fs.existsSync(path.join(a.cwd, `${a.featureId}.txt`)),
      head: git(a.cwd, 'rev-parse', 'HEAD'),
    });
    if (script) return script(a);
    writeFiles(a.cwd, { [`${a.featureId}.txt`]: 'done\n' });
    return { ok: true, costUsd: 0 };
  };
  fn.calls = calls;
  return fn;
}

const runF = (dir, deps, opts = {}) => run.runFeatures({ root: dir, config: cfg(), ...opts, deps: { verify, evaluate: verdict('pass'), cpus: 8, ...deps } });
const wt = (dir, id = 'F1') => path.join(dir, '.harness', 'wt', id);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// The feature is re-approved after it was blocked: its status goes back to approved.
function reapprove(dir, ids = ['F1']) {
  const file = path.join(dir, '.harness/features.json');
  const data = readJson(file);
  for (const f of data.features) if (ids.includes(f.id)) f.status = 'approved';
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

// A first run whose evaluator stops F1 as needs-human: the worktree and branch stay behind.
async function leaveBlocked(dir, script) {
  const r = await runF(dir, { build: fakeBuild(script), evaluate: verdict('needs-human') }, { ids: ['F1'] });
  assert.deepEqual([r.results[0].status, r.results[0].reason], ['blocked', 'needs_human']);
  assert.ok(fs.existsSync(wt(dir)), 'the blocked worktree is kept');
  reapprove(dir);
}

const commitWork = (a) => {
  writeFiles(a.cwd, { 'F1.txt': 'first\n', 'lib/part.txt': 'part\n' });
  commitAll(a.cwd, 'builder F1');
  return { ok: true, costUsd: 0 };
};
const dirtyWork = (a) => {
  writeFiles(a.cwd, { 'F1.txt': 'first\n', 'lib/part.txt': 'part\n' });
  return { ok: true, costUsd: 0 };
};

// ------------------------------------------------------------------ AC-1
test('F47 AC-1: a re-approved feature continues in its leftover worktree; the prompt says so and lists the changed files', async () => {
  const dir = fixture();
  await leaveBlocked(dir, commitWork);
  const before = git(wt(dir), 'rev-parse', 'HEAD');
  const leftover = fs.realpathSync.native(wt(dir));
  const build = fakeBuild();
  const r = await runF(dir, { build });
  assert.deepEqual([r.results[0].status, r.results[0].reason], ['passed', null], JSON.stringify(r.results[0]));
  assert.equal(build.calls.length, 1);
  const [call] = build.calls;
  assert.equal(call.real, leftover, 'the build runs in the leftover worktree');
  assert.equal(call.had, true, 'the earlier work is there when the builder starts');
  assert.equal(call.head, before, 'the branch was not recreated');
  assert.match(call.prompt, /previous attempt/i);
  assert.match(call.prompt, /working tree/i);
  assert.match(call.prompt, /^- F1\.txt$/m);
  assert.match(call.prompt, /^- lib\/part\.txt$/m);
  assert.deepEqual(call.carriedWork.files, ['F1.txt', 'lib/part.txt']);
});

test('F47 AC-1: without a leftover worktree the prompt has no carried-work note', async () => {
  const dir = fixture();
  const build = fakeBuild();
  const r = await runF(dir, { build });
  assert.equal(r.results[0].status, 'passed');
  assert.doesNotMatch(build.calls[0].prompt, /previous attempt/i);
  assert.equal(r.results[0].carried, undefined);
});

// ------------------------------------------------------------------ AC-2
test('F47 AC-2: run --fresh removes the leftover worktree and branch and starts from the base', async () => {
  const dir = fixture();
  await leaveBlocked(dir, commitWork);
  const old = git(dir, 'rev-parse', 'refs/heads/harness/F1');
  const base = git(dir, 'rev-parse', `refs/heads/${INTEG}`);
  const build = fakeBuild();
  const r = await runF(dir, { build }, { ids: ['F1'], fresh: true });
  assert.deepEqual([r.results[0].status, r.results[0].reason], ['passed', null], JSON.stringify(r.results[0]));
  const [call] = build.calls;
  assert.equal(call.had, false, 'the earlier work is gone');
  assert.equal(fs.existsSync(path.join(call.cwd, 'lib', 'part.txt')), false);
  assert.equal(call.head, base, 'the new branch starts at the integration commit');
  assert.doesNotMatch(call.prompt, /previous attempt/i);
  assert.notEqual(spawnSync('git', ['merge-base', '--is-ancestor', old, INTEG], { cwd: dir }).status, 0, 'the old commit was not merged');
  assert.equal(r.results[0].carried, undefined);
});

test('F47 AC-2: --fresh is parsed by the CLI and needs feature ids', () => {
  assert.deepEqual(parseArgs(['--fresh', 'F1']).fresh, true);
  assert.deepEqual(parseArgs(['F1', '--fresh']).ids, ['F1']);
  assert.throws(() => parseArgs(['--fresh']), /--fresh/);
  assert.throws(() => parseArgs(['--fresh', '--resume']), /--fresh|--resume/);
  const dir = fixture();
  const r = spawnSync(process.execPath, [BIN, 'run', '--fresh'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /usage: harness run/);
});

// ------------------------------------------------------------------ AC-3
test('F47 AC-3: uncommitted changes in the leftover worktree are committed as carried work before the build', async () => {
  const dir = fixture();
  // The core commits each build attempt before its verify (F92), so the uncommitted work is left
  // in the blocked worktree afterwards, as a timed-out last attempt or an eval repro leaves it.
  await leaveBlocked(dir, () => ({ ok: true, costUsd: 0 }));
  dirtyWork({ cwd: wt(dir) });
  assert.notEqual(git(wt(dir), 'status', '--porcelain'), '', 'the fixture leaves uncommitted work');
  const build = fakeBuild();
  const r = await runF(dir, { build });
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results[0]));
  assert.equal(r.results[0].carried, true);
  const subjects = git(dir, 'log', '--format=%s', INTEG).split('\n');
  assert.ok(subjects.includes('harness: F1 carried work'), subjects.join('\n'));
  const sha = git(dir, 'log', '--format=%H', '--grep=^harness: F1 carried work$', INTEG);
  assert.deepEqual(git(dir, 'show', '--name-only', '--format=', sha).split('\n').sort(), ['F1.txt', 'lib/part.txt']);
  assert.equal(build.calls[0].head, sha, 'the builder starts on the carried-work commit');
  assert.match(fs.readFileSync(r.report, 'utf8'), /carried: true/);
});

// ------------------------------------------------------------------ SC-1
test('F47 SC-1: a leftover worktree on another branch is not taken over — blocked(worktree) with its path and branch', async () => {
  const dir = fixture();
  await leaveBlocked(dir, commitWork);
  git(wt(dir), 'checkout', '-q', '-b', 'someone-else');
  writeFiles(wt(dir), { 'mine.txt': 'keep\n' });
  const head = git(wt(dir), 'rev-parse', 'HEAD');
  const build = fakeBuild();
  const r = await runF(dir, { build });
  assert.deepEqual([r.results[0].status, r.results[0].reason], ['blocked', 'worktree']);
  assert.ok(r.results[0].detail.includes(wt(dir)) || r.results[0].detail.includes('.harness/wt/F1'), r.results[0].detail);
  assert.match(r.results[0].detail, /someone-else/);
  assert.equal(build.calls.length, 0);
  assert.equal(git(wt(dir), 'rev-parse', 'HEAD'), head, 'nothing was committed');
  assert.match(git(wt(dir), 'status', '--porcelain'), /mine\.txt/);
});

test('F47 SC-1: a detached leftover worktree is not taken over', async () => {
  const dir = fixture();
  await leaveBlocked(dir, commitWork);
  git(wt(dir), 'checkout', '-q', '--detach');
  const build = fakeBuild();
  const r = await runF(dir, { build });
  assert.deepEqual([r.results[0].status, r.results[0].reason], ['blocked', 'worktree']);
  assert.match(r.results[0].detail, /harness\/F1/);
  assert.match(r.results[0].detail, /detached/);
  assert.equal(build.calls.length, 0);
});

test('F47 SC-1: a directory that is not a registered worktree is not taken over', async () => {
  const dir = fixture();
  git(dir, 'branch', 'harness/F1', 'main');
  writeFiles(dir, { '.harness/wt/F1/F1.txt': 'not a worktree\n' });
  const build = fakeBuild();
  const r = await runF(dir, { build });
  assert.deepEqual([r.results[0].status, r.results[0].reason], ['blocked', 'worktree']);
  assert.ok(r.results[0].detail.includes(wt(dir)) || r.results[0].detail.includes('.harness/wt/F1'), r.results[0].detail);
  assert.match(r.results[0].detail, /harness\/F1/);
  assert.match(r.results[0].detail, /not a registered worktree/);
  assert.equal(build.calls.length, 0);
  assert.equal(fs.readFileSync(path.join(wt(dir), 'F1.txt'), 'utf8'), 'not a worktree\n');
});

// ------------------------------------------------------------------ ES-1
test('F47 ES-1: --fresh that cannot remove the worktree blocks that feature with the git error; the others go on', async () => {
  const dir = fixture(['F1', 'F2']);
  await leaveBlocked(dir, commitWork);
  git(dir, 'worktree', 'lock', '--reason', 'kept by hand', wt(dir));
  const build = fakeBuild();
  const r = await runF(dir, { build }, { ids: ['F1', 'F2'], fresh: true });
  const byId = Object.fromEntries(r.results.map((x) => [x.feature, x]));
  assert.deepEqual([byId.F1.status, byId.F1.reason], ['blocked', 'worktree']);
  assert.match(byId.F1.detail, /--fresh/);
  assert.match(byId.F1.detail, /kept by hand/, 'the git error (with the lock reason) is in the detail');
  assert.equal(byId.F2.status, 'passed');
  assert.deepEqual(build.calls.map((c) => c.featureId), ['F2']);
  assert.ok(fs.existsSync(path.join(wt(dir), 'F1.txt')), 'the locked worktree keeps its work');
});

// ------------------------------------------------------------------ AC-4
// Each case runs the CLI with its own temporary directory (TMPDIR/TEMP/TMP) and looks for
// what the core leaves there after the process has exited.
function tempEnv() {
  const t = fs.realpathSync.native(tmpdir('harness-f47-tmp-'));
  return { dir: t, env: { ...process.env, TMPDIR: t, TEMP: t, TMP: t } };
}
const leftovers = (t) => fs.readdirSync(t).filter((n) => /^harness-(base|no-hooks)-/.test(n));

function spawnCli(args, cwd, env) {
  const child = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exited, out: () => out };
}

async function until(fn, what, ms = 90000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// F1 is done: `harness run` has nothing to run and skips the role preflight.
function markPassed(dir) {
  const file = path.join(dir, '.harness/features.json');
  const data = readJson(file);
  data.features[0].status = 'passed';
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

test('F47 AC-4: verify that ends normally leaves no temporary path', () => {
  const dir = fixture();
  writeFiles(dir, { 'F1.txt': 'feature\n' }); // the new criterion passes on head, so base is checked out
  const t = tempEnv();
  const r = spawnSync(process.execPath, [BIN, 'verify', 'F1'], { cwd: dir, env: t.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(leftovers(t.dir), []);
});

test('F47 AC-4: verify that ends with an error leaves no temporary path', () => {
  const dir = fixture();
  writeFiles(dir, { 'F1.txt': 'feature\n' });
  // The base worktree cannot be registered: `git worktree add` fails after the temporary directory exists.
  fs.writeFileSync(path.join(dir, '.git', 'worktrees'), 'not a directory\n');
  const t = tempEnv();
  const r = spawnSync(process.execPath, [BIN, 'verify', 'F1'], { cwd: dir, env: t.env, encoding: 'utf8' });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /base worktree/);
  assert.deepEqual(leftovers(t.dir), []);
});

test('F47 AC-4: verify interrupted by SIGINT leaves no temporary path', { timeout: 180000 }, async () => {
  if (process.platform === 'win32') return; // no POSIX signal delivery to a child on Windows
  const marks = tmpdir('harness-f47-marks-');
  const dir = fixture(['F1'], { check: `node scripts/slow.mjs ${marks}` });
  const t = tempEnv();
  const cli = spawnCli(['verify', 'F1'], dir, t.env);
  try {
    // The criterion passed on head and its base vacuity run has started in harness-base-*.
    await until(() => fs.existsSync(path.join(marks, 'base')), `the base run (${cli.out()})`);
    assert.equal(leftovers(t.dir).filter((n) => n.startsWith('harness-base-')).length, 1);
    cli.child.kill('SIGINT');
    assert.equal(await cli.exited, 130, cli.out());
    assert.deepEqual(leftovers(t.dir), []);
  } finally {
    cli.child.kill('SIGKILL');
  }
});

test('F47 AC-4: run that ends normally leaves no temporary path', () => {
  const dir = fixture();
  markPassed(dir); // nothing to run: the run still makes its core git calls
  const t = tempEnv();
  const r = spawnSync(process.execPath, [BIN, 'run'], { cwd: dir, env: t.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no approved, executable features/);
  assert.deepEqual(leftovers(t.dir), []);
});

test('F47 AC-4: run that ends with an error leaves no temporary path', () => {
  const dir = fixture();
  writeFiles(dir, { '.harness/config.json': { profile: 'sdlc', base_branch: 'main', integration_branch: 'Harness/Integration', verify: { commands: [] } } });
  commitAll(dir, 'integration branch config');
  git(dir, 'branch', 'harness/integration'); // differs only by case: the run refuses after its first git calls
  markPassed(dir); // no preflight: the run gets to its git calls without role CLIs
  const t = tempEnv();
  const r = spawnSync(process.execPath, [BIN, 'run'], { cwd: dir, env: t.env, encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /differs only by case/);
  assert.deepEqual(leftovers(t.dir), []);
});

test('F47 AC-4: run interrupted by SIGINT leaves no temporary path', { timeout: 180000 }, async () => {
  if (process.platform === 'win32') return; // no POSIX signal delivery to a child on Windows
  const dir = fixture();
  const pidFile = path.join(tmpdir('harness-pid-'), 'builder.pid');
  writeFiles(dir, {
    '.harness/config.json': {
      profile: 'sdlc', base_branch: 'main', verify: { commands: [] },
      roles: { builder: 'generic', evaluator: 'generic', 'security-reviewer': 'generic' },
      adapters: { generic: { command: [process.execPath, FAKE_CLI, 'sleep', pidFile], read_only_command: [process.execPath, FAKE_CLI, 'echo-args'] } },
    },
  });
  commitAll(dir, 'slow builder config');
  const t = tempEnv();
  const cli = spawnCli(['run'], dir, t.env);
  let builderPid = null;
  try {
    await until(() => fs.existsSync(pidFile) && (builderPid = Number(fs.readFileSync(pidFile, 'utf8')) || null), `the slow builder (${cli.out()})`);
    assert.equal(leftovers(t.dir).filter((n) => n.startsWith('harness-no-hooks-')).length, 1, 'the run made its hook-free directory');
    cli.child.kill('SIGINT');
    assert.equal(await cli.exited, 130, cli.out());
    assert.deepEqual(leftovers(t.dir), []);
  } finally {
    cli.child.kill('SIGKILL');
    if (builderPid) { try { process.kill(builderPid, 'SIGKILL'); } catch { /* gone */ } }
  }
});

// ------------------------------------------------------------------ AC-5
test('F47 AC-5: SPEC §8 and docs/run.md explain carrying blocked work, --fresh and temporary path cleanup', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs/SPEC.md'), 'utf8');
  const s8 = spec.slice(spec.indexOf('## 8.'), spec.indexOf('\n## ', spec.indexOf('## 8.') + 1));
  const doc = fs.readFileSync(path.join(REPO, 'docs/run.md'), 'utf8');
  for (const [name, text] of [['SPEC §8', s8], ['docs/run.md', doc]]) {
    assert.match(text, /이어받기/, `${name} names carrying the work`);
    assert.ok(text.includes('harness: F<n> carried work'), `${name} names the carried-work commit`);
    assert.ok(text.includes('carried: true'), `${name} names the report field`);
    assert.ok(text.includes('--fresh'), `${name} names --fresh`);
    assert.match(text, /blocked\(`?worktree`?\)/, `${name} says when it is blocked(worktree)`);
    assert.ok(text.includes('harness-base-') && text.includes('harness-no-hooks-'), `${name} names the temporary paths`);
    assert.match(text, /SIGINT/, `${name} says the paths are removed on SIGINT too`);
  }
  assert.doesNotMatch(s8, /이전 run 의 `harness\/F\{n\}` 브랜치가 남아 있으면 자동으로 지우지 않는다\(작업 보존\) — 해당 기능은 blocked/,
    'the old "leftover branch blocks" rule is replaced');
});
