// F76: a new run first brings the integration branch up to date with the base branch —
// a --no-ff merge when both have their own commits, a fast-forward when integration has none.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import * as run from '../lib/run.mjs';

// ------------------------------------------------------------------ fixtures

const INTEG = 'harness/integration';
const SYNC_SUBJECT = `harness: sync ${INTEG} with main`;

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-05T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

// A repo on `main` with F1 (`status`: approved runs it, passed leaves nothing to run).
function fixture({ status = 'approved' } = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status }] },
    '.harness/contracts/F1.json': contract('F1'),
    'scripts/ok.mjs': 'process.exit(0);\n',
    'doc.md': 'original\n',
  }, { branch: null });
}

// Commits `files` on `branch` (created from main when missing) and returns to main.
function commitOn(dir, branch, files, message) {
  const exists = git(dir, 'branch', '--list', branch) !== '';
  git(dir, 'checkout', '-q', ...(exists ? [branch] : ['-b', branch]));
  writeFiles(dir, files);
  const sha = commitAll(dir, message);
  git(dir, 'checkout', '-q', 'main');
  return sha;
}

const cfg = (extra = {}) => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, ...extra });
const intWt = (dir) => path.join(dir, '.harness', 'wt', '_integration');
const featureWt = (dir) => path.join(dir, '.harness', 'wt', 'F1');
const sha = (dir, ref) => git(dir, 'rev-parse', ref);
const isAncestor = (dir, a, b) => {
  try { git(dir, 'merge-base', '--is-ancestor', a, b); return true; } catch { return false; }
};
const statusOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.harness', 'features.json'), 'utf8')).features[0].status;
// A base commit made while a run is saved: only late.txt, not the run's own files.
const commitLate = (dir) => {
  writeFiles(dir, { 'late.txt': 'arrived after the run started\n' });
  git(dir, 'add', 'late.txt');
  git(dir, 'commit', '-q', '-m', 'late base work');
  return sha(dir, 'HEAD');
};
const subjects = (dir, ref) => git(dir, 'log', '--format=%s', ref).split(/\r?\n/);

const OK_INTEGRITY = { markers: [], harnessPaths: [], testCount: { status: 'unset' } };
const PASSING = { pass: true, commands: [], criteria: [{ id: 'AC-1', pass: true }], integrity: OK_INTEGRITY, warnings: [] };
const evaluate = async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });

// A build that records the feature worktree's HEAD and writes F1.txt.
function recordingBuild() {
  const calls = [];
  const fn = async (a) => {
    calls.push({ cwd: a.cwd, head: sha(a.cwd, 'HEAD') });
    writeFiles(a.cwd, { [`${a.featureId}.txt`]: 'built\n' });
    return { ok: true, costUsd: 0 };
  };
  fn.calls = calls;
  return fn;
}

// git calls the core made, in order.
function recordingGit() {
  const calls = [];
  const fn = async (args, cwd, opts) => { calls.push(args); return run.git(args, cwd, opts); };
  fn.calls = calls;
  return fn;
}

function runF(dir, deps = {}, opts = {}) {
  const logs = [];
  const p = run.runFeatures({
    root: dir, config: cfg(), parallel: 1, ...opts,
    deps: { build: recordingBuild(), evaluate, verify: async () => PASSING, cpus: 8, log: (m) => logs.push(m), warn: () => {}, ...deps },
  });
  return { p, logs };
}

const baseSyncLine = (report) => fs.readFileSync(report, 'utf8').split('\n').find((l) => l.startsWith('- base sync: '));

// ------------------------------------------------------------------ AC-1

