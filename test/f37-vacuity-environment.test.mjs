// F37: the base-side vacuity run of a new criterion is limited by
// min(budget.step_timeout_sec, max(verify.vacuity_timeout_sec, 3 × the head run's duration measured
// by the core)); a base timeout records the applied limit. A base run whose program is not found
// is an environment stop in `harness run`, like F29.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { verify } from '../lib/verify.mjs';
import { runFeatures } from '../lib/run.mjs';

const CONTRACT = (id, criteria) => ({
  id, title: 'fixture', security_tier: 'standard', version: 1,
  acceptance_criteria: criteria.map(({ id: cid, check, isNew = true }) => ({ id: cid, criterion: cid, check, new: isNew })),
  security_criteria: [], error_scenarios: [], out_of_scope: [],
});

// `node scripts/check.mjs <headSec> <baseSec> [headExit]`: on HEAD (marker.txt exists) waits
// headSec and exits headExit (default 0); on base waits baseSec and exits 0.
// Every wait is bounded (at most 45 s here), so the pre-feature code ends too.
// A "fast" head run still takes node startup time (several seconds with three suites running
// at once), so exact limit assertions use a vacuity_timeout_sec of 15: 3 × startup stays below it.
const CHECK_SCRIPT = `const [headSec, baseSec, headExit = '0'] = process.argv.slice(2);
const head = require('node:fs').existsSync('marker.txt');
if (head) console.log('duration: 9999');
setTimeout(() => process.exit(head ? Number(headExit) : 0), Number(head ? headSec : baseSec) * 1000);
`;

function fixture(criteria) {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': CONTRACT('F9', criteria),
    '.harness/backlog.json': { items: [] },
    'scripts/check.cjs': CHECK_SCRIPT,
  });
  writeFiles(dir, { 'marker.txt': 'feature\n' });
  commitAll(dir, 'feature');
  return dir;
}

const cfg = (verifyExtra = {}, budget = {}) => resolveConfig({ base_branch: 'main', verify: { commands: [], ...verifyExtra }, budget });
const runVerify = (dir, config) => verify({ root: dir, featureId: 'F9', base: 'main', config, cpus: 1 });
const check = (...args) => `node scripts/check.cjs ${args.join(' ')}`;

// ---------- AC-1 ----------
test('F37 AC-1: a check taking 5s on head and passing on base after 6s is vacuous at vacuity_timeout_sec 2', async () => {
  const dir = fixture([{ id: 'AC-1', check: check(5, 6) }]);
  const r = await runVerify(dir, cfg({ vacuity_timeout_sec: 2 }, { step_timeout_sec: 60 }));
  const c = r.criteria[0];
  assert.equal(c.vacuous, true, JSON.stringify(c));
  assert.equal(c.pass, false);
  assert.equal(c.base_timed_out, undefined);
  assert.equal(r.pass, false);
});

test('F37 AC-1: the base limit never exceeds budget.step_timeout_sec', async () => {
  // 3 × 3s head = 9s is above step_timeout_sec 6: the base run (10s) is cut at 6s.
  const dir = fixture([{ id: 'AC-1', check: check(3, 10) }]);
  const r = await runVerify(dir, cfg({ vacuity_timeout_sec: 1 }, { step_timeout_sec: 6 }));
  const c = r.criteria[0];
  assert.equal(c.base_timed_out, true, JSON.stringify(c));
  assert.equal(c.base_timeout_sec, 6);
  assert.equal(c.pass, true);
});

test('F37 AC-1: a fast head check keeps vacuity_timeout_sec as the base limit', async () => {
  const dir = fixture([{ id: 'AC-1', check: check(0, 45) }]);
  const r = await runVerify(dir, cfg({ vacuity_timeout_sec: 15 }, { step_timeout_sec: 60 }));
  const c = r.criteria[0];
  assert.equal(c.base_timed_out, true, JSON.stringify(c));
  assert.equal(c.base_timeout_sec, 15);
});

