import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpdir, writeJson, harness } from './helpers.mjs';
import { resolveConfig } from '../lib/config.mjs';
import {
  getAdapter, extractJson, parseOutput, independence, resolveInvocation, missingFlags,
} from '../lib/adapters/index.mjs';
import { createGenericAdapter } from '../lib/adapters/generic.mjs';
import { DENY } from '../lib/adapters/claude.mjs';
import doctor, { diagnose } from '../lib/commands/doctor.mjs';

const FIX = path.join(REPO, 'test', 'fixtures');
const FAKE = path.join(FIX, 'fake-cli.mjs');
const help = (f) => fs.readFileSync(path.join(FIX, 'help', f), 'utf8');
const CLAUDE_HELP = help('claude-2.1.280.txt');
const GEMINI_HELP = help('gemini-0.38.1.txt');

const GENERIC_CONFIG = {
  adapters: { generic: { command: ['mycli', '--headless', '--auto'], read_only_command: ['mycli', '--headless', '--read-only'] } },
};
const adapters = () => ({
  claude: getAdapter('claude'),
  gemini: getAdapter('gemini'),
  codex: getAdapter('codex'),
  generic: getAdapter('generic', GENERIC_CONFIG),
});
// Run an adapter against the fake CLI instead of its real binary.
const fake = (mode, arg) => ({ bin: process.execPath, binArgs: arg === undefined ? [FAKE, mode] : [FAKE, mode, arg] });
const RESULT_KEYS = ['ok', 'error', 'text', 'json', 'costUsd', 'exitCode'];
const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };

// ---------------------------------------------------------------- AC-1

test('F4 AC-1 every adapter exposes name, bin, buildArgs, requiredFlags, run', () => {
  for (const [name, a] of Object.entries(adapters())) {
    assert.equal(a.name, name);
    assert.equal(typeof a.bin, 'string', name);
    for (const fn of ['buildArgs', 'requiredFlags', 'run']) assert.equal(typeof a[fn], 'function', `${name}.${fn}`);
  }
  assert.equal(getAdapter('nope'), null);
});

test('F4 AC-1 run() passes the prompt on stdin and returns the common result shape', async () => {
  for (const [name, a] of Object.entries(adapters())) {
    for (const readOnly of [false, true]) {
      const r = await a.run({ role: readOnly ? 'evaluator' : 'builder', prompt: 'PROMPT-TEXT\nline 2', cwd: REPO, readOnly,
        schema: SCHEMA, timeoutSec: 30, budgetUsd: 1, model: 'm1', ...fake('echo-args') });
      for (const k of RESULT_KEYS) assert.ok(k in r, `${name}: missing ${k}`);
      assert.equal(r.ok, true, `${name}: ${r.error} ${r.detail}`);
      assert.equal(r.error, null);
      assert.equal(r.exitCode, 0);
      assert.equal(r.json.stdin, 'PROMPT-TEXT\nline 2', name);
      assert.deepEqual(r.json.argv, a.buildArgs({ readOnly, schema: SCHEMA, budgetUsd: 1, model: 'm1' }), name);
      assert.ok(!r.json.argv.some((x) => x.includes('PROMPT-TEXT')), `${name}: prompt leaked into argv`);
    }
  }
});

