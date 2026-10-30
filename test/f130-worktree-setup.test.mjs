import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BIN, REPO, tmpdir } from './helpers.mjs';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { readEvents } from '../lib/events.mjs';
import { runFeatures } from '../lib/run.mjs';

const FAKE_CLI = path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs');
const real = (p) => fs.realpathSync.native(p);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ fixtures

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-18T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

// A setup script (committed in the project directory) that appends {s: name, cwd} to `log`,
// then runs `tail` (JS source) — which may call process.exit.
const script = (log, name, tail = '') => [
  "import fs from 'node:fs';",
  `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ s: ${JSON.stringify(name)}, cwd: fs.realpathSync.native(process.cwd()) }) + '\\n');`,
  tail,
].join('\n');

/**
 * A repository whose project (`prefix`, '' = the top level) has features `ids`, setup scripts s1/s2 and
 * a config for the CLI (generic builder that records its call in `marker`). `scripts` adds files.
 */
function fixture({ ids = ['F1'], prefix = '', setup = [], scripts = {}, config = {} } = {}) {
  // .native: on Windows only the native realpath expands an 8.3 short temp path, as the scripts do.
  const tmp = fs.realpathSync.native(tmpdir('f130-'));
  const log = path.join(tmp, 'setup.log');
  const marker = path.join(tmp, 'builder.called');
  const builder = path.join(tmp, 'builder.mjs');
  fs.writeFileSync(builder, `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(marker)}, 'called\\n');\nprocess.exit(1);\n`);
  const at = (p) => (prefix ? `${prefix}/${p}` : p);
  const files = {
    [at('.harness/config.json')]: {
      profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, run: { worktree_setup: setup, max_parallel: 1 },
      roles: { builder: 'generic', evaluator: 'generic', 'security-reviewer': 'generic' },
      adapters: { generic: { command: [process.execPath, builder], read_only_command: [process.execPath, FAKE_CLI, 'echo-args'] } },
      ...config,
    },
    [at('.harness/backlog.json')]: { items: [] },
    [at('.harness/.gitignore')]: 'wt/\n*.tmp-*\n',
    [at('.harness/features.json')]: { features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: 'standard', depends_on: [], status: 'approved' })) },
    [at('scripts/ok.mjs')]: 'process.exit(0);\n',
    [at('s1.mjs')]: script(log, 's1'),
    [at('s2.mjs')]: script(log, 's2'),
    'top.txt': 'x\n',
  };
  for (const id of ids) files[at(`.harness/contracts/${id}.json`)] = contract(id);
  for (const [name, content] of Object.entries(scripts)) files[at(name)] = typeof content === 'function' ? content(log) : content;
  // The native real path, as the setup scripts log it (a Windows 8.3 temp path expands).
  const dir = fs.realpathSync.native(gitRepo(files, { branch: null }));
  const root = prefix ? path.join(dir, prefix) : dir;
  return { dir, root, log, marker, tmp, prefix, setup };
}

const logLines = (f) => (fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const wtDir = (f, name) => path.join(f.root, '.harness', 'wt', name);
const projectIn = (f, wt) => path.join(wt, f.prefix);
// f.dir is a realpath, so the expected cwd needs none (a merged feature's worktree is gone by then).
const cwdIn = (f, name) => projectIn(f, wtDir(f, name));

const PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const evalPass = async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });

// Fake builder: records its call in the setup log (so the order against the setup is visible).
function fakeBuild(f, over) {
  const calls = [];
  const fn = async (a) => {
    calls.push(a);
    fs.appendFileSync(f.log, `${JSON.stringify({ s: 'build', feature: a.featureId, cwd: real(a.cwd), carriedWork: a.carriedWork ?? null })}\n`);
    if (over) return over(a);
    writeFiles(a.cwd, { [`${a.featureId}.txt`]: 'built\n' });
    return { ok: true, costUsd: 0 };
  };
  fn.calls = calls;
  return fn;
}

