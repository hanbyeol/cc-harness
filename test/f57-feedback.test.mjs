import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, REPO, readJson } from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';

// F57: feedback stage events (decide, note, ci-record) and `harness insights`.

function fixture({ features = ['F1', 'F2', 'F3'], status = 'blocked', backlog = { items: [] }, files = {} } = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: features.map((id) => ({ id, title: `feature ${id}`, status, depends_on: [] })) },
    '.harness/backlog.json': backlog,
    ...files,
  }, { branch: null });
}

const eventsDir = (dir) => path.join(dir, '.harness', 'events');
const eventsText = (dir) => {
  let names = [];
  try { names = fs.readdirSync(eventsDir(dir)).sort(); } catch { return ''; }
  return names.map((n) => fs.readFileSync(path.join(eventsDir(dir), n), 'utf8')).join('');
};
const events = (dir) => eventsText(dir).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const of = (dir, stage, type) => events(dir).filter((e) => e.stage === stage && e.type === type);
const backlogOf = (dir) => readJson(path.join(dir, '.harness', 'backlog.json'));
const featuresText = (dir) => fs.readFileSync(path.join(dir, '.harness', 'features.json'), 'utf8');

// ---------- AC-1 ----------
test('F57 AC-1: decide records feedback/decision and a kind: decision backlog item, status unchanged', () => {
  const dir = fixture({ backlog: { items: [{ id: 'B1', summary: 'old' }] } });
  const before = featuresText(dir);
  const cases = [['--accept-risk', 'accept-risk', 'F1'], ['--split', 'split', 'F2'], ['--rewrite', 'rewrite', 'F3']];
  for (const [flag, decision, id] of cases) {
    const r = harness(['decide', id, flag, `because ${decision}`], { cwd: dir });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`${id}.*${decision}`));
  }
  const ev = of(dir, 'feedback', 'decision');
  assert.deepEqual(ev.map((e) => [e.feature, e.data.decision, e.data.reason]), cases.map(([, d, id]) => [id, d, `because ${d}`]));
  const items = backlogOf(dir).items;
  assert.equal(items.length, 4);
  assert.deepEqual(items.slice(1).map((i) => [i.id, i.kind, i.feature, i.decision, i.reason]),
    cases.map(([, d, id], k) => [`B${k + 2}`, 'decision', id, d, `because ${d}`]));
  assert.ok(items.slice(1).every((i) => !Number.isNaN(Date.parse(i.at))));
  assert.deepEqual(ev.map((e) => e.data.backlog_id), ['B2', 'B3', 'B4']);
  assert.equal(featuresText(dir), before);
  assert.deepEqual(events(dir).filter((e) => e.type === 'status'), []);
});

test('F57 AC-1: decide takes exactly one decision flag and a known feature', () => {
  const dir = fixture();
  for (const args of [['F1', 'why'], ['F1', '--split', '--rewrite', 'why'], ['F9', '--split', 'why'], ['nope', '--split', 'why'], ['F1', '--split', 'a', 'b']]) {
    const r = harness(['decide', ...args], { cwd: dir });
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  }
  assert.equal(eventsText(dir), '');
  assert.deepEqual(backlogOf(dir).items, []);
});