test('F76 AC-1: diverged integration and base are merged --no-ff before the feature worktree is created', async () => {
  const dir = fixture();
  const integBefore = commitOn(dir, INTEG, { 'integ.txt': 'integration only\n' }, 'integration work');
  writeFiles(dir, { 'base.txt': 'base only\n' });
  const base = commitAll(dir, 'base work');
  const build = recordingBuild();
  const { p } = runF(dir, { build });
  const r = await p;
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results));
  // The feature worktree started on top of the sync merge: it contains both sides.
  const head = build.calls[0].head;
  assert.ok(isAncestor(dir, base, head), 'base commit is in the feature worktree HEAD');
  assert.ok(isAncestor(dir, integBefore, head), 'integration commit is in the feature worktree HEAD');
  assert.equal(git(dir, 'log', '-1', '--format=%s', head), SYNC_SUBJECT);
  assert.deepEqual(git(dir, 'log', '-1', '--format=%P', head).split(' '), [integBefore, base]);
  assert.ok(subjects(dir, INTEG).includes(SYNC_SUBJECT));
});

// ------------------------------------------------------------------ AC-2

test('F76 AC-2: an integration branch behind base is fast-forwarded without a merge commit', async () => {
  const dir = fixture({ status: 'passed' });
  git(dir, 'branch', INTEG, 'main');
  writeFiles(dir, { 'base.txt': 'base only\n' });
  const base = commitAll(dir, 'base work');
  const { p } = runF(dir);
  await p;
  assert.equal(sha(dir, INTEG), base);
  assert.ok(!subjects(dir, INTEG).includes(SYNC_SUBJECT));
});

test('F76 AC-2: the fast-forwarded integration is the base of the feature worktree', async () => {
  const dir = fixture();
  git(dir, 'branch', INTEG, 'main');
  writeFiles(dir, { 'base.txt': 'base only\n' });
  const base = commitAll(dir, 'base work');
  const build = recordingBuild();
  const { p } = runF(dir, { build });
  await p;
  assert.equal(build.calls[0].head, base);
});

// ------------------------------------------------------------------ AC-3

test('F76 AC-3: integration that already contains base is left alone and git merge is not called', async () => {
  const dir = fixture({ status: 'passed' });
  const integBefore = commitOn(dir, INTEG, { 'integ.txt': 'integration only\n' }, 'integration work');
  const g = recordingGit();
  const { p, logs } = runF(dir, { git: g });
  await p;
  assert.ok(logs.includes(`${INTEG} is up to date with main`), logs.join('\n'));
  assert.equal(sha(dir, INTEG), integBefore);
  assert.deepEqual(g.calls.filter((a) => a[0] === 'merge'), []);
});

test('F76 AC-3: integration equal to base is left alone and git merge is not called', async () => {
  const dir = fixture({ status: 'passed' });
  git(dir, 'branch', INTEG, 'main');
  const before = sha(dir, INTEG);
  const g = recordingGit();
  const { p, logs } = runF(dir, { git: g });
  await p;
  assert.ok(logs.includes(`${INTEG} is up to date with main`), logs.join('\n'));
  assert.equal(sha(dir, INTEG), before);
  assert.deepEqual(g.calls.filter((a) => a[0] === 'merge'), []);
});

// ------------------------------------------------------------------ AC-4

test('F76 AC-4: a merge sync prints and reports "merged <n> commits"', async () => {
  const dir = fixture({ status: 'passed' });
  commitOn(dir, INTEG, { 'integ.txt': 'integration only\n' }, 'integration work');
  writeFiles(dir, { 'base.txt': 'one\n' });
  commitAll(dir, 'base work 1');
  writeFiles(dir, { 'base2.txt': 'two\n' });
  commitAll(dir, 'base work 2');
  const { p, logs } = runF(dir);
  const r = await p;
  const msg = `synced ${INTEG} with main: merged 2 commits`;
  assert.ok(logs.includes(msg), logs.join('\n'));
  assert.equal(baseSyncLine(r.report), `- base sync: ${msg}`);
});

test('F76 AC-4: a fast-forward sync prints and reports "fast-forwarded <n> commits"', async () => {
  const dir = fixture({ status: 'passed' });
  git(dir, 'branch', INTEG, 'main');
  for (const n of [1, 2, 3]) {
    writeFiles(dir, { [`base${n}.txt`]: `${n}\n` });
    commitAll(dir, `base work ${n}`);
  }
  const { p, logs } = runF(dir);
  const r = await p;
  const msg = `synced ${INTEG} with main: fast-forwarded 3 commits`;
  assert.ok(logs.includes(msg), logs.join('\n'));
  assert.equal(baseSyncLine(r.report), `- base sync: ${msg}`);
});

