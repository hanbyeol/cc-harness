import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, REPO, readJson, writeJson, tmpdir } from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';
import { hashContract, lintContract } from '../lib/contract.mjs';
import { HarnessError } from '../lib/errors.mjs';
import { isOpen, recordEntries, recordFlakyTests, resolveItems } from '../lib/backlog.mjs';
import { propose } from '../lib/learn.mjs';
import evalCommand from '../lib/commands/eval.mjs';
import statusCommand from '../lib/commands/status.mjs';

// F95: `harness backlog close` — a human closes open backlog items with a reason.

const FAKE_CLI = path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs');
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const ITEMS = () => [
  { id: 'B1', summary: 'first finding', priority: 'high', seen: 2, sources: ['F1-r1', 'F2-r1'], file: 'lib/a.mjs', line: 3, feature: 'F1', round: 1 },
  { id: 'B2', summary: 'second finding', priority: 'low', seen: 1, sources: ['F3-r2'] },
  { id: 'B3', summary: 'third finding' },
  { id: 'B4', summary: 'done', resolved_by: 'F2' },
  { id: 'B5', summary: 'closed earlier', closed: { as: 'obsolete', reason: 'gone', at: '2026-10-01T00:00:00.000Z' } },
  { id: 'B6', kind: 'decision', feature: 'F1', decision: 'split', reason: 'too big', summary: 'decision split for F1: too big' },
];

// A plain initialized project (no git): enough for the backlog command.
function project({ items = ITEMS(), backlogRaw } = {}) {
  const dir = tmpdir('harness-f95-');
  writeJson(path.join(dir, '.harness', 'config.json'), { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } });
  writeJson(path.join(dir, '.harness', 'features.json'), { features: [] });
  const file = path.join(dir, '.harness', 'backlog.json');
  if (backlogRaw !== undefined) fs.writeFileSync(file, backlogRaw);
  else writeJson(file, { items });
  return dir;
}

const backlogFile = (dir) => path.join(dir, '.harness', 'backlog.json');
const backlogText = (dir) => fs.readFileSync(backlogFile(dir), 'utf8');
const items = (dir) => readJson(backlogFile(dir)).items;
const eventsText = (dir) => {
  const d = path.join(dir, '.harness', 'events');
  let names = [];
  try { names = fs.readdirSync(d).sort(); } catch { return ''; }
  return names.map((n) => fs.readFileSync(path.join(d, n), 'utf8')).join('');
};
const closeEvents = (dir) => eventsText(dir).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'backlog_close');

// The closed item equals the original plus `closed`, nothing else changed.
function assertClosed(item, original, as, reason) {
  const { closed, ...rest } = item;
  assert.deepEqual(rest, original);
  assert.deepEqual(Object.keys(closed).sort(), ['as', 'at', 'reason']);
  assert.equal(closed.as, as);
  assert.equal(closed.reason, reason);
  assert.match(closed.at, AT);
}

