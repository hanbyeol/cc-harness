import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, REPO, readJson } from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';
import { hashContract } from '../lib/contract.mjs';
import { HarnessError } from '../lib/errors.mjs';
import { propose } from '../lib/learn.mjs';
import evalCommand from '../lib/commands/eval.mjs';
import statusCommand from '../lib/commands/status.mjs';

// F67: backlog items written by `harness decide` carry a summary and are not open tasks.

const FAKE_CLI = path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs');

function contract() {
  const c = {
    id: 'F1', title: 'fixture feature', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'one', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-28T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture({ backlog = { items: [] }, status = 'blocked' } = {}) {
  return gitRepo({
    '.harness/config.json': {
      profile: 'sdlc', base_branch: 'main', verify: { commands: [] },
      roles: { builder: 'claude', evaluator: 'generic', 'security-reviewer': 'generic' },
      adapters: { generic: { read_only_command: [process.execPath, FAKE_CLI, 'exit', '1'] } },
    },
    '.harness/features.json': { features: ['F1', 'F2', 'F3'].map((id) => ({ id, title: `feature ${id}`, status, depends_on: [] })) },
    '.harness/contracts/F1.json': contract(),
    '.harness/backlog.json': backlog,
    'scripts/ok.mjs': 'process.exit(0);\n',
  }, { branch: null });
}

const backlogFile = (dir) => path.join(dir, '.harness', 'backlog.json');
const backlogText = (dir) => fs.readFileSync(backlogFile(dir), 'utf8');
const eventsText = (dir) => {
  const d = path.join(dir, '.harness', 'events');
  let names = [];
  try { names = fs.readdirSync(d).sort(); } catch { return ''; }
  return names.map((n) => fs.readFileSync(path.join(d, n), 'utf8')).join('');
};

// One decision item without a summary (as written before F67) and one ordinary finding.
const MIXED = () => ({ items: [
  { id: 'B1', kind: 'decision', feature: 'F1', decision: 'accept-risk', reason: 'old decision', at: '2026-09-27T00:00:00.000Z' },
  { id: 'B2', summary: 'ordinary finding', priority: 'high' },
] });

const scores = () => ({ functionality: 9, quality: 9, security: 9, errors: 9, tests: 9 });
const reply = (json) => ({ ok: true, error: null, text: JSON.stringify(json), json, costUsd: 0, exitCode: 0 });
const PASS_VERIFY = {
  pass: true, commands: [], warnings: [],
  integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } },
  criteria: [{ id: 'AC-1', pass: true }],
};

async function evalPrompt(dir) {
  const prompts = [];
  const runAdapter = async (role, opts) => {
    prompts.push(opts.prompt);
    return reply({ scores: scores(), findings: [], out_of_scope: [] });
  };
  try {
    await evalCommand({ root: dir, args: ['F1'], out: () => {}, err: () => {}, deps: { runAdapter, verifyResult: PASS_VERIFY } });
  } catch (e) {
    if (!(e instanceof HarnessError)) throw e;
  }
  assert.ok(prompts.length >= 1, 'the evaluator was asked');
  return prompts[0];
}

async function statusOut(dir) {
  const out = [];
  const code = await statusCommand({ root: dir, args: [], out: (s) => out.push(s), err: () => {} });
  assert.equal(code, 0);
  return out.join('\n');
}

