import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { redactor } from '../lib/failures.mjs';
import * as run from '../lib/run.mjs';

// ------------------------------------------------------------------ fixtures

const HEADER = '## Verification';
const RUNS = /the harness core runs/;
const DONT = /Do not run these commands yourself/;
const ONLY = /run only the criteria's `check` commands and the test files of the modules you changed/;

function contract(id) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'done file', check: `node -e "process.exit(0)"`, new: true }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-09T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture() {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main' },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': contract('F1'),
    'shared.txt': 'original\n',
  }, { branch: null });
}

const COMMANDS = ['node --test "test/**/*.test.mjs"', 'npm run lint'];
const cfg = (verify = { commands: COMMANDS }) => resolveConfig({
  base_branch: 'main', run: { max_parallel: 1 }, verify, budget: { step_timeout_sec: 60 },
});

const PASSING = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const FAILING = { ...PASSING, pass: false, criteria: [{ id: 'AC-1', check: 'x', pass: false, message: 'exit 1' }] };
const verdict = (v) => async (a) => ({ feature: a.featureId, round: a.round, verdict: v, score: 8, scores: {}, blocking: [], backlogged: [], independence: 'cross-model', costUsd: 0, file: null });

const runF = (dir, deps, opts = {}) => run.runFeatures({
  root: dir, config: opts.config ?? cfg(), ...opts,
  deps: { evaluate: verdict('pass'), verify: async () => PASSING, cpus: 8, ...deps },
});

// The section's lines: the header up to the next heading or the end.
function section(prompt) {
  const at = prompt.indexOf(`\n${HEADER}\n`);
  if (at === -1) return null;
  const rest = prompt.slice(at + HEADER.length + 2).split('\n');
  const end = rest.findIndex((l) => l.startsWith('#'));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}
const listed = (s) => s.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));

function assertSection(prompt, commands, what) {
  const s = section(prompt);
  assert.ok(s, `${what}: has the section`);
  assert.deepEqual(listed(s), commands, `${what}: lists each verify command as it is`);
  assert.match(s, RUNS, `${what}: says the core runs them`);
  assert.match(s, /every criterion's `check`/, `${what}: and every criterion check`);
  assert.match(s, DONT, `${what}: says not to run them`);
  assert.match(s, ONLY, `${what}: says what to run instead`);
}

// ------------------------------------------------------------------ AC-1
test('F99 AC-1: a build attempt and the retry after a failed verify get the verification section', async () => {
  const dir = fixture();
  const prompts = [];
  let verifies = 0;
  const build = async (a) => {
    prompts.push(run.builderPrompt({ rolePrompt: 'ROLE', ...a }));
    writeFiles(a.cwd, { 'F1.txt': `done ${prompts.length}\n` });
    return { ok: true, costUsd: 0 };
  };
  const r = await runF(dir, { build, verify: async () => (verifies++ === 0 ? FAILING : PASSING) });
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results[0]));
  assert.equal(prompts.length, 2);
  prompts.forEach((p, i) => assertSection(p, COMMANDS, `attempt ${i + 1}`));
});

test('F99 AC-1: the commands are the resolved ones — a profile default is listed', async () => {
  const dir = fixture();
  const prompts = [];
  const build = async (a) => {
    prompts.push(run.builderPrompt({ rolePrompt: 'ROLE', ...a }));
    writeFiles(a.cwd, { 'F1.txt': 'done\n' });
    return { ok: true, costUsd: 0 };
  };
  const config = resolveConfig({ base_branch: 'main', run: { max_parallel: 1 }, budget: { step_timeout_sec: 60 } });
  assert.deepEqual(config.verify.commands, ['npm test'], 'the sdlc profile supplies the command');
  await runF(dir, { build }, { config });
  assertSection(prompts[0], ['npm test'], 'profile default');
});

test('F99 AC-1: the continuation of a timed-out build gets the verification section', async () => {
  const dir = fixture();
  const prompts = [];
  const build = async (a) => {
    prompts.push(run.builderPrompt({ rolePrompt: 'ROLE', ...a }));
    if (prompts.length === 1) {
      writeFiles(a.cwd, { 'half.txt': 'half\n' });
      return { ok: false, error: 'timeout', costUsd: null };
    }
    writeFiles(a.cwd, { 'F1.txt': 'done\n' });
    return { ok: true, costUsd: 0 };
  };
  const r = await runF(dir, { build });
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results[0]));
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /# Continuation of a timed-out build/);
  assertSection(prompts[1], COMMANDS, 'continuation');
});

