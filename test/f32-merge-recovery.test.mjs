import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './helpers.mjs';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { HarnessError } from '../lib/errors.mjs';
import { verify as realVerify } from '../lib/verify.mjs';
import * as run from '../lib/run.mjs';
import evalCommand from '../lib/commands/eval.mjs';

// Symbols this feature adds are read from the module namespace, so on the pre-feature code
// each test fails on its own assertion instead of the whole file failing to import.
const failures = await import('../lib/failures.mjs').catch(() => ({}));

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

// A repo on `main` with one approved feature F1 and a shared file the feature may edit.
function fixture(files = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract('F1'),
    'scripts/ok.mjs': 'process.exit(0);\n',
    'shared.txt': 'original\n',
    ...files,
  }, { branch: null });
}

const cfg = () => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 } });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const statusOf = (dir) => readJson(path.join(dir, '.harness/features.json')).features.find((f) => f.id === 'F1').status;
const real = (p) => fs.realpathSync.native(p);
const isIntegration = (cwd) => real(cwd).endsWith(`${path.sep}_integration`);
const intWt = (dir) => path.join(dir, '.harness', 'wt', '_integration');
const featureWt = (dir) => path.join(dir, '.harness', 'wt', 'F1');
const integ = (dir) => git(dir, 'rev-parse', 'harness/integration');

const OK_INTEGRITY = { markers: [], harnessPaths: [], testCount: { status: 'unset' } };
const PASSING = { pass: true, commands: [], criteria: [{ id: 'AC-1', pass: true }], integrity: OK_INTEGRITY, warnings: [] };
const FAILING = {
  pass: false, commands: [{ cmd: 'npm test', pass: false, message: 'exit 1', output: 'boom' }],
  criteria: [{ id: 'AC-1', pass: false, message: 'exit 1' }], integrity: OK_INTEGRITY, warnings: [],
};

// Fake verify: the integration worktree fails until fixed.txt is there; the feature worktree
// fails while broken.txt is there. `integration(a)` overrides the integration result.
function fakeVerify({ integration } = {}) {
  const calls = [];
  const fn = async (a) => {
    const onInt = isIntegration(a.cwd);
    calls.push({ cwd: a.cwd, base: a.base, integration: onInt });
    if (onInt) return integration ? integration(a) : (fs.existsSync(path.join(a.cwd, 'fixed.txt')) ? PASSING : FAILING);
    return fs.existsSync(path.join(a.cwd, 'broken.txt')) ? FAILING : PASSING;
  };
  fn.calls = calls;
  return fn;
}

// Fake builder: a normal build writes F1.txt (plus `edit`), the recovery build writes `fix`.
function fakeBuild({ edit = {}, fix = { 'fixed.txt': 'fixed\n' }, resolve = { 'shared.txt': 'both\n' }, result, onCall } = {}) {
  const calls = [];
  const fn = async (a) => {
    const kind = a.postMergeFailures ? 'recover' : a.conflicts ? 'resolve' : 'build';
    // The worktree of a passed feature is removed: its real path is taken while it exists.
    const c = { kind, cwd: real(a.cwd), wt: real(featureWt(a.root)), round: a.round, postMergeFailures: a.postMergeFailures, conflicts: a.conflicts };
    calls.push(c);
    if (onCall) await onCall(a, c);
    writeFiles(a.cwd, kind === 'recover' ? fix : kind === 'resolve' ? resolve : { 'F1.txt': 'built\n', ...edit });
    return (result && result(kind)) || { ok: true, costUsd: 0 };
  };
  fn.calls = calls;
  fn.of = (kind) => calls.filter((c) => c.kind === kind);
  return fn;
}

