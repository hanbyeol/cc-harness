import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, harness, writeJson } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { runFeatures } from '../lib/run.mjs';
import { verify as realVerify } from '../lib/verify.mjs';
import { METRIC_FIELDS } from '../lib/metrics.mjs';
import evalCommand from '../lib/commands/eval.mjs';

// ------------------------------------------------------------------ fixtures

const SCRIPTS = {
  'scripts/has.mjs': "import fs from 'node:fs';\nprocess.exit(process.argv.slice(2).every((f) => fs.existsSync(f)) ? 0 : 1);\n",
};

function contract(id, { tier = 'standard', text = `${id}.txt exists` } = {}) {
  const c = {
    id, title: `feature ${id}`, security_tier: tier, version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: text, check: `node scripts/has.mjs ${id}.txt`, new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-26T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture(ids, { files = {}, config = {}, text, status = 'approved' } = {}) {
  const state = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...config },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': {
      features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: 'standard', depends_on: [], status })),
    },
  };
  for (const id of ids) state[`.harness/contracts/${id}.json`] = contract(id, { text });
  return gitRepo({ ...state, ...SCRIPTS, ...files }, { branch: null });
}

const ROLES = {
  builder: { adapter: 'claude', model: 'builder-model' },
  evaluator: { adapter: 'gemini', model: 'eval-model' },
  'security-reviewer': { adapter: 'codex', model: 'sr-model' },
};
const cfg = (extra = {}) => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, roles: ROLES, run: { max_parallel: 1 }, ...extra });

// Fake builder: writes <id>.txt unless `skip(a)`; records calls.
function fakeBuild({ skip = () => false, files, cost = 0.5 } = {}) {
  const fn = async (a) => {
    fn.calls.push({ featureId: a.featureId, conflicts: a.conflicts });
    if (!skip(a)) writeFiles(a.cwd, files ? files(a) : { [`${a.featureId}.txt`]: 'x\n' });
    return { ok: true, costUsd: cost };
  };
  fn.calls = [];
  return fn;
}

function fakeEvaluate(cost = 0.25) {
  const fn = async (a) => {
    fn.calls.push(a.featureId);
    return { feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: cost, file: null };
  };
  fn.calls = [];
  return fn;
}

function countingVerify() {
  const fn = async (a) => { fn.calls += 1; return realVerify(a); };
  fn.calls = 0;
  return fn;
}

const runsDir = (dir) => path.join(dir, '.harness', 'runs');
const metricFiles = (dir) => (fs.existsSync(runsDir(dir)) ? fs.readdirSync(runsDir(dir)).filter((n) => n.endsWith('.metrics.jsonl')) : []);
const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const runMetrics = (dir, r) => readLines(r.report.replace(/\.md$/, '.metrics.jsonl'));

function assertShape(line) {
  assert.deepEqual(Object.keys(line), [...METRIC_FIELDS]);
  assert.equal(typeof line.feature, 'string');
  assert.ok(Number.isInteger(line.round));
  assert.ok(!Number.isNaN(Date.parse(line.started_at)) && !Number.isNaN(Date.parse(line.ended_at)));
  assert.equal(line.duration_ms, Date.parse(line.ended_at) - Date.parse(line.started_at));
  assert.equal(typeof line.outcome, 'string');
}

// ------------------------------------------------------------------ AC-1
test('F27 AC-1: a passing run writes one metrics line per step with the listed fields', async () => {
  const dir = fixture(['F1']);
  const build = fakeBuild();
  const evaluate = fakeEvaluate();
  const verify = countingVerify();
  const r = await runFeatures({ root: dir, config: cfg(), deps: { build, evaluate, verify } });
  assert.equal(r.results[0].status, 'passed');
  const lines = runMetrics(dir, r);
  assert.deepEqual(lines.map((l) => l.step), ['build', 'verify', 'eval', 'merge', 'post_merge_verify']);
  assert.equal(lines.length, build.calls.length + verify.calls + evaluate.calls.length + 1);
  for (const l of lines) assertShape(l);
  const by = Object.fromEntries(lines.map((l) => [l.step, l]));
  assert.deepEqual([by.build.role, by.build.adapter, by.build.model, by.build.cost_usd, by.build.outcome], ['builder', 'claude', 'builder-model', 0.5, 'ok']);
  assert.deepEqual([by.eval.role, by.eval.adapter, by.eval.model, by.eval.cost_usd, by.eval.outcome], ['evaluator', 'gemini', 'eval-model', 0.25, 'pass']);
  assert.deepEqual([by.verify.role, by.verify.outcome, by.merge.outcome, by.post_merge_verify.outcome], ['core', 'pass', 'merged', 'pass']);
  assert.ok(lines.every((l) => l.feature === 'F1' && l.round === 1));
});

