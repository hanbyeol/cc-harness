import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { builderPrompt } from '../lib/run/prompt.mjs';
import { buildPrompt } from '../lib/eval.mjs';
import claude from '../lib/adapters/claude.mjs';

const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');
const HARNESS = ['Bash(harness:*)', 'Bash(cc-harness:*)', 'Bash(npx cc-harness:*)', 'Bash(npx github:hanbyeol/cc-harness:*)', 'Bash(node bin/harness.mjs:*)'];
const OLD = ['Bash(git push:*)', 'Bash(git reset --hard:*)', 'Bash(rm -rf /:*)', 'Bash(rm -rf ~:*)', 'Bash(sudo:*)'];
const contract = { id: 'F1', title: 't', acceptance_criteria: [] };
const base = { rolePrompt: 'role', featureId: 'F1', round: 1, attempt: 1, contract };
const cfg = (commands) => ({ verify: { commands } });
const denied = (args) => {
  const rest = args.slice(args.indexOf('--disallowedTools') + 1);
  const end = rest.findIndex((a) => a.startsWith('--'));
  return end < 0 ? rest : rest.slice(0, end);
};
const section = (p) => p.slice(p.indexOf('## Headless session'));

test('F138 AC-1: every builder prompt has the headless section', () => {
  const variants = [{}, { conflicts: ['a.js'] }, { postMergeFailures: [{ x: 1 }] }];
  for (const v of variants) {
    const p = builderPrompt({ ...base, ...v, config: cfg(['npm test']) });
    assert.ok(p.includes('## Headless session'));
    const sec = section(p);
    assert.match(sec, /Do not run harness commands/);
    assert.match(sec, /CLAUDE\.md/);
    assert.match(sec, /AGENTS\.md/);
    assert.match(sec, /harness verify/);
    assert.match(sec, /harness eval/);
  }
});

test('F138 AC-2: claude builder call denies the harness spellings; SPEC lists them', () => {
  const d = denied(claude.buildArgs({ readOnly: false }));
  for (const t of HARNESS) assert.ok(d.includes(t), t);
  const spec = read('docs', 'SPEC.md');
  const line = spec.split('\n').find((l) => l.startsWith('- `<deny>`'));
  for (const t of [...OLD, ...HARNESS]) assert.ok(line.includes(`\`${t}\``), t);
});

test('F138 AC-3: builder.md Finish leaves verify to the core under harness run', () => {
  const doc = read('agents', 'builder.md');
  const fin = doc.slice(doc.indexOf('## Finish'));
  assert.match(fin, /harness run/);
  assert.match(fin, /outside `harness run`/);
  assert.ok(!/the verify command results, and/.test(fin));
});

test('F138 AC-4: builder.md has no project-specific test guidance; CLAUDE.md has it', () => {
  const doc = read('agents', 'builder.md');
  for (const w of ['realTmpdir', 'test/helpers.mjs', 'F134', 'realpathSync', 'CI also runs Windows, macOS and Linux']) {
    assert.ok(!doc.includes(w), w);
  }
  const claudeMd = read('CLAUDE.md');
  const tail = claudeMd.slice(claudeMd.indexOf('This block is managed by'));
  assert.match(tail, /realTmpdir/);
  assert.match(tail, /realpathSync\.native/);
  assert.match(tail, /F134 AC-2/);
});

test('F138 AC-5: evaluator and security-reviewer do not re-run the checks', () => {
  for (const f of ['evaluator.md', 'security-reviewer.md']) {
    const doc = read('agents', f);
    assert.match(doc, /## Deterministic verification/, f);
    assert.match(doc, /do not run/i, f);
    assert.match(doc, /core runs a finding's `repro` itself/, f);
    assert.ok(!doc.includes('run its `check`'), f);
    assert.ok(!doc.includes('Run or read each criterion'), f);
  }
  const p = buildPrompt({ rolePrompt: 'r', featureId: 'F1', contract, diff: { text: '', mergeBase: 'abcdefabcdefabcdef' }, base: 'main', vr: { ok: true }, threshold: 8 });
  assert.match(p, /do not run them again/);
  assert.match(p, /core runs a finding's repro itself/);
});

test('F138 AC-6: security-reviewer evaluates separately from the evaluator', () => {
  const doc = read('agents', 'security-reviewer.md');
  assert.ok(!doc.includes('has already judged'));
  assert.match(doc, /evaluates it separately at the same time/);
  assert.match(doc, /do not see its verdict/);
});

test('F138 SC-1: claude write args keep the old deny list and excluded tools', () => {
  const args = claude.buildArgs({ readOnly: false });
  assert.equal(args.filter((a) => a === '--permission-mode').length, 1);
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'auto');
  assert.equal(args.filter((a) => a === '--disallowedTools').length, 1);
  const d = denied(args);
  for (const t of [...OLD, 'Workflow', 'Skill', 'ReportFindings', 'ListAgents', 'Agent']) assert.ok(d.includes(t), t);
});

test('F138 SC-2: read-only args and required flags are unchanged', () => {
  const args = claude.buildArgs({ readOnly: true });
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  assert.deepEqual(denied(args), ['Workflow', 'ScheduleWakeup', 'Skill', 'ReportFindings', 'ListAgents', 'Agent',
    'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'PushNotification', 'SendMessage', 'DesignSync', 'EnterWorktree', 'ExitWorktree']);
  const req = ['-p', '--strict-mcp-config', '--disable-slash-commands', '--disallowedTools', '--output-format=json'];
  assert.deepEqual(claude.requiredFlags({ readOnly: true }), [...req.slice(0, 3), '--permission-mode=plan', ...req.slice(3)]);
  assert.deepEqual(claude.requiredFlags({ readOnly: false }), [...req.slice(0, 3), '--permission-mode=auto', ...req.slice(3)]);
});

test('F138 ES-1: empty verify.commands still gives the headless section', () => {
  const p = builderPrompt({ ...base, config: cfg([]) });
  assert.match(section(p), /Do not run harness commands/);
  assert.ok(!p.includes('Do not run these commands'));
});
