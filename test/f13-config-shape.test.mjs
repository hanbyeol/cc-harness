// F13: array and nullable keys of config.json are shape-checked when the user file is
// loaded, before it is merged with the profile. A wrong shape is HarnessError
// config_invalid (exit 2) naming the key, so no command runs on a misread config.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, project, writeJson, readJson, REPO } from './helpers.mjs';
import { git, gitRepo } from './gitfixture.mjs';
import { resolveConfig, loadConfig, listProfiles, loadProfile } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { runFeatures } from '../lib/run.mjs';
import { HarnessError } from '../lib/errors.mjs';

const MARKER = 'f13-marker.txt';
const MARKER_CMD = `node -e "require('fs').writeFileSync('${MARKER}','ran')"`;

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id}.txt exists`, check: `node -e "process.exit(require('fs').existsSync('${id}.txt')?0:1)"`, new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-23T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

// A git repo on main with approved F1 and the given config.json.
function repo(config, { base = 'main' } = {}) {
  return gitRepo({
    '.harness/config.json': config,
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract('F1'),
  }, { base, branch: null });
}

// resolveConfig must throw config_invalid (exit 2) whose message contains `needle`.
function rejects(user, needle) {
  assert.throws(() => resolveConfig(user, { label: 'cfg' }), (e) => {
    assert.ok(e instanceof HarnessError, String(e));
    assert.equal(e.code, 'config_invalid', e.message);
    assert.equal(e.exit, 2);
    assert.ok(e.message.includes(needle), `expected '${needle}' in: ${e.message}`);
    return true;
  }, JSON.stringify(user));
}

// The CLI exits 2 with `needle` in stderr, no stack trace, and no marker file.
function cliRejects(dir, args, needle) {
  const r = harness(args, { cwd: dir });
  assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  assert.ok(r.stderr.includes(needle), `${args.join(' ')}: ${r.stderr}`);
  assert.doesNotMatch(r.stdout + r.stderr, /^ {4}at /m, 'no stack trace');
  assert.doesNotMatch(r.stderr, /internal error/);
  return r;
}

const configured = (over) => ({ profile: 'sdlc', base_branch: 'main', ...over });

test('F13 AC-1 verify.commands as a string stops status and verify with exit 2 before any command runs', () => {
  const dir = repo(configured({ verify: { commands: MARKER_CMD } }));
  cliRejects(dir, ['status'], 'verify.commands');
  cliRejects(dir, ['verify', 'F1', '--base', 'main'], 'verify.commands');
  assert.equal(fs.existsSync(path.join(dir, MARKER)), false, 'the verify command did not run');
  rejects({ verify: { commands: 'npm test' } }, 'verify.commands');
});

test('F13 AC-2 a non-string or empty element of verify.commands names verify.commands[<index>]', () => {
  for (const [commands, idx] of [[['npm test', 42], 1], [[null], 0], [['a', 'b', ''], 2], [[['npm test']], 0], [[{ cmd: 'x' }], 0]]) {
    rejects({ verify: { commands } }, `verify.commands[${idx}]`);
  }
  const dir = repo(configured({ verify: { commands: [MARKER_CMD, 7] } }));
  cliRejects(dir, ['verify', 'F1', '--base', 'main'], 'verify.commands[1]');
  assert.equal(fs.existsSync(path.join(dir, MARKER)), false, 'the valid first command did not run either');
});

// One test per key (AC-3): a non-array value, and a non-string element with its index.
const ARRAY_KEYS = [
  ['verify.skip_markers', (v) => ({ verify: { skip_markers: v } })],
  ['env_allowlist', (v) => ({ env_allowlist: v })],
  ['secret_globs', (v) => ({ secret_globs: v })],
];
for (const [key, make] of ARRAY_KEYS) {
  test(`F13 AC-3 ${key}: a non-array or a non-string element exits 2 naming the key`, () => {
    for (const bad of ['x', 5, true, null, { a: 'b' }]) rejects(make(bad), key);
    rejects(make(['ok', 3]), `${key}[1]`);
    rejects(make([null]), `${key}[0]`);
    rejects(make(['ok', ['nested']]), `${key}[1]`);
    rejects(make(['']), `${key}[0]`);
    // valid shapes load
    assert.deepEqual(key === 'verify.skip_markers' ? resolveConfig(make(['@Flaky'])).verify.skip_markers : resolveConfig(make(['A_B']))[key], key === 'verify.skip_markers' ? ['@Flaky'] : ['A_B']);
    assert.doesNotThrow(() => resolveConfig(make([])));
    const dir = project([]);
    writeJson(path.join(dir, '.harness', 'config.json'), configured(make('X')));
    cliRejects(dir, ['status'], key);
  });
}

test('F13 AC-4 verify.test_count that is neither a string nor null exits 2 naming verify.test_count', () => {
  for (const bad of [3, 0, true, ['node count.mjs'], { cmd: 'x' }]) rejects({ verify: { test_count: bad } }, 'verify.test_count');
  assert.equal(resolveConfig({ verify: { test_count: 'node count.mjs' } }).verify.test_count, 'node count.mjs');
  assert.equal(resolveConfig({ verify: { test_count: null } }).verify.test_count, null);
  const dir = project([]);
  writeJson(path.join(dir, '.harness', 'config.json'), configured({ verify: { test_count: 12 } }));
  cliRejects(dir, ['status'], 'verify.test_count');
});

test('F13 AC-5 init config, profile defaults, verify {} and this repository config still load', () => {
  // init's own config through the CLI
  const dir = project([]);
  assert.equal(harness(['status'], { cwd: dir }).code, 0);
  const initCfg = loadConfig(dir);
  assert.deepEqual(initCfg.verify.commands, ['npm test']);
  // every shipped profile, both as defaults and when its verify block is written into the user file
  const profiles = listProfiles();
  for (const name of ['sdlc', 'iac', 'ops']) assert.ok(profiles.includes(name), name);
  for (const name of profiles) {
    const c = resolveConfig({ profile: name });
    assert.deepEqual(c.verify.commands, loadProfile(name).verify.commands, name);
    assert.doesNotThrow(() => resolveConfig({ profile: name, verify: loadProfile(name).verify }), name);
  }
  // verify: {} keeps the defaults
  const empty = resolveConfig({ verify: {} });
  assert.deepEqual(empty.verify.skip_markers, []);
  assert.equal(empty.verify.test_count, null);
  // this repository's own config (read-only)
  const own = resolveConfig(readJson(path.join(REPO, '.harness', 'config.json')));
  assert.ok(Array.isArray(own.protected_branches) && own.protected_branches.includes('main'));
  // a full config with every array key set loads
  assert.doesNotThrow(() => resolveConfig({
    protected_branches: ['main', 'release'], env_allowlist: ['CI'], secret_globs: ['secrets/**'],
    verify: { commands: ['npm test'], skip_markers: ['@Flaky'], test_count: 'node count.mjs' },
  }));
});

// ---------- SC-1: the real run flow with a fake builder/evaluator ----------

function fakeDeps() {
  const calls = [];
  const build = async (a) => {
    calls.push(a.featureId);
    fs.writeFileSync(path.join(a.cwd, `${a.featureId}.txt`), 'built\n');
    git(a.cwd, 'add', '-A');
    git(a.cwd, 'commit', '-q', '-m', `builder ${a.featureId}`);
    return { ok: true, costUsd: 0 };
  };
  return {
    calls,
    deps: {
      build,
      verify: async () => ({ pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] }),
      evaluate: async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null }),
    },
  };
}

test('F13 SC-1 protected_branches as a string or with a non-string element stops run before any work; v2 is unchanged', async () => {
  for (const protected_branches of ['v2', ['main', 7], ['main', null], ['main', '']]) {
    // The user means to protect v2, and v2 is also the integration target: a misread list would merge into it.
    const dir = repo(configured({ integration_branch: 'v2', protected_branches, verify: { commands: [] }, budget: { step_timeout_sec: 60 } }));
    git(dir, 'branch', 'v2', 'main');
    const before = git(dir, 'rev-parse', 'refs/heads/v2');
    const { deps, calls } = fakeDeps();
    await assert.rejects(runFeatures({ root: dir, deps }), (e) => {
      assert.ok(e instanceof HarnessError, String(e));
      assert.equal(e.code, 'config_invalid', e.message);
      assert.equal(e.exit, 2);
      assert.match(e.message, /protected_branches/);
      return true;
    }, JSON.stringify(protected_branches));
    assert.deepEqual(calls, [], 'no build ran');
    assert.equal(git(dir, 'rev-parse', 'refs/heads/v2'), before, 'v2 did not move');
    assert.equal(fs.existsSync(path.join(dir, '.harness', 'runs', 'current.json')), false, 'the run did not start');
    // and through the CLI
    cliRejects(dir, ['run'], 'protected_branches');
    assert.equal(git(dir, 'rev-parse', 'refs/heads/v2'), before, 'v2 did not move (CLI)');
  }
  // a proper list still protects v2
  const ok = resolveConfig({ protected_branches: ['main', 'v2'] });
  assert.deepEqual(ok.protected_branches, ['main', 'v2']);
});

test('F13 ES-1 every shape error is config_invalid, exit 2, with no stack trace', () => {
  const cases = [
    [{ verify: { commands: 'npm test' } }, 'verify.commands'],
    [{ verify: { commands: ['ok', 1] } }, 'verify.commands[1]'],
    [{ verify: { skip_markers: 'x' } }, 'verify.skip_markers'],
    [{ env_allowlist: [1] }, 'env_allowlist[0]'],
    [{ secret_globs: {} }, 'secret_globs'],
    [{ verify: { test_count: 5 } }, 'verify.test_count'],
    [{ protected_branches: 'v2' }, 'protected_branches'],
    [{ protected_branches: ['main', false] }, 'protected_branches[1]'],
  ];
  for (const [over, needle] of cases) {
    rejects(over, needle);
    const dir = project([]);
    writeJson(path.join(dir, '.harness', 'config.json'), configured(over));
    for (const cmd of ['status', 'run']) cliRejects(dir, [cmd], needle);
  }
});

// Round 2: the run acts on its config snapshot, not on config.json. A state file written
// before F13 (or a config handed to runFeatures directly) must get the same checks.
test('F13 SC-1 resume: a saved run whose config snapshot has protected_branches "v2" stops before any work', async () => {
  const dir = repo(configured({ integration_branch: 'v2', protected_branches: ['main', 'v2'], verify: { commands: [] } }));
  git(dir, 'branch', 'v2', 'main');
  const before = git(dir, 'rev-parse', 'refs/heads/v2');
  const snapshot = { ...resolveConfig(configured({ integration_branch: 'v2', verify: { commands: [] } })), protected_branches: 'v2' };
  const statePath = path.join(dir, '.harness', 'runs', 'current.json');
  writeJson(statePath, { version: 1, runId: 'pre-f13', startedAt: '2026-09-23T00:00:00.000Z', scope: null, maxUsd: null,
    config: snapshot, costUsd: 0, results: [], current: null, stopped: null });
  const { deps, calls } = fakeDeps();
  await assert.rejects(runFeatures({ root: dir, resume: true, deps }),
    (e) => e instanceof HarnessError && e.code === 'config_invalid' && e.exit === 2 && /protected_branches/.test(e.message) && /current\.json/.test(e.message));
  assert.deepEqual(calls, [], 'no build ran');
  assert.equal(git(dir, 'rev-parse', 'refs/heads/v2'), before, 'v2 did not move');
});

test('F13 SC-1 direct config: runFeatures({config}) with protected_branches "v2" stops before any work', async () => {
  const dir = repo(configured({ integration_branch: 'v2', protected_branches: ['main', 'v2'], verify: { commands: [] } }));
  git(dir, 'branch', 'v2', 'main');
  const before = git(dir, 'rev-parse', 'refs/heads/v2');
  const config = { ...resolveConfig(configured({ integration_branch: 'v2', verify: { commands: [] } })), protected_branches: 'v2' };
  const { deps, calls } = fakeDeps();
  await assert.rejects(runFeatures({ root: dir, config, deps }), (e) => e instanceof HarnessError && e.code === 'config_invalid');
  assert.deepEqual(calls, []);
  assert.equal(git(dir, 'rev-parse', 'refs/heads/v2'), before);
});
