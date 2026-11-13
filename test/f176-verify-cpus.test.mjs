// F176: verify pool 'auto' is max(1, floor(cpus / 4)); verify commands get '{verify_cpus}' and
// HARNESS_VERIFY_CPUS (a run: cpus / pool size; interactive verify: all cpus). SPEC §4, §6.1, §8.10.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from './helpers.mjs';
import { gitRepo, git, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { verify } from '../lib/verify.mjs';
import { runFeatures, verifyParallelFor } from '../lib/run.mjs';
import { renderReport } from '../lib/run/report.mjs';
import { hashContract } from '../lib/contract.mjs';

const REC = [
  "import fs from 'node:fs';",
  "fs.appendFileSync(process.argv[2], JSON.stringify({ arg: process.argv[3], env: process.env.HARNESS_VERIFY_CPUS, cwd: process.cwd() }) + '\\n');",
  "console.log('# tests ' + (process.argv[4] ?? '3'));",
].join('\n') + '\n';

const logFile = () => path.join(fs.realpathSync.native(tmpdir('harness-f176-log-')), 'log.jsonl');
const lines = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function contract(checks = []) {
  const c = {
    id: 'F9', title: 'fixture', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'c', check: checks[0] ?? 'node -e "process.exit(0)"', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-26T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function repo(check) {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': contract(check ? [check] : []),
    'scripts/rec.mjs': REC,
  });
  writeFiles(dir, { 'feature.txt': 'x\n' });
  commitAll(dir, 'feature');
  return dir;
}

const cfg = (verifyExtra) => resolveConfig({
  base_branch: 'main', verify: { commands: [], cache: 'off', ...verifyExtra }, budget: { step_timeout_sec: 60 },
});

test('F176 AC-1: verify_parallel auto is max(1, floor(cpus / 4)); an integer stays; the report header says so', () => {
  for (const [cpus, n] of [[8, 2], [4, 1], [16, 4], [2, 1], [1, 1], [7, 1]]) {
    assert.equal(verifyParallelFor('auto', cpus), n);
    assert.equal(verifyParallelFor(undefined, cpus), n);
  }
  assert.equal(verifyParallelFor(5, 4), 5);
  assert.equal(verifyParallelFor(1, 64), 1);
  const md = renderReport({
    runId: 'r', startedAt: 's', config: { integration_branch: 'i', base_branch: 'main' }, results: [],
    verifyParallel: { value: 4, auto: true, cpus: 16 },
  }, { finishedAt: 'f' });
  assert.match(md, /- verify parallel: 4 \(auto: 16 CPUs \/ 4\)\n/);
  const explicit = renderReport({
    runId: 'r', startedAt: 's', config: { integration_branch: 'i', base_branch: 'main' }, results: [],
    verifyParallel: { value: 2, auto: false, cpus: 16 },
  }, { finishedAt: 'f' });
  assert.match(explicit, /- verify parallel: 2\n/);
});

test('F176 AC-2: harness run replaces {verify_cpus} with cpus / pool size and sets HARNESS_VERIFY_CPUS', async () => {
  for (const [vp, cpus, want] of [['auto', 16, '4'], [4, 10, '2'], [4, 2, '1']]) {
    const log = logFile();
    const dir = repo();
    // The feature's own files are committed on the integration branch by the run; a fresh feature
    // with nothing to build is enough: the run's verify steps are what is observed.
    git(dir, 'checkout', '-q', 'main');
    const c = {
      ...cfg({ commands: [`node scripts/rec.mjs ${JSON.stringify(log)} {verify_cpus} and-{verify_cpus}`] }),
      run: { max_parallel: 1, verify_parallel: vp },
    };
    const build = async (a) => { writeFiles(a.cwd, { 'F9.txt': 'built\n' }); return { ok: true, costUsd: 0 }; };
    const evaluate = async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });
    await runFeatures({ root: dir, config: c, deps: { build, evaluate, cpus } });
    const got = lines(log);
    assert.ok(got.length >= 2, `commands ran (${got.length})`);
    for (const l of got) {
      assert.equal(l.arg, want);
      assert.equal(l.env, want);
    }
  }
});

