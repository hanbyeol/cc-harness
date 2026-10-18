import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, realTmpdir, tmpdir, fakeNodeCli } from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import * as run from '../lib/run.mjs';
import { readContextFiles, contextSection } from '../lib/run/prompt.mjs';

const MARKER = 'F148-OUTSIDE-MARKER';
const FAKE_BUILDER = path.join(REPO, 'test', 'fixtures', 'fake-claude-builder.mjs');
const cfg = (over = {}) => resolveConfig({ base_branch: 'main', run: { max_parallel: 1 }, verify: { commands: [] }, budget: { step_timeout_sec: 60 }, ...over });
const prompt = (files) => run.builderPrompt({
  rolePrompt: 'role', featureId: 'F1', round: 1, attempt: 1, config: cfg(), contextFiles: files,
  contract: { id: 'F1', title: 't', acceptance_criteria: [], security_criteria: [], error_scenarios: [], out_of_scope: [] },
});
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const link = (target, at, type = 'junction') => fs.symlinkSync(target, at, type);

test('F148 AC-1 a directory link that points inside the worktree is still read', () => {
  const wt = realTmpdir('f148-');
  put(path.join(wt, 'real', 'MAP.md'), '# inside map\n');
  link(path.join(wt, 'real'), path.join(wt, 'docs'));
  const got = readContextFiles(wt, ['docs/MAP.md']);
  assert.deepEqual(got, [{ path: 'docs/MAP.md', text: '# inside map\n' }]);
  const p = prompt(got);
  assert.ok(p.includes('### docs/MAP.md') && p.includes('# inside map'));
});

test('F148 AC-2 a cwd written as a link is compared by real paths', () => {
  const wt = realTmpdir('f148-');
  put(path.join(wt, 'docs', 'MAP.md'), 'body\n');
  const holder = realTmpdir('f148-');
  const cwd = path.join(holder, 'cwdlink');
  link(wt, cwd);
  assert.deepEqual(readContextFiles(cwd, ['docs/MAP.md']), [{ path: 'docs/MAP.md', text: 'body\n' }]);
});

test('F148 AC-3 contextSection and builderPrompt write outside and not found lines', () => {
  const p = prompt([{ path: 'docs/x.md', missing: true, outside: true }, { path: 'docs/y.md', missing: true }]);
  assert.ok(p.includes('- docs/x.md: outside the worktree'));
  assert.ok(!p.includes('### docs/x.md') && !p.includes('docs/x.md: not found'));
  assert.ok(p.includes('- docs/y.md: not found'));
  const s = contextSection ? contextSection([{ path: 'docs/x.md', missing: true, outside: true }]) : null;
  if (s) assert.ok(s.includes('- docs/x.md: outside the worktree'));
});

test('F148 AC-4 SPEC §8 documents the real path rule', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const line = spec.split('\n').find((l) => l.includes('프로젝트 컨텍스트 절'));
  assert.ok(line);
  for (const w of ['실제 경로', 'realpathSync.native', 'outside the worktree', 'not found']) assert.ok(line.includes(w), w);
});

function outsideCase(build) {
  const root = realTmpdir('f148-');
  const wt = path.join(root, 'wt');
  const out = path.join(root, 'out');
  fs.mkdirSync(wt);
  put(path.join(out, 'x.md'), `${MARKER}\n`);
  put(path.join(out, 'c', 'x.md'), `${MARKER}\n`);
  return build({ root, wt, out });
}
const assertOutside = (wt, rel, out) => {
  const got = readContextFiles(wt, [rel]);
  assert.deepEqual(got, [{ path: rel, missing: true, outside: true }]);
  assert.ok(!prompt(got).includes(MARKER));
  return out;
};

test('F148 SC-1 an intermediate junction to outside is not read', () => {
  outsideCase(({ wt, out }) => {
    link(out, path.join(wt, 'docs'));
    assertOutside(wt, 'docs/x.md');
    const p = prompt(readContextFiles(wt, ['docs/x.md']));
    assert.ok(p.includes('- docs/x.md: outside the worktree'));
  });
});

