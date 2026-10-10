import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, fakeExecutableLink, tmpdir, harness } from './helpers.mjs';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { redactor } from '../lib/failures.mjs';
import { verify as realVerify } from '../lib/verify.mjs';
import { storable, VERIFY_CACHE_LIMIT } from '../lib/verify-cache.mjs';
import { runFeatures } from '../lib/run.mjs';

// F87: a verify whose inputs (working tree, merge-base, contract, verify settings, node, platform,
// harness version, command environment) match a stored passed verify returns that result and
// runs nothing.

// ------------------------------------------------------------------ fixtures

// Every command and check appends "<kind> <cwd>" to the log named by its first argument.
// rec.mjs exits 0 iff every further argument names an existing file; count.mjs prints the
// number of lines of tests.txt.
const SCRIPTS = {
  'scripts/rec.mjs': "import fs from 'node:fs';\nconst [log, kind, ...need] = process.argv.slice(2);\n"
    + "fs.appendFileSync(log, `${kind} ${fs.realpathSync.native(process.cwd())}\\n`);\n"
    + 'process.exit(need.every((f) => fs.existsSync(f)) ? 0 : 1);\n',
  'scripts/count.mjs': "import fs from 'node:fs';\nfs.appendFileSync(process.argv[2], `count ${fs.realpathSync.native(process.cwd())}\\n`);\n"
    + "console.log(fs.readFileSync('tests.txt', 'utf8').split('\\n').filter(Boolean).length);\n",
  'tests.txt': 'a\nb\n',
  'doc.md': 'original\n',
};
// What `harness init` writes, so the core's own ignored records are as in a real project.
const HARNESS_IGNORE = 'wt/\n*.tmp-*\nruns/test-count-cache.json\nruns/verify-cache.json\n';

const slash = (p) => p.split(path.sep).join('/');
const quoted = (p) => JSON.stringify(slash(p));
const newLog = () => path.join(tmpdir('harness-f87-log-'), 'log.txt');

// AC-1 is new (F9.txt exists only on the feature branch, so its base run fails); AC-2 is not.
function contract(log, { text = 'ok', id = 'F9' } = {}) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [
      { id: 'AC-1', criterion: `${id}.txt exists`, check: `node scripts/rec.mjs ${quoted(log)} check ${id}.txt`, new: true },
      { id: 'AC-2', criterion: text, check: `node scripts/rec.mjs ${quoted(log)} check`, new: false },
    ],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-08T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

// A repo whose feature branch adds F9.txt (committed), with the contract on main.
function fixture(log, { files = {}, config = {}, contract: c = contract(log) } = {}) {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...config },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': HARNESS_IGNORE,
    '.harness/features.json': { features: [{ id: 'F9', title: 'feature F9', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F9.json': c,
    ...SCRIPTS,
    ...files,
  });
  writeFiles(dir, { 'F9.txt': 'built\n' });
  commitAll(dir, 'feature');
  return dir;
}

// One check at a time: a base run that fails next to another run is re-run alone, which would
// make the number of base runs depend on timing.
const verifyCfg = (log, over = {}) => ({
  commands: [`node scripts/rec.mjs ${quoted(log)} command`], test_count: `node scripts/count.mjs ${quoted(log)}`, check_parallel: 1, ...over,
});
const cfg = (log, { verify: v = {}, ...rest } = {}) => resolveConfig({ base_branch: 'main', verify: verifyCfg(log, v), budget: { step_timeout_sec: 60 }, ...rest });
const verify = (dir, config, extra = {}) => realVerify({ root: dir, featureId: 'F9', base: 'main', config, cpus: 8, ...extra });

const real = (p) => fs.realpathSync.native(p);
const readLog = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
// Runs logged since the last clear: { command, check, count } on head (`cwd`) and on base (elsewhere).
function runs(log, cwd) {
  const out = { head: { command: 0, check: 0, count: 0 }, base: { command: 0, check: 0, count: 0 } };
  for (const line of readLog(log)) {
    const i = line.indexOf(' ');
    const side = line.slice(i + 1) === real(cwd) ? 'head' : 'base';
    out[side][line.slice(0, i)] = (out[side][line.slice(0, i)] ?? 0) + 1;
  }
  return out;
}
const total = (r) => Object.values(r.head).reduce((a, b) => a + b, 0) + Object.values(r.base).reduce((a, b) => a + b, 0);
const clear = (log) => fs.rmSync(log, { force: true });

