// F50: command not found for chained commands ('&&', '||', ';', '|'), a fresh empty
// core.hooksPath directory per verify/eval git call, and the working tree's node_modules
// linked into the base vacuity worktree.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, tmpdir } from './helpers.mjs';
import { gitRepo, git, commitAll, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { verify } from '../lib/verify.mjs';
import { buildDiff } from '../lib/eval.mjs';
import { commandNotFound, commandPrograms } from '../lib/exec.mjs';
import { withNoHooksDir } from '../lib/tmp.mjs';

const MISSING = 'harness-f50-no-such-prog';
const posix = process.platform !== 'win32';

// A repo on branch `feature` with a committed `sub/` directory and an F9 contract whose
// `checks` are [id, check, new].
function fixture(checks = [], files = {}) {
  return gitRepo({
    'sub/keep.txt': 'x\n',
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': {
      id: 'F9', title: 'fixture', security_tier: 'standard', version: 1,
      acceptance_criteria: checks.map(([id, check, isNew = false]) => ({ id, criterion: id, check, new: isNew })),
      security_criteria: [], error_scenarios: [], out_of_scope: [],
    },
    ...files,
  });
}
const run = (dir, verifyCfg = {}) => verify({
  root: dir, featureId: 'F9', base: 'main', cpus: 1,
  config: resolveConfig({ base_branch: 'main', verify: { commands: [], ...verifyCfg }, budget: { step_timeout_sec: 60 } }),
});

// ---------- AC-1 ----------
test('F50 AC-1: a verify command "cd sub && <missing>" is command not found', async () => {
  const r = await run(fixture(), { commands: [`cd sub && ${MISSING}`] });
  const c = r.commands[0];
  assert.equal(c.pass, false);
  assert.equal(c.notFound, MISSING, JSON.stringify(c));
  assert.match(c.message, new RegExp(`command not found: ${MISSING}`));
});

test('F50 AC-1: a verify command "cd sub && sh -c \\"exit 127\\"" is a plain failure', async () => {
  if (!posix) return; // cmd.exe has no sh; the node form below covers Windows
  const r = await run(fixture(), { commands: ['cd sub && sh -c "exit 127"'] });
  const c = r.commands[0];
  assert.equal(c.notFound, undefined, JSON.stringify(c));
  assert.equal(c.message, 'exit 127');
});

test('F50 AC-1: a verify command "cd sub && node -e exit(127)" is a plain failure', async () => {
  const r = await run(fixture(), { commands: ['cd sub && node -e "process.exit(127)"'] });
  const c = r.commands[0];
  assert.equal(c.notFound, undefined, JSON.stringify(c));
  assert.equal(c.message, 'exit 127');
});

test('F50 AC-1: a check "cd sub && <missing>" is command not found', async () => {
  const r = await run(fixture([['AC-1', `cd sub && ${MISSING} AC-1`]]));
  const c = r.criteria[0];
  assert.equal(c.pass, false);
  assert.equal(c.notFound, MISSING, JSON.stringify(c));
  assert.match(c.message, /command not found/);
});

test('F50 AC-1: a check "cd sub && sh -c \\"exit 127\\"" is a plain failure', async () => {
  if (!posix) return;
  const r = await run(fixture([['AC-1', 'cd sub && sh -c "exit 127"']]));
  const c = r.criteria[0];
  assert.equal(c.pass, false);
  assert.equal(c.notFound, undefined, JSON.stringify(c));
  assert.equal(c.message, 'exit 127');
});

test('F50 AC-1: a check "<fails> || <missing>" is command not found', async () => {
  const r = await run(fixture([['AC-1', `node -e "process.exit(1)" || ${MISSING}`]]));
  const c = r.criteria[0];
  assert.equal(c.notFound, MISSING, JSON.stringify(c));
});

