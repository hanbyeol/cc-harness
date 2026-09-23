import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, REPO } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { HarnessError } from '../lib/errors.mjs';
import { runFeatures } from '../lib/run.mjs';
import evalCommand from '../lib/commands/eval.mjs';

const FAKE_CLI = path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs');
const REPLY_PASS = path.join(REPO, 'test', 'fixtures', 'eval', 'pass.json');

const SCRIPTS = {
  'scripts/ok.mjs': 'process.exit(0);\n',
  'scripts/fail.mjs': 'process.exit(3);\n',
  // exit 0 iff every named file exists
  'scripts/has.mjs': "import fs from 'node:fs';\nprocess.exit(process.argv.slice(2).every((f) => fs.existsSync(f)) ? 0 : 1);\n",
};

function contract({ approve = true, tier = 'standard' } = {}) {
  const c = {
    id: 'F9', title: 'fixture feature', security_tier: tier, version: 1,
    acceptance_criteria: [
      { id: 'AC-1', criterion: 'one', check: 'node scripts/ok.mjs', new: false },
      { id: 'AC-2', criterion: 'two', check: 'node scripts/ok.mjs', new: false },
    ],
    security_criteria: [{ id: 'SC-1', criterion: 'three', check: 'node scripts/ok.mjs', new: false }],
    error_scenarios: [],
    out_of_scope: [],
  };
  if (approve) c.approval = { by: 'test', at: '2026-09-23T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

// A CLI evaluator that fails at once: nothing in these tests reaches a real model CLI,
// even when the in-process adapter injection is not honoured.
const FAILING_CLI = {
  roles: { builder: 'claude', evaluator: 'generic', 'security-reviewer': 'generic' },
  adapters: { generic: { read_only_command: [process.execPath, FAKE_CLI, 'exit', '1'] } },
};

function fixture({ status = 'approved', contract: c = contract(), config = {} } = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...FAILING_CLI, ...config },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status, depends_on: [] }] },
    '.harness/contracts/F9.json': c,
    '.harness/backlog.json': { items: [] },
    ...SCRIPTS,
  });
}

const PASS_VERIFY = {
  pass: true, commands: [], warnings: [],
  integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } },
  criteria: [{ id: 'AC-1', pass: true }, { id: 'AC-2', pass: true }, { id: 'SC-1', pass: true }],
};

const scores = (o = {}) => ({ functionality: 9, quality: 9, security: 9, errors: 9, tests: 9, ...o });
const reply = (json) => ({ ok: true, error: null, text: JSON.stringify(json), json, costUsd: 0, exitCode: 0 });
const finding = (id) => ({ criterion_id: id, dimension: 'functionality', summary: `${id} broken`, repro: 'node scripts/fail.mjs' });
const passReply = () => reply({ scores: scores(), findings: [], out_of_scope: [] });
const failReply = (...ids) => reply({ scores: scores({ functionality: 3 }), findings: ids.map(finding), out_of_scope: [] });
const lowReply = () => reply({ scores: scores({ quality: 2 }), findings: [], out_of_scope: [] });
const errReply = () => ({ ok: false, error: 'exit_nonzero', detail: 'boom', text: '', json: null, costUsd: 0, exitCode: 1 });

// Adapter that answers every call with the next reply; counts calls.
function adapter(...replies) {
  const q = [...replies];
  const fn = async () => {
    fn.calls += 1;
    if (!q.length) throw new Error('unexpected adapter call');
    return q.shift();
  };
  fn.calls = 0;
  return fn;
}

