import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './helpers.mjs';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import * as run from '../lib/run.mjs';

// ------------------------------------------------------------------ fixtures

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-26T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

// A repo on `main` with independent approved features `ids`.
function fixture(ids = ['F1'], files = {}) {
  const state = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': {
      features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: 'standard', depends_on: [], status: 'approved' })),
    },
    'scripts/ok.mjs': 'process.exit(0);\n',
    'doc.md': 'original\n',
    'shared.txt': 'original\n',
    ...files,
  };
  for (const id of ids) state[`.harness/contracts/${id}.json`] = contract(id);
  return gitRepo(state, { branch: null });
}

const cfg = () => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 } });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const statuses = (dir) => Object.fromEntries(readJson(path.join(dir, '.harness/features.json')).features.map((f) => [f.id, f.status]));
const real = (p) => fs.realpathSync.native(p);
const intWt = (dir) => path.join(dir, '.harness', 'wt', '_integration');
const featureWt = (dir, id = 'F1') => path.join(dir, '.harness', 'wt', id);
const isWt = (cwd, dir, id) => fs.existsSync(cwd) && fs.existsSync(featureWt(dir, id)) && real(cwd) === real(featureWt(dir, id));
const isIntegration = (cwd) => real(cwd).endsWith(`${path.sep}_integration`);
const integ = (dir) => git(dir, 'rev-parse', 'harness/integration');
const hasMergeHead = (wt) => spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: wt }).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const resultOf = (r, id = 'F1') => r.results.find((x) => x.feature === id);

const OK_INTEGRITY = { markers: [], harnessPaths: [], testCount: { status: 'unset' } };
const PASSING = { pass: true, commands: [], criteria: [{ id: 'AC-1', pass: true }], integrity: OK_INTEGRITY, warnings: [] };
const FAILING = {
  pass: false, commands: [{ cmd: 'npm test', pass: false, message: 'exit 1', output: 'boom' }],
  criteria: [{ id: 'AC-1', pass: false, message: 'exit 1' }], integrity: OK_INTEGRITY, warnings: [],
};

function fakeEvaluate() {
  return async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });
}

const landOnIntegration = (dir, files) => {
  writeFiles(intWt(dir), files);
  return commitAll(intWt(dir), 'meanwhile on integration');
};

// Fake builder: F1's first build changes doc.md while integration changes it too, so F1's merge
// conflicts; `resolve` is what the resolving builder writes. Other features write <id>.txt.
function conflictBuild(dir, { resolve, integration = { 'doc.md': 'changed on integration\n' }, onResolve } = {}) {
  const calls = [];
  const fn = async (a) => {
    const kind = a.postMergeFailures ? 'recover' : a.conflicts ? 'resolve' : 'build';
    calls.push({ kind, feature: a.featureId });
    if (a.featureId !== 'F1') {
      writeFiles(a.cwd, { [`${a.featureId}.txt`]: 'built\n' });
    } else if (kind === 'build') {
      landOnIntegration(dir, integration);
      writeFiles(a.cwd, { 'F1.txt': 'built\n', 'doc.md': 'changed by F1\n' });
    } else if (kind === 'resolve') {
      if (onResolve) onResolve(a);
      writeFiles(a.cwd, resolve);
    } else {
      writeFiles(a.cwd, { 'fixed.txt': 'fixed\n' });
    }
    return { ok: true, costUsd: 0 };
  };
  fn.calls = calls;
  return fn;
}

// A core git that fails `merge --abort` (and, with failReset, `reset --hard`) in F1's worktree.
function failingGit(dir, { failReset = false, before } = {}) {
  const calls = [];
  const fn = async (args, cwd, opts) => {
    calls.push({ args, cwd });
    const inF1 = isWt(cwd, dir, 'F1');
    if (before) await before(args, cwd, inF1);
    if (inF1 && args[0] === 'merge' && args[1] === '--abort') {
      return { code: 128, stdout: '', stderr: 'fatal: simulated abort failure\n' };
    }
    if (inF1 && failReset && args[0] === 'reset' && args.includes('--hard')) {
      return { code: 128, stdout: '', stderr: 'fatal: simulated reset failure\n' };
    }
    return run.git(args, cwd, opts);
  };
  fn.calls = calls;
  return fn;
}