test('F76 AC-4: an integration already up to date prints and reports "is up to date"', async () => {
  const dir = fixture({ status: 'passed' });
  commitOn(dir, INTEG, { 'integ.txt': 'integration only\n' }, 'integration work');
  const { p, logs } = runF(dir);
  const r = await p;
  const msg = `${INTEG} is up to date with main`;
  assert.ok(logs.includes(msg), logs.join('\n'));
  assert.equal(baseSyncLine(r.report), `- base sync: ${msg}`);
});

// ------------------------------------------------------------------ AC-5

test('F76 AC-5: --resume does not sync and reports "skipped (resume)"', async () => {
  const dir = fixture();
  const controller = new AbortController();
  // The first run stops in F1's build: its state is saved for --resume.
  const stop = async () => { controller.abort(); return { ok: true, costUsd: 0 }; };
  const first = await runF(dir, { build: stop }, { signal: controller.signal }).p;
  assert.equal(first.interrupted, true);
  const integBefore = sha(dir, INTEG);
  const late = commitLate(dir);
  const logs = [];
  const r = await run.runFeatures({
    root: dir, resume: true,
    deps: { build: recordingBuild(), evaluate, verify: async () => PASSING, cpus: 8, log: (m) => logs.push(m), warn: () => {} },
  });
  assert.equal(r.interrupted, false);
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results));
  assert.ok(isAncestor(dir, integBefore, INTEG));
  assert.ok(!isAncestor(dir, late, INTEG), 'the late base commit was not merged');
  assert.ok(!subjects(dir, INTEG).includes(SYNC_SUBJECT));
  assert.ok(!logs.some((m) => m.startsWith('synced ')), logs.join('\n'));
  assert.equal(baseSyncLine(r.report), '- base sync: skipped (resume)');
});

test('F76 AC-5: on --resume the integration commit does not change before the feature continues', async () => {
  const dir = fixture();
  const controller = new AbortController();
  const stop = async () => { controller.abort(); return { ok: true, costUsd: 0 }; };
  await runF(dir, { build: stop }, { signal: controller.signal }).p;
  const integBefore = sha(dir, INTEG);
  commitLate(dir);
  let atBuild = null;
  const build = async (a) => { atBuild = sha(dir, INTEG); writeFiles(a.cwd, { 'F1.txt': 'x\n' }); return { ok: true, costUsd: 0 }; };
  await run.runFeatures({ root: dir, resume: true, deps: { build, evaluate, verify: async () => PASSING, cpus: 8, log: () => {}, warn: () => {} } });
  assert.equal(atBuild, integBefore);
});

// ------------------------------------------------------------------ AC-6

test('F76 AC-6: a run that creates the integration branch creates it from base and reports "is up to date"', async () => {
  const dir = fixture({ status: 'passed' });
  const base = sha(dir, 'main');
  const { p, logs } = runF(dir);
  const r = await p;
  assert.equal(sha(dir, INTEG), base);
  const msg = `${INTEG} is up to date with main`;
  assert.ok(logs.includes(msg), logs.join('\n'));
  assert.equal(baseSyncLine(r.report), `- base sync: ${msg}`);
});

// ------------------------------------------------------------------ AC-7

test('F76 AC-7: untracked files and changes left in the integration worktree are cleaned before the sync merge', async () => {
  const dir = fixture({ status: 'passed' });
  const integBefore = commitOn(dir, INTEG, { 'integ.txt': 'integration only\n' }, 'integration work');
  writeFiles(dir, { 'base.txt': 'from base\n' });
  const base = commitAll(dir, 'base work');
  // A leftover integration worktree: an untracked file in the way of the merge and a changed tracked file.
  fs.mkdirSync(path.dirname(intWt(dir)), { recursive: true });
  git(dir, 'worktree', 'add', '-q', intWt(dir), INTEG);
  writeFiles(intWt(dir), { 'base.txt': 'leftover\n', 'doc.md': 'leftover change\n' });
  const { p } = runF(dir);
  const r = await p;
  const head = sha(dir, INTEG);
  assert.equal(git(dir, 'log', '-1', '--format=%s', head), SYNC_SUBJECT);
  assert.deepEqual(git(dir, 'log', '-1', '--format=%P', head).split(' '), [integBefore, base]);
  assert.equal(git(dir, 'show', `${INTEG}:base.txt`), 'from base');
  assert.equal(git(dir, 'show', `${INTEG}:doc.md`), 'original');
  assert.match(fs.readFileSync(r.report, 'utf8'), /discarded 2 path\(s\)/);
});

