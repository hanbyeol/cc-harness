import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpdir, harness } from './helpers.mjs';
import { gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig, loadConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { loadRolePrompt } from '../lib/roles.mjs';
import { evalAndRecord } from '../lib/eval-status.mjs';
import { readEvents } from '../lib/events.mjs';
import doctor, { diagnose } from '../lib/commands/doctor.mjs';
import { runFeatures } from '../lib/run.mjs';
import { HarnessError } from '../lib/errors.mjs';
import claude from '../lib/adapters/claude.mjs';

const FIX = path.join(REPO, 'test', 'fixtures');
const MODEL_CLI = path.join(FIX, 'fake-model-cli.mjs');
const CLAUDE_HELP = fs.readFileSync(path.join(FIX, 'help', 'claude-2.1.280.txt'), 'utf8');
const GIT_DIR = path.dirname(spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim());

// ------------------------------------------------------------------ fixtures

function contract(id, tier = 'standard') {
  const c = {
    id, title: `feature ${id}`, security_tier: tier, version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node -e "process.exit(0)"', new: false }],
    security_criteria: tier === 'critical' ? [{ id: 'SC-1', criterion: 'ok', check: 'node -e "process.exit(0)"', new: false }] : [],
    error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-30T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function repo(features, { roles, files = {} } = {}) {
  const state = {
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 }, run: { max_parallel: 1 }, roles },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': {
      features: features.map((f) => ({ id: f.id, title: `feature ${f.id}`, security_tier: f.tier || 'standard', depends_on: [], status: 'approved' })),
    },
  };
  for (const f of features) state[`.harness/contracts/${f.id}.json`] = contract(f.id, f.tier);
  return gitRepo({ ...state, ...files }, { branch: null });
}

const PASS_VERIFY = { pass: true, commands: [], criteria: [], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const FAIL_VERIFY = { ...PASS_VERIFY, pass: false, criteria: [{ id: 'AC-1', check: 'x', pass: false, message: 'exit 1' }] };

function scriptedVerify(seq = [], onCall) {
  let n = 0;
  return async (a) => {
    const s = seq[n];
    n += 1;
    await onCall?.(a, n);
    return s === false ? FAIL_VERIFY : PASS_VERIFY;
  };
}

const argOf = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
};

// Runs fn with a fake `claude` first on PATH that logs every call; returns the calls as
// {role, model, effort, feature, conflict, argv}.
async function withFakeClaude(fn) {
  const bin = tmpdir('harness-bin-');
  const log = path.join(tmpdir('harness-log-'), 'calls.jsonl');
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'claude.cmd'), `@"${process.execPath}" "${MODEL_CLI}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${MODEL_CLI}" "$@"\n`);
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
  }
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
      return { role, model: argOf(c.argv, '--model'), effort: argOf(c.argv, '--effort'), feature: path.basename(c.cwd), conflict: c.conflict, argv: c.argv };
    }),
  };
}

