import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, harness } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract, lintContract, matchesRemoved } from '../lib/contract.mjs';
import { parseTestNames } from '../lib/testcount.mjs';
import { readEvents } from '../lib/events.mjs';
import { verify } from '../lib/verify.mjs';

// ------------------------------------------------------------------ fixtures

// Prints every `test('name'` of test/*.test.mjs as a node spec line (or a TAP line with TAP set)
// followed by the summary line the count is read from.
const RUNNER = [
  "import fs from 'node:fs';",
  "const names = [];",
  "for (const f of fs.readdirSync('test').filter((x) => x.endsWith('.test.mjs')).sort()) {",
  "  for (const m of fs.readFileSync(`test/${f}`, 'utf8').matchAll(/^test\\('([^']*)'/gm)) names.push(m[1]);",
  '}',
  "if (process.env.TAP) { names.forEach((n, i) => console.log(`ok ${i + 1} - ${n}`)); console.log(`# tests ${names.length}`); }",
  "else if (process.env.ANON) { console.log(`\\u2139 tests ${names.length}`); }",
  "else { names.forEach((n) => console.log(`\\u2714 ${n} (1.5ms)`)); console.log(`\\u2139 tests ${names.length}`); }",
  '',
].join('\n');

const tests = (...names) => names.map((n) => `test('${n}', () => { assert.ok(true); assert.ok(true); });\n`).join('');
const NAMES = ['F9 AC-1', 'F9 AC-2', 'F8 AC-1', 'F51 AC-1'];