const runF = (dir, deps) => run.runFeatures({ root: dir, config: cfg(), deps: { evaluate: fakeEvaluate(), verify: async () => PASSING, cpus: 8, ...deps } });

// F1's conflict resolution leaves a marker: the resolution fails and the core aborts the merge.
async function markerLeftRun(opts = {}) {
  const dir = fixture(opts.ids);
  const seen = {};
  const build = conflictBuild(dir, {
    resolve: { 'doc.md': '<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> x\n' },
    onResolve: () => {
      seen.integration = integ(dir);
      seen.head = git(featureWt(dir), 'rev-parse', 'HEAD');
    },
  });
  const r = await runF(dir, { build, git: failingGit(dir, opts) });
  return { dir, r, seen, build };
}

// F1's post-merge verify fails; before the recovery merges integration into F1, F1 gets a commit
// on shared.txt that integration changed too, so the recovery merge conflicts.
async function recoveryConflictRun(opts = {}) {
  const dir = fixture();
  const seen = {};
  const before = async (args, cwd, inF1) => {
    if (inF1 && args[0] === 'merge' && args.some((a) => String(a).includes('post-merge verify recovery'))) {
      writeFiles(cwd, { 'shared.txt': 'changed on the feature\n' });
      seen.head = commitAll(cwd, 'feature side');
      seen.integration = integ(dir);
    }
  };
  // F1's merge into integration is clean: F1 changes only its own file.
  const build = async (a) => {
    landOnIntegration(dir, { 'shared.txt': 'changed on integration\n' });
    writeFiles(a.cwd, { 'F1.txt': 'built\n' });
    return { ok: true, costUsd: 0 };
  };
  const verify = async (a) => (isIntegration(a.cwd) ? FAILING : PASSING);
  const r = await runF(dir, { build, verify, git: failingGit(dir, { ...opts, before }) });
  return { dir, r, seen };
}

// ------------------------------------------------------------------ AC-1
test('F38 AC-1: a failed merge --abort after a failed conflict resolution resets the feature worktree to the pre-merge commit and says so', async () => {
  const { dir, r, seen } = await markerLeftRun();
  const f1 = resultOf(r);
  assert.equal(f1.status, 'blocked', JSON.stringify(f1));
  assert.equal(f1.reason, 'merge_conflict');
  assert.match(f1.detail, /conflict markers left in doc\.md/);
  assert.match(f1.detail, /merge --abort failed/);
  assert.match(f1.detail, /simulated abort failure/);
  assert.ok(f1.detail.includes(`reset to ${seen.head}`), f1.detail);
  const wt = featureWt(dir);
  assert.equal(git(wt, 'rev-parse', 'HEAD'), seen.head);
  assert.equal(git(wt, 'status', '--porcelain'), '');
  assert.equal(statuses(dir).F1, 'blocked');
});

test('F38 AC-1: a failed merge --abort after a failed post-merge verify recovery resets the feature worktree and says so', async () => {
  const { dir, r, seen } = await recoveryConflictRun();
  const f1 = resultOf(r);
  assert.equal(f1.status, 'blocked', JSON.stringify(f1));
  assert.equal(f1.reason, 'post_merge_verify');
  assert.match(f1.detail, /cannot merge harness\/integration into harness\/F1/);
  assert.match(f1.detail, /merge --abort failed/);
  assert.match(f1.detail, /simulated abort failure/);
  assert.ok(f1.detail.includes(`reset to ${seen.head}`), f1.detail);
  assert.equal(git(featureWt(dir), 'rev-parse', 'HEAD'), seen.head);
  assert.equal(git(featureWt(dir), 'status', '--porcelain'), '');
});

// ------------------------------------------------------------------ SC-1
test('F38 SC-1: after the reset no MERGE_HEAD is left in the feature worktree and the integration commit is unchanged (conflict resolution)', async () => {
  const { dir, r, seen } = await markerLeftRun();
  assert.equal(resultOf(r).status, 'blocked');
  assert.ok(seen.integration, 'the resolving builder ran');
  assert.equal(hasMergeHead(featureWt(dir)), false, 'MERGE_HEAD removed');
  assert.equal(integ(dir), seen.integration);
});

