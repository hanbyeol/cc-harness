import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpdir } from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';
import { hashContract } from '../lib/contract.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { evaluate } from '../lib/eval.mjs';
import claude, { DENY } from '../lib/adapters/claude.mjs';
import codex from '../lib/adapters/codex.mjs';
import { createGenericAdapter } from '../lib/adapters/generic.mjs';
import { missingFlags } from '../lib/adapters/index.mjs';

// F152: claude role sessions for Claude Code 2.1.314.

const NEVER = ['CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'PushNotification', 'SendMessage', 'DesignSync', 'EnterWorktree', 'ExitWorktree'];
const FIX = path.join(REPO, 'test', 'fixtures');
const VAR = 'CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK';

const deniedOf = (argv) => {
  const out = [];
  for (let j = argv.indexOf('--disallowedTools') + 1; j < argv.length && !argv[j].startsWith('-'); j += 1) out.push(argv[j]);
  return out;
};

// A fake CLI that writes its environment (JSON) to the file named by $HARNESS_F152_OUT.
function envCli() {
  const dir = tmpdir('harness-f152-');
  const script = path.join(dir, 'env-cli.mjs');
  fs.writeFileSync(script, "import fs from 'node:fs';\nfor await (const _ of process.stdin) { /* drain */ }\nfs.writeFileSync(process.env.HARNESS_F152_OUT, JSON.stringify(process.env));\nprocess.stdout.write('{}');\n");
  return { script, out: path.join(dir, 'env.json') };
}

async function envSeen(adapter, opts, parent = {}) {
  const { script, out } = envCli();
  const saved = {};
  const set = { HARNESS_F152_OUT: out, ...parent };
  for (const [k, v] of Object.entries(set)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    await adapter.run({ prompt: 'p', bin: process.execPath, binArgs: [script], timeoutSec: 60, ...opts });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

test('F152 AC-1: never-used tools are denied in builder and read-only sessions', () => {
  for (const readOnly of [false, true]) {
    const denied = deniedOf(claude.buildArgs({ readOnly }));
    for (const t of NEVER) assert.ok(denied.includes(t), `${t} readOnly=${readOnly}`);
  }
  const builder = deniedOf(claude.buildArgs({ readOnly: false }));
  for (const t of ['ScheduleWakeup', 'Monitor', 'TaskStop', 'ToolSearch']) assert.equal(builder.includes(t), false, t);
});

test('F152 AC-2: the claude adapter sets the refusal-fallback switch and passes the parent environment on', async () => {
  for (const readOnly of [false, true]) {
    const env = await envSeen(claude, { readOnly }, { HARNESS_F152_PROBE: 'x' });
    assert.equal(env[VAR], '1');
    assert.equal(env.HARNESS_F152_PROBE, 'x');
  }
});

test('F152 AC-3: codex and generic calls do not get the switch', async () => {
  const saved = process.env[VAR];
  delete process.env[VAR];
  try {
    for (const adapter of [codex, createGenericAdapter({ adapters: { generic: { command: ['x'], read_only_command: ['x'] } } })]) {
      const env = await envSeen(adapter, { readOnly: true, cmd: process.execPath });
      assert.equal(VAR in env, false, adapter.name);
    }
  } finally {
    if (saved !== undefined) process.env[VAR] = saved;
  }
});

test('F152 SC-1: a parent value of 0 is overridden with 1', async () => {
  const env = await envSeen(claude, { readOnly: true }, { [VAR]: '0' });
  assert.equal(env[VAR], '1');
});

test('F152 SC-2: the builder deny list and permission mode are unchanged', () => {
  const argv = claude.buildArgs({ readOnly: false });
  const i = argv.indexOf('--disallowedTools');
  assert.deepEqual(argv.slice(i + 1, i + 1 + DENY.length), [...DENY]);
  assert.equal(DENY[0], 'Bash(git push:*)');
  assert.equal(DENY.at(-1), 'Bash(node bin/harness.mjs:*)');
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'auto');
});

// ---------- independence by the served model ----------
function contract() {
  const c = {
    id: 'F9', title: 'feature F9', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'one', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [{ id: 'SC-1', criterion: 'no secrets', check: 'node scripts/ok.mjs', new: false }],
    error_scenarios: [{ id: 'ES-1', criterion: 'errors reported', check: 'node scripts/ok.mjs', new: false }],
    out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-23T00:00:00.000Z', hash: hashContract(c) };
  return c;
}
const PASS_VERIFY = { pass: true, commands: [], warnings: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } } };
const scores = { functionality: 9, quality: 9, security: 9, errors: 9, tests: 9 };
const reply = (extra) => ({
  ok: true, error: null, costUsd: 0.01, exitCode: 0, ...extra,
  json: { scores, findings: [], out_of_scope: [] }, text: '{}',
});

async function independenceFor(extra) {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'feature F9', status: 'approved', depends_on: [] }] },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/contracts/F9.json': contract(),
    'scripts/ok.mjs': 'process.exit(0);\n',
  }, { branch: null });
  const config = resolveConfig({
    base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 30 },
    roles: { builder: { adapter: 'claude', model: 'claude-sonnet-5-5' }, evaluator: { adapter: 'claude', model: 'claude-opus-5-5' }, 'security-reviewer': { adapter: 'claude', model: 'claude-opus-5-5' } },
  });
  const warnings = [];
  const res = await evaluate({
    root: dir, featureId: 'F9', base: 'main', config, verifyResult: PASS_VERIFY,
    builders: [{ adapter: 'claude', model: 'claude-sonnet-5-5' }],
    runAdapter: async (role) => reply(role === 'evaluator' ? extra : {}),
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(warnings.filter((w) => /exception|throw/i.test(w)), []);
  return res.independence;
}

test('F152 AC-4: an evaluator served by the builder model is fresh-context', async () => {
  assert.equal(await independenceFor({ servedModel: 'claude-sonnet-5-5', servedCanonical: null }), 'fresh-context');
});

test('F152 AC-5: the canonical served model counts too', async () => {
  assert.equal(await independenceFor({ servedModel: 'claude-sonnet-5-5[1m]', servedCanonical: 'claude-sonnet-5-5' }), 'fresh-context');
});

test('F152 AC-6: an evaluator served by its own model stays cross-model', async () => {
  assert.equal(await independenceFor({ servedModel: 'claude-opus-5-5', servedCanonical: null }), 'cross-model');
});

test('F152 ES-1: no served model leaves the requested-model judgement', async () => {
  assert.equal(await independenceFor({ servedModel: null, servedCanonical: null }), 'cross-model');
});

test('F152 ES-2: a refusal wrapper still ends as error refusal', async () => {
  const dir = tmpdir('harness-f152-');
  const script = path.join(dir, 'refuse.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';\nfor await (const _ of process.stdin) { /* drain */ }\nprocess.stdout.write(fs.readFileSync(${JSON.stringify(path.join(FIX, 'output', 'claude-json-refusal.json'))}, 'utf8'));\n`);
  const r = await claude.run({ prompt: 'p', bin: process.execPath, binArgs: [script], timeoutSec: 60 });
  assert.equal(r.error, 'refusal', JSON.stringify(r));
});

test('F152 AC-7: the 2.1.314 help has every required flag', () => {
  const help = fs.readFileSync(path.join(FIX, 'help', 'claude-2.1.314.txt'), 'utf8');
  for (const readOnly of [true, false]) {
    const req = claude.requiredFlags({ readOnly, schema: {}, budgetUsd: 1, model: 'm', effort: 'high' });
    assert.deepEqual(missingFlags(help, req), []);
  }
});

test('F152 AC-8: SPEC §10 documents the switch, the served-model independence and the new tools', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s10 = spec.slice(spec.indexOf('## 10. 어댑터'));
  assert.ok(s10.includes(VAR));
  assert.ok(s10.split(/(?<=[.。])\s/).some((x) => x.includes('실제 응답 모델') && x.includes('fresh-context')));
  assert.ok(s10.includes('EnterWorktree'));
});
