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
  // Writes its marker (argv[2], a path relative to the worktree), then sleeps `argv[3]` ms.
  'scripts/hang.mjs': "import fs from 'node:fs';\nfs.writeFileSync(process.argv[2], String(process.pid));\nsetTimeout(() => process.exit(0), Number(process.argv[3]));\n",
};

const HEADER = '# Criterion status in this working tree';

// AC → SC → ES with cases: AC-1 passes once F1.txt exists, AC-2#a passes, AC-2#b fails,
// SC-1 passes, ES-1 runs a missing program.
function richContract(id, extra = {}) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [
      { id: 'AC-1', criterion: 'done file', check: `node scripts/has.mjs ${id}.txt`, new: true },
      {
        id: 'AC-2', criterion: 'cases', check: 'node scripts/has.mjs scripts/has.mjs', new: true,
        cases: [
          { id: 'a', check: 'node scripts/has.mjs scripts/has.mjs' },
          { id: 'b', check: 'node scripts/has.mjs no-such-file.txt' },
        ],
      },
    ],
    security_criteria: [{ id: 'SC-1', criterion: 'sc', check: 'node scripts/has.mjs scripts/has.mjs', new: true }],
    error_scenarios: [{ id: 'ES-1', criterion: 'es', check: 'f74-no-such-program-zz --version', new: true }],
    out_of_scope: [],
    ...extra,
  };
  c.approval = { by: 'test', at: '2026-10-05T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture(c = richContract('F1')) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': c,
    'shared.txt': 'original\n',
    ...SCRIPTS,
  }, { branch: null });
}

const cfg = (budget = {}) => resolveConfig({
  base_branch: 'main', run: { max_parallel: 1 }, verify: { commands: [] }, budget: { step_timeout_sec: 60, ...budget },
});

const PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const FAILING = { ...PASSING, pass: false, criteria: [{ id: 'AC-1', check: 'x', pass: false, message: 'exit 1' }] };
const verifySeq = (seq = []) => {
  let i = 0;
  return async () => seq[i++] ?? PASSING;
};
const verdict = (v, blocking = []) => async (a) => ({ feature: a.featureId, round: a.round, verdict: v, score: v === 'pass' ? 8 : 5, scores: {}, blocking, backlogged: [], independence: 'cross-model', costUsd: 0, file: null });

// Fake builder: script[i] runs on call i (default: writes F1.txt, ok); every call records the
// prompt the real builderPrompt renders from the arguments the run passed.
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
const partial = (files = { 'F1.txt': 'half\n' }) => (a) => { writeFiles(a.cwd, files); return TIMEOUT; };

const runF = (dir, deps, opts = {}) => run.runFeatures({
  root: dir, config: opts.config ?? cfg(), ...opts,
  deps: { evaluate: verdict('pass'), verify: verifySeq(), cpus: 8, ...deps },
});
const readLines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const metricsOf = (dir) => {
  const runs = path.join(dir, '.harness', 'runs');
  return fs.readdirSync(runs).filter((n) => n.endsWith('.metrics.jsonl')).flatMap((n) => readLines(path.join(runs, n)));
};
const wt = (dir) => path.join(dir, '.harness', 'wt', 'F1');

// The section's lines: the header up to the next blank line or heading.
function section(prompt) {
  const at = prompt.indexOf(HEADER);
  if (at === -1) return null;
  const rest = prompt.slice(at + HEADER.length).split('\n').slice(1);
  const end = rest.findIndex((l) => l === '' || l.startsWith('#'));
  return (end === -1 ? rest : rest.slice(0, end)).filter((l) => l.startsWith('- '));
}

async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

// ------------------------------------------------------------------ AC-1
test('F74 AC-1: the continuation of a timed-out build lists every criterion status in contract order', async () => {
  const dir = fixture();
  const build = fakeBuild([partial()]);
  const r = await runF(dir, { build });
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results[0]));
  assert.equal(build.calls.length, 2);
  assert.equal(section(build.calls[0].prompt), null, 'the first attempt has no section');
  assert.deepEqual(section(build.calls[1].prompt), [
    '- AC-1: pass', // F1.txt was written by the timed-out attempt
    '- AC-2: pass',
    '- AC-2#a: pass',
    '- AC-2#b: fail',
    '- SC-1: pass',
    '- ES-1: fail',
  ]);
});

test('F74 AC-1: the checks run in the feature worktree before the builder is called', async () => {
  const dir = fixture();
  // The first attempt leaves a change but no F1.txt; the second writes F1.txt only when called.
  const build = fakeBuild([partial({ 'src/part.txt': 'x\n' })]);
  await runF(dir, { build });
  assert.deepEqual(section(build.calls[1].prompt).slice(0, 1), ['- AC-1: fail'], 'judged before the builder wrote F1.txt');
});

