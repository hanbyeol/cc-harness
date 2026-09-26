// F35: a base vacuity run that did not pass while other runs were active is re-run alone;
// a failed base `worktree add` removes only the temp directory; merge recoveries check the
// integration ref before merging; the test-count cache never enters the builder commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpdir } from './helpers.mjs';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { HarnessError } from '../lib/errors.mjs';
import { verify } from '../lib/verify.mjs';
import * as run from '../lib/run.mjs';
import init from '../lib/commands/init.mjs';

// ------------------------------------------------------------------ verify fixtures

const CONTRACT = (criteria) => ({
  id: 'F9', title: 'fixture', security_tier: 'standard', version: 1,
  acceptance_criteria: criteria.map(({ id, check, isNew = true }) => ({ id, criterion: id, check, new: isNew })),
  security_criteria: [], error_scenarios: [], out_of_scope: [],
});

// usage: node scripts/check.mjs <log> <id> <alone>
// Head (.git is a directory): exits 0. Base, AC-1: fails as soon as another run of the log is
// active (polling up to 3 s); alone it passes ('pass') or hangs ('hang', 8 s). Base, any other
// id: waits (up to 10 s) until AC-1 saw it, then fails. Runs are paired by a generated token.
const CHECK_SCRIPT = `import fs from 'node:fs';
const [log, id, alone] = process.argv.slice(2);
const side = fs.statSync('.git').isDirectory() ? 'head' : 'base';
const token = id + '-' + side + '-' + process.pid + '-' + Date.now() + '-' + Math.random();
const write = (ev) => fs.appendFileSync(log, JSON.stringify({ ...ev, id, side, token, t: Date.now() }) + '\\n');
const events = () => fs.readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).map((l) => JSON.parse(l));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (code) => { write({ ev: 'end', code }); process.exit(code); };
write({ ev: 'start' });
if (side === 'head') done(0);
if (id === 'AC-1') {
  for (let t = 0; t < 3000; t += 50) {
    const ev = events();
    const ended = new Set(ev.filter((e) => e.ev === 'end').map((e) => e.token));
    if (ev.some((e) => e.ev === 'start' && e.token !== token && !ended.has(e.token))) { write({ ev: 'saw' }); done(1); }
    await sleep(50);
  }
  if (alone === 'hang') await sleep(8000);
  done(alone === 'hang' ? 1 : 0);
} else {
  for (let t = 0; t < 10000 && !events().some((e) => e.ev === 'saw'); t += 50) await sleep(50);
  done(1);
}
`;

function vacuityFixture(log, alone = 'pass') {
  const check = (id) => `node scripts/check.mjs ${JSON.stringify(log)} ${id} ${alone}`;
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': CONTRACT([{ id: 'AC-1', check: check('AC-1') }, { id: 'AC-2', check: check('AC-2') }]),
    '.harness/backlog.json': { items: [] },
    'scripts/check.mjs': CHECK_SCRIPT,
  });
  writeFiles(dir, { 'marker.txt': 'feature\n' });
  commitAll(dir, 'feature');
  return dir;
}

const logFile = () => path.join(fs.realpathSync(tmpdir('harness-f35-log-')), 'log.jsonl');
const events = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const cfg = (verifyExtra = {}, budget = { step_timeout_sec: 60 }) => resolveConfig({ base_branch: 'main', verify: { commands: [], ...verifyExtra }, budget });
const runVerify = (dir, config) => verify({ root: dir, featureId: 'F9', base: 'main', config, cpus: 16 });
const byId = (r) => Object.fromEntries(r.criteria.map((c) => [c.id, c]));
const baseStarts = (log, id) => events(log).filter((e) => e.ev === 'start' && e.side === 'base' && e.id === id);

