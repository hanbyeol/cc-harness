import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { verify, isHarnessPath } from '../lib/verify.mjs';

// F11: the core's own records (verdicts/**, backlog.json, runs/**) are exempt from the
// .harness integrity check (SPEC §6.2); everything else under .harness stays protected.

const contract = {
  id: 'F9', title: 'fixture', security_tier: 'standard', version: 1,
  acceptance_criteria: [{ id: 'AC-1', criterion: 'check exists', check: 'node check.mjs', new: true }],
  security_criteria: [], error_scenarios: [], out_of_scope: [],
};

// Base `main` holds .harness state; HEAD `feature` adds an untracked check.mjs making AC-1 pass.
// `prefix` places the project in a monorepo subdirectory ('' = repo root).
function fixture(prefix = '') {
  const p = prefix ? `${prefix}/` : '';
  const dir = gitRepo({
    [`${p}.harness/config.json`]: { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    [`${p}.harness/features.json`]: { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    [`${p}.harness/contracts/F9.json`]: contract,
    [`${p}.harness/contracts/F1.json`]: { ...contract, id: 'F1' },
    [`${p}.harness/backlog.json`]: { items: [] },
    [`${p}.harness/verdicts/F9-r1.json`]: { verdict: 'fail', round: 1 },
  });
  const root = prefix ? path.join(dir, prefix) : dir;
  writeFiles(root, { 'check.mjs': 'process.exit(0);\n' });
  return { dir, root };
}

const cfg = () => resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 30 } });
const run = (root) => verify({ root, featureId: 'F9', base: 'main', config: cfg() });

// ---------- AC-1 ----------
test('F11 AC-1: untracked new and modified verdicts/** files do not fail integrity', async () => {
  const { root } = fixture();
  writeFiles(root, {
    '.harness/verdicts/F9-r1.json': { verdict: 'fail', round: 1, note: 'rewritten' },
    '.harness/verdicts/F9-r2.json': { verdict: 'pass', round: 2 },
  });
  const r = await run(root);
  assert.deepEqual(r.integrity.harnessPaths, []);
  assert.equal(r.pass, true, JSON.stringify(r, null, 2));
});

test('F11 AC-1: committed verdicts/** additions and modifications do not fail integrity', async () => {
  const { root } = fixture();
  writeFiles(root, {
    '.harness/verdicts/F9-r1.json': { verdict: 'fail', round: 1, note: 'rewritten' },
    '.harness/verdicts/F9-r2.json': { verdict: 'pass', round: 2 },
  });
  commitAll(root, 'core records verdicts');
  const r = await run(root);
  assert.deepEqual(r.integrity.harnessPaths, []);
  assert.equal(r.pass, true, JSON.stringify(r, null, 2));
});

// ---------- AC-2 ----------
test('F11 AC-2: a changed backlog.json (committed or not) does not fail integrity', async () => {
  const { root } = fixture();
  writeFiles(root, { '.harness/backlog.json': { items: [{ id: 'B1', text: 'out of scope' }] } });
  let r = await run(root);
  assert.deepEqual(r.integrity.harnessPaths, []);
  assert.equal(r.pass, true, JSON.stringify(r, null, 2));
  commitAll(root, 'core records backlog');
  r = await run(root);
  assert.deepEqual(r.integrity.harnessPaths, []);
  assert.equal(r.pass, true, JSON.stringify(r, null, 2));
});

// ---------- AC-3 ----------
test('F11 AC-3: new files under runs/ (committed or not) do not fail integrity', async () => {
  const { root } = fixture();
  writeFiles(root, { '.harness/runs/2026-09-23T10-00-00Z.md': '# run report\n' });
  let r = await run(root);
  assert.deepEqual(r.integrity.harnessPaths, []);
  assert.equal(r.pass, true, JSON.stringify(r, null, 2));
  commitAll(root, 'core writes run report');
  writeFiles(root, { '.harness/runs/nested/2026-09-23T11-00-00Z.md': '# run report 2\n' });
  r = await run(root);
  assert.deepEqual(r.integrity.harnessPaths, []);
  assert.equal(r.pass, true, JSON.stringify(r, null, 2));
});

// ---------- AC-4 ----------
test('F11 AC-4: SPEC §6.2 names verdicts/, backlog.json and runs/ as exempt and keeps the rest protected', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const start = spec.indexOf('### 6.2');
  const end = spec.indexOf('### 6.3');
  assert.ok(start >= 0 && end > start, 'SPEC has §6.2 followed by §6.3');
  const s = spec.slice(start, end);
  const exemptLine = s.split('\n').find((l) => l.includes('면제'));
  assert.ok(exemptLine, '§6.2 has a line stating the exemption (면제)');
  for (const p of ['verdicts/', 'backlog.json', 'runs/']) assert.ok(exemptLine.includes(p), `exemption line names ${p}`);
  const protectedLine = s.split('\n').find((l) => l.includes('config.json') && l.includes('contracts/') && l.includes('features.json'));
  assert.ok(protectedLine, '§6.2 names config.json, contracts/ and features.json as protected');
  assert.ok(!/verdicts/.test(protectedLine), 'the protected list no longer includes verdicts/');
});

