// F33: the base-side vacuity run of a new criterion is limited by
// min(verify.vacuity_timeout_sec (default 120), budget.step_timeout_sec). A timeout there means
// the criterion did not pass on base: not vacuous, judged by its head result, base_timed_out: true.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpdir, harness } from './helpers.mjs';
import { gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig, DEFAULTS } from '../lib/config.mjs';
import { verify } from '../lib/verify.mjs';
import { HarnessError } from '../lib/errors.mjs';

const CONTRACT = (criteria) => ({
  id: 'F9', title: 'fixture', security_tier: 'standard', version: 1,
  acceptance_criteria: criteria.map(({ id, check, isNew = true }) => ({ id, criterion: id, check, new: isNew })),
  security_criteria: [], error_scenarios: [], out_of_scope: [],
});

// On HEAD (marker.txt exists) the check waits `argv[2]` seconds and exits 0; on base it starts
// a child process, records the child's pid in `argv[3]` (when given) and hangs for 600 s.
const CHECK_SCRIPT = `import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const [headSec = '0', pidDir] = process.argv.slice(2);
if (fs.existsSync('marker.txt')) {
  setTimeout(() => process.exit(0), Number(headSec) * 1000);
} else {
  if (pidDir) {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(pidDir, 'child.tmp'), String(child.pid));
    fs.renameSync(path.join(pidDir, 'child.tmp'), path.join(pidDir, 'child.pid'));
  }
  setTimeout(() => {}, 600000);
}
`;

// A feature branch whose new criteria pass on HEAD and hang on base.
function fixture(criteria) {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': CONTRACT(criteria),
    '.harness/backlog.json': { items: [] },
    'scripts/check.mjs': CHECK_SCRIPT,
    'scripts/wait.mjs': 'setTimeout(() => console.log(1), Number(process.argv[2]) * 1000);\n',
  });
  writeFiles(dir, { 'marker.txt': 'feature\n' });
  commitAll(dir, 'feature');
  return dir;
}

const cfg = (verifyExtra = {}, budget = {}) => resolveConfig({ base_branch: 'main', verify: { commands: [], ...verifyExtra }, budget });
const runVerify = (dir, config) => verify({ root: dir, featureId: 'F9', base: 'main', config, cpus: 1 });

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid, ms = 3000) {
  for (let t = 0; t < ms && alive(pid); t += 100) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}

// ---------- AC-1 ----------
test('F33 AC-1: verify.vacuity_timeout_sec defaults to 120', () => {
  assert.equal(DEFAULTS.verify.vacuity_timeout_sec, 120);
  assert.equal(cfg().verify.vacuity_timeout_sec, 120);
});

test('F33 AC-1: a base check that hangs for 600s ends verify within 60s at vacuity_timeout_sec 3', async () => {
  const dir = fixture([{ id: 'AC-1', check: 'node scripts/check.mjs' }]);
  // step_timeout_sec 75 alone would let the base run go past 60 s.
  const started = Date.now();
  const r = await runVerify(dir, cfg({ vacuity_timeout_sec: 3 }, { step_timeout_sec: 75 }));
  const elapsed = (Date.now() - started) / 1000;
  assert.ok(elapsed < 60, `verify took ${elapsed}s`);
  assert.equal(r.criteria[0].base_timed_out, true, JSON.stringify(r.criteria));
});

test('F33 AC-1: a step_timeout_sec below vacuity_timeout_sec limits the base run', async () => {
  const dir = fixture([{ id: 'AC-1', check: 'node scripts/check.mjs' }]);
  const r = await runVerify(dir, cfg({}, { step_timeout_sec: 3 }));
  assert.equal(r.criteria[0].base_timed_out, true, JSON.stringify(r.criteria));
});

// ---------- AC-2 ----------
test('F33 AC-2: a base timeout is not vacuous — the criterion passes by its head result with base_timed_out', async () => {
  const dir = fixture([{ id: 'AC-1', check: 'node scripts/check.mjs' }]);
  const r = await runVerify(dir, cfg({ vacuity_timeout_sec: 3 }, { step_timeout_sec: 30 }));
  const c = r.criteria[0];
  assert.equal(c.base_timed_out, true, JSON.stringify(c));
  assert.equal(c.vacuous, false);
  assert.equal(c.pass, true);
  assert.equal(c.timedOut, undefined);
  assert.equal(r.pass, true, JSON.stringify(r));
});

test('F33 AC-2: base_timed_out is recorded per criterion, only where the base run timed out', async () => {
  const dir = fixture([
    { id: 'AC-1', check: 'node scripts/check.mjs' },
    { id: 'AC-2', check: 'node -e "process.exit(1)"', isNew: false },
    { id: 'AC-3', check: 'node -e "process.exit(require(\'fs\').existsSync(\'marker.txt\') ? 0 : 1)"' },
  ]);
  const r = await runVerify(dir, cfg({ vacuity_timeout_sec: 3 }, { step_timeout_sec: 30 }));
  assert.equal(r.criteria[0].base_timed_out, true, JSON.stringify(r.criteria));
  assert.equal(r.criteria[1].pass, false);
  assert.equal(r.criteria[1].base_timed_out, undefined);
  assert.equal(r.criteria[2].pass, true);
  assert.equal(r.criteria[2].base_timed_out, undefined);
  assert.equal(r.pass, false);
});

