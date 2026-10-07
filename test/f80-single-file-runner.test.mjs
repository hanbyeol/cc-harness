// F80: test/t.mjs is a single file again — it imports only node: built-ins, so copying it alone
// into a project is enough. Its file selection (F78) lives in t.mjs and is exported for tests;
// importing t.mjs does not run the command.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPO, tmpdir } from './helpers.mjs';

const T_MJS = path.join(REPO, 'test', 't.mjs');
// Spelled in parts so this file does not itself contain the name AC-3 looks for.
const OLD_NAME = ['criterion', 'files'].join('-');

// ---------- AC-1 ----------
test('F80 AC-1 every import of test/t.mjs is a node: built-in', () => {
  const src = fs.readFileSync(T_MJS, 'utf8');
  const specs = [
    ...src.matchAll(/^\s*import\s[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm),
    ...src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
    ...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1]);
  assert.ok(specs.length > 0, 't.mjs has imports');
  assert.deepEqual(specs.filter((s) => !s.startsWith('node:')), []);
});

// ---------- AC-2 ----------
test('F80 AC-2 t.mjs copied alone (no lib/) runs and loads only the file containing the id', () => {
  const dir = tmpdir('harness-f80-');
  fs.mkdirSync(path.join(dir, 'test', 'sub'), { recursive: true });
  fs.copyFileSync(T_MJS, path.join(dir, 'test', 't.mjs'));
  const marked = (name, body) => [
    "import test from 'node:test';",
    "import fs from 'node:fs';",
    `fs.writeFileSync(new URL('../${name === 'c' ? '../' : ''}${name}.ran', import.meta.url), '');`,
    body,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'test', 'a.test.mjs'), marked('a', "test('X AC-1 works', () => {});"));
  fs.writeFileSync(path.join(dir, 'test', 'b.test.mjs'), marked('b', "test('X AC-2 other', () => {});"));
  fs.writeFileSync(path.join(dir, 'test', 'sub', 'c.test.mjs'), marked('c', "test('Y AC-1 other', () => {});"));
  assert.ok(!fs.existsSync(path.join(dir, 'lib')));
  const r = spawnSync(process.execPath, ['test/t.mjs', 'X AC-1'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /t\.mjs: "X AC-1" — 1 passed/);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.ran')).sort(), ['a.ran']);
});

// ---------- AC-3 ----------
test('F80 AC-3 the separate selection module is gone and no tracked file names it', () => {
  assert.ok(!fs.existsSync(path.join(REPO, 'lib', `${OLD_NAME}.mjs`)));
  const ls = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(ls.status, 0, ls.stderr);
  const files = ls.stdout.split('\0').filter((f) => f && !f.startsWith('.harness/'));
  assert.ok(files.length > 50, `listed ${files.length} tracked files`);
  const hits = [];
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(path.join(REPO, f), 'utf8'); } catch { continue; } // deleted in the worktree
    if (src.includes(OLD_NAME)) hits.push(f);
  }
  assert.deepEqual(hits, []);
});

// ---------- ES-1 ----------
test('F80 ES-1 importing t.mjs exposes selectTestFiles without running the command', () => {
  const dir = tmpdir('harness-f80-');
  fs.writeFileSync(path.join(dir, 'a.test.mjs'), '');
  const importer = path.join(dir, 'importer.mjs');
  fs.writeFileSync(importer, [
    `const m = await import(${JSON.stringify(pathToFileURL(T_MJS).href)});`,
    "console.log('alive', typeof m.selectTestFiles);",
    '',
  ].join('\n'));
  for (const args of [[], ['X AC-1']]) {
    const r = spawnSync(process.execPath, [importer, ...args], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), 'alive function', r.stdout + r.stderr);
    assert.doesNotMatch(r.stderr, /usage/);
  }
});