const cacheFile = (dir) => path.join(dir, '.harness', 'runs', 'verify-cache.json');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const entries = (dir) => (fs.existsSync(cacheFile(dir)) ? readJson(cacheFile(dir)).entries : []);
const events = (dir) => {
  const d = path.join(dir, '.harness', 'events');
  let names = [];
  try { names = fs.readdirSync(d).sort(); } catch { /* none */ }
  return names.flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
};
const cacheEvents = (dir) => events(dir).filter((e) => e.stage === 'verify' && e.type === 'cache');

// A first verify that passes and is stored, then the log cleared.
async function stored(dir, log, config) {
  const first = await verify(dir, config);
  assert.equal(first.pass, true, JSON.stringify(first, null, 2));
  assert.deepEqual(first.cache, { status: 'miss' });
  assert.equal(entries(dir).length, 1, 'the passed result is stored');
  const all = runs(log, dir);
  assert.ok(all.head.command === 1 && all.head.check === 2 && all.base.check === 1, JSON.stringify(all));
  clear(log);
  return first;
}

// A second verify that ran everything again: a miss, the command, both head checks and the new
// criterion's base run.
function assertRanAll(r, log, dir, status = 'miss') {
  assert.equal(r.cache.status, status, JSON.stringify(r.cache));
  const all = runs(log, dir);
  assert.equal(all.head.command, 1, JSON.stringify(all));
  assert.equal(all.head.check, 2, JSON.stringify(all));
  assert.equal(all.base.check, 1, JSON.stringify(all));
}

// ------------------------------------------------------------------ AC-1
test('F87 AC-1: a second verify of the same inputs runs no command, check or base run and returns the stored pass as a hit', async () => {
  const log = newLog();
  const dir = fixture(log);
  const config = cfg(log);
  const first = await stored(dir, log, config);
  const second = await verify(dir, config);
  assert.deepEqual(readLog(log), [], 'nothing ran on head or base');
  assert.equal(second.pass, true);
  assert.deepEqual(second.cache, { status: 'hit' });
  assert.deepEqual(second.commands, first.commands);
  assert.deepEqual(second.criteria, first.criteria);
  assert.deepEqual(second.integrity, first.integrity);
  assert.equal(second.mergeBase, first.mergeBase);
  assert.equal(second.feature, 'F9');
});

test('F87 AC-1: the key is the working tree with uncommitted and untracked files, not the commit', async () => {
  const log = newLog();
  const dir = fixture(log);
  writeFiles(dir, { 'doc.md': 'edited, not committed\n', 'notes/new.txt': 'untracked\n' });
  const config = cfg(log);
  await stored(dir, log, config);
  const second = await verify(dir, config);
  assert.equal(second.cache.status, 'hit');
  assert.deepEqual(readLog(log), []);
  // The repository's own index is not touched by the temporary one: nothing got staged.
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), '');
  assert.equal(git(dir, 'ls-files', '--others', '--exclude-standard', '--', 'notes'), 'notes/new.txt');
});

test('F87 AC-1: files under .harness/runs and .harness/events are not part of the key', async () => {
  const log = newLog();
  const dir = fixture(log);
  const config = cfg(log);
  await stored(dir, log, config);
  writeFiles(dir, { '.harness/runs/other-record.json': '{}\n', '.harness/events/extra.jsonl': '{}\n' });
  const second = await verify(dir, config);
  assert.equal(second.cache.status, 'hit');
  assert.deepEqual(readLog(log), []);
});

test('F87 AC-1: the stored entry names its key and tree, and is written to .harness/runs/verify-cache.json', async () => {
  const log = newLog();
  const dir = fixture(log);
  await stored(dir, log, cfg(log));
  const [e] = entries(dir);
  assert.match(e.key, /^[0-9a-f]{64}$/);
  assert.match(e.tree, /^[0-9a-f]{40,64}$/);
  assert.equal(e.merge_base, git(dir, 'merge-base', 'main', 'HEAD'));
  assert.equal(e.result.pass, true);
  assert.equal('cache' in e.result, false, 'the stored result has no cache status of its own');
});

// ------------------------------------------------------------------ AC-2
const PASS_EVAL = async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });

