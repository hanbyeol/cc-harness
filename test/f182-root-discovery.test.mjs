import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, realTmpdir, writeJson, REPO } from './helpers.mjs';

// An initialized project in a fresh temporary directory with the given features.
function initialized(dir, features) {
  fs.mkdirSync(dir, { recursive: true });
  const r = harness(['init'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  writeJson(path.join(dir, '.harness', 'features.json'), { features });
  return dir;
}

const feature = (id, title) => ({ id, title, security_tier: 'standard', depends_on: [], status: 'todo' });

function sub(dir, ...parts) {
  const d = path.join(dir, ...parts);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

test('F182 AC-1 status in a subdirectory a/b prints what it prints at the project top', () => {
  const top = initialized(realTmpdir('harness-f182-'), [feature('F1', 'outer one'), feature('F2', 'outer two')]);
  const atTop = harness(['status'], { cwd: top });
  assert.equal(atTop.code, 0, atTop.stdout + atTop.stderr);
  assert.match(atTop.stdout, /F1/);
  const inSub = harness(['status'], { cwd: sub(top, 'a', 'b') });
  assert.equal(inSub.code, 0, inSub.stdout + inSub.stderr);
  assert.equal(inSub.stdout, atTop.stdout);
  assert.equal(fs.existsSync(path.join(top, 'a', '.harness')), false);
  assert.equal(fs.existsSync(path.join(top, 'a', 'b', '.harness')), false);
});

test('F182 AC-2 the search stops at the first directory with a .git entry', () => {
  const top = initialized(realTmpdir('harness-f182-'), [feature('F1', 'outer feature')]);
  // A linked worktree inside the project: its own .git file and its own .harness/.
  const wt = initialized(sub(top, '.harness', 'wt', 'x'), [feature('F9', 'worktree feature')]);
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /nowhere/.git/worktrees/x\n');
  const inWt = harness(['status'], { cwd: sub(wt, 'src', 'deep') });
  assert.equal(inWt.code, 0, inWt.stdout + inWt.stderr);
  assert.match(inWt.stdout, /F9/);
  assert.doesNotMatch(inWt.stdout, /F1\b/);
  // Contrast: a subdirectory without .git uses the outer project.
  const inOuter = harness(['status'], { cwd: sub(top, 'lib', 'x') });
  assert.equal(inOuter.code, 0, inOuter.stdout + inOuter.stderr);
  assert.match(inOuter.stdout, /F1/);
  assert.doesNotMatch(inOuter.stdout, /F9/);
});

test('F182 AC-3 init in a subdirectory of an initialized project creates .harness/ there', () => {
  const top = initialized(realTmpdir('harness-f182-'), [feature('F1', 'outer feature')]);
  const before = fs.readFileSync(path.join(top, '.harness', 'config.json'), 'utf8');
  const d = sub(top, 'pkg', 'inner');
  // Contrast: other commands in the same subdirectory search upward and use the outer project.
  const searched = harness(['status'], { cwd: d });
  assert.equal(searched.code, 0, searched.stdout + searched.stderr);
  assert.match(searched.stdout, /F1/);
  const r = harness(['init'], { cwd: d });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(path.join(d, '.harness', 'config.json')), true);
  assert.equal(fs.existsSync(path.join(d, '.harness', 'features.json')), true);
  assert.equal(fs.readFileSync(path.join(top, '.harness', 'config.json'), 'utf8'), before);
  // Contrast: after init the subdirectory is its own root.
  const s = harness(['status'], { cwd: d });
  assert.equal(s.code, 0, s.stdout + s.stderr);
  assert.doesNotMatch(s.stdout, /F1/);
});

test('F182 AC-4 SPEC describes the nearest .harness/config.json, the .git boundary and init', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const paragraph = spec.split(/\n\s*\n|\n(?=[-|#])/).find((p) => p.includes('nearest'));
  assert.ok(paragraph, 'SPEC has a paragraph containing "nearest"');
  assert.match(paragraph, /\.harness\/config\.json/);
  assert.match(paragraph, /\.git/);
  assert.match(paragraph, /`?init`?/);
});

test('F182 ES-1 no .harness/config.json up to the .git boundary is not initialized as before', () => {
  // No initialized ancestor at all.
  const bare = realTmpdir('harness-f182-');
  const r = harness(['status'], { cwd: sub(bare, 'a', 'b') });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /not initialized — run `harness init`/);
  const v = harness(['verify', 'F1'], { cwd: sub(bare, 'a', 'b') });
  assert.equal(v.code, 2, v.stdout + v.stderr);
  assert.match(v.stderr, /not initialized — run `harness init`/);
  // An initialized project above a .git boundary is not used.
  const top = initialized(realTmpdir('harness-f182-'), [feature('F1', 'outer feature')]);
  const repo = sub(top, 'vendor', 'repo');
  fs.mkdirSync(path.join(repo, '.git'));
  const below = harness(['status'], { cwd: sub(repo, 'src') });
  assert.equal(below.code, 2, below.stdout + below.stderr);
  assert.match(below.stderr, /not initialized — run `harness init`/);
  assert.equal(fs.existsSync(path.join(repo, '.harness')), false);
  // Contrast: with .harness/config.json above (no .git between) it runs.
  const ok = harness(['status'], { cwd: sub(top, 'vendor', 'other') });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /F1/);
});