const cfgOf = (f, over = {}) => resolveConfig({
  base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 },
  run: { worktree_setup: f.setup, max_parallel: 1 }, ...over,
});

function run(f, deps = {}, { config, ...opts } = {}) {
  const logs = [];
  const warns = [];
  return runFeatures({
    root: f.root, config: config ?? cfgOf(f),
    deps: { verify: async () => PASSING, evaluate: evalPass, log: (m) => logs.push(m), warn: (m) => warns.push(m), ...deps },
    ...opts,
  }).then((r) => ({ ...r, logs, warns }));
}

function cli(f, args = ['run'], env = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: f.root, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 };
}

const statusOf = (f, id = 'F1') => readJson(path.join(f.root, '.harness/features.json')).features.find((x) => x.id === id).status;
const statePath = (f) => path.join(f.root, '.harness/runs/current.json');
const setupEvents = (f) => readEvents(f.root).events.filter((e) => e.stage === 'build' && e.type === 'worktree_setup');
const branches = (f) => git(f.dir, 'branch', '--list', 'harness/F*').split('\n').map((s) => s.replace(/^[*+ ]+/, '')).filter(Boolean);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ------------------------------------------------------------------ AC-1
test('F130 AC-1 the setup commands run in order, once, in <wt>/F1 before the first build', async () => {
  const f = fixture({ setup: ['node s1.mjs', 'node s2.mjs'] });
  const build = fakeBuild(f);
  const r = await run(f, { build });
  assert.equal(r.results[0].status, 'passed', r.logs.join('\n'));
  const lines = logLines(f);
  const f1 = lines.filter((l) => l.cwd === cwdIn(f, 'F1'));
  assert.deepEqual(f1.map((l) => l.s), ['s1', 's2', 'build'], 'both commands once, in order, then the build');
});

// ------------------------------------------------------------------ AC-2
test('F130 AC-2 integration is set up once before the first merge; each feature worktree once (3 runs in all)', async () => {
  const f = fixture({ ids: ['F1', 'F2'], setup: ['node s1.mjs'] });
  const r = await run(f, { build: fakeBuild(f) });
  assert.deepEqual(r.results.map((x) => x.status), ['passed', 'passed'], r.logs.join('\n'));
  const lines = logLines(f);
  const setups = lines.filter((l) => l.s === 's1');
  assert.equal(setups.length, 3);
  const where = (l) => path.basename(l.cwd);
  assert.deepEqual(setups.map(where).sort(), ['F1', 'F2', '_integration']);
  assert.equal(where(setups[0]), '_integration', 'the integration worktree is set up before any feature work');
  assert.ok(lines.findIndex((l) => l.s === 'build') > lines.findIndex((l) => l.s === 's1'), 'and before the first build');
});

// ------------------------------------------------------------------ AC-3
test('F130 AC-3 in pkg/app the commands run in <wt>/F1/pkg/app and <wt>/_integration/pkg/app', async () => {
  const f = fixture({ prefix: 'pkg/app', setup: ['node s1.mjs'] });
  const r = await run(f, { build: fakeBuild(f) });
  assert.equal(r.results[0].status, 'passed', r.logs.join('\n'));
  const cwds = logLines(f).filter((l) => l.s === 's1').map((l) => l.cwd);
  assert.deepEqual(cwds.sort(), [cwdIn(f, '_integration'), cwdIn(f, 'F1')].sort());
  assert.ok(cwds.some((c) => c.split(path.sep).join('/').endsWith('/F1/pkg/app')));
  assert.ok(cwds.some((c) => c.split(path.sep).join('/').endsWith('/_integration/pkg/app')));
});

// ------------------------------------------------------------------ AC-4
const ENV_FAIL = { pass: false, commands: [{ cmd: 'tool-x', pass: false, notFound: 'tool-x', message: 'not found', output: '' }], criteria: [], integrity: PASSING.integrity, warnings: [] };

