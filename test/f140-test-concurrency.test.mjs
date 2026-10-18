import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, realTmpdir } from './helpers.mjs';
import { parseNodeTest, partialRetry } from '../lib/retryfiles.mjs';

const CMD = 'node --test --test-concurrency=6 "test/**/*.test.mjs"';
const scriptTest = () => JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts.test;

test('F140 AC-1: scripts.test sets the file concurrency to 6 before the glob and parseNodeTest reads it', () => {
  assert.equal(scriptTest(), CMD);
  assert.deepEqual(parseNodeTest(scriptTest()).options, ['--test-concurrency=6']);
});

test('F140 AC-2: scripts.test runs 6 test files at the same time', () => {
  const dir = realTmpdir('harness-f140-');
  fs.mkdirSync(path.join(dir, 'test'));
  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(path.join(dir, 'test', `p${i}.test.mjs`), [
      "import test from 'node:test';",
      "import fs from 'node:fs';",
      `test('p${i} waits for all six', async () => {`,
      `  fs.writeFileSync('started-${i}', '');`,
      '  const end = Date.now() + 60000;',
      '  const all = () => [0, 1, 2, 3, 4, 5].every((n) => fs.existsSync(`started-${n}`));',
      '  while (!all() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));',
      '  if (!all()) throw new Error("not all six files started");',
      '});',
      '',
    ].join('\n'));
  }
  const r = spawnSync(scriptTest(), { cwd: dir, shell: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});

test('F140 AC-3: CLAUDE.md documents the concurrency flag', () => {
  const md = fs.readFileSync(path.join(REPO, 'CLAUDE.md'), 'utf8');
  const line = md.split('\n').findIndex((l) => l.startsWith('- Tests:'));
  assert.ok(line >= 0);
  const block = md.split('\n').slice(line, line + 8).join('\n');
  assert.ok(block.includes(CMD), 'shows the command');
  assert.match(block, /4 CPU/);
  assert.match(block, /stress 2/);
  assert.match(block, /after the glob[^.]*ignored|ignored[^.]*after the glob/);
  assert.match(block, /\.harness\/config\.json/);
  assert.match(block, /verify/);
});

test('F140 ES-1: the retry of the package.json command keeps the concurrency flag', () => {
  const cwd = realTmpdir('harness-f140-');
  fs.mkdirSync(path.join(cwd, 'test'));
  fs.writeFileSync(path.join(cwd, 'test', 'b.test.mjs'), '');
  const out = ['✖ x (1ms)', 'ℹ tests 3', 'ℹ fail 1', '', '✖ failing tests:', '', 'test at test/b.test.mjs:3:1', '✖ b fails (1.2ms)', '  Error: boom', ''].join('\n');
  const p = partialRetry(scriptTest(), out, cwd, { platform: 'linux' });
  assert.equal(p.cmd, 'node --test --test-concurrency=6 test/b.test.mjs');
  assert.deepEqual(p.files, [path.join('test', 'b.test.mjs')]);
});
