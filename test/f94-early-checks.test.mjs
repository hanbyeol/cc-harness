// F94: with verify.check_parallel above 1, head criterion checks start together with the verify
// commands instead of after them and the test count; base vacuity runs still wait for the base
// worktree and the test count (SPEC §6.3).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpdir } from './helpers.mjs';
import { gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { verify } from '../lib/verify.mjs';

const INTERVAL = path.join(REPO, 'test', 'fixtures', 'interval-check.mjs');

// The log lines both fake scripts write: {ev:'start'|'end', id, t, code?}.
const LOG_LIB = [
  "import fs from 'node:fs';",
  'const log = process.argv[2];',
  "const write = (ev) => fs.appendFileSync(log, JSON.stringify({ ...ev, t: Date.now() }) + '\\n');",
  "const read = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)) : []);",
  'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
].join('\n');

const SCRIPTS = {
  // A fake verify command: waits (up to 30 s) until a criterion check has started and, if one
  // did, until it has ended — so a check that may start alongside it overlaps by construction.
  'scripts/cmd.mjs': `${LOG_LIB}
const until = async (pred) => {
  for (const t0 = Date.now(); Date.now() - t0 < 30_000; await sleep(20)) if (read().some(pred)) return true;
  return false;
};
write({ ev: 'start', id: 'cmd' });
if (await until((e) => e.ev === 'start' && e.id !== 'cmd')) await until((e) => e.ev === 'end' && e.id !== 'cmd');
write({ ev: 'end', id: 'cmd' });
`,
  // A fake criterion check: node scripts/check.mjs <log> <id> <ms> [await-cmd] [fail-if-cmd].
  // await-cmd first waits (up to 30 s) until the fake verify command has started, so a check
  // that starts first does not miss it. fail-if-cmd exits 1 when that command was running then.
  'scripts/check.mjs': `${LOG_LIB}
const [, , , id, ms, ...flags] = process.argv;
write({ ev: 'start', id });
const cmdStarted = () => read().some((e) => e.ev === 'start' && e.id === 'cmd');
if (flags.includes('await-cmd')) for (const t0 = Date.now(); !cmdStarted() && Date.now() - t0 < 30_000;) await sleep(20);
const running = cmdStarted() && !read().some((e) => e.ev === 'end' && e.id === 'cmd');
await sleep(Number(ms));
const code = flags.includes('fail-if-cmd') && running ? 1 : 0;
write({ ev: 'end', id, code });
process.exit(code);
`,
};

const CONTRACT = (criteria) => ({
  id: 'F9', title: 'fixture', security_tier: 'standard', version: 1,
  acceptance_criteria: criteria.map(({ id, check, isNew = false }) => ({ id, criterion: id, check, new: isNew })),
  security_criteria: [], error_scenarios: [], out_of_scope: [],
});

function fixture(criteria, files = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': CONTRACT(criteria),
    '.gitignore': '.harness/events/\n.harness/runs/\n',
    ...SCRIPTS, ...files,
  });
}

// The verify result cache (F87) is off: a test verifies one tree more than once.
const cfg = (verifyExtra = {}) => resolveConfig({
  base_branch: 'main', verify: { commands: [], test_paths: ['test/**'], cache: 'off', ...verifyExtra }, budget: { step_timeout_sec: 120 },
});
const run = (dir, config) => verify({ root: dir, featureId: 'F9', base: 'main', config, cpus: 16 });
const logFile = () => path.join(fs.realpathSync(tmpdir('harness-f94-log-')), 'log.jsonl');
const q = JSON.stringify;
const events = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const byId = (r) => Object.fromEntries(r.criteria.map((c) => [c.id, c]));

// Runs as {id, side?, start, end}: the n-th start of an id (and side) pairs with its n-th end.
function intervals(log) {
  const ev = events(log);
  const key = (e) => `${e.id}/${e.side ?? ''}`;
  const ends = new Map();
  for (const e of ev.filter((x) => x.ev === 'end')) ends.set(key(e), [...(ends.get(key(e)) || []), e]);
  const seen = new Map();
  return ev.filter((e) => e.ev === 'start').map((s) => {
    const n = seen.get(key(s)) ?? 0;
    seen.set(key(s), n + 1);
    const end = ends.get(key(s))?.[n];
    return { id: s.id, side: s.side, probe: s.probe, start: s.t, end: end ? end.t : Infinity, code: end?.code };
  });
}
const overlaps = (a, b) => a.start < b.end && b.start < a.end;

