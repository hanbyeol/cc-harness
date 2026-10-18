import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpdir } from './helpers.mjs';
import { gitRepo, git, commitAll, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { verify } from '../lib/verify.mjs';

// F128: in a project that is a subdirectory of the repository (pkg/app), the base-side runs
// (vacuity runs of new criteria, base test count) run in the project directory of the base
// worktree, not at its top (SPEC §6.3).

const posix = process.platform !== 'win32';
const P = 'pkg/app';
const q = (s) => JSON.stringify(s);

const harnessFiles = (checks, extra = {}) => ({
  [`${P}/.harness/config.json`]: { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
  [`${P}/.harness/features.json`]: { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
  [`${P}/.harness/contracts/F9.json`]: {
    id: 'F9', title: 'fixture', security_tier: 'standard', version: 1,
    acceptance_criteria: checks.map(([id, check, isNew = true]) => ({ id, criterion: id, check, new: isNew })),
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  },
  ...extra,
});

const cfg = (verifyCfg = {}) => resolveConfig({
  base_branch: 'main', verify: { commands: [], test_paths: ['test/**'], ...verifyCfg }, budget: { step_timeout_sec: 60 },
});
const run = (root, verifyCfg, cwd = root) => verify({ root, cwd, featureId: 'F9', base: 'main', cpus: 1, config: cfg(verifyCfg) });
const byId = (r) => Object.fromEntries(r.criteria.map((c) => [c.id, c]));

// A node command that appends its cwd to `log`, then exits with `tail` (a JS expression).
// os.EOL, not a '\\n' escape: cmd.exe passes backslashes through, so the escape would reach
// node as a literal backslash-n on Windows.
const recordCwd = (log, tail = '0') => `node -e ${q(`require('fs').appendFileSync(${q(log)}, process.cwd() + require('os').EOL); process.exit(${tail})`)}`;
const lines = (log) => fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean);
const baseLines = (log) => lines(log).filter((l) => /harness-base-/.test(l));
const countFiles = `node -e ${q("console.log(require('fs').readdirSync('test').length)")}`;
const summaryOfFiles = `node -e ${q("console.log('# tests ' + require('fs').readdirSync('test').length)")}`;

test('F128 AC-1: the base vacuity run of a new criterion runs in <base worktree>/pkg/app', async () => {
  const log = path.join(tmpdir('f128-log-'), 'cwd.log');
  const dir = gitRepo({ 'top.txt': 'x\n', [`${P}/keep.txt`]: 'x\n', ...harnessFiles([['AC-1', recordCwd(log)]]) });
  const r = await run(path.join(dir, P));
  assert.ok(baseLines(log).length >= 1, 'the check ran on base');
  for (const l of baseLines(log)) assert.ok(l.split(path.sep).join('/').endsWith(`/${P}`), l);
  assert.equal(byId(r)['AC-1'].vacuous, true);
});

test('F128 AC-2: the base test count is taken in <base worktree>/pkg/app (shell command and from:commands[i])', async () => {
  const files = { 'top.txt': 'x\n', [`${P}/test/a.test.mjs`]: 'x\n', [`${P}/test/b.test.mjs`]: 'x\n' };
  for (const [verifyCfg] of [
    [{ test_count: countFiles }],
    [{ commands: [summaryOfFiles], test_count: 'from:commands[0]' }],
  ]) {
    const dir = gitRepo({ ...files, ...harnessFiles([['AC-1', 'node -e 0', false]]) });
    writeFiles(dir, { [`${P}/test/c.test.mjs`]: 'x\n' });
    commitAll(dir, 'feature');
    const r = await run(path.join(dir, P), verifyCfg);
    assert.equal(r.integrity.testCount.status, 'ok', JSON.stringify(r.integrity.testCount));
    assert.equal(r.integrity.testCount.base, 2);
    assert.equal(r.integrity.testCount.head, 3);
  }
});

test('F128 AC-3: an entry script the feature created in pkg/app/test is withheld on base; base_entry has no project prefix', async () => {
  const dir = gitRepo({ 'top.txt': 'x\n', [`${P}/keep.txt`]: 'x\n', ...harnessFiles([['AC-1', 'node test/run.mjs']]) });
  writeFiles(dir, { [`${P}/test/run.mjs`]: 'process.exit(0);\n' });
  commitAll(dir, 'feature adds its entry');
  const r = await run(path.join(dir, P));
  const c = byId(r)['AC-1'];
  assert.equal(c.vacuous, false, c.message);
  assert.equal(c.pass, true);
  assert.equal(c.base_entry, 'test/run.mjs');
});

test('F128 AC-4: pkg/app/node_modules is linked into the base project directory; the working tree keeps it', { skip: !posix && 'symlink fixture' }, async () => {
  const dir = gitRepo({ '.gitignore': 'node_modules\n', 'top.txt': 'x\n', ...harnessFiles([['AC-1', `node -e ${q("require('f128pkg')")}`]]) });
  const nm = path.join(dir, P, 'node_modules', 'f128pkg');
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, 'index.js'), 'module.exports = 1;\n');
  const r = await run(path.join(dir, P));
  const c = byId(r)['AC-1'];
  assert.equal(c.vacuous, true, JSON.stringify(c));
  assert.equal(fs.readFileSync(path.join(nm, 'index.js'), 'utf8'), 'module.exports = 1;\n');
  assert.ok(fs.statSync(path.join(dir, P, 'node_modules')).isDirectory());
  assert.ok(!fs.lstatSync(path.join(dir, P, 'node_modules')).isSymbolicLink());
});

