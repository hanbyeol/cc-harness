import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, tmpdir, REPO } from './helpers.mjs';
import { compareCommandNames as compareCommands } from '../lib/util.mjs';

const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

const commandNames = () => {
  const r = harness(['--help'], { cwd: tmpdir() });
  const names = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^ {2}(\S+) +(.+)$/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
};

// The paragraph that starts with `marker`, up to the next blank line.
const paragraph = (text, marker) => {
  const start = text.indexOf(marker);
  if (start < 0) return '';
  const end = text.indexOf('\n\n', start);
  return text.slice(start, end < 0 ? undefined : end);
};

const report = ({ missing, notCommands }) =>
  `빠짐: ${missing.join(', ') || '-'}; 명령 아님: ${notCommands.join(', ') || '-'}`;

const checkDoc = (file, marker) => {
  const par = paragraph(read(file), marker);
  assert.ok(par, `${file}: no paragraph starting with ${marker}`);
  const r = compareCommands(par, commandNames());
  assert.deepEqual(r, { missing: [], notCommands: [] }, report(r));
};

test('F137 AC-1 AGENTS.md command list equals COMMANDS', () => {
  checkDoc('AGENTS.md', 'The commands are:');
});

test('F137 AC-2 README.md command list equals COMMANDS', () => {
  checkDoc('README.md', '코어 명령:');
});

test('F137 AC-3 comparison reports missing names and non-commands', () => {
  const cmds = ['init', 'run', 'status'];
  const ok = '`harness init`, `harness run`, `harness status`. `harness <command> --help`';
  assert.deepEqual(compareCommands(ok, cmds), { missing: [], notCommands: [] });
  assert.deepEqual(compareCommands('`harness init`, `harness run`', cmds), { missing: ['status'], notCommands: [] });
  assert.deepEqual(compareCommands(`${ok} \`harness deploy\``, cmds), { missing: [], notCommands: ['deploy'] });
  assert.deepEqual(compareCommands('`harness init` `harness run` `harness status` `harness init --help`', cmds), { missing: [], notCommands: [] });
});

test('F137 AC-4 status and build skills name decide and backlog close', () => {
  for (const f of ['skills/status/SKILL.md', 'skills/build/SKILL.md']) {
    const t = read(f);
    assert.match(t, /`harness decide F/, f);
    for (const o of ['--split', '--rewrite', '--accept-risk']) assert.ok(t.includes(o), `${f} ${o}`);
    assert.match(t, /decide[^.]*records only[^.]*status|records only[^.]*does not change[^.]*status/i, f);
  }
  assert.match(read('skills/status/SKILL.md'), /`harness backlog close/);
});

test('F137 AC-5 README CI matrix points to ci.yml with the matrix values', () => {
  const line = read('README.md').split('\n').find((l) => l.includes('CI 매트릭스'));
  assert.ok(line, 'no CI matrix line');
  assert.ok(line.includes('.github/workflows/ci.yml'), line);
  assert.ok(!/`CLAUDE\.md`/.test(line), line);
  const ci = read('.github/workflows/ci.yml');
  const os = /os: \[([^\]]+)\]/.exec(ci)[1].split(',').map((s) => s.trim().replace(/-latest$/, ''));
  const node = /node: \[([^\]]+)\]/.exec(ci)[1].split(',').map((s) => s.trim());
  for (const v of [...os, ...node]) assert.ok(line.includes(v), `${v} missing in: ${line}`);
});

test('F137 AC-6 SPEC autonomous row says report and gh pr create suggestion', () => {
  const row = read('docs/SPEC.md').split('\n').find((l) => l.startsWith('| 자율 |'));
  assert.ok(row, 'no 자율 row');
  assert.ok(!row.includes('보고서 + PR'), row);
  assert.ok(row.includes('runs/{ts}.md'), row);
  assert.ok(row.includes('gh pr create'), row);
  assert.match(row, /PR.*(만들|push).*않/, row);
});
