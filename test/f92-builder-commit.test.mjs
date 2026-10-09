// F92: in `harness run` the core commits the builder's changes after each build attempt, before
// the feature verify, so the feature verify and the post-merge verify see the same git state
// (what is tracked) and the verify result cache can be reused safely.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, harness } from './helpers.mjs';
import { git, gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { verify as realVerify } from '../lib/verify.mjs';
import * as run from '../lib/run.mjs';

// ------------------------------------------------------------------ fixtures

// What `harness init` writes, so the core's own ignored records are as in a real project.
const HARNESS_IGNORE = 'wt/\n*.tmp-*\nruns/test-count-cache.json\nruns/verify-cache.json\n';
const SUBJECT = 'harness: F1 round 1 builder changes';

function contract(check) {
  const c = {
    id: 'F1', title: 'feature F1', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'F1.txt is tracked', check, new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-09T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function runFixture(check = 'node scripts/ok.mjs') {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': HARNESS_IGNORE,
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract(check),
    'scripts/ok.mjs': 'process.exit(0);\n',
  }, { branch: null });
}

const OK_INTEGRITY = { markers: [], harnessPaths: [], testCount: { status: 'unset' } };
const PASSING = { pass: true, commands: [], criteria: [{ id: 'AC-1', pass: true }], integrity: OK_INTEGRITY, warnings: [] };
const FAILING = { pass: false, commands: [{ cmd: 'npm test', pass: false, message: 'exit 1', output: 'boom' }], criteria: [{ id: 'AC-1', pass: true }], integrity: OK_INTEGRITY, warnings: [] };
const evaluate = async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });
const runCfg = () => resolveConfig({ base_branch: 'main', run: { max_parallel: 1 }, verify: { commands: [] }, budget: { step_timeout_sec: 60 } });
const isIntegration = (cwd) => fs.realpathSync.native(cwd).endsWith(`${path.sep}_integration`);

// The git state a (fake) feature verify sees in its worktree.
const seen = (cwd) => ({
  head: git(cwd, 'rev-parse', 'HEAD'),
  status: git(cwd, 'status', '--porcelain'),
  files: git(cwd, 'ls-files').split('\n').filter(Boolean),
});
const builderCommits = (dir) => git(dir, 'log', '--all', '--format=%H %s').split('\n').filter((l) => l.endsWith(` ${SUBJECT}`));

// ------------------------------------------------------------------ AC-1
test('F92 AC-1: the core commits the build attempt before the feature verify: clean status and the new file tracked', async () => {
  const dir = runFixture();
  const states = [];
  const build = async (a) => {
    writeFiles(a.cwd, { 'F1.txt': 'built\n', 'src/new.mjs': 'export const x = 1;\n' });
    return { ok: true, costUsd: 0 };
  };
  const verify = async (a) => {
    if (!isIntegration(a.cwd)) states.push(seen(a.cwd));
    return PASSING;
  };
  const r = await run.runFeatures({ root: dir, config: runCfg(), deps: { build, verify, evaluate, cpus: 8 } });
  assert.equal(r.results[0]?.status, 'passed', JSON.stringify(r.results));
  assert.equal(states.length, 1);
  assert.equal(states[0].status, '', 'nothing uncommitted when the feature verify runs');
  assert.ok(states[0].files.includes('F1.txt'), states[0].files.join(','));
  assert.ok(states[0].files.includes('src/new.mjs'), states[0].files.join(','));
  assert.equal(git(dir, 'log', '-1', '--format=%s', states[0].head), SUBJECT);
});

test('F92 AC-1: the attempt commit leaves out the core records, as the commit before the merge does', async () => {
  const dir = runFixture();
  let commit = null;
  const build = async (a) => {
    writeFiles(a.cwd, { 'F1.txt': 'built\n', '.harness/runs/test-count-cache.json': { entries: [] } });
    return { ok: true, costUsd: 0 };
  };
  const verify = async (a) => {
    if (!isIntegration(a.cwd)) commit = git(a.cwd, 'rev-parse', 'HEAD');
    return PASSING;
  };
  const r = await run.runFeatures({ root: dir, config: runCfg(), deps: { build, verify, evaluate, cpus: 8 } });
  assert.equal(r.results[0]?.status, 'passed', JSON.stringify(r.results));
  const files = git(dir, 'show', '--name-only', '--format=', commit).split('\n');
  assert.ok(files.includes('F1.txt'), files.join(','));
  assert.ok(!files.includes('.harness/runs/test-count-cache.json'), files.join(','));
});

