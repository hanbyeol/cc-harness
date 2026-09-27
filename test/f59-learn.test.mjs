import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, REPO, tmpdir, readJson } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { runFeatures } from '../lib/run.mjs';
import { exportLine } from '../lib/telemetry.mjs';
import { THRESHOLDS } from '../lib/learn.mjs';

// F59: `harness learn` — reads the field data hub, aggregates metrics per harness version,
// derives evidenced improvement candidates, proposes them to the backlog and compares versions.

const P1 = 'aaaaaaaaaaaaaaaa';
const P2 = 'bbbbbbbbbbbbbbbb';
const P3 = 'cccccccccccccccc';
const H1 = '1111111111111111';
const H2 = '2222222222222222';
const V0 = '2.0.0';
const V1 = '2.1.0';

const L = (project, version, ts, stage, type, round, data) => ({
  ts, stage, type, harness_version: version, profile: 'sdlc', project, ...(round ? { round } : {}), data,
});
const lint = (p, v, ts, rules) => L(p, v, ts, 'plan', 'lint', null, {
  version: 1, errors: rules.map((rule) => ({ rule })), warnings: [], error_count: rules.length, warning_count: 0,
});
const status = (p, v, ts, round, from, to, reason, build) => L(p, v, ts, to === 'in_progress' ? 'build' : 'eval', 'status', round, {
  from, to, reason, ...(build ? { build_duration_ms: build[0], build_turns: build[1], build_cost_usd: build[2] } : {}),
});
const finding = (p, v, ts, outcome, reason) => L(p, v, ts, 'eval', 'finding', 1, { outcome, ...(reason ? { reason } : {}) });
const note = (p, v, ts, kind) => L(p, v, ts, 'feedback', 'intervention', null, { kind });
const ci = (p, v, ts, tests) => L(p, v, ts, 'feedback', 'ci', null, { tests });
const at = (day, hour = 0, minute = 0) => `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;

// The fixed hub: three projects, two harness versions.
const HUB = {
  [P1]: {
    '20260905T000000.000Z.jsonl': [
      lint(P1, V0, at(1, 1), ['check']),
      lint(P1, V0, at(1, 2), ['check']),
      status(P1, V0, at(2), null, 'approved', 'in_progress', 'run_start'),
      L(P1, V0, at(2, 0, 30), 'build', 'step', 1, { role: 'builder', duration_ms: 600000, turns: 40, cost_usd: 2 }),
      status(P1, V0, at(2, 1), 1, 'in_progress', 'passed', 'pass', [600000, 40, 2]),
      status(P1, V0, at(3, 1), 3, 'in_progress', 'blocked', 'stall', [1800000, 90, 6]),
      finding(P1, V0, at(3, 2), 'blocking'),
      finding(P1, V0, at(3, 3), 'backlogged', 'repro_not_reproduced'),
      finding(P1, V0, at(3, 4), 'backlogged', 'repro_not_reproduced'),
      note(P1, V0, at(4, 1), 'manual-fix'),
      ci(P1, V0, at(5, 1), [H1, H2]),
      ci(P1, V0, at(5, 2), [H1]),
    ],
    '20260925T000000.000Z.jsonl': [
      status(P1, V1, at(20, 1), 1, 'in_progress', 'passed', 'pass', [300000, 20, 1]),
      ci(P1, V1, at(20, 2), []),
    ],
  },
  [P2]: {
    '20260906T000000.000Z.jsonl': [
      lint(P2, V0, at(1, 3), ['check', 'size']),
      status(P2, V0, at(2, 2), 2, 'in_progress', 'passed', 'pass', [900000, 50, 3]),
      status(P2, V0, at(3, 5), 3, 'in_progress', 'blocked', 'stall', [1200000, 60, 4]),
      finding(P2, V0, at(3, 6), 'backlogged', 'repro_not_reproduced'),
      note(P2, V0, at(4, 2), 'manual-fix'),
      ci(P2, V0, at(5, 3), [H1]),
    ],
  },
  [P3]: {
    '20260926T000000.000Z.jsonl': [
      ...Array.from({ length: 10 }, (_, i) => lint(P3, V1, at(21, 0, i), ['universal'])),
      lint(P3, V1, at(21, 1), []),
      status(P3, V1, at(22, 1), 1, 'in_progress', 'passed', 'pass', [500000, 30, 1.5]),
      status(P3, V1, at(22, 2), 2, 'in_progress', 'blocked', 'eval_error', [700000, 35, 2.5]),
      finding(P3, V1, at(22, 3), 'blocking'),
      finding(P3, V1, at(22, 4), 'blocking'),
      finding(P3, V1, at(22, 5), 'backlogged', 'missing_repro'),
    ],
  },
};

function writeHub(hub, spec) {
  for (const [project, files] of Object.entries(spec)) {
    for (const [name, lines] of Object.entries(files)) {
      const file = path.join(hub, project, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
    }
  }
  return hub;
}
const fixtureHub = () => writeHub(path.join(tmpdir('harness-f59-'), 'hub'), HUB);
const learn = (args, { cwd = tmpdir('harness-f59-cwd-'), env } = {}) => harness(['learn', ...args], { cwd, env });

const VERSION_V0 = {
  version: V0, projects: 2, events: 18, features: 4,
  build: { duration_ms: 1050000, turns: 55, cost_usd: 3.5 },
  first_round_pass_rate: 0.25, blocked_rate: 0.5, blocked_reasons: [{ reason: 'stall', count: 2 }],
  interventions: 2,
  lint_rejections: [{ rule: 'check', count: 3 }, { rule: 'size', count: 1 }],
  reproduction_rate: 0.25,
  ci_repeated: [{ test: H1, failures: 3 }],
};
const VERSION_V1 = {
  version: V1, projects: 2, events: 18, features: 3,
  build: { duration_ms: 500000, turns: 30, cost_usd: 1.5 },
  first_round_pass_rate: 0.67, blocked_rate: 0.33, blocked_reasons: [{ reason: 'eval_error', count: 1 }],
  interventions: 0,
  lint_rejections: [{ rule: 'universal', count: 10 }],
  reproduction_rate: 0.67,
  ci_repeated: [],
};
const CANDIDATES = [
  { rule: 'lint_rule', subject: 'universal', key: 'lint_rule:universal', priority: 'low',
    title: "lint rule 'universal' rejected 10 contracts — add guidance and an example for it to the spec skill",
    evidence: { projects: 1, events: 10, versions: [V1] } },
  { rule: 'lint_rule', subject: 'check', key: 'lint_rule:check', priority: 'medium',
    title: "lint rule 'check' rejected 3 contracts — add guidance and an example for it to the spec skill",
    evidence: { projects: 2, events: 3, versions: [V0] } },
  { rule: 'backlog_reason', subject: 'repro_not_reproduced', key: 'backlog_reason:repro_not_reproduced', priority: 'medium',
    title: "3 findings were backlogged as 'repro_not_reproduced' — tighten the evaluator's guidance for that case",
    evidence: { projects: 2, events: 3, versions: [V0] } },
  { rule: 'low_reproduction', subject: 'findings', key: 'low_reproduction:findings', priority: 'high',
    title: 'only 43% of 7 findings reproduced — ask evaluators for a repro that fails on the current tree',
    evidence: { projects: 3, events: 7, versions: [V0, V1] } },
  { rule: 'blocked_reason', subject: 'stall', key: 'blocked_reason:stall', priority: 'medium',
    title: "2 features were blocked with 'stall' — look at what kept those rounds from converging",
    evidence: { projects: 2, events: 2, versions: [V0] } },
  { rule: 'intervention', subject: 'manual-fix', key: 'intervention:manual-fix', priority: 'medium',
    title: "2 'manual-fix' interventions — find the step that needed the human and automate or document it",
    evidence: { projects: 2, events: 2, versions: [V0] } },
  { rule: 'ci_repeated', subject: H1, key: `ci_repeated:${H1}`, priority: 'medium',
    title: `CI test ${H1} failed in 3 runs — stabilize it (see test/stress.mjs) or fix the platform difference`,
    evidence: { projects: 2, events: 3, versions: [V0] } },
];
const EXPECTED = { since: null, projects: 3, events: 36, versions: [VERSION_V0, VERSION_V1], candidates: CANDIDATES };

const EXPECTED_TEXT = `learn: 3 projects, 36 events
version 2.0.0: 2 projects, 18 events, 4 features
  build per feature (median): 1050000 ms · 55 turns · $3.5
  first-round pass rate 25% · blocked 50% (stall 2)
  interventions: 2
  lint rejections: check 3 · size 1
  finding reproduction rate: 25%
  ci repeated failures: ${H1} 3
