// F96: backlog fixes in verify and run — untracked files a pre-merge verify wrote are cleaned
// when the feature worktree is put back, a git error of the base sync's ancestor check stops the
// run, a tree key is computed once per commit and verify, a failed third flaky run reports its
// own exit code, a lone NAME=value command records no program, and a cache hit repeats no warning.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpdir } from './helpers.mjs';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { verify as realVerify } from '../lib/verify.mjs';
import * as run from '../lib/run.mjs';

// ------------------------------------------------------------------ fixtures

// What `harness init` writes, so the core's own ignored records are as in a real project.
const HARNESS_IGNORE = 'wt/\n*.tmp-*\nruns/test-count-cache.json\nruns/verify-cache.json\n';
const INTEG = 'harness/integration';

function contract(id, check = 'node scripts/ok.mjs') {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id}.txt exists`, check, new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-09T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

// A repo on `main` with F1 approved; *.log is ignored by the project.
function runFixture() {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': HARNESS_IGNORE,
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract('F1'),
    'scripts/ok.mjs': 'process.exit(0);\n',
    '.gitignore': '*.log\n',
    'shared.txt': 'original\n',
  }, { branch: null });
}

const cfg = (over = {}) => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, ...over });
const real = (p) => fs.realpathSync.native(p);
const intWt = (dir) => path.join(dir, '.harness', 'wt', '_integration');
const featureWt = (dir, id = 'F1') => path.join(dir, '.harness', 'wt', id);
const isIntegration = (cwd) => real(cwd).endsWith(`${path.sep}_integration`);
const resultOf = (r, id = 'F1') => r.results.find((x) => x.feature === id);

const OK_INTEGRITY = { markers: [], harnessPaths: [], testCount: { status: 'unset' } };
const PASSING = { pass: true, commands: [], criteria: [{ id: 'AC-1', pass: true }], integrity: OK_INTEGRITY, warnings: [] };
const FAILING = {
  pass: false, commands: [{ cmd: 'npm test', pass: false, message: 'exit 1', output: 'boom' }],
  criteria: [{ id: 'AC-1', pass: true }], integrity: OK_INTEGRITY, warnings: [],
};
const evaluate = async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });

const landOnIntegration = (dir, files, message = 'meanwhile on integration') => {
  writeFiles(intWt(dir), files);
  return commitAll(intWt(dir), message);
};

// A builder that writes <id>.txt (a recovery writes fixed.txt); `onBuild` runs first.
function fakeBuild({ onBuild } = {}) {
  const calls = [];
  const fn = async (a) => {
    const kind = a.postMergeFailures ? 'recover' : a.conflicts ? 'resolve' : 'build';
    calls.push({ kind, cwd: a.cwd });
    if (kind === 'build' && onBuild) await onBuild(a);
    writeFiles(a.cwd, kind === 'recover' ? { 'fixed.txt': 'fixed\n' } : { [`${a.featureId}.txt`]: 'built\n' });
    return { ok: true, costUsd: 0 };
  };
  fn.calls = calls;
  return fn;
}

// A core git that records every call; `fail(args, cwd)` returning a result replaces the call.
function recordingGit({ fail, before } = {}) {
  const calls = [];
  const fn = async (args, cwd, opts) => {
    const c = { args, cwd: real(cwd), integration: isIntegration(cwd), code: null };
    calls.push(c);
    if (before) before(c);
    const r = (fail && fail(args, cwd)) || await run.git(args, cwd, opts);
    c.code = r.code;
    return r;
  };
  fn.calls = calls;
  return fn;
}

// Every commit of the repo (all refs) that has `file` in its tree.
const commitsWith = (dir, file) => git(dir, 'log', '--all', '--format=%H').split(/\r?\n/).filter(Boolean)
  .filter((sha) => git(dir, 'ls-tree', '-r', '--name-only', sha).split(/\r?\n/).includes(file));

// A run where integration moves while F1 builds (so the pre-merge verify runs), the pre-merge
// verify writes leak.txt, an ignored out.log and .harness/events/probe.jsonl, and the post-merge
// verify fails once (so the builder's recovery commits once more). The feature worktree is
// inspected when the merge into integration starts.
async function leakRun(gitOpts = {}) {
  const dir = runFixture();
  const build = fakeBuild({ onBuild: () => landOnIntegration(dir, { 'other.txt': 'other\n' }) });
  let postFailed = false;
  const steps = [];
  const verify = async (a) => {
    steps.push(a.step);
    if (a.step === 'pre_merge_verify') {
      writeFiles(a.cwd, { 'leak.txt': 'left by the verify\n', 'out.log': 'ignored\n', '.harness/events/probe.jsonl': '{}\n' });
      return PASSING;
    }
    if (a.step === 'post_merge_verify' && !postFailed) {
      postFailed = true;
      return FAILING;
    }
    return PASSING;
  };
  let atLockMerge = null;
  const before = (c) => {
    if (!atLockMerge && c.integration && c.args[0] === 'merge' && c.args[1] === '--no-ff' && fs.existsSync(featureWt(dir))) {
      atLockMerge = Object.fromEntries(['leak.txt', 'out.log', '.harness/events/probe.jsonl']
        .map((f) => [f, fs.existsSync(path.join(featureWt(dir), f))]));
    }
  };
  const g = recordingGit({ ...gitOpts, before });
  const logs = [];
  const r = await run.runFeatures({ root: dir, config: cfg(), deps: { build, verify, evaluate, git: g, cpus: 8, log: (m) => logs.push(m), warn: () => {} } });
  return { dir, r, build, steps, atLockMerge, g, logs };
}

// ------------------------------------------------------------------ AC-1
test('F96 AC-1: untracked files the pre-merge verify wrote outside .harness/ are removed when the worktree is put back; ignored and .harness/ files stay', async () => {
  const { dir, r, build, steps, atLockMerge } = await leakRun();
  assert.equal(resultOf(r).status, 'passed', JSON.stringify(r.results));
  assert.ok(steps.includes('pre_merge_verify'), steps.join(','));
  assert.deepEqual(atLockMerge, { 'leak.txt': false, 'out.log': true, '.harness/events/probe.jsonl': true });
  // A recovery followed the merge: its builder commit, like the merge commit, has no leak.txt.
  assert.deepEqual(build.calls.map((c) => c.kind), ['build', 'recover']);
  const merged = git(dir, 'log', '--format=%H', `${INTEG}`).split(/\r?\n/);
  assert.ok(merged.length > 0);
  assert.deepEqual(commitsWith(dir, 'leak.txt'), [], 'no commit has leak.txt');
  git(dir, 'cat-file', '-e', `${INTEG}:fixed.txt`);
  git(dir, 'cat-file', '-e', `${INTEG}:F1.txt`);
});

// ------------------------------------------------------------------ ES-1
test('F96 ES-1: a failing git clean after the pre-merge verify leaves one warning and the run goes on', async () => {
  const injected = { code: 1, stdout: '', stderr: 'fatal: injected clean failure' };
  const fail = (args, cwd) => (args[0] === 'clean' && !isIntegration(cwd) ? injected : null);
  const { r, atLockMerge, g, logs } = await leakRun({ fail });
  assert.equal(resultOf(r).status, 'passed', JSON.stringify(r.results));
  assert.ok(g.calls.some((c) => c.args[0] === 'clean' && !c.integration), 'the clean was tried');
  assert.equal(atLockMerge['leak.txt'], true, 'nothing was cleaned');
  const warned = logs.filter((m) => m.includes('injected clean failure'));
  assert.equal(warned.length, 1, logs.join('\n'));
  const report = fs.readFileSync(r.report, 'utf8');
  assert.equal(report.split('injected clean failure').length - 1, 1, report);
});

// ------------------------------------------------------------------ AC-2
// A diverged integration branch: the base sync has to merge.
function divergedFixture() {
  const dir = runFixture();
  git(dir, 'checkout', '-q', '-b', INTEG);
  writeFiles(dir, { 'integ.txt': 'integration only\n' });
  commitAll(dir, 'integration work');
  git(dir, 'checkout', '-q', 'main');
  writeFiles(dir, { 'base.txt': 'base only\n' });
  commitAll(dir, 'base work');
  return dir;
}
const isSyncAncestorCheck = (args) => args[0] === 'merge-base' && args[1] === '--is-ancestor' && args[3] === `refs/heads/${INTEG}`;

test('F96 AC-2: a git error (128) of the base sync ancestor check stops the run with integration_sync, before any merge or rev-list', async () => {
  const dir = divergedFixture();
  const integBefore = git(dir, 'rev-parse', INTEG);
  const fail = (args) => (isSyncAncestorCheck(args) ? { code: 128, stdout: '', stderr: 'fatal: injected merge-base failure' } : null);
  const g = recordingGit({ fail });
  const build = fakeBuild();
  const err = await run.runFeatures({ root: dir, config: cfg(), parallel: 1, deps: { build, verify: async () => PASSING, evaluate, git: g, cpus: 8, warn: () => {} } })
    .then(() => null, (e) => e);
  assert.ok(err, 'the run failed');
  assert.equal(err.code, 'integration_sync', err.message);
  assert.match(err.message, /merge-base/);
  assert.match(err.message, /injected merge-base failure/);
  assert.ok(g.calls.some((c) => isSyncAncestorCheck(c.args)));
  assert.deepEqual(g.calls.filter((c) => c.args[0] === 'merge' || c.args[0] === 'rev-list').map((c) => c.args), []);
  assert.equal(build.calls.length, 0);
  assert.equal(git(dir, 'rev-parse', INTEG), integBefore);
});

test('F96 AC-2: exit 1 of the base sync ancestor check syncs as before', async () => {
  const dir = divergedFixture();
  const g = recordingGit();
  const r = await run.runFeatures({ root: dir, config: cfg(), parallel: 1, deps: { build: fakeBuild(), verify: async () => PASSING, evaluate, git: g, cpus: 8, warn: () => {} } });
  assert.equal(g.calls.find((c) => isSyncAncestorCheck(c.args)).code, 1);
  assert.equal(resultOf(r).status, 'passed', JSON.stringify(r.results));
  git(dir, 'cat-file', '-e', `${INTEG}:base.txt`);
  assert.ok(git(dir, 'log', '--format=%s', INTEG).split(/\r?\n/).includes(`harness: sync ${INTEG} with main`));
});

// ------------------------------------------------------------------ verify fixtures

const POSIX = process.platform !== 'win32'; // the fake git is a shebang script
const REAL_GIT = spawnSync(POSIX ? 'which' : 'where', ['git'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim();
const pathKey = () => Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

// A fake git, first on PATH, that logs every call's arguments and (with `failLsTree`) fails
// `ls-tree`; every other call goes to the real git.
async function withFakeGit({ failLsTree }, fn) {
  const bin = fs.realpathSync(tmpdir('harness-f96-git-'));
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
echo "$*" >> "${log}"
${failLsTree ? 'case " $* " in *" ls-tree "*) echo "fatal: injected ls-tree failure" >&2; exit 128 ;; esac' : ''}
exec "${REAL_GIT}" "$@"
`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const key = pathKey();
  const saved = process.env[key];
  process.env[key] = `${bin}${path.delimiter}${saved}`;
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  try { return await fn(calls); } finally { process.env[key] = saved; }
}

