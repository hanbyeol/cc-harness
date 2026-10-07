import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, REPO } from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { lintContract } from '../lib/contract.mjs';
import { ENUM_FIELDS } from '../lib/telemetry.mjs';

// F82: lint-contract warns when a new criterion names a test_paths helper the base vacuity
// run overlays (§6.3), so the criterion can pass on base.

const SDLC_TEST_PATHS = resolveConfig({ profile: 'sdlc' }).verify.test_paths;

function contract(criteria, id = 'F9') {
  return {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: criteria, security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
}

const crit = (criterion, { isNew = true, check = 'node scripts/ok.mjs', id = 'AC-1' } = {}) => {
  const c = { id, check, new: isNew };
  if (criterion !== undefined) c.criterion = criterion;
  return c;
};

const helperWarnings = (problems) => problems.filter((p) => p.rule === 'overlaid_helper');
const lint = (criteria, testPaths = SDLC_TEST_PATHS) => lintContract(contract(criteria), { testPaths });

function fixture({ criteria, config = {} }) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...config },
    '.harness/features.json': { features: [{ id: 'F9', title: 'feature F9', status: 'todo', depends_on: [] }] },
    '.harness/backlog.json': { items: [] },
    '.harness/contracts/F9.json': contract(criteria),
    'scripts/ok.mjs': 'process.exit(0);\n',
  }, { branch: null });
}

const lintEvents = (dir) => {
  const d = path.join(dir, '.harness', 'events');
  return fs.readdirSync(d).flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    .filter((e) => e.stage === 'plan' && e.type === 'lint');
};

// ---------- AC-1 ----------
for (const p of ['test/t.mjs', 'tests/util.js', '__tests__/setup.ts']) {
  test(`F82 AC-1: a new criterion naming ${p} gets an overlaid_helper warning with its id and the path`, () => {
    const ws = helperWarnings(lint([crit(`the runner ${p} loads only matching files`, { id: 'AC-2' })]));
    assert.equal(ws.length, 1, JSON.stringify(ws));
    assert.equal(ws[0].level, 'warning');
    assert.equal(ws[0].id, 'AC-2');
    assert.ok(ws[0].message.includes(p), ws[0].message);
    assert.ok(ws[0].message.includes('overlaid on base'), ws[0].message);
    assert.ok(ws[0].message.includes('new: false'), ws[0].message);
  });
}