// ---------- AC-2 ----------
test('F57 AC-2: note records feedback/intervention with the kind and text, feature optional', () => {
  const dir = fixture();
  const kinds = ['manual-fix', 'manual-merge', 'environment', 'other'];
  for (const kind of kinds) {
    const r = harness(['note', 'F2', '--kind', kind, `did ${kind}`], { cwd: dir });
    assert.equal(r.code, 0, r.stdout + r.stderr);
  }
  let r = harness(['note', '--kind', 'environment', 'disk full'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const ev = of(dir, 'feedback', 'intervention');
  assert.deepEqual(ev.map((e) => [e.feature ?? null, e.data.kind, e.data.text]),
    [...kinds.map((k) => ['F2', k, `did ${k}`]), [null, 'environment', 'disk full']]);
  assert.deepEqual(backlogOf(dir).items, []);
  r = harness(['note', 'F2', '--kind', 'magic', 'x'], { cwd: dir });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  r = harness(['note', 'F2', 'no kind'], { cwd: dir });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.equal(of(dir, 'feedback', 'intervention').length, kinds.length + 1);
});

test('F57 AC-2: note text is redacted like other event data', () => {
  const dir = fixture();
  const r = harness(['note', '--kind', 'other', 'key sk-test-secret leaked'], { cwd: dir, env: { GEMINI_API_KEY: 'sk-test-secret' } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(eventsText(dir).includes('sk-test-secret'), false);
  assert.match(of(dir, 'feedback', 'intervention')[0].data.text, /\[redacted\]/);
});

// ---------- AC-3 ----------
test('F57 AC-3: ci-record records feedback/ci with sha, result, job and tests', () => {
  const dir = fixture();
  let r = harness(['ci-record', '--sha', 'abc1234', '--result', 'failure', '--job', 'test (windows)', '--test', 't-a', '--test', 't-b'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  r = harness(['ci-record', '--sha', 'def5678', '--result', 'success'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const ev = of(dir, 'feedback', 'ci');
  assert.deepEqual(ev.map((e) => e.data), [
    { sha: 'abc1234', result: 'failure', job: 'test (windows)', tests: ['t-a', 't-b'] },
    { sha: 'def5678', result: 'success', job: null, tests: [] },
  ]);
  for (const args of [['--result', 'failure'], ['--sha', 'abc1234'], ['--sha', 'abc1234', '--result', 'maybe'],
    ['--sha', 'not a sha', '--result', 'failure'], ['--sha', 'abc1234', '--result', 'failure', '--test']]) {
    r = harness(['ci-record', ...args], { cwd: dir });
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  }
  assert.equal(of(dir, 'feedback', 'ci').length, 2);
});

test('F57 AC-3: a test name recorded in several CI runs is counted as a repeated failure by insights', () => {
  const dir = fixture();
  for (const [sha, tests] of [['aaaa111', ['t-flaky', 't-once']], ['bbbb222', ['t-flaky']], ['cccc333', ['t-flaky', 't-two']], ['dddd444', ['t-two']]]) {
    const r = harness(['ci-record', '--sha', sha, '--result', 'failure', ...tests.flatMap((t) => ['--test', t])], { cwd: dir });
    assert.equal(r.code, 0, r.stdout + r.stderr);
  }
  const r = harness(['insights', '--json'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.ci, { runs: 4, failures: 4, repeated: [{ test: 't-flaky', failures: 3 }, { test: 't-two', failures: 2 }] });
  const text = harness(['insights'], { cwd: dir }).stdout;
  assert.match(text, /repeated failures: t-flaky 3 · t-two 2/);
});

// ---------- AC-4 ----------
const ev = (ts, stage, type, feature, round, data) => ({
  ts, stage, type, ...(feature ? { feature } : {}), ...(round ? { round } : {}),
  harness_version: '2.0.0', profile: 'sdlc', project: '0123456789abcdef', data,
});
const lint = (ts, f, rules) => ev(ts, 'plan', 'lint', f, null, {
  version: 1, errors: rules.map((rule) => ({ rule, id: 'AC-1' })), warnings: [{ rule: 'criterion_text', id: 'AC-9' }],
  error_count: rules.length, warning_count: 1,
});
const step = (ts, stage, type, f, round, duration, cost, turns) => ev(ts, stage, type, f, round, { duration_ms: duration, cost_usd: cost, turns });
const finding = (ts, stage, f, outcome, reason) => ev(ts, stage, 'finding', f, 1, { criterion_id: 'AC-1', outcome, reason, repro_exit: 1, duration_ms: 5 });

const FIXTURE = {
  '2026-08.jsonl': [lint('2026-08-20T00:00:00.000Z', 'F0', ['size'])],
  '2026-09.jsonl': [
    lint('2026-09-01T01:00:00.000Z', 'F1', ['check', 'universal']),
    lint('2026-09-01T02:00:00.000Z', 'F2', ['check']),
    lint('2026-09-01T03:00:00.000Z', 'F3', ['check']),
    lint('2026-09-01T04:00:00.000Z', 'F3', []),
    step('2026-09-02T01:00:00.000Z', 'build', 'step', 'F1', 1, 600000, 1.5, 40),
    step('2026-09-02T02:00:00.000Z', 'build', 'step', 'F2', 1, 300000, 0.5, 20),
    step('2026-09-02T03:00:00.000Z', 'build', 'step', 'F3', 1, 900000, null, null),
    step('2026-09-02T04:00:00.000Z', 'build', 'step', 'F1', 2, 120000, 0.25, 10),
    step('2026-09-02T05:00:00.000Z', 'verify', 'command', 'F1', 1, 30000, null, null),
    step('2026-09-02T06:00:00.000Z', 'verify', 'check', 'F1', 1, 2000, null, null),
    step('2026-09-02T07:00:00.000Z', 'eval', 'step', 'F1', 1, 200000, 0.75, 12),
    finding('2026-09-03T01:00:00.000Z', 'eval', 'F1', 'blocking', null),
    finding('2026-09-03T02:00:00.000Z', 'eval', 'F1', 'backlogged', 'not_reproduced'),
    finding('2026-09-03T03:00:00.000Z', 'eval', 'F2', 'backlogged', 'not_reproduced'),
    finding('2026-09-03T04:00:00.000Z', 'security', 'F3', 'backlogged', 'not_reproduced'),
    finding('2026-09-03T05:00:00.000Z', 'eval', 'F3', 'backlogged', 'no_criterion'),
    ev('2026-09-03T06:00:00.000Z', 'eval', 'reask', 'F1', 1, { reason: 'schema' }),
    ev('2026-09-04T01:00:00.000Z', 'feedback', 'intervention', 'F1', null, { kind: 'manual-fix', text: 'x' }),
    ev('2026-09-04T02:00:00.000Z', 'feedback', 'intervention', 'F2', null, { kind: 'manual-fix', text: 'y' }),
    ev('2026-09-04T03:00:00.000Z', 'feedback', 'intervention', null, null, { kind: 'environment', text: 'z' }),
    ev('2026-09-04T04:00:00.000Z', 'feedback', 'decision', 'F3', null, { decision: 'split', reason: 'too big', backlog_id: 'B1' }),
    ev('2026-09-04T05:00:00.000Z', 'feedback', 'decision', 'F2', null, { decision: 'rewrite', reason: 'vague', backlog_id: 'B2' }),
    ev('2026-09-05T01:00:00.000Z', 'feedback', 'ci', null, null, { sha: 'aaaa111', result: 'failure', job: 'test', tests: ['t-flaky', 't-other'] }),
    ev('2026-09-05T02:00:00.000Z', 'feedback', 'ci', null, null, { sha: 'bbbb222', result: 'failure', job: 'test', tests: ['t-flaky'] }),
    ev('2026-09-05T03:00:00.000Z', 'feedback', 'ci', null, null, { sha: 'cccc333', result: 'success', job: 'test', tests: [] }),
  ],
};

function insightsFixture() {
  const files = {};
  for (const [name, list] of Object.entries(FIXTURE)) files[`.harness/events/${name}`] = list.map((e) => JSON.stringify(e)).join('\n') + '\n';
  return fixture({ files });
}

const top = (type, list) => list.map(([feature, round, value]) => ({ feature, round, type, value }));

const EXPECTED_SINCE = {
  since: '2026-09-01',
  events: 25,
  lint: { checked: 4, rejected: 3, rules: [{ rule: 'check', count: 3 }, { rule: 'universal', count: 1 }] },
  steps: {
    build: {
      count: 4, duration_ms: 1920000, cost_usd: 2.25, turns: 70,
      top: {
        duration_ms: top('step', [['F3', 1, 900000], ['F1', 1, 600000], ['F2', 1, 300000]]),
        cost_usd: top('step', [['F1', 1, 1.5], ['F2', 1, 0.5], ['F1', 2, 0.25]]),
        turns: top('step', [['F1', 1, 40], ['F2', 1, 20], ['F1', 2, 10]]),
      },
    },
    verify: {
      count: 2, duration_ms: 32000, cost_usd: null, turns: null,
      top: {
        duration_ms: [{ feature: 'F1', round: 1, type: 'command', value: 30000 }, { feature: 'F1', round: 1, type: 'check', value: 2000 }],
        cost_usd: [], turns: [],
      },
    },
    eval: {
      count: 1, duration_ms: 200000, cost_usd: 0.75, turns: 12,
      top: {
        duration_ms: top('step', [['F1', 1, 200000]]),
        cost_usd: top('step', [['F1', 1, 0.75]]),
        turns: top('step', [['F1', 1, 12]]),
      },
    },
  },
  findings: {
    total: 5, blocking: 1, backlogged: 4, reproduction_rate: 0.2,
    reasons: [{ reason: 'not_reproduced', count: 3 }, { reason: 'no_criterion', count: 1 }], reasks: 1,
  },
  interventions: { total: 3, kinds: [{ kind: 'manual-fix', count: 2 }, { kind: 'environment', count: 1 }] },
  decisions: { total: 2, kinds: [{ kind: 'rewrite', count: 1 }, { kind: 'split', count: 1 }] },
  ci: { runs: 3, failures: 2, repeated: [{ test: 't-flaky', failures: 2 }] },
  suggestions: [
    { rule: 'lint_rule', subject: 'check', evidence: 3,
      title: "lint rule 'check' rejected 3 criteria — add guidance and an example for it to the spec skill" },
    { rule: 'backlog_reason', subject: 'not_reproduced', evidence: 3,
      title: "3 findings were backlogged as 'not_reproduced' — tighten the evaluator's guidance for that case" },
    { rule: 'low_reproduction', subject: 'findings', evidence: 5,
      title: 'only 20% of 5 findings reproduced — ask evaluators for a repro that fails on the current tree' },
    { rule: 'intervention', subject: 'manual-fix', evidence: 2,
      title: "2 'manual-fix' interventions — find the step that needed the human and automate or document it" },
    { rule: 'rescope', subject: 'decisions', evidence: 2,
      title: '2 blocked features were split or rewritten — contracts may be too large or their criteria unclear at plan time' },
    { rule: 'ci_repeated', subject: 't-flaky', evidence: 2,
      title: "CI test 't-flaky' failed in 2 runs — stabilize it (see test/stress.mjs) or fix the platform difference" },
  ],
};

const EXPECTED_TEXT = `insights: 25 events since 2026-09-01
lint: 4 contracts checked, 3 rejected
  check 3 · universal 1
steps:
  build: 4 · 1920000 ms · $2.25 · 70 turns
    top duration: F3 r1 step 900000 ms · F1 r1 step 600000 ms · F2 r1 step 300000 ms
    top cost: F1 r1 step $1.5 · F2 r1 step $0.5 · F1 r2 step $0.25
    top turns: F1 r1 step 40 · F2 r1 step 20 · F1 r2 step 10
  verify: 2 · 32000 ms · cost n/a · turns n/a
    top duration: F1 r1 command 30000 ms · F1 r1 check 2000 ms
  eval: 1 · 200000 ms · $0.75 · 12 turns
    top duration: F1 r1 step 200000 ms
    top cost: F1 r1 step $0.75
    top turns: F1 r1 step 12
findings: 5 (blocking 1, backlogged 4), reproduction rate 20%
  backlog reasons: not_reproduced 3 · no_criterion 1
  reasks: 1
interventions: 3
  manual-fix 2 · environment 1
decisions: 2
  rewrite 1 · split 1
ci: 3 runs, 2 failures
  repeated failures: t-flaky 2
suggestions:
${EXPECTED_SINCE.suggestions.map((s) => `  [${s.rule}] ${s.title} (${s.evidence} events)`).join('\n')}`;

test('F57 AC-4: insights --json aggregates the fixture events into the expected structure', () => {
  const dir = insightsFixture();
  const r = harness(['insights', '--since', '2026-09-01', '--json'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), EXPECTED_SINCE);
});

test('F57 AC-4: insights text output matches the expected report for the fixture', () => {
  const dir = insightsFixture();
  const r = harness(['insights', '--since', '2026-09-01'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trimEnd(), EXPECTED_TEXT);
});

test('F57 AC-4: without --since every event counts', () => {
  const dir = insightsFixture();
  const r = harness(['insights', '--json'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.since, null);
  assert.equal(out.events, 26);
  assert.deepEqual(out.lint, { checked: 5, rejected: 4, rules: [{ rule: 'check', count: 3 }, { rule: 'size', count: 1 }, { rule: 'universal', count: 1 }] });
  assert.match(harness(['insights'], { cwd: dir }).stdout, /^insights: 26 events\n/);
});

test('F57 AC-4: suggestions need their threshold — below it no suggestion is made', () => {
  const files = { '.harness/events/2026-09.jsonl': [
    lint('2026-09-01T01:00:00.000Z', 'F1', ['check', 'check']),
    finding('2026-09-03T01:00:00.000Z', 'eval', 'F1', 'backlogged', 'not_reproduced'),
    finding('2026-09-03T02:00:00.000Z', 'eval', 'F1', 'blocking', null),
    ev('2026-09-04T01:00:00.000Z', 'feedback', 'intervention', 'F1', null, { kind: 'manual-fix', text: 'x' }),
    ev('2026-09-04T04:00:00.000Z', 'feedback', 'decision', 'F3', null, { decision: 'accept-risk', reason: 'ok' }),
    ev('2026-09-04T05:00:00.000Z', 'feedback', 'decision', 'F2', null, { decision: 'split', reason: 'big' }),
    ev('2026-09-05T01:00:00.000Z', 'feedback', 'ci', null, null, { sha: 'aaaa111', result: 'failure', job: null, tests: ['t-a', 't-a'] }),
  ].map((e) => JSON.stringify(e)).join('\n') + '\n' };
  const dir = fixture({ files });
  const r = harness(['insights', '--json'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.suggestions, []);
  assert.deepEqual(out.ci.repeated, []);
  assert.match(harness(['insights'], { cwd: dir }).stdout, /suggestions: none/);
});

test('F57 AC-4: insights rejects bad options with usage', () => {
  const dir = insightsFixture();
  for (const args of [['--since', 'yesterday'], ['--since'], ['--stage', 'plan']]) {
    assert.equal(harness(['insights', ...args], { cwd: dir }).code, 2, args.join(' '));
  }
});

// ---------- AC-5 ----------
const section = (text, heading) => {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, heading);
  const rest = text.slice(start + heading.length);
  const end = rest.search(/\n##+ /);
  return end === -1 ? rest : rest.slice(0, end);
};

test('F57 AC-5: SPEC §2 and the README describe decide, note, ci-record and the insights rules', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s2 = section(spec, '## 2. ');
  for (const re of [/harness decide/, /--accept-risk/, /--split/, /--rewrite/, /feedback\/decision/, /kind: decision|`kind`: `decision`|kind` `decision/,
    /harness note/, /manual-fix/, /manual-merge/, /environment/, /feedback\/intervention/,
    /harness ci-record/, /--sha/, /--result/, /--job/, /--test/, /feedback\/ci/,
    /harness insights/, /--since/, /--json/, /no events yet/,
    /lint_rule/, /backlog_reason/, /low_reproduction/, /intervention/, /rescope/, /ci_repeated/]) {
    assert.match(s2, re);
  }
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  for (const re of [/harness decide/, /harness note/, /harness ci-record/, /harness insights/]) assert.match(readme, re);
  const help = harness(['--help'], { cwd: REPO }).stdout;
  for (const c of ['decide', 'note', 'ci-record', 'insights']) assert.match(help, new RegExp(`^  ${c} `, 'm'));
});

// ---------- ES-1 ----------
test('F57 ES-1: insights without events prints "no events yet" (text) or the empty structure (--json), exit 0', () => {
  const dir = fixture();
  let r = harness(['insights'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), 'no events yet');
  r = harness(['insights', '--json'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    since: null, events: 0,
    lint: { checked: 0, rejected: 0, rules: [] },
    steps: {},
    findings: { total: 0, blocking: 0, backlogged: 0, reproduction_rate: null, reasons: [], reasks: 0 },
    interventions: { total: 0, kinds: [] },
    decisions: { total: 0, kinds: [] },
    ci: { runs: 0, failures: 0, repeated: [] },
    suggestions: [],
  });
  // An events directory with only unreadable lines is also "no events yet", with the line warning.
  fs.mkdirSync(eventsDir(dir), { recursive: true });
  fs.writeFileSync(path.join(eventsDir(dir), '2026-09.jsonl'), 'not json\n');
  r = harness(['insights'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), 'no events yet');
  assert.match(r.stderr, /events\/2026-09\.jsonl:1: not a JSON object/);
});

// ---------- ES-2 ----------
test('F57 ES-2: decide and note with an empty or missing reason exit 2 and record nothing', () => {
  const dir = fixture({ backlog: { items: [{ id: 'B1', summary: 'old' }] } });
  const before = fs.readFileSync(path.join(dir, '.harness', 'backlog.json'), 'utf8');
  for (const args of [['decide', 'F1', '--split', ''], ['decide', 'F1', '--split', '   '], ['decide', 'F1', '--accept-risk'],
    ['note', 'F1', '--kind', 'manual-fix', ''], ['note', '--kind', 'other', ' \t'], ['note', '--kind', 'other']]) {
    const r = harness(args, { cwd: dir });
    assert.equal(r.code, 2, `${JSON.stringify(args)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage: harness (decide|note)/);
  }
  assert.equal(eventsText(dir), '');
  assert.equal(fs.readFileSync(path.join(dir, '.harness', 'backlog.json'), 'utf8'), before);
});