test('F74 AC-1: builderPrompt renders the section from criteriaStatus', () => {
  const p = run.builderPrompt({
    rolePrompt: 'ROLE', featureId: 'F1', round: 1, attempt: 2, contract: {}, config: {},
    continuation: { files: ['a.txt'] },
    criteriaStatus: [{ id: 'AC-1', status: 'pass' }, { id: 'ES-1', status: 'fail' }, { id: 'AC-2', status: 'timeout' }],
  });
  assert.deepEqual(section(p), ['- AC-1: pass', '- ES-1: fail', '- AC-2: timeout']);
});

// ------------------------------------------------------------------ AC-2
test('F74 AC-2: a build that takes over carried work gets the criterion status section', async () => {
  const dir = fixture();
  // First run: F1 is blocked by the evaluator; its worktree (with committed work) stays.
  const first = await runF(dir, {
    build: fakeBuild([(a) => { writeFiles(a.cwd, { 'F1.txt': 'first\n' }); commitAll(a.cwd, 'wip'); return { ok: true, costUsd: 0 }; }]),
    evaluate: verdict('needs-human'),
  }, { ids: ['F1'] });
  assert.equal(first.results[0].status, 'blocked');
  const file = path.join(dir, '.harness/features.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.features[0].status = 'approved';
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

  const build = fakeBuild();
  const r = await runF(dir, { build });
  assert.equal(r.results[0].carried, true);
  assert.equal(build.calls.length, 1);
  assert.match(build.calls[0].prompt, /# Work carried from a previous attempt/);
  assert.deepEqual(section(build.calls[0].prompt), [
    '- AC-1: pass', '- AC-2: pass', '- AC-2#a: pass', '- AC-2#b: fail', '- SC-1: pass', '- ES-1: fail',
  ]);
});

// ------------------------------------------------------------------ AC-3
test('F74 AC-3: of a first attempt, a retry after a failed verify, a findings round and a continuation, only the continuation gets the section', async () => {
  const dir = fixture();
  // r1a1 ok → verify fails → r1a2 ok → eval fails → r2a1 times out with changes → r2a2 continues.
  const build = fakeBuild([undefined, undefined, partial({ 'src/r2.txt': 'x\n' })]);
  let evals = 0;
  const evaluate = async (a) => {
    evals += 1;
    return evals === 1
      ? verdict('fail', [{ criterion_id: 'AC-1', severity: 'high', title: 't', repro: 'node scripts/has.mjs nope' }])(a)
      : verdict('pass')(a);
  };
  const r = await runF(dir, { build, verify: verifySeq([FAILING]), evaluate });
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results[0]));
  assert.deepEqual(build.calls.map((c) => [c.round, c.attempt]), [[1, 1], [1, 2], [2, 1], [2, 2]]);
  assert.deepEqual(build.calls.map((c) => c.prompt.includes(HEADER)), [false, false, false, true],
    'first attempt, verify retry and findings round have no section; the continuation has it');
  assert.equal(metricsOf(dir).filter((m) => m.step === 'criteria_status').length, 1, 'checks ran before the continuation only');
});

test('F74 AC-3: a merge conflict resolution gets no section', () => {
  const p = run.builderPrompt({ rolePrompt: 'ROLE', featureId: 'F1', round: 1, attempt: 1, contract: {}, config: {}, conflicts: ['a.txt'] });
  assert.ok(!p.includes(HEADER));
  const q = run.builderPrompt({ rolePrompt: 'ROLE', featureId: 'F1', round: 1, attempt: 1, contract: {}, config: {}, postMergeFailures: [{ id: 'AC-1' }] });
  assert.ok(!q.includes(HEADER));
});

