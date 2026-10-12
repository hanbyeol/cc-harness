// F121: the security_tier criteria are written the same way in the spec skill, AGENTS.md and the SPEC.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\s+/g, ' ');

const CRITICAL = [
  'authentication', 'authorization', 'secret handling', 'payments', 'data deletion',
  'running commands that come from a model or user input',
  'merging or switching branches', 'writing outside the repository',
];
const STANDARD = [
  'redacting log or report text', 'validating configuration', 'wording of messages', 'documentation',
];

test('F121 AC-1 skills/spec/SKILL.md lists the critical and standard tier examples', () => {
  const t = read('skills/spec/SKILL.md');
  for (const p of [...CRITICAL, ...STANDARD]) assert.ok(t.includes(p), `missing: ${p}`);
});

test('F121 AC-2 AGENTS.md workflow step 1 states the criteria and points to the spec skill', () => {
  const t = fs.readFileSync(path.join(REPO, 'AGENTS.md'), 'utf8');
  const m = /^1\. \*\*Contract\*\*[\s\S]*?(?=^2\. )/m.exec(t);
  assert.ok(m, 'step 1 not found');
  const step = m[0].replace(/\s+/g, ' ');
  for (const p of CRITICAL) assert.ok(step.includes(p), `missing: ${p}`);
  assert.ok(step.includes('skills/spec/SKILL.md'));
});

test('F121 AC-3 docs/SPEC.md §5 defines security_tier with the same list', () => {
  const full = fs.readFileSync(path.join(REPO, 'docs/SPEC.md'), 'utf8');
  const m = /^## 5\.[\s\S]*?(?=^## 6\.)/m.exec(full);
  assert.ok(m, '§5 not found');
  const t = m[0].replace(/\s+/g, ' ');
  for (const p of [...CRITICAL, ...STANDARD]) assert.ok(t.includes(p), `missing: ${p}`);
});