test('F27 AC-1: a failed verify and a rebuild add their own lines', async () => {
  const dir = fixture(['F1']);
  let n = 0;
  const build = fakeBuild({ skip: () => (n += 1) === 1 });
  const verify = countingVerify();
  const evaluate = fakeEvaluate();
  const r = await runFeatures({ root: dir, config: cfg(), deps: { build, evaluate, verify } });
  assert.equal(r.results[0].status, 'passed');
  const lines = runMetrics(dir, r);
  assert.deepEqual(lines.map((l) => `${l.step}:${l.outcome}`), ['build:ok', 'verify:fail', 'build:ok', 'verify:pass', 'eval:pass', 'merge:merged', 'post_merge_verify:pass']);
  assert.equal(lines.length, build.calls.length + verify.calls + evaluate.calls.length + 1);
});

test('F27 AC-1: a merge conflict adds merge:conflict and a conflict_resolve line', async () => {
  const dir = fixture(['F1', 'F2'], { files: { 'shared.txt': 'original\n' } });
  const build = fakeBuild({
    files: (a) => (a.conflicts ? { 'shared.txt': 'both\n' } : { [`${a.featureId}.txt`]: 'x\n', 'shared.txt': `by ${a.featureId}\n` }),
  });
  // F2 is built before F1 merges (both start on the same integration commit), so its merge conflicts.
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = async (a) => {
    if (a.featureId === 'F1' && !a.conflicts) await gate;
    const out = await build(a);
    if (a.featureId === 'F2' && !a.conflicts) release();
    return out;
  };
  const r = await runFeatures({ root: dir, config: cfg({ run: { max_parallel: 2 } }), deps: { build: slow, evaluate: fakeEvaluate() } });
  const lines = runMetrics(dir, r);
  const conflicted = r.results.find((x) => x.conflictResolution === 'resolved');
  assert.ok(conflicted, JSON.stringify(r.results));
  const steps = lines.filter((l) => l.feature === conflicted.feature).map((l) => `${l.step}:${l.outcome}`);
  assert.deepEqual(steps, ['build:ok', 'verify:pass', 'eval:pass', 'merge:conflict', 'conflict_resolve:ok', 'verify:pass', 'eval:pass', 'merge:merged', 'post_merge_verify:pass']);
  const cr = lines.find((l) => l.step === 'conflict_resolve');
  assert.deepEqual([cr.role, cr.model], ['builder', 'builder-model']);
});

// ------------------------------------------------------------------ AC-2
const scores = { functionality: 9, quality: 9, security: 9, errors: 9, tests: 9 };
const passReply = (cost) => ({ ok: true, error: null, text: '{}', json: { scores, findings: [], out_of_scope: [] }, costUsd: cost, exitCode: 0 });
const PASS_VERIFY = { pass: true, commands: [], warnings: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, criteria: [{ id: 'AC-1', pass: true }] };

async function evalCmd(dir, runAdapter) {
  const out = [];
  const code = await evalCommand({ root: dir, args: ['F1'], out: (s) => out.push(s), err: () => {}, deps: { runAdapter, verifyResult: PASS_VERIFY } });
  return { code, out: out.join('\n') };
}

