// F104: the builder_model suggestion names a cheaper model whose build timeout rate is no
// higher; roles.<role>.effort is checked against the merged adapter; a test_tree cache hit
// warns about changed test files outside verify.test_paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, harness, tmpdir, writeJson } from './helpers.mjs';
import { git, gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig, loadConfig } from '../lib/config.mjs';
import { roleCall } from '../lib/adapters/index.mjs';
import { HarnessError } from '../lib/errors.mjs';
import { suggest } from '../lib/metrics.mjs';
import { verify } from '../lib/verify.mjs';

// ------------------------------------------------------------------ AC-1, ES-1

const at = (i) => new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString();
let clock = 0;
const build = (model, outcome = 'ok', o = {}) => ({ step: 'build', role: 'builder', model, outcome, cost_usd: 0, duration_ms: 1_000, ended_at: at(clock++), ...o });
// Five builds of `model`, `timeouts` of them timed out (alternating the two timeout outcomes).
const builds = (model, n, timeouts) => Array.from({ length: n }, (_, i) => build(model, i < timeouts ? (i % 2 ? 'timeout-continued' : 'timeout') : 'ok'));
// The builder is 90% of the cost; the current model's builds come last.
const costly = (current) => [
  { step: 'eval', role: 'evaluator', cost_usd: 1, duration_ms: 1_000, ended_at: at(clock++) },
  ...current.slice(0, -1), { ...current.at(-1), cost_usd: 9 },
];
const builderSuggestion = (rows) => suggest(rows, { stepTimeoutSec: 1800, standardFeature: true }).find((s) => s.rule === 'builder_model');

test('F104 AC-1: a cheaper model with a lower build timeout rate is suggested with both rates', () => {
  const rows = [...builds('claude-haiku-4', 5, 0), ...builds('claude-sonnet-4', 6, 1), ...costly(builds('claude-opus-4', 4, 2))];
  const s = builderSuggestion(rows);
  assert.ok(s, 'a suggestion');
  assert.equal(s.model, 'claude-haiku-4', 'the cheapest qualifying model');
  assert.equal(s.current_model, 'claude-opus-4');
  assert.equal(s.timeout_rate, 0);
  assert.equal(s.current_timeout_rate, 0.5);
  assert.match(s.message, /claude-haiku-4/);
  assert.match(s.message, /0%/);
  assert.match(s.message, /50%/);
});

test('F104 AC-1: an equal timeout rate is enough; sonnet is cheaper than opus', () => {
  const rows = [...builds('sonnet', 5, 1), ...costly(builds('opus', 5, 1))];
  const s = builderSuggestion(rows);
  assert.equal(s?.model, 'sonnet');
  assert.equal(s.timeout_rate, 0.2);
  assert.equal(s.current_timeout_rate, 0.2);
});

test('F104 AC-1: a cheaper model that times out more often → no suggestion', () => {
  const rows = [...builds('haiku', 5, 3), ...costly(builds('opus', 5, 1))];
  assert.equal(builderSuggestion(rows), undefined);
});

test('F104 AC-1: a cheaper model with fewer than five build lines → no suggestion', () => {
  const rows = [...builds('haiku', 4, 0), ...costly(builds('opus', 5, 3))];
  assert.equal(builderSuggestion(rows), undefined);
});

test('F104 AC-1: only a cheaper model counts — a pricier or unranked one is never suggested', () => {
  assert.equal(builderSuggestion([...builds('opus', 5, 0), ...costly(builds('sonnet', 5, 3))])?.model, undefined, 'opus is not cheaper than sonnet');
  assert.equal(builderSuggestion([...builds('gpt-5', 5, 0), ...costly(builds('opus', 5, 3))]), undefined, 'an unranked model is not cheaper');
  assert.equal(builderSuggestion([...builds('haiku', 5, 0), ...costly(builds('gpt-5', 5, 3))]), undefined, 'an unranked current model');
});

test('F104 AC-1: builder at or under 70% of the cost → no suggestion even with a cheaper model', () => {
  const rows = [...builds('haiku', 5, 0), ...builds('opus', 5, 3), { step: 'eval', role: 'evaluator', cost_usd: 5, ended_at: at(clock++) }];
  rows[rows.length - 2] = { ...rows[rows.length - 2], cost_usd: 5 };
  assert.equal(builderSuggestion(rows), undefined);
});