function fakeEvaluate(verdicts = []) {
  const calls = [];
  const fn = async (a) => {
    calls.push({ cwd: a.cwd, base: a.base });
    const verdict = verdicts[calls.length - 1] ?? 'pass';
    const blocking = verdict === 'fail' ? [{ criterion_id: 'AC-1', summary: 'broken' }] : [];
    return { feature: a.featureId, round: a.round, verdict, score: 8, scores: {}, blocking, backlogged: [], independence: 'cross-model', costUsd: 0, file: null };
  };
  fn.calls = calls;
  return fn;
}

// A commit lands on integration while F1 builds: F1's base is no longer integration's tip.
const landOnIntegration = (dir, files) => {
  writeFiles(intWt(dir), files);
  return commitAll(intWt(dir), 'meanwhile on integration');
};

const runF = (dir, deps) => run.runFeatures({ root: dir, config: cfg(), deps: { evaluate: fakeEvaluate(), cpus: 8, ...deps } });
const f1 = (r) => r.results.find((x) => x.feature === 'F1');

// ------------------------------------------------------------------ AC-1
const markers = (text) => (typeof run.hasConflictMarkers === 'function' ? run.hasConflictMarkers(text) : text.includes('<<<<<<<'));

test('F32 AC-1: a conflict marker quoted mid-line is not a marker', () => {
  assert.equal(typeof run.hasConflictMarkers, 'function');
  assert.equal(markers('The markers look like `<<<<<<<`, `=======` and `>>>>>>>`.\n'), false);
  assert.equal(markers('x <<<<<<< HEAD\ny >>>>>>> F1\n'), false);
});

test('F32 AC-1: a line starting with "<<<<<<< " is a marker', () => {
  assert.equal(markers('a\n<<<<<<< HEAD\nb\n'), true);
});

test('F32 AC-1: a line starting with ">>>>>>> " is a marker', () => {
  assert.equal(markers('a\n>>>>>>> harness/integration\n'), true);
});

test('F32 AC-1: a line that is "=======" alone is a marker (LF and CRLF)', () => {
  assert.equal(markers('a\n=======\nb\n'), true);
  assert.equal(markers('a\r\n=======\r\nb\r\n'), true);
  assert.equal(markers('a\n======== \nb ======= c\n'), false);
});

// The feature and a commit on integration both change doc.md: the merge conflicts and the
// resolving builder writes `resolved`.
async function conflictRun(resolved) {
  const dir = fixture({ 'doc.md': 'original\n' });
  const build = fakeBuild({
    edit: { 'doc.md': 'changed by F1\n' },
    resolve: { 'doc.md': resolved },
    onCall: (a, c) => { if (c.kind === 'build') landOnIntegration(dir, { 'doc.md': 'changed on integration\n' }); },
  });
  const r = await runF(dir, { build, verify: fakeVerify({ integration: () => PASSING }) });
  return { dir, r, build };
}

test('F32 AC-1: a conflicted doc that quotes `<<<<<<<` mid-line is accepted as resolved → passed', async () => {
  const { dir, r, build } = await conflictRun('Git writes `<<<<<<<`, `=======` and `>>>>>>>` around a conflict.\n');
  assert.equal(build.of('resolve').length, 1);
  assert.equal(f1(r).status, 'passed', JSON.stringify(f1(r)));
  assert.match(git(dir, 'show', 'harness/integration:doc.md'), /`<<<<<<<`/);
});

for (const [name, text] of [
  ['"<<<<<<< "', '<<<<<<< HEAD\nmine\n'],
  ['">>>>>>> "', 'mine\n>>>>>>> harness/integration\n'],
  ['"=======" alone', 'mine\n=======\ntheirs\n'],
]) {
  test(`F32 AC-1: a ${name} line left at the line start → blocked(merge_conflict)`, async () => {
    const { dir, r } = await conflictRun(text);
    assert.equal(f1(r).status, 'blocked');
    assert.equal(f1(r).reason, 'merge_conflict');
    assert.match(f1(r).detail, /marker/);
    assert.equal(statusOf(dir), 'blocked');
  });
}

