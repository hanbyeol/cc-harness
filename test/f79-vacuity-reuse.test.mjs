import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpdir, harness } from './helpers.mjs';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { verify as realVerify } from '../lib/verify.mjs';
import { runFeatures } from '../lib/run.mjs';

// F79: a run's post-merge verify reuses the feature verify's base vacuity runs when the
// integration commit before the merge is the base that feature verify judged against.

// ------------------------------------------------------------------ fixtures

// Every check and command appends "<kind> <cwd>" to the log named by its first argument, so a
// test sees where each one ran. rec.mjs exits 0 iff every further argument names an existing file.
const SCRIPTS = {
  'scripts/rec.mjs': "import fs from 'node:fs';\nconst [log, ...need] = process.argv.slice(2);\n"
    + "fs.appendFileSync(log, `check ${fs.realpathSync.native(process.cwd())}\\n`);\n"
    + 'process.exit(need.every((f) => fs.existsSync(f)) ? 0 : 1);\n',
  'scripts/cmd.mjs': "import fs from 'node:fs';\nfs.appendFileSync(process.argv[2], `command ${fs.realpathSync.native(process.cwd())}\\n`);\n",
  'scripts/count.mjs': "import fs from 'node:fs';\nfs.appendFileSync(process.argv[2], `count ${fs.realpathSync.native(process.cwd())}\\n`);\n"
    + "console.log(fs.readFileSync('tests.txt', 'utf8').split('\\n').filter(Boolean).length);\n",
  'tests.txt': 'a\nb\n',
  'doc.md': 'original\n',
};

const slash = (p) => p.split(path.sep).join('/');
const quoted = (p) => JSON.stringify(slash(p));
const logOf = (id) => path.join(tmpdir(`harness-f79-${id}-`), 'log.txt');

// AC-1 is new (F<n>.txt exists only after the build); AC-2 is not.
function contract(id, log) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [
      { id: 'AC-1', criterion: `${id}.txt exists`, check: `node scripts/rec.mjs ${quoted(log)} ${id}.txt`, new: true },
      { id: 'AC-2', criterion: 'ok', check: `node scripts/rec.mjs ${quoted(log)}`, new: false },
    ],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-06T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture(ids, { branch = null } = {}) {
  const logs = Object.fromEntries(ids.map((id) => [id, logOf(id)]));
  const state = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': {
      features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: 'standard', depends_on: [], status: 'approved' })),
    },
    ...SCRIPTS,
  };
  for (const id of ids) state[`.harness/contracts/${id}.json`] = contract(id, logs[id]);
  return { dir: gitRepo(state, { branch }), logs };
}

const cfg = (log, over = {}) => resolveConfig({
  base_branch: 'main',
  run: { max_parallel: 1, ...(over.run || {}) },
  verify: {
    commands: [`node scripts/cmd.mjs ${quoted(log)}`], test_count: `node scripts/count.mjs ${quoted(log)}`,
    check_parallel: 'auto', ...(over.verify || {}),
  },
  budget: { step_timeout_sec: 60 },
});

const real = (p) => fs.realpathSync.native(p);
// Removed when the run ends: spelled from the repo's real path, as the checks log it.
const intWt = (dir) => path.join(real(dir), '.harness', 'wt', '_integration');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const statuses = (dir) => Object.fromEntries(readJson(path.join(dir, '.harness/features.json')).features.map((f) => [f.id, f.status]));
const sha = (dir, ref) => git(dir, 'rev-parse', ref);
const events = (dir) => {
  const d = path.join(dir, '.harness', 'events');
  let names = [];
  try { names = fs.readdirSync(d).sort(); } catch { /* none */ }
  return names.flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
};
const checkEvents = (dir, feature, step) => events(dir)
  .filter((e) => e.stage === 'verify' && e.type === 'check' && e.feature === feature && e.data?.step === step);

const PASS_EVAL = async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });

