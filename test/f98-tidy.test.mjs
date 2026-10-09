import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import * as config from '../lib/config.mjs';
import * as metrics from '../lib/metrics.mjs';
import * as util from '../lib/util.mjs';
import { hashContract } from '../lib/contract.mjs';
import { runFeatures } from '../lib/run.mjs';

function libFiles(dir = path.join(REPO, 'lib')) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? libFiles(p) : e.name.endsWith('.mjs') ? [p] : [];
  });
}
const lib = (rel) => fs.readFileSync(path.join(REPO, 'lib', rel), 'utf8');
// The names a module imports from `from` (a relative specifier), across all its import statements.
function importedFrom(src, from) {
  const names = [];
  const re = /import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m[2] === from) names.push(...m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean));
  }
  return names;
}

// ------------------------------------------------------------------ AC-1

test('F98 AC-1 util.finite: a finite number stays, anything else is null', () => {
  assert.equal(typeof util.finite, 'function');
  for (const v of [1, 0, -2.5]) assert.equal(util.finite(v), v);
  for (const v of [NaN, Infinity, -Infinity, '1', null, undefined]) assert.equal(util.finite(v), null, String(v));
});

test('F98 AC-1 metrics.mjs and usage.mjs import finite from util.mjs and do not define it', () => {
  for (const f of ['metrics.mjs', 'usage.mjs']) {
    const src = lib(f);
    assert.doesNotMatch(src, /(const|let|function)\s+finite\b/, f);
    assert.ok(importedFrom(src, './util.mjs').includes('finite'), f);
  }
});

// ------------------------------------------------------------------ AC-2

test('F98 AC-2 maxRoundsOf: a positive integer max_rounds, otherwise 3', () => {
  assert.equal(typeof config.maxRoundsOf, 'function');
  assert.equal(config.maxRoundsOf({ max_rounds: 5 }), 5);
  assert.equal(config.maxRoundsOf({ max_rounds: 1 }), 1);
  for (const v of [0, -1, 2.5, '4', undefined, null]) assert.equal(config.maxRoundsOf({ max_rounds: v }), 3, String(v));
  assert.equal(config.maxRoundsOf({}), 3);
});

test('F98 AC-2 eval-status, approve and run take the round limit from maxRoundsOf; no lib file repeats the fallback', () => {
  for (const [f, from] of [['eval-status.mjs', './config.mjs'], ['commands/approve.mjs', '../config.mjs'], ['run.mjs', './config.mjs']]) {
    const src = lib(f);
    assert.ok(importedFrom(src, from).includes('maxRoundsOf'), f);
    assert.match(src, /maxRoundsOf\(/, f);
  }
  const found = libFiles().filter((f) => fs.readFileSync(f, 'utf8').includes('max_rounds > 0 ?')).map((f) => path.relative(REPO, f));
  assert.deepEqual(found, []);
});

// ------------------------------------------------------------------ AC-3

test('F98 AC-3 metrics.mjs does not export median; no lib file imports median from metrics.mjs', () => {
  assert.equal('median' in metrics, false);
  const found = libFiles().filter((f) => {
    const src = fs.readFileSync(f, 'utf8');
    return ['./metrics.mjs', '../metrics.mjs'].some((s) => importedFrom(src, s).includes('median'));
  }).map((f) => path.relative(REPO, f));
  assert.deepEqual(found, []);
  for (const f of ['metrics.mjs', 'learn.mjs']) assert.ok(importedFrom(lib(f), './util.mjs').includes('median'), f);
});

// ------------------------------------------------------------------ AC-4

test('F98 AC-4 no lib .mjs file has two or more blank lines in a row', () => {
  const found = [];
  for (const f of libFiles()) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === '' && lines[i - 1].trim() === '' && i < lines.length - 1) found.push(`${path.relative(REPO, f)}:${i + 1}`);
    }
  }
  assert.deepEqual(found, []);
});

// ------------------------------------------------------------------ AC-5

