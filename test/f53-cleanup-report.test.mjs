// F53: the integration-worktree cleanup reports the paths it discards (AC-1, ES-1), lint-contract
// rule 3's '절대' judgement (AC-2) and its SPEC §5 explanation (AC-3).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, gitRepo, writeFiles } from './gitfixture.mjs';
import { REPO } from './helpers.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract, matchedForbidden } from '../lib/contract.mjs';
import * as run from '../lib/run.mjs';

// ------------------------------------------------------------------ fixtures

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-27T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture(ids) {
  const state = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': {
      features: ids.map((id) => ({ id, title: `feature ${id}`, security_tier: 'standard', depends_on: [], status: 'approved' })),
    },
    'scripts/ok.mjs': 'process.exit(0);\n',
    'doc.md': 'original\n',
  };
  for (const id of ids) state[`.harness/contracts/${id}.json`] = contract(id);
  return gitRepo(state, { branch: null });
}

const cfg = () => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 } });
const isIntegration = (cwd) => fs.realpathSync.native(cwd).endsWith(`${path.sep}_integration`);
const resultOf = (r, id) => r.results.find((x) => x.feature === id);

const OK_INTEGRITY = { markers: [], harnessPaths: [], testCount: { status: 'unset' } };
const PASSING = { pass: true, commands: [], criteria: [{ id: 'AC-1', pass: true }], integrity: OK_INTEGRITY, warnings: [] };
const evaluate = async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });
const build = async (a) => {
  writeFiles(a.cwd, { [`${a.featureId}.txt`]: 'built\n' });
  return { ok: true, costUsd: 0 };
};

async function runWith(ids, verify) {
  const dir = fixture(ids);
  const logs = [];
  const r = await run.runFeatures({
    root: dir, config: cfg(), parallel: 1,
    deps: { evaluate, build, verify, cpus: 8, log: (m) => logs.push(m) },
  });
  return { dir, r, logs, report: fs.readFileSync(r.report, 'utf8') };
}

const warningsSection = (report) => {
  const m = report.match(/## Warnings\n([\s\S]*?)(\n## |$)/);
  return m ? m[1] : '';
};

// ------------------------------------------------------------------ AC-1

test('F53 AC-1: a changed tracked file and an untracked file discarded by the cleanup are both reported in the run output and the report', async () => {
  const verify = async (a) => {
    if (isIntegration(a.cwd) && a.featureId === 'F1') writeFiles(a.cwd, { 'artifact.log': 'left by verify\n', 'doc.md': 'changed by verify\n' });
    return PASSING;
  };
  const { r, logs, report } = await runWith(['F1', 'F2'], verify);
  assert.equal(resultOf(r, 'F2').status, 'passed', JSON.stringify(r.results));
  const line = logs.find((l) => l.includes('discarded'));
  assert.ok(line, logs.join('\n'));
  assert.match(line, /integration worktree/);
  assert.match(line, /doc\.md/);
  assert.match(line, /artifact\.log/);
  const warnings = warningsSection(report);
  assert.match(warnings, /discarded/, report);
  assert.match(warnings, /doc\.md/);
  assert.match(warnings, /artifact\.log/);
});

test('F53 AC-1: more than 50 discarded paths list the first 50 and "… N more"', async () => {
  const verify = async (a) => {
    if (isIntegration(a.cwd) && a.featureId === 'F1') {
      const files = {};
      for (let i = 0; i < 60; i += 1) files[`junk/f${String(i).padStart(2, '0')}.log`] = 'x\n';
      writeFiles(a.cwd, files);
    }
    return PASSING;
  };
  const { r, logs, report } = await runWith(['F1', 'F2'], verify);
  assert.equal(resultOf(r, 'F2').status, 'passed', JSON.stringify(r.results));
  const line = logs.find((l) => l.includes('discarded'));
  assert.ok(line, logs.join('\n'));
  assert.equal((line.match(/junk\/f\d\d\.log/g) || []).length, 50, line);
  assert.match(line, /… 10 more/);
  const warnings = warningsSection(report);
  assert.equal((warnings.match(/junk\/f\d\d\.log/g) || []).length, 50, warnings);
  assert.match(warnings, /… 10 more/);
});

// ------------------------------------------------------------------ ES-1

test('F53 ES-1: a clean integration worktree leaves no cleanup warning', async () => {
  const { r, logs, report } = await runWith(['F1', 'F2'], async () => PASSING);
  assert.equal(resultOf(r, 'F2').status, 'passed', JSON.stringify(r.results));
  assert.ok(!logs.some((l) => l.includes('discarded')), logs.join('\n'));
  assert.doesNotMatch(report, /discarded/);
  assert.doesNotMatch(report, /## Warnings/);
});

// ------------------------------------------------------------------ AC-2

const AC2_ERRORS = [
  ['e1', '절대로 경로를 바꾸지 않는다'],
  ['e2', '이 값은 절대 변경되지 않는다'],
  ['e3', '절대로실패하지 않는다'],
];
const AC2_PASSES = [
  ['p1', '입력은 절대 경로 또는 절대경로여야 한다'],
  ['p2', '결과는 절대값으로 비교한다'],
  ['p3', '절대적 기준으로 판정한다'],
];

for (const [tag, sentence] of AC2_ERRORS) {
  test(`F53 AC-2 ${tag}: "${sentence}" is a universal-negation error`, () => {
    assert.deepEqual(matchedForbidden(sentence), ['절대'], sentence);
  });
}

for (const [tag, sentence] of AC2_PASSES) {
  test(`F53 AC-2 ${tag}: "${sentence}" is not a universal-negation error`, () => {
    assert.deepEqual(matchedForbidden(sentence), [], sentence);
  });
}

// ------------------------------------------------------------------ AC-3

test('F53 AC-3: SPEC §5 rule 3 explains the 절대 judgement with examples', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const start = spec.indexOf('## 5.');
  const end = spec.indexOf('## 6.');
  const section = spec.slice(start, end === -1 ? undefined : end);
  const line = section.split('\n').find((l) => l.startsWith('3. **전칭 부정 금지**'));
  assert.ok(line, 'no rule 3 line in §5');
  for (const s of ['절대로 경로를 바꾸지 않는다', '절대 경로', '절대경로', '절대값', '절대적']) {
    assert.ok(line.includes(s), `rule 3 does not mention "${s}"`);
  }
  assert.match(line, /절대로.*뒤에 무엇이 오든/);
});