for (const kind of ['conflict', 'post-merge recovery']) {
  test(`F74 AC-3: a ${kind} build gets no section and runs no checks`, async () => {
    const dir = fixture();
    const intWt = path.join(dir, '.harness', 'wt', '_integration');
    const calls = [];
    const build = async (a) => {
      const which = a.conflicts ? 'conflict' : a.postMergeFailures ? 'post-merge recovery' : 'build';
      calls.push({ which, prompt: run.builderPrompt({ rolePrompt: 'ROLE', ...a }) });
      if (which === 'build') {
        writeFiles(a.cwd, { 'F1.txt': 'done\n', 'shared.txt': 'feature\n' });
        // Meanwhile a conflicting (or test-breaking) commit lands on integration.
        writeFiles(intWt, kind === 'conflict' ? { 'shared.txt': 'integration\n' } : { 'other.txt': 'x\n' });
        commitAll(intWt, 'meanwhile on integration');
      } else if (which === 'conflict') {
        writeFiles(a.cwd, { 'shared.txt': 'both\n' });
      } else {
        writeFiles(a.cwd, { 'fixed.txt': 'fixed\n' });
      }
      return { ok: true, costUsd: 0 };
    };
    // The integration worktree fails post-merge verify until fixed.txt is there.
    const verify = async (a) => (kind !== 'conflict' && fs.realpathSync.native(a.cwd) === fs.realpathSync.native(intWt)
      && !fs.existsSync(path.join(a.cwd, 'fixed.txt')) ? FAILING : PASSING);
    const r = await runF(dir, { build, verify });
    assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results[0]));
    const recovery = calls.filter((c) => c.which === kind);
    assert.equal(recovery.length, 1, `one ${kind} build`);
    for (const c of calls) assert.ok(!c.prompt.includes(HEADER), `${c.which} has no section`);
    assert.ok(!metricsOf(dir).some((m) => m.step === 'criteria_status'), 'no criteria_status step');
    // The same recovery prompt with a status list would show it: the absence above is the run's choice.
    const p = run.builderPrompt({ rolePrompt: 'ROLE', featureId: 'F1', round: 1, attempt: 1, contract: {}, config: {}, conflicts: ['shared.txt'], criteriaStatus: [{ id: 'AC-1', status: 'pass' }] });
    assert.ok(p.includes(HEADER));
  });
}

// ------------------------------------------------------------------ AC-4
test('F74 AC-4: a check past step_timeout_sec is a timeout line and the other checks still run', async () => {
  const c = richContract('F1');
  c.acceptance_criteria[1] = { id: 'AC-2', criterion: 'hangs', check: 'node scripts/hang.mjs hang-started.txt 25000', new: true };
  c.approval.hash = hashContract(c);
  const dir = fixture(c);
  const build = fakeBuild([partial()]);
  const r = await runF(dir, { build }, { config: cfg({ step_timeout_sec: 6 }) });
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results[0]));
  assert.deepEqual(section(build.calls[1].prompt), ['- AC-1: pass', '- AC-2: timeout', '- SC-1: pass', '- ES-1: fail']);
});

test('F74 AC-4: without budget.step_timeout_sec the limit is 1800 seconds', async () => {
  const { criteriaStatus } = await import('../lib/verify.mjs');
  const seen = [];
  const out = await criteriaStatus({
    cwd: REPO, contract: { acceptance_criteria: [{ id: 'AC-1', check: 'x' }] }, config: { budget: {} },
    runCheck: async (cmd, opts) => { seen.push(opts.timeoutSec); return { code: 0, timedOut: false, error: null }; },
  });
  assert.deepEqual(seen, [1800]);
  assert.deepEqual(out, [{ id: 'AC-1', status: 'pass' }]);
});

// ------------------------------------------------------------------ AC-5
test('F74 AC-5: the status run is a criteria_status metrics line (core, null cost) and does not count as an attempt or round', async () => {
  const dir = fixture();
  const build = fakeBuild([partial()]);
  const r = await runF(dir, { build });
  assert.equal(r.results[0].status, 'passed');
  const m = metricsOf(dir);
  const cs = m.filter((x) => x.step === 'criteria_status');
  assert.equal(cs.length, 1);
  assert.equal(cs[0].role, 'core');
  assert.equal(cs[0].cost_usd, null);
  assert.equal(cs[0].round, 1);
  assert.deepEqual(build.calls.map((c) => [c.round, c.attempt]), [[1, 1], [1, 2]]);
  assert.deepEqual(m.filter((x) => x.step === 'build').map((x) => x.outcome), ['timeout-continued', 'ok']);
  assert.equal(r.results[0].rounds ?? 1, 1);
  const order = m.map((x) => x.step);
  assert.ok(order.indexOf('criteria_status') > order.indexOf('build') && order.indexOf('criteria_status') < order.lastIndexOf('build'));
});

test('F74 AC-5: a third timed-out attempt is still blocked by the 3-attempt cap', async () => {
  const dir = fixture();
  const build = fakeBuild([partial({ 'a.txt': '1\n' }), partial({ 'b.txt': '2\n' }), partial({ 'c.txt': '3\n' })]);
  const r = await runF(dir, { build });
  assert.deepEqual([r.results[0].status, r.results[0].reason], ['blocked', 'budget']);
  assert.deepEqual(build.calls.map((c) => [c.round, c.attempt]), [[1, 1], [1, 2], [1, 3]]);
  assert.equal(metricsOf(dir).filter((x) => x.step === 'criteria_status').length, 2);
});