version 2.1.0: 2 projects, 18 events, 3 features
  build per feature (median): 500000 ms · 30 turns · $1.5
  first-round pass rate 67% · blocked 33% (eval_error 1)
  interventions: 0
  lint rejections: universal 10
  finding reproduction rate: 67%
  ci repeated failures: none
candidates:
${CANDIDATES.map((c) => `  [${c.priority}] ${c.key} — ${c.title} (${c.evidence.projects} project${c.evidence.projects === 1 ? '' : 's'}, ${c.evidence.events} events, ${c.evidence.versions.join(', ')})`).join('\n')}`;

// ---------- AC-1 ----------
test('F59 AC-1: learn --json reads every project bundle of the fixed hub into the expected metrics per version', () => {
  const hub = fixtureHub();
  const r = learn(['--hub', hub, '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.stderr, '');
  assert.deepEqual(JSON.parse(r.stdout), EXPECTED);
});

test('F59 AC-1: learn text output matches the expected report for the fixed hub', () => {
  const hub = fixtureHub();
  const r = learn(['--hub', hub]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trimEnd(), EXPECTED_TEXT);
});

test('F59 AC-1: the hub comes from $CC_HARNESS_HUB when --hub is not given, and --hub is relative to the current directory', () => {
  const hub = fixtureHub();
  const r = learn(['--json'], { env: { CC_HARNESS_HUB: hub } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).events, 36);
  const rel = learn(['--hub', 'hub', '--json'], { cwd: path.dirname(hub), env: { CC_HARNESS_HUB: '' } });
  assert.equal(rel.code, 0, rel.stdout + rel.stderr);
  assert.equal(JSON.parse(rel.stdout).projects, 3);
});

test('F59 AC-1: learn --since counts only lines from that day on', () => {
  const hub = fixtureHub();
  const r = learn(['--hub', hub, '--since', '2026-09-20', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.since, '2026-09-20');
  assert.equal(out.projects, 2);
  assert.equal(out.events, 18);
  assert.deepEqual(out.versions, [VERSION_V1]);
  assert.match(learn(['--hub', hub, '--since', '2026-09-20']).stdout, /^learn: 2 projects, 18 events since 2026-09-20\n/);
});

test('F59 AC-1: learn rejects bad options with usage (exit 2)', () => {
  for (const args of [['--hub'], ['--since'], ['--since', '2026-13-45'], ['--bogus'], ['--compare', '2.0.0'], ['--compare', '2.0.0', '2.1.0', '--propose']]) {
    const r = learn(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage: harness learn/);
  }
  assert.match(harness(['--help']).stdout, /learn\s+/);
});

test('F59 AC-1: export keeps a status line\'s from, to and reason, so the hub knows how features ended', () => {
  const line = exportLine({
    ts: at(2), stage: 'eval', type: 'status', feature: 'F1', round: 3, harness_version: V0, profile: 'sdlc',
    data: { from: 'in_progress', to: 'blocked', reason: 'stall', build_duration_ms: 5, build_turns: 2, build_cost_usd: 0.5 },
  }, { project: P1 });
  assert.deepEqual(line.data, { from: 'in_progress', to: 'blocked', reason: 'stall', build_duration_ms: 5, build_turns: 2, build_cost_usd: 0.5 });
  for (const reason of ['pass', 'max_rounds', 'rounds', 'divergence', 'needs-human', 'needs_human', 'eval_error', 'budget', 'run_start']) {
    assert.equal(exportLine({ ts: at(2), stage: 'eval', type: 'status', data: { reason } }, { project: P1 }).data.reason, reason);
  }
  const bad = exportLine({ ts: at(2), stage: 'eval', type: 'status', data: { from: 'somewhere', to: 'F1 title', reason: 'free text' } }, { project: P1 });
  assert.deepEqual(bad.data, {});
});

// A project where the builder reports turns and cost: the feature's final status event carries its build totals.
function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id} works`, check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-27T00:00:00.000Z', hash: hashContract(c) };
  return c;
}
function project({ features = [{ id: 'F1', title: 'feature F1', status: 'approved' }], backlog = { items: [] } } = {}) {
  const files = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': backlog,
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: features.map((f) => ({ security_tier: 'standard', depends_on: [], ...f })) },
    'scripts/ok.mjs': 'process.exit(0);\n',
  };
  for (const f of features) files[`.harness/contracts/${f.id}.json`] = contract(f.id);
  return gitRepo(files, { branch: null });
}
const readEvents = (dir) => {
  const d = path.join(dir, '.harness', 'events');
  return fs.readdirSync(d).filter((n) => n.endsWith('.jsonl')).sort()
    .flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
};