// ------------------------------------------------------------------ AC-8

test('F76 AC-8: SPEC §8 describes the base sync at run start', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const start = spec.indexOf('## 8.');
  const end = spec.indexOf('## 9.');
  const section = spec.slice(start, end);
  const para = section.split('\n').find((l) => l.includes('**base 동기화**'));
  assert.ok(para, 'no **base 동기화** paragraph in §8');
  for (const s of ['--no-ff', 'fast-forward', '--resume', `harness: sync <integration_branch> with <base_branch>`,
    'synced <integration_branch> with <base_branch>: merged <n> commits',
    'synced <integration_branch> with <base_branch>: fast-forwarded <n> commits',
    '<integration_branch> is up to date with <base_branch>', '- base sync:', 'skipped (resume)',
    'git merge --abort', 'integration_sync', 'merge <base_branch> into <integration_branch> by hand', 'base_missing', '§8.10']) {
    assert.ok(para.includes(s), `the base sync paragraph does not mention ${s}`);
  }
  const step1 = section.split('\n').find((l) => l.startsWith('1. worktree') && l.includes('(base = '));
  assert.ok(step1, 'step 1 names the base of a feature worktree');
  assert.match(step1, /\(base = [^)]*동기화[^)]*뒤의 integration 브랜치\)/);
});

// ------------------------------------------------------------------ ES-1

test('F76 ES-1: a conflicting sync is aborted and the run stops with integration_sync before any feature work', async () => {
  const dir = fixture();
  const integBefore = commitOn(dir, INTEG, { 'doc.md': 'integration side\n' }, 'integration change');
  writeFiles(dir, { 'doc.md': 'base side\n' });
  commitAll(dir, 'base change');
  const build = recordingBuild();
  const err = await runF(dir, { build }).p.then(() => null, (e) => e);
  assert.ok(err, 'the run failed');
  assert.equal(err.code, 'integration_sync', err.message);
  assert.equal(err.exit, 2);
  assert.match(err.message, /doc\.md/);
  assert.ok(err.message.includes(`merge main into ${INTEG} by hand`), err.message);
  assert.equal(sha(dir, INTEG), integBefore);
  assert.throws(() => git(intWt(dir), 'rev-parse', '-q', '--verify', 'MERGE_HEAD'));
  assert.equal(git(intWt(dir), 'status', '--porcelain'), '');
  assert.equal(build.calls.length, 0);
  assert.ok(!fs.existsSync(featureWt(dir)), 'no feature worktree');
  assert.equal(git(dir, 'branch', '--list', 'harness/F1'), '');
  assert.equal(statusOf(dir), 'approved');
});

// ------------------------------------------------------------------ ES-2

test('F76 ES-2: an existing integration branch with an unresolvable base_branch stops with base_missing', async () => {
  const dir = fixture();
  commitOn(dir, INTEG, { 'integ.txt': 'integration only\n' }, 'integration work');
  const build = recordingBuild();
  const err = await runF(dir, { build }, { config: cfg({ base_branch: 'no-such-base' }) }).p.then(() => null, (e) => e);
  assert.ok(err, 'the run failed');
  assert.equal(err.code, 'base_missing', err.message);
  assert.equal(err.exit, 2);
  assert.match(err.message, /no-such-base/);
  assert.equal(build.calls.length, 0);
  assert.ok(!fs.existsSync(featureWt(dir)), 'no feature worktree');
  assert.equal(statusOf(dir), 'approved');
});
