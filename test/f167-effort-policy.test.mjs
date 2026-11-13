// F167: a role's effort is chosen by the feature's security tier (roles.<role>.effort_by_tier)
// and, for the builder, by the round (roles.builder.effort_escalate, round >= 2) — the effort
// counterpart of the by_tier and escalate model keys (SPEC §4, §10).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpdir, fakeNodeCli } from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';
import { resolveConfig, loadConfig, unknownConfigKeys } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { loadRolePrompt } from '../lib/roles.mjs';
import { evalAndRecord } from '../lib/eval-status.mjs';
import { readEvents } from '../lib/events.mjs';
import doctor, { diagnose } from '../lib/commands/doctor.mjs';
import { runFeatures } from '../lib/run.mjs';
import { roleCall } from '../lib/adapters/index.mjs';
import { HarnessError } from '../lib/errors.mjs';

const FIX = path.join(REPO, 'test', 'fixtures');
const MODEL_CLI = path.join(FIX, 'fake-model-cli.mjs');
const CLAUDE_HELP = fs.readFileSync(path.join(FIX, 'help', 'claude-2.1.280.txt'), 'utf8');
const GIT_DIR = path.dirname(spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim());
const ROLES = ['builder', 'evaluator', 'security-reviewer'];

// ------------------------------------------------------------------ fixtures (as in F70)

function contract(id, tier = 'standard') {
  const c = {
    id, title: `feature ${id}`, security_tier: tier, version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node -e "process.exit(0)"', new: false }],
    security_criteria: tier === 'critical' ? [{ id: 'SC-1', criterion: 'ok', check: 'node -e "process.exit(0)"', new: false }] : [],
    error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-11-13T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function repo(features, { roles } = {}) {
  const state = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, run: { max_parallel: 1 }, roles },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': {
      features: features.map((f) => ({ id: f.id, title: `feature ${f.id}`, security_tier: f.tier || 'standard', depends_on: [], status: 'approved' })),
    },
  };
  for (const f of features) state[`.harness/contracts/${f.id}.json`] = contract(f.id, f.tier);
  return gitRepo(state, { branch: null });
}

const PASS_VERIFY = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const FAIL_VERIFY = { ...PASS_VERIFY, pass: false, criteria: [{ id: 'AC-1', check: 'x', pass: false, message: 'exit 1' }] };

function scriptedVerify(seq = []) {
  let n = 0;
  return async () => {
    const s = seq[n];
    n += 1;
    return s === false ? FAIL_VERIFY : PASS_VERIFY;
  };
}

const argOf = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
};

// Runs fn with a fake `claude` first on PATH that logs every call.
async function withFakeClaude(fn) {
  const bin = fakeNodeCli('claude', MODEL_CLI);
  const log = path.join(tmpdir('harness-log-'), 'calls.jsonl');
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const saved = { path: process.env[pathKey], log: process.env.FAKE_MODEL_LOG };
  process.env[pathKey] = [bin, path.dirname(process.execPath), GIT_DIR].join(path.delimiter);
  process.env.FAKE_MODEL_LOG = log;
  let result;
  try {
    result = await fn();
  } finally {
    process.env[pathKey] = saved.path;
    if (saved.log === undefined) delete process.env.FAKE_MODEL_LOG; else process.env.FAKE_MODEL_LOG = saved.log;
  }
  const heads = Object.fromEntries(['evaluator', 'security-reviewer'].map((r) => [r, loadRolePrompt(r).slice(0, 120)]));
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return {
    result,
    calls: calls.map((c) => {
      const mode = argOf(c.argv, '--permission-mode');
      const role = mode === 'plan' ? Object.keys(heads).find((r) => c.head.startsWith(heads[r])) : 'builder';
      return { role, effort: argOf(c.argv, '--effort'), feature: path.basename(c.cwd), argv: c.argv };
    }),
  };
}