test('F148 SC-2 a real run shows outside the worktree and never the marker', { timeout: 240000 }, async () => {
  const out = realTmpdir('f148-out-');
  put(path.join(out, 'x.md'), `${MARKER}\n`);
  const c = { id: 'F1', title: 'feature F1', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'F1.txt exists', check: 'node scripts/has.mjs F1.txt', new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [] };
  c.approval = { by: 'test', at: '2026-10-10T00:00:00.000Z', hash: hashContract(c) };
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.gitignore': 'docs\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': c,
    'scripts/has.mjs': 'import fs from "node:fs"; process.exit(fs.existsSync(process.argv[2]) ? 0 : 1);\n',
    'scripts/mk.mjs': `import fs from 'node:fs'; fs.symlinkSync(${JSON.stringify(out)}, 'docs', 'junction');\n`,
  }, { branch: null });
  const prompts = tmpdir('harness-f148-prompts-');
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const saved = { path: process.env[key], prompts: process.env.FAKE_CLAUDE_PROMPTS };
  process.env[key] = [fakeNodeCli('claude', FAKE_BUILDER), saved.path].join(path.delimiter);
  process.env.FAKE_CLAUDE_PROMPTS = prompts;
  const PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
  let r;
  try {
    r = await run.runFeatures({
      root: dir, config: cfg({ run: { max_parallel: 1, context_files: ['docs/x.md'], worktree_setup: ['node scripts/mk.mjs'] } }),
      deps: {
        verify: async () => PASSING,
        evaluate: async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null }),
        diagnose: async () => ({ roles: ['builder', 'evaluator', 'security-reviewer'].map((role) => ({ role, adapter: 'claude', usable: true })) }),
        cpus: 8, log: () => {}, warn: () => {},
      },
    });
  } finally {
    process.env[key] = saved.path;
    if (saved.prompts === undefined) delete process.env.FAKE_CLAUDE_PROMPTS; else process.env.FAKE_CLAUDE_PROMPTS = saved.prompts;
  }
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results[0]));
  const got = fs.readdirSync(prompts).map((f) => fs.readFileSync(path.join(prompts, f), 'utf8'));
  assert.ok(got.length >= 1);
  for (const p of got) {
    assert.ok(p.includes('- docs/x.md: outside the worktree'));
    assert.ok(!p.includes(MARKER));
  }
});

test('F148 SC-3 deeper and chained links are outside', () => {
  outsideCase(({ wt, out }) => {
    fs.mkdirSync(path.join(wt, 'a'));
    link(out, path.join(wt, 'a', 'b'));
    assertOutside(wt, 'a/b/c/x.md');
  });
  outsideCase(({ wt, out }) => {
    link(out, path.join(wt, 'hop'));
    link(path.join(wt, 'hop'), path.join(wt, 'docs'));
    assertOutside(wt, 'docs/x.md');
  });
});

test('F148 SC-4 direct calls with .. and absolute paths are refused', () => {
  const parent = realTmpdir('f148-');
  const wt = path.join(parent, 'wt');
  fs.mkdirSync(path.join(wt, 'sub'), { recursive: true });
  put(path.join(parent, 'x.md'), `${MARKER}\n`);
  for (const rel of ['../x.md', 'sub/../../x.md']) assertOutside(wt, rel);
  const abs = readContextFiles(wt, [path.join(parent, 'x.md')]);
  assert.deepEqual(abs, [{ path: path.join(parent, 'x.md'), missing: true }]);
  assert.ok(!prompt(abs).includes(MARKER));
});

test('F148 SC-5 a file link as the last element is not followed', (t) => {
  const root = realTmpdir('f148-');
  const wt = path.join(root, 'wt');
  put(path.join(root, 'out', 'x.md'), `${MARKER}\n`);
  fs.mkdirSync(path.join(wt, 'docs'), { recursive: true });
  try { link(path.join(root, 'out', 'x.md'), path.join(wt, 'docs', 'x.md'), 'file'); } catch (e) {
    if (e.code === 'EPERM') { t.diagnostic('cannot create file symlinks here (EPERM)'); return; }
    throw e;
  }
  const got = readContextFiles(wt, ['docs/x.md']);
  assert.deepEqual(got, [{ path: 'docs/x.md', missing: true }]);
  const p = prompt(got);
  assert.ok(p.includes('- docs/x.md: not found') && !p.includes(MARKER));
});

test('F148 ES-1 a link loop is missing, not a throw', () => {
  const wt = realTmpdir('f148-');
  try { link(path.join(wt, 'loop'), path.join(wt, 'docs'), 'dir'); link(path.join(wt, 'docs'), path.join(wt, 'loop'), 'dir'); } catch (e) {
    if (e.code === 'EPERM') return;
    throw e;
  }
  assert.deepEqual(readContextFiles(wt, ['docs/x.md']), [{ path: 'docs/x.md', missing: true }]);
});

test('F148 ES-2 a missing cwd gives missing entries', () => {
  const cwd = path.join(realTmpdir('f148-'), 'nope');
  const got = readContextFiles(cwd, ['docs/MAP.md', 'a.md']);
  assert.equal(got.length, 2);
  for (const g of got) assert.ok(g.missing === true && !('text' in g));
});