test('F27 AC-2: interactive eval appends one line per evaluator and security-reviewer call to eval.metrics.jsonl', async () => {
  const dir = fixture(['F1'], { config: { roles: ROLES } });
  // critical: the evaluator and the security-reviewer are both called
  writeJson(path.join(dir, '.harness/contracts/F1.json'), contract('F1', { tier: 'critical' }));
  const calls = [];
  const r = await evalCmd(dir, async (role) => { calls.push(role); return passReply(role === 'evaluator' ? 0.1 : 0.2); });
  assert.equal(r.code, 0, r.out);
  const lines = readLines(path.join(runsDir(dir), 'eval.metrics.jsonl'));
  assert.equal(lines.length, calls.length);
  assert.deepEqual(lines.map((l) => l.role).sort(), ['evaluator', 'security-reviewer']);
  for (const l of lines) assertShape(l);
  const ev = lines.find((l) => l.role === 'evaluator');
  const sr = lines.find((l) => l.role === 'security-reviewer');
  assert.deepEqual([ev.step, ev.feature, ev.round, ev.adapter, ev.model, ev.cost_usd, ev.outcome], ['eval', 'F1', 1, 'gemini', 'eval-model', 0.1, 'ok']);
  assert.deepEqual([sr.adapter, sr.model, sr.cost_usd], ['codex', 'sr-model', 0.2]);
  // A second evaluation appends to the same file.
  fs.writeFileSync(path.join(dir, '.harness/features.json'), JSON.stringify({ features: [{ id: 'F1', title: 'x', security_tier: 'critical', depends_on: [], status: 'in_progress', eval_round: 1 }] }));
  await evalCmd(dir, async () => ({ ok: false, error: 'exit_nonzero', detail: 'boom', text: '', json: null, costUsd: null, exitCode: 1 }));
  const after = readLines(path.join(runsDir(dir), 'eval.metrics.jsonl'));
  assert.equal(after.length, lines.length + 2);
  assert.ok(after.slice(lines.length).every((l) => l.outcome === 'exit_nonzero' && l.cost_usd === null));
});

