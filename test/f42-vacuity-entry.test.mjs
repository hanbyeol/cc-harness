import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { verify, checkEntry } from '../lib/verify.mjs';

// F42: when a new criterion's check directly runs a file in the repository that the feature
// created (`node test/tool.mjs`), the base vacuity run of that criterion does not get the
// feature's version of that file — the check's own entry script is not "the feature's test",
// it is the feature (SPEC §6.3).

const HARNESS = (checks) => ({
  '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
  '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
  '.harness/contracts/F9.json': {
    id: 'F9', title: 'fixture', security_tier: 'standard', version: 1,
    acceptance_criteria: checks.map(([id, check, isNew = true]) => ({ id, criterion: id, check, new: isNew })),
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  },
});

const cfg = () => resolveConfig({
  base_branch: 'main', verify: { commands: [], test_paths: ['test/**'] }, budget: { step_timeout_sec: 30 },
});
const run = (root) => verify({ root, featureId: 'F9', base: 'main', config: cfg() });
const byId = (r) => Object.fromEntries(r.criteria.map((c) => [c.id, c]));

// A script that always passes: overlaid on base, it would make its criterion vacuous.
const PASS_JS = 'process.exit(0);\n';
const PASS_SH = '#!/bin/sh\nexit 0\n';

// A feature that adds `files` (all passing tools) and checks each criterion with its command.
async function featureRun(checks, files) {
  const dir = gitRepo({ ...HARNESS(checks), 'lib/x.mjs': 'export const x = 1;\n' });
  writeFiles(dir, files);
  // A committed script run as ./x.sh is recreated executable (a fixture file, not a PATH fake).
  for (const f of Object.keys(files)) {
    if (!f.endsWith('.sh')) continue;
    fs.rmSync(path.join(dir, f));
    fs.writeFileSync(path.join(dir, f), files[f], { mode: 0o755 });
  }
  commitAll(dir, 'feature adds its tool');
  return { dir, r: await run(dir) };
}

// ---------- AC-1 ----------
test('F42 AC-1: the entry forms node, bash, sh, python3 and ./ are recognised', () => {
  assert.equal(checkEntry('node test/tool.mjs'), 'test/tool.mjs');
  assert.equal(checkEntry('node test/tool.mjs "F1 AC-1"'), 'test/tool.mjs');
  assert.equal(checkEntry('bash scripts/check.sh arg'), 'scripts/check.sh');
  assert.equal(checkEntry('sh scripts/check.sh'), 'scripts/check.sh');
  assert.equal(checkEntry('python3 tools/check.py -v'), 'tools/check.py');
  assert.equal(checkEntry('./scripts/check.sh'), 'scripts/check.sh');
  assert.equal(checkEntry("node 'test/my tool.mjs'"), 'test/my tool.mjs');
  assert.equal(checkEntry('node ./test/tool.mjs&&echo x'), 'test/tool.mjs');
  assert.equal(checkEntry('  node   test/a/../tool.mjs'), 'test/tool.mjs');
});

test('F42 AC-1: other command shapes have no entry script', () => {
  for (const cmd of ['node --test test/x.test.mjs', 'npm test', 'python3 -m pytest', 'nodejs test/x.mjs',
    'echo test/x.mjs', 'node', 'sh -c "exit 0"', 'node $X', 'node test/*.mjs', '']) {
    assert.equal(checkEntry(cmd), null, cmd);
  }
});

test('F42 AC-1: a new entry script run with node is not placed on base, so the criterion is not vacuous', async () => {
  const { r } = await featureRun([['AC-1', 'node test/tool.mjs']], { 'test/tool.mjs': PASS_JS });
  const c = byId(r)['AC-1'];
  assert.equal(c.vacuous, false, JSON.stringify(c));
  assert.equal(c.pass, true, JSON.stringify(c));
});

test('F42 AC-1: the entry is withheld only from its own criterion — another check still sees it on base', async () => {
  // AC-0 runs the same file through a runner that exists on base: the file is overlaid there.
  const RUNNER = "import { spawnSync } from 'node:child_process';\n"
    + "process.exit(spawnSync(process.execPath, ['test/tool.mjs']).status ?? 1);\n";
  const dir = gitRepo({ ...HARNESS([['AC-0', 'node run.mjs'], ['AC-1', 'node test/tool.mjs']]), 'run.mjs': RUNNER });
  writeFiles(dir, { 'test/tool.mjs': PASS_JS });
  commitAll(dir, 'feature adds its tool');
  const r = byId(await run(dir));
  assert.equal(r['AC-0'].vacuous, true, JSON.stringify(r['AC-0']));
  assert.equal(r['AC-1'].vacuous, false, JSON.stringify(r['AC-1']));
  assert.equal(r['AC-1'].pass, true);
});

test('F42 AC-1: a new entry script run with sh or ./ is not vacuous and not a missing command', async () => {
  if (process.platform === 'win32') return; // sh and ./ scripts are POSIX shell forms
  const { r } = await featureRun(
    [['AC-1', 'sh test/tool.sh'], ['AC-2', './test/tool.sh']],
    { 'test/tool.sh': PASS_SH },
  );
  for (const id of ['AC-1', 'AC-2']) {
    const c = byId(r)[id];
    assert.equal(c.vacuous, false, JSON.stringify(c));
    assert.equal(c.pass, true, JSON.stringify(c));
    assert.equal(c.base_not_found, undefined, JSON.stringify(c));
  }
});