// ---------- AC-2 ----------
test('F37 AC-2: a base run past its limit is base_timed_out and the limit appears in the result and warnings', async () => {
  const dir = fixture([{ id: 'AC-1', check: check(2, 20) }]);
  const r = await runVerify(dir, cfg({ vacuity_timeout_sec: 1 }, { step_timeout_sec: 60 }));
  const c = r.criteria[0];
  assert.equal(c.base_timed_out, true, JSON.stringify(c));
  assert.equal(c.vacuous, false);
  assert.equal(c.pass, true);
  assert.equal(r.pass, true, JSON.stringify(r));
  // 3 × a head run of at least 2s, below 20s since the base run was cut.
  assert.ok(c.base_timeout_sec >= 6 && c.base_timeout_sec < 20, String(c.base_timeout_sec));
  const w = r.warnings.find((x) => x.startsWith('AC-1:') && x.includes('base'));
  assert.ok(w, JSON.stringify(r.warnings));
  assert.ok(w.includes(`${c.base_timeout_sec}s`), w);
});

test('F37 AC-2: only criteria whose base run timed out get base_timeout_sec and a warning', async () => {
  const dir = fixture([
    { id: 'AC-1', check: check(0, 45) },
    { id: 'AC-2', check: 'node -e "process.exit(require(\'fs\').existsSync(\'marker.txt\') ? 0 : 1)"' },
  ]);
  const r = await runVerify(dir, cfg({ vacuity_timeout_sec: 15 }, { step_timeout_sec: 60 }));
  assert.equal(r.criteria[0].base_timeout_sec, 15, JSON.stringify(r.criteria));
  assert.equal(r.criteria[1].base_timeout_sec, undefined);
  assert.equal(r.criteria[1].base_timed_out, undefined);
  assert.ok(r.warnings.some((x) => x.startsWith('AC-1:') && x.includes('15s')), JSON.stringify(r.warnings));
  assert.ok(!r.warnings.some((x) => x.startsWith('AC-2:')), JSON.stringify(r.warnings));
});

// ---------- SC-1 ----------
test('F37 SC-1: a check printing "duration: 9999" does not change the base limit', async () => {
  const dir = fixture([{ id: 'AC-1', check: check(0, 45) }]);
  const r = await runVerify(dir, cfg({ vacuity_timeout_sec: 15 }, { step_timeout_sec: 60 }));
  const c = r.criteria[0];
  assert.equal(c.base_timed_out, true, JSON.stringify(c));
  assert.equal(c.base_timeout_sec, 15, 'the limit comes from the core-measured head time, not the output');
});

// ---------- ES-1 ----------
test('F37 ES-1: a failing head check runs no base run and gets no limit; another criterion still does', async () => {
  const dir = fixture([
    { id: 'AC-1', check: check(4, 0, 1) }, // fails on head after 4s, would pass on base at once
    { id: 'AC-2', check: check(0, 45) },
  ]);
  const r = await runVerify(dir, cfg({ vacuity_timeout_sec: 15 }, { step_timeout_sec: 60 }));
  const [a, b] = r.criteria;
  assert.equal(a.pass, false, JSON.stringify(a));
  assert.equal(a.message, 'exit 1');
  assert.equal(a.vacuous, false);
  assert.equal(a.base_timed_out, undefined);
  assert.equal(a.base_timeout_sec, undefined);
  assert.equal(a.notFound, undefined);
  // AC-1's 4s head run does not raise AC-2's limit.
  assert.equal(b.base_timeout_sec, 15, JSON.stringify(b));
  assert.ok(!r.warnings.some((x) => x.startsWith('AC-1:')), JSON.stringify(r.warnings));
});

// ---------- AC-3 ----------
const TOOL = 'harness-f37-tool';
// On the feature worktree (F1.txt written by the build) exits 0; on base runs TOOL, which is not
// installed, and exits with the shell's status (127, or 1 with cmd.exe's message on Windows).
const PROBE = `const fs = require('node:fs');
if (fs.existsSync('F1.txt')) process.exit(0);
const r = require('node:child_process').spawnSync('${TOOL}', { shell: true, stdio: 'inherit' });
process.exit(r.status ?? 1);
`;

function runFixture(check) {
  const c = {
    id: 'F1', title: 'feature F1', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check, new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-26T00:00:00.000Z', hash: hashContract(c) };
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': c,
    'scripts/probe.cjs': PROBE,
    'scripts/fail.cjs': "process.exit(require('node:fs').existsSync('F1.txt') ? 0 : 1);\n",
  }, { branch: null });
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const evalResult = (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });

