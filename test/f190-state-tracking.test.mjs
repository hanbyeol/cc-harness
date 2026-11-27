// F190: status --brief tells when .harness/ is not tracked by git (or ignored), and migrate-v1
// ends with a `next:` line asking to commit it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { harness, fakeExecutableLink, writeJson, realTmpdir, REPO } from './helpers.mjs';
import { gitRepo, git } from './gitfixture.mjs';
import { briefStateLine } from '../lib/statetrack.mjs';
import { gitTimeoutError } from '../lib/exec.mjs';

const NOT_COMMITTED = 'state: .harness/ is not committed — commit it (git add .harness)';
const NEXT = 'next: commit .harness/ — the state lives in git (git add .harness && git commit)';
const lines = (s) => s.trimEnd().split(/\r?\n/);
const brief = (dir, env) => harness(['status', '--brief'], { cwd: dir, env });
const stateLines = (s) => lines(s).filter((l) => l.startsWith('state:'));

// A git repository with an initialized, uncommitted .harness/.
function initializedRepo() {
  const dir = gitRepo({ 'a.txt': 'a\n' });
  const r = harness(['init'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  return dir;
}

test('F190 AC-1 an untracked, not ignored .harness/ adds the state line; after a commit it is gone', () => {
  const dir = initializedRepo();
  const r = brief(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(stateLines(r.stdout), [NOT_COMMITTED], r.stdout);
  assert.match(lines(r.stdout)[0], /^harness: /);

  // From a subdirectory the root is found (F182) and the same line is printed.
  fs.mkdirSync(path.join(dir, 'sub', 'deep'), { recursive: true });
  const s = brief(path.join(dir, 'sub', 'deep'));
  assert.equal(s.code, 0, s.stderr);
  assert.deepEqual(stateLines(s.stdout), [NOT_COMMITTED], s.stdout);

  git(dir, 'add', '.harness');
  git(dir, 'commit', '-q', '-m', 'harness state');
  const after = brief(dir);
  assert.equal(after.code, 0, after.stderr);
  assert.deepEqual(stateLines(after.stdout), [], after.stdout);
  assert.match(lines(after.stdout)[0], /^harness: /);
});

test('F190 AC-2 a .harness/ ignored by a .gitignore rule names the rule file and line', () => {
  const dir = initializedRepo();
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.harness/\n');
  const r = brief(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(stateLines(r.stdout), ['state: .harness/ is ignored by git (.gitignore:2) — state must be tracked'], r.stdout);

  // A nested rule file is named by its path from the repository top.
  fs.rmSync(path.join(dir, '.gitignore'));
  fs.writeFileSync(path.join(dir, '.harness', '.gitignore'), '# all state\nconfig.json\n');
  const n = brief(dir);
  assert.equal(n.code, 0, n.stderr);
  assert.deepEqual(stateLines(n.stdout), ['state: .harness/ is ignored by git (.harness/.gitignore:2) — state must be tracked'], n.stdout);

  // A negated rule does not ignore: the file is only untracked.
  fs.writeFileSync(path.join(dir, '.harness', '.gitignore'), '*\n!config.json\n');
  const neg = brief(dir);
  assert.equal(neg.code, 0, neg.stderr);
  assert.deepEqual(stateLines(neg.stdout), [NOT_COMMITTED], neg.stdout);
});

function v1Project(dir) {
  writeJson(path.join(dir, 'progress', 'feature_list.json'), { features: [{ id: 'F1', name: 'one', passes: true }] });
  return dir;
}

test('F190 AC-3 migrate-v1 ends with the next line while .harness/config.json is untracked; not once it is tracked', () => {
  const dir = v1Project(gitRepo({ 'a.txt': 'a\n' }));
  const r = harness(['migrate-v1'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(lines(r.stdout).at(-1), NEXT, r.stdout);
  assert.equal(lines(r.stdout).filter((l) => l === NEXT).length, 1, r.stdout);

  git(dir, 'add', '.harness');
  git(dir, 'commit', '-q', '-m', 'harness state');
  const again = harness(['migrate-v1', '--force'], { cwd: dir });
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.ok(!again.stdout.includes('next: commit .harness/'), again.stdout);
  assert.match(lines(again.stdout).at(-1), /v1 files are left in place/);

  // Outside a git repository there is nothing to commit into: no next line.
  const plain = v1Project(realTmpdir('harness-f190-nogit-'));
  if (spawnSync('git', ['rev-parse', '--git-dir'], { cwd: plain }).status !== 0) {
    const p = harness(['migrate-v1'], { cwd: plain });
    assert.equal(p.code, 0, p.stdout + p.stderr);
    assert.ok(!p.stdout.includes('next: commit .harness/'), p.stdout);
  }
});

test('F190 AC-4 SPEC documents the state line and the migrate-v1 next line', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s13 = spec.slice(spec.indexOf('## 13. v1 마이그레이션'));
  assert.ok(s13.includes(NEXT), 'SPEC §13 names the migrate-v1 next line');
  assert.ok(spec.includes(NOT_COMMITTED), 'SPEC names the not committed state line');
  assert.ok(spec.includes('state: .harness/ is ignored by git (<'), 'SPEC names the ignored state line');
  const briefPara = spec.split('\n').find((l) => l.includes('`status --brief`') && l.includes('is not committed'));
  assert.ok(briefPara, 'a status --brief paragraph mentions is not committed');
});

const POSIX = process.platform !== 'win32'; // the fake git is a shebang script
const REAL_GIT = spawnSync(POSIX ? 'which' : 'where', ['git'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim();
const pathKey = () => Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

test('F190 ES-1 no git repository, a failing git or a git past 10 s: no state line, the rest as before, exit 0', async () => {
  // Not a git repository: the state line is left out, the summary is printed.
  const plain = realTmpdir('harness-f190-nogit-');
  assert.equal(harness(['init'], { cwd: plain }).code, 0);
  if (spawnSync('git', ['rev-parse', '--git-dir'], { cwd: plain }).status !== 0) {
    const r = brief(plain);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(stateLines(r.stdout), [], r.stdout);
    assert.match(lines(r.stdout)[0], /^harness: /);
  }

  // Contrast and failing git in the same repository: the real git prints the line, a git that
  // fails ls-files and check-ignore does not, and the rest of the output is the same.
  const dir = initializedRepo();
  const ok = brief(dir);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(stateLines(ok.stdout), [NOT_COMMITTED]);
  if (POSIX) {
    const bin = fakeExecutableLink('git', `#!/bin/sh
case " $* " in *" ls-files "*|*" check-ignore "*) echo "fatal: injected failure" >&2; exit 128 ;; esac
exec "${REAL_GIT}" "$@"
`, 'harness-f190-git-');
    const env = { ...process.env, [pathKey()]: `${bin}${path.delimiter}${process.env[pathKey()]}` };
    const f = brief(dir, env);
    assert.equal(f.code, 0, f.stderr);
    assert.deepEqual(stateLines(f.stdout), [], f.stdout);
    assert.deepEqual(lines(f.stdout), lines(ok.stdout).filter((l) => !l.startsWith('state:')));
  }

  // The git calls are capped at 10 s; a call past it (the runner throws) leaves the line out.
  const seen = [];
  const timedOut = await briefStateLine(dir, { run: async (args, cwd, opts) => { seen.push(opts.timeoutSec); throw gitTimeoutError(args, opts.timeoutSec); } });
  assert.equal(timedOut, null);
  assert.ok(seen.length > 0 && seen.every((t) => t === 10), JSON.stringify(seen));
  // A runner that fails with an exit code other than "not matched" leaves it out too.
  assert.equal(await briefStateLine(dir, { run: async () => ({ code: 128, stdout: '', stderr: 'fatal' }) }), null);
  // Contrast: the same function with a runner reporting "untracked, not ignored" gives the line.
  assert.equal(await briefStateLine(dir, { run: async () => ({ code: 1, stdout: '', stderr: '' }) }), NOT_COMMITTED);
});