test('F38 SC-1: after the reset no MERGE_HEAD is left in the feature worktree and the integration commit is unchanged (post-merge recovery)', async () => {
  const { dir, r, seen } = await recoveryConflictRun();
  assert.equal(resultOf(r).status, 'blocked');
  assert.ok(seen.integration, 'the recovery merge ran');
  assert.equal(hasMergeHead(featureWt(dir)), false, 'MERGE_HEAD removed');
  assert.equal(integ(dir), seen.integration);
});

// ------------------------------------------------------------------ ES-1
test('F38 ES-1: when reset --hard fails too the feature is blocked(merge_conflict) with the worktree path and both failures, and the run goes on', async () => {
  const { dir, r } = await markerLeftRun({ ids: ['F1', 'F2'], failReset: true });
  const f1 = resultOf(r);
  assert.equal(f1.status, 'blocked', JSON.stringify(f1));
  assert.equal(f1.reason, 'merge_conflict');
  assert.ok(f1.detail.includes(featureWt(dir)), f1.detail);
  assert.match(f1.detail, /merge --abort failed/);
  assert.match(f1.detail, /simulated abort failure/);
  assert.match(f1.detail, /simulated reset failure/);
  assert.equal(resultOf(r, 'F2').status, 'passed');
  assert.deepEqual(statuses(dir), { F1: 'blocked', F2: 'passed' });
});

test('F38 ES-1: a failed reset --hard after a failed post-merge verify recovery is blocked(merge_conflict)', async () => {
  const { dir, r } = await recoveryConflictRun({ failReset: true });
  const f1 = resultOf(r);
  assert.equal(f1.status, 'blocked', JSON.stringify(f1));
  assert.equal(f1.reason, 'merge_conflict');
  assert.ok(f1.detail.includes(featureWt(dir)), f1.detail);
  assert.match(f1.detail, /simulated abort failure/);
  assert.match(f1.detail, /simulated reset failure/);
});

// ------------------------------------------------------------------ AC-2
async function resolveRun(resolve, { integration, files } = {}) {
  const dir = fixture(['F1'], files);
  const build = conflictBuild(dir, {
    resolve,
    integration: { 'doc.md': 'changed on integration\n', ...integration },
  });
  const r = await runF(dir, { build });
  return { dir, r, build };
}

test('F38 AC-2: a marker left in a new file that git did not report as conflicted → blocked(merge_conflict)', async () => {
  const { r, build } = await resolveRun({ 'doc.md': 'both\n', 'notes.md': 'text\n<<<<<<< HEAD\nmine\n' });
  assert.equal(build.calls.filter((c) => c.kind === 'resolve').length, 1);
  const f1 = resultOf(r);
  assert.equal(f1.status, 'blocked', JSON.stringify(f1));
  assert.equal(f1.reason, 'merge_conflict');
  assert.match(f1.detail, /conflict markers left in notes\.md/);
  assert.doesNotMatch(f1.detail, /doc\.md/);
});

test('F38 AC-2: a marker left in a tracked file outside the conflict → blocked(merge_conflict)', async () => {
  const { r } = await resolveRun({ 'doc.md': 'both\n', 'shared.txt': 'x\n=======\ny\n' });
  const f1 = resultOf(r);
  assert.equal(f1.status, 'blocked', JSON.stringify(f1));
  assert.equal(f1.reason, 'merge_conflict');
  assert.match(f1.detail, /conflict markers left in shared\.txt/);
});

test('F38 AC-2: a marker added to a file merged cleanly from integration → blocked(merge_conflict)', async () => {
  const { r } = await resolveRun({ 'doc.md': 'both\n', 'int.md': 'from integration\n>>>>>>> theirs\n' }, { integration: { 'int.md': 'from integration\n' } });
  const f1 = resultOf(r);
  assert.equal(f1.status, 'blocked', JSON.stringify(f1));
  assert.match(f1.detail, /conflict markers left in int\.md/);
});

test('F38 AC-2: markers are line-start only in the other changed files too, and a file merged from integration unchanged is not checked → passed', async () => {
  const { dir, r } = await resolveRun(
    { 'doc.md': 'both\n', 'notes.md': 'Git writes `<<<<<<<` and `=======` around a conflict.\n' },
    { integration: { 'setext.md': 'Title\n=======\n' } },
  );
  const f1 = resultOf(r);
  assert.equal(f1.status, 'passed', JSON.stringify(f1));
  assert.match(git(dir, 'show', 'harness/integration:notes.md'), /`<<<<<<<`/);
});

