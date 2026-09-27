// F52: test/stress.mjs stderr on an abnormal exit (AC-2), lint-contract rule 3's absolute-path
// false positive (AC-3), and the SPEC §8 post-merge-verify-recovery-conflict explanation (AC-4).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpdir } from './helpers.mjs';
import { writeFiles } from './gitfixture.mjs';
import { FORBIDDEN_PATTERNS, matchedForbidden } from '../lib/contract.mjs';

// ------------------------------------------------------------------ AC-2

const STRESS = path.join(REPO, 'test', 'stress.mjs');
const HEAD = "import test from 'node:test';\n";

function stressWithChildCrash(preloadSrc) {
  const dir = fs.realpathSync(tmpdir('harness-f52-ac2-'));
  const preload = path.join(dir, 'crash-preload.cjs');
  writeFiles(dir, {
    'test/ok.test.mjs': `${HEAD}test('fake passing test', () => {});\n`,
    'crash-preload.cjs': preloadSrc,
  });
  const r = spawnSync(process.execPath, [STRESS, '1', '--root', dir], {
    encoding: 'utf8',
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, STRESS_TEST_CHILD_NODE_OPTIONS: `--require ${preload}` },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('F52 AC-2: a run that exits abnormally with no failing test prints its stderr tail', () => {
  const r = stressWithChildCrash("process.stderr.write('FATAL_MARKER_crash diagnostic\\n'); process.exit(7);\n");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /exited 7 without a failing test/);
  assert.match(r.out, /FATAL_MARKER_crash diagnostic/);
});

test('F52 AC-2: only the last 2000 chars of stderr are printed', () => {
  const body = `MUST_NOT_APPEAR${'x'.repeat(3000)}MUST_APPEAR_AT_END`;
  const r = stressWithChildCrash(`process.stderr.write(${JSON.stringify(body)}); process.exit(3);\n`);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /MUST_APPEAR_AT_END/);
  assert.ok(!r.out.includes('MUST_NOT_APPEAR'), r.out);
});

test('F52 AC-2: a normal failing test prints no stderr-tail section', () => {
  const dir = fs.realpathSync(tmpdir('harness-f52-ac2-'));
  writeFiles(dir, { 'test/bad.test.mjs': `${HEAD}test('fake failing test', () => { throw new Error('boom'); });\n` });
  const r = spawnSync(process.execPath, [STRESS, '1', '--root', dir], { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(!/--- stderr/.test(r.stdout), r.stdout);
});

// ------------------------------------------------------------------ AC-3

test('F52 AC-3: "절대 경로" (with or without a space) is not a universal-negation error', () => {
  for (const s of ['이 값은 절대 경로가 아니다', '이 값은 절대경로가 아니다', '항상 절대 경로로 변환한다']) {
    assert.deepEqual(matchedForbidden(s), [], s);
  }
});

const UNIVERSAL_NEGATION_EXAMPLES = [
  ['ac3-1', '이 값은 절대 변경되지 않는다'],
  ['ac3-2', '우회할 방법이 절대 없다'],
  ['ac3-3', '절대로 실패하지 않는다'],
  ['ac3-4', '사용자는 절대 접근할 수 없다'],
  ['ac3-5', '이 키는 절대 노출되지 않는다'],
];

for (const [tag, sentence] of UNIVERSAL_NEGATION_EXAMPLES) {
  test(`F52 AC-3 ${tag}: "${sentence}" is still a universal-negation error`, () => {
    assert.deepEqual(matchedForbidden(sentence), ['절대'], sentence);
  });
}

test('F52 AC-3: the "절대" pattern is unchanged in shape (still 8 forbidden patterns)', () => {
  assert.equal(FORBIDDEN_PATTERNS.length, 8);
});

// ------------------------------------------------------------------ AC-4

test('F52 AC-4: SPEC §8 explains that a merge conflict during post-merge-verify recovery is blocked(post_merge_verify) with "cannot merge" in detail', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const start = spec.indexOf('## 8.');
  const end = spec.indexOf('## 9.');
  const section = spec.slice(start, end === -1 ? undefined : end);
  const line = section.split('\n').find((l) => l.includes('cannot merge') && l.includes('post_merge_verify'));
  assert.ok(line, 'no line in §8 ties a recovery-merge conflict to blocked(post_merge_verify) with "cannot merge"');
});