// ------------------------------------------------------------------ AC-6
test('F74 AC-6: SPEC §8 describes the criterion status section and §8.11 the criteria_status step', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs/SPEC.md'), 'utf8');
  const s8 = spec.slice(spec.indexOf('## 8.'), spec.indexOf('\n## ', spec.indexOf('## 8.') + 1));
  assert.ok(s8.includes(HEADER), 'names the section');
  for (const word of ['- <id>: pass', '- <id>: fail', '- <id>: timeout']) assert.ok(s8.includes(word), `line format ${word}`);
  assert.match(s8, /기준 상태/);
  assert.match(s8, /step_timeout_sec/);
  assert.match(s8, /1800/);
  assert.match(s8, /이어받/);
  const start = spec.indexOf('**실행 지표와 `harness stats`** (§8.11)');
  const s811 = spec.slice(start, spec.indexOf('\n## ', start));
  assert.ok(s811.includes('`criteria_status`'), '§8.11 names the step');
});

// ------------------------------------------------------------------ ES-1
test('F74 ES-1: a check whose program is missing or that exits non-zero is a fail line and the builder is still called', async () => {
  const c = richContract('F1');
  c.acceptance_criteria = [{ id: 'AC-1', criterion: 'done file', check: 'node scripts/has.mjs F1.txt', new: true }];
  c.security_criteria = [];
  c.error_scenarios = [
    { id: 'ES-1', criterion: 'missing', check: 'f74-no-such-program-zz --version', new: true },
    { id: 'ES-2', criterion: 'exit 3', check: 'node -e "process.exit(3)"', new: true },
  ];
  c.approval.hash = hashContract(c);
  const dir = fixture(c);
  const build = fakeBuild([partial({ 'src/x.txt': 'x\n' })]);
  const r = await runF(dir, { build });
  assert.equal(r.results[0].status, 'passed');
  assert.equal(build.calls.length, 2, 'the builder is called after the status run');
  assert.deepEqual(section(build.calls[1].prompt), ['- AC-1: fail', '- ES-1: fail', '- ES-2: fail']);
});

test('F74 ES-1: a check that cannot be spawned is a fail', async () => {
  const { criteriaStatus } = await import('../lib/verify.mjs');
  const out = await criteriaStatus({
    cwd: REPO, contract: { acceptance_criteria: [{ id: 'AC-1', check: 'x' }, { id: 'AC-2', check: 'y' }] }, config: {},
    runCheck: async (cmd) => (cmd === 'x'
      ? { code: null, signal: null, timedOut: false, error: 'ENOENT' }
      : { code: 0, signal: null, timedOut: false, error: null }),
  });
  assert.deepEqual(out, [{ id: 'AC-1', status: 'fail' }, { id: 'AC-2', status: 'pass' }]);
});

// ------------------------------------------------------------------ ES-2
test('F74 ES-2: an abort during the status run stops the running check, calls no builder and saves the run', async () => {
  const c = richContract('F1');
  c.acceptance_criteria = [
    { id: 'AC-1', criterion: 'hangs', check: 'node scripts/hang.mjs hang-started.txt 30000', new: true },
    { id: 'AC-2', criterion: 'after', check: 'node scripts/hang.mjs second-started.txt 0', new: true },
  ];
  c.security_criteria = [];
  c.error_scenarios = [];
  c.approval.hash = hashContract(c);
  const dir = fixture(c);
  const build = fakeBuild([partial()]);
  const ac = new AbortController();
  const marker = path.join(wt(dir), 'hang-started.txt');
  const pr = runF(dir, { build }, { signal: ac.signal });
  await until(() => fs.existsSync(marker), 'the hanging check to start');
  ac.abort();
  const r = await pr;
  assert.equal(r.interrupted, true);
  assert.equal(build.calls.length, 1, 'no builder after the abort');
  assert.ok(!fs.existsSync(path.join(wt(dir), 'second-started.txt')), 'the next check did not start');
  const state = JSON.parse(fs.readFileSync(r.statePath, 'utf8'));
  const e = state.active.find((x) => x.feature === 'F1');
  assert.ok(e, 'the feature is saved as in flight');
  assert.equal(e.round, 1);
  assert.equal(e.attemptsDone, 1, 'the timed-out attempt stays consumed');
  assert.ok(e.continuation?.files?.length, 'resume starts the continuation again');
  if (process.platform !== 'win32') {
    const pid = Number(fs.readFileSync(marker, 'utf8'));
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await until(() => !alive(), 'the hanging check to be killed', 15000);
  }
});
