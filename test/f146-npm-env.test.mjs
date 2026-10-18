import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, realTmpdir } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { NPM_ENV, CI_METADATA_ENV, CWD_ENV, redactor } from '../lib/failures.mjs';
import { BASE_ENV_ALLOWLIST, filteredEnv } from '../lib/exec.mjs';
import { runFeatures } from '../lib/run.mjs';

const NAMES = [
  'NODE', '_', 'npm_command',
  ...['cache', 'global_prefix', 'globalconfig', 'init_module', 'local_prefix', 'node_gyp', 'npm_version', 'prefix', 'user_agent', 'userconfig'].map((n) => `npm_config_${n}`),
  'npm_execpath', 'npm_lifecycle_event', 'npm_node_execpath',
  'npm_package_json', 'npm_package_name', 'npm_package_version',
];
const UA = 'npm/10.9.4 node/v22.20.0 linux x64 workspaces/false';
const npmEnv = (root) => ({
  NODE: '/opt/node22/bin/node', _: '/opt/node22/bin/npm', npm_command: 'test',
  npm_config_cache: '/root/.npm', npm_config_global_prefix: '/opt/node22', npm_config_globalconfig: '/opt/node22/etc/npmrc',
  npm_config_init_module: '/root/.npm-init.js', npm_config_local_prefix: root, npm_config_node_gyp: '/opt/node22/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js',
  npm_config_npm_version: '10.9.4', npm_config_prefix: '/opt/node22', npm_config_user_agent: UA, npm_config_userconfig: '/root/.npmrc',
  npm_execpath: '/opt/node22/lib/node_modules/npm/bin/npm-cli.js', npm_lifecycle_event: 'test', npm_node_execpath: '/opt/node22/bin/node',
  npm_package_json: `${root}/package.json`, npm_package_name: 'my-sample-project', npm_package_version: '1.0.0',
});
const ROOT = '/home/u/my-sample-project';

test('F146 AC-1 NPM_ENV is the frozen 19 names in order', () => {
  assert.ok(Object.isFrozen(NPM_ENV));
  assert.deepEqual([...NPM_ENV], NAMES);
  assert.equal(new Set(NPM_ENV).size, 19);
});

test('F146 AC-2 other lists are unchanged and disjoint; NPM_ENV is outside BASE_ENV_ALLOWLIST', () => {
  assert.equal(CI_METADATA_ENV.length, 45);
  assert.deepEqual([...CWD_ENV], ['PWD', 'OLDPWD', 'INIT_CWD']);
  for (const n of NPM_ENV) {
    assert.ok(!CI_METADATA_ENV.includes(n) && !CWD_ENV.includes(n), n);
    assert.ok(!BASE_ENV_ALLOWLIST.includes(n), n);
  }
});

test('F146 AC-3 npm metadata values and their fragments are left alone', () => {
  const red = redactor(npmEnv(ROOT));
  for (const t of [`${ROOT}/.harness/wt/F1/test/a.test.mjs:3`, '> my-sample-project@1.0.0 test', 'sample-project@1.0.0',
    'cd /home/u/my-sample', UA, '/opt/node22/bin/node --test', '/root/.npm/_cacache']) assert.equal(red(t), t);
});

function probe(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
}

test('F146 AC-4 under npm test and npm exec the redactor keeps the path, name@version and node path', () => {
  const dir = realTmpdir('harness-f146-');
  const body = `import { redactor } from ${JSON.stringify(path.join(REPO, 'lib/failures.mjs').replace(/\\/g, '/').replace(/^/, 'file://'))};
const red = redactor(process.env);
const out = [process.cwd() + '/.harness/wt/F1/a.txt', '> my-sample-project@1.0.0 test', process.execPath].map((t) => red(t) === t);
console.log('RESULT ' + JSON.stringify(out));`;
  const probeFile = probe(dir, 'probe.mjs', body);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'my-sample-project', version: '1.0.0', scripts: { test: `node ${JSON.stringify(probeFile)}` } }));
  const npmCli = path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npm = fs.existsSync(npmCli) ? [process.execPath, [npmCli]] : ['npm', []];
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^npm_/i.test(k)) delete env[k];
  // Only npm's own variables are under test: drop inherited ones whose value lies inside a
  // probed text (e.g. AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache on GitHub runners, a prefix
  // of process.execPath). Allowlisted names (PATH, TEMP, HOME…) stay: they are never redacted.
  const probed = [dir, process.execPath];
  for (const [k, v] of Object.entries(env)) {
    if (BASE_ENV_ALLOWLIST.includes(k) || typeof v !== 'string' || v.length < 8) continue;
    if (probed.some((t) => t.includes(v))) delete env[k];
  }
  for (const args of [['test'], ['exec', '--', 'node', probeFile]]) {
    const r = spawnSync(npm[0], [...npm[1], ...args], { cwd: dir, encoding: 'utf8', env, shell: process.platform === 'win32' && npm[0] === 'npm' });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-2000));
    assert.match(r.stdout, /RESULT \[true,true,true\]/, r.stdout);
  }
});

