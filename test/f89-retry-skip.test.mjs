import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpdir } from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { verify } from '../lib/verify.mjs';
import { runFeatures } from '../lib/run.mjs';

// A test command scripted per attempt: plan[n] is the n-th run's outcome — 'p' passes,
// 'f' prints 'attempt-<n>' and then each '|'-separated name as a failed test ('-' prints
// none) and fails, 'h' hangs past the step timeout. The attempt counter lives in the state file.
const PLAN = [
  "import fs from 'node:fs';",
  'const [plan, names, state] = process.argv.slice(2);',
  "const n = fs.existsSync(state) ? Number(fs.readFileSync(state, 'utf8')) : 0;",
  'fs.writeFileSync(state, String(n + 1));',
  "const step = plan[n] ?? 'p';",
  "if (step === 'p') process.exit(0);",
  "if (step === 'h') setTimeout(() => {}, 20000);",
  'else {',
  '  console.log(`attempt-${n}`);',
  "  if (names !== '-') for (const name of names.split('|')) console.log(`\\u2716 ${name} (1.5ms)`);",
  '  process.exit(1);',
  '}',
  '',
].join('\n');

const contract = (id) => {
  const c = {
    id, title: 'fixture', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'check exists', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-09T00:00:00.000Z', hash: hashContract(c) };
  return c;
};

function fixture(id = 'F9', { forRun = false } = {}) {
  const run = forRun ? { '.harness/backlog.json': { items: [] }, '.harness/.gitignore': 'wt/\n*.tmp-*\n' } : {};
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id, title: 'fixture', security_tier: 'standard', status: 'approved', depends_on: [] }] },
    [`.harness/contracts/${id}.json`]: contract(id),
    'scripts/plan.mjs': PLAN,
    'scripts/ok.mjs': 'process.exit(0);\n',
    '.gitignore': '*.state\n',
    ...run,
  }, forRun ? { branch: null } : undefined);
}

// The state file lives outside the repository, so a run inside a worktree counts there too.
const stateFile = () => path.join(tmpdir('harness-f89-state-'), 'runs.state');
const planCmd = (plan, names, state) => `node scripts/plan.mjs ${plan} "${names}" "${state}"`;
const runsOf = (state) => Number(fs.readFileSync(state, 'utf8'));
const cfg = (over = {}) => resolveConfig({ base_branch: 'main', ...over, verify: { commands: [], ...(over.verify || {}) }, budget: { step_timeout_sec: 60, ...(over.budget || {}) } });
const run = (dir, over = {}) => verify({ root: dir, featureId: 'F9', base: 'main', config: cfg(over) });

const commandEvents = (dir) => {
  const d = path.join(dir, '.harness', 'events');
  let names = [];
  try { names = fs.readdirSync(d).sort(); } catch { return []; }
  return names.flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    .filter((e) => e.stage === 'verify' && e.type === 'command');
};

// ---------- AC-1 ----------
test("F89 AC-1: a first run that fails the feature's own test is not re-run (retry is the default)", async () => {
  const dir = fixture();
  const state = stateFile();
  const r = await run(dir, { verify: { commands: [planCmd('fpp', 'F9 AC-1 own test', state)] } });
  assert.equal(cfg().verify.flaky, 'retry');
  const c = r.commands[0];
  assert.equal(runsOf(state), 1, 'the command ran once');
  assert.deepEqual([c.pass, c.attempts, c.flaky, c.retry_skipped], [false, 1, false, 'own_test'], JSON.stringify(c));
  assert.equal(Boolean(c.flaky_passed), false);
  assert.equal(r.pass, false);
});

test("F89 AC-1: one own test among other failed tests is enough to skip the re-run", async () => {
  const dir = fixture();
  const state = stateFile();
  const r = await run(dir, { verify: { commands: [planCmd('fpp', 'other suite > x|F9 ES-1: own|F90 AC-1 y', state)], flaky: 'retry' } });
  const c = r.commands[0];
  assert.equal(runsOf(state), 1);
  assert.deepEqual([c.pass, c.attempts, c.flaky, c.retry_skipped], [false, 1, false, 'own_test'], JSON.stringify(c));
});