// ------------------------------------------------------------------ AC-3
test('F38 AC-3: git add, commit and reset --hard are serialized git calls; read-only calls are not', () => {
  assert.equal(run.isSerializedGit(['add', '-A']), true);
  assert.equal(run.isSerializedGit(['add', '-A', '--', '.', ':(exclude,literal)x']), true);
  assert.equal(run.isSerializedGit(['commit', '-q', '-m', 'x']), true);
  assert.equal(run.isSerializedGit(['commit', '-q', '--no-edit', '-m', 'x']), true);
  assert.equal(run.isSerializedGit(['reset', '-q', '--hard', 'abc']), true);
  for (const args of [['status', '--porcelain'], ['diff', '--cached', '--quiet'], ['rev-parse', 'HEAD'], ['merge-base', '--is-ancestor', 'a', 'b']]) {
    assert.equal(run.isSerializedGit(args), false, args.join(' '));
  }
});

const changesState = (args) => ['add', 'commit', 'branch', 'merge', 'checkout', 'switch'].includes(args[0])
  || (args[0] === 'worktree' && ['add', 'remove', 'prune'].includes(args[1]))
  || (args[0] === 'reset' && args.includes('--hard'));

test('F38 AC-3: add, commit and reset --hard in feature and integration worktrees never overlap with each other or worktree/branch/merge calls across four parallel features', async () => {
  const ids = ['F1', 'F2', 'F3', 'F4'];
  const dir = fixture(ids);
  const calls = [];
  const recorder = async (args, cwd, opts) => {
    const c = { args, start: now(), end: null };
    if (changesState(args)) {
      calls.push(c);
      await sleep(60); // long enough that two unserialized calls would overlap
    }
    const r = await run.git(args, cwd, opts);
    c.end = now();
    return r;
  };
  // Every integration verify fails once: each feature's merge is rolled back with reset --hard.
  const failedOnce = new Set();
  const verify = async (a) => {
    if (isIntegration(a.cwd) && !failedOnce.has(a.featureId)) { failedOnce.add(a.featureId); return FAILING; }
    return PASSING;
  };
  const build = async (a) => {
    await sleep({ F1: 0, F2: 30, F3: 60, F4: 90 }[a.featureId]);
    writeFiles(a.cwd, { [`${a.featureId}${a.postMergeFailures ? '-fix' : ''}.txt`]: 'x\n' });
    return { ok: true, costUsd: 0 };
  };
  const r = await runF(dir, { build, verify, git: recorder });
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed', F3: 'passed', F4: 'passed' }, JSON.stringify(r.results));
  const count = (pred) => calls.filter((c) => pred(c.args)).length;
  assert.ok(count((a) => a[0] === 'add') >= 4, 'git add per feature');
  assert.ok(count((a) => a[0] === 'commit') >= 4, 'git commit per feature');
  assert.equal(count((a) => a[0] === 'reset'), 4, 'one rollback per feature');
  for (let i = 0; i < calls.length; i += 1) {
    for (let j = i + 1; j < calls.length; j += 1) {
      const [a, b] = [calls[i], calls[j]];
      assert.ok(!(a.start < b.end && b.start < a.end), `git ${a.args.join(' ')} overlaps git ${b.args.join(' ')}`);
    }
  }
});

// ------------------------------------------------------------------ AC-4
const SPEC = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
const RUN_DOC = fs.readFileSync(path.join(REPO, 'docs', 'run.md'), 'utf8');
const s8 = SPEC.slice(SPEC.indexOf('\n## 8. '), SPEC.indexOf('\n## 9. '));

test('F38 AC-4: SPEC §8 describes the three rules', () => {
  for (const s of ['merge --abort` 가 실패하면', 'reset --hard', '해결 과정에서 바뀐 모든 파일', '`git add`·`git commit`·`git reset --hard`']) {
    assert.ok(s8.includes(s), `§8 mentions ${s}`);
  }
});

test('F38 AC-4: docs/run.md describes the three rules', () => {
  for (const s of ['merge --abort` 가 실패하면', 'reset --hard', '해결 과정에서 바뀐 모든 파일', '`git add`·`git commit`·`git reset --hard`']) {
    assert.ok(RUN_DOC.includes(s), `run.md mentions ${s}`);
  }
});
