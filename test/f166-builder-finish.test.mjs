// F166: the builder works through ordinary obstacles instead of stopping, follows a criterion's
// `check` when its wording is ambiguous, and its final report lists only what a deliberate limit
// or a contract problem stopped (Fable 5.2 prompting guide, "Finish the whole task").
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { REPO } from './helpers.mjs';
import { loadRolePrompt } from '../lib/roles.mjs';
import { builderPrompt } from '../lib/run/prompt.mjs';

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');
// Whitespace-insensitive text: the prompts wrap lines at different columns.
const flat = (s) => s.replace(/\s+/g, ' ').trim();

// The text of one `## ` section: from its heading up to the next `## ` heading (or the end).
function section(text, heading) {
  const marker = `\n${heading}\n`;
  const at = `\n${text}`.indexOf(marker);
  assert.notEqual(at, -1, `missing section ${heading}`);
  const rest = `\n${text}`.slice(at + 1);
  const next = rest.indexOf('\n## ', heading.length);
  return next === -1 ? rest : rest.slice(0, next);
}

const BUILDER = 'agents/builder.md';
const FINISHING = '## Finishing the work';
const WRONG = '## When the contract is wrong';
const OLD_WRONG = 'If a criterion is ambiguous, contradicts another, or cannot be met';

// ---------- AC-1 ----------
test('F166 AC-1 builder.md has one Finishing the work section between Boundaries and When the contract is wrong', () => {
  const text = read(BUILDER);
  assert.equal(text.split(`\n${FINISHING}\n`).length, 2, 'exactly one section');
  const fin = text.indexOf(`\n${FINISHING}\n`);
  const bounds = text.indexOf('\n## Boundaries\n');
  const wrong = text.indexOf(`\n${WRONG}\n`);
  assert.ok(bounds !== -1 && wrong !== -1, 'both neighbours exist');
  assert.ok(bounds < fin && fin < wrong, 'after Boundaries, before When the contract is wrong');
});

// ---------- AC-2 ----------
test('F166 AC-2 ordinary obstacles are diagnosed and worked through', () => {
  const s = flat(section(read(BUILDER), FINISHING));
  for (const word of ['failing test', 'flaky', 'error', 'timeout', 'locked file', 'empty result']) {
    assert.ok(s.includes(word), `names '${word}': ${s}`);
  }
  assert.ok(/not a reason to stop/.test(s), s);
  assert.ok(/[Dd]iagnose/.test(s), s);
  assert.ok(s.includes('wait and retry'), s);
  assert.ok(s.includes('use another tool'), s);
});

// ---------- AC-3 ----------
test('F166 AC-3 deliberate limits are named, left alone, reported, and the rest is finished', () => {
  const s = flat(section(read(BUILDER), FINISHING));
  for (const word of ['`.harness/`', '`out_of_scope`', 'protected branch']) {
    assert.ok(s.includes(word), `names ${word}: ${s}`);
  }
  assert.ok(s.includes('Leave them alone'), s);
  assert.ok(s.includes('finish the rest'), s);
});

// ---------- AC-4 ----------
test('F166 AC-4 an ambiguous criterion follows its check; stop only on three conditions', () => {
  const text = read(BUILDER);
  assert.ok(!flat(text).includes(OLD_WRONG), 'old sentence removed');
  const s = flat(section(text, WRONG));
  assert.ok(s.includes('follow the `check` and keep working'), s);
  assert.ok(/two criteria contradict each other/.test(s), s);
  assert.ok(/a `check` cannot run/.test(s), s);
  assert.ok(/cannot be met without work that `out_of_scope` excludes/.test(s), s);
  assert.ok(/criterion id/.test(s) && /command output/.test(s), s);
});

// ---------- AC-5 ----------
test('F166 AC-5 Finish lists only what a deliberate limit or contract problem stopped', () => {
  const s = flat(section(read(BUILDER), '## Finish'));
  assert.ok(!s.includes('anything you could not do'), s);
  assert.ok(/deliberate limit/.test(s) && /contract problem/.test(s), s);
  assert.ok(/its reason/.test(s), s);
  assert.ok(/work through ordinary obstacles instead of listing them/.test(s), s);
  assert.ok(s.includes('Under `harness run` the core runs the verify commands, so do not report their results'), s);
});

// ---------- AC-6 ----------
test('F166 AC-6 the headless builder prompt carries the new sections', () => {
  const role = loadRolePrompt('builder');
  const prompt = builderPrompt({
    rolePrompt: role, featureId: 'F1', round: 1, attempt: 1,
    contract: { id: 'F1', acceptance_criteria: [] }, config: { verify: { commands: [] } },
  });
  for (const text of [role, prompt]) {
    assert.ok(text.includes(`\n${FINISHING}\n`), 'Finishing section');
    assert.ok(flat(text).includes('follow the `check` and keep working'), 'new contract rule');
    assert.ok(!flat(text).includes(OLD_WRONG), 'no old sentence');
  }
});

// ---------- AC-7 ----------
test('F166 AC-7 the build skill follows the same rule', () => {
  const s = flat(read('skills/build/SKILL.md'));
  assert.ok(!s.includes('If a criterion is ambiguous or impossible, stop'), 'old sentence removed');
  assert.ok(s.includes('follow the `check` and keep going'), s);
  assert.ok(/two criteria contradict each other/.test(s), 'contradiction');
  assert.ok(/a `check` cannot run/.test(s), 'cannot run');
  assert.ok(/cannot be met without work that `out_of_scope` excludes/.test(s), 'out of scope');
  assert.ok(/ordinary obstacle/.test(s) && /instead of stopping/.test(s), 'ordinary obstacles');
});

// ---------- AC-8 ----------
test('F166 AC-8 the SPEC describes the builder finish and stop rules', () => {
  const lines = read('docs/SPEC.md').split('\n').filter((l) => l.includes('F166'));
  assert.ok(lines.length > 0, 'SPEC mentions F166');
  const s = lines.join(' ');
  assert.ok(s.includes('평범한 장애물'), s);
  assert.ok(s.includes('의도된 한계'), s);
  assert.ok(s.includes('check'), s);
});

// ---------- ES-1 ----------
// The section is compared by its SHA-256 (taken from the section before F166), not by its text:
// it lists skip markers as examples, and verify rejects skip markers on added lines.
const BOUNDARIES_SHA256 = 'cfe9301b97d66aa1481c83817a69d4867601daa6e842403a807b688c1aa517d4';

test('F166 ES-1 the Boundaries section is unchanged', () => {
  const text = section(read(BUILDER), '## Boundaries').replace(/\n+$/, '\n');
  assert.ok(text.startsWith('## Boundaries\nThese keep the process convergent'), text);
  assert.equal(createHash('sha256').update(text).digest('hex'), BOUNDARIES_SHA256, text);
});