// Runs the eval command in-process with an injected adapter; returns {code, out, err}.
async function evalCmd(dir, runAdapter, args = [], deps = {}) {
  const out = [];
  const err = [];
  let code;
  try {
    code = await evalCommand({
      root: dir, args: ['F9', ...args], out: (s) => out.push(s), err: (s) => err.push(s),
      deps: { runAdapter, verifyResult: PASS_VERIFY, ...deps },
    });
  } catch (e) {
    if (!(e instanceof HarnessError)) throw e;
    code = e.exit;
    err.push(e.message);
    return { code, out: out.join('\n'), err: err.join('\n'), error: e };
  }
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const statusOf = (dir) => readJson(path.join(dir, '.harness', 'features.json')).features.find((f) => f.id === 'F9').status;
const backlog = (dir) => readJson(path.join(dir, '.harness', 'backlog.json')).items;
const verdictFiles = (dir) => {
  try { return fs.readdirSync(path.join(dir, '.harness', 'verdicts')).sort(); } catch { return []; }
};

// ---------- AC-1 ----------
test('F17 AC-1 pass verdict records status passed and prints status: passed', async () => {
  const dir = fixture();
  const r = await evalCmd(dir, adapter(passReply()));
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(statusOf(dir), 'passed');
  assert.match(r.out, /status: passed/);
});

test('F17 AC-1 pass after an earlier failing round (in_progress) also records passed', async () => {
  const dir = fixture();
  assert.equal((await evalCmd(dir, adapter(failReply('AC-1')))).code, 1);
  assert.equal(statusOf(dir), 'in_progress');
  const r = await evalCmd(dir, adapter(passReply()));
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(statusOf(dir), 'passed');
});

// ---------- AC-2 ----------
test('F17 AC-2 round 1 fail → in_progress, exit 1, rounds left printed', async () => {
  const dir = fixture();
  const r = await evalCmd(dir, adapter(failReply('AC-1', 'SC-1')));
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(statusOf(dir), 'in_progress');
  assert.match(r.out, /status: in_progress/);
  assert.match(r.out, /rounds left: 2\b/);
});

test('F17 AC-2 round 2 fail with a proper subset of round 1 → in_progress, 1 round left', async () => {
  const dir = fixture();
  await evalCmd(dir, adapter(failReply('AC-1', 'SC-1')));
  const r = await evalCmd(dir, adapter(failReply('AC-1')));
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(statusOf(dir), 'in_progress');
  assert.match(r.out, /rounds left: 1\b/);
  assert.deepEqual(backlog(dir), []);
});

// ---------- AC-3 ----------
test('F17 AC-3 fail at round max_rounds → blocked, backlog F9-blocked / rounds with split·rewrite·accept', async () => {
  const dir = fixture();
  await evalCmd(dir, adapter(failReply('AC-1', 'AC-2', 'SC-1')));
  await evalCmd(dir, adapter(failReply('AC-1', 'AC-2')));
  const r = await evalCmd(dir, adapter(failReply('AC-1')));
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(statusOf(dir), 'blocked');
  assert.match(r.out, /status: blocked/);
  const items = backlog(dir).filter((i) => i.source === 'F9-blocked');
  assert.equal(items.length, 1);
  assert.equal(items[0].reason, 'rounds');
  assert.deepEqual(items[0].options.map((o) => o.kind), ['split', 'rewrite', 'accept']);
});

test('F17 AC-3 max_rounds comes from config', async () => {
  const dir = fixture({ config: { max_rounds: 1 } });
  const r = await evalCmd(dir, adapter(failReply('AC-1')));
  assert.equal(r.code, 1);
  assert.equal(statusOf(dir), 'blocked');
  assert.equal(backlog(dir).find((i) => i.source === 'F9-blocked').reason, 'rounds');
});

// ---------- AC-4 ----------
test('F17 AC-4 divergence: a blocking id absent in the previous round blocks with reason divergence', async () => {
  const dir = fixture();
  await evalCmd(dir, adapter(failReply('AC-1', 'AC-2')));
  const r = await evalCmd(dir, adapter(failReply('AC-1', 'SC-1')));
  assert.equal(r.code, 1);
  assert.equal(statusOf(dir), 'blocked');
  assert.match(r.out, /divergence/);
  assert.equal(backlog(dir).find((i) => i.source === 'F9-blocked').reason, 'divergence');
});

test('F17 AC-4 stall: a blocking set that did not shrink blocks with reason stall', async () => {
  const dir = fixture();
  await evalCmd(dir, adapter(failReply('AC-1', 'AC-2')));
  const r = await evalCmd(dir, adapter(failReply('AC-2', 'AC-1')));
  assert.equal(r.code, 1);
  assert.equal(statusOf(dir), 'blocked');
  assert.match(r.out, /stall/);
  assert.equal(backlog(dir).find((i) => i.source === 'F9-blocked').reason, 'stall');
});

// ---------- AC-5 ----------
test('F17 AC-5 one eval_error leaves the status unchanged', async () => {
  const dir = fixture();
  const r = await evalCmd(dir, adapter(errReply()));
  assert.equal(r.code, 2);
  assert.equal(statusOf(dir), 'approved');
  assert.deepEqual(backlog(dir), []);
});

test('F17 AC-5 two consecutive eval_errors block the feature with reason eval_error', async () => {
  const dir = fixture();
  await evalCmd(dir, adapter(errReply()));
  const r = await evalCmd(dir, adapter(errReply()));
  assert.equal(r.code, 2);
  assert.equal(statusOf(dir), 'blocked');
  assert.match(r.out, /eval_error/);
  assert.equal(backlog(dir).find((i) => i.source === 'F9-blocked').reason, 'eval_error');
});

// ---------- AC-6 ----------
test('F17 AC-6 needs-human verdict blocks the feature with reason needs_human', async () => {
  const dir = fixture();
  const r = await evalCmd(dir, adapter(lowReply(), lowReply()));
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(statusOf(dir), 'blocked');
  assert.match(r.out, /needs_human/);
  assert.equal(backlog(dir).find((i) => i.source === 'F9-blocked').reason, 'needs_human');
});

// ---------- AC-7 ----------
test('F17 AC-7 run: a passing feature is passed only after merge + verify, not right after evaluation', async () => {
  const c = contract();
  c.acceptance_criteria = [{ id: 'AC-1', criterion: 'x', check: 'node scripts/has.mjs F9.txt', new: true }];
  c.security_criteria = [];
  c.approval.hash = hashContract(c);
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': c,
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    ...SCRIPTS,
  }, { branch: null });
  const seen = [];
  const { evaluate } = await import('../lib/eval.mjs');
  const deps = {
    build: async (a) => { writeFiles(a.cwd, { 'F9.txt': 'built\n' }); return { ok: true, costUsd: 0 }; },
    runAdapter: adapter(passReply()),
    evaluate: async (a) => {
      const v = await evaluate(a);
      seen.push(['after-eval', v.verdict, statusOf(dir)]);
      return v;
    },
    verify: async (a) => {
      seen.push(['verify', a.cwd.includes('_integration') ? 'merge' : 'feature', statusOf(dir)]);
      return PASS_VERIFY;
    },
  };
  const r = await runFeatures({
    root: dir, config: resolveConfig({ base_branch: 'main', verify: { commands: [] }, budget: { step_timeout_sec: 60 } }), deps,
  });
  assert.equal(r.results[0].status, 'passed', JSON.stringify(r.results));
  assert.deepEqual(seen.find((s) => s[0] === 'after-eval'), ['after-eval', 'pass', 'in_progress']);
  const mergeVerify = seen.find((s) => s[0] === 'verify' && s[1] === 'merge');
  assert.ok(mergeVerify, 'post-merge verify ran');
  assert.equal(mergeVerify[2], 'in_progress', 'not passed before the post-merge verify');
  assert.ok(seen.indexOf(mergeVerify) > seen.findIndex((s) => s[0] === 'after-eval'));
  assert.equal(statusOf(dir), 'passed');
  // The run's verdict says which path wrote it, so interactive status recording never acts on it.
  assert.equal(readJson(path.join(dir, '.harness', 'verdicts', 'F9-r1.json')).origin, 'run');
});

