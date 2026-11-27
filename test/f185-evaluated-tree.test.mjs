import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { harness, REPO, realTmpdir, writeJson } from './helpers.mjs';
import { git, gitRepo, writeFiles } from './gitfixture.mjs';
import { hashContract } from '../lib/contract.mjs';
import { HarnessError } from '../lib/errors.mjs';
import { USAGE } from '../lib/help.mjs';
import { evaluatedTree } from '../lib/verify.mjs';
import evalCommand from '../lib/commands/eval.mjs';

const FAKE_CLI = path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs');
const TREE_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function contract() {
  const c = {
    id: 'F9', title: 'fixture feature', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'one', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-23T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

// The evaluator CLI fails at once: nothing reaches a real model even if injection is not honoured.
const FAILING_CLI = {
  roles: { builder: 'claude', evaluator: 'generic', 'security-reviewer': 'generic' },
  adapters: { generic: { read_only_command: [process.execPath, FAKE_CLI, 'exit', '1'] } },
};

function fixture() {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...FAILING_CLI },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': contract(),
    '.harness/backlog.json': { items: [] },
    '.gitignore': 'ignored.log\n',
    'scripts/ok.mjs': 'process.exit(0);\n',
    'src/a.txt': 'a\n',
    'src/b.txt': 'b\n',
  });
}

const PASS_VERIFY = {
  pass: true, commands: [], warnings: [],
  integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } },
  criteria: [{ id: 'AC-1', pass: true }],
};
const scores = { functionality: 9, quality: 9, security: 9, errors: 9, tests: 9 };
const passReply = () => {
  const json = { scores, findings: [], out_of_scope: [] };
  return { ok: true, error: null, text: JSON.stringify(json), json, costUsd: 0, exitCode: 0 };
};

async function runEval(dir, during = () => {}) {
  const out = [];
  const err = [];
  const runAdapter = async () => { during(); return passReply(); };
  let code;
  try {
    code = await evalCommand({ root: dir, args: ['F9'], out: (s) => out.push(s), err: (s) => err.push(s), deps: { runAdapter, verifyResult: PASS_VERIFY } });
  } catch (e) {
    if (!(e instanceof HarnessError)) throw e;
    code = e.exit;
    err.push(e.message);
  }
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const verdictFile = (dir, k = 1) => path.join(dir, '.harness', 'verdicts', `F9-r${k}.json`);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

async function passed() {
  const dir = fixture();
  const r = await runEval(dir);
  assert.equal(r.code, 0, r.out + r.err);
  return dir;
}

const check = (dir, args = ['F9']) => harness(['merge-check', ...args], { cwd: dir });
const okLine = (r) => /^ok F9 tree [0-9a-f]{12}$/m.test(r.stdout);

// The working tree as git sees it with a temporary index, .harness/ left out — built by hand.
function treeByHand(dir) {
  const index = path.join(realTmpdir('f185-index-'), 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const run = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  run('read-tree', 'HEAD');
  run('add', '-A', '--', '.');
  run('rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.harness');
  return run('write-tree');
}

// ---------- AC-1 ----------
test('F185 AC-1 the verdict records the working tree after the evaluator session, without .harness/', async () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'ignored.log'), 'ignored\n');
  fs.writeFileSync(path.join(dir, 'src', 'early.txt'), 'untracked before eval\n');
  const r = await runEval(dir, () => fs.writeFileSync(path.join(dir, 'src', 'late.txt'), 'written during the session\n'));
  assert.equal(r.code, 0, r.out + r.err);
  const v = readJson(verdictFile(dir));
  assert.match(v.tree, TREE_ID);
  assert.equal(v.tree, treeByHand(dir));
  const names = git(dir, 'ls-tree', '-r', '--name-only', v.tree).split('\n');
  assert.ok(names.includes('src/late.txt'), names.join(','));
  assert.ok(names.includes('src/early.txt'), names.join(','));
  assert.ok(names.includes('src/a.txt'));
  assert.ok(!names.includes('ignored.log'), names.join(','));
  assert.ok(!names.some((n) => n.startsWith('.harness/')), names.join(','));
  // Contrast: .harness/ is in the commit, only the evaluated tree leaves it out.
  assert.ok(git(dir, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').includes('.harness/config.json'));
  assert.equal(await evaluatedTree({ root: dir }), v.tree);
});

// ---------- AC-2 ----------
test('F185 AC-2 nothing changed after eval: ok F9 tree <12>, exit 0, also with .harness/ records committed', async () => {
  const dir = await passed();
  const tree = readJson(verdictFile(dir)).tree;
  let r = check(dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), `ok F9 tree ${tree.slice(0, 12)}`);
  // The eval's records (verdict, features.json) are committed: still the same tree.
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'harness: F9 eval records');
  r = check(dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(okLine(r), r.stdout);
  // Another change under .harness/ only.
  fs.writeFileSync(path.join(dir, '.harness', 'note.txt'), 'x\n');
  r = check(dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  // Contrast: a change outside .harness/ is not ok.
  fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'changed\n');
  r = check(dir);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.ok(!okLine(r));
});