async function runF1(dir) {
  const logs = [];
  const builds = [];
  const build = async (a) => {
    builds.push(a.round);
    writeFiles(a.cwd, { 'F1.txt': 'built\n' });
    return { ok: true, costUsd: 0 };
  };
  const r = await runFeatures({
    root: dir,
    config: resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 } }),
    deps: { build, evaluate: async (a) => evalResult(a), log: (m) => logs.push(m) },
  });
  return { ...r, builds, out: logs.join('\n') };
}

test('F37 AC-3: a base vacuity run whose program is not found stops the run on the environment; the feature is not blocked', async () => {
  const dir = runFixture('node scripts/probe.cjs');
  const r = await runF1(dir);
  assert.equal(r.interrupted, true, `${r.out}\n${JSON.stringify(r.results)}`);
  assert.deepEqual(r.environment, { feature: 'F1', stage: 'verify', item: 'AC-1', program: TOOL });
  assert.deepEqual(r.results, [], 'nothing was blocked');
  for (const w of [TOOL, 'command not found', 'harness run --resume']) assert.ok(r.out.includes(w), `${w} in: ${r.out}`);
  const status = readJson(path.join(dir, '.harness/features.json')).features[0].status;
  assert.equal(status, 'in_progress');
  assert.deepEqual(readJson(path.join(dir, '.harness/backlog.json')).items, []);
  const saved = readJson(path.join(dir, '.harness/runs/current.json'));
  assert.equal(saved.active.length, 1);
  assert.equal(saved.active[0].round, 1);
  assert.deepEqual(saved.active[0].history, []);
  assert.equal(r.builds.length, 1, 'no build retry for a missing program');
});

test('F37 AC-3: an ordinary base failure (exit 1) is not an environment stop — the criterion is non-vacuous and passes', async () => {
  const dir = runFixture('node scripts/fail.cjs');
  const r = await runF1(dir);
  assert.equal(r.environment, undefined, r.out);
  assert.equal(r.results[0]?.status, 'passed', `${r.out}\n${JSON.stringify(r.results)}`);
});

test('F37 AC-3: verify reports a base not-found run as a failed criterion naming the program', async () => {
  const dir = runFixture('node scripts/probe.cjs');
  writeFiles(dir, { 'F1.txt': 'built\n' });
  const r = await verify({ root: dir, featureId: 'F1', base: 'main', config: cfg(), cpus: 1 });
  // F1.txt is untracked, so base (main) has no F1.txt and runs the missing tool.
  const c = r.criteria[0];
  assert.equal(c.pass, false, JSON.stringify(c));
  assert.equal(c.base_not_found, true);
  assert.equal(c.notFound, TOOL);
  assert.match(c.message, /command not found/);
  assert.equal(r.pass, false);
});

// ---------- AC-4 ----------
test('F37 AC-4: SPEC §6.3, §8 and docs/run.md describe the head-based base limit and the base not-found stop', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s63 = spec.slice(spec.indexOf('\n### 6.3 '), spec.indexOf('\n## 7. '));
  const s8 = spec.slice(spec.indexOf('\n## 8. '), spec.indexOf('\n## 9. '));
  const runMd = fs.readFileSync(path.join(REPO, 'docs', 'run.md'), 'utf8');
  for (const [name, text] of [['SPEC §6.3', s63], ['docs/run.md', runMd]]) {
    for (const s of ['verify.vacuity_timeout_sec', 'budget.step_timeout_sec', '3배', 'base_timeout_sec', 'warnings']) {
      assert.ok(text.includes(s), `${name} mentions ${s}`);
    }
  }
  const env8 = s8.split('\n').find((l) => l.includes('환경 실패'));
  assert.ok(env8 && env8.includes('base vacuity'), 'SPEC §8 environment rule covers the base vacuity run');
  const envRun = runMd.split('\n').filter((l) => l.includes('base vacuity') && l.includes('command not found'));
  assert.ok(envRun.length > 0, 'docs/run.md covers a base vacuity run with a missing program');
  assert.ok(s63.includes('base_not_found'), 'SPEC §6.3 names base_not_found');
});