test('F59 AC-1: run records the builder\'s time, turns and cost of a feature on its final status event', async () => {
  const dir = project();
  const RUN_PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
  let round = 0;
  const verdicts = ['fail', 'pass'];
  await runFeatures({
    root: dir,
    config: resolveConfig({ base_branch: 'main', run: { max_parallel: 1 }, verify: { commands: [] }, budget: { step_timeout_sec: 60 } }),
    deps: {
      build: async (a) => { writeFiles(a.cwd, { [`F1-${a.round}.txt`]: 'x\n' }); return { ok: true, costUsd: 0.5, turns: 7 }; },
      verify: async () => RUN_PASSING,
      evaluate: async (a) => {
        const verdict = verdicts[round++];
        return { feature: a.featureId, round: a.round, score: 8, scores: {}, backlogged: [], independence: 'cross-model', costUsd: 0.25, file: null,
          verdict, blocking: verdict === 'fail' ? [{ criterion_id: 'AC-1', summary: 'x', repro: 'node -e "process.exit(1)"' }] : [] };
      },
    },
  });
  const final = readEvents(dir).filter((e) => e.type === 'status' && e.data.to === 'passed');
  assert.equal(final.length, 1);
  assert.equal(final[0].round, 2);
  assert.equal(final[0].data.build_turns, 14);
  assert.equal(final[0].data.build_cost_usd, 1);
  assert.equal(typeof final[0].data.build_duration_ms, 'number');
  const steps = readEvents(dir).filter((e) => e.stage === 'build' && e.type === 'step');
  assert.equal(final[0].data.build_duration_ms, steps.reduce((a, e) => a + e.data.duration_ms, 0));
});