for (const kind of ['conflict', 'post-merge recovery']) {
  test(`F99 AC-1: a ${kind} build gets the verification section`, async () => {
    const dir = fixture();
    const intWt = path.join(dir, '.harness', 'wt', '_integration');
    const calls = [];
    const build = async (a) => {
      const which = a.conflicts ? 'conflict' : a.postMergeFailures ? 'post-merge recovery' : 'build';
      calls.push({ which, prompt: run.builderPrompt({ rolePrompt: 'ROLE', ...a }) });
      if (which === 'build') {
        writeFiles(a.cwd, { 'F1.txt': 'done\n', 'shared.txt': 'feature\n' });
        writeFiles(intWt, kind === 'conflict' ? { 'shared.txt': 'integration\n' } : { 'other.txt': 'x\n' });
        commitAll(intWt, 'meanwhile on integration');
      } else if (which === 'conflict') {
        writeFiles(a.cwd, { 'shared.txt': 'both\n' });
      } else {
        writeFiles(a.cwd, { 'fixed.txt': 'fixed\n' });
      }
      return { ok: true, costUsd: 0 };
    };
    const verify = async (a) => (kind !== 'conflict' && fs.realpathSync.native(a.cwd) === fs.realpathSync.native(intWt)
      && !fs.existsSync(path.join(a.cwd, 'fixed.txt')) ? FAILING : PASSING);
    const r = await runF(dir, { build, verify });
    assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results[0]));
    const recovery = calls.filter((c) => c.which === kind);
    assert.equal(recovery.length, 1, `one ${kind} build`);
    assertSection(recovery[0].prompt, COMMANDS, kind);
  });
}

// ------------------------------------------------------------------ AC-2
test('F99 AC-2: with no verify commands the section only says the core runs the criterion checks', async () => {
  const dir = fixture();
  const prompts = [];
  const build = async (a) => {
    prompts.push(run.builderPrompt({ rolePrompt: 'ROLE', ...a }));
    writeFiles(a.cwd, { 'F1.txt': 'done\n' });
    return { ok: true, costUsd: 0 };
  };
  await runF(dir, { build }, { config: cfg({ commands: [] }) });
  const s = section(prompts[0]);
  assert.ok(s, 'has the section');
  assert.deepEqual(listed(s), [], 'no command list');
  assert.match(s, RUNS);
  assert.match(s, /every criterion's `check`/);
  assert.doesNotMatch(s, DONT, 'no sentence about not running commands');
  assert.doesNotMatch(s, /verify commands/);
});

// ------------------------------------------------------------------ AC-3
test('F99 AC-3: agents/builder.md says the core runs the verify commands under harness run, and to run them once otherwise', () => {
  const doc = fs.readFileSync(path.join(REPO, 'agents', 'builder.md'), 'utf8');
  const how = doc.slice(doc.indexOf('## How to work'), doc.indexOf('\n## ', doc.indexOf('## How to work') + 1)).replace(/\s+/g, ' ');
  assert.match(how, /Under `harness run`[^.]*the harness core runs the verify commands[^.]*after you/i);
  assert.match(how, /do not run the full verify commands yourself/i);
  assert.match(how, /[Oo]utside `harness run`[^.]*run the project's verify commands[^.]*once/);
});

// ------------------------------------------------------------------ AC-4
test('F99 AC-4: SPEC §8 describes the verification section of the builder prompt', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s8 = spec.slice(spec.indexOf('## 8. '), spec.indexOf('## 9. '));
  const at = s8.indexOf('**검증 안내 절**');
  assert.ok(at !== -1, 'a paragraph names the section');
  const para = s8.slice(at, s8.indexOf('\n', at));
  assert.match(para, /`## Verification`/);
  assert.match(para, /`verify\.commands`/);
  assert.match(para, /직접 실행하지 말/);
  assert.match(para, /비어 있으면/);
});

// ------------------------------------------------------------------ ES-1
test('F99 ES-1: a non-allowlisted environment value in a verify command is redacted in its line', async () => {
  const secret = 'f99-very-secret-token-value';
  const redact = redactor({ F99_TOKEN: secret, HOME: '/home/someone' });
  const commands = [`curl -H "Authorization: ${secret}" http://localhost/check`, 'npm test'];
  const p = run.builderPrompt({ rolePrompt: 'ROLE', featureId: 'F1', round: 1, attempt: 1, contract: {}, config: cfg({ commands }), redact });
  assert.ok(!p.includes(secret), 'the secret is gone');
  assert.deepEqual(listed(section(p)), [redact(commands[0]), 'npm test']);
  assert.notEqual(redact(commands[0]), commands[0]);

  // Through the run: the run's own redactor (deps.env) is the one used.
  const dir = fixture();
  const prompts = [];
  const build = async (a) => {
    prompts.push(run.builderPrompt({ rolePrompt: 'ROLE', ...a }));
    writeFiles(a.cwd, { 'F1.txt': 'done\n' });
    return { ok: true, costUsd: 0 };
  };
  await runF(dir, { build, env: { F99_TOKEN: secret } }, { config: cfg({ commands }) });
  assert.ok(!prompts[0].includes(secret), 'the run redacts it');
  assert.deepEqual(listed(section(prompts[0])), [redact(commands[0]), 'npm test']);
});
