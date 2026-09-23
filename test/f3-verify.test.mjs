import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harness } from './helpers.mjs';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { verify, DEFAULT_SKIP_MARKERS, effectiveMarkers, findMarker } from '../lib/verify.mjs';
import { HarnessError } from '../lib/errors.mjs';

// Markers are written split at '|' so this file's own diff passes verify's marker scan.
const m = (s) => s.replace('|', '');
const MARKERS = ['.sk|ip(', '.on|ly(', 'x|it(', 'x|describe(', '@pytest.mark.sk|ip', '@Dis|abled', 't.Sk|ip(', '@Ig|nore'].map(m);
const [SKIP, ONLY, XIT, XDESCRIBE, , , TSKIP] = MARKERS;

// Scripts are files, not `node -e "..."`, so commands quote the same on every shell.
const SCRIPTS = {
  'scripts/ok.mjs': 'process.exit(0);\n',
  'scripts/fail.mjs': 'process.exit(3);\n',
  'scripts/log.mjs': "import fs from 'node:fs';\nfs.appendFileSync('order.log', process.argv[2] + '\\n');\n",
  // Fails on the first call, passes on the second (state file in cwd).
  'scripts/flaky.mjs': "import fs from 'node:fs';\nconst f = 'flaky.state';\nif (fs.existsSync(f)) process.exit(0);\nfs.writeFileSync(f, '1');\nprocess.exit(1);\n",
  'scripts/count.mjs': "import fs from 'node:fs';\nconsole.log('collecting');\nconsole.log(fs.readFileSync('count.txt', 'utf8').trim());\n",
  'scripts/cwd.mjs': "import fs from 'node:fs';\nfs.writeFileSync(process.argv[2], process.cwd());\n",
  // Prints env names to a file; exits 1 if any injected secret is visible.
  'scripts/env.mjs': [
    "import fs from 'node:fs';",
    "const names = Object.keys(process.env);",
    "fs.appendFileSync(process.argv[2], JSON.stringify(names) + '\\n');",
    "process.exit(['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'FOO_SECRET'].some((n) => n in process.env) ? 1 : 0);",
    '',
  ].join('\n'),
  // Spawns a grandchild that outlives nothing: both sleep far past the timeout.
  'scripts/slow.mjs': [
    "import fs from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
    "fs.appendFileSync(process.argv[2], gc.pid + '\\n');",
    'setTimeout(() => {}, 60000);',
    '',
  ].join('\n'),
};

const contract = (overrides = {}) => ({
  id: 'F9', title: 'fixture', security_tier: 'standard', version: 1,
  acceptance_criteria: [{ id: 'AC-1', criterion: 'check exists', check: 'node check.mjs', new: true }],
  security_criteria: [], error_scenarios: [], out_of_scope: [],
  ...overrides,
});

// Base branch `main` holds initialized .harness state + scripts; HEAD is `feature`
// with the builder's change: an untracked check.mjs that makes AC-1 pass.
function fixture({ files = {}, contract: c = contract() } = {}) {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': c,
    ...SCRIPTS,
    ...files,
  });
  writeFiles(dir, { 'check.mjs': 'process.exit(0);\n' });
  return dir;
}

const cfg = (over = {}) => resolveConfig({ base_branch: 'main', ...over, budget: { step_timeout_sec: 30, ...(over.budget || {}) } });
const run = (dir, over = {}, extra = {}) => verify({ root: dir, featureId: 'F9', base: 'main', config: cfg(over), ...extra });
const worktreeCount = (dir) => git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;

// ---------- AC-1 ----------
test('F3 AC-1: commands run in order, any failure fails, exit code recorded per command', async () => {
  const dir = fixture();
  const r = await run(dir, { verify: { commands: ['node scripts/log.mjs first', 'node scripts/fail.mjs', 'node scripts/log.mjs third'] } });
  assert.equal(r.pass, false);
  assert.deepEqual(r.commands.map((c) => c.code), [0, 3, 0]);
  assert.deepEqual(r.commands.map((c) => c.pass), [true, false, true]);
  assert.equal(fs.readFileSync(path.join(dir, 'order.log'), 'utf8'), 'first\nthird\n');
});