test('F50 AC-1: a check "echo x; <missing>" is command not found', async () => {
  if (!posix) return; // ';' does not chain commands in cmd.exe
  const r = await run(fixture([['AC-1', `echo x; ${MISSING}`]]));
  const c = r.criteria[0];
  assert.equal(c.notFound, MISSING, JSON.stringify(c));
});

test('F50 AC-1: a check "echo x | <missing>" is command not found', async () => {
  if (!posix) return; // cmd.exe reports a missing program in a pipe differently
  const r = await run(fixture([['AC-1', `echo x | ${MISSING}`]]));
  const c = r.criteria[0];
  assert.equal(c.notFound, MISSING, JSON.stringify(c));
});

test('F50 AC-1: a test_count "cd sub && <missing>" is command not found', async () => {
  const r = await run(fixture(), { test_count: `cd sub && ${MISSING}` });
  const tc = r.integrity.testCount;
  assert.equal(tc.status, 'error');
  assert.equal(tc.notFound, MISSING, JSON.stringify(tc));
});

test('F50 AC-1: a test_count "cd sub && sh -c \\"exit 127\\"" is a plain error', async () => {
  if (!posix) return;
  const r = await run(fixture(), { test_count: 'cd sub && sh -c "exit 127"' });
  const tc = r.integrity.testCount;
  assert.equal(tc.status, 'error');
  assert.equal(tc.notFound, undefined, JSON.stringify(tc));
  assert.doesNotMatch(tc.message, /command not found/);
});

test('F50 AC-1: the rule — the first program of each chained part', () => {
  const p = 'linux';
  const nf = (stderr) => ({ code: 127, stderr });
  assert.equal(commandNotFound('cd sub && jest', nf('sh: 1: jest: not found\n'), p), true);
  assert.equal(commandNotFound('false || jest', nf('bash: jest: command not found\n'), p), true);
  assert.equal(commandNotFound('echo a; jest', nf('zsh:1: command not found: jest\n'), p), true);
  assert.equal(commandNotFound('echo a | jest', nf('sh: 1: jest: not found\n'), p), true);
  assert.equal(commandNotFound('cd sub && CI=1 jest --ci', nf('sh: 1: jest: not found\n'), p), true);
  assert.equal(commandNotFound('cd sub && sh -c "exit 127"', nf(''), p), false);
  assert.equal(commandNotFound('cd sub && npm test', nf('sh: 1: jest: not found\n'), p), false);
  // separators inside quotes do not split
  assert.equal(commandNotFound('node -e "a && jest"', nf('sh: 1: jest: not found\n'), p), false);
  assert.deepEqual(commandPrograms('cd sub && A=1 jest || x;y | "z w" q'), ['cd', 'jest', 'x', 'y', 'z w']);
  assert.deepEqual(commandPrograms('echo "a && b" \'c | d\''), ['echo']);
});