// ---------- AC-2 ----------
test('F59 AC-2: every candidate carries its evidence (projects, events, versions) and meets the threshold', () => {
  const hub = fixtureHub();
  const out = JSON.parse(learn(['--hub', hub, '--json']).stdout);
  assert.ok(out.candidates.length > 0);
  for (const c of out.candidates) {
    assert.ok(Number.isInteger(c.evidence.projects) && Number.isInteger(c.evidence.events) && Array.isArray(c.evidence.versions), JSON.stringify(c));
    assert.ok(c.evidence.projects >= THRESHOLDS.projects || c.evidence.events >= THRESHOLDS.events, JSON.stringify(c));
  }
  assert.deepEqual(THRESHOLDS, { projects: 2, events: 10 });
  // below the threshold: lint rule 'size' (1 project, 1 event), 'eval_error' blocks and 'missing_repro' (1 project each), H2 (1 CI run)
  const keys = out.candidates.map((c) => c.key);
  for (const k of ['lint_rule:size', 'blocked_reason:eval_error', 'backlog_reason:missing_repro', `ci_repeated:${H2}`]) assert.ok(!keys.includes(k), k);
});

test('F59 AC-2: one project needs 10 events for a candidate; two projects need one each', () => {
  const nine = writeHub(path.join(tmpdir('harness-f59-'), 'hub'), {
    [P3]: { 'a.jsonl': Array.from({ length: 9 }, (_, i) => lint(P3, V1, at(21, 0, i), ['universal'])) },
  });
  assert.deepEqual(JSON.parse(learn(['--hub', nine, '--json']).stdout).candidates, []);
  assert.match(learn(['--hub', nine]).stdout, /candidates: none/);
  const ten = writeHub(path.join(tmpdir('harness-f59-'), 'hub'), {
    [P3]: { 'a.jsonl': Array.from({ length: 10 }, (_, i) => lint(P3, V1, at(21, 0, i), ['universal'])) },
  });
  assert.deepEqual(JSON.parse(learn(['--hub', ten, '--json']).stdout).candidates.map((c) => [c.key, c.priority, c.evidence]),
    [['lint_rule:universal', 'low', { projects: 1, events: 10, versions: [V1] }]]);
  const two = writeHub(path.join(tmpdir('harness-f59-'), 'hub'), {
    [P1]: { 'a.jsonl': [note(P1, V0, at(1), 'environment')] },
    [P2]: { 'a.jsonl': [note(P2, V1, at(2), 'environment')] },
  });
  assert.deepEqual(JSON.parse(learn(['--hub', two, '--json']).stdout).candidates.map((c) => [c.key, c.priority, c.evidence]),
    [['intervention:environment', 'medium', { projects: 2, events: 2, versions: [V0, V1] }]]);
});