// ------------------------------------------------------------------ AC-2
test('F32 AC-2: a failed post-merge verify goes to the builder once in the feature worktree with integration merged, then verify, eval (base integration) and merge → passed', async () => {
  const dir = fixture();
  let intTip = null;
  let atRecovery = null;
  const build = fakeBuild({
    onCall: (a, c) => {
      if (c.kind === 'build') intTip = landOnIntegration(dir, { 'other.txt': 'other\n' });
      if (c.kind === 'recover') {
        const wt = featureWt(dir);
        atRecovery = {
          containsIntegration: spawnSync('git', ['merge-base', '--is-ancestor', intTip, 'HEAD'], { cwd: wt }).status === 0,
          other: fs.existsSync(path.join(wt, 'other.txt')),
          integration: integ(dir),
        };
      }
    },
  });
  const verify = fakeVerify();
  const evaluate = fakeEvaluate();
  const r = await runF(dir, { build, verify, evaluate });
  assert.equal(f1(r).status, 'passed', JSON.stringify(f1(r)));
  assert.equal(statusOf(dir), 'passed');
  const rec = build.of('recover');
  assert.equal(rec.length, 1, 'one recovery call');
  assert.equal(rec[0].cwd, rec[0].wt);
  assert.deepEqual(rec[0].postMergeFailures.map((f) => f.item), ['npm test', 'AC-1']);
  assert.match(rec[0].postMergeFailures[0].message, /exit 1: boom/);
  assert.deepEqual(atRecovery, { containsIntegration: true, other: true, integration: intTip });
  assert.equal(evaluate.calls.length, 2, 'evaluated again after the recovery');
  assert.notEqual(evaluate.calls[0].base, intTip);
  assert.equal(evaluate.calls[1].base, intTip, 'the re-evaluation is against the integration commit');
  const featureVerifies = verify.calls.filter((c) => !c.integration);
  assert.equal(featureVerifies.length, 2, 'verified again after the recovery');
  assert.equal(featureVerifies[1].base, intTip);
  for (const f of ['F1.txt', 'fixed.txt', 'other.txt']) git(dir, 'cat-file', '-e', `harness/integration:${f}`);
  assert.equal(f1(r).rounds, 1);
});

test('F32 AC-2: the recovery prompt names the failed items', () => {
  const prompt = run.builderPrompt({
    rolePrompt: 'role', featureId: 'F1', round: 1, attempt: 1, contract: {}, findings: [],
    postMergeFailures: [{ item: 'npm test', message: 'exit 1: boom' }, { item: 'AC-1', message: 'exit 1' }],
  });
  assert.match(prompt, /verify failed on the integration branch/i);
  assert.match(prompt, /npm test/);
  assert.match(prompt, /exit 1: boom/);
  assert.match(prompt, /AC-1/);
});

// ------------------------------------------------------------------ AC-3
async function recoveryRun({ build: buildOpts = {}, verify: verifyOpts, evaluate } = {}) {
  const dir = fixture();
  let preMerge = null;
  const log = (m) => { if (/^F1: post-merge verify failed/.test(m)) preMerge = integ(dir); };
  const build = fakeBuild(buildOpts);
  const r = await runF(dir, { build, verify: fakeVerify(verifyOpts), log, ...(evaluate ? { evaluate } : {}) });
  return { dir, r, build, preMerge, before: git(dir, 'rev-parse', 'main') };
}

const assertBlockedPostMerge = (x) => {
  assert.equal(f1(x.r).status, 'blocked', JSON.stringify(f1(x.r)));
  assert.equal(f1(x.r).reason, 'post_merge_verify');
  assert.equal(statusOf(x.dir), 'blocked');
  assert.equal(integ(x.dir), x.before, 'integration is the commit before the feature\'s merge');
  assert.equal(f1(x.r).rounds, 1, 'no round consumed');
  assert.equal(x.build.of('recover').length <= 1, true, 'at most one recovery');
};