const SPEC = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8').split('\n');
const specLine = (marker) => {
  const l = SPEC.find((x) => x.includes(marker));
  assert.ok(l, `SPEC line with ${marker}`);
  return l;
};

test('F98 AC-5 SPEC §7.6: blocked_reason lists have no dependency_blocked; a skipped dependent ends as skipped', () => {
  const l = specLine('**blocked 사유와 재승인**');
  const values = l.match(/그 상태 이벤트의 reason 과 같은 값\(([^)]*)\)이고/);
  const others = l.match(/그 밖의 사유\(([^)]*)\)면/);
  assert.ok(values && others, 'both blocked_reason lists');
  assert.equal(values[1].includes('dependency_blocked'), false, 'dependency_blocked is still a blocked_reason value');
  assert.equal(others[1].includes('dependency_blocked'), false, 'dependency_blocked is still an other reason');
  assert.match(values[1], /`run_stopped`/);
  assert.match(others[1], /`run_stopped`/);
  assert.match(l, /건너뛴 기능은[^.]*status `skipped`/);
});

test('F98 AC-5 SPEC §8.11: criteria_status error outcome and pre_merge_verify in the queue_ms and cached sentences', () => {
  const l = specLine('`harness run` 은 단계가 끝날 때마다');
  assert.match(l, /`criteria_status`\(.*`error`.*치명적이지 않은 예외/);
  assert.match(l, /치명적이지 않은 예외[^.]*기준 상태 (절|섹션) 없이/);
  assert.ok(l.includes('`queue_ms`(`verify`·`pre_merge_verify`·`post_merge_verify` 줄은'), 'queue_ms sentence');
  assert.ok(l.includes('`cached`(`verify`·`pre_merge_verify`·`post_merge_verify` 줄은'), 'cached sentence');
});

// ------------------------------------------------------------------ ES-1

function contract() {
  const c = {
    id: 'F9', title: 'fixture feature', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'one', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-09T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

const PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };

for (const [maxRounds, expected] of [[2, 2], [undefined, 3], [0, 3]]) {
  test(`F98 ES-1 run with max_rounds ${maxRounds}: blocked (rounds) after ${expected} rounds`, async () => {
    const dir = gitRepo({
      '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
      '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
      '.harness/contracts/F9.json': contract(),
      '.harness/backlog.json': { items: [] },
      '.harness/.gitignore': 'wt/\n*.tmp-*\n',
      'scripts/ok.mjs': 'process.exit(0);\n',
      'scripts/fail.mjs': 'process.exit(3);\n',
    }, { branch: null });
    let evals = 0;
    const evaluate = async (a) => {
      evals += 1;
      // A strictly shrinking failing set, so only the round limit can stop the feature.
      const ids = ['AC-1', 'SC-1', 'SC-2', 'SC-3'].slice(0, 5 - a.round);
      return {
        feature: a.featureId, round: a.round, verdict: 'fail', score: 4, scores: {}, backlogged: [], independence: 'cross-model', costUsd: 0, file: null,
        blocking: ids.map((id) => ({ criterion_id: id, dimension: 'functionality', summary: `${id} broken`, repro: 'node scripts/fail.mjs' })),
      };
    };
    const user = { base_branch: 'main', run: { max_parallel: 1 }, verify: { commands: [] }, budget: { step_timeout_sec: 60 } };
    if (maxRounds !== undefined) user.max_rounds = maxRounds;
    const r = await runFeatures({
      root: dir,
      config: { ...resolveConfig(user), ...(maxRounds !== undefined ? { max_rounds: maxRounds } : {}) },
      deps: {
        build: async (a) => { writeFiles(a.cwd, { 'F9.txt': `built r${a.round}\n` }); return { ok: true, costUsd: 0 }; },
        verify: async () => PASSING,
        evaluate,
      },
    });
    assert.deepEqual([r.results[0].status, r.results[0].reason], ['blocked', 'rounds'], JSON.stringify(r.results));
    assert.equal(evals, expected);
  });
}
