// F26: verify runs criterion checks and base vacuity runs concurrently (verify.check_parallel,
// 'auto' = max(1, floor(cpus / 4))), re-runs a check that failed while overlapping alone,
// and counts tests on head and base at the same time (SPEC §6.3).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpdir, harness } from './helpers.mjs';
import { gitRepo, git, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { verify, checkParallelFor } from '../lib/verify.mjs';
import { HarnessError } from '../lib/errors.mjs';

const CHECK = path.join(REPO, 'test', 'fixtures', 'interval-check.mjs');

// A check command running the interval recorder. On base it exits 1 unless baseExit says otherwise,
// so new criteria are not vacuous.
const cmd = (log, id, { ms = 0, exit = 0, baseExit = 1, failIfOverlap = false, probe, print, awaitOther = false } = {}) => [
  'node', JSON.stringify(CHECK), JSON.stringify(log), id, '--ms', ms, '--exit', exit, '--base-exit', baseExit,
  ...(failIfOverlap ? ['--fail-if-overlap'] : []), ...(probe ? ['--probe', probe] : []), ...(print !== undefined ? ['--print', print] : []),
  ...(awaitOther ? ['--await-other-side'] : []),
].join(' ');

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
    ...files,
  });
}

const cfg = (verifyExtra = {}, timeout = 60) => resolveConfig({
  base_branch: 'main', verify: { commands: [], test_paths: ['test/**'], ...verifyExtra }, budget: { step_timeout_sec: timeout },
});
const run = (dir, { config = cfg(), cpus = 16 } = {}) => verify({ root: dir, featureId: 'F9', base: 'main', config, cpus });
const byId = (r) => Object.fromEntries(r.criteria.map((c) => [c.id, c]));
const logFile = () => path.join(fs.realpathSync(tmpdir('harness-f26-log-')), 'log.jsonl');
const events = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// Runs as {id, side, cwd, start, end} (end: Infinity when the run never finished).
// Each start pairs with the first later, unused end of the same pid: Windows reuses pids
// quickly, and keying ends by pid alone gave an early run a later run's end (a false overlap).
function intervals(log) {
  const ev = events(log);
  const used = new Set();
  return ev.filter((e) => e.ev === 'start').map((s) => {
    const i = ev.findIndex((e, k) => !used.has(k) && e.ev === 'end' && e.pid === s.pid && e.t >= s.t);
    if (i >= 0) used.add(i);
    return { ...s, start: s.t, end: i >= 0 ? ev[i].t : Infinity };
  });
}