test('F3 AC-1: all commands passing (plus integrity and criteria) passes', async () => {
  const dir = fixture();
  const r = await run(dir, { verify: { commands: ['node scripts/ok.mjs', 'node scripts/ok.mjs'] } });
  assert.equal(r.pass, true, JSON.stringify(r, null, 2));
  assert.deepEqual(r.commands.map((c) => [c.code, c.attempts, c.flaky]), [[0, 1, false], [0, 1, false]]);
});

test('F3 AC-1: CLI --json prints the full result with per-command exit codes; exit 1 on fail, 0 on pass', () => {
  const dir = fixture();
  writeFiles(dir, { '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: ['node scripts/ok.mjs', 'node scripts/fail.mjs'] } } });
  const onBase = (msg) => { // config lives on base (no .harness diff); check.mjs stays untracked
    git(dir, 'add', '.harness');
    git(dir, 'commit', '-q', '-m', msg);
    git(dir, 'branch', '-f', 'main', 'HEAD');
  };
  onBase('config on base');
  const r = harness(['verify', 'F9', '--json'], { cwd: dir });
  assert.equal(r.code, 1, r.stderr);
  const json = JSON.parse(r.stdout);
  assert.deepEqual(json.commands.map((c) => c.code), [0, 3]);
  assert.equal(json.pass, false);
  const human = harness(['verify', 'F9'], { cwd: dir });
  assert.equal(human.code, 1);
  assert.match(human.stdout, /FAIL node scripts\/fail\.mjs — exit 3/);

  writeFiles(dir, { '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: ['node scripts/ok.mjs'] } } });
  onBase('passing config on base');
  const ok = harness(['verify', 'F9'], { cwd: dir });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /: PASS/);
});

// ---------- AC-2 ----------
test('F3 AC-2: a failing command is re-run once; a different outcome is flaky and still fails', async () => {
  const dir = fixture();
  const r = await run(dir, { verify: { commands: ['node scripts/flaky.mjs'] } });
  assert.equal(r.commands[0].attempts, 2);
  assert.equal(r.commands[0].flaky, true);
  assert.equal(r.commands[0].pass, false);
  assert.equal(r.pass, false);
});

test('F3 AC-2: a consistently failing command is re-run once and is not flaky', async () => {
  const dir = fixture();
  const r = await run(dir, { verify: { commands: ['node scripts/fail.mjs'] } });
  assert.deepEqual([r.commands[0].attempts, r.commands[0].flaky, r.commands[0].pass], [2, false, false]);
});

// ---------- AC-3 ----------
for (const marker of MARKERS) {
  test(`F3 AC-3 marker ${marker}: an added line containing it fails verify`, async () => {
    const dir = fixture();
    writeFiles(dir, { 'src/a.test.js': `// ok line\n  ${marker}'x', () => {});\n` });
    commitAll(dir, 'add test');
    const r = await run(dir);
    assert.equal(r.pass, false);
    assert.deepEqual(r.integrity.markers.map((m) => [m.file, m.marker]), [['src/a.test.js', marker]]);
  });
}

test('F3 AC-3: uncommitted modifications and untracked files count as added lines', async () => {
  const dir = fixture({ files: { 'src/tracked.js': 'a\n' } });
  writeFiles(dir, { 'src/tracked.js': `a\nit${ONLY}\n`, 'src/new.js': `describe${SKIP}\n` });
  const r = await run(dir);
  assert.equal(r.pass, false);
  const found = r.integrity.markers.map((m) => `${m.file} ${m.marker}`).sort();
  assert.deepEqual(found, [`src/new.js ${SKIP}`, `src/tracked.js ${ONLY}`]);
});

test('F3 AC-3: markers match as tokens — process.exit is not x-it, list.Skip is not t-dot-Skip', () => {
  assert.equal(findMarker(m('process.ex|it(0);'), XIT), false);
  assert.equal(findMarker(m('var y = list.Sk|ip(3);'), TSKIP), false);
  assert.equal(findMarker(`${XIT}'a')`, XIT), true);
  assert.equal(findMarker(`  (${XDESCRIBE}'a'))`, XDESCRIBE), true);
  assert.equal(findMarker(m('ex|it(1); ') + `${XIT}2)`, XIT), true); // a later token occurrence still counts
  assert.equal(findMarker(`\t${TSKIP}"flaky")`, TSKIP), true);
  assert.equal(findMarker(`foo${SKIP}`, SKIP), true); // markers starting with punctuation stay substrings
});

test('F3 AC-3: markers already present on base, or on removed lines, do not fail', async () => {
  const dir = fixture({ files: { 'src/old.js': `it${SKIP}1)\n${XIT}2)\n` } });
  writeFiles(dir, { 'src/old.js': `it${SKIP}1)\n` }); // removes the x-it line
  const r = await run(dir);
  assert.deepEqual(r.integrity.markers, []);
  assert.equal(r.pass, true, JSON.stringify(r, null, 2));
});

// ---------- AC-4 ----------
for (const [label, rel, content] of [
  ['config.json', '.harness/config.json', { profile: 'sdlc', verify: { commands: [] } }],
  ['contracts/**', '.harness/contracts/F9.json', contract({ acceptance_criteria: [{ id: 'AC-1', criterion: 'x', check: 'node scripts/ok.mjs', new: false }] })],
  ['verdicts/**', '.harness/verdicts/F9-r1.json', { verdict: 'pass' }],
]) {
  test(`F3 AC-4: a diff touching .harness/${label} fails`, async () => {
    const dir = fixture();
    writeFiles(dir, { [rel]: content });
    const r = await run(dir);
    assert.equal(r.pass, false);
    assert.deepEqual(r.integrity.harnessPaths, [rel]);
  });
}

test('F3 AC-4: committed and deleted .harness paths are caught too', async () => {
  const dir = fixture();
  fs.rmSync(path.join(dir, '.harness', 'config.json'));
  commitAll(dir, 'delete config');
  const r = await run(dir);
  assert.equal(r.pass, false);
  assert.deepEqual(r.integrity.harnessPaths, ['.harness/config.json']);
});

test('F6 SC-2: a builder diff that changes .harness/ state (features.json status) fails verify', async () => {
  const dir = fixture();
  writeFiles(dir, { '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'passed', depends_on: [] }] } });
  commitAll(dir, 'builder marks itself passed');
  const r = await run(dir);
  assert.equal(r.pass, false);
  assert.deepEqual(r.integrity.harnessPaths, ['.harness/features.json']);
});

// ---------- AC-5 ----------
test('F3 AC-5: test_count below base fails; the base worktree is removed afterwards', async () => {
  const dir = fixture({ files: { 'count.txt': '5\n' } });
  writeFiles(dir, { 'count.txt': '4\n' });
  const r = await run(dir, { verify: { commands: [], test_count: 'node scripts/count.mjs' } });
  assert.deepEqual(r.integrity.testCount, { base: 5, head: 4, status: 'decreased' });
  assert.equal(r.pass, false);
  assert.equal(worktreeCount(dir), 1);
});

test('F3 AC-5: test_count equal or above base passes', async () => {
  const dir = fixture({ files: { 'count.txt': '5\n' } });
  writeFiles(dir, { 'count.txt': '6\n' });
  const r = await run(dir, { verify: { commands: [], test_count: 'node scripts/count.mjs' } });
  assert.deepEqual(r.integrity.testCount, { base: 5, head: 6, status: 'ok' });
  assert.equal(r.pass, true, JSON.stringify(r, null, 2));
});

test('F3 AC-5: test_count unset is a warning only', async () => {
  const dir = fixture();
  const r = await run(dir);
  assert.equal(r.integrity.testCount.status, 'unset');
  assert.ok(r.warnings.some((w) => /test_count/.test(w)));
  assert.equal(r.pass, true, JSON.stringify(r, null, 2));
});

test('F3 AC-5: a test_count command that prints no integer fails', async () => {
  const dir = fixture();
  const r = await run(dir, { verify: { commands: [], test_count: 'node scripts/ok.mjs' } });
  assert.equal(r.integrity.testCount.status, 'error');
  assert.equal(r.pass, false);
});

// ---------- AC-6 ----------
test('F3 AC-6: each check is recorded per criterion; a new check passing on base is vacuous and fails', async () => {
  const dir = fixture({
    contract: contract({
      acceptance_criteria: [
        { id: 'AC-1', criterion: 'check exists', check: 'node check.mjs', new: true },
        { id: 'AC-2', criterion: 'always true', check: 'node scripts/ok.mjs', new: true },
        { id: 'AC-3', criterion: 'regression guard', check: 'node scripts/ok.mjs', new: false },
        { id: 'AC-4', criterion: 'broken', check: 'node scripts/fail.mjs', new: true },
      ],
      security_criteria: [{ id: 'SC-1', criterion: 'cases', cases: [{ id: 'a', check: 'node check.mjs' }, { check: 'node scripts/ok.mjs' }] }],
    }),
  });
  const r = await run(dir);
  const byId = Object.fromEntries(r.criteria.map((c) => [c.id, [c.pass, c.vacuous]]));
  assert.deepEqual(byId, {
    'AC-1': [true, false],
    'AC-2': [false, true],
    'AC-3': [true, false],
    'AC-4': [false, false],
    'SC-1#a': [true, false],
    'SC-1#2': [false, true],
  });
  assert.equal(r.pass, false);
  assert.equal(worktreeCount(dir), 1);
});

test('F3 AC-6: a contract with no checks fails instead of passing vacuously', async () => {
  const dir = fixture({ contract: contract({ acceptance_criteria: [] }) });
  const r = await run(dir);
  assert.equal(r.pass, false);
});

// ---------- SC-1 ----------
test('F3 SC-1: commands run with cwd = the verified worktree, contracts are read from root', async () => {
  const dir = fixture();
  const wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-wt-')));
  fs.rmSync(wt, { recursive: true });
  git(dir, 'worktree', 'add', '-q', '-b', 'other', wt, 'feature');
  try {
    writeFiles(wt, { 'check.mjs': 'process.exit(0);\n' });
    const out = path.join(wt, 'cwd.txt');
    const r = await run(dir, { verify: { commands: [`node scripts/cwd.mjs ${JSON.stringify(out)}`] } }, { cwd: wt });
    assert.equal(fs.realpathSync(fs.readFileSync(out, 'utf8')), wt);
    assert.equal(r.criteria[0].pass, true);
    assert.equal(fs.existsSync(path.join(dir, 'cwd.txt')), false);
  } finally {
    git(dir, 'worktree', 'remove', '--force', wt);
  }
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

test('F3 SC-1: a command past the timeout is killed together with its grandchild', async () => {
  const dir = fixture();
  const pids = path.join(dir, 'pids.txt');
  const t0 = Date.now();
  const r = await run(dir, { budget: { step_timeout_sec: 1 }, verify: { commands: [`node scripts/slow.mjs ${JSON.stringify(pids)}`] } });
  const elapsed = Date.now() - t0;
  assert.equal(r.commands[0].pass, false);
  assert.equal(r.commands[0].timedOut, true);
  assert.match(r.commands[0].message, /timed out/);
  assert.ok(elapsed < 15000, `took ${elapsed}ms`);
  const gcs = fs.readFileSync(pids, 'utf8').trim().split('\n').map(Number);
  assert.equal(gcs.length, 2); // original run + one re-run
  const deadline = Date.now() + 3000;
  while (gcs.some(alive) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(gcs.filter(alive), [], 'grandchild survived the timeout');
});

// ---------- SC-2 ----------
test('F3 SC-2: injected secrets are not visible to verify commands, test_count or criterion checks', async () => {
  const secrets = { ANTHROPIC_API_KEY: 'sk-ant-test', GITHUB_TOKEN: 'ghp_test', FOO_SECRET: 'shh', HARNESS_TEST_ALLOWED: 'yes' };
  const saved = Object.fromEntries(Object.keys(secrets).map((k) => [k, process.env[k]]));
  Object.assign(process.env, secrets);
  try {
    const dump = path.join(os.tmpdir(), `harness-env-${process.pid}-${Date.now()}.txt`);
    const cmd = `node scripts/env.mjs ${JSON.stringify(dump)}`;
    const dir = fixture({
      files: { 'count.txt': '1\n' },
      contract: contract({ acceptance_criteria: [{ id: 'AC-1', criterion: 'env', check: cmd, new: false }] }),
    });
    const r = await run(dir, { env_allowlist: ['HARNESS_TEST_ALLOWED'], verify: { commands: [cmd], test_count: `${cmd} && node scripts/count.mjs` } });
    const seen = fs.readFileSync(dump, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    fs.rmSync(dump, { force: true });
    assert.equal(seen.length, 4); // command, test_count head + base, criterion check
    for (const names of seen) {
      for (const k of ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'FOO_SECRET']) assert.ok(!names.includes(k), `${k} leaked`);
      assert.ok(names.includes('HARNESS_TEST_ALLOWED'), 'config env_allowlist not applied');
    }
    assert.equal(r.commands[0].pass, true);
    assert.equal(r.criteria[0].pass, true);
    assert.equal(r.integrity.testCount.status, 'ok');
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// ---------- SC-3 ----------
test('F3 SC-3: an empty config skip_markers list keeps all 8 default markers', async () => {
  assert.deepEqual([...DEFAULT_SKIP_MARKERS], MARKERS);
  assert.deepEqual(effectiveMarkers(cfg({ verify: { skip_markers: [] } })), MARKERS);
  const dir = fixture();
  writeFiles(dir, { 'src/all.test.js': MARKERS.map((m) => `  ${m}`).join('\n') + '\n' });
  const r = await run(dir, { verify: { commands: [], skip_markers: [] } });
  assert.deepEqual(r.integrity.markers.map((m) => m.marker).sort(), [...MARKERS].sort());
  assert.equal(r.pass, false);
});

test('F3 SC-3: config markers are added to, never replace, the defaults', async () => {
  const c = cfg({ verify: { skip_markers: ['@Flaky', '', null] } });
  assert.deepEqual(effectiveMarkers(c), [...MARKERS, '@Flaky']);
  const dir = fixture();
  writeFiles(dir, { 'src/b.test.js': `@Flaky\nit${ONLY}1)\n` });
  const r = await run(dir, { verify: { commands: [], skip_markers: ['@Flaky'] } });
  assert.deepEqual(r.integrity.markers.map((m) => m.marker).sort(), [ONLY, '@Flaky']);
});

// ---------- ES-1 ----------
test('F3 ES-1: a missing executable fails that command with a clear message, no crash', async () => {
  const dir = fixture();
  const r = await run(dir, { verify: { commands: ['harness-no-such-exe-7d1 --flag', 'node scripts/ok.mjs'] } });
  assert.equal(r.pass, false);
  assert.equal(r.commands[0].pass, false);
  assert.match(r.commands[0].message, /command not found: harness-no-such-exe-7d1/);
  assert.equal(r.commands[1].pass, true); // later commands still run
});

test('F3 ES-1: a missing executable in a criterion check fails that criterion, no crash', async () => {
  const dir = fixture({ contract: contract({ acceptance_criteria: [{ id: 'AC-1', criterion: 'x', check: 'harness-no-such-exe-7d1', new: true }] }) });
  const r = await run(dir);
  assert.equal(r.criteria[0].pass, false);
  assert.match(r.criteria[0].message, /command not found/);
});

// ---------- ES-2 ----------
test('F3 ES-2: a missing base ref exits 2 with the cause', async () => {
  const dir = fixture();
  await assert.rejects(run(dir, {}, { base: 'no-such-branch' }),
    (e) => e instanceof HarnessError && e.exit === 2 && /base ref 'no-such-branch' not found/.test(e.message));
  const r = harness(['verify', 'F9', '--base', 'no-such-branch'], { cwd: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /base ref 'no-such-branch' not found/);
  assert.equal(r.stdout, '');
});

test('F3 ES-2: base_branch from config is the default and a missing one also exits 2', () => {
  const dir = fixture();
  git(dir, 'branch', '-m', 'main', 'trunk');
  const r = harness(['verify', 'F9'], { cwd: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /base ref 'main' not found/);
});
