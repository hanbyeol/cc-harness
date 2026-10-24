// F151: once a feature has passed `harness eval` (a `fix`: once its verify passes) the agent merges
// it into the base branch and pushes, with no pull request. Merging or pushing to a protected branch
// before that, and force-pushing it, stay prohibited; the core's SR-5 (harness run never merges into
// a protected branch) is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { blockStatus, renderBlock } from '../lib/claudemd.mjs';
import { assertIntegrationAllowed } from '../lib/run.mjs';

const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

// The body of a "## heading" section, up to the next "## " heading.
function section(text, heading) {
  const at = text.indexOf(`\n${heading}\n`);
  assert.notEqual(at, -1, `no section ${heading}`);
  const rest = text.slice(at + heading.length + 2);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

const BLOCKS = () => [renderBlock(), renderBlock({ profile: 'iac' }), renderBlock({ profile: 'ops', language: 'ko' })];

test('F151 AC-1 the stop-and-ask list no longer names merging or pushing to a protected branch', () => {
  for (const block of BLOCKS()) {
    const stop = section(block, '## When to keep going and when to stop').split('\n').find((l) => l.startsWith('- Stop and ask only'));
    assert.ok(stop, block);
    assert.doesNotMatch(stop, /merging or pushing to a protected branch/);
    assert.match(stop, /force-pushing/);
  }
});

test('F151 AC-2 the workflow says to merge and push a passed feature, with no pull request', () => {
  for (const block of BLOCKS()) {
    const wf = section(block, '## Workflow — cc-harness v2');
    assert.match(wf, /`harness eval`[^\n]*passed[^\n]*\n?[^\n]*merge[^\n]*push/i, wf);
    assert.match(wf, /no pull request/);
    assert.doesNotMatch(block, /a human always decides/);
  }
});

test('F151 AC-3 AGENTS.md: no human-only merge rule; prohibits merging before the verdict and force-pushing; merge directly after', () => {
  const agents = read('AGENTS.md');
  assert.doesNotMatch(agents, /Merging to main is always\s+a human decision/);
  const never = section(agents, '## Never do these');
  assert.match(never, /protected branch[^]*before[^]*`harness eval`/);
  assert.match(never, /[Ff]orce-push/);
  assert.match(agents, /no pull request/);
});

test('F151 AC-4 build and fix skills: merge and push directly once passed, never force-push', () => {
  const build = read('skills/build/SKILL.md');
  assert.doesNotMatch(build, /the user merges/);
  const report = section(build, '## 5. Report');
  assert.match(report, /merge[^]*base branch[^]*push/i);
  assert.match(report, /no pull request/);

  const fix = read('skills/fix/SKILL.md');
  assert.doesNotMatch(fix, /Do not push to or merge into a protected branch\./);
  const bounds = section(fix, '## Boundaries');
  assert.match(bounds, /commit and push/i);
  assert.match(bounds, /no pull request/);
  assert.match(bounds, /force-push/i);
});

test('F151 AC-5 README and SPEC describe the agent merging after the verdict', () => {
  const readme = read('README.md');
  assert.doesNotMatch(readme, /main 병합은 사람이 결정합니다/);
  assert.match(readme, /PR 없이/);
  const spec = read('docs/SPEC.md');
  const blockLine = spec.split('\n').find((l) => l.includes('`templates/claude-block.md` 에서만 읽는다'));
  assert.ok(blockLine, 'SPEC block description');
  // the stop-and-ask list: from "멈춰 묻는다" to its "(`Stop and ask only" label
  const stopList = blockLine.slice(blockLine.indexOf('멈춰 묻는다'), blockLine.indexOf('(`Stop and ask only'));
  assert.ok(stopList.length > 0, 'SPEC stop list');
  assert.doesNotMatch(stopList, /보호 브랜치/);
  assert.match(blockLine, /PR 없이/);
});

test('F151 AC-6 the repository CLAUDE.md block matches the template', () => {
  const s = blockStatus(REPO);
  assert.equal(s.state, 'current', s.reason);
  // current against the new template, i.e. the repository's own block carries the rule
  assert.match(read('CLAUDE.md'), /no pull request/);
});

test('F151 SC-1 Prohibited still forbids merging before the verdict and force-pushing protected branches', () => {
  for (const block of BLOCKS()) {
    const prohibited = section(block, '## Prohibited');
    // the list item that names protected_branches, with its indented continuation lines
    const lines = prohibited.split('\n');
    const at = lines.findIndex((l) => l.includes('protected_branches'));
    assert.notEqual(at, -1, prohibited);
    let end = at + 1;
    while (end < lines.length && lines[end].startsWith('  ')) end++;
    const line = lines.slice(at, end).join(' ');
    assert.match(line, /before[^]*`harness eval`/);
    assert.match(line, /verify/);
    assert.match(line, /[Ff]orce-push/);
  }
});

test('F151 SC-2 the core still refuses a protected integration branch and SPEC keeps SR-5', async () => {
  await assert.rejects(
    assertIntegrationAllowed({ integration_branch: 'main', base_branch: 'main', protected_branches: ['main'] }, REPO),
    (e) => e.code === 'protected_branch',
  );
  assert.match(read('docs/SPEC.md'), /SR-5 코어는 `main`\(및 config의 protected 브랜치\)에 병합·push하지 않는다/);
});
