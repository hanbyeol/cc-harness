// F78: the criterion check runner (test/t.mjs) passes node --test only the test files whose
// source contains the id, and falls back to every test file when none does. The verdict is
// unchanged: it is decided from the TAP names that start with the id.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpdir, readJson } from './helpers.mjs';
import { selectTestFiles as selectFiles } from './t.mjs';

const T_MJS = path.join(REPO, 'test', 't.mjs');

// A project with test/t.mjs and the given test files (name → source) under test/.
function sandbox(files) {
  const dir = tmpdir('harness-f78-');
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.copyFileSync(T_MJS, path.join(dir, 'test', 't.mjs'));
  for (const [name, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, 'test', name)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test', name), src);
  }
  return dir;
}

// Source of a test file that writes <name>.ran at the project root when it is loaded.
function marked(name, body) {
  return [
    "import test from 'node:test';",
    "import fs from 'node:fs';",
    `fs.writeFileSync(new URL('../${name}.ran', import.meta.url), '');`,
    body,
    '',
  ].join('\n');
}

function runT(dir, args) {
  const r = spawnSync(process.execPath, [path.join(dir, 'test', 't.mjs'), ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const ran = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.ran')).sort();

// ---------- AC-1 ----------
test('F78 AC-1 only the test file whose source contains the id is run', () => {
  const dir = sandbox({
    'a.test.mjs': marked('a', "test('Q1 AC-1 works', () => {});"),
    'b.test.mjs': marked('b', "test('Q2 AC-1 other', () => {});"),
    'sub/c.test.mjs': marked('c', "test('Q3 AC-1 other', () => {});"),
  });
  const r = runT(dir, ['Q1 AC-1']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /t\.mjs: "Q1 AC-1" — 1 passed/);
  assert.deepEqual(ran(dir), ['a.ran']);
});

test('F78 AC-1 selectFiles returns the files containing the id, nested ones included', () => {
  const dir = sandbox({
    'a.test.mjs': "// Q1 AC-1\n",
    'b.test.mjs': "// Q2 AC-1\n",
    'sub/c.test.mjs': "test('Q1 AC-1 nested')\n",
    'sub/helper.mjs': "// Q1 AC-1 but not a test file\n",
  });
  assert.deepEqual(selectFiles(dir, 'Q1 AC-1'), ['test/a.test.mjs', 'test/sub/c.test.mjs']);
  assert.deepEqual(selectFiles(dir, 'Q9 AC-1'), []);
});

// ---------- AC-2 ----------
test('F78 AC-2 no file contains the id: every test file runs and a templated name is still judged', () => {
  const tmpl = "const id = ['Q5', 'AC-2'].join(' ');\n";
  const pass = sandbox({
    'a.test.mjs': marked('a', tmpl + "test(`${id} templated`, () => {});"),
    'b.test.mjs': marked('b', "test('Q6 AC-1 other', () => {});"),
  });
  const ok = runT(pass, ['Q5 AC-2']);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /t\.mjs: "Q5 AC-2" — 1 passed/);
  assert.deepEqual(ran(pass), ['a.ran', 'b.ran']);

  const fail = sandbox({
    'a.test.mjs': marked('a', tmpl + "test(`${id} templated`, () => { throw new Error('boom'); });"),
    'b.test.mjs': marked('b', "test('Q6 AC-1 other', () => {});"),
  });
  const bad = runT(fail, ['Q5 AC-2']);
  assert.equal(bad.code, 1, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /t\.mjs: "Q5 AC-2" — 1\/1 failed/);
  assert.deepEqual(ran(fail), ['a.ran', 'b.ran']);
});

// ---------- AC-3 ----------
test('F78 AC-3 all matching tests pass: exit 0 and "<n> passed"', () => {
  const dir = sandbox({
    'a.test.mjs': "import test from 'node:test';\ntest('Q1 AC-3 one', () => {});\ntest('Q1 AC-3 two', () => {});\n",
  });
  const r = runT(dir, ['Q1 AC-3']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /t\.mjs: "Q1 AC-3" — 2 passed/);
});

test('F78 AC-3 one matching test fails: exit 1 and "<k>/<n> failed"', () => {
  const dir = sandbox({
    'a.test.mjs': "import test from 'node:test';\ntest('Q1 AC-3 one', () => {});\ntest('Q1 AC-3 two', () => { throw new Error('boom'); });\n",
  });
  const r = runT(dir, ['Q1 AC-3']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /t\.mjs: "Q1 AC-3" — 1\/2 failed/);
});

test('F78 AC-3 no matching test: exit 1 and "no test matched"', () => {
  const dir = sandbox({
    'a.test.mjs': "import test from 'node:test';\ntest('Q1 AC-1 other', () => {});\n",
  });
  const r = runT(dir, ['Q1 AC-3']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /no test matched "Q1 AC-3"/);
});

test('F78 AC-3 the id only in a comment: the file runs, still exit 1 and "no test matched"', () => {
  const dir = sandbox({
    'a.test.mjs': marked('a', "// Q1 AC-3 is checked elsewhere\ntest('Q1 AC-1 other', () => {});"),
    'b.test.mjs': marked('b', "test('Q2 AC-1 other', () => {});"),
  });
  const r = runT(dir, ['Q1 AC-3']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /no test matched "Q1 AC-3"/);
  assert.deepEqual(ran(dir), ['a.ran']);
});

// ---------- AC-4 ----------
test('F78 AC-4 a failing test of a longer id (AC-10) does not count for its prefix (AC-1)', () => {
  const dir = sandbox({
    'a.test.mjs': marked('a', "test('Q3 AC-1 passes', () => {});"),
    'b.test.mjs': marked('b', "test('Q3 AC-10 fails', () => { throw new Error('boom'); });"),
  });
  const r = runT(dir, ['Q3 AC-1']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /t\.mjs: "Q3 AC-1" — 1 passed/);
  assert.deepEqual(ran(dir), ['a.ran', 'b.ran'], 'both files contain "Q3 AC-1" and both run');

  const other = runT(dir, ['Q3 AC-10']);
  assert.equal(other.code, 1, other.stdout + other.stderr);
  assert.match(other.stderr, /t\.mjs: "Q3 AC-10" — 1\/1 failed/);
});

// ---------- AC-5 ----------
test('F78 AC-5 every t.mjs check of the F70–F77 contracts still exits 0', { timeout: 30 * 60 * 1000 }, () => {
  const ids = [];
  for (let n = 70; n <= 77; n++) {
    const c = readJson(path.join(REPO, '.harness', 'contracts', `F${n}.json`));
    for (const key of ['acceptance_criteria', 'security_criteria', 'error_scenarios']) {
      for (const cr of c[key] || []) {
        const m = /^node test\/t\.mjs "([^"]+)"$/.exec(cr.check);
        if (m) ids.push(m[1]);
      }
    }
  }
  assert.ok(ids.length >= 60, `found ${ids.length} t.mjs checks`);
  const failed = [];
  for (const id of ids) {
    const r = spawnSync(process.execPath, [T_MJS, id], {
      cwd: REPO, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
    if (r.status !== 0) failed.push(`${id}: exit ${r.status}\n${(r.stderr || '').slice(-2000)}`);
  }
  assert.deepEqual(failed, []);
});

// ---------- AC-6 ----------
test('F78 AC-6 CLAUDE.md says t.mjs runs only the files containing the id, else all of them', () => {
  const doc = fs.readFileSync(path.join(REPO, 'CLAUDE.md'), 'utf8');
  const start = doc.indexOf('## Running the core from this checkout');
  assert.ok(start >= 0, 'development commands section exists');
  const end = doc.indexOf('\n## ', start);
  const section = doc.slice(start, end === -1 ? undefined : end);
  const at = section.indexOf('node test/t.mjs');
  assert.ok(at >= 0, 't.mjs is described');
  const item = section.slice(at, section.indexOf('\n- ', at));
  assert.match(item, /only the test files whose source contains the id/, 'scoped to files with the id');
  assert.match(item, /no file contains (it|the id)[^.]*runs (every|all) test files?/, 'falls back to all files');
});

// ---------- ES-1 ----------
test('F78 ES-1 a test file that cannot be read is included, not an error', () => {
  const dir = sandbox({
    'a.test.mjs': "// Q1 ES-1\n",
    'b.test.mjs': "// nothing\n",
    'c.test.mjs': "// unreadable\n",
  });
  const read = (file, enc) => {
    if (file.endsWith('c.test.mjs')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return fs.readFileSync(file, enc);
  };
  assert.deepEqual(selectFiles(dir, 'Q1 ES-1', read), ['test/a.test.mjs', 'test/c.test.mjs']);
});

test('F78 ES-1 a real unreadable file (where permissions apply) is passed to node --test', () => {
  const dir = sandbox({
    'a.test.mjs': marked('a', "test('Q1 ES-1 works', () => {});"),
    'c.test.mjs': marked('c', "test('Q2 ES-1 other', () => {});"),
  });
  const c = path.join(dir, 'test', 'c.test.mjs');
  fs.chmodSync(c, 0);
  let readable = true;
  try { fs.readFileSync(c); } catch { readable = false; }
  const r = runT(dir, ['Q1 ES-1']);
  fs.chmodSync(c, 0o644);
  assert.ok(!/at .*t\.mjs:\d+/.test(r.stderr), `t.mjs itself did not throw:\n${r.stderr}`);
  assert.match(r.stdout + r.stderr, /t\.mjs: "Q1 ES-1"/, 't.mjs reached a verdict');
  if (readable) {
    // Windows, or running as root: the file is read, has no id, and is left out.
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(ran(dir), ['a.ran']);
  } else {
    // node --test cannot load it either: it is reported, so the run fails rather than skipping it.
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /c\.test\.mjs/);
  }
});

// ---------- ES-2 ----------
test('F78 ES-2 no argument prints usage and exits 2', () => {
  const dir = sandbox({});
  const r = runT(dir, []);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: node test\/t\.mjs/);
});
