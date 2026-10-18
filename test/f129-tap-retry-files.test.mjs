import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { REPO, tmpdir } from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { verify } from '../lib/verify.mjs';
import { partialRetry, failedTestFiles } from '../lib/retryfiles.mjs';

const logger = (label, body) => [
  "import test from 'node:test';",
  "import fs from 'node:fs';",
  "const log = (s) => fs.appendFileSync('runs.log', s + '\\n');",
  `const label = ${JSON.stringify(label)};`,
  "const runs = () => fs.readFileSync('runs.log', 'utf8').split('\\n').filter((l) => l === label).length;",
  body,
  '',
].join('\n');
const STABLE = logger('a', "test('a passes', () => { log(label); });");
const FLAKY = logger('b', "test('b flaky', () => { log(label); if (runs() === 1) throw new Error('first run fails'); });");
const NESTED = logger('n', "test('parent', async (t) => { log(label); await t.test('child', () => { if (runs() === 1) throw new Error('boom'); }); });");
const THROWS = logger('c', "log(label);\nif (runs() === 1) throw new Error('import fails');\ntest('c ok', () => {});");
const NODE_TEST = 'node --test --test-reporter=tap "tests/**/*.test.mjs"';

const contract = (id) => {
  const c = {
    id, title: 'fixture', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'check exists', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-09T00:00:00.000Z', hash: hashContract(c) };
  return c;
};
const fixture = (tests) => gitRepo({
  '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
  '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', security_tier: 'standard', status: 'approved', depends_on: [] }] },
  '.harness/contracts/F9.json': contract('F9'),
  'scripts/ok.mjs': 'process.exit(0);\n',
  '.gitignore': 'runs.log\n',
  ...tests,
});
const run = (dir, over = {}) => verify({
  root: dir, featureId: 'F9', base: 'main',
  config: resolveConfig({ base_branch: 'main', verify: { commands: [NODE_TEST], ...over }, budget: { step_timeout_sec: 120 } }),
});
const runsLog = (dir) => fs.readFileSync(path.join(dir, 'runs.log'), 'utf8').split('\n').filter(Boolean);

// A TAP output with one top-level block per entry: [name, location key line | null, suffix].
const tap = (blocks) => ['TAP version 13', ...blocks.flatMap(([name, loc, suffix = '', extra = []]) => [
  `not ok 1 - ${name}${suffix}`, '  ---', '  duration_ms: 1', "  type: 'test'", ...(loc === null ? [] : [`  location: ${loc}`]), ...extra, '  ...',
]), '1..1', '# tests 2', ''].join('\n');
const cwdWith = (...names) => {
  const cwd = fs.realpathSync.native(tmpdir('harness-f129-'));
  for (const n of names) {
    fs.mkdirSync(path.dirname(path.join(cwd, n)), { recursive: true });
    fs.writeFileSync(path.join(cwd, n), '');
  }
  return cwd;
};

test('F129 AC-1: TAP output gives the failed file; 2nd and 3rd runs run only it, head count is the 1st run total', async () => {
  const dir = fixture({ 'tests/a.test.mjs': STABLE, 'tests/b.test.mjs': FLAKY });
  const r = await run(dir, { test_count: 'from:commands[0]' });
  const c = r.commands[0];
  assert.equal(c.pass, true, JSON.stringify(c));
  const log = runsLog(dir);
  assert.equal(log.filter((l) => l === 'a').length, 1, log.join(','));
  assert.equal(log.filter((l) => l === 'b').length, 3, log.join(','));
  assert.deepEqual(c.retry_files, [path.join('tests', 'b.test.mjs')]);
  assert.equal(r.integrity.testCount.head, 2, JSON.stringify(r.integrity.testCount));
});

test('F129 AC-2: nested subtest failure and an import failure give [A, C] without duplicates; B is not re-run', async () => {
  const dir = fixture({ 'tests/a.test.mjs': NESTED, 'tests/b.test.mjs': STABLE, 'tests/c.test.mjs': THROWS });
  const r = await run(dir);
  const c = r.commands[0];
  assert.deepEqual(c.retry_files, [path.join('tests', 'a.test.mjs'), path.join('tests', 'c.test.mjs')], JSON.stringify(c));
  assert.equal(runsLog(dir).filter((l) => l === 'a').length, 1);
});