// ---------- AC-3 ----------
test('F185 AC-3 auto, build and AGENTS.md run merge-check before merging and do not merge when it fails', () => {
  for (const f of ['skills/auto/SKILL.md', 'skills/build/SKILL.md', 'AGENTS.md']) {
    const t = fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\s+/g, ' ');
    assert.ok(t.includes('`harness merge-check F{n}`'), `${f}: merge-check`);
    const at = t.indexOf('`harness merge-check F{n}`');
    const merge = t.indexOf('merge the feature branch');
    assert.ok(t.includes('Before you merge a passed feature, run `harness merge-check F{n}`') || (merge > at && at >= 0),
      `${f}: merge-check comes before the merge`);
    assert.match(t, /not (0|exit 0)[^.]*,? do not merge: revert the changes made after eval, or ask the user/, `${f}: on failure`);
  }
});

// ---------- AC-4 ----------
test('F185 AC-4 merge-check in USAGE and --help, SPEC §7 section, README command list line', () => {
  assert.ok(Object.hasOwn(USAGE, 'merge-check'));
  const help = harness(['--help'], { cwd: realTmpdir('f185-help-') });
  assert.match(help.stdout, /^ {2}merge-check +\S/m);
  const own = harness(['merge-check', '--help'], { cwd: realTmpdir('f185-help-') });
  assert.equal(own.code, 0);
  assert.match(own.stdout, /^usage: harness merge-check F<n>/);
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s7 = spec.slice(spec.indexOf('\n## 7. '), spec.indexOf('\n## 8. '));
  assert.ok(s7.length > 0);
  const section = s7.slice(s7.indexOf('`harness merge-check F{n}`'));
  assert.ok(s7.includes('`harness merge-check F{n}`'), 'SPEC §7 names merge-check');
  assert.match(section, /`tree`/);
  assert.match(section, /tree changed since eval/);
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8').split('\n');
  const start = readme.findIndex((l) => l.startsWith('코어 명령:'));
  const list = readme.slice(start, readme.indexOf('', start));
  assert.equal(list.filter((l) => l.includes('`harness merge-check`')).length, 1, list.join('\n'));
});

// ---------- SC-1 ----------
test('F185 SC-1 a change after eval fails merge-check with its path; reverting it passes again', async () => {
  const dir = await passed();
  const changed = (r, p) => {
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /tree changed since eval/);
    assert.ok(r.stderr.includes(p), r.stderr);
    assert.ok(!okLine(r));
  };
  const ok = (r) => { assert.equal(r.code, 0, r.stdout + r.stderr); assert.ok(okLine(r), r.stdout); };
  ok(check(dir));
  // Tracked file modified.
  fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'after eval\n');
  changed(check(dir), 'src/a.txt');
  git(dir, 'checkout', '--', 'src/a.txt');
  ok(check(dir));
  // New untracked, not ignored file.
  fs.writeFileSync(path.join(dir, 'src', 'new.txt'), 'new\n');
  changed(check(dir), 'src/new.txt');
  fs.rmSync(path.join(dir, 'src', 'new.txt'));
  ok(check(dir));
  // An ignored new file is not part of the tree (contrast with the case above).
  fs.writeFileSync(path.join(dir, 'ignored.log'), 'x\n');
  ok(check(dir));
  // Tracked file deleted.
  fs.rmSync(path.join(dir, 'src', 'b.txt'));
  changed(check(dir), 'src/b.txt');
  git(dir, 'checkout', '--', 'src/b.txt');
  ok(check(dir));
  // The change committed.
  fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'committed after eval\n');
  git(dir, 'add', 'src/a.txt');
  git(dir, 'commit', '-q', '-m', 'after eval');
  changed(check(dir), 'src/a.txt');
  git(dir, 'reset', '-q', 'HEAD~1');
  git(dir, 'checkout', '--', 'src/a.txt');
  ok(check(dir));
});

