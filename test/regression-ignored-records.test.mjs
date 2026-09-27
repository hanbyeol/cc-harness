import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { runFeatures } from '../lib/run.mjs';

// Regression (v2.0.27): when .gitignore ignores .harness/events and a command wrote events inside
// the feature worktree, `git add -A -- . ':(exclude)…/events'` failed ("paths are ignored") and
// the run stopped at the merge with exit 2.
function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node -e "0"', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-28T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

test('regression: an ignored .harness/events written inside the feature worktree does not stop the merge', async () => {
  const dir = gitRepo({
    '.gitignore': '.harness/events/\n.harness/wt/\n',
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract('F1'),
  }, { branch: null });
  const build = async (a) => {
    writeFiles(a.cwd, { 'F1.txt': 'built\n', '.harness/events/2026-09.jsonl': '{"stage":"plan"}\n' });
    return { ok: true, costUsd: 0 };
  };
  const PASSING = { pass: true, commands: [], criteria: [{ id: 'AC-1', pass: true }], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
  const evaluate = async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });
  const r = await runFeatures({
    root: dir, config: resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 } }),
    deps: { build, verify: async () => PASSING, evaluate, log: () => {} },
  });
  assert.deepEqual(r.results.map((x) => [x.feature, x.status]), [['F1', 'passed']], JSON.stringify(r.results));
  const features = JSON.parse(fs.readFileSync(path.join(dir, '.harness/features.json'), 'utf8')).features;
  assert.equal(features[0].status, 'passed');
});
