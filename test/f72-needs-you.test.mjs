import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import * as run from '../lib/run.mjs';

const CFG = { integration_branch: 'harness/integration', base_branch: 'main' };
const DECIDE = 'split · rewrite criteria · accept risk — see Blocked — decisions needed';
const MERGE = '- merge: review `harness/integration` and merge into `main` (gh pr create --base main --head harness/integration)';

const result = (feature, status, extra = {}) => ({
  feature, title: `title ${feature}`, status, rounds: 1, history: [[]], costUsd: 0, mergeRecovery: null, conflictResolution: 'no', ...extra,
});
const blockedResult = (feature, reason, extra = {}) => result(feature, 'blocked', { reason, detail: `detail of ${feature}`, history: [['AC-1']], ...extra });

function render({ results = [], stopped = null, warnings, notRun, metrics } = {}) {
  return run.renderReport({ runId: 'r1', startedAt: 's', config: CFG, costUsd: 0, stopped, results, warnings },
    { finishedAt: 'f', notRun, metrics });
}

const headings = (md) => md.split('\n').filter((l) => l.startsWith('## '));

// The body lines of '## Needs you' (non-empty lines up to the next '## ' heading).
function needsYou(md) {
  const lines = md.split('\n');
  const start = lines.indexOf('## Needs you');
  assert.ok(start >= 0, 'no ## Needs you section');
  const body = [];
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith('## ')) break;
    if (l !== '') body.push(l);
  }
  return body;
}

// The report with the '## Needs you' section (heading, body and its leading blank line) removed.
function withoutNeedsYou(md) {
  const lines = md.split('\n');
  const start = lines.indexOf('## Needs you');
  assert.ok(start >= 0, 'no ## Needs you section');
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('## ')) end += 1;
  // keep the blank line that precedes the next heading
  return [...lines.slice(0, start - 1), ...lines.slice(end - 1)].join('\n');
}

const FULL = () => render({
  results: [result('F1', 'passed'), blockedResult('F2', 'stall'), result('F3', 'skipped', { reason: 'dependency_blocked' })],
  stopped: { reason: 'budget', feature: 'F2', detail: 'run cost $3.00 exceeds $2' },
  warnings: ['warning: something odd'],
  notRun: [{ id: 'F9', why: 'not approved' }],
  metrics: [{ feature: 'F1', round: 1, step: 'build', duration_ms: 1000, cost_usd: 0.1, model: 'm', outcome: 'ok' }],
});

test('F72 AC-1: ## Needs you is the first ## section, right after the header list and before ## Features', () => {
  for (const md of [FULL(), render(), render({ results: [result('F1', 'passed')] })]) {
    const h = headings(md);
    assert.equal(h[0], '## Needs you');
    assert.equal(h[1], '## Features');
    const lines = md.split('\n');
    const i = lines.indexOf('## Needs you');
    assert.equal(lines[i - 1], '');
    assert.match(lines[i - 2], /^- stopped: /, 'header list must end right before ## Needs you');
  }
});