test('F4 AC-1 run() reads model text and cost from a recorded claude wrapper', async () => {
  const r = await adapters().claude.run({ prompt: 'x', cwd: REPO, readOnly: true, schema: SCHEMA, timeoutSec: 30,
    ...fake('print', path.join(FIX, 'output', 'claude-json-success.json')) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(r.text, '{"ok":true}');
  assert.equal(r.costUsd, 0.0701628);
});

test('F4 AC-1 run() reports exit_nonzero (with cost) and no_json without throwing', async () => {
  const budget = await adapters().claude.run({ prompt: 'x', cwd: REPO, timeoutSec: 30,
    ...fake('print-fail', path.join(FIX, 'output', 'claude-json-budget-exhausted.json')) });
  assert.equal(budget.ok, false);
  assert.equal(budget.error, 'exit_nonzero');
  assert.equal(budget.exitCode, 1);
  assert.equal(budget.costUsd, 0.0663634); // spend is still reported for budget accounting
  const fail = await adapters().gemini.run({ prompt: 'x', cwd: REPO, timeoutSec: 30, ...fake('exit', '41') });
  assert.equal(fail.ok, false);
  assert.equal(fail.error, 'exit_nonzero');
  assert.equal(fail.exitCode, 41);
  const noJson = await adapters().codex.run({ prompt: 'x', cwd: REPO, readOnly: true, schema: SCHEMA, timeoutSec: 30, ...fake('text', 'no json here') });
  assert.equal(noJson.error, 'no_json');
  assert.equal(noJson.text, 'no json here');
  const textOk = await adapters().codex.run({ prompt: 'x', cwd: REPO, timeoutSec: 30, ...fake('text', 'done') });
  assert.equal(textOk.ok, true); // no schema requested → plain text is fine
});

test('F4 AC-1 generic refuses a read-only call when no read_only_command is configured', async () => {
  const a = createGenericAdapter({ adapters: { generic: { command: ['mycli', '--auto'] } } });
  const r = await a.run({ prompt: 'x', cwd: REPO, readOnly: true, timeoutSec: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'adapter_unavailable');
});

// ---------------------------------------------------------------- AC-2 (SPEC §10 arg arrays)

const DENY_ARGS = ['Bash(git push:*)', 'Bash(git reset --hard:*)', 'Bash(rm -rf /:*)', 'Bash(rm -rf ~:*)', 'Bash(sudo:*)'];

test('F4 AC-2 claude builder: -p, auto mode, native deny list, json output, schema, budget, model', () => {
  const a = adapters().claude;
  assert.deepEqual(DENY, DENY_ARGS);
  assert.deepEqual(a.buildArgs({ readOnly: false }),
    ['-p', '--permission-mode', 'auto', '--disallowedTools', ...DENY_ARGS, '--output-format', 'json']);
  assert.deepEqual(a.buildArgs({ readOnly: false, schema: SCHEMA, budgetUsd: 2.5, model: 'opus' }),
    ['-p', '--permission-mode', 'auto', '--disallowedTools', ...DENY_ARGS, '--output-format', 'json',
      '--json-schema', JSON.stringify(SCHEMA), '--max-budget-usd', '2.5', '--model', 'opus']);
});

test('F4 AC-2 claude readOnly: -p, plan mode, json output', () => {
  const a = adapters().claude;
  assert.deepEqual(a.buildArgs({ readOnly: true }), ['-p', '--permission-mode', 'plan', '--output-format', 'json']);
  assert.deepEqual(a.buildArgs({ readOnly: true, schema: SCHEMA, budgetUsd: 1, model: 'sonnet' }),
    ['-p', '--permission-mode', 'plan', '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA),
      '--max-budget-usd', '1', '--model', 'sonnet']);
});

test('F4 AC-2 gemini builder: -p "" (prompt on stdin), yolo, sandbox, json output, model', () => {
  const a = adapters().gemini;
  assert.deepEqual(a.buildArgs({ readOnly: false }), ['-p', '', '--approval-mode', 'yolo', '-s', '-o', 'json']);
  // no structured-output or budget flag exists for gemini — schema/budget add nothing
  assert.deepEqual(a.buildArgs({ readOnly: false, schema: SCHEMA, budgetUsd: 3, model: 'gemini-2.5-pro' }),
    ['-p', '', '--approval-mode', 'yolo', '-s', '-o', 'json', '-m', 'gemini-2.5-pro']);
});

test('F4 AC-2 gemini readOnly: -p "", plan approval mode, json output', () => {
  const a = adapters().gemini;
  assert.deepEqual(a.buildArgs({ readOnly: true }), ['-p', '', '--approval-mode', 'plan', '-o', 'json']);
  assert.deepEqual(a.buildArgs({ readOnly: true, model: 'g' }), ['-p', '', '--approval-mode', 'plan', '-o', 'json', '-m', 'g']);
});

test('F4 AC-2 codex builder: exec, workspace-write sandbox, prompt from stdin', () => {
  const a = adapters().codex;
  assert.equal(a.experimental, true);
  assert.deepEqual(a.buildArgs({ readOnly: false }), ['exec', '--sandbox', 'workspace-write', '-']);
  assert.deepEqual(a.buildArgs({ readOnly: false, schema: SCHEMA, budgetUsd: 1, model: 'o4' }),
    ['exec', '--sandbox', 'workspace-write', '--model', 'o4', '-']);
});

test('F4 AC-2 codex readOnly: exec, read-only sandbox, prompt from stdin', () => {
  assert.deepEqual(adapters().codex.buildArgs({ readOnly: true }), ['exec', '--sandbox', 'read-only', '-']);
});

test('F4 AC-2 generic builder and readOnly: config command templates', () => {
  const a = adapters().generic;
  assert.equal(a.bin, 'mycli');
  assert.deepEqual(a.buildArgs({ readOnly: false }), ['--headless', '--auto']);
  assert.deepEqual(a.buildArgs({ readOnly: true }), ['--headless', '--read-only']);
});

test('F4 AC-2 win32: .cmd shims run through cmd.exe with escaped arguments; .exe spawn directly', () => {
  const env = { Path: 'C:\\Program Files\\nodejs;C:\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const files = new Set(['C:\\Program Files\\nodejs\\gemini.cmd', 'C:\\bin\\claude.exe']);
  const exists = (f) => files.has(f);
  const gem = resolveInvocation('gemini', getAdapter('gemini').buildArgs({ readOnly: true }), { platform: 'win32', env, exists });
  assert.equal(typeof gem, 'string'); // runCommand runs strings as `cmd.exe /d /s /c "<line>"`
  assert.equal(gem, 'C:\\Program^ Files\\nodejs\\gemini.cmd ^^^"-p^^^" ^^^"^^^" ^^^"--approval-mode^^^" ^^^"plan^^^" ^^^"-o^^^" ^^^"json^^^"');
  const cl = resolveInvocation('claude', ['-p', 'Bash(git push:*)'], { platform: 'win32', env, exists });
  assert.deepEqual(cl, { file: 'C:\\bin\\claude.exe', args: ['-p', 'Bash(git push:*)'] });
  assert.equal(resolveInvocation('codex', ['exec'], { platform: 'win32', env, exists }), null);
  // metacharacters and embedded quotes in a .cmd argument are neutralised
  const js = resolveInvocation('gemini', ['{"a":"b & c"}'], { platform: 'win32', env, exists });
  assert.ok(js.endsWith(' ^^^"{\\^^^"a\\^^^":\\^^^"b^^^ ^^^&^^^ c\\^^^"}^^^"'), js);
  // POSIX: spawn directly, arguments verbatim
  assert.deepEqual(resolveInvocation('gemini', ['-p', ''], { platform: 'linux' }), { file: 'gemini', args: ['-p', ''] });
});

// ---------------------------------------------------------------- AC-3

test('F4 AC-3 extractJson: pure JSON', () => {
  assert.deepEqual(extractJson('  {"scores":{"quality":8},"findings":[]}\n'), { scores: { quality: 8 }, findings: [] });
  assert.deepEqual(extractJson('[1,2]'), [1, 2]);
  assert.equal(extractJson('42'), null);
  assert.equal(extractJson('no json at all'), null);
  assert.equal(extractJson(''), null);
});

test('F4 AC-3 extractJson: ```json fenced block inside prose', () => {
  const text = 'Here is my verdict:\n\n```json\n{"scores":{"security":9},"findings":[]}\n```\nThanks.';
  assert.deepEqual(extractJson(text), { scores: { security: 9 }, findings: [] });
  // the last parsable fenced block wins; non-json fences are ignored
  const two = '```js\nconst a = {"x":1}\n```\n```json\n{"draft":true}\n```\n```json\n{"final":true}\n```';
  assert.deepEqual(extractJson(two), { final: true });
});

test('F4 AC-3 extractJson: claude --output-format json wrapper (measured), result text possibly fenced', () => {
  const raw = fs.readFileSync(path.join(FIX, 'output', 'claude-json-success.json'), 'utf8');
  assert.deepEqual(extractJson(raw), { ok: true });
  assert.equal(parseOutput(raw).costUsd, 0.0701628);
  const fenced = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.5,
    result: 'Verdict:\n```json\n{"scores":{"tests":7}}\n```' });
  assert.deepEqual(parseOutput(fenced), { json: { scores: { tests: 7 } }, text: 'Verdict:\n```json\n{"scores":{"tests":7}}\n```', costUsd: 0.5 });
  const structured = JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.1, result: 'done', structured_output: { ok: false } });
  assert.deepEqual(extractJson(structured), { ok: false });
  // error wrapper (budget exhausted, measured): no result text, cost still read
  const err = parseOutput(fs.readFileSync(path.join(FIX, 'output', 'claude-json-budget-exhausted.json'), 'utf8'));
  assert.deepEqual(err, { json: null, text: '', costUsd: 0.0663634 });
});