// ------------------------------------------------------------------ AC-2
test('F92 AC-2: a build attempt that changed nothing makes no commit (HEAD unchanged); the next attempt that changes something does', async () => {
  const dir = runFixture();
  const before = [];
  const states = [];
  const build = async (a) => {
    before.push(git(a.cwd, 'rev-parse', 'HEAD'));
    if (before.length === 2) writeFiles(a.cwd, { 'F1.txt': 'built\n' });
    return { ok: true, costUsd: 0 };
  };
  const verify = async (a) => {
    if (isIntegration(a.cwd)) return PASSING;
    states.push(seen(a.cwd));
    return states.length === 1 ? FAILING : PASSING;
  };
  const r = await run.runFeatures({ root: dir, config: runCfg(), deps: { build, verify, evaluate, cpus: 8 } });
  assert.equal(r.results[0]?.status, 'passed', JSON.stringify(r.results));
  assert.equal(states.length, 2, JSON.stringify(states));
  assert.equal(states[0].head, before[0], 'the attempt that changed nothing left HEAD where it was');
  assert.equal(states[0].status, '');
  // Control: the commit is active, so the absence above is not just a missing commit step.
  assert.notEqual(states[1].head, before[1], 'the attempt that changed a file was committed before its verify');
  assert.equal(git(dir, 'log', '-1', '--format=%s', states[1].head), SUBJECT);
  assert.equal(builderCommits(dir).length, 1, builderCommits(dir).join('\n'));
});

// ------------------------------------------------------------------ AC-3
test('F92 AC-3: each build attempt of a round is its own commit, made before that attempt\'s verify', async () => {
  const dir = runFixture();
  const states = [];
  let n = 0;
  const build = async (a) => {
    n += 1;
    writeFiles(a.cwd, { [`attempt${n}.txt`]: `${n}\n` });
    return { ok: true, costUsd: 0 };
  };
  const verify = async (a) => {
    if (isIntegration(a.cwd)) return PASSING;
    states.push(seen(a.cwd));
    return states.length === 1 ? FAILING : PASSING;
  };
  const r = await run.runFeatures({ root: dir, config: runCfg(), deps: { build, verify, evaluate, cpus: 8 } });
  assert.equal(r.results[0]?.status, 'passed', JSON.stringify(r.results));
  assert.equal(n, 2, 'two build attempts');
  assert.equal(states.length, 2);
  for (const s of states) assert.equal(s.status, '', 'nothing uncommitted at either verify');
  assert.ok(states[0].files.includes('attempt1.txt') && !states[0].files.includes('attempt2.txt'), states[0].files.join(','));
  assert.ok(states[1].files.includes('attempt2.txt'), states[1].files.join(','));
  assert.notEqual(states[0].head, states[1].head);
  const commits = builderCommits(dir);
  assert.equal(commits.length, 2, commits.join('\n'));
  assert.deepEqual(commits.map((l) => l.split(' ')[0]).reverse(), [states[0].head, states[1].head]);
});

// ------------------------------------------------------------------ AC-4
test('F92 AC-4: with nothing left uncommitted at the merge no further builder changes commit is made', async () => {
  const dir = runFixture();
  const build = async (a) => {
    writeFiles(a.cwd, { 'F1.txt': 'built\n' });
    return { ok: true, costUsd: 0 };
  };
  let atVerify = null;
  const verify = async (a) => {
    if (!isIntegration(a.cwd)) atVerify = git(a.cwd, 'rev-parse', 'HEAD');
    return PASSING;
  };
  const r = await run.runFeatures({ root: dir, config: runCfg(), deps: { build, verify, evaluate, cpus: 8 } });
  assert.equal(r.results[0]?.status, 'passed', JSON.stringify(r.results));
  const commits = builderCommits(dir);
  assert.equal(commits.length, 1, commits.join('\n'));
  assert.equal(commits[0].split(' ')[0], atVerify, 'the only builder changes commit is the one made before the feature verify');
  assert.equal(git(dir, 'show', 'harness/integration:F1.txt'), 'built');
});

test('F92 AC-4: changes left in the worktree after the verify (an eval repro) are committed at the merge as before', async () => {
  const dir = runFixture();
  const build = async (a) => {
    writeFiles(a.cwd, { 'F1.txt': 'built\n' });
    return { ok: true, costUsd: 0 };
  };
  const evalWrites = async (a) => {
    writeFiles(a.cwd, { 'repro-output.txt': 'left by a repro\n' });
    return evaluate(a);
  };
  const r = await run.runFeatures({ root: dir, config: runCfg(), deps: { build, verify: async () => PASSING, evaluate: evalWrites, cpus: 8 } });
  assert.equal(r.results[0]?.status, 'passed', JSON.stringify(r.results));
  const commits = builderCommits(dir);
  assert.equal(commits.length, 2, commits.join('\n'));
  const files = git(dir, 'show', '--name-only', '--format=', commits[0].split(' ')[0]).split('\n');
  assert.deepEqual(files, ['repro-output.txt']);
  assert.equal(git(dir, 'show', 'harness/integration:repro-output.txt'), 'left by a repro');
});

