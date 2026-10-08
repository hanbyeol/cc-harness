import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpdir } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { loadRolePrompt } from '../lib/roles.mjs';
import { evaluate, buildPrompt, OUTPUT_SCHEMA } from '../lib/eval.mjs';
import doctor, { diagnose } from '../lib/commands/doctor.mjs';
import claude from '../lib/adapters/claude.mjs';
import { openItems } from '../lib/backlog.mjs';

const FIX = path.join(REPO, 'test', 'fixtures');
const MODEL_CLI = path.join(FIX, 'fake-model-cli.mjs');
const CLAUDE_HELP = fs.readFileSync(path.join(FIX, 'help', 'claude-2.1.280.txt'), 'utf8');

// The pre-feature builder deny list (SPEC §10 <deny>), spelled out so a shrunk DENY is noticed.
const DENY_ARGS = ['Bash(git push:*)', 'Bash(git reset --hard:*)', 'Bash(rm -rf /:*)', 'Bash(rm -rf ~:*)', 'Bash(sudo:*)'];
const BUILDER_OFF = ['Workflow', 'Skill', 'ReportFindings', 'ListAgents', 'Agent'];
const BUILDER_KEPT = ['ScheduleWakeup', 'Monitor', 'ToolSearch'];
const READ_ONLY_OFF = ['Workflow', 'ScheduleWakeup', 'Skill', 'ReportFindings', 'ListAgents', 'Agent'];
const NEW_FLAGS = ['--strict-mcp-config', '--disable-slash-commands'];
const CLAUDE_ROLES = {
  builder: { adapter: 'claude', model: 'b1' },
  evaluator: { adapter: 'claude', model: 'e1', effort: 'medium' },
  'security-reviewer': { adapter: 'claude', model: 's1' },
};

const argOf = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
};

// The values of the variadic --disallowedTools: the arguments after it up to the next option.
function deniedOf(argv) {
  assert.equal(argv.filter((a) => a === '--disallowedTools').length, 1, JSON.stringify(argv));
  const out = [];
  for (let j = argv.indexOf('--disallowedTools') + 1; j < argv.length && !argv[j].startsWith('-'); j += 1) out.push(argv[j]);
  return out;
}

// Runs fn with $FAKE_MODEL_LOG set; returns the fake claude calls as {argv, head}.
async function logged(fn) {
  const log = path.join(tmpdir('harness-log-'), 'calls.jsonl');
  const saved = process.env.FAKE_MODEL_LOG;
  process.env.FAKE_MODEL_LOG = log;
  let result;
  try {
    result = await fn();
  } finally {
    if (saved === undefined) delete process.env.FAKE_MODEL_LOG; else process.env.FAKE_MODEL_LOG = saved;
  }
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { result, calls };
}

// The claude adapter run against the fake claude (fake-model-cli.mjs) instead of the real CLI.
const fakeClaude = (opts) => claude.run({ ...opts, bin: process.execPath, binArgs: [MODEL_CLI] });

function contract(id = 'F9', tier = 'standard') {
  const c = {
    id, title: `feature ${id}`, security_tier: tier, version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node -e "process.exit(0)"', new: false }],
    security_criteria: tier === 'critical' ? [{ id: 'SC-1', criterion: 'ok', check: 'node -e "process.exit(0)"', new: false }] : [],
    error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-08T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

// A repo on branch `feature` with F9 committed on main; `changed` files are written after the
// base commit, so they are the diff the evaluation sees.
function repo({ items = [], tier = 'standard', roles = CLAUDE_ROLES, changed = {} } = {}) {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, roles },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F9', title: 'feature F9', security_tier: tier, depends_on: [], status: 'approved' }] },
    '.harness/contracts/F9.json': contract('F9', tier),
    '.harness/backlog.json': { items },
    'lib/widget.mjs': 'export const widget = 1;\n',
    'lib/other.mjs': 'export const other = 1;\n',
  });
  writeFiles(dir, changed);
  return dir;
}

const PASS_VERIFY = { pass: true, commands: [], criteria: [{ id: 'AC-1', pass: true }], integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } }, warnings: [] };
const scores = () => ({ functionality: 9, quality: 9, security: 9, errors: 9, tests: 9 });
const passing = () => ({ ok: true, error: null, text: '', json: { scores: scores(), findings: [], out_of_scope: [] }, costUsd: 0, exitCode: 0 });

