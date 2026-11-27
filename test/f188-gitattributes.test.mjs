import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { harness, realTmpdir, REPO } from './helpers.mjs';
import { git, gitRepo, commitAll } from './gitfixture.mjs';

const ATTR = path.join('.harness', '.gitattributes');
const lines = (r) => r.stdout.split('\n');
const STATE = ['config.json', 'features.json', 'backlog.json'];
const snapshot = (d) => Object.fromEntries(STATE.map((f) => [f, fs.readFileSync(path.join(d, '.harness', f), 'utf8')]));

test('F188 AC-1 init creates .harness/.gitattributes with union merge for the JSON Lines records', () => {
  const d = realTmpdir('harness-f188-');
  const r = harness(['init'], { cwd: d });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(lines(r).includes('created .harness/.gitattributes'), r.stdout);
  const attrs = fs.readFileSync(path.join(d, ATTR), 'utf8').split(/\r?\n/);
  assert.ok(attrs.includes('runs/*.jsonl merge=union'));
  assert.ok(attrs.includes('deployments.jsonl merge=union'));
});

test('F188 AC-2 init again keeps an existing .gitattributes and creates a missing one', () => {
  const d = realTmpdir('harness-f188-');
  assert.equal(harness(['init'], { cwd: d }).code, 0);
  const file = path.join(d, ATTR);
  fs.writeFileSync(file, 'mine\n');
  const before = snapshot(d);
  const r = harness(['init'], { cwd: d });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(lines(r).includes('kept    .harness/.gitattributes'), r.stdout);
  assert.ok(!lines(r).includes('created .harness/.gitattributes'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'mine\n');
  assert.deepEqual(snapshot(d), before);
  // Contrast: an initialized project without the file gets it, state files unchanged.
  fs.rmSync(file);
  const again = harness(['init'], { cwd: d });
  assert.equal(again.code, 0, again.stderr);
  assert.ok(lines(again).includes('created .harness/.gitattributes'), again.stdout);
  assert.ok(fs.readFileSync(file, 'utf8').includes('runs/*.jsonl merge=union'));
  assert.deepEqual(snapshot(d), before);
});

// Two branches each append a different line to runs/eval.metrics.jsonl, then merge.
function mergeAppends({ keepAttributes }) {
  const d = gitRepo({ 'README.md': 'x\n' }, { branch: null });
  assert.equal(harness(['init'], { cwd: d }).code, 0);
  const log = path.join(d, '.harness', 'runs', 'eval.metrics.jsonl');
  fs.writeFileSync(log, JSON.stringify({ step: 'base' }) + '\n');
  if (!keepAttributes) fs.rmSync(path.join(d, ATTR));
  commitAll(d, 'init');
  git(d, 'checkout', '-q', '-b', 'a');
  fs.appendFileSync(log, JSON.stringify({ step: 'a' }) + '\n');
  commitAll(d, 'a');
  git(d, 'checkout', '-q', 'main');
  git(d, 'checkout', '-q', '-b', 'b');
  fs.appendFileSync(log, JSON.stringify({ step: 'b' }) + '\n');
  commitAll(d, 'b');
  const m = spawnSync('git', ['merge', '--no-edit', 'a'], { cwd: d, encoding: 'utf8' });
  const unmerged = git(d, 'diff', '--name-only', '--diff-filter=U');
  return { code: m.status, out: m.stdout + m.stderr, unmerged, text: fs.readFileSync(log, 'utf8') };
}

test('F188 AC-3 a merge of two appended metrics lines does not conflict with the init .gitattributes', () => {
  const ok = mergeAppends({ keepAttributes: true });
  assert.equal(ok.code, 0, ok.out);
  assert.equal(ok.unmerged, '');
  const rows = ok.text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.step).sort(), ['a', 'b', 'base']);
  // Contrast: without the attributes file the same merge conflicts.
  const conflict = mergeAppends({ keepAttributes: false });
  assert.notEqual(conflict.code, 0, conflict.out);
  assert.equal(conflict.unmerged, '.harness/runs/eval.metrics.jsonl', conflict.out);
});

test('F188 AC-4 SPEC section 4 names .harness/.gitattributes and merge=union', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const start = spec.indexOf('## 4. ');
  const end = spec.indexOf('\n## 5. ', start);
  assert.ok(start >= 0 && end > start);
  const s4 = spec.slice(start, end);
  assert.ok(s4.includes('.gitattributes'));
  assert.ok(s4.includes('merge=union'));
  assert.ok(s4.includes('runs/*.jsonl') && s4.includes('deployments.jsonl merge=union'));
});

test('F188 ES-1 an unwritable .gitattributes is a warning; the other files are created', () => {
  const d = realTmpdir('harness-f188-');
  fs.mkdirSync(path.join(d, '.harness', '.gitattributes'), { recursive: true });
  const r = harness(['init'], { cwd: d });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /harness: warning: .*\.gitattributes/);
  for (const f of [...STATE, '.gitignore']) assert.ok(fs.statSync(path.join(d, '.harness', f)).isFile(), f);
  assert.ok(!lines(r).includes('created .harness/.gitattributes'));
  // Contrast: a writable path gives no such warning.
  const ok = harness(['init'], { cwd: realTmpdir('harness-f188-') });
  assert.doesNotMatch(ok.stderr, /\.gitattributes/);
});