// ------------------------------------------------------------------ AC-1
test('F35 AC-1: a base run that fails only while others run is re-run alone after them and judged vacuous with base_retry', async () => {
  const log = logFile();
  const dir = vacuityFixture(log, 'pass');
  const r = await runVerify(dir, cfg({ check_parallel: 2 }));
  const c = byId(r)['AC-1'];
  assert.equal(c.vacuous, true, JSON.stringify(r.criteria));
  assert.equal(c.pass, false);
  assert.equal(c.base_retry, true);
  assert.match(c.message, /vacuous/);
  assert.equal(r.pass, false);
  const starts = baseStarts(log, 'AC-1');
  assert.equal(starts.length, 2, 'ran on base once concurrently and once alone');
  // The solo run starts after every run that started before it has ended.
  const ev = events(log);
  const solo = starts[1];
  const earlier = new Set(ev.filter((x) => x.ev === 'start' && x.token !== solo.token && x.t <= solo.t).map((x) => x.token));
  for (const e of ev.filter((x) => x.ev === 'end' && earlier.has(x.token))) {
    assert.ok(e.t <= solo.t, `${e.id}/${e.side} ended after the solo base run started`);
  }
  assert.ok(events(log).some((e) => e.ev === 'saw'), 'fixture: the concurrent base run saw another run');
});

test('F35 AC-1: a criterion whose base run fails again alone stays non-vacuous with base_retry', async () => {
  const log = logFile();
  const dir = vacuityFixture(log, 'pass');
  const r = await runVerify(dir, cfg({ check_parallel: 2 }));
  const c = byId(r)['AC-2'];
  assert.equal(c.vacuous, false, JSON.stringify(c));
  assert.equal(c.pass, true);
  assert.equal(c.base_retry, true);
  assert.equal(baseStarts(log, 'AC-2').length, 2);
});

// ------------------------------------------------------------------ AC-2
test('F35 AC-2: check_parallel 1 runs each base check once and records no base_retry; the same fixture at 2 re-runs', async () => {
  const log1 = logFile();
  const r1 = await runVerify(vacuityFixture(log1, 'pass'), cfg({ check_parallel: 1 }));
  for (const id of ['AC-1', 'AC-2']) {
    assert.equal(baseStarts(log1, id).length, 1, `${id} ran once on base`);
    assert.equal(byId(r1)[id].base_retry, undefined);
  }
  const log2 = logFile();
  const r2 = await runVerify(vacuityFixture(log2, 'pass'), cfg({ check_parallel: 2 }));
  assert.equal(baseStarts(log2, 'AC-1').length, 2, 'at check_parallel 2 the failed concurrent base run is re-run');
  assert.equal(byId(r2)['AC-1'].base_retry, true);
});

// ------------------------------------------------------------------ ES-1
test('F35 ES-1: a solo base re-run that times out is not vacuous and records base_timed_out', async () => {
  const log = logFile();
  const dir = vacuityFixture(log, 'hang');
  const r = await runVerify(dir, cfg({ check_parallel: 2, vacuity_timeout_sec: 5 }, { step_timeout_sec: 60 }));
  const c = byId(r)['AC-1'];
  assert.equal(c.base_retry, true, JSON.stringify(c));
  assert.equal(c.base_timed_out, true);
  assert.equal(c.vacuous, false);
  assert.equal(c.pass, true);
  assert.equal(baseStarts(log, 'AC-1').length, 2);
  const first = events(log).find((e) => e.ev === 'end' && e.side === 'base' && e.id === 'AC-1');
  assert.equal(first?.code, 1, 'fixture: the concurrent base run failed rather than timed out');
});