// ---------- AC-2 ----------
test('F42 AC-2: an entry script that exists on base keeps the overlay of the feature test files', async () => {
  // run.mjs is on base and runs test/x.test.mjs, which the feature adds and which passes on base.
  const RUNNER = "import { spawnSync } from 'node:child_process';\n"
    + "process.exit(spawnSync(process.execPath, ['test/x.test.mjs']).status ?? 1);\n";
  const dir = gitRepo({ ...HARNESS([['AC-1', 'node test/run.mjs']]), 'test/run.mjs': RUNNER });
  writeFiles(dir, { 'test/x.test.mjs': PASS_JS });
  commitAll(dir, 'feature adds a test for existing behaviour');
  const c = byId(await run(dir))['AC-1'];
  assert.equal(c.vacuous, true, JSON.stringify(c));
  assert.equal(c.base_entry, undefined);
});

test('F42 AC-2: an entry script on base that the feature modifies is placed on base as before', async () => {
  const dir = gitRepo({ ...HARNESS([['AC-1', 'node test/tool.mjs']]), 'test/tool.mjs': 'process.exit(1);\n' });
  writeFiles(dir, { 'test/tool.mjs': PASS_JS });
  commitAll(dir, 'feature rewrites the tool');
  const c = byId(await run(dir))['AC-1'];
  assert.equal(c.vacuous, true, JSON.stringify(c));
  assert.equal(c.base_entry, undefined);
});

// ---------- AC-3 ----------
test('F42 AC-3: the criterion records the withheld entry file as base_entry', async () => {
  const { r } = await featureRun(
    [['AC-1', 'node ./test/tool.mjs "F1 AC-1"'], ['AC-2', 'node test/other.mjs']],
    { 'test/tool.mjs': PASS_JS },
  );
  assert.equal(byId(r)['AC-1'].base_entry, 'test/tool.mjs');
  assert.equal(byId(r)['AC-2'].base_entry, undefined, 'a failing head check has no base run');
});

test('F42 AC-3: an entry outside verify.test_paths is not overlaid anyway and has no base_entry', async () => {
  const { r } = await featureRun([['AC-1', 'node tools/tool.mjs']], { 'tools/tool.mjs': PASS_JS });
  const c = byId(r)['AC-1'];
  assert.equal(c.vacuous, false, JSON.stringify(c));
  assert.equal(c.base_entry, undefined);
});

// ---------- AC-4 ----------
test('F42 AC-4: SPEC §6.3 and docs/run.md describe the entry script rule', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s63 = spec.slice(spec.indexOf('\n### 6.3 '), spec.indexOf('\n## 7. '));
  const runMd = fs.readFileSync(path.join(REPO, 'docs', 'run.md'), 'utf8');
  for (const [name, text] of [['SPEC §6.3', s63], ['docs/run.md', runMd]]) {
    for (const s of ['진입 스크립트', 'base_entry', 'node <경로>', 'python3 <경로>', './<경로>', '..']) {
      assert.ok(text.includes(s), `${name} mentions ${s}`);
    }
  }
});

// ---------- SC-1 ----------
test('F42 SC-1: an entry path that leaves the repository with .. gets no rule', async () => {
  assert.equal(checkEntry('node ../outside/tool.mjs'), null);
  assert.equal(checkEntry('node test/../../tool.mjs'), null);
  assert.equal(checkEntry('./../tool.sh'), null);
  assert.equal(checkEntry('node ..'), null);
});

test('F42 SC-1: an absolute entry path starting at the root gets no rule', () => {
  assert.equal(checkEntry('node /tmp/test/tool.mjs'), null);
  assert.equal(checkEntry('bash /test/tool.sh'), null);
  assert.equal(checkEntry('node //server/share/tool.mjs'), null);
});

test('F42 SC-1: an entry path with a drive letter gets no rule', () => {
  assert.equal(checkEntry('node C:/repo/test/tool.mjs'), null);
  assert.equal(checkEntry('node c:test/tool.mjs'), null);
  assert.equal(checkEntry('python3 "D:/x/tool.py"'), null);
});

test('F42 SC-1: an entry that leaves the repository with .. is handled as before (no base_entry)', async () => {
  // `../<repo>/test/tool.mjs` leaves the repository and comes back into it on head; on base
  // it still names the head file, which passes there — vacuous, exactly as without the rule.
  const dir = gitRepo({ 'lib/x.mjs': '' });
  writeFiles(dir, { ...HARNESS([['AC-1', `node ../${path.basename(dir)}/test/tool.mjs`]]), 'test/tool.mjs': PASS_JS });
  commitAll(dir, 'feature adds its tool');
  const c = byId(await run(dir))['AC-1'];
  assert.equal(c.base_entry, undefined, JSON.stringify(c));
  assert.equal(c.vacuous, true, JSON.stringify(c));
});

// ---------- ES-1 ----------
test('F42 ES-1: a check that cannot be parsed has no entry and raises nothing', () => {
  for (const cmd of ['node "test/tool.mjs', "node 'test/tool.mjs", 'node test/tool.mjs "unterminated', "./x.sh 'a", null, undefined, 42]) {
    assert.doesNotThrow(() => checkEntry(cmd));
    assert.equal(checkEntry(cmd), null, String(cmd));
  }
});

test('F42 ES-1: an unparsable check is verified as before without error', async () => {
  // An escaped quote leaves the parser with an unbalanced quote; the shell runs it fine.
  const { r } = await featureRun([['AC-1', 'node test/tool.mjs \\"']], { 'test/tool.mjs': PASS_JS });
  const c = byId(r)['AC-1'];
  assert.equal(c.base_entry, undefined, JSON.stringify(c));
  assert.equal(c.vacuous, true, 'the entry is overlaid as before');
});