test('F32 AC-3: the recovery builder fails → blocked(post_merge_verify), integration unchanged', async () => {
  const x = await recoveryRun({ build: { result: (k) => (k === 'recover' ? { ok: false, error: 'exit_nonzero', costUsd: 0 } : null) } });
  assertBlockedPostMerge(x);
  assert.equal(x.build.of('recover').length, 1);
});

test('F32 AC-3: the post-merge verify fails again after the recovery → blocked(post_merge_verify), one recovery only', async () => {
  const x = await recoveryRun({ build: { fix: { 'notfixed.txt': 'x\n' } } });
  assertBlockedPostMerge(x);
  assert.equal(x.build.of('recover').length, 1);
  assert.equal(x.build.of('build').length, 1);
});

test('F32 AC-3: verify fails in the feature worktree after the recovery → blocked(post_merge_verify)', async () => {
  const x = await recoveryRun({ build: { fix: { 'fixed.txt': 'x\n', 'broken.txt': 'x\n' } } });
  assertBlockedPostMerge(x);
  assert.equal(x.build.of('build').length, 1, 'no build retry after a recovery');
});

test('F32 AC-3: evaluation fails after the recovery → blocked(post_merge_verify)', async () => {
  const x = await recoveryRun({ evaluate: fakeEvaluate(['pass', 'fail']) });
  assertBlockedPostMerge(x);
  assert.equal(x.build.of('build').length, 1);
});

test('F32 AC-3: after a conflict resolution a failed post-merge verify is not recovered → blocked(post_merge_verify)', async () => {
  const dir = fixture();
  let before = null;
  const build = fakeBuild({
    edit: { 'shared.txt': 'changed by F1\n' },
    onCall: (a, c) => { if (c.kind === 'build') before = landOnIntegration(dir, { 'shared.txt': 'changed on integration\n' }); },
  });
  const r = await runF(dir, { build, verify: fakeVerify() });
  assert.equal(build.of('resolve').length, 1);
  assert.equal(build.of('recover').length, 0, 'resolution and recovery together are once per feature');
  assert.equal(f1(r).status, 'blocked');
  assert.equal(f1(r).reason, 'post_merge_verify');
  assert.equal(integ(dir), before);
  assert.equal(f1(r).rounds, 1);
});

test('F32 AC-3: after a post-merge recovery a merge conflict is not resolved again → blocked(merge_conflict)', async () => {
  const dir = fixture();
  let tip = null;
  const build = fakeBuild({
    edit: { 'shared.txt': 'changed by F1\n' },
    onCall: (a, c) => { if (c.kind === 'recover') tip = landOnIntegration(dir, { 'shared.txt': 'changed on integration\n' }); },
  });
  const r = await runF(dir, { build, verify: fakeVerify() });
  assert.equal(build.of('recover').length, 1);
  assert.equal(build.of('resolve').length, 0);
  assert.equal(f1(r).status, 'blocked');
  assert.equal(f1(r).reason, 'merge_conflict');
  assert.equal(integ(dir), tip);
});

// ------------------------------------------------------------------ AC-4
test('F32 AC-4: the report shows each feature\'s merge recovery and its result', async () => {
  const x = await recoveryRun();
  const md = fs.readFileSync(x.r.report, 'utf8');
  assert.match(md, /\| Merge recovery \|/);
  assert.match(md, /\| F1 feature F1 \| passed \|.*\| post_merge_verify → passed \| no \|$/m);
  const y = await recoveryRun({ build: { fix: {} } });
  assert.match(fs.readFileSync(y.r.report, 'utf8'), /\| F1 feature F1 \| blocked \|.*\| post_merge_verify → failed \| no \|$/m);
  assert.deepEqual(f1(y.r).mergeRecovery, { kind: 'post_merge_verify', result: 'failed' });
  const z = await conflictRun('both\n');
  assert.match(fs.readFileSync(z.r.report, 'utf8'), /\| F1 feature F1 \| passed \|.*\| conflict → passed \| resolved \|$/m);
});