test('F104 AC-1: harness stats --json carries the suggestion', () => {
  const rows = [...builds('haiku', 5, 0), ...costly(builds('opus', 2, 1))];
  const dir = tmpdir('harness-f104-stats-');
  writeJson(path.join(dir, '.harness/config.json'), { profile: 'sdlc', base_branch: 'main' });
  writeJson(path.join(dir, '.harness/features.json'), { features: [{ id: 'F1', title: 'F1', security_tier: 'standard', depends_on: [], status: 'passed' }] });
  fs.mkdirSync(path.join(dir, '.harness/runs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.harness/runs/r.metrics.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const r = harness(['stats', '--json'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  const s = JSON.parse(r.stdout).suggestions.find((x) => x.rule === 'builder_model');
  assert.equal(s?.model, 'haiku');
  assert.equal(s.current_timeout_rate, 0.5);
});

test('F104 ES-1: lines without a string model or outcome are left out of the timeout rates', () => {
  const bad = [
    build(undefined, 'timeout'), build(null, 'timeout'), build(42, 'timeout'),
    build('haiku', undefined), build('haiku', null), build('haiku', 7), build('haiku', { x: 1 }),
    build(['haiku'], 'timeout'),
  ];
  for (const r of bad) if (r.model === undefined) delete r.model;
  delete bad[3].outcome;
  const rows = [...builds('haiku', 5, 1), ...costly(builds('opus', 2, 1)), ...bad];
  let s;
  assert.doesNotThrow(() => { s = builderSuggestion(rows); });
  assert.equal(s?.model, 'haiku');
  assert.equal(s.timeout_rate, 0.2, 'bad haiku lines do not count');
  assert.equal(s.current_model, 'opus', 'a later line without a string model is not the current model');
  assert.equal(s.current_timeout_rate, 0.5);
  // Four valid haiku lines plus bad ones are still fewer than five.
  const few = [...builds('haiku', 4, 0), ...costly(builds('opus', 2, 1)), ...bad];
  assert.doesNotThrow(() => { s = builderSuggestion(few); });
  assert.equal(s, undefined);
});

// ------------------------------------------------------------------ AC-2

const configError = (user) => {
  try { resolveConfig(user); } catch (e) { return e; }
  return null;
};

test('F104 AC-2: effort without adapter is accepted when the merged adapter is claude', () => {
  for (const role of ['builder', 'evaluator', 'security-reviewer']) {
    const c = resolveConfig({ roles: { [role]: { effort: 'high', model: 'm' } } });
    assert.equal(c.roles[role].adapter, 'claude', `${role} keeps the default adapter`);
    assert.deepEqual(roleCall(c, role), { adapter: 'claude', model: 'm', effort: 'high' });
  }
  const dir = tmpdir('harness-f104-cfg-');
  writeJson(path.join(dir, '.harness/config.json'), { profile: 'sdlc', roles: { builder: { effort: 'low' } } });
  assert.equal(loadConfig(dir).roles.builder.adapter, 'claude', 'config.json without adapter loads');
});

test('F104 AC-2: a merged adapter other than claude → config_invalid with the actual adapter', () => {
  for (const adapter of ['codex', 'gemini']) {
    const err = configError({ roles: { builder: { adapter, effort: 'high' } } });
    assert.ok(err instanceof HarnessError, `accepted effort on ${adapter}`);
    assert.equal(err.code, 'config_invalid');
    assert.equal(err.exit, 2);
    assert.ok(err.message.includes('roles.builder.effort'), err.message);
    assert.ok(err.message.includes(adapter), err.message);
  }
  const nul = configError({ roles: { evaluator: { adapter: null, effort: 'low' } } });
  assert.equal(nul?.code, 'config_invalid', 'adapter null is not claude');
  assert.match(nul.message, /null/);
});

test('F104 AC-2 CLI: effort without adapter passes; effort on a codex role exits 2 naming codex', () => {
  const mk = (roles) => {
    const dir = tmpdir('harness-f104-cli-');
    writeJson(path.join(dir, '.harness/config.json'), { profile: 'sdlc', base_branch: 'main', roles });
    writeJson(path.join(dir, '.harness/features.json'), { features: [] });
    return dir;
  };
  const ok = harness(['status'], { cwd: mk({ builder: { effort: 'high' } }) });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  const bad = harness(['status'], { cwd: mk({ builder: { adapter: 'codex', effort: 'high' } }) });
  assert.equal(bad.code, 2, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /roles\.builder\.effort/);
  assert.match(bad.stderr, /codex/);
});

// ------------------------------------------------------------------ AC-3

const CONTRACT = {
  id: 'F9', title: 'fixture', security_tier: 'standard', version: 1,
  acceptance_criteria: [{ id: 'AC-1', criterion: 'check exists', check: 'node check.mjs', new: false }],
  security_criteria: [], error_scenarios: [], out_of_scope: [],
};
const COUNT_SCRIPT = "import fs from 'node:fs';\nconsole.log(fs.readdirSync('test').filter((f) => f.endsWith('.test.mjs')).length);\n";

function fixture() {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', budget: { step_timeout_sec: 60 } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': CONTRACT,
    'package.json': { name: 'app', version: '1.0.0' },
    'scripts/count.mjs': COUNT_SCRIPT,
    'check.mjs': 'process.exit(0);\n',
    'lib/a.mjs': 'export const a = 1;\n',
    'test/a.test.mjs': '// a tests\n',
  });
}

