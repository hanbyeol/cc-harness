import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BIN, REPO, tmpdir, fakeNodeCli } from './helpers.mjs';
import { gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { getAdapter } from '../lib/adapters/index.mjs';
import { HarnessError } from '../lib/errors.mjs';
import * as run from '../lib/run.mjs';

const FIX = path.join(REPO, 'test', 'fixtures');
const FAKE = path.join(FIX, 'fake-cli.mjs');
const FAKE_BUILDER = path.join(FIX, 'fake-claude-builder.mjs');
const REPLY_PASS = path.join(FIX, 'eval', 'pass.json');
const REFUSAL = fs.readFileSync(path.join(FIX, 'output', 'claude-json-refusal.json'), 'utf8');

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
  c.approval = { by: 'test', at: '2026-10-10T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture(ids = ['F1'], { config = {}, files = {} } = {}) {
  const all = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...config },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: 'standard', depends_on: [], status: 'approved' })) },
    ...SCRIPTS,
    ...files,
  };
  for (const id of ids) all[`.harness/contracts/${id}.json`] = contract(id);
  return gitRepo(all, { branch: null });
}

const COMMANDS = ['node --test "test/**/*.test.mjs"', 'npm run lint'];
const cfg = (over = {}) => resolveConfig({
  base_branch: 'main', run: { max_parallel: 1 }, verify: { commands: COMMANDS }, budget: { step_timeout_sec: 60 }, ...over,
});
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const readLines = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const runMetrics = (r) => readLines(r.report.replace(/\.md$/, '.metrics.jsonl'));
const featureOf = (dir, id = 'F1') => readJson(path.join(dir, '.harness/features.json')).features.find((f) => f.id === id);
const same = (a, b) => fs.realpathSync.native(a) === fs.realpathSync.native(b);
const intWtOf = (dir) => path.join(dir, '.harness', 'wt', '_integration');

const PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const FAILING = { ...PASSING, pass: false, criteria: [{ id: 'AC-1', check: 'x', pass: false, message: 'exit 1' }] };
const evaluatePass = async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });
const usableRoles = async () => ({ roles: ['builder', 'evaluator', 'security-reviewer'].map((role) => ({ role, adapter: 'claude', usable: true })) });

// A verify that, on its first call in the feature worktree, commits a change to the integration
// branch: one to shared.txt (a conflict with the feature) or to other.txt (a later post-merge
// verify failure). The post-merge verify fails until the feature has fixed.txt.
function scenarioVerify(dir, kind) {
  let moved = false;
  return async (a) => {
    const intWt = intWtOf(dir);
    if (!moved && fs.existsSync(intWt) && !same(a.cwd, intWt)) {
      moved = true;
      writeFiles(intWt, kind === 'conflict' ? { 'shared.txt': 'integration\n' } : { 'other.txt': 'x\n' });
      commitAll(intWt, 'meanwhile on integration');
    }
    if (kind === 'post-merge' && same(a.cwd, intWt) && !fs.existsSync(path.join(a.cwd, 'fixed.txt'))) return FAILING;
    return PASSING;
  };
}

const kindOf = (a) => (a.conflicts ? 'conflict' : a.postMergeFailures ? 'post-merge' : 'build');

// ------------------------------------------------------------------ AC-1

// The prompt's `## Verification` section lines up to the next heading.
function section(prompt) {
  const at = prompt.indexOf('\n## Verification\n');
  if (at === -1) return null;
  const rest = prompt.slice(at + '\n## Verification\n'.length).split('\n');
  const end = rest.findIndex((l) => l.startsWith('#'));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}
const listed = (s) => s.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
const promptKind = (p) => (p.includes('# Merge conflict resolution') ? 'conflict' : p.includes('# Post-merge verification failure') ? 'post-merge' : 'build');

test('F108 AC-1 builderPrompt without config throws', () => {
  const args = { rolePrompt: 'ROLE', featureId: 'F1', round: 1, attempt: 1, contract: {} };
  for (const config of [undefined, null]) {
    assert.throws(() => run.builderPrompt({ ...args, config }), /config/);
    assert.throws(() => run.builderPrompt({ ...args, config, conflicts: ['a.txt'] }), /config/);
    assert.throws(() => run.builderPrompt({ ...args, config, postMergeFailures: [{ item: 'verify' }] }), /config/);
  }
  // With the config the section is there.
  assert.deepEqual(listed(section(run.builderPrompt({ ...args, config: cfg() }))), COMMANDS);
});