test('F4 AC-3 extractJson: gemini -o json wrapper response text', () => {
  const raw = JSON.stringify({ session_id: 's', response: '```json\n{"ok":1}\n```', stats: {} });
  assert.deepEqual(extractJson(raw), { ok: 1 });
});

// ---------------------------------------------------------------- AC-4

const fixtureProbe = (helps) => async (adapter) => (helps[adapter.name] === undefined
  ? { installed: false, version: null, help: null }
  : { installed: true, version: `${adapter.name} fixture`, help: helps[adapter.name] });

test('F4 AC-4 missingFlags checks flags and their choice values against measured --help', () => {
  assert.deepEqual(missingFlags(CLAUDE_HELP, getAdapter('claude').requiredFlags({ readOnly: false, schema: {}, budgetUsd: 1, model: 'x' })), []);
  assert.deepEqual(missingFlags(CLAUDE_HELP, getAdapter('claude').requiredFlags({ readOnly: true, schema: {} })), []);
  assert.deepEqual(missingFlags(GEMINI_HELP, getAdapter('gemini').requiredFlags({ readOnly: false, model: 'x' })), []);
  assert.deepEqual(missingFlags(GEMINI_HELP, getAdapter('gemini').requiredFlags({ readOnly: true })), []);
  assert.deepEqual(missingFlags(CLAUDE_HELP, ['--permission-mode=yolo', '--sandbox', '--output-format=xml']),
    ['--permission-mode=yolo', '--sandbox', '--output-format=xml']);
  assert.deepEqual(missingFlags(GEMINI_HELP, ['--approval-mode=auto']), ['--approval-mode=auto']);
});

