import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import * as run from '../lib/run.mjs';

// ------------------------------------------------------------------ fixtures

const SCRIPTS = {
  'scripts/has.mjs': "import fs from 'node:fs';\nprocess.exit(process.argv.slice(2).every((f) => fs.existsSync(f)) ? 0 : 1);\n",
};

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
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract('F1'),
    ...SCRIPTS,
  }, { branch: null });
}

const cfg = () => resolveConfig({
  base_branch: 'main', run: { max_parallel: 1 }, verify: { commands: [] }, budget: { step_timeout_sec: 60 },
});

const PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const FAILING = { ...PASSING, pass: false, criteria: [{ id: 'AC-1', check: 'x', pass: false, message: 'exit 1' }] };

function fakeVerify(seq = []) {
  const calls = [];
  const fn = async (a) => { calls.push(a.cwd); return seq[calls.length - 1] ?? PASSING; };
  fn.calls = calls;
  return fn;
}

const evaluate = async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });

// Verifies of the feature worktree (post-merge verify runs in the integration worktree).
const featureVerifies = (verify) => verify.calls.filter((c) => path.basename(c) === 'F1');

// Fake builder: script[i] runs on call i and returns the build result (default: writes F1.txt, ok).
// The prompt of each call is rendered with the real builderPrompt from the arguments the run passed.
function fakeBuild(script = []) {
  const calls = [];
  const fn = async (a) => {
    calls.push({ round: a.round, attempt: a.attempt, prompt: run.builderPrompt({ rolePrompt: 'ROLE', ...a }) });
    const s = script[calls.length - 1];
    if (s) return s(a);
    writeFiles(a.cwd, { 'F1.txt': 'done\n' });
    return { ok: true, costUsd: 0 };
  };
  fn.calls = calls;
  return fn;
}

const TIMEOUT = { ok: false, error: 'timeout', costUsd: null };
const partial = (files = { 'src/part.txt': 'half\n' }) => (a) => { writeFiles(a.cwd, files); return TIMEOUT; };
const idle = () => TIMEOUT;

const runF = (dir, deps) => run.runFeatures({ root: dir, config: cfg(), deps: { evaluate, verify: fakeVerify(), cpus: 8, ...deps } });
const readLines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const buildOutcomes = (r) => readLines(r.report.replace(/\.md$/, '.metrics.jsonl')).filter((m) => m.step === 'build').map((m) => m.outcome);

// ------------------------------------------------------------------ AC-1
test('F43 AC-1: a build timeout with changes in the worktree continues in the next attempt of the same round', async () => {
  const dir = fixture();
  const build = fakeBuild([partial()]);
  const verify = fakeVerify();
  const r = await runF(dir, { build, verify });
  assert.deepEqual([r.results[0].status, r.results[0].reason], ['passed', null]);
  assert.deepEqual(build.calls.map((c) => [c.round, c.attempt]), [[1, 1], [1, 2]], 'the next attempt of the same round');
  assert.equal(featureVerifies(verify).length, 1, 'the timed-out attempt is not verified');
  const [first, second] = build.calls.map((c) => c.prompt);
  assert.doesNotMatch(first, /timed out/i, 'the first attempt gets no continuation note');
  assert.match(second, /previous attempt timed out/i);
  assert.match(second, /continue/i);
  assert.match(second, /- src\/part\.txt/, 'lists the changed file');
});

test('F43 AC-1: committed changes of the timed-out build count as changes', async () => {
  const dir = fixture();
  const build = fakeBuild([(a) => {
    writeFiles(a.cwd, { 'lib/done.txt': 'x\n' });
    commitAll(a.cwd, 'wip');
    return TIMEOUT;
  }]);
  const r = await runF(dir, { build });
  assert.equal(r.results[0].status, 'passed');
  assert.match(build.calls[1].prompt, /- lib\/done\.txt/);
});

// ------------------------------------------------------------------ AC-2
test('F43 AC-2: continuation attempts count toward the 3 attempts; a third timeout blocks with budget', async () => {
  const dir = fixture();
  const build = fakeBuild([partial({ 'a.txt': '1\n' }), partial({ 'b.txt': '2\n' }), partial({ 'c.txt': '3\n' }), partial()]);
  const r = await runF(dir, { build });
  assert.deepEqual([r.results[0].status, r.results[0].reason], ['blocked', 'budget']);
  assert.match(r.results[0].detail, /build timed out after 60s/);
  assert.deepEqual(build.calls.map((c) => [c.round, c.attempt]), [[1, 1], [1, 2], [1, 3]]);
});