// ---------- AC-3 ----------
const backlogOf = (dir) => readJson(path.join(dir, '.harness', 'backlog.json')).items;

test('F59 AC-3: learn --propose adds each candidate to the backlog with source field-data, priority and evidence', () => {
  const hub = fixtureHub();
  const other = { id: 'B1', summary: CANDIDATES[0].title, source: 'F3-r1' };
  const dir = project({ backlog: { items: [other] } });
  const r = learn(['--hub', hub, '--propose'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /proposed: 7 added, 0 updated/);
  const items = backlogOf(dir);
  assert.deepEqual(items[0], other);
  const added = items.slice(1);
  assert.equal(added.length, CANDIDATES.length);
  added.forEach((item, i) => {
    const c = CANDIDATES[i];
    assert.equal(item.id, `B${i + 2}`);
    assert.equal(item.source, 'field-data');
    assert.equal(item.learn_rule, c.key);
    assert.equal(item.summary, c.title);
    assert.equal(item.priority, c.priority);
    assert.deepEqual(item.evidence, c.evidence);
    assert.equal(item.seen, 1);
    assert.ok(!Number.isNaN(Date.parse(item.at)));
  });
  assert.match(r.stdout, /B5 \[high\] low_reproduction:findings/);
  // learn without --propose never writes
  const before = fs.readFileSync(path.join(dir, '.harness', 'backlog.json'), 'utf8');
  assert.equal(learn(['--hub', hub], { cwd: dir }).code, 0);
  assert.equal(fs.readFileSync(path.join(dir, '.harness', 'backlog.json'), 'utf8'), before);
});

test('F59 AC-3: proposing again updates seen and evidence of the open item of the same rule instead of adding one', () => {
  const hub = fixtureHub();
  const dir = project();
  assert.equal(learn(['--hub', hub, '--propose'], { cwd: dir }).code, 0);
  // more field data: a third project with a manual-fix intervention
  writeHub(hub, { [P3]: { 'more.jsonl': [note(P3, V1, at(23), 'manual-fix')] } });
  const r = learn(['--hub', hub, '--propose'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /proposed: 0 added, 7 updated/);
  const items = backlogOf(dir);
  assert.equal(items.length, CANDIDATES.length);
  for (const item of items) assert.equal(item.seen, 2, item.learn_rule);
  const manual = items.find((i) => i.learn_rule === 'intervention:manual-fix');
  assert.deepEqual(manual.evidence, { projects: 3, events: 3, versions: [V0, V1] });
  assert.equal(manual.priority, 'medium', 'priority stays as proposed first');
});

test('F59 AC-3: a resolved item of the same rule does not absorb the candidate — a new item is added', () => {
  const hub = fixtureHub();
  const dir = project({
    backlog: { items: [{ id: 'B1', source: 'field-data', learn_rule: 'lint_rule:check', summary: 'old', priority: 'low', seen: 4, resolved_by: 'F7' }] },
  });
  const r = learn(['--hub', hub, '--propose'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const items = backlogOf(dir);
  assert.equal(items[0].seen, 4);
  assert.equal(items.filter((i) => i.learn_rule === 'lint_rule:check').length, 2);
});

test('F59 AC-3: learn --propose needs an initialized project and refuses a corrupt backlog without writing', () => {
  const hub = fixtureHub();
  const bare = tmpdir('harness-f59-bare-');
  const r = learn(['--hub', hub, '--propose'], { cwd: bare });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /not initialized/);
  const dir = project();
  const file = path.join(dir, '.harness', 'backlog.json');
  fs.writeFileSync(file, '{"items": [{"id": "B1"}, {"id": "B1"}]}\n');
  const c = learn(['--hub', hub, '--propose'], { cwd: dir });
  assert.equal(c.code, 2, c.stdout + c.stderr);
  assert.match(c.stderr, /duplicate item id B1/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"items": [{"id": "B1"}, {"id": "B1"}]}\n');
});

// ---------- AC-4 ----------
test('F59 AC-4: learn --compare shows both versions of each metric with the change and its direction', () => {
  const hub = fixtureHub();
  const r = learn(['--hub', hub, '--compare', V0, V1, '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    since: null, v1: V0, v2: V1,
    metrics: [
      { metric: 'build_duration_ms', v1: 1050000, v2: 500000, delta: -550000, direction: 'improved' },
      { metric: 'build_turns', v1: 55, v2: 30, delta: -25, direction: 'improved' },
      { metric: 'build_cost_usd', v1: 3.5, v2: 1.5, delta: -2, direction: 'improved' },
      { metric: 'first_round_pass_rate', v1: 0.25, v2: 0.67, delta: 0.42, direction: 'improved' },
      { metric: 'blocked_rate', v1: 0.5, v2: 0.33, delta: -0.17, direction: 'improved' },
      { metric: 'interventions', v1: 2, v2: 0, delta: -2, direction: 'improved' },
      { metric: 'reproduction_rate', v1: 0.25, v2: 0.67, delta: 0.42, direction: 'improved' },
    ],
  });
  const t = learn(['--hub', hub, '--compare', V0, V1]);
  assert.equal(t.code, 0, t.stdout + t.stderr);
  assert.equal(t.stdout.trimEnd(), [
    'compare 2.0.0 → 2.1.0',
    '  build_duration_ms: 1050000 → 500000 (-550000, improved)',
    '  build_turns: 55 → 30 (-25, improved)',
    '  build_cost_usd: 3.5 → 1.5 (-2, improved)',
    '  first_round_pass_rate: 0.25 → 0.67 (+0.42, improved)',
    '  blocked_rate: 0.5 → 0.33 (-0.17, improved)',
    '  interventions: 2 → 0 (-2, improved)',
    '  reproduction_rate: 0.25 → 0.67 (+0.42, improved)',
  ].join('\n'));
});

test('F59 AC-4: the other way round every change is worse; an equal value is same; a version without data is n/a', () => {
  const hub = fixtureHub();
  const back = JSON.parse(learn(['--hub', hub, '--compare', V1, V0, '--json']).stdout);
  assert.deepEqual(back.metrics.map((m) => m.direction), Array(7).fill('worse'));
  assert.equal(back.metrics[0].delta, 550000);
  const same = JSON.parse(learn(['--hub', hub, '--compare', V0, V0, '--json']).stdout);
  assert.deepEqual(same.metrics.map((m) => [m.delta, m.direction]), Array(7).fill([0, 'same']));
  const none = learn(['--hub', hub, '--compare', V0, '9.9.9', '--json']);
  assert.equal(none.code, 0, none.stdout + none.stderr);
  const out = JSON.parse(none.stdout);
  assert.deepEqual(out.metrics.map((m) => [m.v2, m.delta, m.direction]), Array(7).fill([null, null, 'n/a']));
  assert.match(none.stderr, /no field data for version 9\.9\.9/);
  assert.match(learn(['--hub', hub, '--compare', V0, '9.9.9']).stdout, /build_turns: 55 → n\/a \(n\/a\)/);
});

// ---------- AC-5 ----------
test('F59 AC-5: SPEC, docs and README describe learn: metrics, candidate rules, thresholds and --propose', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'telemetry.md'), 'utf8');
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  for (const text of [spec, doc]) {
    for (const s of ['harness learn', '--propose', '--compare', '--since', 'field-data', 'learn_rule', 'seen', 'evidence', 'no field data',
      'first_round_pass_rate', 'blocked_rate', 'reproduction_rate', 'interventions', 'build_duration_ms', 'build_turns', 'build_cost_usd',
      'lint_rule', 'backlog_reason', 'low_reproduction', 'blocked_reason', 'intervention', 'ci_repeated', 'improved', 'worse']) {
      assert.ok(text.includes(s), `mentions ${s}`);
    }
    assert.match(text, /2개 이상/);
    assert.match(text, /10건 이상/);
  }
  assert.ok(readme.includes('harness learn'));
});