const runIn = (dir, deps = {}) => runFeatures({ root: dir, config: loadConfig(dir), deps: { verify: scriptedVerify(), ...deps } });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const statuses = (dir) => Object.fromEntries(readJson(path.join(dir, '.harness/features.json')).features.map((f) => [f.id, f.status]));
const metricLines = (dir, suffix = '.metrics.jsonl') => fs.readdirSync(path.join(dir, '.harness', 'runs'))
  .filter((f) => f.endsWith(suffix))
  .flatMap((f) => fs.readFileSync(path.join(dir, '.harness', 'runs', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
const effortsOf = (calls, role) => calls.filter((c) => c.role === role).map((c) => c.effort);

const EFFORT_ROLES = {
  builder: { adapter: 'claude', model: 'b1', effort: 'high' },
  evaluator: { adapter: 'claude', model: 'e1', effort: 'medium' },
  'security-reviewer': { adapter: 'claude', model: 's1', effort: 'max' },
};

// ------------------------------------------------------------------ AC-1

test('F70 AC-1 claude adapter: effort becomes --effort <value> after the other flags', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const args = claude.buildArgs({ readOnly: true, model: 'm', effort });
    assert.deepEqual(args.slice(-2), ['--effort', effort]);
    assert.equal(args.filter((a) => a === '--effort').length, 1);
  }
});

test('F70 AC-1 harness run: builder, evaluator and security-reviewer each get --effort of their own role', async () => {
  const dir = repo([{ id: 'F1', tier: 'critical' }], { roles: EFFORT_ROLES });
  const { calls } = await withFakeClaude(() => runIn(dir));
  assert.deepEqual(statuses(dir), { F1: 'passed' });
  assert.deepEqual(effortsOf(calls, 'builder'), ['high']);
  assert.deepEqual(effortsOf(calls, 'evaluator'), ['medium']);
  assert.deepEqual(effortsOf(calls, 'security-reviewer'), ['max']);
});

test('F70 AC-1 harness eval: the default adapter call passes each reviewer its own --effort', async () => {
  const dir = repo([{ id: 'F1', tier: 'critical' }], { roles: EFFORT_ROLES });
  const { calls, result } = await withFakeClaude(() => evalAndRecord({ root: dir, featureId: 'F1', base: 'main', config: loadConfig(dir), verifyResult: PASS_VERIFY }));
  assert.equal(result.verdict, 'pass', JSON.stringify(result));
  assert.deepEqual(effortsOf(calls, 'evaluator'), ['medium']);
  assert.deepEqual(effortsOf(calls, 'security-reviewer'), ['max']);
  assert.deepEqual(effortsOf(calls, 'builder'), []);
});

// ------------------------------------------------------------------ AC-2

test('F70 AC-2 claude adapter: without effort the arguments are exactly the pre-feature ones', () => {
  const DENY = ['Bash(git push:*)', 'Bash(git reset --hard:*)', 'Bash(rm -rf /:*)', 'Bash(rm -rf ~:*)', 'Bash(sudo:*)'];
  // The flags and denied tools of a lean role session (F86) come first.
  const LEAN = ['-p', '--strict-mcp-config', '--disable-slash-commands'];
  const READ_ONLY_OFF = ['Workflow', 'ScheduleWakeup', 'Skill', 'ReportFindings', 'ListAgents', 'Agent'];
  assert.deepEqual(claude.buildArgs({ readOnly: false, budgetUsd: 2, model: 'm' }),
    [...LEAN, '--permission-mode', 'auto', '--disallowedTools', ...DENY, 'Workflow', 'Skill', 'ReportFindings', 'ListAgents', 'Agent',
      '--output-format', 'json', '--max-budget-usd', '2', '--model', 'm']);
  assert.deepEqual(claude.buildArgs({ readOnly: true, schema: { type: 'object' }, model: 'm', effort: null }),
    [...LEAN, '--permission-mode', 'plan', '--disallowedTools', ...READ_ONLY_OFF, '--output-format', 'json', '--json-schema', '{"type":"object"}', '--model', 'm']);
  const req = [...LEAN, '--permission-mode=plan', '--disallowedTools', '--output-format=json'];
  assert.deepEqual(claude.requiredFlags({ readOnly: true, model: 'm' }), [...req, '--model']);
  assert.deepEqual(claude.requiredFlags({ readOnly: true, model: 'm', effort: 'low' }), [...req, '--model', '--effort']);
  // With effort, the rest is unchanged.
  const withEffort = claude.buildArgs({ readOnly: false, budgetUsd: 2, model: 'm', effort: 'low' });
  assert.deepEqual(withEffort.filter((a, i, all) => a !== '--effort' && all[i - 1] !== '--effort'), claude.buildArgs({ readOnly: false, budgetUsd: 2, model: 'm' }));
});

test('F70 AC-2 harness run: roles without effort get no --effort; the other arguments match a run without any effort', async () => {
  const mixed = repo([{ id: 'F1', tier: 'critical' }], {
    roles: { builder: { adapter: 'claude', model: 'b1' }, evaluator: { adapter: 'claude', model: 'e1', effort: 'low' }, 'security-reviewer': { adapter: 'claude', model: 's1' } },
  });
  const plain = repo([{ id: 'F1', tier: 'critical' }], {
    roles: { builder: { adapter: 'claude', model: 'b1' }, evaluator: { adapter: 'claude', model: 'e1' }, 'security-reviewer': { adapter: 'claude', model: 's1' } },
  });
  const a = await withFakeClaude(() => runIn(mixed));
  const b = await withFakeClaude(() => runIn(plain));
  assert.deepEqual(statuses(mixed), { F1: 'passed' });
  assert.deepEqual(statuses(plain), { F1: 'passed' });
  for (const role of ['builder', 'security-reviewer']) {
    const argvs = a.calls.filter((c) => c.role === role).map((c) => c.argv);
    assert.equal(argvs.length, 1, role);
    assert.ok(!argvs[0].includes('--effort'), `${role}: ${argvs[0].join(' ')}`);
    assert.deepEqual(argvs, b.calls.filter((c) => c.role === role).map((c) => c.argv), role);
  }
  assert.ok(b.calls.every((c) => !c.argv.includes('--effort')));
  const ev = a.calls.find((c) => c.role === 'evaluator').argv;
  assert.equal(argOf(ev, '--effort'), 'low', 'only the role with effort gets --effort');
  assert.deepEqual(ev.filter((x, i, all) => x !== '--effort' && all[i - 1] !== '--effort'), b.calls.find((c) => c.role === 'evaluator').argv);
});

// ------------------------------------------------------------------ AC-3

test('F70 AC-3 harness run: by_tier and escalate builder calls carry the same --effort', async () => {
  const dir = repo([{ id: 'F1' }], {
    roles: { builder: { adapter: 'claude', model: 'b1', by_tier: { standard: 'b-std' }, escalate: 'b-esc', effort: 'xhigh' }, evaluator: { adapter: 'claude', model: 'e1' } },
  });
  const { calls } = await withFakeClaude(() => runIn(dir, { verify: scriptedVerify([false, false, false]) }));
  assert.equal(statuses(dir).F1, 'passed');
  const builds = calls.filter((c) => c.role === 'builder');
  assert.deepEqual(builds.map((c) => [c.model, c.effort]), [['b-std', 'xhigh'], ['b-std', 'xhigh'], ['b-std', 'xhigh'], ['b-esc', 'xhigh']]);
});

test('F70 AC-3 harness run: the conflict_model resolution call carries the same --effort', async () => {
  const dir = repo([{ id: 'F1' }], {
    roles: { builder: { adapter: 'claude', model: 'b1', conflict_model: 'b-c', effort: 'xhigh' }, evaluator: { adapter: 'claude', model: 'e1' } },
    files: { 'shared.txt': 'base\n' },
  });
  // A conflicting shared.txt lands on integration while F1 is verified.
  const verify = scriptedVerify([], async (a, n) => {
    if (n !== 1) return;
    const intWt = path.join(dir, '.harness', 'wt', '_integration');
    writeFiles(intWt, { 'shared.txt': 'human\n' });
    commitAll(intWt, 'conflicting change');
  });
  const { calls } = await withFakeClaude(() => runIn(dir, { verify }));
  assert.equal(statuses(dir).F1, 'passed');
  const builds = calls.filter((c) => c.role === 'builder');
  assert.deepEqual(builds.map((c) => [c.conflict, c.model, c.effort]), [[false, 'b1', 'xhigh'], [true, 'b-c', 'xhigh']]);
});

// ------------------------------------------------------------------ AC-4

test('F70 AC-4 harness run: metrics lines carry the effort passed (null when unset and for core steps); step events too', async () => {
  const dir = repo([{ id: 'F1', tier: 'critical' }], {
    roles: { builder: { adapter: 'claude', model: 'b1', effort: 'high' }, evaluator: { adapter: 'claude', model: 'e1' }, 'security-reviewer': { adapter: 'claude', model: 's1', effort: 'max' } },
  });
  await withFakeClaude(() => runIn(dir));
  assert.deepEqual(statuses(dir), { F1: 'passed' });
  const lines = metricLines(dir);
  for (const l of lines) assert.ok(Object.hasOwn(l, 'effort'), JSON.stringify(l));
  const by = (step) => lines.filter((l) => l.step === step).map((l) => l.effort);
  assert.deepEqual(by('build'), ['high']);
  assert.deepEqual(by('eval'), [null], 'the run eval line carries the evaluator effort (unset)');
  assert.ok(by('verify').length >= 1 && by('verify').every((x) => x === null));
  assert.ok(by('merge').length >= 1 && by('merge').every((x) => x === null));
  const steps = readEvents(dir).events.filter((e) => e.type === 'step');
  const ev = (stage) => steps.filter((e) => e.stage === stage).map((e) => e.data.effort);
  assert.deepEqual(ev('build'), ['high']);
  assert.deepEqual(ev('eval'), [null]);
  assert.deepEqual(ev('security'), ['max']);
});

test('F70 AC-4 harness run: the eval metrics line carries the evaluator effort when set', async () => {
  const dir = repo([{ id: 'F1' }], { roles: { builder: { adapter: 'claude', model: 'b1' }, evaluator: { adapter: 'claude', model: 'e1', effort: 'medium' } } });
  await withFakeClaude(() => runIn(dir));
  const lines = metricLines(dir);
  assert.deepEqual(lines.filter((l) => l.step === 'build').map((l) => l.effort), [null]);
  assert.deepEqual(lines.filter((l) => l.step === 'eval').map((l) => l.effort), ['medium']);
  assert.deepEqual(readEvents(dir).events.filter((e) => e.type === 'step' && e.stage === 'eval').map((e) => e.data.effort), ['medium']);
});

test('F70 AC-4 harness eval: eval.metrics.jsonl lines and step events carry each reviewer effort', async () => {
  const dir = repo([{ id: 'F1', tier: 'critical' }], { roles: EFFORT_ROLES });
  const json = { scores: { functionality: 9, quality: 9, security: 9, errors: 9, tests: 9 }, findings: [], out_of_scope: [] };
  const seen = [];
  const runAdapter = async (role, opts) => { seen.push([role, opts.effort]); return { ok: true, error: null, text: '', json, costUsd: 0, exitCode: 0 }; };
  await evalAndRecord({ root: dir, featureId: 'F1', base: 'main', config: loadConfig(dir), runAdapter, verifyResult: PASS_VERIFY });
  assert.deepEqual(seen.sort(), [['evaluator', 'medium'], ['security-reviewer', 'max']]);
  assert.deepEqual(metricLines(dir, 'eval.metrics.jsonl').map((m) => [m.role, m.effort]).sort(), [['evaluator', 'medium'], ['security-reviewer', 'max']]);
  const steps = readEvents(dir).events.filter((e) => e.type === 'step');
  assert.deepEqual(steps.map((e) => [e.stage, e.data.effort]).sort(), [['eval', 'medium'], ['security', 'max']]);
});

// ------------------------------------------------------------------ AC-5

const mline = (o) => ({
  feature: 'F1', round: 1, step: 'build', started_at: '2026-09-29T00:00:00.000Z', ended_at: '2026-09-29T00:00:10.000Z', duration_ms: 10_000,
  cost_usd: 1, role: 'builder', adapter: 'claude', model: 'opus', outcome: 'ok', turns: null, tokens: null, session_id: null, ...o,
});

function statsRepo() {
  const dir = repo([{ id: 'F1' }]);
  const rows = [
    mline({ effort: 'high', cost_usd: 2 }),
    mline({ effort: 'high', cost_usd: 1 }),
    mline({ effort: 'low', cost_usd: 0.5 }),
    mline({}), // written before effort existed
    mline({ step: 'verify', role: 'core', adapter: null, model: null, effort: null, cost_usd: null }),
  ];
  fs.mkdirSync(path.join(dir, '.harness', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.harness', 'runs', 'r1.metrics.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return dir;
}

test('F70 AC-5 harness stats --json: cost_by_role_model is split by role, model and effort; a line without effort counts as null', () => {
  const dir = statsRepo();
  const r = harness(['stats', '--json'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.deepEqual(s.cost_by_role_model, [
    { role: 'builder', model: 'opus', effort: 'high', count: 2, cost_usd: 3 },
    { role: 'builder', model: 'opus', effort: null, count: 1, cost_usd: 1 },
    { role: 'builder', model: 'opus', effort: 'low', count: 1, cost_usd: 0.5 },
    { role: 'core', model: null, effort: null, count: 1, cost_usd: 0 },
  ]);
});

test('F70 AC-5 harness stats: each role/model line shows the effort, or - when there is none', () => {
  const dir = statsRepo();
  const r = harness(['stats'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.split('\n');
  const find = (re) => lines.filter((l) => re.test(l));
  assert.equal(find(/^\s+builder\s+opus\s+high\s+\$3\.00 \(2 steps\)$/).length, 1, r.stdout);
  assert.equal(find(/^\s+builder\s+opus\s+low\s+\$0\.50 \(1 steps\)$/).length, 1, r.stdout);
  assert.equal(find(/^\s+builder\s+opus\s+-\s+\$1\.00 \(1 steps\)$/).length, 1, r.stdout);
  assert.equal(find(/^\s+core\s+-\s+-\s+\$0\.00 \(1 steps\)$/).length, 1, r.stdout);
});

// ------------------------------------------------------------------ AC-6

const PROBE = (help) => async (adapter) => (adapter.name === 'claude'
  ? { installed: true, version: 'claude fixture', help }
  : { installed: false, version: null, help: null });

async function doctorOut(config, help = CLAUDE_HELP) {
  const out = [];
  const err = [];
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.harness', 'config.json'), JSON.stringify(config));
  const code = await doctor({ root: dir, out: (s) => out.push(s), err: (s) => err.push(s), probe: PROBE(help), env: {} });
  return { code, lines: out.join('\n').split('\n') };
}

// The role's block: its line and the indented lines under it, up to the next role or section.
const roleBlock = (lines, role) => {
  const at = lines.findIndex((l) => new RegExp(`^  ${role}\\s`).test(l));
  assert.ok(at !== -1, `role line for ${role}`);
  const block = [];
  for (let i = at + 1; i < lines.length && /^ {4}\S/.test(lines[i]); i += 1) block.push(lines[i]);
  return { line: lines[at], block };
};

test('F70 AC-6 doctor: an "effort <value>" or "effort not set" line under each role line', async () => {
  const { code, lines } = await doctorOut({ roles: { builder: { adapter: 'claude', model: 'b1', effort: 'high' }, evaluator: { adapter: 'claude', model: 'e1' }, 'security-reviewer': { adapter: 'claude', model: 's1', effort: 'max' } } });
  assert.equal(code, 0, lines.join('\n'));
  assert.deepEqual(roleBlock(lines, 'builder').block.filter((l) => /effort/.test(l)), ['    effort high']);
  assert.deepEqual(roleBlock(lines, 'evaluator').block.filter((l) => /effort/.test(l)), ['    effort not set']);
  assert.deepEqual(roleBlock(lines, 'security-reviewer').block.filter((l) => /effort/.test(l)), ['    effort max']);
  for (const role of ['builder', 'evaluator', 'security-reviewer']) assert.match(roleBlock(lines, role).line, /usable$/);
});

test('F70 AC-6 doctor: --effort is a required flag only for a role with effort; a claude without it is not usable there', async () => {
  const noEffort = CLAUDE_HELP.split('\n').filter((l) => !/^\s*--effort\b/.test(l)).join('\n');
  const config = resolveConfig({ roles: { builder: { adapter: 'claude', model: 'b1', effort: 'high' }, evaluator: { adapter: 'claude', model: 'e1' } } });
  const r = await diagnose({ config, probe: PROBE(noEffort), env: {} });
  const builder = r.roles.find((x) => x.role === 'builder');
  const evaluator = r.roles.find((x) => x.role === 'evaluator');
  assert.equal(builder.usable, false);
  assert.deepEqual(builder.missing, ['--effort']);
  assert.equal(builder.reason, '--help lacks --effort');
  assert.equal(evaluator.usable, true, 'a role without effort does not need --effort');
  const full = await diagnose({ config, probe: PROBE(CLAUDE_HELP), env: {} });
  assert.equal(full.roles.find((x) => x.role === 'builder').usable, true);
  const { code, lines } = await doctorOut({ roles: { builder: { adapter: 'claude', model: 'b1', effort: 'high' } } }, noEffort);
  assert.equal(code, 1);
  assert.match(roleBlock(lines, 'builder').line, /NOT usable: --help lacks --effort$/);
});

// ------------------------------------------------------------------ AC-7

test('F70 AC-7 SPEC §4, §10 and §8.11 describe roles.<role>.effort, --effort and the effort in metrics and stats', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const section = (n) => {
    const start = spec.search(new RegExp(`^## ${n}\\.`, 'm'));
    assert.ok(start !== -1, `SPEC §${n} exists`);
    const rest = spec.slice(start + 3);
    const end = rest.search(/^## \d+\./m);
    return end === -1 ? rest : rest.slice(0, end);
  };
  const s4 = section(4);
  assert.ok(s4.includes('roles.<역할>.effort'), '§4 names roles.<역할>.effort');
  for (const v of ['`low`', '`medium`', '`high`', '`xhigh`', '`max`']) assert.ok(s4.includes(v), `§4 lists ${v}`);
  assert.ok(s4.includes('only supported by the claude adapter'), '§4 gives the non-claude check');
  const s10 = section(10);
  assert.ok(s10.includes('--effort'), '§10 names --effort');
  assert.ok(/effort[^\n]*역할 모델 정책|역할 모델 정책[^\n]*effort/.test(s10), '§10 relates effort to the role model policy');
  for (const k of ['by_tier', 'escalate', 'conflict_model']) assert.ok(/\*\*역할 effort\.\*\*[^\n]*/.exec(s10)?.[0].includes(k), `§10 effort paragraph covers ${k}`);
  const start = spec.indexOf('**실행 지표와 `harness stats`** (§8.11)');
  assert.ok(start !== -1, '§8.11 exists');
  const s811 = spec.slice(start, spec.indexOf('\n## ', start));
  assert.ok(s811.includes('`effort`'), '§8.11 names the effort field');
  assert.ok(s811.includes('역할·모델·effort'), '§8.11 splits stats by effort');
});

// ------------------------------------------------------------------ ES-1

const configError = (user) => {
  try { resolveConfig(user); return null; } catch (e) { return e; }
};

for (const [what, value] of [['"extreme"', 'extreme'], ['"HIGH" (upper case)', 'HIGH'], ['"" (empty)', ''], ['"--max" (flag-shaped)', '--max'], ['3 (number)', 3]]) {
  test(`F70 ES-1 roles.<role>.effort ${what} → config_invalid with the key path and the allowed values`, () => {
    for (const role of ['builder', 'evaluator', 'security-reviewer']) {
      const err = configError({ roles: { [role]: { adapter: 'claude', effort: value } } });
      assert.ok(err instanceof HarnessError, `accepted ${JSON.stringify(value)} for ${role}`);
      assert.equal(err.code, 'config_invalid');
      assert.equal(err.exit, 2);
      assert.ok(err.message.includes(`roles.${role}.effort`), err.message);
      assert.ok(err.message.includes('low, medium, high, xhigh, max'), err.message);
    }
  });
}

test('F70 ES-1 CLI: harness run and doctor exit 2 on an invalid effort and no model CLI is called', async () => {
  const dir = repo([{ id: 'F1' }], { roles: { builder: { adapter: 'claude', model: 'b1', effort: '--max' } } });
  const { calls } = await withFakeClaude(async () => {
    for (const args of [['run'], ['doctor']]) {
      const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'harness.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 2, `${args}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /roles\.builder\.effort/);
      assert.match(r.stderr, /low, medium, high, xhigh, max/);
    }
  });
  assert.deepEqual(calls, []);
  assert.ok(!fs.existsSync(path.join(dir, '.harness', 'wt', 'F1')));
});

test('F70 ES-1 every allowed effort is accepted', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const c = resolveConfig({ roles: { builder: { adapter: 'claude', effort } } });
    assert.equal(c.roles.builder.effort, effort);
  }
});

// ------------------------------------------------------------------ ES-2

for (const adapter of ['codex', 'gemini', 'generic']) {
  test(`F70 ES-2 effort on a ${adapter} role → config_invalid: only supported by the claude adapter`, () => {
    for (const role of ['builder', 'evaluator']) {
      const err = configError({ roles: { [role]: { adapter, model: 'm', effort: 'high' } } });
      assert.ok(err instanceof HarnessError, `accepted effort on ${adapter} ${role}`);
      assert.equal(err.code, 'config_invalid');
      assert.equal(err.exit, 2);
      assert.ok(err.message.includes(`roles.${role}.effort`), err.message);
      assert.ok(err.message.includes('only supported by the claude adapter'), err.message);
    }
  });
}

test('F70 ES-2 CLI: harness doctor exits 2 on effort for a codex role', () => {
  const dir = repo([{ id: 'F1' }], { roles: { evaluator: { adapter: 'codex', effort: 'low' } } });
  const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'harness.mjs'), 'doctor'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /roles\.evaluator\.effort/);
  assert.match(r.stderr, /only supported by the claude adapter/);
});
