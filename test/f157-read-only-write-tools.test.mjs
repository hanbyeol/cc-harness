// F157: read-only claude role sessions and the plugin evaluator agents disallow the file
// writing tools Edit, Write and NotebookEdit; the builder session is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import claude, { DENY } from '../lib/adapters/claude.mjs';

const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const OLD_READ_ONLY_OFF = ['Workflow', 'ScheduleWakeup', 'Skill', 'ReportFindings', 'ListAgents', 'Agent', 'CronCreate', 'CronDelete', 'CronList',
  'RemoteTrigger', 'PushNotification', 'SendMessage', 'DesignSync', 'EnterWorktree', 'ExitWorktree'];
const FAKE = path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs');

// The values after --disallowedTools, up to the next option.
function disallowed(argv) {
  const i = argv.indexOf('--disallowedTools');
  assert.ok(i >= 0, '--disallowedTools missing');
  const rest = argv.slice(i + 1);
  const end = rest.findIndex((a) => a.startsWith('--'));
  return end < 0 ? rest : rest.slice(0, end);
}

// The YAML frontmatter of an agent file as raw lines.
function frontmatter(file) {
  const text = fs.readFileSync(path.join(REPO, 'agents', file), 'utf8').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, `${file}: no frontmatter`);
  return m[1].split('\n');
}

test('F157 AC-1: the read-only session disallows Edit, Write and NotebookEdit and keeps the old list', () => {
  const off = disallowed(claude.buildArgs({ readOnly: true }));
  for (const t of WRITE_TOOLS) assert.ok(off.includes(t), t);
  for (const t of OLD_READ_ONLY_OFF) assert.ok(off.includes(t), t);
});

test('F157 AC-2: evaluator and security-reviewer frontmatter disallow the write tools; builder does not', () => {
  for (const file of ['evaluator.md', 'security-reviewer.md']) {
    const line = frontmatter(file).find((l) => l.startsWith('disallowedTools:'));
    assert.ok(line, `${file}: disallowedTools missing`);
    const tools = line.slice('disallowedTools:'.length).split(',').map((s) => s.trim());
    for (const t of WRITE_TOOLS) assert.ok(tools.includes(t), `${file}: ${t}`);
  }
  assert.ok(!frontmatter('builder.md').some((l) => l.startsWith('disallowedTools:')), 'builder.md has no disallowedTools');
});

test('F157 AC-3: docs/SPEC.md names the write tools in the read-only tool list', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const para = spec.split('\n').find((l) => l.includes('`<읽기 전용 제외 도구>`(evaluator·security-reviewer)'));
  assert.ok(para, 'the <읽기 전용 제외 도구> paragraph');
  const at = para.indexOf('`<읽기 전용 제외 도구>`(evaluator·security-reviewer)');
  const part = para.slice(at, at + 400);
  for (const t of WRITE_TOOLS) assert.ok(part.includes(`\`${t}\``), t);
});

test('F157 SC-1: the builder session is unchanged', () => {
  const b = claude.buildArgs({ readOnly: false });
  assert.equal(b[b.indexOf('--permission-mode') + 1], 'auto');
  const off = disallowed(b);
  assert.deepEqual(off.slice(0, DENY.length), [...DENY]);
  for (const t of WRITE_TOOLS) assert.ok(!off.includes(t), t);
});

test('F157 SC-2: an evaluator call passes plan mode and the write tools to the CLI', async () => {
  const r = await claude.run({ role: 'evaluator', prompt: 'p', cwd: REPO, readOnly: true, timeoutSec: 60,
    bin: process.execPath, binArgs: [FAKE, 'echo-args-wrapper'] });
  assert.equal(r.ok, true, `${r.error} ${r.detail}`);
  const argv = r.json.argv;
  assert.deepEqual(argv, claude.buildArgs({ readOnly: true }));
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'plan');
  for (const t of WRITE_TOOLS) assert.ok(disallowed(argv).includes(t), t);
});