// ---------- AC-1 ----------
test('F94 AC-1: with check_parallel above 1 a head criterion check runs while a verify command runs', async () => {
  const log = logFile();
  const dir = fixture([{ id: 'AC-1', check: `node scripts/check.mjs ${q(log)} AC-1 300 await-cmd` }]);
  const r = await run(dir, cfg({ check_parallel: 2, commands: [`node scripts/cmd.mjs ${q(log)}`] }));
  assert.equal(r.pass, true, q(r));
  const runs = intervals(log);
  const cmd = runs.find((x) => x.id === 'cmd');
  const check = runs.find((x) => x.id === 'AC-1');
  assert.ok(cmd && check, q(runs));
  assert.ok(overlaps(cmd, check), `command ${cmd.start}-${cmd.end} and check ${check.start}-${check.end} do not overlap`);
});

// ---------- AC-2 ----------
test('F94 AC-2: check_parallel 1 runs the verify command, then the test count, then the checks, one at a time', async () => {
  const log = logFile();
  const dir = fixture([
    { id: 'AC-1', check: `node ${q(INTERVAL)} ${q(log)} AC-1 --ms 150` },
    { id: 'AC-2', check: `node ${q(INTERVAL)} ${q(log)} AC-2 --ms 150` },
  ]);
  const r = await run(dir, cfg({
    check_parallel: 1,
    commands: [`node ${q(INTERVAL)} ${q(log)} cmd --ms 150`],
    test_count: `node ${q(INTERVAL)} ${q(log)} count --ms 150 --print 3`,
  }));
  assert.equal(r.pass, true, q(r));
  const runs = intervals(log);
  assert.deepEqual(runs.map((x) => `${x.id}/${x.side}`), ['cmd/head', 'count/head', 'count/base', 'AC-1/head', 'AC-2/head']);
  for (let i = 1; i < runs.length; i += 1) {
    assert.ok(runs[i - 1].end <= runs[i].start, `${runs[i - 1].id} and ${runs[i].id} overlap: ${q(runs)}`);
  }
});

// ---------- AC-3 ----------
// The parts of a verify result that do not depend on timing.
const outcome = (r) => ({
  pass: r.pass,
  commands: r.commands.map((c) => ({ cmd: c.cmd, pass: c.pass, code: c.code })),
  integrity: { markers: r.integrity.markers, harnessPaths: r.integrity.harnessPaths, testCount: { status: r.integrity.testCount.status, base: r.integrity.testCount.base, head: r.integrity.testCount.head } },
  criteria: r.criteria.map((c) => ({ id: c.id, check: c.check, pass: c.pass, vacuous: c.vacuous, message: c.message })),
});

test('F94 AC-3: base vacuity runs follow the base count and overlay; the result matches the sequential verify', async () => {
  const log = logFile();
  const probe = 'test/new.test.mjs';
  const check = (id, extra) => `node ${q(INTERVAL)} ${q(log)} ${id} --ms 300 --probe ${probe} ${extra}`;
  const dir = fixture([
    { id: 'AC-1', check: check('AC-1', '--exit 0 --base-exit 1'), isNew: true },
    { id: 'AC-2', check: check('AC-2', '--exit 1') },
    { id: 'AC-3', check: check('AC-3', '--exit 0 --base-exit 0'), isNew: true },
    { id: 'AC-4', check: check('AC-4', '--exit 0') },
  ]);
  writeFiles(dir, { [probe]: '// the feature test file\n' });
  commitAll(dir, 'feature');
  const verifyCfg = {
    commands: [`node ${q(INTERVAL)} ${q(log)} cmd --ms 300`],
    test_count: `node ${q(INTERVAL)} ${q(log)} count --ms 150 --print 3`,
  };
  const expected = {
    pass: false,
    commands: [{ cmd: verifyCfg.commands[0], pass: true, code: 0 }],
    integrity: { markers: [], harnessPaths: [], testCount: { status: 'ok', base: 3, head: 3 } },
    criteria: [
      { id: 'AC-1', check: check('AC-1', '--exit 0 --base-exit 1'), pass: true, vacuous: false, message: undefined },
      { id: 'AC-2', check: check('AC-2', '--exit 1'), pass: false, vacuous: false, message: 'exit 1' },
      { id: 'AC-3', check: check('AC-3', '--exit 0 --base-exit 0'), pass: false, vacuous: true, message: "vacuous: new criterion already passes on base with the feature's test files" },
      { id: 'AC-4', check: check('AC-4', '--exit 0'), pass: true, vacuous: false, message: undefined },
    ],
  };
  // The concurrent verify goes first: the second verify reads the base count from the cache.
  const parallel = await run(dir, cfg({ ...verifyCfg, check_parallel: 4 }));
  const runs = intervals(log);
  const sequential = await run(dir, cfg({ ...verifyCfg, check_parallel: 1 }));
  assert.deepEqual(outcome(sequential), expected);
  assert.deepEqual(outcome(parallel), expected);
  assert.deepEqual(outcome(parallel), outcome(sequential));
  const baseCount = runs.find((x) => x.id === 'count' && x.side === 'base');
  assert.ok(baseCount, JSON.stringify(runs));
  const baseRuns = runs.filter((x) => x.side === 'base' && x.id !== 'count');
  assert.deepEqual([...new Set(baseRuns.map((b) => b.id))].sort(), ['AC-1', 'AC-3']);
  for (const b of baseRuns) {
    assert.ok(b.start >= baseCount.end, `${b.id} started on base before the base test count ended`);
    assert.equal(b.probe, true, `${b.id} ran on base before the feature's test files were placed`);
  }
});

