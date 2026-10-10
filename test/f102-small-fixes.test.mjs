// F102: small fixes — the cleanup after the pre-merge verify also removes untracked nested git
// repositories, `harness backlog close` takes a reason that starts with '-' after '--', and the
// lint warning for a closed item with an odd `closed` value does not say 'undefined'.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, readJson, writeJson, tmpdir } from './helpers.mjs';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract, lintContract } from '../lib/contract.mjs';
import * as run from '../lib/run.mjs';

// ------------------------------------------------------------------ AC-1 fixtures

const HARNESS_IGNORE = 'wt/\n*.tmp-*\nruns/test-count-cache.json\nruns/verify-cache.json\n';

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id}.txt exists`, check: 'node scripts/ok.mjs', new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-09T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function runFixture() {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': HARNESS_IGNORE,
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract('F1'),
    'scripts/ok.mjs': 'process.exit(0);\n',
    '.gitignore': '*.log\n',
  }, { branch: null });
}

const cfg = () => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 } });
const intWt = (dir) => path.join(dir, '.harness', 'wt', '_integration');
const featureWt = (dir) => path.join(dir, '.harness', 'wt', 'F1');
const isIntegration = (cwd) => fs.realpathSync.native(cwd).endsWith(`${path.sep}_integration`);

const OK_INTEGRITY = { markers: [], harnessPaths: [], testCount: { status: 'unset' } };
const PASSING = { pass: true, commands: [], criteria: [{ id: 'AC-1', pass: true }], integrity: OK_INTEGRITY, warnings: [] };
const evaluate = async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });

// ------------------------------------------------------------------ AC-1
test('F102 AC-1: the cleanup after the pre-merge verify removes an untracked nested git repository; ignored and .harness/ files stay', async () => {
  const dir = runFixture();
  const build = async (a) => {
    // Integration moves while F1 builds, so the pre-merge verify runs.
    writeFiles(intWt(dir), { 'other.txt': 'other\n' });
    commitAll(intWt(dir), 'meanwhile on integration');
    writeFiles(a.cwd, { 'F1.txt': 'built\n' });
    return { ok: true, costUsd: 0 };
  };
  const steps = [];
  const verify = async (a) => {
    steps.push(a.step);
    if (a.step === 'pre_merge_verify') {
      const nested = path.join(a.cwd, 'nested');
      fs.mkdirSync(nested, { recursive: true });
      git(nested, 'init', '-q');
      writeFiles(a.cwd, { 'nested/inner.txt': 'cloned\n', 'out.log': 'ignored\n', '.harness/events/probe.jsonl': '{}\n' });
      assert.ok(fs.existsSync(path.join(nested, '.git')), 'the fixture made a nested repository');
    }
    return PASSING;
  };
  let atLockMerge = null;
  const g = async (args, cwd, opts) => {
    if (!atLockMerge && isIntegration(cwd) && args[0] === 'merge' && args[1] === '--no-ff' && fs.existsSync(featureWt(dir))) {
      atLockMerge = Object.fromEntries(['nested', 'nested/inner.txt', 'out.log', '.harness/events/probe.jsonl']
        .map((f) => [f, fs.existsSync(path.join(featureWt(dir), f))]));
    }
    return run.git(args, cwd, opts);
  };
  const r = await run.runFeatures({ root: dir, config: cfg(), deps: { build, verify, evaluate, git: g, cpus: 8, log: () => {}, warn: () => {} } });
  const result = r.results.find((x) => x.feature === 'F1');
  assert.equal(result.status, 'passed', JSON.stringify(r.results));
  assert.ok(steps.includes('pre_merge_verify'), steps.join(','));
  assert.deepEqual(atLockMerge, { nested: false, 'nested/inner.txt': false, 'out.log': true, '.harness/events/probe.jsonl': true });
  const inTree = git(dir, 'ls-tree', '-r', '--name-only', 'harness/integration').split(/\r?\n/);
  assert.ok(inTree.includes('F1.txt'), inTree.join(','));
  assert.ok(!inTree.some((f) => f.startsWith('nested')), inTree.join(','));
});

// ------------------------------------------------------------------ AC-2 / ES-1 fixtures

const ITEMS = () => [
  { id: 'B1', summary: 'first finding' },
  { id: 'B2', summary: 'second finding' },
];

function project() {
  const dir = tmpdir('harness-f102-');
  writeJson(path.join(dir, '.harness', 'config.json'), { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } });
  writeJson(path.join(dir, '.harness', 'features.json'), { features: [] });
  writeJson(path.join(dir, '.harness', 'backlog.json'), { items: ITEMS() });
  return dir;
}
const backlogFile = (dir) => path.join(dir, '.harness', 'backlog.json');
const backlogText = (dir) => fs.readFileSync(backlogFile(dir), 'utf8');

// ------------------------------------------------------------------ AC-2
test('F102 AC-2: a reason after -- is taken as the reason, even when it starts with -', () => {
  const dir = project();
  const r = harness(['backlog', 'close', 'B1', '--resolved', '--', '-5% fixed'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, 'B1: closed as resolved\n');
  const after = readJson(backlogFile(dir)).items;
  assert.equal(after[0].closed.as, 'resolved');
  assert.equal(after[0].closed.reason, '-5% fixed');
  assert.deepEqual(after[1], ITEMS()[1]);
});

test('F102 AC-2: a reason after -- that looks like an option is still the reason', () => {
  const dir = project();
  const r = harness(['backlog', 'close', 'B1', 'B2', '--obsolete', '--', '--force'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const after = readJson(backlogFile(dir)).items;
  assert.deepEqual(after.map((i) => [i.closed.as, i.closed.reason]), [['obsolete', '--force'], ['obsolete', '--force']]);
});

test('F102 AC-2: without -- a reason that starts with - is still an unknown option, and the usage shows --', () => {
  const dir = project();
  const before = backlogText(dir);
  const r = harness(['backlog', 'close', 'B1', '--resolved', '-5% fixed'], { cwd: dir });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /unexpected option '-5% fixed'/);
  assert.match(r.stderr, /usage: harness backlog close .*\[--\] "<reason>"/);
  assert.ok(r.stderr.includes('--resolved -- "-5% fixed"'), r.stderr);
  assert.equal(backlogText(dir), before);
});

// ------------------------------------------------------------------ ES-1
const ES_CASES = [
  ['no reason after --', ['backlog', 'close', 'B1', '--resolved', '--'], /non-empty reason/],
  ['an empty reason after --', ['backlog', 'close', 'B1', '--resolved', '--', '  '], /non-empty reason/],
  ['two reasons after --', ['backlog', 'close', 'B1', '--resolved', '--', '-a', '-b'], /one quoted argument/],
  ['a reason before and after --', ['backlog', 'close', 'B1', '--resolved', 'a', '--', '-b'], /one quoted argument/],
];

for (const [name, args, message] of ES_CASES) {
  test(`F102 ES-1: ${name} is a usage error and changes nothing`, () => {
    const dir = project();
    const before = backlogText(dir);
    const r = harness(args, { cwd: dir });
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, message);
    assert.equal(r.stdout, '');
    assert.equal(backlogText(dir), before, 'backlog.json is unchanged');
  });
}

// ------------------------------------------------------------------ AC-3
const LINT_CONTRACT = {
  id: 'F9', title: 't', security_tier: 'standard', version: 1,
  acceptance_criteria: [{ id: 'AC-1', criterion: 'one', check: 'node x.mjs' }],
  security_criteria: [], error_scenarios: [], out_of_scope: [], resolves: ['B1'],
};

for (const [name, closed] of [['closed: true', true], ['closed: {}', {}], ['closed: {as: 7}', { as: 7 }]]) {
  test(`F102 AC-3: a resolves item with ${name} warns 'already closed' without 'undefined'`, () => {
    const backlog = [{ id: 'B1', summary: 'a', closed }];
    const warnings = lintContract(LINT_CONTRACT, { backlog }).filter((p) => p.rule === 'resolves');
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.equal(warnings[0].level, 'warning');
    assert.match(warnings[0].message, /resolves: backlog item B1 is already closed/);
    assert.ok(!warnings[0].message.includes('undefined'), warnings[0].message);
    assert.ok(!warnings[0].message.includes(' as '), warnings[0].message);
  });
}