const runIn = (dir, deps = {}) => runFeatures({ root: dir, config: loadConfig(dir), deps: { verify: scriptedVerify(), ...deps } });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const statuses = (dir) => Object.fromEntries(readJson(path.join(dir, '.harness/features.json')).features.map((f) => [f.id, f.status]));
const metricLines = (dir) => fs.readdirSync(path.join(dir, '.harness', 'runs'))
  .filter((f) => f.endsWith('.metrics.jsonl'))
  .flatMap((f) => fs.readFileSync(path.join(dir, '.harness', 'runs', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
const configError = (user) => {
  try { resolveConfig(user); return null; } catch (e) { return e; }
};

const PROBE = (help) => async (adapter) => (adapter.name === 'claude'
  ? { installed: true, version: 'claude fixture', help }
  : { installed: false, version: null, help: null });

async function doctorOut(config, help = CLAUDE_HELP) {
  const out = [];
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.harness', 'config.json'), JSON.stringify(config));
  const code = await doctor({ root: dir, out: (s) => out.push(s), err: () => {}, probe: PROBE(help), env: {} });
  return { code, lines: out.join('\n').split('\n') };
}

// The role's block: the indented lines under its role line.
const roleBlock = (lines, role) => {
  const at = lines.findIndex((l) => new RegExp(`^  ${role}\\s`).test(l));
  assert.ok(at !== -1, `role line for ${role}`);
  const block = [];
  for (let i = at + 1; i < lines.length && /^ {4}\S/.test(lines[i]); i += 1) block.push(lines[i]);
  return { line: lines[at], block };
};

const POLICY = {
  builder: { adapter: 'claude', model: 'b1', effort_by_tier: { standard: 'medium', critical: 'high' }, effort_escalate: 'xhigh' },
  evaluator: { adapter: 'claude', model: 'e1', effort_by_tier: { standard: 'low', critical: 'high' } },
  'security-reviewer': { adapter: 'claude', model: 's1', effort_by_tier: { critical: 'max' } },
};

// ------------------------------------------------------------------ AC-1

test('F167 AC-1 roleCall: effort_by_tier.<tier>, then effort, then null — for every role and tier', () => {
  for (const role of ROLES) {
    const both = resolveConfig({ roles: { [role]: { adapter: 'claude', effort: 'low', effort_by_tier: { critical: 'max', standard: 'medium' } } } });
    assert.equal(roleCall(both, role, { tier: 'critical' }).effort, 'max', role);
    assert.equal(roleCall(both, role, { tier: 'standard' }).effort, 'medium', role);
    const partial = resolveConfig({ roles: { [role]: { adapter: 'claude', effort: 'low', effort_by_tier: { critical: 'high' } } } });
    assert.equal(roleCall(partial, role, { tier: 'critical' }).effort, 'high', role);
    assert.equal(roleCall(partial, role, { tier: 'standard' }).effort, 'low', `${role}: falls back to effort`);
    const tierOnly = resolveConfig({ roles: { [role]: { adapter: 'claude', effort_by_tier: { critical: 'high' } } } });
    assert.equal(roleCall(tierOnly, role, { tier: 'standard' }).effort, null, `${role}: neither set`);
    const none = resolveConfig({ roles: { [role]: { adapter: 'claude' } } });
    for (const tier of ['critical', 'standard']) assert.equal(roleCall(none, role, { tier }).effort, null, role);
  }
});

// ------------------------------------------------------------------ AC-2

test('F167 AC-2 roleCall: the builder uses effort_escalate from round 2, conflict calls included; round 1 keeps the tier value', () => {
  const config = resolveConfig({ roles: { builder: POLICY.builder } });
  for (const [tier, first] of [['standard', 'medium'], ['critical', 'high']]) {
    assert.equal(roleCall(config, 'builder', { tier, round: 1 }).effort, first, tier);
    assert.equal(roleCall(config, 'builder', { tier, round: 1, conflict: true }).effort, first, `${tier} conflict r1`);
    for (const round of [2, 3]) {
      assert.equal(roleCall(config, 'builder', { tier, round }).effort, 'xhigh', `${tier} r${round}`);
      assert.equal(roleCall(config, 'builder', { tier, round, conflict: true }).effort, 'xhigh', `${tier} conflict r${round}`);
    }
  }
  const noEscalate = resolveConfig({ roles: { builder: { adapter: 'claude', effort_by_tier: { standard: 'medium' } } } });
  assert.equal(roleCall(noEscalate, 'builder', { tier: 'standard', round: 2 }).effort, 'medium', 'no escalate: the tier value');
});

// ------------------------------------------------------------------ AC-3

test('F167 AC-3 harness run: the builder gets the tier effort of its feature', async () => {
  const dir = repo([{ id: 'F1' }, { id: 'F2', tier: 'critical' }], { roles: POLICY });
  const { calls } = await withFakeClaude(() => runIn(dir));
  assert.deepEqual(statuses(dir), { F1: 'passed', F2: 'passed' });
  const builds = calls.filter((c) => c.role === 'builder');
  assert.deepEqual(builds.filter((c) => c.feature === 'F1').map((c) => c.effort), ['medium']);
  assert.deepEqual(builds.filter((c) => c.feature === 'F2').map((c) => c.effort), ['high']);
});

test('F167 AC-3 harness run: round 2 after a failed round 1 gets effort_escalate', async () => {
  const dir = repo([{ id: 'F1' }], { roles: POLICY });
  const { calls } = await withFakeClaude(() => runIn(dir, { verify: scriptedVerify([false, false, false]) }));
  assert.equal(statuses(dir).F1, 'passed');
  assert.deepEqual(calls.filter((c) => c.role === 'builder').map((c) => c.effort), ['medium', 'medium', 'medium', 'xhigh']);
});

// ------------------------------------------------------------------ AC-4

test('F167 AC-4 harness eval: each reviewer gets its effort_by_tier for the feature tier', async () => {
  const crit = repo([{ id: 'F1', tier: 'critical' }], { roles: POLICY });
  const a = await withFakeClaude(() => evalAndRecord({ root: crit, featureId: 'F1', base: 'main', config: loadConfig(crit), verifyResult: PASS_VERIFY }));
  assert.equal(a.result.verdict, 'pass', JSON.stringify(a.result));
  assert.deepEqual(a.calls.filter((c) => c.role === 'evaluator').map((c) => c.effort), ['high']);
  assert.deepEqual(a.calls.filter((c) => c.role === 'security-reviewer').map((c) => c.effort), ['max']);
  const std = repo([{ id: 'F1' }], { roles: POLICY });
  const b = await withFakeClaude(() => evalAndRecord({ root: std, featureId: 'F1', base: 'main', config: loadConfig(std), verifyResult: PASS_VERIFY }));
  assert.equal(b.result.verdict, 'pass', JSON.stringify(b.result));
  assert.deepEqual(b.calls.filter((c) => c.role === 'evaluator').map((c) => c.effort), ['low']);
});

// ------------------------------------------------------------------ AC-5

test('F167 AC-5 harness run: metrics lines and step events carry the effort chosen for each call', async () => {
  const dir = repo([{ id: 'F1' }], { roles: POLICY });
  await withFakeClaude(() => runIn(dir, { verify: scriptedVerify([false, false, false]) }));
  const lines = metricLines(dir);
  assert.deepEqual(lines.filter((l) => l.step === 'build').map((l) => [l.round, l.effort]),
    [[1, 'medium'], [1, 'medium'], [1, 'medium'], [2, 'xhigh']]);
  assert.deepEqual(lines.filter((l) => l.step === 'eval').map((l) => l.effort), ['low']);
  const steps = readEvents(dir).events.filter((e) => e.type === 'step');
  assert.deepEqual(steps.filter((e) => e.stage === 'build').map((e) => e.data.effort), ['medium', 'medium', 'medium', 'xhigh']);
  assert.deepEqual(steps.filter((e) => e.stage === 'eval').map((e) => e.data.effort), ['low']);
});

// ------------------------------------------------------------------ AC-6

test('F167 AC-6 doctor: tier effort lines and the builder escalate line; a plain effort keeps one line', async () => {
  const { code, lines } = await doctorOut({ roles: { ...POLICY, 'security-reviewer': { adapter: 'claude', model: 's1', effort: 'high' } } });
  assert.equal(code, 0, lines.join('\n'));
  const eff = (role) => roleBlock(lines, role).block.filter((l) => /effort/.test(l));
  assert.deepEqual(eff('builder'), ['    effort critical  high', '    effort standard  medium', '    effort escalate (r≥2)  xhigh']);
  assert.deepEqual(eff('evaluator'), ['    effort critical  high', '    effort standard  low']);
  assert.deepEqual(eff('security-reviewer'), ['    effort high'], 'unchanged without the new keys');
  const bare = await doctorOut({ roles: { builder: { adapter: 'claude', model: 'b1' }, evaluator: { adapter: 'claude', model: 'e1', effort_by_tier: { critical: 'high' } } } });
  assert.deepEqual(roleBlock(bare.lines, 'builder').block.filter((l) => /effort/.test(l)), ['    effort not set']);
  assert.deepEqual(roleBlock(bare.lines, 'evaluator').block.filter((l) => /effort/.test(l)), ['    effort critical  high', '    effort standard  not set']);
  const esc = await doctorOut({ roles: { builder: { adapter: 'claude', model: 'b1', effort: 'low', effort_escalate: 'high' } } });
  assert.deepEqual(roleBlock(esc.lines, 'builder').block.filter((l) => /effort/.test(l)),
    ['    effort critical  low', '    effort standard  low', '    effort escalate (r≥2)  high']);
});

test('F167 AC-6 doctor: --effort is required when any call of the role has an effort', async () => {
  const noEffort = CLAUDE_HELP.split('\n').filter((l) => !/^\s*--effort\b/.test(l)).join('\n');
  for (const roles of [
    { builder: { adapter: 'claude', model: 'b1', effort_escalate: 'high' } },
    { builder: { adapter: 'claude', model: 'b1', effort_by_tier: { critical: 'high' } } },
  ]) {
    const config = resolveConfig({ roles });
    const r = await diagnose({ config, probe: PROBE(noEffort), env: {} });
    const builder = r.roles.find((x) => x.role === 'builder');
    assert.equal(builder.usable, false, JSON.stringify(roles));
    assert.deepEqual(builder.missing, ['--effort']);
    const full = await diagnose({ config, probe: PROBE(CLAUDE_HELP), env: {} });
    assert.equal(full.roles.find((x) => x.role === 'builder').usable, true);
  }
});

// ------------------------------------------------------------------ AC-7

test('F167 AC-7 effort_by_tier and effort_escalate are known config keys', () => {
  assert.deepEqual(unknownConfigKeys({ roles: POLICY }), []);
});

// ------------------------------------------------------------------ AC-8

test('F167 AC-8 SPEC §4 and §10 describe effort_by_tier, effort_escalate, the order and the starting values', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const section = (n) => {
    const start = spec.search(new RegExp(`^## ${n}\\.`, 'm'));
    assert.ok(start !== -1, `SPEC §${n} exists`);
    const rest = spec.slice(start + 3);
    const end = rest.search(/^## \d+\./m);
    return end === -1 ? rest : rest.slice(0, end);
  };
  for (const n of [4, 10]) {
    const s = section(n);
    assert.ok(s.includes('effort_by_tier') && s.includes('effort_escalate'), `§${n} names both keys`);
  }
  const s10 = section(10);
  assert.ok(/effort_escalate[^\n]*→[^\n]*effort_by_tier[^\n]*→[^\n]*effort/.test(s10), '§10 gives the order escalate → tier → effort');
  const lines = spec.split('\n').filter((l) => l.includes('F167'));
  assert.ok(lines.length > 0, 'SPEC mentions F167');
  const text = lines.join(' ');
  assert.ok(text.includes('Fable 5.2'), 'the starting values cite the Fable 5.2 guide');
  for (const v of ['medium', 'high']) assert.ok(text.includes(v), `starting values name ${v}`);
});

// ------------------------------------------------------------------ ES-1

for (const [what, value, key] of [
  ['a string', 'high', 'effort_by_tier'],
  ['an unknown tier key', { low: 'high' }, 'effort_by_tier.low'],
  ['"HIGH" (upper case)', { critical: 'HIGH' }, 'effort_by_tier.critical'],
  ['"" (empty)', { standard: '' }, 'effort_by_tier.standard'],
  ['"--max" (flag-shaped)', { critical: '--max' }, 'effort_by_tier.critical'],
]) {
  test(`F167 ES-1 roles.<role>.effort_by_tier ${what} → config_invalid with the key path`, () => {
    for (const role of ROLES) {
      const err = configError({ roles: { [role]: { adapter: 'claude', effort_by_tier: value } } });
      assert.ok(err instanceof HarnessError, `accepted ${JSON.stringify(value)} for ${role}`);
      assert.equal(err.code, 'config_invalid');
      assert.equal(err.exit, 2);
      assert.ok(err.message.includes(`roles.${role}.${key}`), err.message);
    }
  });
}

test('F167 ES-1 CLI: harness run and doctor exit 2 on an invalid effort_by_tier and no model CLI is called', async () => {
  const dir = repo([{ id: 'F1' }], { roles: { builder: { adapter: 'claude', model: 'b1', effort_by_tier: { critical: '--max' } } } });
  const { calls } = await withFakeClaude(async () => {
    for (const args of [['run'], ['doctor']]) {
      const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'harness.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 2, `${args}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /roles\.builder\.effort_by_tier\.critical/);
    }
  });
  assert.deepEqual(calls, []);
});

// ------------------------------------------------------------------ ES-2

test('F167 ES-2 effort_escalate on a role other than the builder, or outside EFFORTS → config_invalid', () => {
  for (const role of ['evaluator', 'security-reviewer']) {
    const err = configError({ roles: { [role]: { adapter: 'claude', effort_escalate: 'high' } } });
    assert.ok(err instanceof HarnessError, role);
    assert.equal(err.code, 'config_invalid');
    assert.equal(err.exit, 2);
    assert.ok(err.message.includes(`roles.${role}.effort_escalate`), err.message);
  }
  for (const value of ['extreme', 'HIGH', '', '--max', 3]) {
    const err = configError({ roles: { builder: { adapter: 'claude', effort_escalate: value } } });
    assert.ok(err instanceof HarnessError, JSON.stringify(value));
    assert.equal(err.code, 'config_invalid');
    assert.ok(err.message.includes('roles.builder.effort_escalate'), err.message);
  }
});

test('F167 ES-2 the new keys on a non-claude role → only supported by the claude adapter', () => {
  for (const adapter of ['codex', 'gemini', 'generic']) {
    for (const [key, value] of [['effort_by_tier', { critical: 'high' }], ['effort_escalate', 'high']]) {
      const err = configError({ roles: { builder: { adapter, model: 'm', [key]: value } } });
      assert.ok(err instanceof HarnessError, `${adapter} ${key}`);
      assert.equal(err.code, 'config_invalid');
      assert.ok(err.message.includes(`roles.builder.${key}`), err.message);
      assert.ok(err.message.includes('only supported by the claude adapter'), err.message);
    }
  }
});
