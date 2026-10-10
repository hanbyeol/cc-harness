import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpdir, fakeNodeCli } from './helpers.mjs';
import { gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig, DEFAULTS } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import * as run from '../lib/run.mjs';

const FAKE_BUILDER = path.join(REPO, 'test', 'fixtures', 'fake-claude-builder.mjs');
const MAP = '# Map\n\n- lib/run.mjs — the run loop\n';

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id}.txt exists`, check: `node scripts/has.mjs ${id}.txt`, new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-10T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture(files = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract('F1'),
    ...files,
  }, { branch: null });
}

const cfg = (over = {}) => resolveConfig({
  base_branch: 'main', run: { max_parallel: 1 }, verify: { commands: [] }, budget: { step_timeout_sec: 60 }, ...over,
});
const PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const FAILING = { ...PASSING, pass: false, criteria: [{ id: 'AC-1', check: 'x', pass: false, message: 'exit 1' }] };
const evaluatePass = async (a) => ({ feature: a.featureId, round: a.round, verdict: 'pass', score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });
const usableRoles = async () => ({ roles: ['builder', 'evaluator', 'security-reviewer'].map((role) => ({ role, adapter: 'claude', usable: true })) });

// A real run whose builder is the fake claude CLI; returns every prompt it received, in order.
async function capturedRun(dir, config, { failFirst = false, env = {} } = {}) {
  const prompts = tmpdir('harness-f112-prompts-');
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const saved = { path: process.env[key], prompts: process.env.FAKE_CLAUDE_PROMPTS };
  const savedEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  process.env[key] = [fakeNodeCli('claude', FAKE_BUILDER), saved.path].join(path.delimiter);
  process.env.FAKE_CLAUDE_PROMPTS = prompts;
  Object.assign(process.env, env);
  let calls = 0;
  const verify = async () => { calls += 1; return failFirst && calls === 1 ? FAILING : PASSING; };
  let r;
  try {
    r = await run.runFeatures({ root: dir, config, deps: { verify, evaluate: evaluatePass, diagnose: usableRoles, cpus: 8, log: () => {}, warn: () => {} } });
  } finally {
    process.env[key] = saved.path;
    if (saved.prompts === undefined) delete process.env.FAKE_CLAUDE_PROMPTS; else process.env.FAKE_CLAUDE_PROMPTS = saved.prompts;
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  const got = fs.readdirSync(prompts).sort().map((f) => fs.readFileSync(path.join(prompts, f), 'utf8'));
  return { r, got };
}

const BASE_ARGS = () => ({
  rolePrompt: 'role', featureId: 'F1', round: 1, attempt: 1, contract: contract('F1'), config: cfg(),
});
const sectionOf = (p) => {
  const at = p.indexOf('\n## Project context\n');
  if (at === -1) return null;
  const rest = p.slice(at + 1).split('\n');
  const end = rest.findIndex((l, i) => i > 0 && l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
};

const bad = (run_) => () => resolveConfig({ run: run_ });

test('F112 AC-1 run.context_files defaults to [] and passes through resolveConfig', () => {
  assert.deepEqual(DEFAULTS.run.context_files, []);
  assert.deepEqual(resolveConfig({}).run.context_files, []);
  assert.deepEqual(resolveConfig({ run: { context_files: ['docs/MAP.md', 'a/b.md'] } }).run.context_files, ['docs/MAP.md', 'a/b.md']);
  assert.equal(resolveConfig({ run: { context_files: ['x.md'] } }).run.max_parallel, 'auto');
});

test('F112 AC-2 first build and the retry after a failed verify carry the context right after Verification', { timeout: 240000 }, async () => {
  const dir = fixture({ 'docs/MAP.md': MAP });
  const { r, got } = await capturedRun(dir, cfg({ run: { max_parallel: 1, context_files: ['docs/MAP.md'] } }), { failFirst: true });
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results[0]));
  assert.equal(got.length, 2, 'first attempt and one retry');
  for (const p of got) {
    const at = p.indexOf('\n## Verification\n');
    const ctx = p.indexOf('\n## Project context\n');
    assert.ok(at !== -1 && ctx > at, 'context after verification');
    const between = p.slice(at + 1, ctx).split('\n').filter((l) => l.startsWith('## '));
    assert.deepEqual(between, ['## Verification'], 'no other section in between');
    assert.ok(p.includes(`### docs/MAP.md\n\`\`\`\n${MAP.replace(/\n$/, '')}\n\`\`\`\n`), p);
  }
  assert.equal(got.filter((p) => p.includes('Deterministic verification failed')).length, 1, 'one prompt is the retry');
});