// ---------- AC-2 ----------
test('F89 AC-2: a first run that names no failed test (e.g. lint) is not re-run', async () => {
  const dir = fixture();
  const state = stateFile();
  const r = await run(dir, { verify: { commands: [planCmd('fpp', '-', state)] } });
  const c = r.commands[0];
  assert.equal(runsOf(state), 1);
  assert.deepEqual([c.pass, c.attempts, c.flaky, c.retry_skipped], [false, 1, false, 'no_test_names'], JSON.stringify(c));
  assert.equal(r.pass, false);
});

test('F89 AC-2: a first run that times out is not re-run and keeps timed_out', async () => {
  const dir = fixture();
  const state = stateFile();
  const r = await run(dir, { verify: { commands: [planCmd('hpp', '-', state)] }, budget: { step_timeout_sec: 5 } });
  const c = r.commands[0];
  assert.equal(runsOf(state), 1);
  assert.deepEqual([c.pass, c.attempts, c.timedOut, c.retry_skipped], [false, 1, true, 'no_test_names'], JSON.stringify(c));
  assert.match(c.message, /timed out/);
  const ev = commandEvents(dir);
  assert.deepEqual([ev[0].data.attempts, ev[0].data.timed_out, ev[0].data.retry_skipped], [1, true, 'no_test_names']);
});

// ---------- AC-3 ----------
test("F89 AC-3: failures of other features' tests are re-run as before (fail, pass, pass → attempts 3)", async () => {
  const dir = fixture();
  const state = stateFile();
  const r = await run(dir, { verify: { commands: [planCmd('fpp', 'other test|F90 AC-1 x|F9x y', state)] } });
  const c = r.commands[0];
  assert.equal(runsOf(state), 3);
  assert.deepEqual([c.pass, c.attempts, c.flaky, c.flaky_passed], [true, 3, true, true], JSON.stringify(c));
  assert.equal('retry_skipped' in c, false);
});

test("F89 AC-3: other features' failures that fail again run twice (attempts 2) without retry_skipped", async () => {
  const dir = fixture();
  const state = stateFile();
  const r = await run(dir, { verify: { commands: [planCmd('ffp', 'other test', state)] } });
  const c = r.commands[0];
  assert.equal(runsOf(state), 2);
  assert.deepEqual([c.pass, c.attempts, c.flaky], [false, 2, false], JSON.stringify(c));
  assert.equal('retry_skipped' in c, false);
});

// ---------- AC-4 ----------
test("F89 AC-4: verify.flaky 'fail' still re-runs a failed command once and records flaky", async () => {
  for (const names of ['F9 AC-1 own test', '-', 'other test']) {
    const dir = fixture();
    const state = stateFile();
    const r = await run(dir, { verify: { commands: [planCmd('fpp', names, state)], flaky: 'fail' } });
    const c = r.commands[0];
    assert.equal(runsOf(state), 2, names);
    assert.deepEqual([c.pass, c.attempts, c.flaky], [false, 2, true], `${names}: ${JSON.stringify(c)}`);
    assert.equal('retry_skipped' in c, false, names);
  }
});

// ---------- AC-5 ----------
test('F89 AC-5: the verify/command event carries retry_skipped only for a skipped command', async () => {
  const dir = fixture();
  const [a, b, c, d] = [stateFile(), stateFile(), stateFile(), stateFile()];
  await run(dir, { verify: { commands: [
    planCmd('p', '-', a), planCmd('fpp', 'F9 AC-2 own', b), planCmd('fpp', '-', c), planCmd('fpp', 'other test', d),
  ] } });
  const ev = commandEvents(dir);
  assert.equal(ev.length, 4);
  assert.deepEqual(ev.map((e) => [e.data.index, e.data.attempts, e.data.retry_skipped ?? null]),
    [[0, 1, null], [1, 1, 'own_test'], [2, 1, 'no_test_names'], [3, 3, null]]);
  for (const i of [0, 3]) assert.equal('retry_skipped' in ev[i].data, false, JSON.stringify(ev[i].data));
});