// HEAD is main itself (check.mjs untracked): the post-merge verify's merge-base and HEAD are one
// commit, so the base count lookup and the head count store need the tree key of the same commit.
function verifyFixture(files = {}) {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/.gitignore': HARNESS_IGNORE,
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': contract('F9', 'node check.mjs'),
    'scripts/count.mjs': 'console.log(3);\n',
    ...files,
  }, { branch: null });
  writeFiles(dir, { 'check.mjs': 'process.exit(0);\n' });
  return dir;
}
const vcfg = (verify = {}) => resolveConfig({ base_branch: 'main', verify: { commands: [], test_count: 'node scripts/count.mjs', ...verify }, budget: { step_timeout_sec: 60 } });
const postMerge = (dir, config) => {
  const base = git(dir, 'rev-parse', 'main');
  return realVerify({ root: dir, featureId: 'F9', base, config, cpus: 8, step: 'post_merge_verify', vacuityBase: base });
};
const treeWarnings = (r) => r.warnings.filter((w) => w.includes('test count cache: cannot compute the tree key'));
const lsTreeCalls = (calls, sha) => calls().filter((l) => / ls-tree /.test(` ${l} `) && l.includes(sha));

const events = (dir) => {
  const d = path.join(dir, '.harness', 'events');
  let names = [];
  try { names = fs.readdirSync(d).sort(); } catch { return []; }
  return names.flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
};
const eventsText = (dir) => {
  const d = path.join(dir, '.harness', 'events');
  return fs.existsSync(d) ? fs.readdirSync(d).map((n) => fs.readFileSync(path.join(d, n), 'utf8')).join('') : '';
};
const commandEvents = (dir) => events(dir).filter((e) => e.stage === 'verify' && e.type === 'command');