// Real verify that marks each verify in the feature's log and keeps its result.
function recordingVerify(logs) {
  const results = [];
  const fn = async (a) => {
    fs.appendFileSync(logs[a.featureId], `--- ${a.step}\n`);
    const v = await realVerify(a);
    results.push({ feature: a.featureId, step: a.step, base: a.base, vacuityBase: a.vacuityBase, v });
    return v;
  };
  fn.results = results;
  return fn;
}

// The log as [{step, lines: [{kind, cwd}]}], one section per verify, in order.
function sections(log) {
  const out = [];
  for (const line of fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
    if (line.startsWith('--- ')) out.push({ step: line.slice(4), lines: [] });
    else {
      const i = line.indexOf(' ');
      out[out.length - 1]?.lines.push({ kind: line.slice(0, i), cwd: line.slice(i + 1) });
    }
  }
  return out;
}
const lastOf = (log, step) => sections(log).filter((s) => s.step === step).at(-1);
const checksOutside = (sec, cwd) => sec.lines.filter((l) => l.kind === 'check' && l.cwd !== cwd);

const build = (a) => {
  writeFiles(a.cwd, { [`${a.featureId}.txt`]: 'built\n' });
  return { ok: true, costUsd: 0 };
};

// One feature, nothing else on integration: preMergeSha is the feature verify base.
async function singleRun() {
  const { dir, logs } = fixture(['F1']);
  const verify = recordingVerify(logs);
  const r = await runFeatures({ root: dir, config: cfg(logs.F1), deps: { build: async (a) => build(a), evaluate: PASS_EVAL, verify, cpus: 8 } });
  assert.equal(statuses(dir).F1, 'passed', JSON.stringify(r.results));
  return { dir, log: logs.F1, verify, post: verify.results.find((x) => x.step === 'post_merge_verify') };
}

// ------------------------------------------------------------------ AC-1
test('F79 AC-1: post-merge verify on the feature verify base runs no base vacuity and marks the new criterion vacuity_reused', async () => {
  const { dir, log, verify, post } = await singleRun();
  const pre = verify.results.find((x) => x.step === 'verify');
  assert.equal(post.base, pre.base, 'preMergeSha is the feature verify base');
  const sec = lastOf(log, 'post_merge_verify');
  assert.ok(sec.lines.some((l) => l.kind === 'check'), 'the head checks ran');
  assert.deepEqual(checksOutside(sec, intWt(dir)), [], 'no check ran in a base worktree during post-merge verify');
  const ac1 = post.v.criteria.find((c) => c.id === 'AC-1');
  assert.equal(ac1.pass, true);
  assert.equal(ac1.vacuity_reused, true);
  assert.equal(ac1.vacuous, false);
});

// ------------------------------------------------------------------ AC-2
test('F79 AC-2: with the base vacuity reused, head checks, verify commands and test count still run in the integration worktree', async () => {
  const { dir, log, post } = await singleRun();
  const sec = lastOf(log, 'post_merge_verify');
  const where = intWt(dir);
  assert.deepEqual(sec.lines.filter((l) => l.kind === 'check').map((l) => l.cwd), [where, where], 'both head checks ran on integration');
  assert.deepEqual(sec.lines.filter((l) => l.kind === 'command').map((l) => l.cwd), [where], 'the verify command ran on integration');
  assert.ok(sec.lines.some((l) => l.kind === 'count' && l.cwd === where), 'the head test count ran on integration');
  assert.equal(post.v.pass, true);
  assert.deepEqual(post.v.integrity.markers, []);
  assert.deepEqual(post.v.integrity.harnessPaths, []);
  assert.equal(post.v.integrity.testCount.status, 'ok');
});