// ---------- AC-2 ----------
test('F50 AC-2: withNoHooksDir gives each call a new empty directory and removes it', async () => {
  const seen = [];
  for (let i = 0; i < 2; i++) {
    await withNoHooksDir(async (d) => {
      assert.ok(fs.statSync(d).isDirectory());
      assert.deepEqual(fs.readdirSync(d), []);
      assert.equal(fs.realpathSync.native(path.dirname(d)), fs.realpathSync.native(os.tmpdir()));
      assert.match(path.basename(d), /^harness-no-hooks-./);
      seen.push(d);
    });
  }
  assert.notEqual(seen[0], seen[1]);
  for (const d of seen) assert.equal(fs.existsSync(d), false, `${d} is removed`);
  let kept = null;
  await assert.rejects(withNoHooksDir(async (d) => { kept = d; throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(kept), false, 'removed after a failure too');
});

// A PATH-first `git` that logs each core.hooksPath value (and whether it is an empty
// directory at that moment) to `log`, then runs the real git.
function fakeGit(log) {
  const realGit = (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, 'git')).find((f) => fs.existsSync(f));
  assert.ok(realGit, 'git on PATH');
  const bin = tmpdir('harness-f50-bin-');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
for a in "$@"; do
  case "$a" in core.hooksPath=*)
    d="\${a#core.hooksPath=}"
    if [ -d "$d" ] && [ -z "$(ls -A "$d")" ]; then s=empty; else s=bad; fi
    printf '%s\\t%s\\n' "$d" "$s" >> '${log}';;
  esac
done
exec '${realGit}' "$@"
`, { mode: 0o755 });
  return bin;
}
async function withFakeGit(fn) {
  const log = path.join(tmpdir('harness-f50-log-'), 'hooks.log');
  const saved = process.env.PATH;
  process.env.PATH = `${fakeGit(log)}${path.delimiter}${saved}`;
  try { await fn(); } finally { process.env.PATH = saved; }
  return fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split('\t'));
}
function assertFreshHooksDirs(rows) {
  assert.ok(rows.length >= 3, `several git calls logged: ${rows.length}`);
  for (const [d, state] of rows) {
    assert.equal(state, 'empty', `${d} was an empty directory during the call`);
    assert.notEqual(path.basename(d), 'harness-no-hooks-dir');
    assert.match(path.basename(d), /^harness-no-hooks-./);
    assert.equal(fs.realpathSync.native(path.dirname(d)), fs.realpathSync.native(os.tmpdir()));
    assert.equal(fs.existsSync(d), false, `${d} is removed afterwards`);
  }
  assert.equal(new Set(rows.map(([d]) => d)).size, rows.length, 'one directory per git call');
}

test('F50 AC-2: verify gives git a fresh empty hooksPath per call, never the fixed path', async () => {
  if (!posix) return; // the logging git is a shell script; the unit test above covers Windows
  const dir = fixture([['AC-1', 'node -e "process.exit(0)"', false]], {});
  fs.writeFileSync(path.join(dir, 'change.txt'), 'x\n');
  const rows = await withFakeGit(() => run(dir, { test_count: 'node -e "console.log(1)"' }));
  assertFreshHooksDirs(rows);
});

test('F50 AC-2: eval (buildDiff) gives git a fresh empty hooksPath per call, never the fixed path', async () => {
  if (!posix) return;
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'change.txt'), 'x\n');
  const rows = await withFakeGit(async () => {
    const d = await buildDiff({ cwd: dir, base: 'main' });
    assert.match(JSON.stringify(d), /change\.txt/);
  });
  assertFreshHooksDirs(rows);
});

// ---------- AC-3 / SC-1 / ES-1 ----------
const PKG = { 'node_modules/f50pkg/index.js': 'module.exports = 1;\n' };
// A repo whose base ignores node_modules; the working tree has node_modules/f50pkg.
function depsFixture(checks) {
  const dir = fixture(checks, { '.gitignore': 'node_modules/\n' });
  writeFiles(dir, PKG);
  return dir;
}

test('F50 AC-3: a new check that only needs a node_modules package is vacuous (base sees node_modules)', async () => {
  const dir = depsFixture([['AC-1', 'node -e "require(\'f50pkg\')"', true]]);
  const r = await run(dir);
  const c = r.criteria[0];
  assert.equal(c.vacuous, true, JSON.stringify(r));
  assert.equal(c.pass, false);
});

test('F50 AC-3: a new check that needs a file the feature adds stays non-vacuous with node_modules linked', async () => {
  const dir = depsFixture([['AC-1', 'node -e "require(\'f50pkg\'); require(\'./feature.cjs\')"', true]]);
  fs.writeFileSync(path.join(dir, 'feature.cjs'), 'module.exports = 2;\n');
  const r = await run(dir);
  const c = r.criteria[0];
  assert.equal(c.pass, true, JSON.stringify(r));
  assert.equal(c.vacuous, false);
});

// Every entry under `root` (not following links): relative path → [kind, size, mtimeMs].
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      out[path.relative(root, p)] = [st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file', st.size, st.mtimeMs];
      if (st.isDirectory() && !st.isSymbolicLink()) walk(p);
    }
  };
  walk(root);
  return out;
}

test('F50 SC-1: the node_modules link exists only in the base worktree and the working tree node_modules is unchanged', async () => {
  const log = path.join(tmpdir('harness-f50-log-'), 'probe.log');
  const dir = fixture([['AC-1', 'node probe.cjs', true]], {
    '.gitignore': 'node_modules/\n',
    'probe.cjs': `const fs = require('fs');
let link = false; let real = null;
try { link = fs.lstatSync('node_modules').isSymbolicLink(); real = fs.realpathSync.native('node_modules'); } catch {}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: fs.realpathSync.native(process.cwd()), link, real }) + '\\n');
require('f50pkg');
`,
  });
  writeFiles(dir, { ...PKG, 'node_modules/other/a.txt': 'a\n' });
  const nm = path.join(dir, 'node_modules');
  const before = snapshot(nm);
  const beforeSt = fs.lstatSync(nm);
  const r = await run(dir);
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2, JSON.stringify(rows));
  const [head, base] = rows;
  assert.equal(head.cwd, fs.realpathSync.native(dir));
  assert.equal(head.link, false, 'the working tree node_modules is not replaced by a link');
  assert.notEqual(base.cwd, head.cwd);
  assert.match(path.basename(base.cwd), /^harness-base-/);
  assert.equal(base.link, true, 'the base worktree has a link');
  assert.equal(base.real, fs.realpathSync.native(nm));
  assert.equal(r.criteria[0].vacuous, true, JSON.stringify(r.criteria));
  // After verify: the base worktree is gone, the working tree node_modules is as it was.
  assert.equal(fs.existsSync(base.cwd), false);
  const afterSt = fs.lstatSync(nm);
  assert.equal(afterSt.isSymbolicLink(), false);
  assert.ok(afterSt.isDirectory());
  assert.equal(afterSt.mtimeMs, beforeSt.mtimeMs);
  assert.deepEqual(snapshot(nm), before);
  assert.equal(Object.keys(before).length, 4); // f50pkg, f50pkg/index.js, other, other/a.txt
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('F50 ES-1: when the node_modules link cannot be made, verify warns and continues without it', async () => {
  // The base tracks its own node_modules, so the link path is taken; the working tree adds a
  // package the base does not have.
  const dir = fixture([['AC-1', 'node -e "require(\'f50new\')"', true]], {
    'node_modules/f50pkg/index.js': 'module.exports = 0;\n',
  });
  writeFiles(dir, { 'node_modules/f50new/index.js': 'module.exports = 1;\n' });
  commitAll(dir, 'feature adds a package');
  const r = await run(dir);
  assert.ok(r.warnings.some((w) => /node_modules/.test(w) && /link/.test(w)), JSON.stringify(r.warnings));
  const c = r.criteria[0];
  assert.equal(c.pass, true, JSON.stringify(c));
  assert.equal(c.vacuous, false);
  assert.equal(c.base_not_found, undefined);
});

// ---------- AC-4 ----------
test('F50 AC-4: SPEC §6 explains chained commands, per-call hooksPath directories and the node_modules link', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs/SPEC.md'), 'utf8');
  const s6 = spec.slice(spec.indexOf('## 6.'), spec.indexOf('\n## 7.'));
  assert.ok(s6.includes('`&&`·`||`·`;`·`|`'), 'names the separators');
  assert.match(s6, /cd sub && /, 'gives the chained example');
  assert.ok(s6.includes('core.hooksPath'), 'names core.hooksPath');
  assert.match(s6, /mkdtemp/);
  assert.ok(s6.includes('harness-no-hooks-'), 'names the per-call directory');
  assert.ok(s6.includes('node_modules'), 'names node_modules');
  assert.match(s6, /junction/);
  assert.match(s6, /경고/, 'says a failed link only warns');
});