test('F4 AC-4 doctor: all roles usable with measured help fixtures → exit 0', async () => {
  const config = resolveConfig({ roles: { builder: 'claude', evaluator: 'gemini', 'security-reviewer': 'claude' } });
  const report = await diagnose({ config, probe: fixtureProbe({ claude: CLAUDE_HELP, gemini: GEMINI_HELP }) });
  assert.equal(report.ok, true, JSON.stringify(report.roles));
  assert.deepEqual(report.roles.map((r) => [r.role, r.adapter, r.readOnly, r.usable]),
    [['builder', 'claude', false, true], ['evaluator', 'gemini', true, true], ['security-reviewer', 'claude', true, true]]);
  const codex = report.clis.find((c) => c.name === 'codex');
  assert.equal(codex.installed, false);
});

test('F4 AC-4 doctor: a role whose flags are absent from --help is reported unusable → exit 1', async () => {
  const dir = tmpdir();
  const lines = [];
  const code = await doctor({ root: dir, args: [], out: (s) => lines.push(s), err: (s) => lines.push(s),
    probe: fixtureProbe({ claude: CLAUDE_HELP, gemini: help('gemini-old-no-approval-mode.txt') }) });
  // defaults (not initialized): every role is claude → usable; now assign gemini to evaluator
  assert.equal(code, 0);
  writeJson(path.join(dir, '.harness', 'config.json'), { roles: { builder: 'claude', evaluator: 'gemini', 'security-reviewer': 'codex' } });
  writeJson(path.join(dir, '.harness', 'features.json'), { features: [] });
  lines.length = 0;
  const code2 = await doctor({ root: dir, args: [], out: (s) => lines.push(s), err: (s) => lines.push(s),
    probe: fixtureProbe({ claude: CLAUDE_HELP, gemini: help('gemini-old-no-approval-mode.txt') }) });
  assert.equal(code2, 1);
  const text = lines.join('\n');
  assert.match(text, /builder\s+claude\s+write\s+usable/);
  assert.match(text, /evaluator\s+gemini\s+read-only\s+NOT usable: --help lacks --approval-mode=plan/);
  assert.match(text, /security-reviewer\s+codex\s+read-only\s+NOT usable: codex not installed/);
});