// ---------- AC-1 ----------
test('F67 AC-1: decide --accept-risk writes summary "decision accept-risk for F<n>: <reason>"', () => {
  const dir = fixture();
  const r = harness(['decide', 'F1', '--accept-risk', 'flaky on windows only'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const [item] = readJson(backlogFile(dir)).items;
  assert.equal(item.kind, 'decision');
  assert.equal(item.summary, 'decision accept-risk for F1: flaky on windows only');
});

test('F67 AC-1: decide --split writes summary "decision split for F<n>: <reason>"', () => {
  const dir = fixture();
  const r = harness(['decide', 'F2', '--split', 'too big'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(readJson(backlogFile(dir)).items[0].summary, 'decision split for F2: too big');
});

test('F67 AC-1: decide --rewrite writes summary "decision rewrite for F<n>: <reason>"', () => {
  const dir = fixture();
  const r = harness(['decide', 'F3', '--rewrite', 'criteria vague'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(readJson(backlogFile(dir)).items[0].summary, 'decision rewrite for F3: criteria vague');
});

test('F67 AC-1: the reason in the summary is redacted like the reason field', () => {
  const dir = fixture();
  const r = harness(['decide', 'F1', '--accept-risk', 'key sk-test-secret is fine'], { cwd: dir, env: { GEMINI_API_KEY: 'sk-test-secret' } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(backlogText(dir).includes('sk-test-secret'), false);
  const [item] = readJson(backlogFile(dir)).items;
  assert.match(item.summary, /^decision accept-risk for F1: key .*\[redacted\].* is fine$/);
  assert.equal(item.summary, `decision accept-risk for F1: ${item.reason}`);
});

// ---------- AC-2 ----------
test('F67 AC-2: harness status counts the ordinary item only — backlog: 1 open', async () => {
  const dir = fixture({ backlog: MIXED() });
  const out = await statusOut(dir);
  assert.match(out, /^backlog: 1 open \(high 1 · medium 0 · low 0 · none 0\)$/m);
  // a decision written by decide (with a summary) is not counted either
  assert.equal(harness(['decide', 'F2', '--split', 'too big'], { cwd: dir }).code, 0);
  assert.match(await statusOut(dir), /^backlog: 1 open \(/m);
});

test('F67 AC-2: the eval prompt "## Open backlog" lists the ordinary item only', async () => {
  const dir = fixture({ backlog: MIXED(), status: 'approved' });
  assert.equal(harness(['decide', 'F2', '--split', 'too big'], { cwd: dir }).code, 0);
  const prompt = await evalPrompt(dir);
  const start = prompt.indexOf('## Open backlog');
  assert.ok(start !== -1, prompt);
  const next = prompt.indexOf('\n## ', start + 1);
  const section = prompt.slice(start, next === -1 ? undefined : next);
  const listed = [...section.matchAll(/^- (B\d+) \[/gm)].map((m) => m[1]);
  assert.deepEqual(listed, ['B2']);
  assert.ok(!section.includes('too big') && !section.includes('decision'), section);
});

test('F67 AC-2: learn --propose treats only the ordinary item as open', () => {
  const dir = fixture({ backlog: { items: [
    { id: 'B1', kind: 'decision', source: 'field-data', learn_rule: 'rule:a', decision: 'split', reason: 'r', at: '2026-09-27T00:00:00.000Z' },
    { id: 'B2', source: 'field-data', learn_rule: 'rule:b', summary: 'b', priority: 'low', seen: 1 },
  ] } });
  const evidence = { projects: 2, events: 10, versions: ['2.0.0'] };
  const { added, updated } = propose(backlogFile(dir), [
    { key: 'rule:a', title: 'a', priority: 'low', evidence },
    { key: 'rule:b', title: 'b', priority: 'low', evidence },
  ]);
  assert.deepEqual(updated.map((i) => i.id), ['B2']);
  assert.deepEqual(added.map((i) => i.learn_rule), ['rule:a']);
  const items = readJson(backlogFile(dir)).items;
  assert.equal(items.find((i) => i.id === 'B1').seen, undefined, 'the decision item is not bumped');
});

test('F67 AC-2: insights counts the decision once, from the event, whatever the backlog holds', () => {
  const dir = fixture({ backlog: MIXED() });
  assert.equal(harness(['decide', 'F2', '--split', 'too big'], { cwd: dir }).code, 0);
  const r = harness(['insights', '--json'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const withBacklog = JSON.parse(r.stdout);
  assert.deepEqual(withBacklog.decisions, { total: 1, kinds: [{ kind: 'split', count: 1 }] });
  fs.writeFileSync(backlogFile(dir), JSON.stringify({ items: [] }));
  const empty = JSON.parse(harness(['insights', '--json'], { cwd: dir }).stdout);
  assert.deepEqual(withBacklog, empty, 'backlog items do not enter insights');
});

// ---------- AC-3 ----------
test('F67 AC-3: decision items stay in backlog.json and the feedback/decision event is unchanged', async () => {
  const dir = fixture({ backlog: MIXED() });
  const r = harness(['decide', 'F2', '--split', 'too big'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const items = readJson(backlogFile(dir)).items;
  assert.deepEqual(items.map((i) => [i.id, i.kind ?? null]), [['B1', 'decision'], ['B2', null], ['B3', 'decision']]);
  assert.deepEqual(items[0], MIXED().items[0], 'the older decision item is untouched');
  const b3 = items[2];
  assert.deepEqual(Object.keys(b3).sort(), ['at', 'decision', 'feature', 'id', 'kind', 'reason', 'summary']);
  assert.deepEqual([b3.feature, b3.decision, b3.reason], ['F2', 'split', 'too big']);
  const ev = eventsText(dir).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'decision');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].stage, 'feedback');
  assert.equal(ev[0].feature, 'F2');
  assert.deepEqual(ev[0].data, { decision: 'split', reason: 'too big', backlog_id: 'B3' });
  // reading status and events leaves the backlog as it is
  const before = backlogText(dir);
  await statusOut(dir);
  const shown = harness(['events', '--stage', 'feedback', '--json'], { cwd: dir });
  assert.equal(shown.code, 0, shown.stdout + shown.stderr);
  const listed = JSON.parse(shown.stdout).filter((e) => e.type === 'decision');
  assert.deepEqual(listed.map((e) => e.data), [{ decision: 'split', reason: 'too big', backlog_id: 'B3' }]);
  assert.equal(backlogText(dir), before);
});

// ---------- AC-4 ----------
test('F67 AC-4: SPEC decide section documents the summary format and the open-task exclusion', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const start = spec.indexOf('`harness decide F<n>');
  assert.ok(start !== -1);
  const section = spec.slice(start, spec.indexOf('\n  - ', start + 1));
  assert.ok(section.includes('decision <decision> for F<n>: <사유>'), section);
  assert.match(section, /열린 (과제|항목)이 아니다/);
  assert.match(section, /status/);
  assert.match(section, /Open backlog/);
});

// ---------- ES-1 ----------
test('F67 ES-1: an empty reason is a usage error (exit 2) and the backlog is unchanged', () => {
  const dir = fixture({ backlog: MIXED() });
  const before = backlogText(dir);
  for (const reason of ['', '   ']) {
    const r = harness(['decide', 'F1', '--accept-risk', reason], { cwd: dir });
    assert.equal(r.code, 2, r.stdout + r.stderr);
  }
  assert.equal(harness(['decide', 'F1', '--split'], { cwd: dir }).code, 2);
  assert.equal(backlogText(dir), before);
  assert.equal(eventsText(dir), '');
});