test('F87 AC-2: in a single-feature run the post-merge verify is a hit, runs nothing and shows as pass (cached)', async () => {
  const log = newLog();
  const c = contract(log, { id: 'F1' });
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': HARNESS_IGNORE,
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': c,
    ...SCRIPTS,
  });
  const steps = [];
  const verifyDep = async (a) => {
    fs.appendFileSync(log, `--- ${a.step}\n`);
    const v = await realVerify(a);
    steps.push({ step: a.step, v });
    return v;
  };
  const build = async (a) => {
    writeFiles(a.cwd, { 'F1.txt': 'built\n' });
    return { ok: true, costUsd: 0 };
  };
  const r = await runFeatures({
    root: dir,
    config: resolveConfig({ base_branch: 'main', run: { max_parallel: 1 }, verify: verifyCfg(log), budget: { step_timeout_sec: 60 } }),
    deps: { build, evaluate: PASS_EVAL, verify: verifyDep, cpus: 8 },
  });
  assert.equal(r.results[0]?.status, 'passed', JSON.stringify(r.results));
  assert.deepEqual(steps.map((s) => [s.step, s.v.cache.status]), [['verify', 'miss'], ['post_merge_verify', 'hit']]);
  const lines = readLog(log);
  const post = lines.slice(lines.indexOf('--- post_merge_verify') + 1);
  assert.deepEqual(post, [], 'no command, check or count ran during the post-merge verify');
  assert.ok(lines.some((l) => l.startsWith('command ')), 'the feature verify ran the command');

  const report = fs.readFileSync(r.report, 'utf8');
  const rows = report.split('\n').filter((l) => /^\| \d+ \| (verify|post_merge_verify) \|/.test(l));
  assert.match(rows.find((l) => l.includes('| post_merge_verify |')), /\| pass \(cached\) \|$/);
  assert.match(rows.find((l) => l.includes('| verify |')), /\| pass \|$/);
  const metrics = fs.readFileSync(r.report.replace(/\.md$/, '.metrics.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const byStep = Object.fromEntries(metrics.map((m) => [m.step, m]));
  assert.equal(byStep.post_merge_verify.cached, true);
  assert.equal(byStep.post_merge_verify.outcome, 'pass');
  assert.equal(byStep.verify.cached, false);
  for (const m of metrics.filter((x) => !['verify', 'post_merge_verify'].includes(x.step))) {
    assert.ok(m.cached === null || m.cached === false, JSON.stringify(m));
  }
});

// ------------------------------------------------------------------ AC-3
const FAKE_CLI = path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs');
const REPLY_PASS = path.join(REPO, 'test', 'fixtures', 'eval', 'pass.json');

test('F87 AC-3: harness eval after a passed harness verify of the same tree reuses that verify and runs no command', () => {
  const log = newLog();
  const dir = fixture(log, {
    config: {
      verify: verifyCfg(log),
      roles: { builder: 'claude', evaluator: 'generic', 'security-reviewer': 'generic' },
      adapters: { generic: { read_only_command: [process.execPath, FAKE_CLI, 'print', REPLY_PASS] } },
    },
  });
  const v = harness(['verify', 'F9', '--json'], { cwd: dir });
  assert.equal(v.code, 0, v.stdout + v.stderr);
  assert.equal(JSON.parse(v.stdout).cache.status, 'miss');
  assert.equal(runs(log, dir).head.command, 1);
  clear(log);
  const e = harness(['eval', 'F9', '--json'], { cwd: dir });
  assert.equal(e.code, 0, e.stdout + e.stderr);
  assert.equal(JSON.parse(e.stdout).verdict, 'pass');
  assert.deepEqual(readLog(log), [], 'the eval verify ran no command, check or count');
  assert.deepEqual(cacheEvents(dir).map((x) => x.data.status), ['miss', 'hit']);
});

// ------------------------------------------------------------------ AC-4
test('F87 AC-4: a modified tracked file is a miss and everything runs', async () => {
  const log = newLog();
  const dir = fixture(log);
  const config = cfg(log);
  await stored(dir, log, config);
  writeFiles(dir, { 'doc.md': 'changed\n' });
  const r = await verify(dir, config);
  assertRanAll(r, log, dir);
  assert.equal(entries(dir).length, 2, 'the new tree is stored as well');
});