// ---------- ES-1 ----------
test('F59 ES-1: a missing or empty hub prints "no field data" and exits 0', () => {
  const base = tmpdir('harness-f59-');
  const missing = path.join(base, 'nope');
  const empty = path.join(base, 'empty');
  fs.mkdirSync(path.join(empty, P1), { recursive: true });
  fs.writeFileSync(path.join(empty, P1, 'a.jsonl'), '');
  const dir = project();
  const before = fs.readFileSync(path.join(dir, '.harness', 'backlog.json'), 'utf8');
  for (const hub of [missing, empty]) {
    for (const extra of [[], ['--propose'], ['--compare', V0, V1]]) {
      const r = learn(['--hub', hub, ...extra], { cwd: dir });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.equal(r.stdout.trim(), 'no field data');
    }
    const j = learn(['--hub', hub, '--json']);
    assert.equal(j.code, 0, j.stdout + j.stderr);
    assert.deepEqual(JSON.parse(j.stdout), { since: null, projects: 0, events: 0, versions: [], candidates: [], message: 'no field data' });
  }
  assert.equal(fs.readFileSync(path.join(dir, '.harness', 'backlog.json'), 'utf8'), before);
  // a hub with lines, none from the --since day on
  assert.equal(learn(['--hub', fixtureHub(), '--since', '2026-12-01']).stdout.trim(), 'no field data');
});