test('F43 AC-2: a failed verify and a continued timeout share the 3 attempts', async () => {
  const dir = fixture();
  const build = fakeBuild([undefined, partial(), partial()]);
  const verify = fakeVerify([FAILING]);
  const r = await runF(dir, { build, verify });
  assert.deepEqual([r.results[0].status, r.results[0].reason], ['blocked', 'budget']);
  assert.deepEqual(build.calls.map((c) => c.attempt), [1, 2, 3]);
  assert.equal(featureVerifies(verify).length, 1);
});

// ------------------------------------------------------------------ AC-3
test('F43 AC-3: a build timeout with no change in the worktree is blocked with budget', async () => {
  const dir = fixture();
  const build = fakeBuild([idle]);
  const r = await runF(dir, { build });
  assert.deepEqual([r.results[0].status, r.results[0].reason], ['blocked', 'budget']);
  assert.match(r.results[0].detail, /build timed out after 60s/);
  assert.equal(build.calls.length, 1, 'no continuation without changes');
});

// ------------------------------------------------------------------ AC-4
test("F43 AC-4: the build step of a continued timeout is recorded as 'timeout-continued' in metrics and the report", async () => {
  const dir = fixture();
  const build = fakeBuild([partial()]);
  const r = await runF(dir, { build });
  assert.deepEqual(buildOutcomes(r), ['timeout-continued', 'ok']);
  assert.match(fs.readFileSync(r.report, 'utf8'), /\| build \|[^\n]*\| timeout-continued \|/);

  const dir2 = fixture();
  const r2 = await runF(dir2, { build: fakeBuild([partial(), partial({ 'b.txt': 'b\n' }), partial({ 'c.txt': 'c\n' })]) });
  assert.deepEqual(buildOutcomes(r2), ['timeout-continued', 'timeout-continued', 'timeout'], 'the timeout that blocks stays timeout');
});

// ------------------------------------------------------------------ SC-1
test('F43 SC-1: the continuation prompt names changed paths only — no file content or environment value', async () => {
  const dir = fixture();
  const secret = 'sk-live-F43-9f8e7d6c5b4a3210';
  const build = fakeBuild([partial({ 'config/secret.env': `API_TOKEN=${secret}\n` })]);
  const r = await runF(dir, { build, env: { ...process.env, API_TOKEN: secret } });
  assert.equal(r.results[0].status, 'passed');
  const prompt = build.calls[1].prompt;
  assert.match(prompt, /- config\/secret\.env/);
  assert.ok(!prompt.includes(secret), 'the secret value is not in the prompt');
  assert.ok(!prompt.includes('API_TOKEN='), 'the file content is not in the prompt');
});

// ------------------------------------------------------------------ ES-1
test('F43 ES-1: when the git command checking for changes fails, the timeout is blocked with budget and the git error', async () => {
  const dir = fixture();
  let timedOut = false;
  const build = fakeBuild([(a) => { writeFiles(a.cwd, { 'x.txt': 'x\n' }); timedOut = true; return TIMEOUT; }]);
  const failing = async (args, cwd, opts) => {
    if (timedOut && (args[0] === 'status' || args[0] === 'diff')) {
      timedOut = false;
      return { code: 128, stdout: '', stderr: 'fatal: simulated F43 git failure\n' };
    }
    return run.git(args, cwd, opts);
  };
  const r = await runF(dir, { build, git: failing });
  assert.deepEqual([r.results[0].status, r.results[0].reason], ['blocked', 'budget']);
  assert.match(r.results[0].detail, /build timed out after 60s/);
  assert.match(r.results[0].detail, /simulated F43 git failure/);
  assert.equal(build.calls.length, 1);
});

// ------------------------------------------------------------------ AC-5
test('F43 AC-5: SPEC §8 and docs/run.md explain the build continuation rule', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs/SPEC.md'), 'utf8');
  const s8 = spec.slice(spec.indexOf('## 8.'), spec.indexOf('\n## ', spec.indexOf('## 8.') + 1));
  const doc = fs.readFileSync(path.join(REPO, 'docs/run.md'), 'utf8');
  for (const [name, text] of [['SPEC §8', s8], ['docs/run.md', doc]]) {
    assert.ok(text.includes('timeout-continued'), `${name} names the outcome`);
    assert.match(text, /이어가기/, `${name} names the continuation`);
    assert.match(text, /변경 파일/, `${name} says the prompt lists changed files`);
    assert.match(text, /3회/, `${name} says continuations count toward the 3 attempts`);
    assert.match(text, /blocked\(`?budget`?\)/, `${name} says a timeout without changes is blocked(budget)`);
  }
});
