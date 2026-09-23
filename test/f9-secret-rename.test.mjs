// F9: secret files that were renamed, moved outside git, renamed with an edit, or
// copied under another name stay out of the evaluator diff (SR-4 extension).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { buildDiff } from '../lib/eval.mjs';

const SECRET_GLOBS = ['creds/**', '*.secret'];
const diff = (dir) => buildDiff({ cwd: dir, base: 'main', secretGlobs: SECRET_GLOBS, timeoutSec: 60 });

// Ten lines so a one-line edit stays well above git's 50% rename similarity.
const ENV_BODY = Array.from({ length: 10 }, (_, i) => `KEY_${i}=F9_SECRET_VALUE_${i}`).join('\n') + '\n';

function assertNoLeak(d, marker, label = marker) {
  assert.equal(d.text.includes(marker), false, `${label} leaked into the diff`);
}

// ---------- AC-1 ----------
test('F9 AC-1 git mv of a base secret (.env → notes.txt) committed: content absent, destination excluded', async () => {
  const dir = gitRepo({ '.env': ENV_BODY, 'src/a.mjs': 'export const a = 1;\n' });
  git(dir, 'mv', '.env', 'notes.txt');
  commitAll(dir, 'rename secret');
  const d = await diff(dir);
  assertNoLeak(d, 'F9_SECRET_VALUE');
  assert.equal(d.files.includes('notes.txt'), false, 'notes.txt must not be in files');
  assert.equal(d.text.includes('notes.txt'), false);
  assert.ok(d.excluded >= 2, `excluded should count .env and notes.txt, got ${d.excluded}`);
});

test('F9 AC-1 staged but uncommitted git mv is excluded too', async () => {
  const dir = gitRepo({ '.env': ENV_BODY });
  git(dir, 'mv', '.env', 'notes.txt');
  const d = await diff(dir);
  assertNoLeak(d, 'F9_SECRET_VALUE');
  assert.equal(d.files.includes('notes.txt'), false);
});

// ---------- AC-2 ----------
test('F9 AC-2 moved outside git (tracked .env deleted, same content untracked as notes.txt): content absent', async () => {
  const dir = gitRepo({ '.env': ENV_BODY, 'src/a.mjs': 'export const a = 1;\n' });
  fs.renameSync(path.join(dir, '.env'), path.join(dir, 'notes.txt'));
  const d = await diff(dir);
  assertNoLeak(d, 'F9_SECRET_VALUE');
  assert.equal(d.files.includes('notes.txt'), false);
  assert.ok(d.excluded >= 2, `excluded should count .env and notes.txt, got ${d.excluded}`);
});

// ---------- AC-3 ----------
test('F9 AC-3 rename with a one-line edit (similarity >= 50%) committed: original secret lines absent', async () => {
  const dir = gitRepo({ '.env': ENV_BODY });
  git(dir, 'mv', '.env', 'config.txt');
  fs.writeFileSync(path.join(dir, 'config.txt'), ENV_BODY.replace('KEY_0=F9_SECRET_VALUE_0', 'KEY_0=CHANGED'));
  commitAll(dir, 'rename with edit');
  const d = await diff(dir);
  for (let i = 1; i < 10; i += 1) assertNoLeak(d, `F9_SECRET_VALUE_${i}`);
  assert.equal(d.files.includes('config.txt'), false);
});

test('F9 AC-3 rename with a one-line edit left in the working tree is excluded too', async () => {
  const dir = gitRepo({ '.env': ENV_BODY });
  git(dir, 'mv', '.env', 'config.txt');
  fs.writeFileSync(path.join(dir, 'config.txt'), ENV_BODY.replace('KEY_9=F9_SECRET_VALUE_9', 'KEY_9=CHANGED'));
  const d = await diff(dir);
  for (let i = 0; i < 9; i += 1) assertNoLeak(d, `F9_SECRET_VALUE_${i}`);
});

// ---------- AC-4 ----------
test('F9 AC-4 a non-secret rename (src/a.mjs → src/b.mjs) and new files stay in the diff', async () => {
  const dir = gitRepo({ '.env': ENV_BODY, 'src/a.mjs': 'export const A_LINE_7 = 7;\n' });
  git(dir, 'mv', 'src/a.mjs', 'src/b.mjs');
  writeFiles(dir, { 'src/new.mjs': 'export const NEW_COMMITTED = 1;\n' });
  commitAll(dir, 'rename ordinary file');
  writeFiles(dir, { 'src/untracked.mjs': 'export const NEW_UNTRACKED = 1;\n' });
  const d = await diff(dir);
  assert.match(d.text, /A_LINE_7/);
  assert.match(d.text, /NEW_COMMITTED/);
  assert.match(d.text, /NEW_UNTRACKED/);
  for (const f of ['src/a.mjs', 'src/b.mjs', 'src/new.mjs', 'src/untracked.mjs']) assert.ok(d.files.includes(f), `${f} missing from files`);
  assert.equal(d.excluded, 0);
});

