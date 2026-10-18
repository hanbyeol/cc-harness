// F145: a run that takes over a blocked feature's worktree judges the feature against the
// merge-base of harness/F{n} and integration, so a later-moved integration gets a
// pre_merge_verify outside the lock and the post-merge verify never reuses a vacuity run
// from another base.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpdir } from './helpers.mjs';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { verify as realVerify } from '../lib/verify.mjs';
import * as run from '../lib/run.mjs';

const HARNESS_IGNORE = 'wt/\n*.tmp-*\nruns/test-count-cache.json\nruns/verify-cache.json\n';

function fixture(file = 'F1.txt') {
  const c = {
    id: 'F1', title: 'feature F1', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${file} exists`, check: `node scripts/has.mjs ${file}`, new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-18T00:00:00.000Z', hash: hashContract(c) };
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': HARNESS_IGNORE,
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': c,
    'scripts/has.mjs': "import fs from 'node:fs';\nprocess.exit(process.argv.slice(2).every((f) => fs.existsSync(f)) ? 0 : 1);\n",
  }, { branch: null });
}

// The result cache is off where a test looks at the checks a post-merge verify runs.
const cfg = (cache = 'on') => resolveConfig({ base_branch: 'main', run: { max_parallel: 1 }, verify: { commands: [], cache }, budget: { step_timeout_sec: 60 } });
const INTEG = cfg().integration_branch;
const wt = (dir) => path.join(dir, '.harness', 'wt', 'F1');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const status = (dir) => readJson(path.join(dir, '.harness/features.json')).features[0].status;
const verdict = (v) => async (a) => ({ feature: a.featureId, round: a.round, verdict: v, score: v === 'pass' ? 8 : 5, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });
const OK_INTEGRITY = { markers: [], harnessPaths: [], testCount: { status: 'unset' } };
const PASSING = { pass: true, commands: [], criteria: [{ id: 'AC-1', pass: true }], integrity: OK_INTEGRITY, warnings: [] };
const build = (a) => { writeFiles(a.cwd, { 'F1.txt': 'built\n', 'X.txt': 'x\n' }); return { ok: true, costUsd: 0 }; };

const runsDir = (dir) => path.join(dir, '.harness', 'runs');
const metrics = (dir) => fs.readdirSync(runsDir(dir)).filter((n) => n.endsWith('.metrics.jsonl'))
  .flatMap((n) => fs.readFileSync(path.join(runsDir(dir), n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const stepsOf = (dir, step) => metrics(dir).filter((m) => m.feature === 'F1' && m.step === step);
const checkEvents = (dir, step) => {
  const d = path.join(dir, '.harness', 'events');
  return fs.readdirSync(d).sort().flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    .filter((e) => e.stage === 'verify' && e.type === 'check' && e.feature === 'F1' && e.data?.step === step);
};

// Leaves F1 blocked with its worktree at the integration tip (M0), re-approved.
async function leaveBlocked(dir) {
  const r = await run.runFeatures({ root: dir, config: cfg(), ids: ['F1'], deps: { build: () => ({ ok: true, costUsd: 0 }), verify: async () => PASSING, evaluate: verdict('needs-human'), cpus: 8 } });
  assert.equal(r.results[0].status, 'blocked', JSON.stringify(r.results));
  const file = path.join(dir, '.harness/features.json');
  const data = readJson(file);
  data.features[0].status = 'approved';
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return git(dir, 'rev-parse', `refs/heads/${INTEG}`);
}

// Moves integration to a new commit M1 with `files`, through a temporary worktree.
function moveIntegration(dir, files) {
  const tmp = path.join(tmpdir('harness-f145-int-'), 'w');
  git(dir, 'worktree', 'add', '-q', '--detach', tmp, INTEG);
  writeFiles(tmp, files);
  const m1 = commitAll(tmp, 'meanwhile on integration');
  git(dir, 'update-ref', `refs/heads/${INTEG}`, m1);
  git(dir, 'worktree', 'remove', '--force', tmp);
  return m1;
}

async function movedRun({ file = 'F1.txt', moved = { 'other.txt': 'o\n' }, verify, cache }) {
  const dir = fixture(file);
  const m0 = await leaveBlocked(dir);
  const m1 = moved ? moveIntegration(dir, moved) : m0;
  const r = await run.runFeatures({ root: dir, config: cfg(cache), ids: ['F1'], deps: { build, evaluate: verdict('pass'), verify, cpus: 8 } });
  return { dir, m0, m1, r };
}

test('F145 AC-1: a taken-over feature is verified on the merge-base; pre_merge_verify runs on the moved integration before the merge', async () => {
  const seen = [];
  const verify = async (a) => { seen.push({ step: a.step, base: a.base }); return PASSING; };
  const { dir, m0, m1, r } = await movedRun({ verify });
  assert.equal(status(dir), 'passed', JSON.stringify(r.results));
  assert.equal(seen.find((s) => s.step === 'verify').base, m0);
  const pre = seen.filter((s) => s.step === 'pre_merge_verify');
  assert.deepEqual(pre.map((s) => s.base), [m1]);
  const pm = stepsOf(dir, 'pre_merge_verify');
  const merge = stepsOf(dir, 'merge');
  assert.equal(pm.length, 1);
  assert.equal(merge.length, 1);
  assert.ok(pm[0].ended_at <= merge[0].started_at, 'the pre-merge verify ended before the merge');
});

test('F145 AC-2: with real verify the pre_merge_verify runs once and the post_merge_verify is a cache hit', async () => {
  const { dir, r } = await movedRun({ verify: realVerify });
  assert.equal(status(dir), 'passed', JSON.stringify(r.results));
  const pre = stepsOf(dir, 'pre_merge_verify');
  assert.equal(pre.length, 1, JSON.stringify(metrics(dir)));
  assert.equal(pre[0].outcome, 'pass');
  assert.equal(pre[0].cached, false);
  const post = stepsOf(dir, 'post_merge_verify');
  assert.equal(post.length, 1);
  assert.equal(post[0].cached, true, JSON.stringify(post));
});

test('F145 AC-3: a criterion made vacuous by the moved integration is not reused from the feature verify', async () => {
  const { dir, r } = await movedRun({ file: 'X.txt', moved: { 'X.txt': 'x\n' }, verify: realVerify, cache: 'off' });
  assert.notEqual(status(dir), 'passed', JSON.stringify(r.results));
  const ev = checkEvents(dir, 'post_merge_verify').filter((e) => e.data.id === 'AC-1');
  assert.ok(ev.length > 0, 'a post_merge_verify check event');
  for (const e of ev) {
    assert.equal(e.data.vacuous, true, JSON.stringify(e.data));
    assert.equal(e.data.vacuity_reused, false);
  }
});

test('F145 AC-4: integration not moved → feature verify base is its tip, no pre_merge_verify, vacuity reused', async () => {
  const seen = [];
  const verify = async (a) => { const v = await realVerify(a); seen.push({ step: a.step, base: a.base }); return v; };
  const { dir, m0, r } = await movedRun({ moved: null, verify, cache: 'off' });
  assert.equal(status(dir), 'passed', JSON.stringify(r.results));
  assert.equal(seen.find((s) => s.step === 'verify').base, m0);
  assert.equal(stepsOf(dir, 'pre_merge_verify').length, 0);
  const ev = checkEvents(dir, 'post_merge_verify').filter((e) => e.data.id === 'AC-1');
  assert.deepEqual(ev.map((e) => e.data.vacuity_reused), [true]);
});

test('F145 AC-5: SPEC §8 and §6.3 name the merge-base as the base of a taken-over feature', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const para = spec.split('\n').find((l) => l.startsWith('**blocked 기능 이어받기**'));
  assert.ok(para);
  assert.match(para, /merge-base/);
  assert.match(para, /pre_merge_verify|병합 전 verify/);
  const s63 = spec.slice(spec.indexOf('### 6.3'), spec.indexOf('## 7.'));
  const rule = s63.split('\n').find((l) => l.includes('병합 후 verify 의 base vacuity 재사용'));
  assert.ok(rule);
  assert.match(rule, /이어받/);
  assert.match(rule, /merge-base/);
});

test('F145 ES-1: a leftover branch with no merge base is blocked(worktree) without a build; the run goes on', async () => {
  const dir = fixture();
  await leaveBlocked(dir);
  git(wt(dir), 'checkout', '-q', '--orphan', 'tmp-orphan');
  writeFiles(wt(dir), { 'orphan.txt': 'o\n' });
  git(wt(dir), 'add', '-A');
  git(wt(dir), 'commit', '-q', '-m', 'orphan');
  git(wt(dir), 'branch', '-M', 'harness/F1');
  let builds = 0;
  const r = await run.runFeatures({ root: dir, config: cfg(), ids: ['F1'], deps: { build: () => { builds++; return { ok: true, costUsd: 0 }; }, verify: async () => PASSING, evaluate: verdict('pass'), cpus: 8 } });
  assert.deepEqual([r.results[0].status, r.results[0].reason], ['blocked', 'worktree'], JSON.stringify(r.results));
  assert.equal(builds, 0);
  assert.match(JSON.stringify(r.results[0]), /no merge base of/);
  assert.match(JSON.stringify(r.results[0]), new RegExp(INTEG));
});
