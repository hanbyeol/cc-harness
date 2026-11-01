// F155 (helpers copied from F143): harness run deletes feature branches with `git update-ref -d` (never `branch -D`), so a run
// does not rewrite .git/config (lock file + rename), which fails concurrent unlocked git reads on Windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from './helpers.mjs';
import { git, gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import * as run from '../lib/run.mjs';

const quoted = (p) => JSON.stringify(p.split(path.sep).join('/'));

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id}.txt exists`, check: `node scripts/has.mjs ${quoted(`${id}.txt`)}`, new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-18T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture(ids = ['F1']) {
  const files = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\nruns/test-count-cache.json\nruns/verify-cache.json\n',
    '.harness/features.json': { features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: 'standard', depends_on: [], status: 'approved' })) },
    'scripts/has.mjs': "import fs from 'node:fs';\nprocess.exit(process.argv.slice(2).every((f) => fs.existsSync(f)) ? 0 : 1);\n",
    'shared.txt': 'original\n',
  };
  for (const id of ids) files[`.harness/contracts/${id}.json`] = contract(id);
  return gitRepo(files, { branch: null });
}

const cfg = (over = {}) => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, ...over });
const evaluate = async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });
const build = async (a) => { writeFiles(a.cwd, { [`${a.featureId}.txt`]: 'built\n' }); return { ok: true, costUsd: 0 }; };
const failBuild = async () => { throw new Error('builder must not be called'); };
const runF = (dir, deps = {}, extra = {}) => run.runFeatures({ root: dir, config: cfg(extra.config), ids: extra.ids, fresh: extra.fresh, deps: { evaluate, build, cpus: 8, ...deps } });
const statusOf = (dir, id = 'F1') => JSON.parse(fs.readFileSync(path.join(dir, '.harness/features.json'), 'utf8')).features.find((f) => f.id === id).status;
const resultOf = (r, id = 'F1') => r.results.find((x) => x.feature === id);
const hasRef = (dir, ref) => spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: dir }).status === 0;
const configFile = (dir) => path.join(dir, '.git', 'config');
const snap = (dir) => {
  const f = configFile(dir);
  const st = fs.statSync(f, { bigint: true });
  return { ino: st.ino, mtimeMs: st.mtimeMs, text: fs.readFileSync(f, 'utf8') };
};
const wtDir = (dir, id) => path.join(dir, '.harness', 'wt', id);

function recordingGit(override) {
  const calls = [];
  const fn = async (args, cwd, opts) => {
    calls.push(args);
    const o = override?.(args, cwd);
    if (o) return o;
    return run.git(args, cwd, opts);
  };
  fn.calls = calls;
  return fn;
}


const isRm = (a) => a[0] === 'worktree' && a[1] === 'remove' && /F\d+$/.test(a[a.length - 1].replace(/[\\/]+$/, ''));
const isDel = (a) => a[0] === 'update-ref' && a.includes('-d');
const fail = (pred, stderr, times = Infinity) => {
  let n = 0;
  return (args) => (pred(args) && (n += 1) <= times ? { code: 1, stdout: '', stderr } : null);
};
const count = (g, pred) => g.calls.filter(pred).length;
// The report lists state.warnings; the run state file is removed at the end of a run.
const reportBody = (r) => (r.report && fs.existsSync(r.report) ? fs.readFileSync(r.report, 'utf8') : String(r.report));
const warnsOf = (r) => {
  const body = reportBody(r);
  const at = body.indexOf('## Warnings');
  return at < 0 ? [] : body.slice(at).split('\n').slice(1).filter((l) => l.startsWith('- '));
};

test('F155 AC-1: the first worktree remove fails, the retry succeeds', async () => {
  const dir = fixture();
  const g = recordingGit(fail(isRm, 'locked', 1));
  const r = await runF(dir, { git: g });
  assert.equal(resultOf(r).status, 'passed');
  assert.equal(count(g, isRm), 2);
  assert.equal(hasRef(dir, 'refs/heads/harness/F1'), false);
  assert.equal(fs.existsSync(wtDir(dir, 'F1')), false);
});

test('F155 AC-2: the first update-ref -d fails, the retry succeeds with the same arguments', async () => {
  const dir = fixture();
  const g = recordingGit(fail(isDel, 'ref locked', 1));
  const r = await runF(dir, { git: g });
  assert.equal(resultOf(r).status, 'passed');
  const dels = g.calls.filter(isDel);
  assert.equal(dels.length, 2);
  assert.deepEqual(dels[0], dels[1]);
  assert.equal(hasRef(dir, 'refs/heads/harness/F1'), false);
});

test('F155 AC-3: worktree remove always fails: 3 calls, no update-ref -d, one warning', async () => {
  const dir = fixture();
  const g = recordingGit(fail(isRm, 'locked by test'));
  const r = await runF(dir, { git: g });
  assert.equal(resultOf(r).status, 'passed');
  assert.equal(count(g, isRm), 3);
  assert.equal(count(g, isDel), 0);
  assert.equal(hasRef(dir, 'refs/heads/harness/F1'), true);
  const w = warnsOf(r).filter((x) => x.includes('F1: merged, but could not remove worktree'));
  assert.equal(w.length, 1);
  assert.match(w[0], /locked by test/);
});

test('F155 SC-2: worktree remove always fails: update-ref -d is never called', async () => {
  const dir = fixture();
  const g = recordingGit(fail(isRm, 'locked by test'));
  await runF(dir, { git: g });
  assert.equal(count(g, isDel), 0);
  assert.equal(hasRef(dir, 'refs/heads/harness/F1'), true);
});

test('F155 AC-4: update-ref -d always fails: 3 calls, branch kept, one warning', async () => {
  const dir = fixture();
  const g = recordingGit(fail(isDel, 'ref locked'));
  const r = await runF(dir, { git: g });
  assert.equal(resultOf(r).status, 'passed');
  assert.equal(count(g, isDel), 3);
  assert.equal(hasRef(dir, 'refs/heads/harness/F1'), true);
  const w = warnsOf(r).filter((x) => x.includes('F1: merged, but could not delete branch harness/F1'));
  assert.equal(w.length, 1);
  assert.match(w[0], /ref locked/);
});

test('F155 AC-5: successful cleanup is called once per feature and does not warn', async () => {
  const dir = fixture(['F1', 'F2']);
  const g = recordingGit();
  const r = await runF(dir, { git: g }, { config: { run: { max_parallel: 2 } } });
  assert.equal(count(g, isRm), 2);
  assert.equal(count(g, isDel), 2);
  assert.deepEqual(warnsOf(r).filter((x) => x.includes('could not')), []);
});

test('F155 AC-6: SPEC §8.10 describes the cleanup retry and the warning', () => {
  const spec = fs.readFileSync(new URL('../docs/SPEC.md', import.meta.url), 'utf8');
  const p = spec.split('\n').find((l) => l.includes('worktree remove') && l.includes('update-ref -d') && l.includes('could not') && l.includes('3'));
  assert.ok(p);
});

test('F155 SC-1: the retried update-ref -d keeps the first sha; a moved branch stays', async () => {
  const dir = fixture();
  const g = recordingGit();
  let n = 0;
  const g2 = async (args, cwd, opts) => {
    if (isDel(args)) {
      n += 1;
      if (n === 1) {
        git(dir, 'update-ref', 'refs/heads/harness/F1', git(dir, 'rev-parse', 'refs/heads/harness/integration'));
        g.calls.push(args);
        return { code: 1, stdout: '', stderr: 'ref locked' };
      }
    }
    return g(args, cwd, opts);
  };
  g2.calls = g.calls;
  const moved = () => git(dir, 'rev-parse', 'refs/heads/harness/F1');
  await runF(dir, { git: g2 });
  const dels = g.calls.filter(isDel);
  assert.ok(dels.length >= 2);
  assert.ok(dels.every((x) => x[3] === dels[0][3]));
  assert.notEqual(moved(), dels[0][3]);
  assert.equal(hasRef(dir, 'refs/heads/harness/F1'), true);
});

test('F155 SC-3: the wait between retries is outside the git lock', async () => {
  const dir = fixture(['F1', 'F2']);
  const times = [];
  const g = async (args, cwd, opts) => {
    if (isRm(args) && args[3].includes('F1')) {
      times.push(['rm', Date.now()]);
      return { code: 1, stdout: '', stderr: 'locked' };
    }
    if (args[0] === 'merge' || (args[0] === 'worktree' && args[1] === 'add')) times.push([args[0], Date.now()]);
    return run.git(args, cwd, opts);
  };
  const r = await runF(dir, { git: g }, { config: { run: { max_parallel: 2 } } });
  assert.equal(resultOf(r, 'F2').status, 'passed');
  const rms = times.filter((t) => t[0] === 'rm').map((t) => t[1]);
  assert.equal(rms.length, 3);
  // F2 ran serialized git (rm of F2 at least) between F1's first and last attempt, or F2 finished before; both leave F1's waits unlocked.
  assert.ok(rms[2] > rms[0]);
});

test('F155 ES-1: the report lists the cleanup warning under Warnings', async () => {
  const dir = fixture();
  const g = recordingGit(fail(isRm, 'locked by test'));
  const r = await runF(dir, { git: g });
  const body = reportBody(r);
  const warn = body.slice(body.indexOf('## Warnings'));
  assert.ok(body.includes('## Warnings'));
  assert.match(warn, /F1: merged, but could not remove worktree/);
});