test('F4 AC-4 doctor: generic without read_only_command cannot take an evaluator role', async () => {
  const config = resolveConfig({ roles: { builder: 'claude', evaluator: 'generic', 'security-reviewer': 'claude' },
    adapters: { generic: { command: ['mycli', '--auto'] } } });
  const report = await diagnose({ config, probe: fixtureProbe({ claude: CLAUDE_HELP, generic: 'Usage: mycli\n  --auto  go\n' }) });
  const ev = report.roles.find((r) => r.role === 'evaluator');
  assert.equal(ev.usable, false);
  assert.equal(report.ok, false);
});

test('F4 AC-4 doctor is dispatched by the CLI without initialized state', () => {
  const r = harness(['doctor'], { cwd: tmpdir(), env: { PATH: '' } }); // no CLIs on PATH
  assert.equal(r.code, 1);
  assert.match(r.stdout, /builder\s+claude\s+write\s+NOT usable: claude not installed/);
});

// ---------------------------------------------------------------- AC-5

test('F4 AC-5 independence: same adapter and model → fresh-context, different → cross-model', () => {
  assert.equal(independence({ builder: 'claude', evaluator: 'claude' }), 'fresh-context');
  assert.equal(independence({ builder: 'claude', evaluator: 'gemini' }), 'cross-model');
  assert.equal(independence({ builder: { adapter: 'claude', model: 'opus' }, evaluator: { adapter: 'claude', model: 'sonnet' } }), 'cross-model');
  assert.equal(independence({ builder: { adapter: 'claude', model: 'opus' }, evaluator: { adapter: 'claude', model: 'opus' } }), 'fresh-context');
  assert.equal(independence({ builder: 'claude', evaluator: { adapter: 'claude', model: 'opus' } }, { adapters: { claude: { model: 'opus' } } }), 'fresh-context');
  assert.equal(independence({ builder: 'claude', evaluator: 'claude' }, { adapters: { claude: { model: 'opus' } } }), 'fresh-context');
});

test('F4 AC-5 doctor warns when builder and evaluator are the same model', async () => {
  const dir = tmpdir();
  const out = [];
  const errs = [];
  const code = await doctor({ root: dir, args: [], out: (s) => out.push(s), err: (s) => errs.push(s),
    probe: fixtureProbe({ claude: CLAUDE_HELP }) });
  assert.equal(code, 0); // warning only
  assert.match(out.join('\n'), /independence: fresh-context/);
  assert.match(errs.join('\n'), /warning: builder and evaluator use the same model \(claude\)/);
  const report = await diagnose({ config: resolveConfig({ roles: { evaluator: 'gemini' } }),
    probe: fixtureProbe({ claude: CLAUDE_HELP, gemini: GEMINI_HELP }) });
  assert.equal(report.independence, 'cross-model');
  assert.ok(!report.warnings.some((w) => /same model/.test(w)));
});