// Largest number of runs active at the same moment.
function maxOverlap(runs) {
  const points = runs.flatMap((r) => [[r.start, 1], [r.end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of points) { cur += d; max = Math.max(max, cur); }
  return max;
}
const overlaps = (a, b) => a.start < b.end && b.start < a.end;

// ---------- AC-1 ----------
test('F26 AC-1: auto check_parallel is max(1, floor(cpus / 4)); an integer is used as is', () => {
  assert.equal(checkParallelFor('auto', 16), 4);
  assert.equal(checkParallelFor('auto', 4), 1);
  assert.equal(checkParallelFor('auto', 2), 1);
  assert.equal(checkParallelFor(undefined, 8), 2);
  assert.equal(checkParallelFor(3, 64), 3);
});

for (const [cpus, limit] of [[16, 4], [4, 1]]) {
  test(`F26 AC-1: with ${cpus} CPUs (auto) at most ${limit} criterion checks run at a time`, async () => {
    const log = logFile();
    const ids = Array.from({ length: 8 }, (_, i) => `AC-${i + 1}`);
    // Long enough that runs sharing a slot window overlap even when process startup is slow.
    const dir = fixture(ids.map((id) => ({ id, check: cmd(log, id, { ms: limit > 1 ? 1000 : 300 }) })));
    const r = await run(dir, { cpus });
    assert.equal(r.pass, true, JSON.stringify(r.criteria));
    const runs = intervals(log);
    assert.equal(runs.length, 8);
    assert.equal(maxOverlap(runs), limit);
  });
}

test('F26 AC-1: verify.check_parallel 3 caps checks at 3 regardless of the CPU count', async () => {
  const log = logFile();
  const ids = Array.from({ length: 7 }, (_, i) => `AC-${i + 1}`);
  const dir = fixture(ids.map((id) => ({ id, check: cmd(log, id, { ms: 1000 }) })));
  const r = await run(dir, { cpus: 64, config: cfg({ check_parallel: 3 }) });
  assert.equal(r.pass, true);
  assert.equal(maxOverlap(intervals(log)), 3);
});

// ---------- AC-2 ----------
test('F26 AC-2: criteria are reported in contract order even when later checks finish first', async () => {
  const log = logFile();
  const dir = fixture([
    { id: 'AC-1', check: cmd(log, 'AC-1', { ms: 900 }) },
    { id: 'AC-2', check: cmd(log, 'AC-2', { ms: 50 }) },
    { id: 'AC-3', check: cmd(log, 'AC-3', { ms: 400 }) },
  ]);
  const r = await run(dir);
  const endOrder = events(log).filter((e) => e.ev === 'end').map((e) => e.id);
  assert.deepEqual(endOrder, ['AC-2', 'AC-3', 'AC-1'], 'fixture: later criteria finish first');
  assert.deepEqual(r.criteria.map((c) => c.id), ['AC-1', 'AC-2', 'AC-3']);
});

// ---------- AC-3 ----------
test('F26 AC-3: a check that failed while overlapping and passes alone is a pass with parallel_retry and a warning', async () => {
  const log = logFile();
  const dir = fixture([
    { id: 'AC-1', check: cmd(log, 'AC-1', { ms: 300, failIfOverlap: true }) },
    { id: 'AC-2', check: cmd(log, 'AC-2', { ms: 300 }) },
  ]);
  const r = await run(dir);
  const c = byId(r)['AC-1'];
  assert.equal(c.pass, true, JSON.stringify(c));
  assert.equal(c.parallel_retry, true);
  assert.ok(r.warnings.some((w) => w.includes('AC-1')), JSON.stringify(r.warnings));
  assert.equal(r.pass, true);
  const runs = intervals(log).filter((x) => x.id === 'AC-1');
  assert.equal(runs.length, 2, 'ran once concurrently and once alone');
  const others = intervals(log).filter((x) => x.pid !== runs[1].pid);
  assert.ok(others.every((o) => o.end <= runs[1].start), 'the retry starts after every concurrent run ended');
});

test('F26 AC-3: a check that fails again when run alone is a fail', async () => {
  const log = logFile();
  const dir = fixture([
    { id: 'AC-1', check: cmd(log, 'AC-1', { ms: 300, exit: 1 }) },
    { id: 'AC-2', check: cmd(log, 'AC-2', { ms: 300 }) },
  ]);
  const r = await run(dir);
  const c = byId(r)['AC-1'];
  assert.equal(c.pass, false);
  assert.equal(c.parallel_retry, true);
  assert.match(c.message, /exit 1/);
  assert.equal(r.pass, false);
  assert.ok(!r.warnings.some((w) => w.includes('AC-1')), JSON.stringify(r.warnings));
  assert.equal(intervals(log).filter((x) => x.id === 'AC-1').length, 2);
});

test('F26 AC-3: a passing check is not re-run and has no parallel_retry', async () => {
  const log = logFile();
  const dir = fixture([
    { id: 'AC-1', check: cmd(log, 'AC-1', { ms: 200 }) },
    { id: 'AC-2', check: cmd(log, 'AC-2', { ms: 200 }) },
  ]);
  const r = await run(dir);
  assert.equal(byId(r)['AC-1'].parallel_retry, undefined);
  assert.equal(intervals(log).length, 2);
});

test('F26 AC-3: a new criterion that passes on its solo retry still gets its base vacuity run', async () => {
  const log = logFile();
  const dir = fixture([
    { id: 'AC-1', check: cmd(log, 'AC-1', { ms: 300, failIfOverlap: true, baseExit: 0 }), isNew: true },
    { id: 'AC-2', check: cmd(log, 'AC-2', { ms: 300 }) },
  ]);
  const r = await run(dir);
  const c = byId(r)['AC-1'];
  assert.equal(c.parallel_retry, true);
  assert.equal(c.vacuous, true, JSON.stringify(c));
  assert.equal(c.pass, false);
  assert.equal(intervals(log).filter((x) => x.id === 'AC-1' && x.side === 'base').length, 1);
});

// ---------- AC-4 ----------
// Test cases are `test(` lines in test/*.test.mjs; count.mjs prints their number.
const COUNT = [
  "import fs from 'node:fs';",
  "const n = fs.readdirSync('test').filter((f) => f.endsWith('.test.mjs'))",
  "  .reduce((s, f) => s + fs.readFileSync(`test/${f}`, 'utf8').split('\\n').filter((l) => l.startsWith('test(')).length, 0);",
  "fs.appendFileSync(process.argv[2], JSON.stringify({ ev: 'count', side: fs.statSync('.git').isDirectory() ? 'head' : 'base', t: Date.now(), n }) + '\\n');",
  'console.log(n);',
  '',
].join('\n');

test('F26 AC-4: base vacuity runs start only after the base test count and the overlay; a removed test is still a decrease', async () => {
  const log = logFile();
  const ids = ['AC-1', 'AC-2', 'AC-3', 'AC-4'];
  const dir = fixture(ids.map((id) => ({ id, check: cmd(log, id, { ms: 300, probe: 'test/new.test.mjs' }), isNew: true })), {
    'count.mjs': COUNT,
    'test/a.test.mjs': "test('one');\ntest('two');\n",
  });
  // The feature drops a test case from an existing file and adds a new test file.
  writeFiles(dir, { 'test/a.test.mjs': "test('one');\n", 'test/new.test.mjs': '// no cases\n' });
  commitAll(dir, 'feature');
  const r = await run(dir, { config: cfg({ test_count: `node count.mjs ${JSON.stringify(log)}` }) });
  assert.equal(r.integrity.testCount.status, 'decreased', JSON.stringify(r.integrity.testCount));
  assert.equal(r.integrity.testCount.base, 2);
  assert.equal(r.integrity.testCount.head, 1);
  const baseCount = events(log).find((e) => e.ev === 'count' && e.side === 'base');
  const baseRuns = intervals(log).filter((x) => x.side === 'base');
  // A base run that failed while others ran is re-run alone once (F35), so count criteria, not runs.
  assert.deepEqual([...new Set(baseRuns.map((b) => b.id))].sort(), ids, 'every new criterion ran on base');
  assert.ok(baseRuns.length <= 2 * ids.length, 'at most one solo re-run per criterion');
  for (const b of baseRuns) {
    assert.ok(b.start >= baseCount.t, `${b.id} started on base before the base test count finished`);
    assert.equal(b.probe, true, `${b.id} ran on base before the feature's test files were placed`);
  }
  assert.ok(maxOverlap(baseRuns) > 1, 'base vacuity runs ran concurrently');
  assert.ok(maxOverlap(baseRuns) <= 4, 'base vacuity runs respect the limit');
});

// ---------- AC-5 ----------
test('F26 AC-5: test_count is computed on head and base at the same time', async () => {
  const log = logFile();
  const dir = fixture([{ id: 'AC-1', check: 'node -e "0"' }]);
  const r = await run(dir, { config: cfg({ test_count: cmd(log, 'count', { ms: 600, baseExit: 0, print: 3, awaitOther: true }) }) });
  assert.equal(r.integrity.testCount.status, 'ok', JSON.stringify(r.integrity.testCount));
  const runs = intervals(log);
  const head = runs.find((x) => x.side === 'head');
  const base = runs.find((x) => x.side === 'base');
  assert.ok(head && base, JSON.stringify(runs));
  assert.ok(overlaps(head, base), `head ${head.start}-${head.end} and base ${base.start}-${base.end} do not overlap`);
});

// ---------- AC-6 ----------
test('F26 AC-6: check_parallel 1 runs checks and base runs one at a time in contract order', async () => {
  const log = logFile();
  const ids = ['AC-1', 'AC-2', 'AC-3', 'AC-4'];
  const dir = fixture([
    ...ids.map((id) => ({ id, check: cmd(log, id, { ms: 150 }), isNew: true })),
    { id: 'AC-5', check: cmd(log, 'AC-5', { ms: 150, exit: 1 }) },
  ]);
  const r = await run(dir, { cpus: 64, config: cfg({ check_parallel: 1, test_count: cmd(log, 'count', { ms: 150, baseExit: 0, print: 3 }) }) });
  const runs = intervals(log);
  assert.equal(maxOverlap(runs), 1, JSON.stringify(runs));
  const order = runs.filter((x) => x.id !== 'count').map((x) => `${x.id}/${x.side}`);
  assert.deepEqual(order, ['AC-1/head', 'AC-1/base', 'AC-2/head', 'AC-2/base', 'AC-3/head', 'AC-3/base', 'AC-4/head', 'AC-4/base', 'AC-5/head']);
  assert.equal(byId(r)['AC-5'].pass, false);
  assert.equal(byId(r)['AC-5'].parallel_retry, undefined, 'nothing ran concurrently, so nothing is retried');
});

// ---------- AC-7 ----------
test('F26 AC-7: SPEC §6 and README describe check_parallel, the solo retry and the base ordering', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s6 = spec.slice(spec.indexOf('## 6.'), spec.indexOf('## 7.'));
  for (const re of [/verify\.check_parallel/, /floor\(CPU 수 \/ 4\)/, /혼자 한 번 더/, /parallel_retry/, /base 테스트 수 → 얹기 → base vacuity/, /동시에/]) {
    assert.match(s6, re);
  }
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  for (const re of [/verify\.check_parallel/, /floor\(CPU 수 \/ 4\)/, /혼자/, /얹/]) assert.match(readme, re);
});

// ---------- SC-1 ----------
test('F26 SC-1: concurrent head checks run in the working tree, base runs in a temporary worktree that is removed', async () => {
  const log = logFile();
  const ids = ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'];
  const dir = fixture(ids.map((id) => ({ id, check: cmd(log, id, { ms: 250 }), isNew: true })));
  const r = await run(dir, { config: cfg({ test_count: cmd(log, 'count', { ms: 250, baseExit: 0, print: 1 }) }) });
  assert.equal(r.pass, true, JSON.stringify(r.criteria));
  const runs = intervals(log);
  assert.ok(maxOverlap(runs) > 1, 'runs overlapped');
  const head = runs.filter((x) => x.side === 'head');
  const base = runs.filter((x) => x.side === 'base');
  assert.equal(head.length, ids.length + 1);
  // Base runs that failed while others ran are re-run alone once (F35): count criteria, not runs.
  assert.deepEqual([...new Set(base.map((b) => b.id))].sort(), [...ids, 'count'].sort());
  assert.ok(base.length <= 2 * ids.length + 1, 'at most one solo re-run per criterion');
  for (const h of head) assert.equal(h.cwd, dir);
  const baseDirs = new Set(base.map((b) => b.cwd));
  assert.equal(baseDirs.size, 1, 'one base worktree');
  const [baseDir] = baseDirs;
  assert.notEqual(baseDir, dir);
  assert.ok(!baseDir.startsWith(dir + path.sep), 'base worktree is outside the working tree');
  assert.equal(fs.existsSync(baseDir), false, 'base worktree directory removed');
  const list = git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));
  // .native on both sides: on Windows the temp dir can be spelled as an 8.3 short name
  // (RUNNER~1) by one API and in full by git.
  assert.deepEqual(list.map((l) => fs.realpathSync.native(l.slice(9))), [fs.realpathSync.native(dir)]);
});