test('F82 AC-1: lint-contract prints the warning with the contract id, criterion id and path', () => {
  const dir = fixture({ criteria: [crit('test/helpers.mjs exports a fixture builder')] });
  const r = harness(['lint-contract'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const line = r.stdout.split('\n').find((l) => l.includes('test/helpers.mjs'));
  assert.ok(line, r.stdout);
  assert.match(line, /^F9 AC-1: warning: /);
  assert.ok(line.includes('overlaid on base') && line.includes('new: false'), line);
});

test('F82 AC-1: a path in backticks, after ./ or several paths in one criterion are all reported in one warning', () => {
  const ws = helperWarnings(lint([crit('`./test/t.mjs` and tests/util.js, plus test/t.mjs again')]));
  assert.equal(ws.length, 1);
  assert.ok(ws[0].message.includes('test/t.mjs, tests/util.js'), ws[0].message);
});

// ---------- AC-2 ----------
test('F82 AC-2: no warning for a criterion with new: false or without new', () => {
  assert.deepEqual(helperWarnings(lint([crit('test/t.mjs runs one criterion', { isNew: false })])), []);
  const noNew = crit('test/t.mjs runs one criterion');
  delete noNew.new;
  assert.deepEqual(helperWarnings(lint([noNew])), []);
});

test('F82 AC-2: no warning for a path shaped like a test file', () => {
  for (const p of ['test/f1.test.mjs', 'src/a.spec.ts', 'pkg/x_test.go', 'tests/test_x.py', 'test/f82-overlaid-helper.test.mjs']) {
    assert.deepEqual(helperWarnings(lint([crit(`covered by ${p}`)])), [], p);
  }
});

test('F82 AC-2: no warning for a path outside test_paths', () => {
  assert.deepEqual(helperWarnings(lint([crit('lib/x.mjs exports lint rules, see docs/SPEC.md')])), []);
  assert.deepEqual(helperWarnings(lint([crit('fetches https://example.com/test/t.mjs')])), []);
});

test('F82 AC-2: no warning when the path is only in the check command', () => {
  assert.deepEqual(helperWarnings(lint([crit('runs one criterion', { check: 'node test/t.mjs "F9 AC-1"' })])), []);
});

// ---------- AC-3 ----------
test('F82 AC-3: a contract with only the warning lints with exit 0 and the plan/lint event lists it', () => {
  const dir = fixture({ criteria: [crit('the runner test/t.mjs filters by id'), crit('two', { id: 'AC-2' })] });
  const r = harness(['lint-contract', 'F9'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /0 error\(s\), 1 warning\(s\)/);
  const [e] = lintEvents(dir);
  assert.deepEqual(e.data.warnings, [{ rule: 'overlaid_helper', id: 'AC-1' }]);
  assert.equal(e.data.error_count, 0);
  assert.ok(ENUM_FIELDS.rule.includes('overlaid_helper'));
});

test('F82 AC-3: the warning does not stop harness approve', () => {
  const dir = fixture({ criteria: [crit('the runner test/t.mjs filters by id')] });
  const r = harness(['approve', 'F9', '--by', 'test'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('overlaid on base'), r.stdout);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, '.harness', 'contracts', 'F9.json'), 'utf8'));
  assert.ok(saved.approval?.hash);
});

// ---------- AC-4 ----------
test('F82 AC-4: test_paths comes from the project config, not the profile default', () => {
  const criteria = [crit('spec/support.rb loads fixtures'), crit('test/t.mjs filters by id', { id: 'AC-2' })];
  const dir = fixture({ criteria, config: { verify: { commands: [], test_paths: ['spec/**'] } } });
  const r = harness(['lint-contract', 'F9'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const [e] = lintEvents(dir);
  assert.deepEqual(e.data.warnings, [{ rule: 'overlaid_helper', id: 'AC-1' }]);
  assert.ok(r.stdout.includes('spec/support.rb'));
});

test('F82 AC-4: an empty test_paths gives no overlaid_helper warning', () => {
  const dir = fixture({ criteria: [crit('test/t.mjs filters by id')], config: { verify: { commands: [], test_paths: [] } } });
  const r = harness(['lint-contract', 'F9'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(lintEvents(dir)[0].data.warnings, []);
  assert.deepEqual(helperWarnings(lint([crit('test/t.mjs filters by id')], [])), []);
});

// ---------- AC-5 ----------
test('F82 AC-5: SPEC §5 describes the overlaid_helper warning, its reason and the remedy', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s5 = spec.slice(spec.indexOf('## 5.'), spec.indexOf('## 6.'));
  for (const re of [/`overlaid_helper`/, /`verify\.test_paths`/, /`\*\.test\.\*`·`\*\.spec\.\*`·`\*_test\.\*`·`test_\*\.py`/,
    /§6\.3 base vacuity 실행/, /`new: false`/, /오류 아님/]) {
    assert.match(s5, re);
  }
});

// ---------- ES-1 ----------
test('F82 ES-1: a missing or non-string criterion is skipped by this rule without throwing', () => {
  for (const criterion of [undefined, 42, null, ['test/t.mjs'], { t: 'test/t.mjs' }, '   ']) {
    const problems = lint([crit(criterion)]);
    assert.deepEqual(helperWarnings(problems), [], String(criterion));
    assert.deepEqual(problems.filter((p) => p.level === 'warning').map((p) => p.rule), ['criterion_text'], String(criterion));
  }
});