function contract() {
  const c = {
    id: 'F1', title: 'feature F1', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-18T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

test('F146 AC-5 a verify failure output with npm values is saved unredacted in current.json', async () => {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract(),
    'scripts/ok.mjs': 'process.exit(0);\n',
  }, { branch: null });
  const line = `boom at ${dir}/a.txt in > my-sample-project@1.0.0 test`;
  const verify = async () => ({
    pass: false, criteria: [], warnings: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } },
    commands: [{ cmd: 'npm test', pass: false, message: 'exit 1', output: line }],
  });
  const config = resolveConfig({ base_branch: 'main', run: { max_parallel: 1 }, verify: { commands: [] }, max_rounds: 2 });
  const env = { npm_config_local_prefix: dir, npm_package_json: `${dir}/package.json`, npm_package_name: 'my-sample-project', NODE: process.execPath };
  const states = [];
  const stateFile = path.join(dir, '.harness/runs/current.json');
  const build = async (a) => {
    if (fs.existsSync(stateFile)) states.push(fs.readFileSync(stateFile, 'utf8'));
    writeFiles(a.cwd, { 'F1.txt': `x${a.round}.${a.attempt}\n` });
    return { ok: true, costUsd: 0 };
  };
  await runFeatures({ root: dir, config, deps: { build, verify, evaluate: async () => { throw new Error('unreachable'); }, env } });
  assert.ok(states.length > 0, 'a state file was saved before a later build');
  assert.ok(states.some((t) => t.includes(JSON.stringify(line).slice(1, -1))), states.join('\n').slice(0, 1500));
});

test('F146 AC-6 SPEC SR-2 describes NPM_ENV', () => {
  const sr2 = fs.readFileSync(path.join(REPO, 'docs/SPEC.md'), 'utf8').split('\n').find((l) => l.startsWith('- SR-2 '));
  for (const s of ['NPM_ENV', 'npm_config_local_prefix', 'npm_package_name', '19', 'npm_lifecycle_script', '_authToken', '_auth', 'password', 'proxy']) assert.ok(sr2.includes(s), s);
});

test('F146 SC-1 npm secrets are still redacted', () => {
  const names = ['npm_config__authToken', 'npm_config_//registry.npmjs.org/:_authToken', 'npm_config__auth', 'npm_config__password',
    'npm_config_password', 'npm_config_https_proxy', 'npm_config_registry', 'NPM_TOKEN', 'NODE_AUTH_TOKEN'];
  names.forEach((n, i) => {
    const v = `s3cr3t-value-${i}-abcdef`;
    const red = redactor({ ...npmEnv(ROOT), [n]: v });
    assert.equal(red(`a ${v} b`), 'a [redacted] b', n);
    assert.ok(red(`${v.slice(4)} tail`).startsWith('[redacted]'), n);
    assert.ok(red(`head ${v.slice(0, 12)}`).endsWith('[redacted]'), n);
  });
});

test('F146 SC-2 npm_lifecycle_script stays redacted', () => {
  for (const n of ['npm_lifecycle_script', 'npm_package_config_token', 'NODE_OPTIONS']) assert.ok(!NPM_ENV.includes(n), n);
  const red = redactor({ ...npmEnv(ROOT), npm_lifecycle_script: 'API_KEY=sk-live-12345678 node --test' });
  assert.equal(red('x API_KEY=sk-live-12345678 node --test y'), 'x [redacted] y');
  assert.ok(red('sk-live-12345678 node --test tail').startsWith('[redacted]'));
});

test('F146 SC-3 NPM_ENV never reaches a command', () => {
  assert.deepEqual(filteredEnv([], { PATH: '/bin', ...npmEnv(ROOT) }), { PATH: '/bin' });
});

test('F146 SC-4 a value shared with a name outside the list is redacted; names are case-sensitive', () => {
  assert.equal(redactor({ ...npmEnv(ROOT), PROJECT_ROOT: ROOT })(`in ${ROOT}/a`), 'in [redacted]/a');
  const red = redactor({ NPM_CONFIG_LOCAL_PREFIX: '/home/u/upper-prefix', Npm_Package_Name: 'mixed-case-name' });
  assert.equal(red('/home/u/upper-prefix mixed-case-name'), '[redacted] [redacted]');
});

test('F146 ES-1 odd NPM_ENV values do not throw', () => {
  for (const v of ['', 'short', undefined, 42, null]) {
    const red = redactor({ npm_config_local_prefix: v, npm_package_name: v }, ['npm_config_local_prefix']);
    assert.equal(red('plain text'), 'plain text');
  }
});