test('F112 AC-2 the fence is longer than any backtick run in the body', () => {
  const text = 'a ``` b\n````` c\n';
  const p = run.builderPrompt({ ...BASE_ARGS(), contextFiles: [{ path: 'x.md', text }] });
  assert.ok(p.includes('### x.md\n``````\na ``` b\n````` c\n``````\n'), p);
});

test('F112 AC-3 conflict, post-merge and continuation prompts carry the same section', () => {
  const contextFiles = [{ path: 'docs/MAP.md', text: MAP }, { path: 'gone.md', missing: true }];
  const plain = sectionOf(run.builderPrompt({ ...BASE_ARGS(), contextFiles }));
  assert.ok(plain && plain.includes('### docs/MAP.md'), plain);
  const variants = {
    conflict: { conflicts: ['a.txt'] },
    'post-merge': { postMergeFailures: [{ item: 'verify' }] },
    continuation: { continuation: { files: ['a.txt'] } },
  };
  for (const [name, extra] of Object.entries(variants)) {
    const p = run.builderPrompt({ ...BASE_ARGS(), contextFiles, ...extra });
    assert.equal(sectionOf(p).split('\n# ')[0].trimEnd(), plain.split('\n# ')[0].trimEnd(), name);
    assert.ok(p.indexOf('## Project context') > p.indexOf('## Verification'), name);
  }
});

test('F112 AC-3 the real conflict recovery build carries the section', { timeout: 240000 }, async () => {
  // The recovery goes through defaultBuild like any build; assert on the captured CLI prompts.
  const dir = fixture({ 'docs/MAP.md': MAP, 'shared.txt': 'original\n' });
  const prompts = tmpdir('harness-f112-prompts-');
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const saved = { path: process.env[key], prompts: process.env.FAKE_CLAUDE_PROMPTS };
  process.env[key] = [fakeNodeCli('claude', FAKE_BUILDER), saved.path].join(path.delimiter);
  process.env.FAKE_CLAUDE_PROMPTS = prompts;
  let moved = false;
  const intWt = path.join(dir, '.harness', 'wt', '_integration');
  const verify = async (a) => {
    if (!moved && fs.existsSync(intWt) && fs.realpathSync.native(a.cwd) !== fs.realpathSync.native(intWt)) {
      moved = true;
      writeFiles(intWt, { 'shared.txt': 'integration\n' });
      commitAll(intWt, 'meanwhile on integration');
    }
    return PASSING;
  };
  let r;
  try {
    r = await run.runFeatures({
      root: dir, config: cfg({ run: { max_parallel: 1, context_files: ['docs/MAP.md'] } }),
      deps: { verify, evaluate: evaluatePass, diagnose: usableRoles, cpus: 8, log: () => {}, warn: () => {} },
    });
  } finally {
    process.env[key] = saved.path;
    if (saved.prompts === undefined) delete process.env.FAKE_CLAUDE_PROMPTS; else process.env.FAKE_CLAUDE_PROMPTS = saved.prompts;
  }
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results[0]));
  const got = fs.readdirSync(prompts).map((f) => fs.readFileSync(path.join(prompts, f), 'utf8'));
  assert.ok(got.some((p) => p.includes('# Merge conflict resolution')), 'a conflict recovery call happened');
  for (const p of got) assert.ok(p.includes('## Project context\n\n### docs/MAP.md\n'), p.slice(0, 200));
});

test('F112 AC-4 an empty or absent list leaves the prompt byte for byte unchanged', () => {
  const base = run.builderPrompt(BASE_ARGS());
  assert.equal(run.builderPrompt({ ...BASE_ARGS(), contextFiles: [] }), base);
  assert.equal(run.builderPrompt({ ...BASE_ARGS(), contextFiles: undefined }), base);
  assert.ok(!base.includes('## Project context'));
  const withCtx = run.builderPrompt({ ...BASE_ARGS(), contextFiles: [{ path: 'x', text: 'y' }] });
  assert.ok(withCtx.includes('## Project context'));
});

test('F112 AC-4 a real run with no context_files has no section', { timeout: 240000 }, async () => {
  const dir = fixture({ 'docs/MAP.md': MAP });
  const { got } = await capturedRun(dir, cfg());
  assert.ok(got.length >= 1);
  for (const p of got) assert.ok(!p.includes('## Project context'));
});