// ---------- SC-2 ----------
test('F185 SC-2 not passed, or a passed verdict without tree, exits 1; with tree exits 0', async () => {
  const dir = fixture();
  let r = check(dir);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /F9 is approved, not passed/);
  assert.equal(r.stdout, '');
  assert.equal((await runEval(dir)).code, 0);
  const file = verdictFile(dir);
  const v = readJson(file);
  const { tree, ...old } = v;
  writeJson(file, old); // as written before F185
  r = check(dir);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /no evaluated tree/);
  writeJson(file, v);
  r = check(dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), `ok F9 tree ${tree.slice(0, 12)}`);
});

// ---------- SC-3 ----------
test('F185 SC-3 only the last passed verdict of the current contract hash counts', async () => {
  const dir = await passed();
  const v = readJson(verdictFile(dir, 1));
  const evaluated = v.tree;
  fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'later version\n');
  const now = await evaluatedTree({ root: dir });
  assert.notEqual(now, evaluated);
  // r1: an earlier contract version passed with today's tree; r2: the current contract, the old tree.
  writeJson(verdictFile(dir, 1), { ...v, contract_hash: 'f'.repeat(64), tree: now });
  writeJson(verdictFile(dir, 2), { ...v, round: 2, tree: evaluated });
  let r = check(dir);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /tree changed since eval/);
  // Contrast: the current contract's last passed verdict has today's tree.
  writeJson(verdictFile(dir, 3), { ...v, round: 3, tree: now });
  r = check(dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  // A later passed verdict of the current contract wins over r3.
  writeJson(verdictFile(dir, 4), { ...v, round: 4, tree: evaluated });
  r = check(dir);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  // A later failed verdict does not count.
  writeJson(verdictFile(dir, 4), { ...v, round: 4, verdict: 'fail', tree: evaluated });
  r = check(dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  // Only a verdict of another contract hash: no evaluated tree.
  for (const k of [2, 3, 4]) fs.rmSync(verdictFile(dir, k));
  r = check(dir);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /no evaluated tree/);
});

// Every file under `dir` with its content.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

// ---------- ES-1 ----------
test('F185 ES-1 no argument or an unknown feature is a usage error; outside a git worktree a git error; state unchanged', async () => {
  const dir = await passed();
  const before = snapshot(path.join(dir, '.harness'));
  for (const args of [[], ['F999'], ['nope']]) {
    const r = check(dir, args);
    assert.equal(r.code, 2, `${args}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage: harness merge-check/);
  }
  // Contrast: the same project with the right id.
  assert.equal(check(dir).code, 0);
  assert.deepEqual(snapshot(path.join(dir, '.harness')), before);
  // The same state outside any git worktree.
  const plain = realTmpdir('f185-nogit-');
  fs.cpSync(path.join(dir, '.harness'), path.join(plain, '.harness'), { recursive: true });
  writeFiles(plain, { 'src/a.txt': 'a\n' });
  const plainBefore = snapshot(plain);
  const r = check(plain);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /not a git worktree/);
  assert.deepEqual(snapshot(plain), plainBefore);
});

// ---------- ES-2 ----------
test('F185 ES-2 merge-check does not write the index of the repository or of a linked worktree', async () => {
  const dir = await passed();
  const status = (d) => git(d, '--no-optional-locks', 'status', '--porcelain', '--untracked-files=all');
  const same = (d) => {
    const index = path.resolve(d, git(d, 'rev-parse', '--git-path', 'index'));
    const s0 = status(d);
    const i0 = fs.readFileSync(index);
    const r = check(d);
    assert.deepEqual(fs.readFileSync(index), i0, 'index unchanged');
    assert.equal(status(d), s0);
    return r;
  };
  assert.equal(same(dir).code, 0);
  fs.writeFileSync(path.join(dir, 'src', 'new.txt'), 'new\n');
  fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'changed\n');
  assert.equal(same(dir).code, 1);
  fs.rmSync(path.join(dir, 'src', 'new.txt'));
  git(dir, 'checkout', '--', 'src/a.txt');
  // A linked worktree of the committed state.
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'records');
  const wt = path.join(realTmpdir('f185-wt-'), 'wt');
  git(dir, 'worktree', 'add', '-q', '-b', 'other', wt);
  assert.equal(same(wt).code, 0);
  fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'changed in wt\n');
  const r = same(wt);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes('src/a.txt'), r.stderr);
});