// ---------- AC-1 ----------
test('F95 AC-1: close one id --resolved records closed and prints one line', () => {
  const dir = project();
  const r = harness(['backlog', 'close', 'B1', '--resolved', 'fixed in F40'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, 'B1: closed as resolved\n');
  const after = items(dir);
  assert.equal(after.length, ITEMS().length, 'the item stays in backlog.json');
  assertClosed(after[0], ITEMS()[0], 'resolved', 'fixed in F40');
  assert.deepEqual(after.slice(1), ITEMS().slice(1), 'other items are untouched');
});

test('F95 AC-1: close several ids --obsolete records closed on each, one line per id', () => {
  const dir = project();
  const r = harness(['backlog', 'close', 'B2', 'B3', '--obsolete', 'code was removed'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, 'B2: closed as obsolete\nB3: closed as obsolete\n');
  const after = items(dir);
  assert.equal(after.length, ITEMS().length);
  assertClosed(after[1], ITEMS()[1], 'obsolete', 'code was removed');
  assertClosed(after[2], ITEMS()[2], 'obsolete', 'code was removed');
  assert.deepEqual(after[0], ITEMS()[0]);
});

test('F95 AC-1: close one id --obsolete and several ids --resolved', () => {
  const dir = project();
  let r = harness(['backlog', 'close', 'B3', '--obsolete', 'no longer relevant'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, 'B3: closed as obsolete\n');
  assertClosed(items(dir)[2], ITEMS()[2], 'obsolete', 'no longer relevant');
  r = harness(['backlog', 'close', 'B1', 'B2', '--resolved', 'both fixed'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, 'B1: closed as resolved\nB2: closed as resolved\n');
  const after = items(dir);
  assertClosed(after[0], ITEMS()[0], 'resolved', 'both fixed');
  assertClosed(after[1], ITEMS()[1], 'resolved', 'both fixed');
});

// ---------- AC-2 ----------
const ONE_OPEN_ONE_CLOSED = () => [
  { id: 'B1', summary: 'closed finding', priority: 'high', closed: { as: 'resolved', reason: 'fixed', at: '2026-10-01T00:00:00.000Z' } },
  { id: 'B2', summary: 'open finding', priority: 'high' },
];

test('F95 AC-2: isOpen is false for an item with closed', () => {
  const [closed, open] = ONE_OPEN_ONE_CLOSED();
  assert.equal(isOpen(closed), false);
  assert.equal(isOpen(open), true);
});

function evalFixture(backlogItems) {
  const c = {
    id: 'F1', title: 'fixture feature', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'one', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-01T00:00:00.000Z', hash: hashContract(c) };
  return gitRepo({
    '.harness/config.json': {
      profile: 'sdlc', base_branch: 'main', verify: { commands: [] },
      roles: { builder: 'claude', evaluator: 'generic', 'security-reviewer': 'generic' },
      adapters: { generic: { read_only_command: [process.execPath, FAKE_CLI, 'exit', '1'] } },
    },
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F1.json': c,
    '.harness/backlog.json': { items: backlogItems },
    'scripts/ok.mjs': 'process.exit(0);\n',
  }, { branch: null });
}

test('F95 AC-2: harness status counts only the open item', async () => {
  const dir = project({ items: ONE_OPEN_ONE_CLOSED() });
  const out = [];
  assert.equal(await statusCommand({ root: dir, args: [], out: (s) => out.push(s), err: () => {} }), 0);
  const text = out.join('\n');
  assert.match(text, /^backlog: 1 open \(high 1 · medium 0 · low 0 · none 0\)$/m);
  assert.ok(!text.includes('closed finding'), text);
});

test('F95 AC-2: the eval prompt "## Open backlog" lists only the open item', async () => {
  const dir = evalFixture(ONE_OPEN_ONE_CLOSED());
  const prompts = [];
  const scores = { functionality: 9, quality: 9, security: 9, errors: 9, tests: 9 };
  const json = { scores, findings: [], out_of_scope: [] };
  const runAdapter = async (role, opts) => {
    prompts.push(opts.prompt);
    return { ok: true, error: null, text: JSON.stringify(json), json, costUsd: 0, exitCode: 0 };
  };
  const verifyResult = {
    pass: true, commands: [], warnings: [],
    integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } },
    criteria: [{ id: 'AC-1', pass: true }],
  };
  try {
    await evalCommand({ root: dir, args: ['F1'], out: () => {}, err: () => {}, deps: { runAdapter, verifyResult } });
  } catch (e) {
    if (!(e instanceof HarnessError)) throw e;
  }
  assert.ok(prompts.length >= 1, 'the evaluator was asked');
  const prompt = prompts[0];
  const start = prompt.indexOf('## Open backlog');
  assert.ok(start !== -1, prompt);
  const next = prompt.indexOf('\n## ', start + 1);
  const section = prompt.slice(start, next === -1 ? undefined : next);
  assert.deepEqual([...section.matchAll(/^- (B\d+) \[/gm)].map((m) => m[1]), ['B2']);
  assert.ok(!section.includes('closed finding'), section);
});

test('F95 AC-2: learn --propose does not merge into a closed item', () => {
  const dir = project({ items: [
    { id: 'B1', source: 'field-data', learn_rule: 'rule:a', summary: 'a', priority: 'low', seen: 1, closed: { as: 'obsolete', reason: 'r', at: '2026-10-01T00:00:00.000Z' } },
    { id: 'B2', source: 'field-data', learn_rule: 'rule:b', summary: 'b', priority: 'low', seen: 1 },
  ] });
  const evidence = { projects: 2, events: 10, versions: ['2.0.0'] };
  const { added, updated } = propose(backlogFile(dir), [
    { key: 'rule:a', title: 'a', priority: 'low', evidence },
    { key: 'rule:b', title: 'b', priority: 'low', evidence },
  ]);
  assert.deepEqual(updated.map((i) => i.id), ['B2']);
  assert.deepEqual(added.map((i) => i.learn_rule), ['rule:a']);
  assert.equal(items(dir).find((i) => i.id === 'B1').seen, 1, 'the closed item is not bumped');
});

test('F95 AC-2: an evaluator backlog_id naming a closed item adds a new item instead of bumping seen', () => {
  const dir = project({ items: ONE_OPEN_ONE_CLOSED() });
  recordEntries(backlogFile(dir), [
    { summary: 'again closed', backlog_id: 'B1' },
    { summary: 'again open', backlog_id: 'B2' },
  ], { feature: 'F7', round: 1, at: '2026-10-09T00:00:00.000Z' });
  const after = items(dir);
  assert.deepEqual(after[0], ONE_OPEN_ONE_CLOSED()[0], 'the closed item is untouched');
  assert.equal(after[1].seen, 2);
  assert.deepEqual(after[1].sources, ['F7-r1']);
  assert.equal(after.length, 3);
  assert.equal(after[2].summary, 'again closed');
  assert.equal(after[2].id, 'B3');
});

test('F95 AC-2: a flaky test with only a closed flaky_test item gets a new item', () => {
  const closedFlaky = { id: 'B1', kind: 'flaky_test', reason: 'flaky_test', priority: 'low', test: 'slow test', summary: 's', seen: 1, sources: ['F1-r1'],
    closed: { as: 'resolved', reason: 'stabilized', at: '2026-10-01T00:00:00.000Z' } };
  const openFlaky = { id: 'B2', kind: 'flaky_test', reason: 'flaky_test', priority: 'low', test: 'other test', summary: 'o', seen: 1, sources: ['F1-r1'] };
  const dir = project({ items: [closedFlaky, openFlaky] });
  recordFlakyTests(backlogFile(dir), ['slow test', 'other test'], { feature: 'F8', round: 2, at: '2026-10-09T00:00:00.000Z' });
  const after = items(dir);
  assert.deepEqual(after[0], closedFlaky, 'the closed item is not reused');
  assert.equal(after[1].seen, 2);
  assert.equal(after.length, 3);
  assert.equal(after[2].test, 'slow test');
  assert.equal(after[2].closed, undefined);
});

// ---------- AC-3 ----------
test('F95 AC-3: one feedback/backlog_close event per close with ids, as and reason', () => {
  const dir = project();
  assert.equal(harness(['backlog', 'close', 'B1', 'B2', '--resolved', 'fixed together'], { cwd: dir }).code, 0);
  let ev = closeEvents(dir);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].stage, 'feedback');
  assert.deepEqual(ev[0].data, { ids: ['B1', 'B2'], as: 'resolved', reason: 'fixed together' });
  assert.equal(harness(['backlog', 'close', 'B3', '--obsolete', 'gone'], { cwd: dir }).code, 0);
  ev = closeEvents(dir);
  assert.equal(ev.length, 2);
  assert.deepEqual(ev[1].data, { ids: ['B3'], as: 'obsolete', reason: 'gone' });
});

test('F95 AC-3: a non-allowlisted env value in the reason is redacted in backlog.json and the event', () => {
  const dir = project();
  const secret = 'tok-f95-very-secret-value';
  const r = harness(['backlog', 'close', 'B1', '--resolved', `rotated ${secret} already`], { cwd: dir, env: { F95_PRIVATE_TOKEN: secret } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(backlogText(dir).includes(secret), false);
  assert.equal(eventsText(dir).includes(secret), false);
  assert.match(items(dir)[0].closed.reason, /^rotated .*\[redacted\].* already$/);
  assert.match(closeEvents(dir)[0].data.reason, /\[redacted\]/);
});

test('F95 AC-3: an env var in config env_allowlist is not redacted', () => {
  const dir = project();
  writeJson(path.join(dir, '.harness', 'config.json'), { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, env_allowlist: ['F95_PUBLIC_NAME'] });
  const value = 'public-build-name';
  const r = harness(['backlog', 'close', 'B1', '--resolved', `fixed on ${value}`], { cwd: dir, env: { F95_PUBLIC_NAME: value } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(items(dir)[0].closed.reason, `fixed on ${value}`);
  assert.equal(closeEvents(dir)[0].data.reason, `fixed on ${value}`);
});

// ---------- AC-4 ----------
test('F95 AC-4: lint-contract warns when resolves names a closed item', () => {
  const contract = {
    id: 'F9', title: 't', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'one', check: 'node x.mjs' }],
    security_criteria: [], error_scenarios: [], out_of_scope: [], resolves: ['B1', 'B2', 'B3'],
  };
  const backlog = [
    { id: 'B1', summary: 'a', closed: { as: 'obsolete', reason: 'r', at: '2026-10-01T00:00:00.000Z' } },
    { id: 'B2', summary: 'b', closed: { as: 'resolved', reason: 'r', at: '2026-10-01T00:00:00.000Z' } },
    { id: 'B3', summary: 'c' },
  ];
  const warnings = lintContract(contract, { backlog }).filter((p) => p.rule === 'resolves');
  assert.deepEqual(warnings.map((p) => [p.level, p.message]), [
    ['warning', 'resolves: backlog item B1 is already closed as obsolete'],
    ['warning', 'resolves: backlog item B2 is already closed as resolved'],
  ]);
});

test('F95 AC-4: lint-contract command prints the closed warning', () => {
  const dir = project({ items: [{ id: 'B1', summary: 'a', closed: { as: 'resolved', reason: 'r', at: '2026-10-01T00:00:00.000Z' } }] });
  writeJson(path.join(dir, '.harness', 'contracts', 'F9.json'), {
    id: 'F9', title: 't', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'one', check: 'node x.mjs' }],
    security_criteria: [], error_scenarios: [], out_of_scope: [], resolves: ['B1'],
  });
  const r = harness(['lint-contract', 'F9'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('resolves: backlog item B1 is already closed as resolved'), r.stdout);
});

test('F95 AC-4: a passed feature does not write resolved_by on a closed item', () => {
  const closed = { id: 'B1', summary: 'a', closed: { as: 'obsolete', reason: 'r', at: '2026-10-01T00:00:00.000Z' } };
  const dir = project({ items: [closed, { id: 'B2', summary: 'b' }] });
  resolveItems(backlogFile(dir), { resolves: ['B1', 'B2'] }, 'F9');
  const after = items(dir);
  assert.deepEqual(after[0], closed);
  assert.equal(after[1].resolved_by, 'F9');
});

// ---------- AC-5 ----------
test('F95 AC-5: harness --help lists the backlog command', () => {
  const r = harness(['--help'], { cwd: tmpdir() });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^ {2}backlog +\S/m);
  assert.ok(r.stdout.includes('close'), r.stdout);
});

function specSection(spec, heading, nextHeading) {
  const start = spec.indexOf(heading);
  assert.ok(start !== -1, `SPEC has ${heading}`);
  const end = spec.indexOf(nextHeading, start + heading.length);
  return spec.slice(start, end === -1 ? undefined : end);
}

test('F95 AC-5: SPEC §2 and §7.7 document backlog close, closed, open items and backlog_close', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s2 = specSection(spec, '## 2. 사용자와 사용 방식', '## 3. ');
  for (const s of ['harness backlog close B<n>', '--resolved', '--obsolete', 'closed', 'backlog_close', '{ids, as, reason}']) {
    assert.ok(s2.includes(s), `§2 mentions ${s}`);
  }
  const s77 = specSection(spec, '7. **backlog 정리 루프**', '8. **평가·보안 이벤트**');
  assert.match(s77, /\*\*열린 항목\*\*: `resolved_by` 도 `closed` 도 없고 `kind: decision`/);
  for (const s of ['harness backlog close', 'closed: {as, reason, at}', 'backlog_close', 'already closed as']) {
    assert.ok(s77.includes(s), `§7.7 mentions ${s}`);
  }
});

// ---------- ES-1 ----------
const USAGE_CASES = [
  ['no id', ['backlog', 'close', '--resolved', 'r'], /at least one backlog id/],
  ['an id not in the B<n> form', ['backlog', 'close', 'B1', 'X7', '--resolved', 'r'], /X7/],
  ['an id not in backlog.json', ['backlog', 'close', 'B1', 'B99', '--resolved', 'r'], /B99/],
  ['an id already resolved_by', ['backlog', 'close', 'B1', 'B4', '--resolved', 'r'], /B4.*already/],
  ['an id already closed', ['backlog', 'close', 'B5', 'B1', '--obsolete', 'r'], /B5.*already/],
  ['a kind decision item', ['backlog', 'close', 'B1', 'B6', '--resolved', 'r'], /B6/],
  ['both --resolved and --obsolete', ['backlog', 'close', 'B1', '--resolved', '--obsolete', 'r'], /--resolved\|--obsolete/],
  ['neither --resolved nor --obsolete', ['backlog', 'close', 'B1'], /--resolved\|--obsolete/],
  ['an empty reason', ['backlog', 'close', 'B1', '--resolved', '  '], /non-empty reason/],
  ['no reason', ['backlog', 'close', 'B1', '--resolved'], /non-empty reason/],
  ['a reason in several arguments', ['backlog', 'close', 'B1', '--resolved', 'fixed', 'already'], /one quoted argument/],
  ['an unknown option', ['backlog', 'close', 'B1', '--resolved', 'r', '--force'], /--force/],
  ['an unknown subcommand', ['backlog', 'reopen', 'B1'], /reopen/],
];

for (const [name, args, message] of USAGE_CASES) {
  test(`F95 ES-1: ${name} is a usage error and changes nothing`, () => {
    const dir = project();
    const before = backlogText(dir);
    const r = harness(args, { cwd: dir });
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, message);
    assert.equal(r.stdout, '');
    assert.equal(backlogText(dir), before, 'backlog.json is unchanged');
    assert.equal(eventsText(dir), '', 'no event is recorded');
  });
}

// ---------- ES-2 ----------
const CORRUPT = [
  ['not an object', '[1, 2]'],
  ['items not an array', '{"items": {"B1": {}}}'],
  ['duplicate ids', JSON.stringify({ items: [{ id: 'B1', summary: 'a' }, { id: 'B1', summary: 'b' }] })],
];

for (const [name, raw] of CORRUPT) {
  test(`F95 ES-2: a backlog.json with ${name} is state_corrupt (exit 2) and is not written`, () => {
    const dir = project({ backlogRaw: raw });
    const r = harness(['backlog', 'close', 'B1', '--resolved', 'r'], { cwd: dir });
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /backlog\.json/);
    assert.equal(backlogText(dir), raw);
    assert.equal(closeEvents(dir).length, 0);
  });
}

test('F95 ES-2: without .harness/ backlog close is not_initialized (exit 2)', () => {
  const dir = tmpdir('harness-f95-');
  const r = harness(['backlog', 'close', 'B1', '--resolved', 'r'], { cwd: dir });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /not initialized/);
  assert.equal(fs.existsSync(path.join(dir, '.harness')), false);
});