test('F112 AC-5 the body is redacted and cut at 16384 code points with a truncation line', () => {
  const redact = (s) => s.replaceAll('hunter2-secret', '[redacted]');
  const p = run.builderPrompt({ ...BASE_ARGS(), redact, contextFiles: [{ path: 'x.md', text: 'key=hunter2-secret\n' }] });
  assert.ok(p.includes('key=[redacted]') && !p.includes('hunter2-secret'));
  const text = '😀'.repeat(16384 + 5);
  const q = run.builderPrompt({ ...BASE_ARGS(), contextFiles: [{ path: 'x.md', text }] });
  const body = sectionOf(q).split('\n').slice(4, -2);
  assert.equal(body.length, 2, body.join('|').slice(0, 50));
  assert.equal(Array.from(body[0]).length, 16384);
  assert.equal(body[1], '… truncated (5 more characters)');
  const exact = run.builderPrompt({ ...BASE_ARGS(), contextFiles: [{ path: 'x.md', text: 'a'.repeat(16384) }] });
  assert.ok(!exact.includes('truncated'));
});

test('F112 AC-5 a real run redacts an environment value in the file', { timeout: 240000 }, async () => {
  const dir = fixture({ 'docs/MAP.md': 'token=zz-f112-secret-value\n' });
  const { got } = await capturedRun(dir, cfg({ run: { max_parallel: 1, context_files: ['docs/MAP.md'] } }), { env: { F112_API_TOKEN: 'zz-f112-secret-value' } });
  assert.ok(got.length >= 1);
  for (const p of got) {
    assert.ok(!p.includes('zz-f112-secret-value'));
    assert.ok(p.includes('token=[redacted]'));
  }
});

test('F112 AC-6 docs/MAP.md names every lib/*.mjs and bin/ file on a line with a description', () => {
  const map = fs.readFileSync(path.join(REPO, 'docs', 'MAP.md'), 'utf8').split(/\r?\n/);
  const walk = (d) => fs.readdirSync(path.join(REPO, d), { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
  const files = [...walk('lib').filter((f) => f.endsWith('.mjs')), ...walk('bin')];
  assert.ok(files.length > 30);
  const missing = files.filter((f) => !map.some((l) => l.includes(`${f} — `) && l.split(`${f} — `)[1].trim().length > 0));
  assert.deepEqual(missing, []);
});

test('F112 SC-1 a secret path in run.context_files is config_invalid', () => {
  for (const f of ['.env', 'secrets/key.pem']) {
    assert.throws(bad({ context_files: [f] }), (e) => e.code === 'config_invalid' && e.exit === 2 && e.message.includes('run.context_files') && e.message.includes(f));
  }
  assert.throws(() => resolveConfig({ secret_globs: ['private/'], run: { context_files: ['private/a.md'] } }),
    (e) => e.code === 'config_invalid' && e.message.includes('run.context_files') && e.message.includes('private/a.md'));
});

test('F112 ES-1 malformed run.context_files is config_invalid', () => {
  const cases = ['docs', 7, [1], [''], ['/x'], ['C:\\x'], ['\\x'], ['a/../b'], ['..'], ['a\\..\\b'], [null]];
  for (const v of cases) {
    assert.throws(bad({ context_files: v }), (e) => e.code === 'config_invalid' && e.exit === 2 && e.message.includes('run.context_files'), JSON.stringify(v));
  }
});

test('F112 ES-2 a missing file is shown as not found and the build goes on', { timeout: 240000 }, async () => {
  const p = run.builderPrompt({ ...BASE_ARGS(), contextFiles: [{ path: 'docs/MAP.md', missing: true }] });
  assert.ok(p.includes('## Project context\n\n- docs/MAP.md: not found\n'), p);
  const dir = fixture();
  const { r, got } = await capturedRun(dir, cfg({ run: { max_parallel: 1, context_files: ['docs/MAP.md'] } }));
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results[0]));
  assert.ok(got.every((q) => q.includes('- docs/MAP.md: not found')));
});

test('F112 AC-7 SPEC §8 documents the Project context section and run.context_files', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s8 = spec.slice(spec.indexOf('## 8. '), spec.indexOf('## 9. '));
  for (const needle of ['## Project context', 'run.context_files', '16,384', 'not found', 'redactor', 'isSecretPath']) {
    assert.ok(s8.includes(needle), needle);
  }
});