for (const kind of ['conflict', 'post-merge']) {
  test(`F108 AC-1 the real build path hands the claude CLI the verification section: build and ${kind} recovery`, { timeout: 240000 }, async () => {
    const dir = fixture(['F1'], { files: { 'shared.txt': 'original\n' } });
    const prompts = tmpdir('harness-f108-prompts-');
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    const saved = { path: process.env[pathKey], prompts: process.env.FAKE_CLAUDE_PROMPTS };
    process.env[pathKey] = [fakeNodeCli('claude', FAKE_BUILDER), saved.path].join(path.delimiter);
    process.env.FAKE_CLAUDE_PROMPTS = prompts;
    let r;
    try {
      // No deps.build: the run's own defaultBuild calls the claude adapter.
      r = await run.runFeatures({
        root: dir, config: cfg({ roles: { builder: 'claude', evaluator: 'claude', 'security-reviewer': 'claude' } }),
        deps: { verify: scenarioVerify(dir, kind), evaluate: evaluatePass, diagnose: usableRoles, cpus: 8, log: () => {}, warn: () => {} },
      });
    } finally {
      process.env[pathKey] = saved.path;
      if (saved.prompts === undefined) delete process.env.FAKE_CLAUDE_PROMPTS;
      else process.env.FAKE_CLAUDE_PROMPTS = saved.prompts;
    }
    assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results[0]));
    const got = fs.readdirSync(prompts).map((f) => fs.readFileSync(path.join(prompts, f), 'utf8'));
    const kinds = got.map(promptKind).sort();
    assert.deepEqual(kinds, ['build', kind].sort(), 'one build and one recovery call reached the CLI');
    for (const p of got) {
      const s = section(p);
      assert.ok(s, `${promptKind(p)}: has the section`);
      assert.deepEqual(listed(s), COMMANDS, `${promptKind(p)}: lists the config's verify commands`);
      assert.match(s, /Do not run these commands yourself/);
    }
  });
}

// ------------------------------------------------------------------ AC-2, ES-1

const claudeReply = (reply, fail) => {
  const f = path.join(tmpdir('harness-f108-reply-'), 'reply.json');
  fs.writeFileSync(f, reply);
  return (cwd) => getAdapter('claude').run({ prompt: 'x', cwd, timeoutSec: 30, bin: process.execPath, binArgs: [FAKE, fail ? 'print-fail' : 'print', f] });
};

// A builder that builds normally and answers the `kind` recovery call with `answer(cwd)`.
function recoveryBuilder(kind, answer) {
  const calls = [];
  const fn = async (a) => {
    const k = kindOf(a);
    calls.push(k);
    if (k === kind) return answer(a.cwd);
    writeFiles(a.cwd, { 'F1.txt': 'built\n', 'shared.txt': 'feature\n' });
    return { ok: true, costUsd: 0 };
  };
  fn.calls = calls;
  return fn;
}