test('F128 AC-6: SPEC §6.3 puts base-side runs in the project directory of the base worktree', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  assert.ok(spec.includes('base worktree 안의 프로젝트 디렉터리(최상위 기준 경로가 작업 트리와 같은 곳)'));
  assert.match(spec, /진입 스크립트 경로[^\n]*프로젝트 디렉터리 기준/);
  assert.match(spec, /base worktree 의 프로젝트 디렉터리\(같은 상대 경로\)에 작업 트리의/);
});

test('F128 SC-1: a check running a file already in pkg/app at the merge-base is vacuous', async () => {
  const dir = gitRepo({ 'top.txt': 'x\n', [`${P}/check.mjs`]: 'process.exit(0);\n', ...harnessFiles([['AC-1', 'node check.mjs']]) });
  const r = await run(path.join(dir, P));
  const c = byId(r)['AC-1'];
  assert.equal(c.vacuous, true);
  assert.equal(c.pass, false);
  assert.match(c.message, /vacuous/);
});

test('F128 SC-2: deleting a test file in pkg/app/test is a decreased test count', async () => {
  const dir = gitRepo({
    'top.txt': 'x\n', [`${P}/test/a.test.mjs`]: 'x\n', [`${P}/test/b.test.mjs`]: 'x\n',
    ...harnessFiles([['AC-1', 'node -e 0', false]]),
  });
  git(dir, 'rm', '-q', `${P}/test/b.test.mjs`);
  commitAll(dir, 'feature deletes a test');
  const r = await run(path.join(dir, P), { test_count: countFiles });
  assert.equal(r.integrity.testCount.status, 'decreased', JSON.stringify(r.integrity.testCount));
  assert.equal(r.integrity.testCount.base, 2);
  assert.equal(r.integrity.testCount.head, 1);
  assert.equal(r.pass, false);
});

test('F128 ES-1: a merge-base without pkg/app gets an empty pkg/app; the base run is an ordinary failure', async () => {
  const log = path.join(tmpdir('f128-log-'), 'cwd.log');
  const dir = gitRepo({ 'top.txt': 'x\n' });
  writeFiles(dir, { ...harnessFiles([['AC-1', recordCwd(log, "require('fs').existsSync('marker.txt') ? 0 : 1")]]), [`${P}/marker.txt`]: 'x\n' });
  commitAll(dir, 'feature adds the project');
  const r = await run(path.join(dir, P));
  const c = byId(r)['AC-1'];
  assert.equal(c.pass, true, JSON.stringify(c));
  assert.equal(c.vacuous, false);
  assert.ok(!c.base_not_found);
  assert.ok(baseLines(log).length >= 1);
  for (const l of baseLines(log)) assert.ok(l.split(path.sep).join('/').endsWith(`/${P}`), l);
});

test('F128 ES-2: a root reached through a symbolic link still runs base in <base worktree>/pkg/app', { skip: !posix && 'symlink fixture' }, async () => {
  const log = path.join(tmpdir('f128-log-'), 'cwd.log');
  const dir = gitRepo({ 'top.txt': 'x\n', [`${P}/keep.txt`]: 'x\n', ...harnessFiles([['AC-1', recordCwd(log)]]) });
  const link = path.join(tmpdir('f128-link-'), 'repo-link');
  fs.symlinkSync(dir, link);
  const root = path.join(link, P);
  assert.notEqual(fs.realpathSync.native(root), root);
  const r = await run(root);
  assert.ok(baseLines(log).length >= 1);
  for (const l of baseLines(log)) {
    assert.ok(l.split(path.sep).join('/').endsWith(`/${P}`), l);
    assert.ok(!path.relative(path.dirname(path.dirname(l)), l).startsWith('..'));
  }
  assert.equal(byId(r)['AC-1'].vacuous, true);
});