test('F129 AC-3: the location value is unquoted from util.inspect (quotes, escapes, spaces)', () => {
  const name = path.join('tests', "sub dir", "it's b.test.mjs");
  const cwd = cwdWith(name);
  const abs = path.join(cwd, name);
  const want = { files: [name] };
  for (const loc of [util.inspect(`${abs}:1:1`), `'${abs.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}:1:1'`,
    `"${abs.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}:1:1"`, `\`${abs.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}:1:1\``]) {
    assert.deepEqual(failedTestFiles(tap([['x', loc]]), cwd), want, loc);
  }
  assert.ok(partialRetry(NODE_TEST, tap([['x', util.inspect(`${abs}:1:1`)]]), cwd));
});

test('F129 AC-4: location lines inside error blocks, ok blocks and TODO/SKIP blocks are not files', () => {
  const cwd = cwdWith('real.test.mjs', 'other.test.mjs');
  // util.inspect, as Node writes it: a Windows path's backslashes are escaped.
  const other = util.inspect(`${path.join(cwd, 'other.test.mjs')}:1:1`);
  const real = util.inspect(`${path.join(cwd, 'real.test.mjs')}:1:1`);
  const deep = ['  error: |-', '    boom', `    location: ${other}`];
  assert.deepEqual(failedTestFiles(tap([['x', real, '', deep]]), cwd), { files: ['real.test.mjs'] });
  const okBlock = ['ok 2 - fine', '  ---', `  location: ${other}`, '  ...'].join('\n');
  assert.deepEqual(failedTestFiles(`${tap([['x', real]])}${okBlock}\n`, cwd), { files: ['real.test.mjs'] });
  for (const d of [' # TODO', ' # SKIP reason']) {
    assert.deepEqual(failedTestFiles(tap([['x', real], ['y', other, d]]), cwd), { files: ['real.test.mjs'] }, d);
  }
  assert.deepEqual(failedTestFiles(tap([['y', other, ' # TODO']]), cwd), { reason: 'no_files' });
});

test('F129 AC-6: SPEC §6.1 describes the TAP rule and no longer lists the TAP reporter as a whole re-run', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const i = spec.indexOf('**실패한 테스트 파일만 재실행');
  const sec = spec.slice(i, spec.indexOf('\n\n', i) > 0 ? spec.indexOf('\n\n', i) : undefined);
  for (const w of ['TAP', 'not ok', 'location', 'TODO', 'SKIP', 'util.inspect']) assert.ok(sec.includes(w), w);
  assert.ok(!sec.includes('TAP reporter'));
});

test('F129 ES-1: unreadable TAP output re-runs the whole command without throwing', () => {
  const cwd = cwdWith('a.test.mjs');
  const abs = path.join(cwd, 'a.test.mjs');
  const good = ['x', `'${abs}:1:1'`];
  const cases = {
    'no location key': tap([good, ['y', null]]),
    'outside cwd': tap([['y', `'${path.join(cwd, '..', 'out.test.mjs')}:1:1'`]]),
    missing: tap([['y', `'${path.join(cwd, 'gone.test.mjs')}:1:1'`]]),
    'unclosed quote': tap([['y', `'${abs}:1:1`]]),
    'other escape': tap([['y', `'${abs.replace('a.test', 'a\\n.test')}:1:1'`]]),
    unquoted: tap([['y', `${abs}:1:1`]]),
  };
  for (const [k, out] of Object.entries(cases)) {
    assert.equal(failedTestFiles(out, cwd).reason, 'unknown_file', k);
    assert.equal(partialRetry(NODE_TEST, out, cwd), null, k);
  }
});

test('F129 ES-2: a Windows path in location is a missing file on POSIX, not a path under cwd', () => {
  if (process.platform === 'win32') return;
  const cwd = cwdWith('C:/proj/tests/a.test.mjs', 'proj/tests/a.test.mjs', 'C:projtestsa.test.mjs');
  const out = tap([['x', util.inspect('C:\\proj\\tests\\a.test.mjs:1:1')]]);
  assert.deepEqual(failedTestFiles(out, cwd), { reason: 'unknown_file' });
  assert.equal(partialRetry(NODE_TEST, out, cwd), null);
});