test('F87 AC-4: a new untracked file is a miss and everything runs', async () => {
  const log = newLog();
  const dir = fixture(log);
  const config = cfg(log);
  await stored(dir, log, config);
  writeFiles(dir, { 'new-file.txt': 'x\n' });
  assertRanAll(await verify(dir, config), log, dir);
});

test('F87 AC-4: another merge-base commit with the same tree is a miss and everything runs', async () => {
  const log = newLog();
  const dir = fixture(log);
  const config = cfg(log);
  await stored(dir, log, config);
  const tree = git(dir, 'rev-parse', 'HEAD^{tree}');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'main moves');
  git(dir, 'checkout', '-q', 'feature');
  git(dir, 'merge', '-q', '--no-ff', '--no-edit', 'main');
  assert.equal(git(dir, 'rev-parse', 'HEAD^{tree}'), tree, 'the working tree is unchanged');
  assertRanAll(await verify(dir, config), log, dir);
});

test('F87 AC-4: a changed contract criterion is a miss and everything runs (same working tree)', async () => {
  const log = newLog();
  const dir = fixture(log);
  // The working tree verified is a linked worktree; the contract is read from the root, so the
  // contract changes while the verified tree does not.
  const wt = path.join(tmpdir('harness-f87-wt-'), 'wt');
  git(dir, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
  const config = cfg(log);
  const first = await verify(dir, config, { cwd: wt });
  assert.equal(first.pass, true, JSON.stringify(first, null, 2));
  clear(log);
  assert.equal((await verify(dir, config, { cwd: wt })).cache.status, 'hit');
  assert.deepEqual(readLog(log), []);
  fs.writeFileSync(path.join(dir, '.harness', 'contracts', 'F9.json'), JSON.stringify(contract(log, { text: 'reworded' }), null, 2));
  assertRanAll(await verify(dir, config, { cwd: wt }), log, wt);
});

test('F87 AC-4: changed verify.commands is a miss and everything runs', async () => {
  const log = newLog();
  const dir = fixture(log);
  await stored(dir, log, cfg(log));
  const other = cfg(log, { verify: { commands: [`node scripts/rec.mjs ${quoted(log)} command doc.md`] } });
  assertRanAll(await verify(dir, other), log, dir);
});

test('F87 AC-4: a changed value of an allowed environment variable is a miss and everything runs', async () => {
  const log = newLog();
  const dir = fixture(log);
  const config = cfg(log, { env_allowlist: ['F87_AC4_VALUE'] });
  const saved = process.env.F87_AC4_VALUE;
  try {
    process.env.F87_AC4_VALUE = 'first';
    await stored(dir, log, config);
    process.env.F87_AC4_VALUE = 'second';
    assertRanAll(await verify(dir, config), log, dir);
  } finally {
    if (saved === undefined) delete process.env.F87_AC4_VALUE; else process.env.F87_AC4_VALUE = saved;
  }
});

// ------------------------------------------------------------------ AC-5
test('F87 AC-5: a failed verify is not stored and the next verify of the same tree runs everything', async () => {
  const log = newLog();
  const dir = fixture(log);
  const config = cfg(log, { verify: { commands: [`node scripts/rec.mjs ${quoted(log)} command missing-file`] } });
  const first = await verify(dir, config);
  assert.equal(first.pass, false);
  assert.deepEqual(entries(dir), []);
  clear(log);
  const second = await verify(dir, config);
  assert.equal(second.cache.status, 'miss');
  assert.ok(runs(log, dir).head.command >= 1, 'the command ran again');
  assert.deepEqual(entries(dir), []);
});

test('F87 AC-5: a verify passed through a flaky retry (flaky_passed) is not stored and the next verify runs everything', async () => {
  const log = newLog();
  const counter = path.join(tmpdir('harness-f87-flaky-'), 'n.txt');
  // Fails with a named failing test on its first run, passes on every later one.
  const flaky = "import fs from 'node:fs';\nconst f = process.argv[2];\nconst n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0;\n"
    + "fs.writeFileSync(f, String(n + 1));\nif (n === 0) { console.log('not ok 1 - shared flaky test'); process.exit(1); }\n";
  const dir = fixture(log, { files: { 'scripts/flaky.mjs': flaky } });
  const config = cfg(log, { verify: { commands: [`node scripts/flaky.mjs ${quoted(counter)}`, `node scripts/rec.mjs ${quoted(log)} command`] } });
  const first = await verify(dir, config);
  assert.equal(first.pass, true, JSON.stringify(first, null, 2));
  assert.equal(first.commands[0].flaky_passed, true);
  assert.deepEqual(entries(dir), []);
  clear(log);
  const second = await verify(dir, config);
  assert.equal(second.cache.status, 'miss');
  assert.equal(runs(log, dir).head.command, 1, 'the commands ran again');
  assert.equal(second.commands[0].flaky_passed, undefined);
  assert.equal(entries(dir).length, 1, 'the clean pass is stored');
});

test('F87 AC-5: a passed verify with a timed-out base vacuity run is not stored and the next verify runs everything', async () => {
  const log = newLog();
  // Fast where F9.txt exists (head), sleeps 15s where it does not (base): the base run passes
  // its limit (max(1s, 3 × the head run)) and is killed.
  const slow = "import fs from 'node:fs';\nfs.appendFileSync(process.argv[2], `check ${fs.realpathSync.native(process.cwd())}\\n`);\n"
    + "if (!fs.existsSync('F9.txt')) setTimeout(() => process.exit(0), 15000);\n";
  const c = contract(log);
  c.acceptance_criteria[0].check = `node scripts/slow.mjs ${quoted(log)}`;
  c.approval.hash = hashContract(c);
  const dir = fixture(log, { files: { 'scripts/slow.mjs': slow }, contract: c });
  const config = cfg(log, { verify: { vacuity_timeout_sec: 1 } });
  const first = await verify(dir, config);
  assert.equal(first.pass, true, JSON.stringify(first, null, 2));
  assert.equal(first.criteria[0].base_timed_out, true);
  assert.deepEqual(entries(dir), []);
  clear(log);
  const second = await verify(dir, config);
  assert.equal(second.cache.status, 'miss');
  assert.equal(runs(log, dir).head.command, 1, 'the command ran again');
});

test('F87 AC-5: storable is false for a command or head check that timed out and for flaky_passed', () => {
  const ok = { pass: true, commands: [{ pass: true }], criteria: [{ pass: true }] };
  assert.equal(storable(ok), true);
  assert.equal(storable({ ...ok, pass: false }), false);
  assert.equal(storable({ ...ok, commands: [{ pass: true, flaky_passed: true }] }), false);
  assert.equal(storable({ ...ok, commands: [{ pass: true, timedOut: true }] }), false);
  assert.equal(storable({ ...ok, criteria: [{ pass: true, timedOut: true }] }), false);
  assert.equal(storable({ ...ok, criteria: [{ pass: true, base_timed_out: true }] }), false);
});

// ------------------------------------------------------------------ AC-6
test('F87 AC-6: an ignored file outside the core records and node_modules skips the cache: no lookup, no store', async () => {
  const log = newLog();
  const dir = fixture(log, { files: { '.gitignore': 'build/\n*.log\n' } });
  writeFiles(dir, { 'build/out.bin': 'generated\n' });
  const config = cfg(log);
  const first = await verify(dir, config);
  assert.equal(first.pass, true, JSON.stringify(first, null, 2));
  assert.equal(first.cache.status, 'skipped');
  assert.match(first.cache.reason, /ignored files/);
  assert.ok(first.cache.reason.includes('build/'), first.cache.reason);
  assert.deepEqual(entries(dir), [], 'nothing stored');
  clear(log);
  const second = await verify(dir, config);
  assertRanAll(second, log, dir, 'skipped');
  // Not even a stored result of the same inputs is used while the ignored file is there.
  fs.rmSync(path.join(dir, 'build'), { recursive: true });
  clear(log);
  await stored(dir, log, config);
  // An ignored file inside an untracked directory counts too.
  writeFiles(dir, { 'notes/keep.txt': 'x\n', 'notes/debug.log': 'x\n' });
  const third = await verify(dir, config);
  assertRanAll(third, log, dir, 'skipped');
  assert.ok(third.cache.reason.includes('notes/debug.log'), third.cache.reason);
});

test('F87 AC-6: ignored files only under .harness/runs, .harness/events and node_modules keep the cache', async () => {
  const log = newLog();
  const dir = fixture(log, { files: { '.gitignore': 'node_modules/\n.harness/events/\n' } });
  writeFiles(dir, {
    'node_modules/pkg/index.js': 'x\n',
    'packages/a/node_modules/dep/index.js': 'x\n',
    '.harness/events/2026-10.jsonl': '{}\n',
    '.harness/runs/test-count-cache.json': '{"entries":[]}\n',
  });
  const config = cfg(log);
  await stored(dir, log, config);
  const second = await verify(dir, config);
  assert.equal(second.cache.status, 'hit');
  assert.deepEqual(readLog(log), []);
});

// ------------------------------------------------------------------ AC-7
test("F87 AC-7: verify.cache 'off' neither reads nor writes the cache", async () => {
  const log = newLog();
  const dir = fixture(log);
  const on = cfg(log);
  await stored(dir, log, on);
  const off = cfg(log, { verify: { cache: 'off' } });
  const before = fs.readFileSync(cacheFile(dir), 'utf8');
  assertRanAll(await verify(dir, off), log, dir, 'off');
  assert.equal(fs.readFileSync(cacheFile(dir), 'utf8'), before, 'not written');
  const fresh = fixture(newLog());
  const r = await verify(fresh, cfg(log, { verify: { cache: 'off' } }));
  assert.equal(r.pass, true);
  assert.equal(fs.existsSync(cacheFile(fresh)), false);
});

test("F87 AC-7: verify.cache defaults to 'on'", () => {
  assert.equal(resolveConfig({}).verify.cache, 'on');
});

for (const bad of ['yes', 'ON', true, null, 1]) {
  test(`F87 AC-7: verify.cache ${JSON.stringify(bad)} is config_invalid (exit 2) naming the key and the allowed values`, () => {
    const log = newLog();
    const dir = fixture(log, { config: { verify: { commands: [], cache: bad } } });
    const r = harness(['verify', 'F9'], { cwd: dir });
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /verify\.cache/);
    assert.match(r.stderr, /'on' or 'off'/);
    assert.deepEqual(readLog(log), []);
    assert.throws(() => resolveConfig({ verify: { cache: bad } }), (e) => e.code === 'config_invalid');
  });
}