// ---------------------------------------------------------------- SC-1 (SR-6)

const WRITE_FLAGS = ['auto', 'yolo', 'workspace-write', 'bypassPermissions', 'acceptEdits', 'auto_edit',
  'danger-full-access', '--dangerously-skip-permissions', '--yolo', '-y', '--disallowedTools', '-s'];

test('F4 SC-1 claude: readOnly uses --permission-mode plan and no write-mode flag', () => {
  for (const opts of [{}, { schema: SCHEMA, budgetUsd: 1, model: 'opus' }]) {
    const args = getAdapter('claude').buildArgs({ readOnly: true, ...opts });
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
    assert.equal(args.filter((a) => a === '--permission-mode').length, 1);
    for (const w of WRITE_FLAGS) assert.ok(!args.includes(w), w);
  }
});

test('F4 SC-1 gemini: readOnly uses --approval-mode plan and no write-mode flag', () => {
  for (const opts of [{}, { model: 'g' }]) {
    const args = getAdapter('gemini').buildArgs({ readOnly: true, ...opts });
    assert.equal(args[args.indexOf('--approval-mode') + 1], 'plan');
    assert.equal(args.filter((a) => a === '--approval-mode').length, 1);
    for (const w of WRITE_FLAGS) assert.ok(!args.includes(w), w);
  }
});

test('F4 SC-1 codex: readOnly uses --sandbox read-only and no write-mode flag', () => {
  for (const opts of [{}, { model: 'o4' }]) {
    const args = getAdapter('codex').buildArgs({ readOnly: true, ...opts });
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    for (const w of WRITE_FLAGS) assert.ok(!args.includes(w), w);
  }
});

test('F4 SC-1 generic: readOnly uses the read_only_command, never the write command', () => {
  const args = adapters().generic.buildArgs({ readOnly: true });
  assert.ok(args.includes('--read-only'));
  assert.ok(!args.includes('--auto'));
});

// ---------------------------------------------------------------- ES-1 / ES-2

test('F4 ES-1 missing CLI binary → adapter_unavailable, no throw', async () => {
  const missing = path.join(tmpdir(), 'no-such-cli');
  for (const [name, a] of Object.entries(adapters())) {
    const r = await a.run({ prompt: 'x', cwd: REPO, readOnly: true, timeoutSec: 10, bin: missing });
    assert.equal(r.ok, false, name);
    assert.equal(r.error, 'adapter_unavailable', `${name}: ${r.error} ${r.detail}`);
    for (const k of RESULT_KEYS) assert.ok(k in r, `${name}: ${k}`);
  }
  // win32 resolution that finds nothing is also adapter_unavailable (no spawn attempted)
  const r = await getAdapter('gemini').run({ prompt: 'x', cwd: REPO, timeoutSec: 5, platform: 'win32', env: { Path: 'C:\\none' }, exists: () => false });
  assert.equal(r.error, 'adapter_unavailable');
  // unconfigured generic adapter
  const g = await getAdapter('generic', {}).run({ prompt: 'x', cwd: REPO, timeoutSec: 5 });
  assert.equal(g.error, 'adapter_unavailable');
});

test('F4 ES-2 timeout kills the child and returns timeout', async () => {
  const pidfile = path.join(tmpdir(), 'pid');
  const started = Date.now();
  const r = await getAdapter('claude').run({ prompt: 'x', cwd: REPO, readOnly: false, timeoutSec: 0.5, ...fake('sleep', pidfile) });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timeout');
  assert.ok(Date.now() - started < 20_000);
  const pid = Number(fs.readFileSync(pidfile, 'utf8'));
  let alive = true;
  for (let i = 0; i < 50 && alive; i += 1) {
    try { process.kill(pid, 0); await new Promise((res) => setTimeout(res, 100)); } catch { alive = false; }
  }
  assert.equal(alive, false, `child ${pid} still running`);
});