// ---------- SC-1 ----------
test('F9 SC-1 each default pattern (.env, id_rsa, server.pem, cert.p12) and a secret_glob path, renamed: content absent', async () => {
  const secrets = {
    '.env': 'SC1_ENV_CONTENT\n',
    '.ssh/id_rsa': 'SC1_IDRSA_CONTENT\n',
    'server.pem': 'SC1_PEM_CONTENT\n',
    'cert.p12': 'SC1_P12_CONTENT\n',
    'creds/db.json': '{"password":"SC1_GLOB_CONTENT"}\n',
  };
  for (const [secretPath, content] of Object.entries(secrets)) {
    const dir = gitRepo({ [secretPath]: content, 'src/a.mjs': 'export const a = 1;\n' });
    git(dir, 'mv', secretPath, 'innocuous.txt');
    commitAll(dir, `rename ${secretPath}`);
    const d = await diff(dir);
    const marker = content.match(/SC1_[A-Z0-9]+_CONTENT/)[0];
    assertNoLeak(d, marker, `${secretPath} content`);
    assert.equal(d.files.includes('innocuous.txt'), false, `${secretPath}: innocuous.txt in files`);
  }
});

// ---------- SC-2 ----------
test('F9 SC-2 copy of a secret under another name, untracked (original kept): copy content absent', async () => {
  const dir = gitRepo({ '.env': ENV_BODY });
  fs.copyFileSync(path.join(dir, '.env'), path.join(dir, 'backup.txt'));
  const d = await diff(dir);
  assertNoLeak(d, 'F9_SECRET_VALUE');
  assert.equal(d.files.includes('backup.txt'), false);
  assert.equal(d.excluded, 1);
});

test('F9 SC-2 copy of a secret under another name, committed (original kept): copy content absent', async () => {
  const dir = gitRepo({ '.env': ENV_BODY });
  fs.copyFileSync(path.join(dir, '.env'), path.join(dir, 'backup.txt'));
  commitAll(dir, 'copy secret');
  const d = await diff(dir);
  assertNoLeak(d, 'F9_SECRET_VALUE');
  assert.equal(d.files.includes('backup.txt'), false);
});

test('F9 SC-2 copy of a secret added on the feature branch (not in base) is excluded too', async () => {
  const dir = gitRepo({ 'src/a.mjs': 'export const a = 1;\n' });
  writeFiles(dir, { 'deploy.key': 'SC2_BRANCH_KEY\n' });
  fs.copyFileSync(path.join(dir, 'deploy.key'), path.join(dir, 'copy.txt'));
  const d = await diff(dir);
  assertNoLeak(d, 'SC2_BRANCH_KEY');
  assert.equal(d.files.includes('copy.txt'), false);
});

// ---------- ES-1 ----------
test('F9 ES-1 an empty base secret does not trigger content matching: a new empty file stays in files', async () => {
  const dir = gitRepo({ '.env': '', 'src/a.mjs': 'export const a = 1;\n' });
  writeFiles(dir, { 'empty-committed.txt': '' });
  commitAll(dir, 'empty committed');
  writeFiles(dir, { 'empty.txt': '' });
  const d = await diff(dir);
  assert.ok(d.files.includes('empty.txt'), 'empty.txt must stay in files');
  assert.ok(d.files.includes('empty-committed.txt'), 'empty-committed.txt must stay in files');
  assert.equal(d.excluded, 0);
});

// Round 2: past git's default diff.renameLimit (1000 paths) rename detection is skipped
// silently unless the core lifts the limit.
test('F9 AC-3 large diff: a renamed-and-edited secret is excluded beyond diff.renameLimit', async () => {
  const N = 1000;
  const files = { '.env': 'KEY_0=F9_BIG_SECRET_0\nKEY_1=F9_BIG_SECRET_1\n' };
  for (let i = 0; i < N; i++) files[`old/${i}.txt`] = `unique base content ${i} padding padding\n`;
  const dir = gitRepo(files);
  fs.rmSync(path.join(dir, 'old'), { recursive: true });
  const added = {};
  for (let i = 0; i < N; i++) added[`new/${i}.txt`] = `unique new content ${i} padding padding\n`;
  writeFiles(dir, added);
  git(dir, 'mv', '.env', 'config.txt');
  fs.writeFileSync(path.join(dir, 'config.txt'), 'KEY_0=CHANGED\nKEY_1=F9_BIG_SECRET_1\n');
  commitAll(dir, 'churn + secret rename with edit');
  const d = await buildDiff({ cwd: dir, base: 'main' });
  assert.equal(d.text.includes('F9_BIG_SECRET'), false);
  assert.equal(d.files.includes('config.txt'), false);
});