// ---------- AC-8 ----------
const section7 = () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  return spec.slice(spec.indexOf('## 7.'), spec.indexOf('## 8.'));
};
const STATUS_WORDS = ['passed', 'in_progress', 'blocked', 'rounds', 'divergence', 'stall', 'eval_error', 'needs_human'];

test('F17 AC-8 SPEC §7 describes the interactive eval status rules', () => {
  const s = section7();
  for (const w of STATUS_WORDS) assert.ok(s.includes(`\`${w}\``), `SPEC §7 mentions \`${w}\``);
  assert.match(s, /대화형/);
});

test('F17 AC-8 skills/build/SKILL.md describes the interactive eval status rules', () => {
  const s = fs.readFileSync(path.join(REPO, 'skills', 'build', 'SKILL.md'), 'utf8');
  for (const w of STATUS_WORDS) assert.ok(s.includes(`\`${w}\``), `SKILL.md mentions \`${w}\``);
});

// ---------- SC-1 ----------
for (const status of ['passed', 'blocked']) {
  test(`F17 SC-1 eval on a ${status} feature: no adapter call, exit 2, status in message, no verdict file`, async () => {
    const dir = fixture({ status });
    const ra = adapter(passReply());
    const r = await evalCmd(dir, ra);
    assert.equal(r.code, 2);
    assert.equal(ra.calls, 0);
    assert.match(r.err, new RegExp(status));
    assert.deepEqual(verdictFiles(dir), []);
    assert.equal(statusOf(dir), status);
  });
}

test('F17 SC-1 CLI: harness eval on a passed feature exits 2 and names the status', () => {
  const dir = fixture({
    status: 'passed',
    config: { roles: { builder: 'claude', evaluator: 'generic' }, adapters: { generic: { read_only_command: [process.execPath, FAKE_CLI, 'print', REPLY_PASS] } } },
  });
  const r = harness(['eval', 'F9'], { cwd: dir });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /passed/);
  assert.deepEqual(verdictFiles(dir), []);
});

// ---------- SC-2 ----------
test('F17 SC-2 unapproved contract: no adapter call, exit 2, status unchanged', async () => {
  const dir = fixture({ contract: contract({ approve: false }) });
  const ra = adapter(passReply());
  const r = await evalCmd(dir, ra);
  assert.equal(r.code, 2);
  assert.equal(ra.calls, 0);
  assert.equal(statusOf(dir), 'approved');
  assert.deepEqual(verdictFiles(dir), []);
});