// Direct verify of a merged tree with a skip marker, a .harness change and fewer tests: the
// integrity checks still catch all three while the new criterion's base run is reused.
test('F79 AC-2: integrity checks still fail a post-merge verify whose base vacuity is reused', async () => {
  const { dir, logs } = fixture(['F1'], { branch: 'feature' });
  const base = sha(dir, 'main');
  writeFiles(dir, {
    'F1.txt': 'built\n',
    // Split so this file does not itself carry the marker it plants in the fixture.
    'test/a.test.mjs': `test${'.sk' + 'ip('}'x', () => {});\n`,
    '.harness/extra.json': '{}\n',
    'tests.txt': 'a\n',
  });
  commitAll(dir, 'feature');
  fs.writeFileSync(logs.F1, '--- post_merge_verify\n');
  const v = await realVerify({ root: dir, featureId: 'F1', base, config: cfg(logs.F1), cpus: 8, step: 'post_merge_verify', vacuityBase: base });
  assert.equal(v.criteria.find((c) => c.id === 'AC-1').vacuity_reused, true);
  assert.equal(v.pass, false);
  assert.ok(v.integrity.markers.some((m) => m.file === 'test/a.test.mjs'), JSON.stringify(v.integrity.markers));
  assert.deepEqual(v.integrity.harnessPaths, ['.harness/extra.json']);
  assert.equal(v.integrity.testCount.status, 'decreased');
  assert.deepEqual(sections(logs.F1)[0].lines.filter((l) => l.kind === 'command').map((l) => l.cwd), [real(dir)]);
});

// ------------------------------------------------------------------ AC-3
// F1 and F2 start together; F2's build waits until F1 is merged and verified, so F2's
// post-merge verify runs on top of F1's merge, not on F2's feature verify base.
async function parallelRun() {
  const { dir, logs } = fixture(['F1', 'F2']);
  const verify = recordingVerify(logs);
  let f1Merged;
  const merged = new Promise((resolve) => { f1Merged = resolve; });
  const wrapped = async (a) => {
    const v = await verify(a);
    if (a.featureId === 'F1' && a.step === 'post_merge_verify') f1Merged();
    return v;
  };
  const bounded = (p, ms) => Promise.race([p, new Promise((resolve) => setTimeout(resolve, ms).unref())]);
  const builder = async (a) => {
    if (a.featureId === 'F2') await bounded(merged, 120_000);
    return build(a);
  };
  const config = cfg(logs.F1, { run: { max_parallel: 2 } });
  const r = await runFeatures({ root: dir, config, deps: { build: builder, evaluate: PASS_EVAL, verify: wrapped, cpus: 8 } });
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed' }, JSON.stringify(r.results));
  return { dir, logs, verify };
}

test('F79 AC-3: when another feature merged first, post-merge verify runs the base vacuity and has no vacuity_reused', async () => {
  const { dir, logs, verify } = await parallelRun();
  const pre = verify.results.find((x) => x.feature === 'F2' && x.step === 'verify');
  const post = verify.results.find((x) => x.feature === 'F2' && x.step === 'post_merge_verify');
  assert.notEqual(post.base, pre.base, 'F1 was merged between F2 feature verify and its merge');
  const outside = checksOutside(lastOf(logs.F2, 'post_merge_verify'), intWt(dir));
  assert.ok(outside.length >= 1, 'the new criterion ran on base');
  const ac1 = post.v.criteria.find((c) => c.id === 'AC-1');
  assert.equal(ac1.pass, true);
  assert.equal('vacuity_reused' in ac1, false);
});

// ------------------------------------------------------------------ AC-4
test('F79 AC-4: the feature verify of a run always runs the base vacuity', async () => {
  const { dir, log, verify } = await singleRun();
  const pre = verify.results.find((x) => x.step === 'verify');
  assert.ok(checksOutside(lastOf(log, 'verify'), path.join(real(dir), '.harness', 'wt', 'F1')).length >= 1, 'the new criterion ran on base');
  assert.equal('vacuity_reused' in pre.v.criteria.find((c) => c.id === 'AC-1'), false);
});

test('F79 AC-4: verify with step verify runs the base vacuity even when given a matching vacuityBase', async () => {
  const { dir, logs } = fixture(['F1'], { branch: 'feature' });
  const base = sha(dir, 'main');
  writeFiles(dir, { 'F1.txt': 'built\n' });
  commitAll(dir, 'feature');
  fs.writeFileSync(logs.F1, '--- verify\n');
  const v = await realVerify({ root: dir, featureId: 'F1', base, config: cfg(logs.F1), cpus: 8, step: 'verify', vacuityBase: base });
  assert.equal(v.pass, true, JSON.stringify(v.criteria));
  assert.equal('vacuity_reused' in v.criteria[0], false);
  assert.ok(checksOutside(sections(logs.F1)[0], real(dir)).length >= 1, 'the new criterion ran on base');
});