// ------------------------------------------------------------------ AC-3
test('F96 AC-3: a failing tree key of one commit runs git ls-tree once per verify and warns once', async () => {
  if (!POSIX) return; // the fake git is a shebang script
  const dir = verifyFixture();
  const sha = git(dir, 'rev-parse', 'HEAD');
  await withFakeGit({ failLsTree: true }, async (calls) => {
    const r = await postMerge(dir, vcfg({ cache: 'off' }));
    assert.equal(r.pass, true, JSON.stringify(r, null, 2));
    assert.equal(lsTreeCalls(calls, sha).length, 1, calls().join('\n'));
    const w = treeWarnings(r);
    assert.equal(w.length, 1, JSON.stringify(r.warnings));
    assert.match(w[0], /injected ls-tree failure/);
  });
});

test('F96 AC-3: a tree key that git computes is computed once per commit and verify', async () => {
  if (!POSIX) return; // the fake git is a shebang script
  const dir = verifyFixture();
  const sha = git(dir, 'rev-parse', 'HEAD');
  await withFakeGit({ failLsTree: false }, async (calls) => {
    const r = await postMerge(dir, vcfg({ cache: 'off' }));
    assert.equal(r.pass, true, JSON.stringify(r, null, 2));
    assert.equal(r.integrity.testCount.source.base, 'ran');
    assert.equal(lsTreeCalls(calls, sha).length, 1, calls().join('\n'));
    assert.deepEqual(treeWarnings(r), []);
    // The head count was stored with the tree key.
    const entries = JSON.parse(fs.readFileSync(path.join(dir, '.harness', 'runs', 'test-count-cache.json'), 'utf8')).entries;
    assert.ok(entries.some((e) => e.base === sha && typeof e.tree === 'string'), JSON.stringify(entries));
  });
});

