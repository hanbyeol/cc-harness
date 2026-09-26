// F31: the core's own git commands are limited by budget.git_timeout_sec (default 300),
// independent of budget.step_timeout_sec, which keeps limiting the user's commands (SPEC §4, §6).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpdir, harness } from './helpers.mjs';
import { gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig, DEFAULTS } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { verify } from '../lib/verify.mjs';
import { evaluate } from '../lib/eval.mjs';
import { git as runGit, runFeatures } from '../lib/run.mjs';
import { HarnessError } from '../lib/errors.mjs';

const POSIX = process.platform !== 'win32'; // the fake git is a shebang script

const REAL_GIT = spawnSync(POSIX ? 'which' : 'where', ['git'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim();
const pathKey = () => Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

/**
 * A directory with a fake `git` (sh script) that runs `onMatch` when its arguments contain
 * `match` (e.g. "worktree add"), then hands every call to the real git.
 */
function fakeGit(match, onMatch) {
  const dir = fs.realpathSync(tmpdir('harness-f31-git-'));
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh
case " $* " in *" ${match} "*) ${onMatch} ;; esac
exec "${REAL_GIT}" "$@"
`);
  fs.chmodSync(path.join(dir, 'git'), 0o755);
  return dir;
}

// Runs fn with `dir` first on PATH; the core's commands inherit PATH (env allowlist).
async function withPath(dir, fn) {
  const key = pathKey();
  const saved = process.env[key];
  process.env[key] = `${dir}${path.delimiter}${saved}`;
  try { return await fn(); } finally { process.env[key] = saved; }
}

const CONTRACT = (criteria) => ({
  id: 'F9', title: 'fixture', security_tier: 'standard', version: 1,
  acceptance_criteria: criteria.map(({ id, check, isNew = false }) => ({ id, criterion: id, check, new: isNew })),
  security_criteria: [], error_scenarios: [], out_of_scope: [],
});

// A feature branch whose new criterion passes on HEAD (marker.txt exists) and fails on base,
// so verify creates the base worktree for the vacuity run.
function fixture(criteria = [{ id: 'AC-1', check: 'node scripts/has-marker.mjs', isNew: true }], files = {}) {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': CONTRACT(criteria),
    '.harness/backlog.json': { items: [] },
    'scripts/has-marker.mjs': "import fs from 'node:fs';\nprocess.exit(fs.existsSync('marker.txt') ? 0 : 1);\n",
    'scripts/sleep.mjs': 'setTimeout(() => {}, 30000);\n',
    'scripts/count.mjs': 'console.log(1);\n',
    ...files,
  });
  writeFiles(dir, { 'marker.txt': 'feature\n' });
  commitAll(dir, 'feature');
  return dir;
}

const cfg = (budget, verifyExtra = {}) => resolveConfig({ base_branch: 'main', verify: { commands: [], ...verifyExtra }, budget });
const runVerify = (dir, config) => verify({ root: dir, featureId: 'F9', base: 'main', config, cpus: 1 });

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid, ms = 30000) {
  for (let t = 0; t < ms && alive(pid); t += 100) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}
const readPid = (file) => Number(fs.readFileSync(file, 'utf8').trim());

// ---------- AC-1 ----------
test('F31 AC-1: budget.git_timeout_sec defaults to 300 and does not follow step_timeout_sec', () => {
  assert.equal(DEFAULTS.budget.git_timeout_sec, 300);
  const c = cfg({ step_timeout_sec: 1 });
  assert.equal(c.budget.git_timeout_sec, 300);
  assert.equal(c.budget.step_timeout_sec, 1);
});

test('F31 AC-1: verify passes with step_timeout_sec 3 while a fake git takes 5s for worktree add', async () => {
  if (!POSIX) return; // the fake git is a shebang script
  const dir = fixture();
  // The criterion check (a node process) also runs under step_timeout_sec: 3 s leaves it room
  // to start on a loaded machine, while the 5 s worktree add still exceeds it.
  const bin = fakeGit('worktree add', 'sleep 5');
  const r = await withPath(bin, () => runVerify(dir, cfg({ step_timeout_sec: 3 })));
  assert.equal(r.pass, true, JSON.stringify(r.criteria));
  assert.equal(r.criteria[0].vacuous, false);
});

test('F31 AC-1: eval builds its diff with step_timeout_sec 1 while a fake git takes 2s for ls-files', async () => {
  if (!POSIX) return;
  const dir = fixture();
  const bin = fakeGit('ls-files', 'sleep 2');
  const scores = { functionality: 9, quality: 9, security: 9, errors: 9, tests: 9 };
  const json = { scores, findings: [], out_of_scope: [] };
  const runAdapter = async () => ({ ok: true, error: null, text: JSON.stringify(json), json, costUsd: 0, exitCode: 0 });
  const verifyResult = {
    pass: true, commands: [], warnings: [], criteria: [{ id: 'AC-1', pass: true }],
    integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } },
  };
  const config = resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 1 }, roles: { builder: 'claude', evaluator: 'claude', 'security-reviewer': 'claude' } });
  const r = await withPath(bin, () => evaluate({ root: dir, featureId: 'F9', base: 'main', config, verifyResult, runAdapter }));
  assert.equal(r.verdict, 'pass');
});

test('F31 AC-1: run gives every core git call budget.git_timeout_sec, not step_timeout_sec', async () => {
  const c = CONTRACT([{ id: 'AC-1', check: 'node scripts/has-marker.mjs' }]);
  c.id = 'F1';
  c.approval = { by: 'test', at: '2026-09-26T00:00:00.000Z', hash: hashContract(c) };
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'f', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': c,
  }, { branch: null });
  const calls = [];
  const spy = (args, cwd, opts) => { calls.push({ args, opts }); return runGit(args, cwd, opts); };
  const passing = { pass: true, commands: [], criteria: [{ id: 'AC-1', pass: true }], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
  const r = await runFeatures({
    root: dir,
    config: resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 1, git_timeout_sec: 7 } }),
    deps: {
      git: spy,
      build: async (a) => { writeFiles(a.cwd, { 'F1.txt': 'built\n' }); return { ok: true, costUsd: 0 }; },
      verify: async () => passing,
      evaluate: async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null }),
      log: () => {},
    },
  });
  assert.equal(r.results.find((x) => x.feature === 'F1')?.status ?? r.results[0]?.status, 'passed', JSON.stringify(r.results));
  assert.ok(calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'add'), 'run created a worktree');
  assert.ok(calls.some((c) => c.args[0] === 'for-each-ref'));
  for (const call of calls) assert.equal(call.opts?.timeoutSec, 7, call.args.join(' '));
});

// ---------- AC-2 ----------
test('F31 AC-2: a verify command still times out at step_timeout_sec', async () => {
  const dir = fixture([{ id: 'AC-1', check: 'node scripts/has-marker.mjs' }]);
  const r = await runVerify(dir, cfg({ step_timeout_sec: 1 }, { commands: ['node scripts/sleep.mjs'] }));
  assert.equal(r.pass, false);
  assert.equal(r.commands[0].timedOut, true);
});

test('F31 AC-2: a criterion check still times out at step_timeout_sec', async () => {
  const dir = fixture([{ id: 'AC-1', check: 'node scripts/sleep.mjs' }]);
  const r = await runVerify(dir, cfg({ step_timeout_sec: 1 }));
  assert.equal(r.pass, false);
  assert.equal(r.criteria[0].timedOut, true);
});

test('F31 AC-2: a test_count command still times out at step_timeout_sec', async () => {
  const dir = fixture([{ id: 'AC-1', check: 'node scripts/has-marker.mjs' }]);
  const r = await runVerify(dir, cfg({ step_timeout_sec: 1 }, { test_count: 'node scripts/sleep.mjs' }));
  assert.equal(r.pass, false);
  assert.equal(r.integrity.testCount.status, 'error');
});

// ---------- AC-3 ----------
// The budget applies to every core git call, so it must be generous enough for the real ones
// that run before the hanging one on a loaded machine (each goes through the fake git script,
// and three concurrent suites stretch that to seconds); the hanging one sleeps far longer.
const GIT_T = 20;
const isGitTimeout = (sub, n) => (e) => e instanceof HarnessError && e.code === 'git'
  && e.message.includes(sub) && e.message.includes(`timed out after ${n}s`);

test('F31 AC-3: verify — a core git command past git_timeout_sec is HarnessError(git) naming it and "timed out after <N>s"', async () => {
  if (!POSIX) return;
  const dir = fixture();
  const bin = fakeGit('worktree add', 'sleep 60');
  await withPath(bin, () => assert.rejects(runVerify(dir, cfg({ step_timeout_sec: 60, git_timeout_sec: GIT_T })), isGitTimeout('worktree add', GIT_T)));
});

test('F31 AC-3: eval — a slow git diff past git_timeout_sec is HarnessError(git) naming diff', async () => {
  if (!POSIX) return;
  const dir = fixture();
  const bin = fakeGit('diff', 'sleep 60');
  const config = resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60, git_timeout_sec: GIT_T } });
  const verifyResult = { pass: true, commands: [], warnings: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } } };
  const runAdapter = async () => { throw new Error('the adapter must not be called'); };
  await withPath(bin, () => assert.rejects(
    evaluate({ root: dir, featureId: 'F9', base: 'main', config, verifyResult, runAdapter }), isGitTimeout('git diff', GIT_T)));
});

test('F31 AC-3: run — the core git runner past its timeout is HarnessError(git) naming the subcommand', async () => {
  if (!POSIX) return;
  const dir = fixture();
  const bin = fakeGit('for-each-ref', 'sleep 60');
  await withPath(bin, () => assert.rejects(runGit(['for-each-ref', 'refs/heads/'], dir, { timeoutSec: GIT_T }), isGitTimeout('git for-each-ref', GIT_T)));
});

// ---------- SC-1 ----------
// The fake must start its child and record both pids before the core kills it; a loaded
// machine can take seconds for that, so the budget is generous (the fake still hangs far longer).
const HANG_T = 30;
// The fake git starts a background child, records both pids, then hangs.
const HANG = (pids) => `sleep 1000 & echo $! > "${pids}/child.tmp" && mv "${pids}/child.tmp" "${pids}/child.pid"; `
  + `echo $$ > "${pids}/self.tmp" && mv "${pids}/self.tmp" "${pids}/self.pid"; wait`;

test('F31 SC-1: verify — a timed-out core git command and its child are both gone within 3s', async () => {
  if (!POSIX) return;
  const dir = fixture();
  const pids = fs.realpathSync(tmpdir('harness-f31-pids-'));
  const bin = fakeGit('worktree add', HANG(pids));
  await withPath(bin, () => assert.rejects(runVerify(dir, cfg({ step_timeout_sec: 60, git_timeout_sec: HANG_T })), (e) => e.code === 'git'));
  for (const name of ['self.pid', 'child.pid']) {
    const file = path.join(pids, name);
    assert.ok(fs.existsSync(file), `${name} recorded`);
    assert.ok(await gone(readPid(file)), `${name} still alive`);
  }
});

test('F31 SC-1: run — a timed-out core git command and its child are both gone within 3s', async () => {
  if (!POSIX) return;
  const dir = fixture();
  const pids = fs.realpathSync(tmpdir('harness-f31-pids-'));
  const bin = fakeGit('for-each-ref', HANG(pids));
  await withPath(bin, () => assert.rejects(runGit(['for-each-ref', 'refs/heads/'], dir, { timeoutSec: HANG_T }), (e) => e.code === 'git'));
  for (const name of ['self.pid', 'child.pid']) {
    const file = path.join(pids, name);
    assert.ok(fs.existsSync(file), `${name} recorded`);
    assert.ok(await gone(readPid(file)), `${name} still alive`);
  }
});

// ---------- ES-1 ----------
for (const [label, value] of [['0', 0], ['negative', -5], ['a numeric string', '300'], ['a word', 'long'], ['null', null], ['true', true], ['an array', [300]], ['an object', { sec: 300 }]]) {
  test(`F31 ES-1: budget.git_timeout_sec ${label} is config_invalid (exit 2) naming the key`, () => {
    assert.throws(() => resolveConfig({ budget: { git_timeout_sec: value } }),
      (e) => e instanceof HarnessError && e.code === 'config_invalid' && e.exit === 2 && e.message.includes('budget.git_timeout_sec'));
  });
}

test('F31 ES-1: the CLI exits 2 with budget.git_timeout_sec in the message for a config.json value of 0', () => {
  const dir = fixture();
  const file = path.join(dir, '.harness', 'config.json');
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...c, budget: { git_timeout_sec: 0 } }));
  const r = harness(['verify', 'F9', '--base', 'main'], { cwd: dir });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr + r.stdout, /budget\.git_timeout_sec/);
});

test('F31 ES-1: a positive git_timeout_sec is accepted', () => {
  assert.equal(resolveConfig({ budget: { git_timeout_sec: 45 } }).budget.git_timeout_sec, 45);
});

// ---------- AC-4 ----------
const SPEC = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
const README = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
const section = (n) => SPEC.slice(SPEC.indexOf(`\n## ${n}. `), SPEC.indexOf(`\n## ${n + 1}. `));

test('F31 AC-4: SPEC §4 documents budget.git_timeout_sec and its validation', () => {
  const s4 = section(4);
  assert.match(s4, /budget\.git_timeout_sec/);
  assert.match(s4, /config_invalid/);
});

test('F31 AC-4: SPEC §6 and README describe both limits and what each one covers', () => {
  for (const [name, text] of [['SPEC §6', section(6)], ['README', README]]) {
    for (const s of ['budget.git_timeout_sec', 'budget.step_timeout_sec', 'verify.commands', 'test_count', 'worktree', 'timed out after <N>s', '300', '1800']) {
      assert.ok(text.includes(s), `${name} mentions ${s}`);
    }
  }
});