// ------------------------------------------------------------------ AC-8
test('F87 AC-8: every verify leaves one verify/cache event whose data is step, status and (when skipped) reason only', async () => {
  const log = newLog();
  const dir = fixture(log, { files: { '.gitignore': 'build/\n' } });
  const config = cfg(log);
  await verify(dir, config, { round: 1, step: 'verify' });
  await verify(dir, config);
  await verify(dir, cfg(log, { verify: { cache: 'off' } }));
  writeFiles(dir, { 'build/x.bin': 'x\n' });
  await verify(dir, config);
  const got = cacheEvents(dir);
  assert.deepEqual(got.map((e) => e.data.status), ['miss', 'hit', 'off', 'skipped']);
  assert.deepEqual(got.map((e) => Object.keys(e.data).sort()), [['status', 'step'], ['status', 'step'], ['status', 'step'], ['reason', 'status', 'step']]);
  assert.deepEqual(got.map((e) => e.data.step), ['verify', null, null, null]);
  assert.equal(got[0].round, 1);
  assert.equal(got.every((e) => e.feature === 'F9'), true);
  assert.match(got[3].data.reason, /ignored files.*build\//);
});

test(`F87 AC-8: the cache file keeps only the newest ${VERIFY_CACHE_LIMIT} entries`, async () => {
  const log = newLog();
  const dir = fixture(log);
  const old = Array.from({ length: 60 }, (_, i) => ({ key: `old-${i}`, result: { pass: true } }));
  writeFiles(dir, { '.harness/runs/verify-cache.json': { entries: old } });
  await verify(dir, cfg(log));
  const kept = entries(dir);
  assert.equal(kept.length, VERIFY_CACHE_LIMIT);
  assert.equal(VERIFY_CACHE_LIMIT, 50);
  assert.equal(kept[0].key, 'old-11', 'the oldest entries were dropped');
  assert.match(kept.at(-1).key, /^[0-9a-f]{64}$/, 'the new entry is last');
});

// ------------------------------------------------------------------ AC-9
test('F87 AC-9: SPEC §6 describes the verify result cache', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const start = spec.indexOf('### 6.4');
  assert.ok(start !== -1 && start < spec.indexOf('## 7.'), 'SPEC has §6.4 inside §6');
  const sec = spec.slice(start, spec.indexOf('## 7.', start));
  for (const s of [
    // key
    'git write-tree', '임시 index', '.harness/runs', '.harness/events', 'merge-base', '계약 해시', 'verify.commands', 'test_count', 'test_paths',
    'skip_markers', 'flaky', 'check_parallel', 'vacuity_timeout_sec', 'node 버전', '플랫폼', 'harness 버전', 'BASE_ENV_ALLOWLIST', 'env_allowlist',
    'verify-cache.json',
    // only passes, ignored files, setting, event, report
    'flaky_passed', '시간 초과', '무시', 'node_modules', 'D1', '`verify.cache`', "'on'", "'off'", "'hit'", "'miss'", "'skipped'",
    "type 'cache'", 'pass (cached)', '`cached`', '50',
    // caution
    '네트워크', '시각', 'node_modules 내용',
  ]) {
    assert.ok(sec.includes(s), `SPEC §6.4 mentions ${s}`);
  }
});