async function recoveryRun(kind, answer) {
  const dir = fixture(['F1'], { files: { 'shared.txt': 'original\n' } });
  const build = recoveryBuilder(kind, answer);
  const logs = [];
  const r = await run.runFeatures({
    root: dir, config: cfg(),
    deps: { build, verify: scenarioVerify(dir, kind), evaluate: evaluatePass, cpus: 8, log: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  return { dir, r, build, out: logs.join('\n') };
}

const STEP = { conflict: 'conflict_resolve', 'post-merge': 'post_merge_recovery' };

for (const kind of ['conflict', 'post-merge']) {
  test(`F108 AC-2 a refused ${kind} recovery build blocks the feature (refusal) without asking again`, { timeout: 240000 }, async () => {
    const { dir, r, build, out } = await recoveryRun(kind, claudeReply(REFUSAL, false));
    const f1 = r.results[0];
    assert.equal(f1.status, 'blocked', out);
    assert.equal(f1.reason, 'refusal', JSON.stringify(f1));
    assert.equal(build.calls.filter((k) => k === kind).length, 1, `one ${kind} call: ${build.calls.join(', ')}`);
    assert.equal(featureOf(dir).status, 'blocked');
    assert.equal(featureOf(dir).blocked_reason, 'refusal');
    const steps = runMetrics(r).filter((m) => m.step === STEP[kind]);
    assert.deepEqual(steps.map((m) => m.outcome), ['refusal']);
    // The merge the recovery started is not left in progress in the feature worktree.
    const wt = path.join(dir, '.harness', 'wt', 'F1');
    if (fs.existsSync(wt)) {
      const head = spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: wt, encoding: 'utf8' });
      assert.notEqual(head.status, 0, 'no merge in progress');
    }
  });
}

const BEFORE = { conflict: 'merge_conflict', 'post-merge': 'post_merge_verify' };
for (const kind of ['conflict', 'post-merge']) {
  for (const error of ['exit_nonzero', 'timeout']) {
    test(`F108 ES-1 a ${kind} recovery build ending in ${error} is blocked as before (${BEFORE[kind]})`, { timeout: 240000 }, async () => {
      const answer = error === 'exit_nonzero' ? claudeReply('not json', true) : async () => ({ ok: false, error: 'timeout', detail: 'timed out', costUsd: null });
      const { dir, r, build, out } = await recoveryRun(kind, answer);
      const f1 = r.results[0];
      assert.equal(f1.status, 'blocked', out);
      assert.equal(f1.reason, BEFORE[kind], JSON.stringify(f1));
      assert.equal(featureOf(dir).blocked_reason, BEFORE[kind]);
      assert.equal(build.calls.filter((k) => k === kind).length, 1);
      assert.deepEqual(runMetrics(r).filter((m) => m.step === STEP[kind]).map((m) => m.outcome), [error]);
    });
  }
}

// ------------------------------------------------------------------ AC-3

const configError = (user) => {
  try { resolveConfig(user); } catch (err) { return err; }
  return null;
};

test('F108 AC-3 effort on a user-defined role without an adapter names the role and how to fix it', () => {
  for (const role of ['custom', 'reviewer-2']) {
    const err = configError({ roles: { [role]: { effort: 'high' } } });
    assert.ok(err instanceof HarnessError, 'rejected');
    assert.equal(err.code, 'config_invalid');
    assert.ok(!/adapter null/.test(err.message), err.message);
    assert.ok(err.message.includes(`roles.${role}.effort`), err.message);
    assert.match(err.message, new RegExp(`role '${role}' has no adapter`));
    assert.ok(err.message.includes(`'roles.${role}.adapter' to 'claude'`), err.message);
  }
  // With the adapter it is accepted.
  assert.equal(resolveConfig({ roles: { custom: { adapter: 'claude', effort: 'high' } } }).roles.custom.effort, 'high');
});

test('F108 AC-3 an adapter other than claude keeps the message it had', () => {
  for (const [roles, adapter] of [[{ builder: { adapter: 'codex', effort: 'high' } }, 'codex'], [{ custom: { adapter: 'gemini', effort: 'low' } }, 'gemini'], [{ evaluator: { adapter: null, effort: 'low' } }, null]]) {
    const err = configError({ roles });
    const role = Object.keys(roles)[0];
    assert.equal(err?.code, 'config_invalid');
    assert.equal(err.message, `config: 'roles.${role}.effort' is only supported by the claude adapter, got adapter ${JSON.stringify(adapter)}`);
  }
});

// ------------------------------------------------------------------ AC-4

const FOUR = ['F1', 'F2', 'F3', 'F4'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statePath = (dir) => path.join(dir, '.harness/runs/current.json');

test('F108 AC-4 harness run --resume --parallel 1 through the CLI runs one fake claude builder at a time and saves maxParallel 1', { timeout: 300000 }, async () => {
  const config = {
    roles: { builder: 'claude', evaluator: 'generic', 'security-reviewer': 'generic' },
    adapters: { generic: { command: [process.execPath, FAKE, 'print', REPLY_PASS], read_only_command: [process.execPath, FAKE, 'print', REPLY_PASS] } },
  };
  const dir = fixture(FOUR, { config });
  // A saved run with all four features active in their build and a limit of 4.
  const controller = new AbortController();
  let started = 0;
  const build = async (a) => {
    if (++started === FOUR.length) controller.abort();
    for (const t0 = Date.now(); !a.signal.aborted && Date.now() - t0 < 30_000;) await sleep(20);
    return { ok: true, costUsd: 0 };
  };
  const first = await run.runFeatures({
    root: dir, config: resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, ...config }), parallel: 4, signal: controller.signal,
    deps: { build, verify: async () => PASSING, evaluate: evaluatePass, log: () => {}, warn: () => {} },
  });
  assert.equal(first.interrupted, true);
  const saved = readJson(statePath(dir));
  assert.deepEqual(saved.active.map((e) => e.feature).sort(), FOUR);
  assert.equal(saved.maxParallel, 4);

  const log = path.join(tmpdir('harness-f108-log-'), 'builds.log');
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const env = { ...process.env, [pathKey]: [fakeNodeCli('claude', FAKE_BUILDER), process.env[pathKey]].join(path.delimiter),
    FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_STATE: statePath(dir), FAKE_CLAUDE_HOLD_MS: '300' };
  const r = spawnSync(process.execPath, [BIN, 'run', '--resume', '--parallel', '1'], { cwd: dir, env, encoding: 'utf8', timeout: 240000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);

  const lines = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.split(' '));
  const starts = lines.filter((l) => l[0] === 'start');
  assert.equal(starts.length, FOUR.length, 'one build per feature');
  let current = 0;
  let max = 0;
  for (const [what] of lines) {
    current += what === 'start' ? 1 : -1;
    max = Math.max(max, current);
  }
  assert.equal(max, 1, 'one fake builder at a time');
  assert.deepEqual(starts.map((l) => l[2]), FOUR.map(() => '1'), 'the state file holds maxParallel 1');
  for (const id of FOUR) assert.equal(featureOf(dir, id).status, 'passed', id);
});

// ------------------------------------------------------------------ AC-5

test('F108 AC-5 SPEC §8 states the refusal condition and the recovery builds\' refusal handling', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const at = spec.indexOf('모델 거부(refusal):');
  assert.ok(at !== -1);
  const para = spec.slice(at, spec.indexOf('\n', at));
  assert.match(para, /wrapper 의 `type` 이 `result` 이고 `stop_reason` 이 문자열 `refusal` 이면/);
  assert.match(para, /`type` 이 `result` 가 아니거나/);
  assert.match(para, /병합 충돌 해결 build 또는 병합 후 verify 복구 build\(§8\.10\)의 결과가 `refusal` 이어도 같은 프롬프트로 다시 부르지 않는다/);
  assert.match(para, /`blocked`\(reason `refusal`/);
  assert.match(para, /`conflict_resolve`·`post_merge_recovery`\)의 metrics 줄 outcome 은 `refusal`/);
});