// ------------------------------------------------------------------ AC-3
test('F27 AC-3: the run report has a per-feature step table with time, cost and model', async () => {
  const dir = fixture(['F1', 'F2']);
  const r = await runFeatures({ root: dir, config: cfg(), deps: { build: fakeBuild(), evaluate: fakeEvaluate() } });
  const md = fs.readFileSync(r.report, 'utf8');
  assert.match(md, /## Steps/);
  for (const id of ['F1', 'F2']) {
    const sec = md.slice(md.indexOf(`### ${id}\n`));
    assert.match(sec, /\| Round \| Step \| Time \| Cost \(USD\) \| Model \| Outcome \|/);
    assert.match(sec, /\| 1 \| build \| \d+\.\ds \| 0\.50 \| builder-model \| ok \|/);
    assert.match(sec, /\| 1 \| verify \| \d+\.\ds \| - \| - \| pass \|/);
    assert.match(sec, /\| 1 \| eval \| \d+\.\ds \| 0\.25 \| eval-model \| pass \|/);
    assert.match(sec, /\| 1 \| merge \| /);
    assert.match(sec, /\| 1 \| post_merge_verify \| /);
  }
});

// ------------------------------------------------------------------ stats fixtures

const line = (o) => ({
  feature: 'F1', round: 1, step: 'build', started_at: '2026-09-20T00:00:00.000Z', ended_at: '2026-09-20T00:00:10.000Z',
  duration_ms: 10_000, cost_usd: null, role: 'core', adapter: null, model: null, outcome: 'ok', ...o,
});
const at = (day, sec = 0) => new Date(Date.UTC(2026, 8, day, 0, 0, sec)).toISOString();

function statsProject(files, { features = [{ id: 'F1', security_tier: 'critical' }], stepTimeout = 100 } = {}) {
  const dir = fixture([], {});
  writeJson(path.join(dir, '.harness/config.json'), { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: stepTimeout } });
  writeJson(path.join(dir, '.harness/features.json'), { features: features.map((f) => ({ title: f.id, depends_on: [], status: 'passed', ...f })) });
  fs.mkdirSync(runsDir(dir), { recursive: true });
  for (const [name, rows] of Object.entries(files)) {
    fs.writeFileSync(path.join(runsDir(dir), name), rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  }
  return dir;
}

// Two features: F1 passes in round 1, F2 in round 2 (one run file + interactive eval lines).
const FIXTURE = {
  'r1.metrics.jsonl': [
    line({ feature: 'F1', step: 'build', duration_ms: 10_000, cost_usd: 1, role: 'builder', adapter: 'claude', model: 'opus', ended_at: at(20, 10) }),
    line({ feature: 'F1', step: 'verify', duration_ms: 2_000, ended_at: at(20, 12) }),
    line({ feature: 'F1', step: 'eval', duration_ms: 4_000, cost_usd: 0.5, role: 'evaluator', adapter: 'gemini', model: 'pro', outcome: 'pass', ended_at: at(20, 16) }),
    line({ feature: 'F1', step: 'merge', duration_ms: 100, outcome: 'merged', ended_at: at(20, 17) }),
    line({ feature: 'F1', step: 'post_merge_verify', duration_ms: 3_000, outcome: 'pass', ended_at: at(20, 20) }),
    line({ feature: 'F2', step: 'build', duration_ms: 20_000, cost_usd: 2, role: 'builder', adapter: 'claude', model: 'opus', ended_at: at(21, 20) }),
    line({ feature: 'F2', step: 'verify', duration_ms: 1_000, ended_at: at(21, 21) }),
    line({ feature: 'F2', step: 'eval', duration_ms: 6_000, cost_usd: 0.5, role: 'evaluator', adapter: 'gemini', model: 'pro', outcome: 'fail', ended_at: at(21, 27) }),
    line({ feature: 'F2', round: 2, step: 'build', duration_ms: 30_000, cost_usd: 3, role: 'builder', adapter: 'claude', model: 'opus', ended_at: at(22, 30) }),
    line({ feature: 'F2', round: 2, step: 'verify', duration_ms: 3_000, ended_at: at(22, 33) }),
    line({ feature: 'F2', round: 2, step: 'eval', duration_ms: 8_000, cost_usd: 1, role: 'evaluator', adapter: 'gemini', model: 'pro', outcome: 'pass', ended_at: at(22, 41) }),
  ],
  'eval.metrics.jsonl': [
    line({ feature: 'F3', step: 'eval', duration_ms: 5_000, cost_usd: 1, role: 'security-reviewer', adapter: 'codex', model: 'o', outcome: 'ok', ended_at: at(23, 5) }),
  ],
};

const EXPECTED = {
  lines: 12,
  total_cost_usd: 9,
  total_duration_ms: 92_100,
  steps: [
    { step: 'build', count: 3, median_ms: 20_000, p90_ms: 30_000, cost_total_usd: 6, cost_avg_usd: 2 },
    { step: 'verify', count: 3, median_ms: 2_000, p90_ms: 3_000, cost_total_usd: 0, cost_avg_usd: 0 },
    { step: 'eval', count: 4, median_ms: 5_500, p90_ms: 8_000, cost_total_usd: 3, cost_avg_usd: 0.75 },
    { step: 'merge', count: 1, median_ms: 100, p90_ms: 100, cost_total_usd: 0, cost_avg_usd: 0 },
    { step: 'post_merge_verify', count: 1, median_ms: 3_000, p90_ms: 3_000, cost_total_usd: 0, cost_avg_usd: 0 },
  ],
  cost_by_role_model: [
    { role: 'builder', model: 'opus', count: 3, cost_usd: 6 },
    { role: 'evaluator', model: 'pro', count: 3, cost_usd: 2 },
    { role: 'security-reviewer', model: 'o', count: 1, cost_usd: 1 },
    { role: 'core', model: null, count: 5, cost_usd: 0 },
  ],
  features: {
    count: 2, first_round_pass_rate: 0.5, avg_rounds: 1.5,
    list: [{ feature: 'F1', rounds: 1, first_round_pass: true }, { feature: 'F2', rounds: 2, first_round_pass: false }],
  },
};

const statsJson = (dir, args = []) => {
  const r = harness(['stats', '--json', ...args], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
};

// ------------------------------------------------------------------ AC-4
test('F27 AC-4: harness stats --json aggregates every metrics file to the fixture\'s expected values', () => {
  const dir = statsProject(FIXTURE);
  const s = statsJson(dir);
  assert.deepEqual(s.files, ['eval.metrics.jsonl', 'r1.metrics.jsonl']);
  for (const k of Object.keys(EXPECTED)) assert.deepEqual(s[k], EXPECTED[k], k);
});

test('F27 AC-4: harness stats text output shows the same numbers', () => {
  const dir = statsProject(FIXTURE);
  const r = harness(['stats'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /metrics: 12 steps, total cost \$9\.00, total time 92\.1s/);
  assert.match(r.stdout, /build\s+3\s+20\.0s\s+30\.0s\s+\$6\.00\s+\$2\.00/);
  assert.match(r.stdout, /eval\s+4\s+5\.5s\s+8\.0s\s+\$3\.00\s+\$0\.75/);
  assert.match(r.stdout, /post_merge_verify\s+1\s+3\.0s\s+3\.0s/);
  assert.match(r.stdout, /builder\s+opus\s+\$6\.00 \(3 steps\)/);
  assert.match(r.stdout, /security-reviewer\s+o\s+\$1\.00 \(1 steps\)/);
  assert.match(r.stdout, /features: 2 evaluated, first-round pass rate 50%, average rounds 1\.5/);
});

// ------------------------------------------------------------------ AC-5
test('F27 AC-5: --since counts only lines whose ended_at is on or after the date', () => {
  const dir = statsProject(FIXTURE);
  const s = statsJson(dir, ['--since', '2026-09-22']);
  assert.equal(s.since, '2026-09-22');
  assert.equal(s.lines, 4);
  assert.deepEqual(s.steps.map((x) => [x.step, x.count]), [['build', 1], ['verify', 1], ['eval', 2]]);
  assert.equal(s.total_cost_usd, 5);
  assert.deepEqual(s.features.list, [{ feature: 'F2', rounds: 2, first_round_pass: false }]);
  assert.equal(statsJson(dir, ['--since', '2026-09-24']).lines, 0);
  const text = harness(['stats', '--since', '2026-09-24'], { cwd: dir });
  assert.equal(text.code, 0);
  assert.match(text.stdout, /no metrics since 2026-09-24/);
  const bad = harness(['stats', '--since', '26-9-1'], { cwd: dir });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--since/);
});

// ------------------------------------------------------------------ AC-6
const rules = (dir) => statsJson(dir).suggestions.map((x) => x.rule);
const t = (i) => at(20, i);

test('F27 AC-6: (a) two of the latest ten steps at ≥90% of step_timeout_sec → only step_timeout', () => {
  // step_timeout 100s: 90s and 95s among the latest ten; builds and evals only (no verify share),
  // costs split so the builder is not over 70%.
  const rows = [];
  for (let i = 0; i < 10; i += 1) {
    const d = i === 3 ? 90_000 : i === 7 ? 95_000 : 10_000;
    rows.push(line({ step: i % 2 ? 'eval' : 'build', role: i % 2 ? 'evaluator' : 'builder', duration_ms: d, cost_usd: 1, ended_at: t(i + 10) }));
  }
  // An older near-timeout step outside the latest ten does not count by itself.
  rows.unshift(line({ step: 'build', role: 'builder', duration_ms: 99_000, cost_usd: 0, ended_at: t(1) }));
  const dir = statsProject({ 'a.metrics.jsonl': rows }, { features: [{ id: 'F1', security_tier: 'standard' }] });
  const s = statsJson(dir);
  assert.deepEqual(s.suggestions.map((x) => x.rule), ['step_timeout']);
  assert.match(s.suggestions[0].message, /budget\.step_timeout_sec/);

  const one = [...rows.slice(1, 5).map((r) => ({ ...r, duration_ms: 10_000 })), ...rows.slice(5)];
  const dir2 = statsProject({ 'a.metrics.jsonl': one }, { features: [{ id: 'F1', security_tier: 'standard' }] });
  assert.deepEqual(rules(dir2), [], 'one near-timeout step among the latest ten is not enough');
});

test('F27 AC-6: (b) verify and post_merge_verify over 30% of the time → only verify.check_parallel', () => {
  const rows = [
    line({ step: 'build', role: 'builder', duration_ms: 60_000, cost_usd: 1, ended_at: t(1) }),
    line({ step: 'eval', role: 'evaluator', duration_ms: 5_000, cost_usd: 1, ended_at: t(2) }),
    line({ step: 'verify', duration_ms: 20_000, ended_at: t(3) }),
    line({ step: 'post_merge_verify', duration_ms: 15_000, ended_at: t(4) }),
  ];
  const dir = statsProject({ 'b.metrics.jsonl': rows }, { features: [{ id: 'F1', security_tier: 'standard' }] });
  const s = statsJson(dir);
  assert.deepEqual(s.suggestions.map((x) => x.rule), ['verify.check_parallel']);
  assert.match(s.suggestions[0].message, /verify\.check_parallel/);
  // exactly 30% is not over 30%
  const dir2 = statsProject({ 'b.metrics.jsonl': [{ ...rows[0], duration_ms: 60_000 }, { ...rows[1], duration_ms: 10_000 }, line({ step: 'verify', duration_ms: 18_000, ended_at: t(3) }), line({ step: 'post_merge_verify', duration_ms: 12_000, ended_at: t(4) })] });
  assert.deepEqual(rules(dir2), []);
});

test('F27 AC-6: (c) builder over 70% of the cost with a standard feature → only builder_model', () => {
  const rows = [
    line({ step: 'build', role: 'builder', duration_ms: 10_000, cost_usd: 8, ended_at: t(1) }),
    line({ step: 'eval', role: 'evaluator', duration_ms: 10_000, cost_usd: 2, ended_at: t(2) }),
    line({ step: 'verify', duration_ms: 1_000, ended_at: t(3) }),
  ];
  const std = statsProject({ 'c.metrics.jsonl': rows }, { features: [{ id: 'F1', security_tier: 'standard' }, { id: 'F2', security_tier: 'critical' }] });
  const s = statsJson(std);
  assert.deepEqual(s.suggestions.map((x) => x.rule), ['builder_model']);
  assert.match(s.suggestions[0].message, /standard/);
  const critOnly = statsProject({ 'c.metrics.jsonl': rows }, { features: [{ id: 'F2', security_tier: 'critical' }] });
  assert.deepEqual(rules(critOnly), [], 'no standard feature → no builder model suggestion');
  const even = statsProject({ 'c.metrics.jsonl': [rows[0], { ...rows[1], cost_usd: 8 }, rows[2]] }, { features: [{ id: 'F1', security_tier: 'standard' }] });
  assert.deepEqual(rules(even), [], 'builder at 50% → none');
});

test('F27 AC-6: suggestions appear in the text output', () => {
  const rows = [line({ step: 'verify', duration_ms: 20_000, ended_at: t(1) }), line({ step: 'build', role: 'builder', duration_ms: 20_000, ended_at: t(2) })];
  const dir = statsProject({ 'x.metrics.jsonl': rows });
  const r = harness(['stats'], { cwd: dir });
  assert.match(r.stdout, /suggestions:\n {2}- \[verify\.check_parallel\]/);
});

// ------------------------------------------------------------------ AC-7
test('F27 AC-7: SPEC and README describe the metrics file, harness stats and the suggestion rules', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  for (const re of [/\.metrics\.jsonl/, /eval\.metrics\.jsonl/, /harness stats/, /--since/, /--json/, /중앙값/, /p90/,
    /step_timeout_sec 의 90%/, /verify\.check_parallel/, /70%/, /no metrics yet/,
    ...METRIC_FIELDS.map((f) => new RegExp(`\`${f}\``))]) {
    assert.match(spec, re);
  }
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  for (const re of [/harness stats/, /\.metrics\.jsonl/, /--since/, /step_timeout/, /verify\.check_parallel/, /builder/]) assert.match(readme, re);
});

// ------------------------------------------------------------------ SC-1
test('F27 SC-1: metrics lines carry only the listed fields — no prompt, output or environment value', async () => {
  const MARK = 'MARKER-7f3a9c';
  const SECRET = 'sk-test-secret';
  const builder = `import fs from 'node:fs';\nlet s = '';\nfor await (const c of process.stdin) s += c;\nfs.writeFileSync('F1.txt', 'x');\nprocess.stdout.write('${MARK} ' + (process.env.GEMINI_API_KEY || '') + ' ' + s);\n`;
  const reply = JSON.stringify({ scores, findings: [], out_of_scope: [{ summary: `${MARK} out of scope` }] });
  const evaluator = `let s = '';\nfor await (const c of process.stdin) s += c;\nprocess.stdout.write(${JSON.stringify(reply)} + ' ${MARK} ' + (process.env.GEMINI_API_KEY || ''));\n`;
  const dir = fixture(['F1'], {
    text: `F1.txt exists ${MARK}`,
    files: { 'scripts/builder.mjs': builder, 'scripts/evaluator.mjs': evaluator },
  });
  const adapters = { generic: { command: [process.execPath, path.join(dir, 'scripts/builder.mjs')], read_only_command: [process.execPath, path.join(dir, 'scripts/evaluator.mjs')] } };
  const config = cfg({ roles: { builder: 'generic', evaluator: 'generic', 'security-reviewer': 'generic' }, adapters, env_allowlist: ['GEMINI_API_KEY'] });
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = SECRET;
  try {
    const diagnose = async () => ({ roles: ['builder', 'evaluator'].map((role) => ({ role, adapter: 'generic', usable: true })) });
    const r = await runFeatures({ root: dir, config, deps: { diagnose } });
    assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results));
    // interactive eval of a second feature through the same adapters
    writeJson(path.join(dir, '.harness/contracts/F2.json'), contract('F2', { text: `F2 ${MARK}` }));
    const feats = JSON.parse(fs.readFileSync(path.join(dir, '.harness/features.json'), 'utf8'));
    feats.features.push({ id: 'F2', title: 'x', security_tier: 'standard', depends_on: [], status: 'approved' });
    writeJson(path.join(dir, '.harness/features.json'), feats);
    writeJson(path.join(dir, '.harness/config.json'), { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, roles: { builder: 'generic', evaluator: 'generic', 'security-reviewer': 'generic' }, adapters, env_allowlist: ['GEMINI_API_KEY'] });
    await evalCommand({ root: dir, args: ['F2'], out: () => {}, err: () => {}, deps: { verifyResult: PASS_VERIFY } });
  } finally {
    if (saved === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved;
  }
  const files = metricFiles(dir);
  assert.ok(files.includes('eval.metrics.jsonl') && files.length === 2, files.join(','));
  let n = 0;
  for (const f of files) {
    const text = fs.readFileSync(path.join(runsDir(dir), f), 'utf8');
    assert.ok(!text.includes(MARK), `${f} contains the marker`);
    assert.ok(!text.includes(SECRET), `${f} contains the secret`);
    for (const l of readLines(path.join(runsDir(dir), f))) { assert.deepEqual(Object.keys(l), [...METRIC_FIELDS]); n += 1; }
  }
  assert.ok(n >= 6, `metrics lines written (${n})`);
  // the marker did reach the adapters: the test is not vacuous
  const backlog = fs.readFileSync(path.join(dir, '.harness/backlog.json'), 'utf8');
  assert.ok(backlog.includes(MARK), 'the evaluator output with the marker reached the core');
});

// ------------------------------------------------------------------ ES-1 / ES-2
test('F27 ES-1: a non-JSON line is skipped with a warning naming the file and line; exit 0', () => {
  const dir = statsProject({ 'bad.metrics.jsonl': [line({ cost_usd: 1, role: 'builder', ended_at: at(20) }), '{not json', '[1,2]', line({ cost_usd: 2, role: 'builder', ended_at: at(21) })] });
  const r = harness(['stats', '--json'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /bad\.metrics\.jsonl:2\b/);
  assert.match(r.stderr, /bad\.metrics\.jsonl:3\b/);
  const s = JSON.parse(r.stdout);
  assert.equal(s.lines, 2);
  assert.equal(s.total_cost_usd, 3);
  const text = harness(['stats'], { cwd: dir });
  assert.equal(text.code, 0);
  assert.match(text.stderr, /warning: bad\.metrics\.jsonl:2/);
});

test('F27 ES-2: no metrics file → "no metrics yet", exit 0', () => {
  const dir = statsProject({});
  for (const args of [['stats'], ['stats', '--json']]) {
    const r = harness(args, { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /no metrics yet/);
  }
  fs.rmSync(runsDir(dir), { recursive: true });
  const r = harness(['stats'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /no metrics yet/);
});