const contract = (removes, id = 'F7') => {
  const c = {
    id, title: 'fixture', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node -e 0', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  if (removes !== undefined) c.removes_tests = removes;
  c.approval = { by: 'test', at: '2026-10-11T00:00:00.000Z', hash: hashContract(c) };
  return c;
};

const VERIFY = { commands: ['node scripts/runtests.mjs'], test_count: 'from:commands[0]', test_paths: ['test/**/*.test.*'], cache: 'off' };
const cfg = (over = {}) => resolveConfig({ base_branch: 'main', verify: { ...VERIFY, ...over }, env_allowlist: ['TAP', 'ANON'], budget: { step_timeout_sec: 60 } });

function fixture(removes, over = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { ...VERIFY, ...over } },
    '.harness/features.json': { features: [{ id: 'F7', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F7.json': contract(removes),
    'scripts/runtests.mjs': RUNNER,
    'test/a.test.mjs': tests(...NAMES),
  });
}

const headTests = (dir, ...names) => writeFiles(dir, { 'test/a.test.mjs': tests(...names) });
// `env`: variables the fixture runner reads, set in this process while verify runs.
async function run(dir, over = {}, { env = {} } = {}) {
  Object.assign(process.env, env);
  try {
    return await verify({ root: dir, featureId: 'F7', base: 'main', config: cfg(over) });
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
  }
}

// ------------------------------------------------------------------ AC-1

test('F115 AC-1 matchesRemoved: exact name, then prefix + space or colon', () => {
  assert.equal(matchesRemoved('F5 AC-1', ['F5']), true);
  assert.equal(matchesRemoved('F5', ['F5']), true);
  assert.equal(matchesRemoved('F5 AC-1: does x', ['F5 AC-1']), true);
  assert.equal(matchesRemoved('F5:x', ['F5']), true);
  assert.equal(matchesRemoved('F51 AC-1', ['F5']), false);
  assert.equal(matchesRemoved('F5 AC-10', ['F5 AC-1']), false);
  assert.equal(matchesRemoved('F6 AC-1', ['F5', 'F5 AC-1']), false);
  assert.equal(matchesRemoved('F5 AC-1', []), false);
  assert.equal(matchesRemoved('F5 AC-1', undefined), false);
});

test('F115 AC-1 parseTestNames reads node spec and TAP lines', () => {
  const spec = parseTestNames('✔ F1 AC-1 does x (12.3ms)\n  ✖ F1 AC-2 (3ms)\nℹ tests 2\n');
  assert.deepEqual([...spec], ['F1 AC-1 does x', 'F1 AC-2']);
  const tap = parseTestNames('ok 1 - F1 AC-1\n    not ok 2 - F1 AC-2 # SKIP later\n# tests 2\n');
  assert.deepEqual([...tap], ['F1 AC-1', 'F1 AC-2']);
  assert.equal(parseTestNames('nothing here\n').size, 0);
});

// ------------------------------------------------------------------ AC-2

test('F115 AC-2 verify: matching tests removed from head are allowed, with removed and a warning (spec output)', async () => {
  const dir = fixture(['F9']);
  headTests(dir, 'F8 AC-1', 'F51 AC-1');
  const r = await run(dir);
  const tc = r.integrity.testCount;
  assert.equal(tc.status, 'ok', JSON.stringify(tc));
  assert.equal(tc.removed, 2);
  assert.equal(tc.base, 4);
  assert.equal(tc.head, 2);
  assert.ok(r.warnings.includes('2 test(s) removed as approved by removes_tests'), JSON.stringify(r.warnings));
});

test('F115 AC-2 verify: TAP output names are read too', async () => {
  const dir = fixture(['F9 AC-2']);
  headTests(dir, 'F9 AC-1', 'F8 AC-1', 'F51 AC-1');
  const r = await run(dir, {}, { env: { TAP: '1' } });
  assert.equal(r.integrity.testCount.status, 'ok', JSON.stringify(r.integrity.testCount));
  assert.equal(r.integrity.testCount.removed, 1);
});

test('F115 AC-2 verify: affected mode allows the same', async () => {
  const over = { affected_command: 'node scripts/runtests.mjs {files}' };
  const dir = fixture(['F9'], over);
  headTests(dir, 'F8 AC-1', 'F51 AC-1');
  const r = await run(dir, over);
  assert.equal(r.integrity.testCount.status, 'ok', JSON.stringify(r.integrity.testCount));
  assert.equal(r.integrity.testCount.removed, 2);
});

// ------------------------------------------------------------------ AC-3

test('F115 AC-3 without removes_tests (absent or empty) a decrease still fails and there is no removed key', async () => {
  for (const removes of [undefined, []]) {
    const dir = fixture(removes);
    headTests(dir, 'F9 AC-1', 'F9 AC-2', 'F8 AC-1');
    const tc = (await run(dir)).integrity.testCount;
    assert.equal(tc.status, 'decreased', JSON.stringify(tc));
    assert.equal('removed' in tc, false);
  }
});

// ------------------------------------------------------------------ AC-4

const ASSERT_COUNT = path.join(REPO, 'test', 'assert-count.mjs');
const assertCount = (dir, ...args) => spawnSync(process.execPath, [ASSERT_COUNT, '--root', dir, '--base', 'main', ...args], { encoding: 'utf8' });

function countFixture(removes = ['F9']) {
  return gitRepo({
    '.harness/config.json': { base_branch: 'main' },
    '.harness/contracts/F7.json': contract(removes),
    'test/a.test.mjs': tests('F9 AC-1', 'F8 AC-1'),
    'test/b.test.mjs': tests('F9 AC-1', 'F9 AC-2'),
  });
}

test('F115 AC-4 assert-count --removes: matching tests removed, a fully matching file deleted, asserts lowered by their blocks', () => {
  const dir = countFixture();
  fs.rmSync(path.join(dir, 'test/b.test.mjs'));
  writeFiles(dir, { 'test/a.test.mjs': tests('F8 AC-1') });
  const r = assertCount(dir, '--removes', 'F7');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(assertCount(dir).status, 1, 'without --removes the same change is a problem');
});

// ------------------------------------------------------------------ AC-5

test('F115 AC-5 lint-contract: removes_tests must be an array of well-formed prefixes that are not its own', () => {
  const rules = (c) => lintContract(c, { ignoreApproval: true }).filter((p) => p.rule === 'removes_tests');
  assert.equal(rules(contract(['F5', 'F5 AC-1', 'F6 SC-2', 'F6 ES-10'])).length, 0);
  assert.equal(rules(contract('F5')).length, 1);
  assert.equal(rules(contract(['f5'])).length, 1);
  assert.equal(rules(contract(['F5 X-1'])).length, 1);
  assert.equal(rules(contract([5])).length, 1);
  assert.equal(rules(contract(['F5 AC-1 x'])).length, 1);
  assert.equal(rules(contract(['F7'])).length, 1);
  assert.equal(rules(contract(['F7 AC-1'])).length, 1);
  assert.equal(rules(contract(['F70'])).length, 0);
  assert.equal(lintContract(contract(['F7']), { ignoreApproval: true }).find((p) => p.rule === 'removes_tests').level, 'error');
});

test('F115 AC-5 lint-contract CLI exits 1 and records the removes_tests rule name in the plan/lint event', () => {
  const dir = fixture(['F7 AC-1']);
  const r = harness(['lint-contract', 'F7'], { cwd: dir });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const e = readEvents(dir).events.filter((x) => x.stage === 'plan' && x.type === 'lint').pop();
  assert.ok(JSON.stringify(e.data).includes('removes_tests'), JSON.stringify(e.data));
});

// ------------------------------------------------------------------ AC-6

test('F115 AC-6 SPEC §5 and §6.2 describe removes_tests', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s5 = spec.slice(spec.indexOf('## 5.'), spec.indexOf('## 6.'));
  const s62 = spec.slice(spec.indexOf('### 6.2'), spec.indexOf('### 6.3'));
  for (const text of ['removes_tests', 'matchesRemoved', 'F5 AC-1', 'F51 AC-1']) assert.ok(s5.includes(text), `§5 lacks ${text}`);
  for (const text of ['removes_tests', 'removed', 'test(s) removed as approved by removes_tests', 'assert-count.mjs --removes', '줄 시작']) assert.ok(s62.includes(text), `§6.2 lacks ${text}`);
});