test('F17 SC-2 contract edited after approval (hash mismatch): no adapter call, exit 2, status unchanged', async () => {
  const c = contract();
  c.acceptance_criteria[0].criterion = 'edited after approval';
  const dir = fixture({ contract: c, status: 'in_progress' });
  const ra = adapter(passReply());
  const r = await evalCmd(dir, ra);
  assert.equal(r.code, 2);
  assert.equal(ra.calls, 0);
  assert.equal(statusOf(dir), 'in_progress');
});

test('F17 SC-2 feature status todo (not approved): no adapter call, exit 2', async () => {
  const dir = fixture({ status: 'todo' });
  const ra = adapter(passReply());
  const r = await evalCmd(dir, ra);
  assert.equal(r.code, 2);
  assert.equal(ra.calls, 0);
  assert.equal(statusOf(dir), 'todo');
});

// ---------- SC-3 ----------
test('F17 SC-3 --round k of an existing round does not overwrite the verdict and exits 2', async () => {
  const dir = fixture();
  await evalCmd(dir, adapter(failReply('AC-1', 'AC-2')));
  const file = path.join(dir, '.harness', 'verdicts', 'F9-r1.json');
  const before = fs.readFileSync(file, 'utf8');
  const ra = adapter(passReply());
  const r = await evalCmd(dir, ra, ['--round', '1']);
  assert.equal(r.code, 2);
  assert.equal(ra.calls, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(statusOf(dir), 'in_progress');
});

// ---------- ES-1 ----------
test('F17 ES-1 unreadable previous verdict: exit 2 state_corrupt with the path, no stack, status unchanged', async () => {
  const dir = fixture({ status: 'in_progress' });
  const file = path.join(dir, '.harness', 'verdicts', 'F9-r1.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  const ra = adapter(passReply());
  const r = await evalCmd(dir, ra);
  assert.equal(r.code, 2);
  assert.equal(r.error.code, 'state_corrupt');
  assert.ok(r.err.includes(file), r.err);
  assert.equal(ra.calls, 0);
  assert.equal(statusOf(dir), 'in_progress');

  const cli = harness(['eval', 'F9'], { cwd: dir });
  assert.equal(cli.code, 2);
  assert.ok(cli.stderr.includes('F9-r1.json'), cli.stderr);
  assert.ok(!cli.stderr.includes('    at '), cli.stderr);
  assert.equal(statusOf(dir), 'in_progress');
});

// ---------- ES-2 ----------
test('F17 ES-2 features.json write failure keeps the verdict, exits 2 (io); a rerun retries the same round', async () => {
  const dir = fixture();
  const failingSave = () => { throw new HarnessError('features.json: write failed (EACCES); previous content kept', { code: 'io' }); };
  const r1 = await evalCmd(dir, adapter(passReply()), [], { saveFeatures: failingSave });
  assert.equal(r1.code, 2);
  assert.equal(r1.error.code, 'io');
  assert.deepEqual(verdictFiles(dir), ['F9-r1.json']);
  assert.equal(statusOf(dir), 'approved');

  const ra = adapter(passReply());
  const r2 = await evalCmd(dir, ra);
  assert.equal(r2.code, 0, r2.out + r2.err);
  assert.equal(ra.calls, 0, 'the recorded verdict is reused, not re-evaluated');
  assert.deepEqual(verdictFiles(dir), ['F9-r1.json']);
  assert.equal(statusOf(dir), 'passed');
  assert.match(r2.out, /status: passed/);

  // Once recorded, a third run is refused like any passed feature (SC-1).
  const r3 = await evalCmd(dir, adapter(passReply()));
  assert.equal(r3.code, 2);
});

test('F17 ES-2 retry of a blocked round records one backlog item, not two', async () => {
  const dir = fixture({ config: { max_rounds: 1 } });
  const failingSave = () => { throw new HarnessError('write failed', { code: 'io' }); };
  const r1 = await evalCmd(dir, adapter(failReply('AC-1')), [], { saveFeatures: failingSave });
  assert.equal(r1.code, 2);
  const r2 = await evalCmd(dir, adapter());
  assert.equal(r2.code, 1, r2.out + r2.err);
  assert.equal(statusOf(dir), 'blocked');
  assert.equal(backlog(dir).filter((i) => i.source === 'F9-blocked').length, 1);
});

// Verdicts written by `harness run` (no interactive origin) are never re-recorded.
test('F17 ES-2 a run-written verdict is not treated as a pending interactive round', async () => {
  const dir = fixture({ status: 'blocked' });
  const file = path.join(dir, '.harness', 'verdicts', 'F9-r1.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ feature: 'F9', round: 1, verdict: 'pass', blocking: [], verify_pass: true, contract_hash: hashContract(contract()) }));
  const r = await evalCmd(dir, adapter(passReply()));
  assert.equal(r.code, 2);
  assert.equal(statusOf(dir), 'blocked');
});
