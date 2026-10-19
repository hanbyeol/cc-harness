import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, realTmpdir } from './helpers.mjs';
import { recordEntries } from '../lib/backlog.mjs';
import * as run from '../lib/run.mjs';
import * as merge from '../lib/run/merge.mjs';

const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const at = '2026-10-19T00:00:00.000Z';

function record(items, entries) {
  const dir = realTmpdir('f149-');
  const file = path.join(dir, 'backlog.json');
  fs.writeFileSync(file, JSON.stringify({ items }));
  recordEntries(file, entries, { feature: 'F9', round: 2, at });
  return JSON.parse(fs.readFileSync(file, 'utf8')).items;
}

test('F149 AC-1 recordEntries does not merge by backlog_id', () => {
  const items = record([{ id: 'B1', summary: 'x', seen: 1, sources: ['F1-r1'] }], [{ summary: 'again', backlog_id: 'B1' }]);
  assert.equal(items.length, 2);
  assert.equal(items[0].seen, 1);
  assert.deepEqual(items[0].sources, ['F1-r1']);
  assert.equal('backlog_id' in items[1], false);
  assert.ok(!read('lib/backlog.mjs').includes('backlog_id'));
});

test('F149 AC-2a summary comment sits on verifyFailureSummary', () => {
  const src = read('lib/run/feature.mjs');
  const head = src.slice(0, src.indexOf('import '));
  assert.ok(!head.includes('Compact, prompt-sized summary'));
  const lines = src.split('\n');
  const i = lines.findIndex((l) => l.startsWith('export function verifyFailureSummary'));
  assert.ok(lines[i - 1].startsWith('//') && lines[i - 1].includes('Compact, prompt-sized summary'));
});

test('F149 AC-2b cleanup comment sits on cleanIntegration', () => {
  const src = read('lib/run/merge.mjs');
  const head = src.slice(0, src.indexOf('import '));
  assert.ok(!head.includes('git reset --hard') && !head.includes('Returns null when the worktree is clean'));
  const lines = src.split('\n');
  let i = lines.findIndex((l) => l.startsWith('export async function cleanIntegration')) - 1;
  const block = [];
  while (i >= 0 && lines[i].startsWith('//')) block.unshift(lines[i--]);
  const text = block.join('\n');
  assert.ok(text.includes('git reset --hard') && text.includes('Returns null when the worktree is clean'));
});

test('F149 AC-2c preflight has no separator line before the first import', () => {
  const src = read('lib/run/preflight.mjs');
  assert.ok(!src.slice(0, src.indexOf('import ')).includes('// ----'));
});

test('F149 AC-3 conflict marker helpers live in merge.mjs', () => {
  assert.match(read('lib/run/merge.mjs'), /export function hasConflictMarkers/);
  assert.match(read('lib/run/merge.mjs'), /export function conflictMarkedFiles/);
  const prompt = read('lib/run/prompt.mjs');
  assert.ok(!prompt.includes('hasConflictMarkers') && !prompt.includes('conflictMarkedFiles'));
  assert.equal(run.hasConflictMarkers, merge.hasConflictMarkers);
  assert.equal(run.conflictMarkedFiles, merge.conflictMarkedFiles);
});

test('F149 AC-4 prompt.mjs ends with a single newline', () => {
  const s = read('lib/run/prompt.mjs');
  assert.ok(s.endsWith('\n') && !s.endsWith('\n\n'));
});

test('F149 AC-5a PROMPT_LIMIT constants are gone from backlog.mjs', () => {
  const s = read('lib/backlog.mjs');
  assert.ok(!s.includes('PROMPT_LIMIT') && !s.includes('PROMPT_SUMMARY_CHARS'));
});

test('F149 AC-5b eval.mjs lost the stale backlog_id comments', () => {
  const s = read('lib/eval.mjs');
  assert.ok(!s.includes('backlog_id is resolved when the backlog is written'));
  assert.ok(!s.includes('criterion_id and backlog_id are not among them'));
});

test('F149 AC-5c SPEC wording', () => {
  const s = read('docs/SPEC.md');
  for (const bad of ['out_of_scope 항목마다', '`out_of_scope`(backlog)']) assert.ok(!s.includes(bad), bad);
  for (const good of ['**지적**: findings 항목마다', '적대적 시나리오로 분류해 backlog 로 보낸다']) assert.ok(s.includes(good), good);
});

test('F149 ES-1 a non-string or unknown backlog_id is a new item without the key', () => {
  const items = record([{ id: 'B1', summary: 'x', seen: 1 }], [{ summary: 'a', backlog_id: 1 }, { summary: 'b', backlog_id: 'B99' }]);
  assert.equal(items.length, 3);
  for (const i of items.slice(1)) assert.equal('backlog_id' in i, false);
  // No branch reads the key at all, so no value of it can reach the merge path.
  assert.ok(!read('lib/backlog.mjs').includes('backlog_id'));
});

// The parent criteria AC-2 and AC-5 run their cases together.
test('F149 AC-2 all comment placements', () => {
  const src = (f) => read(f);
  const f = src('lib/run/feature.mjs');
  assert.ok(!f.slice(0, f.indexOf('import ')).includes('Compact, prompt-sized summary'));
  const m = src('lib/run/merge.mjs');
  assert.ok(!m.slice(0, m.indexOf('import ')).includes('git reset --hard'));
  assert.ok(!src('lib/run/preflight.mjs').slice(0, src('lib/run/preflight.mjs').indexOf('import ')).includes('// ----'));
});

test('F149 AC-5 earlier cleanups stay', () => {
  assert.ok(!read('lib/backlog.mjs').includes('PROMPT_LIMIT'));
  assert.ok(!read('lib/eval.mjs').includes('backlog_id is resolved when the backlog is written'));
  assert.ok(read('docs/SPEC.md').includes('**지적**: findings 항목마다'));
});