// ------------------------------------------------------------------ SC-1

test('F115 SC-1 a matching test still in head is not removed: another test vanishing is a decrease', async () => {
  const dir = fixture(['F9']);
  headTests(dir, 'F9 AC-1', 'F9 AC-2', 'F51 AC-1');
  const tc = (await run(dir)).integrity.testCount;
  assert.equal(tc.status, 'decreased', JSON.stringify(tc));
  assert.equal(tc.removed, 0);
});

// ------------------------------------------------------------------ SC-2

test('F115 SC-2 verify: two matching tests and one other vanishing is a decrease', async () => {
  const dir = fixture(['F9']);
  headTests(dir, 'F51 AC-1');
  const r = await run(dir);
  assert.equal(r.integrity.testCount.status, 'decreased', JSON.stringify(r.integrity.testCount));
  assert.equal(r.pass, false);
});

test('F115 SC-2 assert-count --removes: unmatched name gone, unmatched name left in a deleted file, too many asserts lost', () => {
  let dir = countFixture();
  writeFiles(dir, { 'test/a.test.mjs': tests('F9 AC-1') });
  let r = assertCount(dir, '--removes', 'F7');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /test\/a\.test\.mjs/);
  assert.match(r.stderr, /F8 AC-1/);

  dir = countFixture();
  fs.rmSync(path.join(dir, 'test/a.test.mjs'));
  r = assertCount(dir, '--removes', 'F7');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /test\/a\.test\.mjs/);

  dir = countFixture();
  writeFiles(dir, { 'test/a.test.mjs': "test('F9 AC-1', () => { assert.ok(true); });\ntest('F8 AC-1', () => {});\n" });
  r = assertCount(dir, '--removes', 'F7');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /test\/a\.test\.mjs: asserts/);
});

// ------------------------------------------------------------------ SC-3

test('F115 SC-3 adding a removes_tests entry after approval makes verify refuse the contract (exit 2)', () => {
  const dir = fixture(['F9']);
  const file = path.join(dir, '.harness/contracts/F7.json');
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  c.removes_tests.push('F8');
  fs.writeFileSync(file, JSON.stringify(c, null, 2) + '\n');
  const r = harness(['verify', 'F7'], { cwd: dir });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /approv|hash/i);
});

// ------------------------------------------------------------------ ES-1

test('F115 ES-1 a base output without test names allows nothing', async () => {
  const dir = fixture(['F9']);
  headTests(dir, 'F8 AC-1', 'F51 AC-1');
  const tc = (await run(dir, {}, { env: { ANON: '1' } })).integrity.testCount;
  assert.equal(tc.status, 'decreased', JSON.stringify(tc));
  assert.equal(tc.removed, 0);
});

// ------------------------------------------------------------------ ES-2

test('F115 ES-2 assert-count --removes exits 2 naming a missing contract or one without removes_tests', () => {
  const dir = countFixture();
  let r = assertCount(dir, '--removes', 'F99');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /F99/);
  writeFiles(dir, { '.harness/contracts/F6.json': contract(undefined, 'F6') });
  r = assertCount(dir, '--removes', 'F6');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /F6/);
});