test('F32 AC-4: a feature merged without a recovery shows none', () => {
  const md = run.renderReport({
    runId: 'x', startedAt: 's', config: { integration_branch: 'i', base_branch: 'main' }, costUsd: 0, stopped: null,
    results: [{ feature: 'F1', title: 't', status: 'passed', rounds: 1, history: [[]], mergeRecovery: null, conflictResolution: 'no' }],
  }, { finishedAt: 'f' });
  assert.match(md, /\| F1 t \| passed \|.*\| none \| no \|$/m);
});

const SPEC = () => fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
const section8 = () => { const s = SPEC(); return s.slice(s.indexOf('## 8.'), s.indexOf('## 9.')); };

test('F32 AC-4: SPEC §8 describes the post-merge recovery, the marker rule and the report column', () => {
  const s8 = section8();
  const rule = s8.split('\n').find((l) => l.startsWith('- **병합 후 verify 복구**'));
  assert.ok(rule, 'no post-merge recovery rule in §8');
  for (const w of ['builder 를 1회', '합쳐서 기능당 1회', '라운드를 소모하지 않는다', 'post_merge_verify', 'integration', '명령 없음']) {
    assert.ok(rule.includes(w), `rule lacks ${w}`);
  }
  assert.match(s8, /줄 시작/);
  assert.match(s8, /Merge recovery/);
  assert.match(s8, /flaky_tests/);
});

test('F32 AC-4: docs/run.md describes merge recovery and the failure records; README points to it', () => {
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'run.md'), 'utf8');
  for (const w of ['post_merge_verify', 'merge_conflict', '<<<<<<< ', 'verify_failures', 'flaky_tests', 'Merge recovery', '1회']) {
    assert.ok(doc.includes(w), `docs/run.md lacks ${w}`);
  }
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  assert.ok(readme.includes('docs/run.md'));
  assert.ok(readme.split('\n').length <= 200, 'README longer than 200 lines');
});