// ------------------------------------------------------------------ SC-1
test('F87 SC-1: the cache file never holds the value of an allowed environment variable in plain text', async () => {
  const log = newLog();
  const dir = fixture(log);
  const config = cfg(log, {
    env_allowlist: ['F87_SC1_TOKEN'],
    verify: { commands: [`node scripts/rec.mjs ${quoted(log)} command`, 'node -e "console.log(process.env.F87_SC1_TOKEN)"'] },
  });
  const saved = process.env.F87_SC1_TOKEN;
  try {
    process.env.F87_SC1_TOKEN = 'sekret-value-12345';
    const r = await verify(dir, config);
    assert.equal(r.pass, true, JSON.stringify(r, null, 2));
    assert.equal(entries(dir).length, 1);
    assert.equal(fs.readFileSync(cacheFile(dir), 'utf8').includes('sekret-value-12345'), false);
    clear(log);
    assert.equal((await verify(dir, config)).cache.status, 'hit', 'the value still keys the entry');
  } finally {
    if (saved === undefined) delete process.env.F87_SC1_TOKEN; else process.env.F87_SC1_TOKEN = saved;
  }
});

test("F87 SC-1: the stored result goes through the verify's redaction", async () => {
  const log = newLog();
  const dir = fixture(log);
  const secret = 'tok-secret-98765';
  // The secret is a value outside the allowlist; a command line carries it as an argument.
  const config = cfg(log, { verify: { commands: [`node scripts/rec.mjs ${quoted(log)} command`, `node scripts/rec.mjs ${quoted(log)} ${secret}`] } });
  const r = await verify(dir, config, { redact: redactor({ F87_SC1_SECRET: secret }) });
  assert.equal(r.pass, true, JSON.stringify(r, null, 2));
  assert.equal(entries(dir).length, 1);
  const text = fs.readFileSync(cacheFile(dir), 'utf8');
  assert.equal(text.includes(secret), false);
  assert.ok(text.includes('[redacted]'));
});