// ---------- ES-2 ----------
test('F59 ES-2: keys outside the allowlist are ignored with a warning; the rest of the line still counts', () => {
  const polluted = {
    ...note(P2, V0, at(4, 2), 'manual-fix'),
    feature: 'F1', title: 'LEAKtitle',
    data: { kind: 'manual-fix', text: 'LEAKtext', 'Bad Key': 1, reason: 'LEAK free reason', nested: { summary: 'LEAKsummary', turns: 1 } },
  };
  const spec = structuredClone(HUB);
  spec[P2]['20260906T000000.000Z.jsonl'][4] = polluted;
  spec[P2]['20260906T000000.000Z.jsonl'].push('not json', JSON.stringify({ ts: 'yesterday', stage: 'plan', type: 'lint', data: {} }));
  const hub = writeHub(path.join(tmpdir('harness-f59-'), 'hub'), spec);
  const r = learn(['--hub', hub, '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), EXPECTED);
  assert.equal(r.stdout.includes('LEAK'), false);
  const file = path.join(hub, P2, '20260906T000000.000Z.jsonl');
  const warnings = r.stderr.trim().split('\n');
  assert.equal(warnings.length, 2, r.stderr);
  assert.ok(warnings[0].startsWith(`harness: warning: ${file}: ignored keys outside the allowlist: `), warnings[0]);
  for (const k of ['feature', 'title', 'data.text', 'data.Bad Key', 'data.reason', 'data.nested.summary']) assert.ok(warnings[0].includes(k), k);
  assert.equal(warnings[0].includes('LEAK'), false);
  assert.equal(warnings[1], `harness: warning: ${file}: 2 lines skipped (not a JSON object with a valid ts and stage)`);
});