// ------------------------------------------------------------------ AC-5
function evalFixture() {
  const c = contract('F9');
  return gitRepo({
    '.harness/config.json': {
      profile: 'sdlc', base_branch: 'main', verify: { commands: [] },
      roles: { builder: 'claude', evaluator: 'generic', 'security-reviewer': 'generic' },
      adapters: { generic: { read_only_command: [process.execPath, path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs'), 'exit', '1'] } },
    },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': c,
    '.harness/backlog.json': { items: [] },
    'scripts/ok.mjs': 'process.exit(0);\n',
  });
}

const reply = () => {
  const json = { scores: { functionality: 9, quality: 9, security: 9, errors: 9, tests: 9 }, findings: [], out_of_scope: [] };
  return { ok: true, error: null, text: JSON.stringify(json), json, costUsd: 0, exitCode: 0 };
};

async function evalCmd(dir, verifyResult) {
  const out = [];
  let code;
  try {
    code = await evalCommand({ root: dir, args: ['F9'], out: (s) => out.push(s), err: () => {}, deps: { runAdapter: async () => reply(), verifyResult } });
  } catch (e) {
    if (!(e instanceof HarnessError)) throw e;
    code = e.exit;
    out.push(e.message);
  }
  const file = path.join(dir, '.harness', 'verdicts', 'F9-r1.json');
  return { code, out: out.join('\n'), verdict: fs.existsSync(file) ? readJson(file) : null };
}

test('F32 AC-5: an eval that fails on verify records verify_failures in the verdict and prints them', async () => {
  const dir = evalFixture();
  const long = 'E'.repeat(1000);
  const vr = { ...FAILING, commands: [{ cmd: 'npm test', pass: false, message: 'exit 1', output: long }] };
  const x = await evalCmd(dir, vr);
  assert.equal(x.code, 1, x.out);
  assert.equal(x.verdict.verdict, 'fail');
  const vf = x.verdict.verify_failures;
  assert.deepEqual(vf.map((f) => f.item), ['npm test', 'AC-1']);
  assert.equal(vf[0].message.length, 300, 'message cut at 300 characters');
  assert.ok(vf[0].message.startsWith('exit 1: EEE'));
  assert.equal(vf[1].message, 'exit 1');
  assert.match(x.out, /verify failures:/);
  assert.ok(x.out.includes(`npm test — ${vf[0].message}`), x.out);
  assert.ok(x.out.includes('AC-1 — exit 1'), x.out);
});

test('F32 AC-5: an eval with a passing verify records no verify_failures', async () => {
  const x = await evalCmd(evalFixture(), PASSING);
  assert.equal(x.verdict.verdict, 'pass', x.out);
  assert.equal(x.verdict.verify_failures, undefined);
  assert.doesNotMatch(x.out, /verify failures:/);
});

// ------------------------------------------------------------------ AC-6
const names = (text) => (typeof failures.failedTestNames === 'function' ? failures.failedTestNames(text) : []);

test('F32 AC-6: failed test names come from lines starting with "✖ " or "not ok "', () => {
  const out = [
    '✔ passes (1.1ms)',
    '✖ first flaky (12.5ms)',
    '  ✖ nested flaky (3ms)',
    'not ok 4 - tap flaky',
    '    not ok 1 - tap nested # TODO',
    'ok 5 - fine',
    'some ✖ mid-line',
    '✖ failing tests:',
    '✖ first flaky (12.5ms)',
  ].join('\n');
  assert.deepEqual(names(out), ['first flaky', 'nested flaky', 'tap flaky', 'tap nested']);
});

test('F32 AC-6: at most 20 flaky test names are kept', () => {
  const out = Array.from({ length: 30 }, (_, i) => `not ok ${i + 1} - t${i}`).join('\n');
  const got = names(out);
  assert.equal(got.length, 20);
  assert.equal(got[19], 't19');
});

// A verify command that fails on its first run (printing failed tests) and passes on the re-run.
function flakyRepo(lines) {
  const c = contract('F1');
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: ['node scripts/flaky.mjs'] } },
    '.harness/features.json': { features: [{ id: 'F1', title: 'f', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F1.json': c,
    '.harness/backlog.json': { items: [] },
    '.gitignore': 'ran.flag\n',
    'scripts/ok.mjs': 'process.exit(0);\n',
    'scripts/flaky.mjs': [
      "import fs from 'node:fs';",
      "if (fs.existsSync('ran.flag')) process.exit(0);",
      "fs.writeFileSync('ran.flag', '1');",
      `console.log(${JSON.stringify(lines.join('\n'))});`,
      'process.exit(1);',
      '',
    ].join('\n'),
  });
  return dir;
}

test('F32 AC-6: verify records the first run\'s failed test names as flaky_tests', async () => {
  const dir = flakyRepo(['✔ ok one (1ms)', '✖ flaky one (2ms)', 'not ok 3 - flaky two']);
  const config = resolveConfig({ base_branch: 'main', verify: { commands: ['node scripts/flaky.mjs'] }, budget: { step_timeout_sec: 60 } });
  const v = await realVerify({ root: dir, featureId: 'F1', base: 'main', config, cpus: 1 });
  assert.equal(v.commands[0].flaky, true);
  assert.deepEqual(v.commands[0].flaky_tests, ['flaky one', 'flaky two']);
  assert.deepEqual(v.flaky_tests, ['flaky one', 'flaky two']);
});

test('F32 AC-6: a command that fails on both runs has no flaky_tests', async () => {
  const dir = flakyRepo(['✖ always (1ms)']);
  fs.writeFileSync(path.join(dir, 'scripts', 'flaky.mjs'), "console.log('✖ always (1ms)');\nprocess.exit(1);\n");
  commitAll(dir, 'always fails');
  const config = resolveConfig({ base_branch: 'main', verify: { commands: ['node scripts/flaky.mjs'] }, budget: { step_timeout_sec: 60 } });
  const v = await realVerify({ root: dir, featureId: 'F1', base: 'main', config, cpus: 1 });
  assert.equal(v.commands[0].flaky, false);
  assert.equal(v.commands[0].flaky_tests, undefined);
  assert.equal(v.flaky_tests, undefined);
});

test('F32 AC-6: the verdict records flaky_tests from the verify result', async () => {
  const x = await evalCmd(evalFixture(), { ...FAILING, flaky_tests: ['flaky one', 'flaky two'] });
  assert.deepEqual(x.verdict.flaky_tests, ['flaky one', 'flaky two']);
  assert.match(x.out, /flaky tests: flaky one, flaky two/);
});

test('F32 AC-6: the run report and result list a feature\'s flaky tests', async () => {
  const dir = fixture();
  let n = 0;
  const verify = async (a) => {
    if (isIntegration(a.cwd)) return PASSING;
    n += 1;
    return n === 1 ? { ...FAILING, flaky_tests: ['flaky one', 'flaky two'] } : PASSING;
  };
  const r = await runF(dir, { build: fakeBuild(), verify });
  assert.equal(f1(r).status, 'passed', JSON.stringify(f1(r)));
  assert.deepEqual(f1(r).flaky_tests, ['flaky one', 'flaky two']);
  const md = fs.readFileSync(r.report, 'utf8');
  assert.match(md, /## Flaky tests/);
  assert.match(md, /- F1: `flaky one`, `flaky two`/);
});

// ------------------------------------------------------------------ SC-1
test('F32 SC-1: the recovery builder runs only in the feature worktree; integration does not move until the recovered feature merges', async () => {
  const dir = fixture();
  let preMerge = null;
  const seen = {};
  const log = (m) => { if (/^F1: post-merge verify failed/.test(m)) preMerge = integ(dir); };
  const build = fakeBuild({
    onCall: (a, c) => {
      if (c.kind === 'recover') { seen.cwd = real(a.cwd); seen.wt = c.wt; seen.duringBuild = integ(dir); }
    },
  });
  const evaluate = fakeEvaluate();
  const evalWrap = async (a) => {
    if (preMerge) seen.duringEval = integ(dir);
    return evaluate(a);
  };
  const verify = fakeVerify();
  const verifyWrap = async (a) => {
    if (preMerge && !isIntegration(a.cwd)) seen.duringVerify = integ(dir);
    return verify(a);
  };
  const r = await runF(dir, { build, evaluate: evalWrap, verify: verifyWrap, log });
  assert.equal(f1(r).status, 'passed');
  assert.ok(preMerge);
  assert.equal(preMerge, git(dir, 'rev-parse', 'main'), 'the failed merge was rolled back');
  assert.equal(seen.cwd, seen.wt);
  assert.deepEqual([seen.duringBuild, seen.duringVerify, seen.duringEval], [preMerge, preMerge, preMerge]);
  assert.notEqual(integ(dir), preMerge, 'integration moves with the final merge');
  assert.equal(git(dir, 'rev-parse', 'harness/integration^1'), preMerge);
});

// ------------------------------------------------------------------ ES-1
test('F32 ES-1: a post-merge verify that fails on a missing command is not recovered; the run stops on the environment', async () => {
  const dir = fixture();
  const notFound = {
    ...FAILING,
    commands: [{ cmd: 'harness-f32-missing test', pass: false, message: 'command not found: harness-f32-missing', notFound: 'harness-f32-missing' }],
    criteria: [{ id: 'AC-1', pass: true }],
  };
  const build = fakeBuild();
  const r = await runF(dir, { build, verify: fakeVerify({ integration: () => notFound }) });
  assert.equal(r.interrupted, true);
  assert.equal(r.environment?.stage, 'post_merge_verify');
  assert.equal(r.environment?.program, 'harness-f32-missing');
  assert.equal(build.of('recover').length, 0, 'no recovery');
  assert.equal(integ(dir), git(dir, 'rev-parse', 'main'), 'integration rolled back');
  assert.equal(statusOf(dir), 'in_progress');
});