// ------------------------------------------------------------------ AC-3
const POSIX = process.platform !== 'win32'; // the fake git is a shebang script
const REAL_GIT = spawnSync(POSIX ? 'which' : 'where', ['git'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim();
const pathKey = () => Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

// A fake `git` that logs every call's arguments and fails `worktree add` with a fixed message.
function failingAddGit(calls) {
  const dir = fs.realpathSync(tmpdir('harness-f35-git-'));
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
case " $* " in *" worktree add "*) echo "fatal: simulated worktree add failure" >&2; exit 128 ;; esac
exec "${REAL_GIT}" "$@"
`);
  fs.chmodSync(path.join(dir, 'git'), 0o755);
  return dir;
}

test('F35 AC-3: a failed base worktree add removes only the temp directory and ends with the git error', async () => {
  if (!POSIX) return; // the fake git is a shebang script
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': CONTRACT([{ id: 'AC-1', check: 'node -e "process.exit(require(\'fs\').existsSync(\'marker.txt\') ? 0 : 1)"' }]),
  });
  writeFiles(dir, { 'marker.txt': 'feature\n' });
  commitAll(dir, 'feature');
  const calls = path.join(fs.realpathSync(tmpdir('harness-f35-calls-')), 'calls.txt');
  const bin = failingAddGit(calls);
  const key = pathKey();
  const saved = process.env[key];
  process.env[key] = `${bin}${path.delimiter}${saved}`;
  let err = null;
  try {
    await verify({ root: dir, featureId: 'F9', base: 'main', config: cfg({ check_parallel: 1 }), cpus: 1 });
  } catch (e) {
    err = e;
  } finally {
    process.env[key] = saved;
  }
  assert.ok(err instanceof HarnessError, `verify rejects with a HarnessError (got ${err})`);
  assert.equal(err.code, 'git');
  assert.match(err.message, /simulated worktree add failure/);
  const lines = fs.readFileSync(calls, 'utf8').split('\n');
  const add = lines.find((l) => / worktree add /.test(` ${l} `));
  assert.ok(add, 'worktree add was attempted');
  const tmp = add.split(' ').find((a) => path.basename(a).startsWith('harness-base-'));
  assert.ok(tmp, add);
  assert.equal(fs.existsSync(tmp), false, 'the temporary directory is removed');
  assert.ok(!lines.some((l) => / worktree remove /.test(` ${l} `)), `no worktree remove call:\n${lines.join('\n')}`);
});

// ------------------------------------------------------------------ run fixtures

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-26T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function runFixture() {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract('F1'),
    'scripts/ok.mjs': 'process.exit(0);\n',
    'shared.txt': 'original\n',
  }, { branch: null });
}

const OK_INTEGRITY = { markers: [], harnessPaths: [], testCount: { status: 'unset' } };
const PASSING = { pass: true, commands: [], criteria: [{ id: 'AC-1', pass: true }], integrity: OK_INTEGRITY, warnings: [] };
const FAILING = { pass: false, commands: [{ cmd: 'npm test', pass: false, message: 'exit 1', output: 'boom' }], criteria: [{ id: 'AC-1', pass: true }], integrity: OK_INTEGRITY, warnings: [] };
const isIntegration = (cwd) => fs.realpathSync.native(cwd).endsWith(`${path.sep}_integration`);
const evaluate = async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });
const runCfg = () => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 } });
const INTEG_REF = 'refs/heads/harness/integration^{commit}';

// Records every core git call; once `trigger(args, result)` has matched, the integration
// ref no longer resolves (as if the branch were deleted meanwhile).
function refGit(trigger) {
  const calls = [];
  let broken = false;
  const fn = async (args, cwd, opts) => {
    calls.push({ args: [...args], broken });
    if (broken && args[0] === 'rev-parse' && args.includes(INTEG_REF)) return { code: 1, signal: null, stdout: '', stderr: '', timedOut: false, error: null };
    const r = await run.git(args, cwd, opts);
    if (!broken && trigger(args, r)) broken = true;
    return r;
  };
  fn.calls = calls;
  return fn;
}

// scenario 'conflict': F1 and integration both change shared.txt → conflict resolution.
// scenario 'recover': the post-merge verify fails → post-merge verify recovery.
async function refScenario(scenario) {
  const dir = runFixture();
  const intWt = path.join(dir, '.harness', 'wt', '_integration');
  const g = scenario === 'conflict'
    ? refGit((args, r) => args[0] === 'merge' && args.includes('harness/F1') && r.code !== 0)
    : refGit((args) => args[0] === 'reset' && args.includes('--hard'));
  const builds = [];
  const build = async (a) => {
    builds.push(a);
    writeFiles(a.cwd, { 'F1.txt': 'built\n', 'shared.txt': 'changed by F1\n' });
    if (scenario === 'conflict') {
      writeFiles(intWt, { 'shared.txt': 'changed on integration\n' });
      commitAll(intWt, 'meanwhile on integration');
    }
    return { ok: true, costUsd: 0 };
  };
  const verifyFn = async (a) => (isIntegration(a.cwd) ? FAILING : PASSING);
  const r = await run.runFeatures({ root: dir, config: runCfg(), deps: { build, verify: verifyFn, evaluate, git: g, cpus: 8 } });
  return { dir, r, g, builds, f1: r.results.find((x) => x.feature === 'F1') };
}

for (const scenario of ['conflict', 'recover']) {
  test(`F35 AC-4: an unresolvable integration ref before the ${scenario === 'conflict' ? 'conflict resolution' : 'post-merge recovery'} → blocked(merge_conflict) naming the branch, no git merge`, async () => {
    const { r, g, builds, f1 } = await refScenario(scenario);
    assert.ok(g.calls.some((c) => c.broken), 'fixture: the integration ref stopped resolving');
    assert.equal(f1?.status, 'blocked', JSON.stringify(r.results));
    assert.equal(f1.reason, 'merge_conflict');
    assert.match(f1.detail, /harness\/integration/);
    const merges = g.calls.filter((c) => c.broken && c.args[0] === 'merge' && !c.args.includes('--abort'));
    assert.deepEqual(merges.map((c) => c.args), [], 'no git merge after the ref stopped resolving');
    assert.equal(builds.length, 1, 'no recovery builder call');
  });

  test(`F35 SC-1: no null, undefined or empty argument reaches git when the integration ref is unresolvable (${scenario})`, async () => {
    const { g } = await refScenario(scenario);
    assert.ok(g.calls.some((c) => c.broken), 'fixture: the integration ref stopped resolving');
    for (const { args } of g.calls) {
      for (const a of args) {
        assert.ok(typeof a === 'string' && a !== '' && a !== 'null' && a !== 'undefined', `bad git argument ${JSON.stringify(a)} in ${JSON.stringify(args)}`);
      }
    }
  });
}

// ------------------------------------------------------------------ AC-5
test('F35 AC-5: the builder-changes commit leaves out .harness/runs/test-count-cache.json', async () => {
  const dir = runFixture();
  const build = async (a) => {
    // The builder ran verify in its worktree, which wrote the test-count cache.
    writeFiles(a.cwd, { 'F1.txt': 'built\n', '.harness/runs/test-count-cache.json': { entries: [{ base: 'x', command: 'y', rule: 'preset', count: 1 }] } });
    return { ok: true, costUsd: 0 };
  };
  const r = await run.runFeatures({ root: dir, config: runCfg(), deps: { build, verify: async () => PASSING, evaluate, cpus: 8 } });
  assert.equal(r.results.find((x) => x.feature === 'F1')?.status, 'passed', JSON.stringify(r.results));
  const sha = git(dir, 'log', '--all', '--format=%H', '--grep=^harness: F1 round 1 builder changes$');
  assert.ok(sha, 'the builder changes were committed');
  const files = git(dir, 'show', '--name-only', '--format=', sha.split('\n')[0]).split('\n');
  assert.ok(files.includes('F1.txt'), files.join(','));
  assert.ok(!files.includes('.harness/runs/test-count-cache.json'), `cache committed: ${files.join(',')}`);
  assert.throws(() => git(dir, 'cat-file', '-e', 'harness/integration:.harness/runs/test-count-cache.json'));
});

test('F35 AC-5: harness init writes runs/test-count-cache.json into .harness/.gitignore', async () => {
  const root = fs.realpathSync(tmpdir('harness-f35-init-'));
  await init({ root, out: () => {} });
  const lines = fs.readFileSync(path.join(root, '.harness', '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(lines.includes('runs/test-count-cache.json'), lines.join('|'));
  // The entry actually ignores the cache file.
  spawnSync('git', ['init', '-q'], { cwd: root });
  writeFiles(root, { '.harness/runs/test-count-cache.json': '{}' });
  assert.equal(spawnSync('git', ['check-ignore', '-q', '.harness/runs/test-count-cache.json'], { cwd: root }).status, 0);
});

// ------------------------------------------------------------------ AC-6
const SPEC = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
const between = (from, to) => SPEC.slice(SPEC.indexOf(from), SPEC.indexOf(to));

test('F35 AC-6: SPEC §6.3 describes the solo base re-run', () => {
  const s63 = between('\n### 6.3 ', '\n## 7. ');
  for (const s of ['base 단독 재확인', '혼자 한 번 더', 'base_retry', 'base_timed_out', 'check_parallel` 이 1 이면']) {
    assert.ok(s63.includes(s), `§6.3 mentions ${s}`);
  }
});

test('F35 AC-6: SPEC §8 describes the integration ref check before a merge recovery', () => {
  const s8 = between('\n## 8. ', '\n## 9. ');
  for (const s of ['integration 참조 확인', 'refs/heads/<integration_branch>', '`git merge` 를 호출하지 않고', 'blocked(`merge_conflict`)', 'test-count-cache.json']) {
    assert.ok(s8.includes(s), `§8 mentions ${s}`);
  }
});