// An adapter stand-in that records each role's prompts and answers with `replies` (default: a pass).
function recorder(replies = []) {
  const q = [...replies];
  const fn = async (role, opts) => {
    (fn.prompts[role] ??= []).push(opts.prompt);
    return q.length ? q.shift() : passing();
  };
  fn.prompts = {};
  return fn;
}

async function evalPrompts({ items, tier, roles = CLAUDE_ROLES, changed, replies } = {}) {
  const dir = repo({ items, tier, roles, changed });
  const runAdapter = recorder(replies);
  const config = resolveConfig({ profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, roles });
  const result = await evaluate({ root: dir, featureId: 'F9', base: 'main', config, verifyResult: PASS_VERIFY, runAdapter });
  return { result, prompts: runAdapter.prompts };
}

// The "## <title>" section of a prompt up to the next "## " heading (the last one when several).
function sectionOf(text, title) {
  const at = text.lastIndexOf(`\n## ${title}`);
  if (at === -1) return null;
  const next = text.indexOf('\n## ', at + 1);
  return text.slice(at + 1, next === -1 ? undefined : next);
}

const listed = (prompt) => [...sectionOf(prompt, 'Open backlog').matchAll(/^- (B\d+) \[/gm)].map((m) => m[1]);
const backlogLines = (prompt) => sectionOf(prompt, 'Open backlog').split('\n').filter((l) => l.startsWith('- '));

// ------------------------------------------------------------------ AC-1

test('F86 AC-1 builder: the fake claude gets --strict-mcp-config, --disable-slash-commands and the unused tools in --disallowedTools', async () => {
  for (const opts of [{}, { budgetUsd: 2, model: 'm', effort: 'high' }]) {
    const { result, calls } = await logged(() => fakeClaude({ prompt: '# Task: feature F1\n', cwd: tmpdir('harness-cwd-'), timeoutSec: 60, readOnly: false, ...opts }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(calls.length, 1);
    const { argv } = calls[0];
    for (const f of NEW_FLAGS) assert.equal(argv.filter((a) => a === f).length, 1, `${f} in ${JSON.stringify(argv)}`);
    const denied = deniedOf(argv);
    for (const t of [...DENY_ARGS, ...BUILDER_OFF]) assert.ok(denied.includes(t), `${t} denied: ${JSON.stringify(denied)}`);
    for (const t of BUILDER_KEPT) assert.ok(!denied.includes(t), `${t} stays available to the builder`);
    assert.equal(argOf(argv, '--permission-mode'), 'auto');
  }
});

test('F86 AC-1 builder: without the new flags and tools the arguments are the pre-feature ones', async () => {
  const { calls } = await logged(() => fakeClaude({ prompt: '# Task: feature F1\n', cwd: tmpdir('harness-cwd-'), timeoutSec: 60, readOnly: false, budgetUsd: 2, model: 'm', effort: 'high' }));
  const rest = calls[0].argv.filter((a) => !NEW_FLAGS.includes(a) && !BUILDER_OFF.includes(a));
  assert.deepEqual(rest, ['-p', '--permission-mode', 'auto', '--disallowedTools', ...DENY_ARGS, '--output-format', 'json',
    '--max-budget-usd', '2', '--model', 'm', '--effort', 'high']);
});

// ------------------------------------------------------------------ AC-2

test('F86 AC-2 evaluator and security-reviewer: the fake claude gets the new flags and the read-only tool exclusions, plan mode and --json-schema unchanged', async () => {
  const dir = repo({ tier: 'critical', roles: CLAUDE_ROLES });
  const config = resolveConfig({ profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, roles: CLAUDE_ROLES });
  const heads = Object.fromEntries(['evaluator', 'security-reviewer'].map((r) => [r, loadRolePrompt(r).slice(0, 120)]));
  const { result, calls } = await logged(() => evaluate({ root: dir, featureId: 'F9', base: 'main', config, verifyResult: PASS_VERIFY,
    runAdapter: (role, opts) => fakeClaude(opts) }));
  assert.equal(result.verdict, 'pass', JSON.stringify(result));
  const byRole = Object.fromEntries(calls.map((c) => [Object.keys(heads).find((r) => c.head.startsWith(heads[r])), c.argv]));
  assert.deepEqual(Object.keys(byRole).sort(), ['evaluator', 'security-reviewer']);
  const expected = {
    evaluator: ['--model', 'e1', '--effort', 'medium'],
    'security-reviewer': ['--model', 's1'],
  };
  for (const [role, argv] of Object.entries(byRole)) {
    for (const f of NEW_FLAGS) assert.equal(argv.filter((a) => a === f).length, 1, `${role}: ${f} in ${JSON.stringify(argv)}`);
    const denied = deniedOf(argv);
    for (const t of READ_ONLY_OFF) assert.ok(denied.includes(t), `${role}: ${t} denied: ${JSON.stringify(denied)}`);
    // The pre-feature read-only arguments, in their order, once the new ones are taken out.
    const rest = argv.filter((a) => !NEW_FLAGS.includes(a) && a !== '--disallowedTools' && !denied.includes(a));
    assert.deepEqual(rest, ['-p', '--permission-mode', 'plan', '--output-format', 'json', '--json-schema', JSON.stringify(OUTPUT_SCHEMA), ...expected[role]], role);
  }
});

test('F86 AC-2 claude adapter: every read-only call carries the flags, with or without schema, budget, model and effort', () => {
  for (const opts of [{}, { schema: { type: 'object' } }, { schema: { type: 'object' }, budgetUsd: 1, model: 'm', effort: 'low' }]) {
    const argv = claude.buildArgs({ readOnly: true, ...opts });
    for (const f of NEW_FLAGS) assert.ok(argv.includes(f), `${f} in ${JSON.stringify(argv)}`);
    assert.deepEqual(deniedOf(argv), READ_ONLY_OFF);
    assert.equal(argOf(argv, '--permission-mode'), 'plan');
    for (const w of ['auto', ...DENY_ARGS]) assert.ok(!argv.includes(w), w);
    if (opts.schema) assert.equal(argOf(argv, '--json-schema'), JSON.stringify(opts.schema));
  }
});

// ------------------------------------------------------------------ AC-3

const PROBE = (help) => async (adapter) => (adapter.name === 'claude'
  ? { installed: true, version: '2.1.280 (Claude Code)', help }
  : { installed: false, version: null, help: null });

// The help fixture without the declaration line of `flag`.
const helpWithout = (flag) => CLAUDE_HELP.split('\n').filter((l) => !l.trimStart().startsWith(`${flag} `) && !l.trimStart().startsWith(`${flag},`)).join('\n');

async function doctorOut(help) {
  const out = [];
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.harness', 'config.json'), JSON.stringify({ roles: CLAUDE_ROLES }));
  const code = await doctor({ root: dir, out: (s) => out.push(s), err: () => {}, probe: PROBE(help), env: {} });
  return { code, text: out.join('\n') };
}

test('F86 AC-3 claude requires --strict-mcp-config, --disable-slash-commands and --disallowedTools in both modes', () => {
  for (const readOnly of [false, true]) {
    const req = claude.requiredFlags({ readOnly, schema: readOnly ? {} : undefined });
    for (const f of [...NEW_FLAGS, '--disallowedTools']) assert.ok(req.includes(f), `${readOnly ? 'read-only' : 'write'}: ${f} in ${JSON.stringify(req)}`);
  }
});

test('F86 AC-3 doctor: a claude whose --help lacks --strict-mcp-config is not usable for any role', async () => {
  const help = helpWithout('--strict-mcp-config');
  assert.ok(!/^\s*--strict-mcp-config\b/m.test(help) && help.includes('--disable-slash-commands'));
  const report = await diagnose({ config: resolveConfig({ roles: CLAUDE_ROLES }), probe: PROBE(help), env: {} });
  for (const r of report.roles) {
    assert.equal(r.usable, false, r.role);
    assert.equal(r.reason, '--help lacks --strict-mcp-config', r.role);
  }
  assert.equal(report.ok, false);
  const { code, text } = await doctorOut(help);
  assert.equal(code, 1);
  for (const role of ['builder', 'evaluator', 'security-reviewer']) {
    assert.match(text, new RegExp(`^  ${role}\\s.*NOT usable: --help lacks --strict-mcp-config$`, 'm'), text);
  }
});

test('F86 AC-3 doctor: --disable-slash-commands and --disallowedTools are required too, for read-only roles as well', async () => {
  for (const flag of ['--disable-slash-commands', '--disallowedTools']) {
    const report = await diagnose({ config: resolveConfig({ roles: CLAUDE_ROLES }), probe: PROBE(helpWithout(flag)), env: {} });
    for (const r of report.roles) assert.equal(r.reason, `--help lacks ${flag}`, `${r.role} without ${flag}`);
  }
});

test('F86 AC-3 doctor: the measured claude 2.1.280 --help fixture is usable for every role', async () => {
  const report = await diagnose({ config: resolveConfig({ roles: CLAUDE_ROLES }), probe: PROBE(CLAUDE_HELP), env: {} });
  assert.deepEqual(report.roles.map((r) => [r.role, r.usable, r.missing]),
    [['builder', true, []], ['evaluator', true, []], ['security-reviewer', true, []]]);
  const { code, text } = await doctorOut(CLAUDE_HELP);
  assert.equal(code, 0, text);
  for (const role of ['builder', 'evaluator', 'security-reviewer']) assert.match(text, new RegExp(`^  ${role}\\s.*\\susable$`, 'm'), text);
});

// ------------------------------------------------------------------ AC-4

const OLD_OUTPUT = 'Reply with one JSON object matching this schema and nothing else';

test('F86 AC-4 claude (--json-schema): the evaluator and security-reviewer prompts ask for a StructuredOutput tool call, never "nothing else"', async () => {
  const { result, prompts } = await evalPrompts({ tier: 'critical', roles: CLAUDE_ROLES });
  assert.equal(result.verdict, 'pass', JSON.stringify(result));
  for (const role of ['evaluator', 'security-reviewer']) {
    assert.equal(prompts[role]?.length, 1, role);
    const prompt = prompts[role][0];
    const output = sectionOf(prompt, 'Output');
    assert.match(output, /StructuredOutput tool/, `${role}: ${output}`);
    assert.ok(output.includes(JSON.stringify(OUTPUT_SCHEMA)), `${role}: the schema is still shown`);
    // Neither the harness's Output section nor the role prompt's own one says "nothing else".
    assert.ok(!prompt.includes('nothing else'), `${role}: ${prompt.slice(prompt.indexOf('nothing else') - 200)}`);
  }
});

test('F86 AC-4 codex, gemini and generic (no schema passed): the prompt keeps the pre-feature Output instruction', async () => {
  for (const adapter of ['codex', 'gemini', 'generic']) {
    const roles = { builder: 'claude', evaluator: adapter, 'security-reviewer': adapter };
    const { result, prompts } = await evalPrompts({ tier: 'critical', roles });
    assert.equal(result.verdict, 'pass', `${adapter}: ${JSON.stringify(result)}`);
    for (const role of ['evaluator', 'security-reviewer']) {
      const output = sectionOf(prompts[role][0], 'Output');
      assert.ok(output.startsWith(`## Output\n${OLD_OUTPUT}:\n`), `${adapter} ${role}: ${output}`);
      assert.ok(output.includes(JSON.stringify(OUTPUT_SCHEMA)), `${adapter} ${role}`);
      assert.ok(!output.includes('StructuredOutput'), `${adapter} ${role}`);
    }
  }
});

test('F86 AC-4 a schema-mismatch retry repeats the instruction of the adapter: StructuredOutput for claude, the JSON reply otherwise', async () => {
  const bad = { ok: true, error: null, text: '', json: { scores: {} }, costUsd: 0, exitCode: 0 };
  const c = await evalPrompts({ roles: CLAUDE_ROLES, replies: [bad] });
  assert.equal(c.prompts.evaluator.length, 2);
  const retry = c.prompts.evaluator[1].slice(c.prompts.evaluator[0].length);
  assert.match(retry, /## Retry/);
  assert.match(retry, /StructuredOutput tool/);
  assert.ok(!retry.includes('nothing else'), retry);
  const g = await evalPrompts({ roles: { builder: 'claude', evaluator: 'gemini', 'security-reviewer': 'gemini' }, replies: [bad] });
  assert.match(g.prompts.evaluator[1].slice(g.prompts.evaluator[0].length), /Reply with exactly one JSON object matching the schema above and nothing else/);
});

test('F86 AC-4 agents/evaluator.md and agents/security-reviewer.md: Output says StructuredOutput when available, one JSON object otherwise', () => {
  for (const role of ['evaluator', 'security-reviewer']) {
    const md = fs.readFileSync(path.join(REPO, 'agents', `${role}.md`), 'utf8');
    const output = sectionOf(md, 'Output');
    assert.ok(output, role);
    assert.match(output, /`StructuredOutput` tool is available/, `${role}: ${output}`);
    assert.match(output, /[Oo]therwise,? reply with a single JSON object/, `${role}: ${output}`);
    assert.ok(!output.includes('nothing else'), role);
  }
});

// ------------------------------------------------------------------ AC-5

const plain = (from, to, extra = {}) => Array.from({ length: to - from + 1 }, (_, k) => ({ id: `B${from + k}`, summary: `plain item ${from + k}.`, ...extra }));

test('F86 AC-5 items about a changed file come first even from the end of the list, then the pre-feature order', async () => {
  const items = [
    ...plain(1, 3, { priority: 'high' }),
    ...plain(4, 17),
    { id: 'B18', summary: 'file field names the changed path', file: 'lib/widget.mjs' },
    { id: 'B19', summary: 'crash in widget.mjs when empty', priority: 'low' },
    { id: 'B20', summary: 'see lib/widget.mjs line 3' },
    { id: 'B21', summary: 'widget without an extension is not a file name', file: 'lib/other.mjs' },
  ];
  const { prompts } = await evalPrompts({ items, changed: { 'lib/widget.mjs': 'export const widget = 2;\n' } });
  const prompt = prompts.evaluator[0];
  // related: B19 (low) before B18 and B20 (no priority, file order); then high B1–B3, then the rest
  assert.deepEqual(listed(prompt), ['B19', 'B18', 'B20', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11', 'B12']);
  assert.equal(backlogLines(prompt).at(-1), '- … 6 more open item(s) not shown');
});

test('F86 AC-5 a new (untracked) file counts as changed, matched by its path in file and summary', async () => {
  const items = [...plain(1, 20), { id: 'B21', summary: 'gizmo.mjs leaks a handle' }, { id: 'B22', summary: 'x', file: 'lib/gizmo.mjs' }];
  const { prompts } = await evalPrompts({ items, changed: { 'lib/gizmo.mjs': 'export const gizmo = 1;\n' } });
  assert.deepEqual(listed(prompts.evaluator[0]).slice(0, 3), ['B21', 'B22', 'B1']);
});

const promptFor = (items, files = []) => buildPrompt({
  rolePrompt: '# Evaluator', featureId: 'F9', contract: contract(), base: 'main', vr: PASS_VERIFY, threshold: 7, critical: false,
  diff: { text: '', mergeBase: '0'.repeat(40), files, excluded: 0, truncated: false }, backlog: items,
});

test('F86 AC-5 at most 15 items: 16 or more leave a "… N more" line, 15 or fewer do not', () => {
  for (const [n, more] of [[16, 1], [40, 25], [15, 0], [3, 0]]) {
    const prompt = promptFor(plain(1, n));
    assert.deepEqual(listed(prompt), plain(1, Math.min(n, 15)).map((i) => i.id), `n=${n}`);
    const last = backlogLines(prompt).at(-1);
    if (more) assert.equal(last, `- … ${more} more open item(s) not shown`, `n=${n}`);
    else assert.ok(!last.includes('more open item'), `n=${n}: ${last}`);
  }
});

test('F86 AC-5 a summary is collapsed to single spaces, then cut to 160 characters with "…"', () => {
  const long = Array.from({ length: 60 }, (_, k) => `w${k}`).join('  \n\t ');
  const collapsed = long.replace(/\s+/g, ' ');
  assert.ok(collapsed.length > 160 && long.length > collapsed.length);
  const exact = 'e'.repeat(160);
  const spaced = `${'s'.repeat(150)}${' '.repeat(30)}end`; // 184 raw, 154 after collapsing
  const lines = backlogLines(promptFor([
    { id: 'B1', summary: long }, { id: 'B2', summary: exact }, { id: 'B3', summary: `${exact}x` }, { id: 'B4', summary: spaced },
  ]));
  assert.equal(lines[0], `- B1 [-] ${collapsed.slice(0, 160)}…`);
  assert.equal(lines[1], `- B2 [-] ${exact}`);
  assert.equal(lines[2], `- B3 [-] ${exact}…`);
  assert.equal(lines[3], `- B4 [-] ${'s'.repeat(150)} end`);
});

// ------------------------------------------------------------------ ES-1

test('F86 ES-1 a missing or non-string summary shows as an empty summary, without an exception', async () => {
  const items = [
    { id: 'B1' }, { id: 'B2', summary: null }, { id: 'B3', summary: 42 }, { id: 'B4', summary: { a: 1 } },
    { id: 'B5', summary: ['lib/widget.mjs'], file: 7 }, { id: 'B6', summary: 'ok' },
  ];
  const { result, prompts } = await evalPrompts({ items, changed: { 'lib/widget.mjs': 'export const widget = 2;\n' } });
  assert.equal(result.verdict, 'pass', JSON.stringify(result));
  assert.deepEqual(backlogLines(prompts.evaluator[0]), ['- B1 [-] ', '- B2 [-] ', '- B3 [-] ', '- B4 [-] ', '- B5 [-] ', '- B6 [-] ok']);
});

// ------------------------------------------------------------------ ES-2

const ORDERED = [
  { id: 'B1', summary: 'one' }, { id: 'B2', summary: 'two', priority: 'low' }, { id: 'B3', summary: 'three', priority: 'high' },
  ...plain(4, 20),
];
const PRE_FEATURE = ['B3', 'B2', 'B1', ...plain(4, 15).map((i) => i.id)];
// ORDERED as the evaluation hands it to the prompt: the open items in backlog order.
const OPEN = () => openItems({ items: structuredClone(ORDERED) });

test('F86 ES-2 no changed files: the pre-feature order, 15 items and the "… more" line', async () => {
  const { prompts } = await evalPrompts({ items: ORDERED });
  assert.deepEqual(listed(prompts.evaluator[0]), PRE_FEATURE);
  assert.equal(backlogLines(prompts.evaluator[0]).at(-1), '- … 5 more open item(s) not shown');
  // a diff without a file list (no changed files) is the same
  const bare = buildPrompt({ rolePrompt: '# E', featureId: 'F9', contract: contract(), base: 'main', vr: PASS_VERIFY, threshold: 7,
    diff: { text: '', mergeBase: '0'.repeat(40) }, backlog: OPEN() });
  assert.deepEqual(listed(bare), PRE_FEATURE);
});

test('F86 ES-2 changed files no item is about: the pre-feature order', async () => {
  const { prompts } = await evalPrompts({ items: ORDERED, changed: { 'lib/widget.mjs': 'export const widget = 2;\n' } });
  assert.deepEqual(listed(prompts.evaluator[0]), PRE_FEATURE);
  assert.deepEqual(listed(promptFor(OPEN(), ['docs/unrelated.md'])), PRE_FEATURE);
});

// ------------------------------------------------------------------ AC-6

const specSection = (n) => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const at = spec.indexOf(`\n## ${n}. `);
  const next = spec.indexOf('\n## ', at + 1);
  return spec.slice(at, next === -1 ? undefined : next);
};

test('F86 AC-6 SPEC §10 describes the extra claude flags and the tools each role goes without', () => {
  const s10 = specSection(10);
  for (const w of ['--strict-mcp-config', '--disable-slash-commands', '`Workflow`', '`Skill`', '`ReportFindings`', '`ListAgents`', '`Agent`',
    '`ScheduleWakeup`', '`Monitor`', '`ToolSearch`', '`StructuredOutput`', '--help lacks --strict-mcp-config']) {
    assert.ok(s10.includes(w), `SPEC §10 lacks ${w}`);
  }
});

test('F86 AC-6 SPEC §7 describes the StructuredOutput instruction and the backlog section rules', () => {
  const s7 = specSection(7);
  for (const w of ['`StructuredOutput`', 'nothing else', '최대 15개', '160자', '`…`', '파일 이름', '`- … N more open item(s) not shown`']) {
    assert.ok(s7.includes(w), `SPEC §7 lacks ${w}`);
  }
  assert.ok(!s7.includes('최대 40개'), 'SPEC §7 still says 40');
});