// ------------------------------------------------------------------ SC-2
const TAMPER = {
  'result.pass is false': (e) => { e.result.pass = false; return e; },
  'result.pass is the string "true"': (e) => { e.result.pass = 'true'; return e; },
  'result is a string': (e) => { e.result = 'pass'; return e; },
  'result is an array': (e) => { e.result = [true]; return e; },
  'result is missing': (e) => { delete e.result; return e; },
  'the entry is a string': () => 'entry',
  'the entry is an array': (e) => [e],
  'the entry is null': () => null,
};
for (const [name, tamper] of Object.entries(TAMPER)) {
  test(`F87 SC-2: a cache entry whose ${name} is not used — everything runs`, async () => {
    const log = newLog();
    const dir = fixture(log);
    const config = cfg(log);
    await stored(dir, log, config);
    const data = readJson(cacheFile(dir));
    data.entries = [tamper(data.entries[0])];
    fs.writeFileSync(cacheFile(dir), JSON.stringify(data));
    const r = await verify(dir, config);
    assert.equal(r.pass, true);
    assertRanAll(r, log, dir);
    assert.equal(entries(dir).filter((e) => e.result?.pass === true).length, 1, 'the real pass replaced it');
  });
}

// ------------------------------------------------------------------ ES-1
for (const [name, content] of [['not JSON', '{ not json'], ['JSON of another shape', '{"entries": 5}'], ['a JSON array', '[]']]) {
  test(`F87 ES-1: a cache file that is ${name} is one warning, an empty cache, and is written anew after a pass`, async () => {
    const log = newLog();
    const dir = fixture(log);
    writeFiles(dir, { '.harness/runs/verify-cache.json': content });
    const r = await verify(dir, cfg(log));
    assert.equal(r.pass, true, JSON.stringify(r, null, 2));
    assertRanAll(r, log, dir);
    const w = r.warnings.filter((x) => x.includes('verify cache'));
    assert.equal(w.length, 1, JSON.stringify(r.warnings));
    assert.ok(w[0].includes(cacheFile(dir)), w[0]);
    assert.equal(entries(dir).length, 1, 'the file was rewritten with the new result');
    assert.equal(entries(dir)[0].result.warnings.some((x) => x.includes('verify cache')), false, "the cache's own warning is not stored");
  });
}