test('F176 AC-3: interactive verify uses all CPUs for {verify_cpus} and HARNESS_VERIFY_CPUS', async () => {
  const log = logFile();
  const dir = repo();
  const config = cfg({ commands: [`node scripts/rec.mjs ${JSON.stringify(log)} {verify_cpus}`] });
  await verify({ root: dir, featureId: 'F9', base: 'main', config, cpus: 6 });
  assert.deepEqual(lines(log).map((l) => [l.arg, l.env]), [['6', '6']]);
  const log0 = logFile();
  await verify({ root: dir, featureId: 'F9', base: 'main', config: cfg({ commands: [`node scripts/rec.mjs ${JSON.stringify(log0)} {verify_cpus}`] }), cpus: 0 });
  assert.deepEqual(lines(log0).map((l) => [l.arg, l.env]), [['1', '1']]);
});

test('F176 AC-4: a command without {verify_cpus} is unchanged; from:commands[i] counts the changed command, on base too', async () => {
  const log = logFile();
  const dir = repo();
  const plain = `node scripts/rec.mjs ${JSON.stringify(log)} plain 7`;
  const r = await verify({ root: dir, featureId: 'F9', base: 'main', config: cfg({ commands: [plain] }), cpus: 8, verifyCpus: 3 });
  assert.equal(r.commands[0].cmd, plain);
  assert.deepEqual(lines(log).map((l) => [l.arg, l.env]), [['plain', '3']]);

  const log2 = logFile();
  const sub = `node scripts/rec.mjs ${JSON.stringify(log2)} {verify_cpus} 5`;
  const r2 = await verify({ root: dir, featureId: 'F9', base: 'main', config: cfg({ commands: [sub], test_count: 'from:commands[0]' }), cpus: 8, verifyCpus: 3 });
  assert.equal(r2.integrity.testCount.head, 5);
  assert.equal(r2.integrity.testCount.base, 5);
  const got = lines(log2);
  assert.equal(got.length, 2, 'head and base runs');
  assert.ok(got.every((l) => l.arg === '3' && l.env === '3'));
  assert.notEqual(got[0].cwd, got[1].cwd);
});

test('F176 ES-2: a criterion check is run as written (no {verify_cpus} replacement)', async () => {
  const log = logFile();
  const check = `node scripts/rec.mjs ${JSON.stringify(log)} {verify_cpus}`;
  const dir = repo(check);
  const vlog = logFile();
  const vcmd = `node scripts/rec.mjs ${JSON.stringify(vlog)} {verify_cpus}`;
  const r = await verify({ root: dir, featureId: 'F9', base: 'main', config: cfg({ commands: [vcmd] }), cpus: 8, verifyCpus: 3 });
  assert.equal(r.criteria[0].check, check);
  assert.ok(lines(log).length >= 1);
  assert.ok(lines(log).every((l) => l.arg === '{verify_cpus}'));
  // contrast: the verify command, unlike the check, is replaced
  assert.ok(lines(vlog).length >= 1);
  assert.ok(lines(vlog).every((l) => l.arg === '3'));
});

test('F176 AC-5: SPEC §8.10 explains the new auto formula and the {verify_cpus} rule; §4 or §6 names the placeholder', () => {
  const spec = fs.readFileSync(new URL('../docs/SPEC.md', import.meta.url), 'utf8');
  const pool = spec.split('\n').find((l) => l.startsWith('- **verify 풀**'));
  assert.ok(pool, 'verify pool paragraph');
  assert.match(pool, /floor\(CPU 수 \/ 4\)/);
  assert.doesNotMatch(pool, /floor\(CPU 수 \/ 8\)/);
  assert.match(pool, /\{verify_cpus\}/);
  assert.match(pool, /HARNESS_VERIFY_CPUS/);
  assert.match(pool, /F176/);
  const before = spec.slice(0, spec.indexOf('**병렬 실행**'));
  assert.match(before, /\{verify_cpus\}/);
});