test('F130 AC-4 resume after a verify environment stop does not set the worktrees up again', async () => {
  const f = fixture({ setup: ['node s1.mjs'] });
  const build = fakeBuild(f);
  const r1 = await run(f, { build, verify: async () => ENV_FAIL });
  assert.ok(r1.environment, JSON.stringify(r1.results));
  assert.equal(logLines(f).filter((l) => l.s === 's1').length, 2, 'integration and F1 once each');
  const r2 = await run(f, { build, verify: async () => PASSING }, { resume: true });
  assert.equal(r2.results[0].status, 'passed', r2.logs.join('\n'));
  assert.equal(logLines(f).filter((l) => l.s === 's1').length, 2, 'resume ran no setup');
});

test('F130 AC-4 a blocked feature worktree from an earlier run is taken over without a setup', async () => {
  const f = fixture({ setup: ['node s1.mjs'] });
  // The leftover of an earlier run: harness/F1 with committed work, in .harness/wt/F1.
  git(f.dir, 'branch', 'harness/integration', 'main');
  git(f.dir, 'worktree', 'add', '-b', 'harness/F1', wtDir(f, 'F1'), 'harness/integration');
  writeFiles(wtDir(f, 'F1'), { 'F1.txt': 'earlier\n' });
  commitAll(wtDir(f, 'F1'), 'earlier work');
  const build = fakeBuild(f);
  const r = await run(f, { build });
  assert.equal(r.results[0].status, 'passed', r.logs.join('\n'));
  const cwds = logLines(f).filter((l) => l.s === 's1').map((l) => path.basename(l.cwd));
  assert.deepEqual(cwds, ['_integration'], 'only the newly created integration worktree was set up');
  assert.ok(build.calls[0].carriedWork, 'the feature worktree was taken over');
});

// ------------------------------------------------------------------ AC-5
test('F130 AC-5 each setup records build/worktree_setup without output; the report has one line per setup', async () => {
  const f = fixture({
    setup: ['node s1.mjs', 'node out.mjs'],
    scripts: { 'out.mjs': "console.log('OUTPUT-MARKER-5');\nconsole.error('ERR-MARKER-5');\n" },
  });
  const r = await run(f, { build: fakeBuild(f) });
  assert.equal(r.results[0].status, 'passed', r.logs.join('\n'));
  const evs = setupEvents(f);
  assert.deepEqual(evs.map((e) => e.data.worktree).sort(), ['F1', 'integration']);
  for (const e of evs) {
    assert.deepEqual(Object.keys(e.data).sort(), ['commands', 'ms', 'outcome', 'worktree']);
    assert.equal(e.data.commands, 2);
    assert.equal(e.data.outcome, 'ok');
    assert.ok(Number.isInteger(e.data.ms) && e.data.ms >= 0);
  }
  const raw = fs.readFileSync(path.join(f.root, '.harness/events', fs.readdirSync(path.join(f.root, '.harness/events'))[0]), 'utf8');
  assert.ok(!raw.includes('OUTPUT-MARKER-5') && !raw.includes('ERR-MARKER-5'));
  const report = fs.readFileSync(r.report, 'utf8');
  assert.match(report, /^- worktree setup F1: 2 commands, ok$/m);
  assert.match(report, /^- worktree setup integration: 2 commands, ok$/m);
});

test('F130 AC-5 a failed and a timed-out setup are recorded with outcome fail / timeout', () => {
  const f = fixture({ setup: ['node fail.mjs'], scripts: { 'fail.mjs': 'process.exit(3);\n' } });
  const r = cli(f);
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(setupEvents(f).map((e) => [e.data.worktree, e.data.outcome]), [['integration', 'fail']]);
  const g = fixture({ setup: ['node sleepy.mjs'], config: { budget: { step_timeout_sec: 1 } }, scripts: { 'sleepy.mjs': 'setTimeout(() => {}, 30000);\n' } });
  const r2 = cli(g);
  assert.equal(r2.code, 1, r2.stderr);
  assert.deepEqual(setupEvents(g).map((e) => e.data.outcome), ['timeout']);
});