// ---------- AC-6 ----------
test("F89 AC-6: a skipped command's output is the end of the first run's output", async () => {
  const dir = fixture();
  const state = stateFile();
  const r = await run(dir, { verify: { commands: [planCmd('ff', 'F9 AC-1 own test', state)] } });
  const c = r.commands[0];
  assert.equal(c.retry_skipped, 'own_test');
  assert.match(c.output, /attempt-0/);
  assert.doesNotMatch(c.output, /attempt-1/);
  assert.match(c.output, /F9 AC-1 own test/);
  assert.equal(c.message, 'exit 1');
});

test('F89 AC-6: the next build attempt gets the first run’s output as its verifyFailure', async () => {
  const state = stateFile();
  const dir = fixture('F1', { forRun: true });
  const builds = [];
  await runFeatures({
    root: dir,
    config: resolveConfig({ base_branch: 'main', run: { max_parallel: 1 }, verify: { commands: [planCmd('ffffff', 'F1 AC-1 own test', state)] }, budget: { step_timeout_sec: 60 } }),
    deps: {
      build: async (a) => {
        builds.push(a);
        fs.writeFileSync(path.join(a.cwd, `F1-${builds.length}.txt`), 'x\n');
        return { ok: true, costUsd: 0 };
      },
      evaluate: async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null }),
      log: () => {},
    },
  });
  assert.ok(builds.length >= 2, `builds: ${builds.length}`);
  const failure = builds[1].verifyFailure;
  assert.ok(failure, 'the second attempt gets the verify failure');
  const cmd = failure.commands[0];
  assert.match(cmd.output, /attempt-0/, JSON.stringify(failure));
  assert.doesNotMatch(cmd.output, /attempt-1/);
  assert.equal(runsOf(state), builds.length, 'one run of the command per verify');
});

// ---------- AC-7 ----------
test('F89 AC-7: SPEC §6.1 describes skipping the re-run under retry, why, and retry_skipped', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs/SPEC.md'), 'utf8');
  const start = spec.indexOf('### 6.1');
  assert.ok(start !== -1);
  const next = spec.indexOf('\n### ', start + 1);
  const s61 = spec.slice(start, next === -1 ? undefined : next);
  for (const re of [/재실행 건너뛰기/, /2차도 실행하지 않는다/, /기능 자신의 테스트/, /이름을 하나도 뽑지 못하면/, /판정이 fail 로 같/, /retry_skipped/, /own_test/, /no_test_names/, /`attempts` 1/, /`timed_out`/]) {
    assert.match(s61, re, `SPEC §6.1 lacks ${re}`);
  }
});

// ---------- ES-1 ----------
test('F89 ES-1: a first run whose program is missing is an environment failure and stops the run', async () => {
  const dir = fixture('F1', { forRun: true });
  const missing = 'harness-f89-no-such-tool';
  const builds = [];
  const logs = [];
  const r = await runFeatures({
    root: dir,
    config: resolveConfig({ base_branch: 'main', run: { max_parallel: 1 }, verify: { commands: [`${missing} --check`] }, budget: { step_timeout_sec: 60 } }),
    deps: {
      build: async (a) => { builds.push(a); fs.writeFileSync(path.join(a.cwd, 'F1.txt'), 'x\n'); return { ok: true, costUsd: 0 }; },
      evaluate: async () => { throw new Error('not reached'); },
      log: (m) => logs.push(m),
    },
  });
  assert.equal(r.interrupted, true, logs.join('\n'));
  assert.equal(r.environment?.program, missing, JSON.stringify(r.environment));
  assert.equal(r.environment?.stage, 'verify');
  assert.equal(builds.length, 1, 'no build retry for a missing program');
  assert.deepEqual(r.results, []);
});