// ---------- ES-1 ----------
for (const [label, value] of [['0', 0], ['fraction', 1.5], ['other string', 'fast'], ['negative', -2], ['numeric string', '2'], ['null', null]]) {
  test(`F26 ES-1: verify.check_parallel ${label} is config_invalid (exit 2) and nothing runs`, () => {
    const log = logFile();
    const dir = fixture([{ id: 'AC-1', check: cmd(log, 'AC-1') }]);
    writeFiles(dir, { '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [], check_parallel: value } } });
    const r = harness(['verify', 'F9'], { cwd: dir });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /verify\.check_parallel/);
    assert.equal(events(log).length, 0, 'no check ran');
    assert.throws(() => resolveConfig({ verify: { check_parallel: value } }),
      (e) => e instanceof HarnessError && e.code === 'config_invalid' && /verify\.check_parallel/.test(e.message));
  });
}

test("F26 ES-1: verify.check_parallel 'auto' and positive integers are accepted", () => {
  for (const v of ['auto', 1, 8]) assert.equal(resolveConfig({ verify: { check_parallel: v } }).verify.check_parallel, v);
  assert.equal(resolveConfig({}).verify.check_parallel, 'auto');
});

// ---------- ES-2 ----------
test('F26 ES-2: a check that times out while others run is fail(timedOut) without a solo retry; the others are recorded', async () => {
  const log = logFile();
  const dir = fixture([
    { id: 'AC-1', check: cmd(log, 'AC-1', { ms: 20000 }) },
    { id: 'AC-2', check: cmd(log, 'AC-2', { ms: 200 }) },
    { id: 'AC-3', check: cmd(log, 'AC-3', { ms: 200, exit: 1 }) },
  ]);
  const r = await run(dir, { config: cfg({}, 2) });
  const c = byId(r);
  assert.equal(c['AC-1'].pass, false);
  assert.equal(c['AC-1'].timedOut, true);
  assert.equal(c['AC-1'].parallel_retry, undefined);
  assert.match(c['AC-1'].message, /timed out/);
  assert.equal(intervals(log).filter((x) => x.id === 'AC-1').length, 1, 'no solo retry after a timeout');
  assert.equal(c['AC-2'].pass, true);
  assert.equal(c['AC-3'].pass, false);
  assert.equal(c['AC-3'].parallel_retry, true);
});