// ------------------------------------------------------------------ AC-6
test('F130 AC-6 without run.worktree_setup (absent or []) there is no setup step, event or report line', async () => {
  for (const setup of [undefined, []]) {
    const f = fixture({ setup: [] });
    const config = setup === undefined
      ? resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, run: { max_parallel: 1 } })
      : cfgOf(f);
    const r = await run(f, { build: fakeBuild(f) }, { config });
    assert.equal(r.results[0].status, 'passed', r.logs.join('\n'));
    assert.deepEqual(logLines(f).map((l) => l.s), ['build']);
    assert.deepEqual(setupEvents(f), []);
    assert.ok(!/worktree setup/.test(fs.readFileSync(r.report, 'utf8')));
  }
  assert.deepEqual(resolveConfig({}).run.worktree_setup, []);
});

// ------------------------------------------------------------------ AC-7
test('F130 AC-7 SPEC §4 lists run.worktree_setup and §8 describes the setup', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs/SPEC.md'), 'utf8');
  const row = spec.split('\n').find((l) => l.startsWith('| `config.json`'));
  assert.ok(row.includes('run.worktree_setup') && row.includes('[]'), '§4 config row');
  const s8 = spec.slice(spec.indexOf('## 8. 자율 실행'), spec.indexOf('## 9. 보안 요구사항'));
  const para = s8.split('\n').find((l) => l.includes('**worktree 준비**'));
  assert.ok(para, '§8 has a worktree 준비 paragraph');
  for (const w of ['run.worktree_setup', '프로젝트 디렉터리', 'SR-2', 'step_timeout_sec', '환경 실패', '--resume', '.gitignore', 'integration']) {
    assert.ok(para.includes(w), `§8 mentions ${w}`);
  }
});