// ------------------------------------------------------------------ AC-4
const CODES_SCRIPT = [
  "import fs from 'node:fs';",
  'const [codes, state] = process.argv.slice(2);',
  "const n = fs.existsSync(state) ? Number(fs.readFileSync(state, 'utf8')) : 0;",
  'fs.writeFileSync(state, String(n + 1));',
  "const code = Number(codes.split(',')[n] ?? 0);",
  "if (code !== 0) console.log('\\u2716 other suite > slow test (1.5ms)');",
  'process.exit(code);',
  '',
].join('\n');

test('F96 AC-4: under flaky retry a failed third run reports its own exit code (3, 0, 5 → 5)', async () => {
  const dir = verifyFixture({ 'scripts/codes.mjs': CODES_SCRIPT, '.gitignore': '*.state\n' });
  const config = vcfg({ commands: ['node scripts/codes.mjs 3,0,5 a.state'], test_count: undefined, cache: 'off' });
  assert.equal(config.verify.flaky, 'retry');
  const r = await realVerify({ root: dir, featureId: 'F9', base: 'main', config, cpus: 8 });
  const c = r.commands[0];
  assert.equal(c.attempts, 3, JSON.stringify(c));
  assert.equal(c.pass, false);
  assert.equal(c.code, 5, JSON.stringify(c));
  const ev = commandEvents(dir);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.exit_code, 5, JSON.stringify(ev[0]));
  assert.equal(ev[0].data.attempts, 3);
});

// ------------------------------------------------------------------ AC-5
test('F96 AC-5: a verify command that is a lone NAME=value records program null and never its value', async () => {
  const dir = verifyFixture({ 'x.mjs': 'process.exit(0);\n' });
  const config = vcfg({ commands: ['TOKEN=abc123', 'FOO=1 node x.mjs'], test_count: undefined, cache: 'off' });
  await realVerify({ root: dir, featureId: 'F9', base: 'main', config, cpus: 8 });
  const ev = commandEvents(dir);
  assert.equal(ev.length, 2, JSON.stringify(ev));
  assert.equal(ev.find((e) => e.data.index === 0).data.program, null);
  assert.equal(ev.find((e) => e.data.index === 1).data.program, 'node');
  assert.ok(!eventsText(dir).includes('abc123'));
});

// ------------------------------------------------------------------ AC-6
test('F96 AC-6: a result cache hit does not repeat a warning that the stored result and this verify both give', async () => {
  if (!POSIX) return; // the fake git is a shebang script
  const dir = verifyFixture();
  await withFakeGit({ failLsTree: true }, async () => {
    const first = await postMerge(dir, vcfg());
    assert.equal(first.pass, true, JSON.stringify(first, null, 2));
    assert.deepEqual(first.cache, { status: 'miss' });
    assert.equal(treeWarnings(first).length, 1, JSON.stringify(first.warnings));
    const second = await postMerge(dir, vcfg());
    assert.deepEqual(second.cache, { status: 'hit' });
    const w = treeWarnings(second);
    assert.equal(w.length, 1, JSON.stringify(second.warnings));
    for (const x of second.warnings) assert.equal(second.warnings.filter((y) => y === x).length, 1, JSON.stringify(second.warnings));
  });
});

// ------------------------------------------------------------------ AC-7
test('F96 AC-7: lib/verify.mjs declares cacheFile once; the result cache and the test-count cache files have different names', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'verify.mjs'), 'utf8');
  const decls = src.match(/\b(?:const|let|var)\s+cacheFile\b/g) || [];
  assert.equal(decls.length, 1, decls.join('\n'));
  assert.match(src, /\b(?:const|let|var)\s+cacheFile\s*=\s*path\.join\(paths\(root\)\.runs, VERIFY_CACHE\)/);
  assert.doesNotMatch(src, /\b(?:const|let|var)\s+cacheFile\s*=\s*path\.join\(paths\(root\)\.runs, TEST_COUNT_CACHE\)/);
});