// ---------- AC-3 ----------
test('F33 AC-3: at vacuity_timeout_sec 3 a 5s head check, verify command and test_count pass while the base run is cut at 3s', async () => {
  const dir = fixture([{ id: 'AC-1', check: 'node scripts/check.mjs 5' }]);
  const config = cfg({ vacuity_timeout_sec: 3, commands: ['node scripts/wait.mjs 5'], test_count: 'node scripts/wait.mjs 5' }, { step_timeout_sec: 30 });
  const r = await runVerify(dir, config);
  assert.equal(r.commands[0].pass, true, JSON.stringify(r.commands));
  assert.notEqual(r.integrity.testCount.status, 'error', JSON.stringify(r.integrity.testCount));
  const c = r.criteria[0];
  assert.equal(c.pass, true, JSON.stringify(c));
  assert.equal(c.timedOut, undefined);
  assert.equal(c.base_timed_out, true);
});

// ---------- SC-1 ----------
test('F33 SC-1: a timed-out base run is killed with its child and the base worktree is removed', async () => {
  const pids = fs.realpathSync.native(tmpdir('harness-f33-pids-'));
  const dir = fixture([{ id: 'AC-1', check: `node scripts/check.mjs 0 "${pids}"` }]);
  // Long enough for the check to start its child on a loaded machine.
  const r = await runVerify(dir, cfg({ vacuity_timeout_sec: 10 }, { step_timeout_sec: 30 }));
  assert.equal(r.criteria[0].base_timed_out, true, JSON.stringify(r.criteria));
  const file = path.join(pids, 'child.pid');
  assert.ok(fs.existsSync(file), 'child pid recorded');
  assert.ok(await gone(Number(fs.readFileSync(file, 'utf8'))), 'child still alive');
  const list = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout;
  assert.equal(list.split('\n').filter((l) => l.startsWith('worktree ')).length, 1, list);
});

// ---------- ES-1 ----------
for (const [label, value] of [['0', 0], ['negative', -5], ['a numeric string', '120'], ['a word', 'long'], ['null', null], ['true', true], ['an array', [120]], ['an object', { sec: 120 }]]) {
  test(`F33 ES-1: verify.vacuity_timeout_sec ${label} is config_invalid (exit 2) naming the key`, () => {
    assert.throws(() => resolveConfig({ verify: { vacuity_timeout_sec: value } }),
      (e) => e instanceof HarnessError && e.code === 'config_invalid' && e.exit === 2 && e.message.includes('verify.vacuity_timeout_sec'));
  });
}

test('F33 ES-1: the CLI exits 2 with verify.vacuity_timeout_sec in the message for a config.json value of 0', () => {
  const dir = fixture([{ id: 'AC-1', check: 'node scripts/check.mjs' }]);
  const file = path.join(dir, '.harness', 'config.json');
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  // step_timeout_sec bounds the base run where the value is not rejected (pre-feature code).
  fs.writeFileSync(file, JSON.stringify({ ...c, verify: { commands: [], vacuity_timeout_sec: 0 }, budget: { step_timeout_sec: 5 } }));
  const r = harness(['verify', 'F9', '--base', 'main'], { cwd: dir });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr + r.stdout, /verify\.vacuity_timeout_sec/);
});

test('F33 ES-1: a positive vacuity_timeout_sec is accepted', () => {
  assert.equal(resolveConfig({ verify: { vacuity_timeout_sec: 2.5 } }).verify.vacuity_timeout_sec, 2.5);
});

// ---------- AC-4 ----------
const SPEC = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
const README = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
const between = (from, to) => SPEC.slice(SPEC.indexOf(from), SPEC.indexOf(to));

test('F33 AC-4: SPEC §4 documents verify.vacuity_timeout_sec and its validation', () => {
  const s4 = between('\n## 4. ', '\n## 5. ');
  assert.match(s4, /verify\.vacuity_timeout_sec/);
  assert.match(s4, /verify\.vacuity_timeout_sec`?\(기본 120\)[^|]*config_invalid/);
});

test('F33 AC-4: SPEC §6.3 and README describe the base limit and how a base timeout is judged', () => {
  for (const [name, text] of [['SPEC §6.3', between('\n### 6.3 ', '\n## 7. ')], ['README', README]]) {
    for (const s of ['verify.vacuity_timeout_sec', '120', 'budget.step_timeout_sec', 'base_timed_out', 'vacuous']) {
      assert.ok(text.includes(s), `${name} mentions ${s}`);
    }
  }
});