// ------------------------------------------------------------------ SC-1
test('F130 SC-1 the setup sees env_allowlist variables and nothing else of the harness environment', async () => {
  const f = fixture({ setup: ['node dumpenv.mjs'] });
  const out = path.join(f.tmp, 'env.json');
  writeFiles(f.root, { 'dumpenv.mjs': `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env));\n` });
  commitAll(f.dir, 'dumpenv');
  const saved = { s: process.env.F130_SECRET, o: process.env.F130_OK };
  process.env.F130_SECRET = 'sEcRet-012345678';
  process.env.F130_OK = 'allowed-value';
  try {
    assert.equal(process.env.F130_SECRET.length, 16);
    const r = await run(f, { build: fakeBuild(f) }, { config: cfgOf(f, { env_allowlist: ['F130_OK'] }) });
    assert.equal(r.results[0].status, 'passed', r.logs.join('\n'));
  } finally {
    for (const [k, v] of [['F130_SECRET', saved.s], ['F130_OK', saved.o]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  const seen = readJson(out);
  assert.equal(seen.F130_OK, 'allowed-value');
  assert.ok(!('F130_SECRET' in seen));
  assert.ok(!JSON.stringify(seen).includes('sEcRet-012345678'));
});

// ------------------------------------------------------------------ SC-2
test('F130 SC-2 a secret a failing setup prints is redacted in stderr, the state file and the events', () => {
  const value = 'Zq8-leak-val-16c';
  assert.equal(value.length, 16);
  const f = fixture({ setup: ['node leak.mjs'], scripts: { 'leak.mjs': "import fs from 'node:fs';\nconsole.log('token=' + fs.readFileSync('secret.txt', 'utf8').trim());\nprocess.exit(1);\n", 'secret.txt': `${value}\n` } });
  const r = cli(f, ['run'], { F130_LEAK: value });
  assert.equal(r.code, 1, r.stderr);
  assert.ok(r.stderr.includes('[redacted]'), r.stderr);
  assert.ok(!r.stderr.includes(value) && !r.stdout.includes(value));
  assert.ok(fs.existsSync(statePath(f)), 'the run is resumable');
  assert.ok(!fs.readFileSync(statePath(f), 'utf8').includes(value));
  const evDir = path.join(f.root, '.harness/events');
  for (const n of fs.readdirSync(evDir)) assert.ok(!fs.readFileSync(path.join(evDir, n), 'utf8').includes(value));
});

// ------------------------------------------------------------------ SC-3
test('F130 SC-3 a setup that leaves a non-ignored file or a tracked change stops the run before any build', () => {
  const cases = [
    ['a copied .env', { 'mk.mjs': "import fs from 'node:fs';\nfs.writeFileSync('.env', 'A=1\\n');\n" }, '.env'],
    ['a changed tracked file', { 'mk.mjs': "import fs from 'node:fs';\nfs.appendFileSync('top.txt', 'more\\n');\n" }, 'top.txt'],
  ];
  for (const [what, scripts, shown] of cases) {
    const f = fixture({ setup: ['node mk.mjs'], scripts });
    const r = cli(f);
    assert.equal(r.code, 1, `${what}: ${r.stderr}`);
    assert.ok(r.stderr.includes(shown) && r.stderr.includes('.gitignore'), `${what}: ${r.stderr}`);
    assert.ok(!fs.existsSync(f.marker), `${what}: the builder was not called`);
    assert.equal(git(f.dir, 'rev-parse', 'harness/integration'), git(f.dir, 'rev-parse', 'main'));
  }
});

test('F130 SC-3 the feature worktree is checked too: its branch commit stays at base', () => {
  const f = fixture({
    setup: ['node feat.mjs'],
    scripts: { 'feat.mjs': "import fs from 'node:fs';\nif (process.cwd().includes('F1')) fs.writeFileSync('.env', 'A=1\\n');\n" },
  });
  const r = cli(f);
  assert.equal(r.code, 1, r.stderr);
  assert.ok(r.stderr.includes('.env') && r.stderr.includes('.gitignore'), r.stderr);
  assert.ok(!fs.existsSync(f.marker));
  assert.equal(git(f.dir, 'rev-parse', 'harness/F1'), git(f.dir, 'rev-parse', 'main'), 'no commit on harness/F1');
});

// ------------------------------------------------------------------ ES-1
test('F130 ES-1 an invalid run.worktree_setup is config_invalid (exit 2) and creates no worktree or branch', () => {
  for (const [value, key] of [['npm ci', 'run.worktree_setup'], [[''], 'run.worktree_setup[0]'], [[1], 'run.worktree_setup[0]']]) {
    const f = fixture({ setup: value });
    const r = cli(f);
    assert.equal(r.code, 2, r.stderr);
    assert.ok(r.stderr.includes('config_invalid') && r.stderr.includes(key), r.stderr);
    assert.ok(!fs.existsSync(path.join(f.root, '.harness/wt')));
    assert.deepEqual(branches(f), []);
    assert.ok(!git(f.dir, 'branch', '--list', 'harness/integration'));
  }
});

// ------------------------------------------------------------------ ES-2 / ES-3
test('F130 ES-2 a failing feature setup stops the run: no next command, no builder, the feature stays in_progress', () => {
  const f = fixture({
    ids: ['F1'], setup: ['node gate.mjs', 'node s2.mjs'],
    scripts: { 'gate.mjs': "if (process.cwd().includes('F1')) process.exit(3);\n" },
  });
  const r = cli(f);
  assert.equal(r.code, 1, r.stderr);
  for (const w of ['worktree setup failed', 'node gate.mjs', 'exit 3', 'harness run --resume']) assert.ok(r.stderr.includes(w), `${w} in ${r.stderr}`);
  assert.ok(!logLines(f).some((l) => l.s === 's2' && path.basename(l.cwd) === 'F1'), 'the next command did not run');
  assert.ok(!fs.existsSync(f.marker), 'no builder call');
  assert.equal(statusOf(f), 'in_progress');
  const e = readJson(statePath(f)).active[0];
  assert.equal(e.round, 0);
  assert.equal(e.attempt, 0);
  assert.equal(e.attemptsDone ?? 0, 0);
});

test('F130 ES-3 resume re-runs the whole setup in the same worktree, without carried work, then builds', async () => {
  const flag = path.join(tmpdir('f130-flag-'), 'fixed');
  const f = fixture({
    setup: ['node s1.mjs', 'node gate.mjs'],
    scripts: { 'gate.mjs': `import fs from 'node:fs';\nif (process.cwd().includes('F1') && !fs.existsSync(${JSON.stringify(flag)})) process.exit(3);\n` },
  });
  const r1 = cli(f);
  assert.equal(r1.code, 1, r1.stderr);
  const head = git(wtDir(f, 'F1'), 'rev-parse', 'HEAD');
  const before = logLines(f).filter((l) => l.s === 's1' && path.basename(l.cwd) === 'F1').length;
  assert.equal(before, 1);
  fs.writeFileSync(flag, 'x');
  const build = fakeBuild(f);
  const r2 = await run(f, { build }, { resume: true });
  assert.equal(r2.results[0].status, 'passed', r2.logs.join('\n'));
  const lines = logLines(f);
  assert.equal(lines.filter((l) => l.s === 's1' && path.basename(l.cwd) === 'F1').length, 2, 'the first command ran again');
  assert.equal(lines.filter((l) => l.s === 's1' && path.basename(l.cwd) === '_integration').length, 1, 'integration was already set up');
  assert.equal(build.calls.length, 1);
  assert.equal(build.calls[0].carriedWork, undefined, 'nothing was carried');
  assert.ok(!git(f.dir, 'log', '--format=%s', `${head}..harness/integration`).includes('carried work'));
});

// ------------------------------------------------------------------ ES-4
test('F130 ES-4 a setup command that outlives budget.step_timeout_sec is killed with its process tree', async () => {
  const pidFile = path.join(tmpdir('f130-pid-'), 'child.pid');
  const f = fixture({
    setup: ['node sleepy.mjs'], config: { budget: { step_timeout_sec: 5 } },
    scripts: { 'sleepy.mjs': `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 120000);\n` },
  });
  const r = cli(f);
  assert.equal(r.code, 1, r.stderr);
  assert.ok(r.stderr.includes('worktree setup') && r.stderr.includes('timed out'), r.stderr);
  assert.ok(r.ms < 90000, `took ${r.ms} ms`);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  let gone = false;
  for (let i = 0; i < 100 && !gone; i += 1) { gone = !alive(pid); if (!gone) await sleep(100); }
  assert.ok(gone, 'the setup process is gone');
});

// ------------------------------------------------------------------ ES-5
test('F130 ES-5 a failing integration setup stops before any feature worktree or builder; resume sets it up again', async () => {
  const flag = path.join(tmpdir('f130-flag-'), 'fixed');
  const f = fixture({
    setup: ['node s1.mjs', 'node gate.mjs'],
    scripts: { 'gate.mjs': `import fs from 'node:fs';\nif (process.cwd().includes('_integration') && !fs.existsSync(${JSON.stringify(flag)})) process.exit(1);\n` },
  });
  const r1 = cli(f);
  assert.equal(r1.code, 1, r1.stderr);
  assert.ok(r1.stderr.includes('worktree setup failed') && r1.stderr.includes('integration'), r1.stderr);
  assert.ok(!fs.existsSync(wtDir(f, 'F1')), 'no feature worktree');
  assert.deepEqual(branches(f), []);
  assert.ok(!fs.existsSync(f.marker));
  assert.ok(fs.existsSync(statePath(f)));
  fs.writeFileSync(flag, 'x');
  const r2 = await run(f, { build: fakeBuild(f) }, { resume: true });
  assert.equal(r2.results[0].status, 'passed', r2.logs.join('\n'));
  const ints = logLines(f).filter((l) => l.s === 's1' && path.basename(l.cwd) === '_integration');
  assert.equal(ints.length, 2, 'integration setup ran again on resume');
});