// Commits a release on main (no test_paths file touched) and merges it into feature, so the
// next verify's merge-base is a new commit with the same test files: a test_tree hit.
function release(dir) {
  git(dir, 'checkout', '-q', 'main');
  writeFiles(dir, { 'package.json': { name: 'app', version: '1.1.0' } });
  git(dir, 'add', '--', 'package.json');
  git(dir, 'commit', '-q', '-m', 'release');
  git(dir, 'checkout', '-q', 'feature');
  git(dir, 'merge', '-q', '--no-edit', 'main');
}

const vcfg = () => resolveConfig({ base_branch: 'main', verify: { commands: [], cache: 'off', test_paths: ['test/**'], test_count: 'node scripts/count.mjs' }, budget: { step_timeout_sec: 60 } });
const run = (dir) => verify({ root: dir, featureId: 'F9', base: 'main', config: vcfg() });
const outsideWarnings = (r) => r.warnings.filter((w) => w.startsWith('test file outside verify.test_paths'));

test('F104 AC-3: a test_tree hit warns once about changed test-shaped files outside test_paths', async () => {
  const dir = fixture();
  // Feature changes: one committed, two untracked, plus files that must not count.
  writeFiles(dir, { 'lib/extra.test.mjs': '// x\n' });
  git(dir, 'add', '--', 'lib/extra.test.mjs');
  git(dir, 'commit', '-q', '-m', 'feature work');
  writeFiles(dir, {
    'src/test_util.py': '# t\n', 'src/b_test.go': '// t\n',
    'test/c.test.mjs': '// inside test_paths\n', 'lib/b.mjs': '// not a test name\n',
  });
  const r1 = await run(dir);
  assert.equal(r1.integrity.testCount.source.base, 'ran');
  assert.deepEqual(outsideWarnings(r1), [], 'no warning when the base count ran');
  release(dir);
  const r2 = await run(dir);
  assert.equal(r2.integrity.testCount.source.base, 'cache', 'the base count came from the cache');
  assert.deepEqual(outsideWarnings(r2), ['test file outside verify.test_paths: lib/extra.test.mjs (and 2 more)']);
});

test('F104 AC-3: one file outside test_paths is named without a count; none → no warning', async () => {
  const dir = fixture();
  writeFiles(dir, { 'pkg/x.spec.js': '// x\n', 'test/c.test.mjs': '// inside\n' });
  await run(dir);
  release(dir);
  const r = await run(dir);
  assert.equal(r.integrity.testCount.source.base, 'cache');
  assert.deepEqual(outsideWarnings(r), ['test file outside verify.test_paths: pkg/x.spec.js']);

  const clean = fixture();
  writeFiles(clean, { 'test/c.test.mjs': '// inside\n', 'lib/b.mjs': '// plain\n' });
  await run(clean);
  release(clean);
  const r2 = await run(clean);
  assert.equal(r2.integrity.testCount.source.base, 'cache');
  assert.deepEqual(outsideWarnings(r2), []);
});

// ------------------------------------------------------------------ AC-4

test('F104 AC-4: SPEC describes the timeout-rate condition, the merged effort check and the test_paths warning', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const section = (re) => {
    const start = spec.search(re);
    assert.ok(start !== -1, `section ${re}`);
    const rest = spec.slice(start + 4);
    const end = rest.search(/^##+ \d/m);
    return end === -1 ? rest : rest.slice(0, end);
  };
  const stats = spec.split('\n').find((l) => l.startsWith('- 제안(규칙 기반') && l.includes('`builder_model`'));
  assert.ok(stats, 'the stats suggestion rules');
  for (const s of ['시간 초과율', '`timeout`', '`timeout-continued`', '5개 이상', 'opus > sonnet > haiku', '`timeout_rate`', '`current_timeout_rate`']) {
    assert.ok(stats.includes(s), `stats rule mentions ${s}`);
  }
  const s4 = section(/^## 4\./m);
  assert.ok(/roles\.<역할>\.effort[^\n]*병합한 뒤의 그 역할 adapter/.test(s4), '§4 checks effort against the merged adapter');
  const s62 = section(/^### 6\.2 /m);
  assert.ok(s62.includes('test file outside verify.test_paths: <경로>'), '§6.2 gives the warning');
  assert.ok(/test_tree[^\n]*test file outside verify\.test_paths/.test(s62), '§6.2 ties it to a test_tree hit');
});