// ------------------------------------------------------------------ AC-5
test('F92 AC-5: a check that needs the new file tracked passes in the feature verify and the post-merge verify is a cache hit', async () => {
  const dir = runFixture('git ls-files --error-unmatch F1.txt');
  const steps = [];
  const build = async (a) => {
    writeFiles(a.cwd, { 'F1.txt': 'built\n' });
    return { ok: true, costUsd: 0 };
  };
  const verify = async (a) => {
    const v = await realVerify(a);
    steps.push({ step: a.step, v });
    return v;
  };
  const r = await run.runFeatures({ root: dir, config: runCfg(), deps: { build, verify, evaluate, cpus: 8 } });
  assert.equal(r.results[0]?.status, 'passed', JSON.stringify(r.results));
  assert.deepEqual(steps.map((s) => [s.step, s.v.pass]), [['verify', true], ['post_merge_verify', true]]);
  assert.equal(steps[0].v.criteria.find((c) => c.id === 'AC-1')?.pass, true);
  assert.deepEqual(steps.map((s) => s.v.cache.status), ['miss', 'hit']);
  const metrics = fs.readFileSync(r.report.replace(/\.md$/, '.metrics.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(metrics.find((m) => m.step === 'post_merge_verify')?.cached, true);
  assert.equal(metrics.find((m) => m.step === 'verify')?.cached, false);
});

// ------------------------------------------------------------------ AC-6
test('F92 AC-6: harness verify F{n} commits nothing: HEAD and git status are the same before and after', () => {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    // The command's own event record is not project state; ignored so status compares the project.
    '.harness/.gitignore': `${HARNESS_IGNORE}events/\n`,
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract('node scripts/ok.mjs'),
    'scripts/ok.mjs': 'process.exit(0);\n',
    'shared.txt': 'original\n',
  });
  writeFiles(dir, { 'F1.txt': 'untracked\n', 'shared.txt': 'modified\n' });
  const before = { head: git(dir, 'rev-parse', 'HEAD'), status: git(dir, 'status', '--porcelain') };
  assert.notEqual(before.status, '', 'fixture: the tree has uncommitted changes');
  const v = harness(['verify', 'F1', '--json'], { cwd: dir });
  assert.ok(v.stdout.trim(), v.stderr);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), before.head);
  assert.equal(git(dir, 'status', '--porcelain'), before.status);
});

// ------------------------------------------------------------------ AC-7
test('F92 AC-7: SPEC §8 describes when builder changes are committed, why, and the merge-time commit', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const line = spec.split('\n').find((l) => l.startsWith('- **builder 변경 커밋**'));
  assert.ok(line, 'the builder changes entry exists');
  for (const s of ['build 시도', '기능 verify 전', '결과 캐시', '추적', '병합 전', '`harness: F<n> round <r> builder changes`', '빈 커밋']) {
    assert.ok(line.includes(s), `missing ${JSON.stringify(s)}: ${line}`);
  }
});

// ------------------------------------------------------------------ ES-1
test('F92 ES-1: a failed commit after a build attempt is handled like a failed builder changes commit at the merge', async () => {
  const dir = runFixture();
  const calls = [];
  const g = async (args, cwd, opts) => {
    if (args[0] === 'commit' && args.includes(SUBJECT)) {
      calls.push(args);
      return { code: 1, signal: null, stdout: '', stderr: 'fatal: injected failure', timedOut: false, error: null };
    }
    return run.git(args, cwd, opts);
  };
  const verifies = [];
  const build = async (a) => {
    writeFiles(a.cwd, { 'F1.txt': 'built\n' });
    return { ok: true, costUsd: 0 };
  };
  const verify = async (a) => {
    verifies.push(a.step);
    return PASSING;
  };
  let out;
  try {
    out = await run.runFeatures({ root: dir, config: runCfg(), deps: { build, verify, evaluate, git: g, cpus: 8 } });
  } catch (err) {
    out = { error: err };
  }
  assert.equal(calls.length, 1, 'the commit was attempted once');
  assert.deepEqual(verifies, [], 'no verify after the failed commit');
  const text = out.error ? out.error.message : JSON.stringify(out.results);
  assert.match(text, /commit of builder changes failed: fatal: injected failure/);
});