test('F79 AC-4: harness verify F{n} runs the base vacuity', async () => {
  const { dir, logs } = fixture(['F1'], { branch: 'feature' });
  writeFiles(dir, { 'F1.txt': 'built\n' });
  commitAll(dir, 'feature');
  fs.writeFileSync(logs.F1, '--- cli\n');
  const r = harness(['verify', 'F1', '--base', 'main'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(checksOutside(sections(logs.F1)[0], real(dir)).length >= 1, 'the new criterion ran on base');
});

// ------------------------------------------------------------------ AC-5
test('F79 AC-5: post-merge check events carry vacuity_reused, and a reused criterion has base_retry false', async () => {
  const { dir } = await singleRun();
  const post = checkEvents(dir, 'F1', 'post_merge_verify');
  assert.deepEqual(post.map((e) => [e.data.id, e.data.vacuity_reused, e.data.base_retry]), [['AC-1', true, false], ['AC-2', false, false]]);
  const pre = checkEvents(dir, 'F1', 'verify');
  assert.ok(pre.length > 0 && pre.every((e) => !('vacuity_reused' in e.data)), 'feature verify events are unchanged');
});

test('F79 AC-5: a post-merge verify that ran the base vacuity records vacuity_reused false', async () => {
  const { dir } = await parallelRun();
  const post = checkEvents(dir, 'F2', 'post_merge_verify');
  assert.deepEqual(post.map((e) => [e.data.id, e.data.vacuity_reused]), [['AC-1', false], ['AC-2', false]]);
});

// ------------------------------------------------------------------ AC-6
test('F79 AC-6: SPEC §6.3 describes the post-merge base vacuity reuse and vacuity_reused', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s63 = spec.slice(spec.indexOf('### 6.3'), spec.indexOf('## 7.'));
  assert.ok(s63.length > 0);
  const rule = s63.split('\n').find((l) => l.includes('병합 후 verify 의 base vacuity 재사용'));
  assert.ok(rule, 'a §6.3 rule for the post-merge reuse');
  assert.match(rule, /preMergeSha/);
  assert.match(rule, /baseSha/);
  assert.match(rule, /vacuity_reused: true/);
  assert.match(rule, /verify\/check/);
  assert.match(spec, /`post_merge_verify` 의 `verify\/check` 에는\s+`vacuity_reused`/);
});

// ------------------------------------------------------------------ ES-1
test('F79 ES-1: a missing or unresolvable feature verify base runs the base vacuity', async () => {
  for (const vacuityBase of [undefined, null, '0123456789abcdef0123456789abcdef01234567', 'not a commit', '--all']) {
    const { dir, logs } = fixture(['F1'], { branch: 'feature' });
    const base = sha(dir, 'main');
    writeFiles(dir, { 'F1.txt': 'built\n' });
    commitAll(dir, 'feature');
    fs.writeFileSync(logs.F1, '--- post_merge_verify\n');
    const v = await realVerify({ root: dir, featureId: 'F1', base, config: cfg(logs.F1), cpus: 8, step: 'post_merge_verify', vacuityBase });
    assert.equal(v.pass, true, String(vacuityBase));
    assert.equal('vacuity_reused' in v.criteria[0], false, String(vacuityBase));
    assert.ok(checksOutside(sections(logs.F1)[0], real(dir)).length >= 1, `base run for ${vacuityBase}`);
  }
});

test('F79 ES-1: a run resumed from a state without baseSha runs the base vacuity in post-merge verify', async () => {
  const { dir, logs } = fixture(['F1']);
  const controller = new AbortController();
  const first = recordingVerify(logs);
  // The first post-merge verify is interrupted: the merge is done, the verify is not.
  const interrupt = async (a) => {
    if (a.step === 'post_merge_verify') {
      controller.abort();
      return first({ ...a, signal: controller.signal });
    }
    return first(a);
  };
  const r1 = await runFeatures({ root: dir, config: cfg(logs.F1), signal: controller.signal, deps: { build: async (a) => build(a), evaluate: PASS_EVAL, verify: interrupt, cpus: 8 } });
  assert.equal(r1.interrupted, true, JSON.stringify(r1));
  const file = path.join(dir, '.harness', 'runs', 'current.json');
  const saved = readJson(file);
  const e = saved.current?.feature === 'F1' ? saved.current : Object.values(saved).flat().find((x) => x?.feature === 'F1');
  assert.ok(e && e.baseSha && e.preMergeSha, JSON.stringify(saved));
  // A state written before F79 has the same shape; drop baseSha as a pre-baseSha state would.
  fs.writeFileSync(file, JSON.stringify(saved, (k, val) => (k === 'baseSha' ? null : val)));
  const second = recordingVerify(logs);
  const r2 = await runFeatures({ root: dir, resume: true, deps: { build: async (a) => build(a), evaluate: PASS_EVAL, verify: second, cpus: 8 } });
  assert.equal(statuses(dir).F1, 'passed', JSON.stringify(r2.results));
  const post = second.results.find((x) => x.step === 'post_merge_verify');
  assert.ok(post, 'resume re-verified the merge');
  assert.equal('vacuity_reused' in post.v.criteria.find((c) => c.id === 'AC-1'), false);
  assert.ok(checksOutside(lastOf(logs.F1, 'post_merge_verify'), intWt(dir)).length >= 1, 'the new criterion ran on base');
});

// ------------------------------------------------------------------ ES-2
// F1's merge conflicts on doc.md; the resolving builder merges integration. With `landLater`,
// one more commit lands on integration during the resolution, after the commit it merged.
async function conflictRun({ landLater }) {
  const { dir, logs } = fixture(['F1']);
  const verify = recordingVerify(logs);
  const integration = path.join(dir, '.harness', 'wt', '_integration');
  const builder = async (a) => {
    if (a.conflicts) {
      if (landLater) {
        writeFiles(integration, { 'other.txt': 'later\n' });
        commitAll(integration, 'later on integration');
      }
      writeFiles(a.cwd, { 'doc.md': 'resolved\n' });
    } else {
      writeFiles(integration, { 'doc.md': 'changed on integration\n' });
      commitAll(integration, 'meanwhile on integration');
      writeFiles(a.cwd, { 'F1.txt': 'built\n', 'doc.md': 'changed by F1\n' });
    }
    return { ok: true, costUsd: 0 };
  };
  const r = await runFeatures({ root: dir, config: cfg(logs.F1), deps: { build: builder, evaluate: PASS_EVAL, verify, cpus: 8 } });
  assert.equal(statuses(dir).F1, 'passed', JSON.stringify(r.results));
  const pre = verify.results.filter((x) => x.step === 'verify').at(-1);
  const post = verify.results.filter((x) => x.step === 'post_merge_verify').at(-1);
  return { dir, log: logs.F1, pre, post, verify };
}

test('F79 ES-2: after a conflict resolution the post-merge verify compares the updated baseSha with the new preMergeSha', async () => {
  const same = await conflictRun({ landLater: false });
  assert.equal(same.post.base, same.pre.base, 'nothing landed: the resolved base is the pre-merge commit');
  assert.equal(same.post.vacuityBase, same.pre.base, 'the updated baseSha is passed');
  assert.equal(same.post.v.criteria.find((c) => c.id === 'AC-1').vacuity_reused, true);
  assert.deepEqual(checksOutside(lastOf(same.log, 'post_merge_verify'), intWt(same.dir)), []);

  const moved = await conflictRun({ landLater: true });
  assert.notEqual(moved.post.base, moved.pre.base, 'a commit landed after the resolved base');
  assert.equal(moved.post.vacuityBase, moved.pre.base);
  assert.equal('vacuity_reused' in moved.post.v.criteria.find((c) => c.id === 'AC-1'), false);
  assert.ok(checksOutside(lastOf(moved.log, 'post_merge_verify'), intWt(moved.dir)).length >= 1, 'the new criterion ran on base');
});