test('F87 ES-1: an unreadable cache file is one warning, an empty cache, and is written anew after a pass', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.diagnostic('file permissions do not apply here'); return; }
  const log = newLog();
  const dir = fixture(log);
  writeFiles(dir, { '.harness/runs/verify-cache.json': '{"entries":[]}' });
  fs.chmodSync(cacheFile(dir), 0o000);
  try {
    const r = await verify(dir, cfg(log));
    assert.equal(r.pass, true, JSON.stringify(r, null, 2));
    assertRanAll(r, log, dir);
    const w = r.warnings.filter((x) => x.includes('verify cache'));
    assert.equal(w.length, 1, JSON.stringify(r.warnings));
    assert.match(w[0], /cannot be read/);
    assert.equal(entries(dir).length, 1);
  } finally {
    try { fs.chmodSync(cacheFile(dir), 0o644); } catch { /* replaced */ }
  }
});

// ------------------------------------------------------------------ ES-2
const POSIX = process.platform !== 'win32'; // the fake git is a shebang script
const REAL_GIT = POSIX ? spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim() : '';
const pathKey = () => Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

// A fake git, first on PATH, that fails the call whose arguments contain ` <sub> ` (logging the
// temporary index it was given) and hands every other call to the real git.
async function withFailingGit(sub, fn) {
  const bin = fakeExecutableLink('git', `#!/bin/sh
case " $* " in *" ${sub} "*) echo "\${GIT_INDEX_FILE:-none}" >> "$(dirname "$0")/index-files.txt"; echo "fatal: injected failure" >&2; exit 128 ;; esac
exec "${REAL_GIT}" "$@"
`, 'harness-f87-git-');
  const seen = path.join(bin, 'index-files.txt');
  const key = pathKey();
  const saved = process.env[key];
  process.env[key] = `${bin}${path.delimiter}${saved}`;
  try {
    return { result: await fn(), seen: fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8').split('\n').filter(Boolean) : [] };
  } finally {
    process.env[key] = saved;
  }
}

// `add -A -- .` is the tree key's own add: a plain ' add ' would also match `worktree add`.
for (const [name, sub] of [['write-tree', 'write-tree'], ['add', 'add -A -- .']]) {
  test(`F87 ES-2: a failing git ${name} for the tree key is one warning, cache skipped, everything runs, no temporary index left`, async () => {
    if (!POSIX) return; // the fake git is a shebang script
    const log = newLog();
    const dir = fixture(log);
    const { result: r, seen } = await withFailingGit(sub, () => verify(dir, cfg(log)));
    assert.equal(r.pass, true, JSON.stringify(r, null, 2));
    assertRanAll(r, log, dir, 'skipped');
    assert.match(r.cache.reason, /tree key/);
    const w = r.warnings.filter((x) => x.includes('verify cache'));
    assert.equal(w.length, 1, JSON.stringify(r.warnings));
    assert.match(w[0], new RegExp(`git ${name} failed: fatal: injected failure`));
    assert.deepEqual(entries(dir), [], 'nothing stored');
    assert.equal(seen.length, 1, 'the failing call ran once');
    assert.notEqual(seen[0], 'none', 'it was given a temporary index');
    assert.equal(fs.existsSync(seen[0]), false, 'the temporary index is removed');
    assert.equal(fs.existsSync(path.dirname(seen[0])), false, 'and its directory');
    assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=no'), '', "the repository's own index is untouched");
  });
}