// ---------- SC-1 ----------
for (const [label, rel, content] of [
  ['config.json', '.harness/config.json', { profile: 'sdlc', base_branch: 'main', verify: { commands: ['node x.mjs'] } }],
  ['contracts/F1.json', '.harness/contracts/F1.json', { ...contract, id: 'F1', title: 'tampered' }],
  ['features.json', '.harness/features.json', { features: [{ id: 'F9', title: 'fixture', status: 'passed', depends_on: [] }] }],
]) {
  test(`F11 SC-1: a change to .harness/${label} still fails integrity (untracked edit and committed)`, async () => {
    const { root } = fixture();
    writeFiles(root, { [rel]: content });
    let r = await run(root);
    assert.equal(r.pass, false);
    assert.deepEqual(r.integrity.harnessPaths, [rel]);
    commitAll(root, `builder edits ${label}`);
    r = await run(root);
    assert.equal(r.pass, false);
    assert.deepEqual(r.integrity.harnessPaths, [rel]);
  });
}

// ---------- SC-2 ----------
for (const rel of ['.harness/verdicts-x/a.json', '.harness/backlog.json.bak', '.harness/runs', '.harness/verdicts', '.harness/runs.md']) {
  test(`F11 SC-2: exemption is by exact path segment — a file at ${rel} still fails`, async () => {
    const { root } = fixture();
    if (rel === '.harness/verdicts') {
      // the verdicts directory replaced by a plain file of the same name
      fs.rmSync(path.join(root, '.harness', 'verdicts'), { recursive: true, force: true });
      fs.writeFileSync(path.join(root, '.harness', 'verdicts'), 'x\n');
    } else {
      writeFiles(root, { [rel]: 'x\n' });
    }
    const r = await run(root);
    assert.equal(r.pass, false);
    assert.ok(r.integrity.harnessPaths.includes(rel), `${rel} in ${JSON.stringify(r.integrity.harnessPaths)}`);
  });
}

test('F11 SC-2: isHarnessPath exempts only exact record paths', () => {
  for (const p of ['.harness/verdicts/F1-r1.json', '.harness/backlog.json', '.harness/runs/a.md', '.harness/runs/x/y.md']) {
    assert.equal(isHarnessPath(p), false, p);
  }
  for (const p of ['.harness', '.harness/verdicts', '.harness/runs', '.harness/verdicts-x/a.json', '.harness/backlog.json.bak',
    '.harness/backlog.json/x', '.harness/config.json', '.harness/contracts/F1.json', '.harness/features.json', '.harness/other.txt',
    '.harness/wt/F1/.harness/config.json']) {
    assert.equal(isHarnessPath(p), true, p);
  }
});

// ---------- SC-3 ----------
test('F11 SC-3: exempt and protected paths changed together fail, and only protected paths are listed', async () => {
  const { root } = fixture();
  writeFiles(root, {
    '.harness/verdicts/F9-r2.json': { verdict: 'pass', round: 2 },
    '.harness/backlog.json': { items: [{ id: 'B1' }] },
    '.harness/runs/r.md': '# run\n',
    '.harness/contracts/F1.json': { ...contract, id: 'F1', title: 'tampered' },
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: ['node x.mjs'] } },
  });
  const r = await run(root);
  assert.equal(r.pass, false);
  assert.deepEqual(r.integrity.harnessPaths, ['.harness/config.json', '.harness/contracts/F1.json']);
});

// ---------- ES-1 ----------
test('F11 ES-1: in a monorepo subproject (pkg/app/.harness) the same exemption applies and config.json still fails', async () => {
  const { root } = fixture('pkg/app');
  writeFiles(root, {
    '.harness/verdicts/F9-r2.json': { verdict: 'pass', round: 2 },
    '.harness/backlog.json': { items: [{ id: 'B1' }] },
    '.harness/runs/r.md': '# run\n',
  });
  let r = await run(root);
  assert.deepEqual(r.integrity.harnessPaths, []);
  assert.equal(r.pass, true, JSON.stringify(r, null, 2));

  writeFiles(root, { '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: ['node x.mjs'] } } });
  r = await run(root);
  assert.equal(r.pass, false);
  assert.deepEqual(r.integrity.harnessPaths, ['pkg/app/.harness/config.json']);

  // A repo-root .harness record path is not the subproject's record path and vice versa:
  // exemption is anchored at the subproject's own .harness.
  assert.equal(isHarnessPath('pkg/app/.harness/verdicts/F1-r1.json', 'pkg/app/.harness'), false);
  assert.equal(isHarnessPath('pkg/app/.harness/config.json', 'pkg/app/.harness'), true);
  assert.equal(isHarnessPath('pkg/app/.harness/runs', 'pkg/app/.harness'), true);
});