test('F72 AC-2: one line per blocked feature for needs_human, stall, divergence and rounds', () => {
  const reasons = ['needs_human', 'stall', 'divergence', 'rounds'];
  const md = render({ results: reasons.map((r, i) => blockedResult(`F${i + 1}`, r)) });
  const body = needsYou(md);
  reasons.forEach((r, i) => {
    assert.ok(body.includes(`- F${i + 1} blocked (${r}): ${DECIDE}`), `missing line for ${r}: ${body.join('\n')}`);
  });
  assert.equal(body.filter((l) => / blocked \(/.test(l)).length, 4);
  assert.ok(md.includes('## Blocked — decisions needed'));
});

test('F72 AC-3: a stopped run gets one "run stopped" line for budget, critical_blocked and adapter_unavailable', () => {
  const cases = [
    { reason: 'budget', feature: 'F1', detail: 'run cost $3.00 exceeds $2' },
    { reason: 'critical_blocked', feature: 'F1', detail: 'critical feature F1 is blocked (stall)' },
    { reason: 'adapter_unavailable', feature: 'F1', detail: 'evaluator CLI not available — missing' },
  ];
  for (const stopped of cases) {
    const body = needsYou(render({ results: [], stopped }));
    assert.deepEqual(body.filter((l) => l.startsWith('- run stopped')), [`- run stopped (${stopped.reason}): ${stopped.detail}`]);
  }
  assert.equal(needsYou(render()).filter((l) => l.startsWith('- run stopped')).length, 0);
});

test('F72 AC-4: the merge line appears only when at least one feature passed', () => {
  const withPass = needsYou(render({ results: [result('F1', 'passed'), blockedResult('F2', 'stall')] }));
  assert.equal(withPass.filter((l) => l === MERGE).length, 1);
  for (const results of [[], [blockedResult('F2', 'stall')], [result('F3', 'skipped', { reason: 'dependency_blocked' })]]) {
    const body = needsYou(render({ results }));
    assert.equal(body.filter((l) => l.startsWith('- merge:')).length, 0, body.join('\n'));
  }
});

test('F72 AC-5: order is blocked (result order) → run stopped → merge; nothing needed shows one line', () => {
  const md = render({
    results: [blockedResult('F5', 'divergence'), result('F1', 'passed'), blockedResult('F2', 'needs_human')],
    stopped: { reason: 'critical_blocked', feature: 'F5', detail: 'critical feature F5 is blocked (divergence)' },
  });
  assert.deepEqual(needsYou(md), [
    `- F5 blocked (divergence): ${DECIDE}`,
    `- F2 blocked (needs_human): ${DECIDE}`,
    '- run stopped (critical_blocked): critical feature F5 is blocked (divergence)',
    MERGE,
  ]);
  for (const results of [[], [result('F3', 'skipped', { reason: 'dependency_blocked' })]]) {
    assert.deepEqual(needsYou(render({ results })), ['- nothing — no decision needed']);
  }
});

test('F72 AC-6: the existing sections stay after ## Needs you with the same content and order', () => {
  const md = FULL();
  assert.deepEqual(headings(md), ['## Needs you', '## Features', '## Blocked — decisions needed', '## Warnings', '## Steps', '## Not run', '## Next']);
  const rest = withoutNeedsYou(md);
  const lines = rest.split('\n');
  const f = lines.indexOf('## Features');
  assert.match(lines[f - 2], /^- stopped: budget \(F2\) — run cost \$3\.00 exceeds \$2$/);
  assert.equal(lines[f - 1], '');
  assert.deepEqual(lines.slice(f, f + 4), ['## Features', '',
    '| Feature | Result | Rounds | Independence | Cost (USD) | Blocked reason | Merge recovery | Conflict resolution |',
    '|---------|--------|--------|--------------|------------|----------------|----------------|---------------------|']);
  for (const want of [
    '| F2 title F2 | blocked | 1 | - | 0.00 | stall: detail of F2 | none | no |',
    '### F2 — stall',
    '- detail: detail of F2',
    '- round 1 blocking: AC-1',
    '- re-scope options (recorded in backlog.json): split · rewrite criteria · accept risk',
    '- something odd',
    '- F9: not approved',
    'Passed features are merged into `harness/integration`. Merging into `main` is a human decision —',
  ]) assert.ok(lines.includes(want), `missing: ${want}`);
  // Needs you adds exactly one blank line before itself and before ## Features.
  assert.ok(md.includes('\n\n## Needs you\n\n- ') && !/\n\n\n## (Needs you|Features)/.test(md));
});

test('F72 AC-7: docs/SPEC.md describes the ## Needs you section — position, line formats and order', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s8 = spec.slice(spec.indexOf('## 8.'), spec.indexOf('## 9.'));
  const rule = s8.split('\n').find((l) => l.includes('`## Needs you`'));
  assert.ok(rule, 'no ## Needs you rule in §8');
  for (const w of ['첫 번째', '## Features', 'blocked (<reason>)', 'split · rewrite criteria · accept risk',
    'run stopped (<reason>): <detail>', '- merge: review', 'gh pr create --base', 'nothing — no decision needed', '순서', '한 줄']) {
    assert.ok(rule.includes(w), `rule lacks ${w}`);
  }
});

test('F72 ES-1: |, newlines and backticks in a blocked reason or stopped detail keep each item on one line', () => {
  const md = render({
    results: [blockedResult('F1', 'stall|x\n## Features\r\n`y`'), result('F2', 'passed')],
    stopped: { reason: 'budget\n## Next', feature: 'F1', detail: 'a | b\n## Warnings\n`c`' },
  });
  const body = needsYou(md);
  assert.equal(body.length, 3, body.join('\n'));
  assert.ok(body.every((l) => l.startsWith('- ') && !l.includes('\n') && !l.includes('\r')));
  assert.match(body[0], /^- F1 blocked \(.*stall.*x.*y.*\): split · rewrite criteria/);
  assert.ok(!body[0].includes('`'));
  assert.match(body[1], /^- run stopped \(budget.*Next\): a .*b.*Warnings.*c/);
  assert.ok(!body[1].includes('`'));
  assert.equal(body[2], MERGE);
  assert.equal(headings(md)[1], '## Features');
  // no section heading can be forged from the reason or detail inside Needs you
  const lines = md.split('\n');
  const start = lines.indexOf('## Needs you');
  assert.equal(lines.indexOf('## Features'), start + 6);
});
