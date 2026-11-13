// F169: the builder reuses a helper that already exists instead of writing a copy, without
// widening the feature; no code ownership sentence is added (the decision is in the SPEC).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { loadRolePrompt } from '../lib/roles.mjs';
import { builderPrompt } from '../lib/run/prompt.mjs';

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');
const flat = (s) => s.replace(/\s+/g, ' ').trim();

const REUSE = 'Before you add a helper, look for one that already does the job in the code you touch and reuse it instead of writing a copy.';
const NO_WIDEN = 'Reuse is not a reason to restructure code the contract does not ask for.';

// Step 3 of '## How to work': from '3. ' up to the next numbered step.
function step3() {
  const text = read('agents/builder.md');
  const at = text.indexOf('\n## How to work\n');
  assert.notEqual(at, -1, 'How to work section');
  const section = text.slice(at, text.indexOf('\n## ', at + 1));
  const s = section.indexOf('\n3. ');
  const e = section.indexOf('\n4. ', s);
  assert.ok(s !== -1 && e !== -1, 'steps 3 and 4');
  return flat(section.slice(s, e));
}

// ---------- AC-1 ----------
test('F169 AC-1 step 3 of How to work tells the builder to reuse an existing helper', () => {
  assert.ok(step3().includes(REUSE), step3());
});

// ---------- AC-2 ----------
test('F169 AC-2 step 3 says reuse does not widen the feature', () => {
  assert.ok(step3().includes(NO_WIDEN), step3());
});

// ---------- AC-3 ----------
test('F169 AC-3 the headless builder prompt carries both sentences', () => {
  const role = loadRolePrompt('builder');
  const prompt = builderPrompt({
    rolePrompt: role, featureId: 'F1', round: 1, attempt: 1,
    contract: { id: 'F1', acceptance_criteria: [] }, config: { verify: { commands: [] } },
  });
  for (const text of [role, prompt]) {
    assert.ok(flat(text).includes(REUSE), 'reuse sentence');
    assert.ok(flat(text).includes(NO_WIDEN), 'no-widen sentence');
  }
});

// ---------- AC-4 ----------
test('F169 AC-4 no code ownership sentence in the builder prompt or the build skill', () => {
  for (const rel of ['agents/builder.md', 'skills/build/SKILL.md']) {
    const text = read(rel);
    assert.ok(!/owner/i.test(text), `${rel} says owner`);
    assert.ok(!/maintainer/i.test(text), `${rel} says maintainer`);
  }
});

// ---------- AC-5 ----------
test('F169 AC-5 the SPEC records the decision, its reasons and the reuse sentence as the alternative', () => {
  const lines = read('docs/SPEC.md').split('\n').filter((l) => l.includes('F169'));
  assert.ok(lines.length > 0, 'SPEC mentions F169');
  const s = lines.join(' ');
  for (const word of ['소유권', 'out_of_scope', '토큰']) assert.ok(s.includes(word), `names ${word}: ${s}`);
  assert.ok(/범위[^ ]* 제한/.test(s) || s.includes('범위 제한'), 'a scope rule does not cancel it');
  assert.ok(s.includes('reuse') || s.includes('재사용'), 'the reuse sentence is the alternative');
});