// ---------- AC-4 ----------
test('F94 AC-4: a head check that failed while a verify command ran is re-run alone after every concurrent run', async () => {
  const log = logFile();
  const dir = fixture([{ id: 'AC-1', check: `node scripts/check.mjs ${q(log)} AC-1 200 await-cmd fail-if-cmd` }]);
  const r = await run(dir, cfg({ check_parallel: 2, commands: [`node scripts/cmd.mjs ${q(log)}`] }));
  const c = byId(r)['AC-1'];
  assert.equal(c.pass, true, q(c));
  assert.equal(c.parallel_retry, true, q(c));
  assert.ok(r.warnings.some((w) => w.startsWith('AC-1: check failed while running concurrently')), q(r.warnings));
  const runs = intervals(log);
  const cmd = runs.find((x) => x.id === 'cmd');
  const checks = runs.filter((x) => x.id === 'AC-1');
  assert.equal(checks.length, 2, q(runs));
  assert.equal(checks[0].code, 1, 'the first run overlapped the verify command');
  assert.ok(checks[1].start >= cmd.end, 'the solo re-run starts after the verify command ended');
  assert.equal(checks[1].code, 0);
});

// ---------- AC-5 ----------
test('F94 AC-5: time a head check overlaps a verify command is in phases_ms.checks, with the F81 keys', async () => {
  const log = logFile();
  const dir = fixture([{ id: 'AC-1', check: `node scripts/check.mjs ${q(log)} AC-1 3000 await-cmd` }]);
  const r = await run(dir, cfg({ check_parallel: 2, commands: [`node scripts/cmd.mjs ${q(log)}`] }));
  assert.equal(r.pass, true, q(r));
  assert.deepEqual(Object.keys(r.phases_ms), ['integrity', 'commands', 'test_count', 'checks', 'cleanup']);
  for (const v of Object.values(r.phases_ms)) assert.ok(Number.isInteger(v) && v >= 0, q(r.phases_ms));
  const sum = Object.values(r.phases_ms).reduce((a, b) => a + b, 0);
  assert.ok(sum <= r.total_ms, q(r));
  // The check runs ~3 s, all of it while the verify command waits for it.
  assert.ok(r.phases_ms.checks >= 2900, q(r.phases_ms));
  assert.ok(r.phases_ms.commands < r.phases_ms.checks, q(r.phases_ms));
});

test('F94 AC-5: SPEC §6 describes when head checks start and the sequential order of check_parallel 1', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s6 = spec.slice(spec.indexOf('### 6.3'), spec.indexOf('### 6.4'));
  assert.match(s6, /head 기준 check 는 `verify\.commands` 와 동시에 시작/);
  assert.match(s6, /`verify\.check_parallel` 이 1 이면[^\n]*`verify\.commands` → 테스트 수[^\n→]*(?:→[^\n→]*)?→ 기준 check/);
  assert.match(s6, /겹친 시간은 `checks` 구간/);
});

// ---------- ES-1 ----------
test('F94 ES-1: a verify command that is not found is an environment failure; a concurrent check is awaited and kept', async () => {
  const log = logFile();
  const dir = fixture([{ id: 'AC-1', check: `node scripts/check.mjs ${q(log)} AC-1 1500` }]);
  const r = await run(dir, cfg({ check_parallel: 2, commands: ['harness-f94-no-such-program --x'] }));
  const returned = Date.now();
  assert.equal(r.pass, false);
  assert.equal(r.commands[0].pass, false);
  assert.equal(r.commands[0].notFound, 'harness-f94-no-such-program', q(r.commands));
  const c = byId(r)['AC-1'];
  assert.equal(c.pass, true, q(c));
  const [check] = intervals(log).filter((x) => x.id === 'AC-1');
  assert.ok(check && check.end <= returned, `the check did not end before verify returned: ${q(intervals(log))}`);
});
