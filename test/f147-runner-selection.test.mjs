import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir, REPO } from './helpers.mjs';
import { selectTestFiles } from './t.mjs';

const RUNNER = path.join(REPO, 'test', 't.mjs');

const pass = (id) => `const t = require('node:test');\nt('${id} ok', () => {});\n`;
const passM = (id) => `import t from 'node:test';\nt('${id} ok', () => {});\n`;
const failM = (id) => `import t from 'node:test';\nt('${id} bad', () => { throw new Error('x'); });\n`;
const markFile = (name) => `require('node:fs').writeFileSync(require('node:path').join(__dirname, '${name}'), 'x');\n`;

function project(files, withRunner = true) {
  const d = realTmpdir('harness-f147-');
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  if (withRunner) files = { 'test/t.mjs': fs.readFileSync(RUNNER, 'utf8'), ...files };
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), c);
  }
  return d;
}
const run = (d, ...args) => spawnSync(process.execPath, ['test/t.mjs', ...args], { cwd: d, encoding: 'utf8' });

test('F147 AC-1 test files of every node --test extension and spec name run', () => {
  const d = project({
    'test/a.test.js': pass('Q1 AC-1'),
    'test/b.test.cjs': pass('Q2 AC-1'),
    'test/c.spec.mjs': passM('Q3 AC-1'),
    'test/d.test.js': `const t = require('node:test');\nt('Q4 AC-1 bad', () => { throw new Error('x'); });\n`,
  });
  for (const id of ['Q1 AC-1', 'Q2 AC-1', 'Q3 AC-1']) {
    const r = run(d, id);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /— 1 passed/);
  }
  const r = run(d, 'Q4 AC-1');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /1\/1 failed/);
});

test('F147 AC-2 node --test default name shapes and files outside test/ are selected', () => {
  const files = { 'test/e-test.js': 'Q6 AC-1', 'test/f_test.mjs': 'Q7 AC-1', 'test/test-g.cjs': 'Q8 AC-1', 'src/h.test.js': 'Q9 AC-1' };
  const d = project(Object.fromEntries(Object.entries(files).map(([f, id]) =>
    [f, f.endsWith('.mjs') ? passM(id) : pass(id)])));
  for (const [f, id] of Object.entries(files)) {
    const r = run(d, id);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(selectTestFiles(d, id), [f]);
  }
});

test('F147 AC-3 node_modules, dot directories and helper files are not selected', () => {
  const src = (name) => `require('node:test')('Q1 AC-1 ok', () => {});\n${markFile(name)}`;
  const d = project({
    'test/a.test.js': src('a.mark'),
    'node_modules/x/a.test.js': src('nm.mark'),
    '.harness/wt/F1/test/a.test.js': src('wt.mark'),
    'test/helper.mjs': "// Q1 AC-1\n",
    'test/fixtures/fake.mjs': "// Q1 AC-1\n",
  });
  const r = run(d, 'Q1 AC-1');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(d, 'test', 'a.mark')));
  assert.ok(!fs.existsSync(path.join(d, 'node_modules', 'x', 'nm.mark')));
  assert.ok(!fs.existsSync(path.join(d, '.harness', 'wt', 'F1', 'test', 'wt.mark')));
  assert.deepEqual(selectTestFiles(d, 'Q1 AC-1'), ['test/a.test.js']);
});

test('F147 AC-4 without a file holding the id every test-shaped file runs', () => {
  for (const ok of [true, false]) {
    const body = (name) => `const t = require('node:test');\nconst n = 'AC-2';\nt(\`Q5 \${n}\`, () => { ${ok ? '' : "throw new Error('x');"} });\n${markFile(name)}`;
    const d = project({
      'test/a.test.cjs': body('a.mark'),
      'src/b.test.js': `require('node:test')('other', () => {});\n${markFile('b.mark')}`,
    });
    const r = run(d, 'Q5 AC-2');
    assert.equal(r.status, ok ? 0 : 1, r.stdout + r.stderr);
    assert.match(ok ? r.stdout : r.stderr, ok ? /— 1 passed/ : /1\/1 failed/);
    assert.ok(fs.existsSync(path.join(d, 'test', 'a.mark')));
    assert.ok(fs.existsSync(path.join(d, 'src', 'b.mark')));
  }
});

test('F147 AC-5 node --test without arguments passes with the runner in the project', () => {
  const d = project({ 'test/a.test.js': pass('Q1 AC-1') });
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: d, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^ok \d+ - .*t\.mjs/m);
  assert.doesNotMatch(r.stdout, /^not ok/m);
  const u = spawnSync(process.execPath, ['test/t.mjs'], { cwd: d, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  assert.equal(u.status, 2);
  assert.match(u.stderr, /usage/);
});

test('F147 AC-6 this repository selects test/**/*.test.mjs holding the id', () => {
  const all = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${rel}/${e.name}`);
      else if (e.name.endsWith('.test.mjs')) all.push(`${rel}/${e.name}`);
    }
  };
  walk('test');
  for (const id of ['F78 AC-1', 'F136 AC-2', 'F144 AC-1']) {
    const want = all.filter((f) => fs.readFileSync(path.join(REPO, f), 'utf8').includes(id)).sort();
    assert.ok(want.length > 0, id);
    assert.deepEqual(selectTestFiles(REPO, id), want);
  }
});

test('F147 AC-7 SPEC describes the runner file selection', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const para = spec.split('\n').find((l) => l.includes('러너의 파일 선택(F147)'));
  assert.ok(para);
  for (const s of ['*.test.', '*.spec.', '*-test.', '*_test.', 'test-*', 'test.*', '.js', '.mjs', '.cjs', '프로젝트 전체', 'node_modules', '점으로 시작하는 디렉터리', 'node --test', 'exit 0']) {
    assert.ok(para.includes(s), s);
  }
});

test('F147 ES-1 an id only in unselected files matches nothing', () => {
  const d = project({
    'node_modules/x/a.test.js': pass('Q1 AC-1'),
    'test/helper.mjs': "// Q1 AC-1\n",
    'test/b.test.js': pass('other'),
  });
  const r = run(d, 'Q1 AC-1');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no test matched/);
});

test('F147 ES-2 a project without test-shaped files reports no test matched', () => {
  const d = project({ 'test/helper.mjs': '// helper\n' });
  const r = run(d, 'Q1 AC-1');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no test matched/);
  assert.doesNotMatch(r.stderr, /Error|at /);
});
