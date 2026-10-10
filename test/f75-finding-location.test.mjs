import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';
import { hashContract } from '../lib/contract.mjs';
import { HarnessError } from '../lib/errors.mjs';
import { OUTPUT_SCHEMA, validateOutput } from '../lib/eval.mjs';
import { builderPrompt } from '../lib/run.mjs';
import evalCommand from '../lib/commands/eval.mjs';

const FAKE_CLI = path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs');

const SCRIPTS = {
  'scripts/ok.mjs': 'process.exit(0);\n',
  'scripts/fail.mjs': 'process.exit(3);\n',
};

function contract() {
  const c = {
    id: 'F9', title: 'fixture feature', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'one', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [],
    error_scenarios: [],
    out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-05T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

// The evaluator CLI fails at once: nothing here reaches a real model CLI.
const FAILING_CLI = {
  roles: { builder: 'claude', evaluator: 'generic', 'security-reviewer': 'generic' },
  adapters: { generic: { read_only_command: [process.execPath, FAKE_CLI, 'exit', '1'] } },
};

function fixture({ items = [], secretGlobs } = {}) {
  return gitRepo({
    '.harness/config.json': {
      profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, ...FAILING_CLI,
      ...(secretGlobs ? { secret_globs: secretGlobs } : {}),
    },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': contract(),
    '.harness/backlog.json': { items },
    ...SCRIPTS,
  });
}

const PASS_VERIFY = {
  pass: true, commands: [], warnings: [],
  integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } },
  criteria: [{ id: 'AC-1', pass: true }],
};

const scores = (o = {}) => ({ functionality: 9, quality: 9, security: 9, errors: 9, tests: 9, ...o });
const reply = (json) => ({ ok: true, error: null, text: JSON.stringify(json), json, costUsd: 0, exitCode: 0 });

function adapter(...replies) {
  const q = [...replies];
  const fn = async () => {
    if (!q.length) throw new Error('unexpected adapter call');
    return q.shift();
  };
  return fn;
}

async function evalCmd(dir, runAdapter) {
  const out = [];
  const err = [];
  try {
    const code = await evalCommand({
      root: dir, args: ['F9'], out: (s) => out.push(s), err: (s) => err.push(s),
      deps: { runAdapter, verifyResult: PASS_VERIFY },
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  } catch (e) {
    if (!(e instanceof HarnessError)) throw e;
    return { code: e.exit, out: out.join('\n'), err: [...err, e.message].join('\n'), error: e };
  }
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const backlog = (dir) => readJson(path.join(dir, '.harness', 'backlog.json')).items;
const verdict = (dir) => readJson(path.join(dir, '.harness', 'verdicts', 'F9-r1.json'));
const bySummary = (items) => Object.fromEntries(items.map((i) => [i.summary, i]));

const blockingFinding = (loc, summary = 'broken') => ({
  criterion_id: 'AC-1', dimension: 'functionality', summary, repro: 'node scripts/fail.mjs', ...loc,
});
// A finding outside the contract: never blocks, goes to the backlog.
const backlogFinding = (loc, summary) => ({
  criterion_id: 'AC-9', dimension: 'quality', summary, repro: 'node scripts/fail.mjs', ...loc,
});

// Evaluates one reply whose out_of_scope entries each carry a location; returns backlog items by summary.
async function backlogOf(cases, opts) {
  const dir = fixture(opts);
  const oos = cases.map(([summary, loc]) => ({ summary, ...loc }));
  const r = await evalCmd(dir, adapter(reply({ scores: scores(), findings: [], out_of_scope: oos })));
  assert.equal(r.code, 0, r.out + r.err);
  return bySummary(backlog(dir));
}

// ---------- AC-1 ----------
test('F75 AC-1 findings and out_of_scope offer optional file (string) and line (integer ≥ 1)', () => {
  for (const s of [OUTPUT_SCHEMA.properties.findings.items, OUTPUT_SCHEMA.properties.out_of_scope.items]) {
    assert.deepEqual(s.properties.file, { type: 'string' });
    assert.deepEqual(s.properties.line, { type: 'integer', minimum: 1 });
    assert.ok(!s.required.includes('file'));
    assert.ok(!s.required.includes('line'));
  }
});

test('F75 AC-1 a reply with or without file/line, valid or not, is not a schema error', () => {
  const base = { scores: scores(), out_of_scope: [{ summary: 'o', file: 3, line: 'x' }] };
  assert.deepEqual(validateOutput({ ...base, findings: [blockingFinding({ file: 'a.mjs', line: 2 })] }), []);
  assert.deepEqual(validateOutput({ ...base, findings: [blockingFinding({ file: {}, line: -1 })] }), []);
  assert.deepEqual(validateOutput({ ...base, findings: [blockingFinding({})] }), []);
});

// ---------- AC-2 ----------
test('F75 AC-2 a blocking finding keeps file and line in the verdict and in the next builder prompt', async () => {
  const dir = fixture();
  const r = await evalCmd(dir, adapter(reply({
    scores: scores({ functionality: 3 }), out_of_scope: [],
    findings: [blockingFinding({ file: 'lib/eval.mjs', line: 42 })],
  })));
  assert.equal(r.code, 1, r.out + r.err);
  const v = verdict(dir);
  assert.equal(v.verdict, 'fail');
  assert.equal(v.blocking.length, 1);
  assert.equal(v.blocking[0].file, 'lib/eval.mjs');
  assert.equal(v.blocking[0].line, 42);

  const prompt = builderPrompt({ rolePrompt: 'role', featureId: 'F9', round: 2, attempt: 1, contract: contract(), findings: v.blocking, config: {} });
  const m = /Blocking findings from the previous round[^\n]*\n```json\n([\s\S]*?)\n```/.exec(prompt);
  assert.ok(m, prompt);
  const findings = JSON.parse(m[1]);
  assert.equal(findings[0].file, 'lib/eval.mjs');
  assert.equal(findings[0].line, 42);
  assert.equal(findings[0].criterion_id, 'AC-1');
});

test('F75 AC-2 a blocking finding without a location has no file or line in the verdict', async () => {
  const dir = fixture();
  const r = await evalCmd(dir, adapter(reply({
    scores: scores({ functionality: 3 }), out_of_scope: [], findings: [blockingFinding({})],
  })));
  assert.equal(r.code, 1, r.out + r.err);
  const b = verdict(dir).blocking[0];
  assert.ok(!('file' in b) && !('line' in b), JSON.stringify(b));
});

// ---------- AC-3 ----------
test('F75 AC-3 backlogged findings and out_of_scope entries keep file and line in backlog.json', async () => {
  const dir = fixture();
  const r = await evalCmd(dir, adapter(reply({
    scores: scores(),
    findings: [
      backlogFinding({ file: 'lib/a.mjs', line: 7 }, 'not in contract'),
      { ...blockingFinding({ file: 'lib/b.mjs', line: 8 }, 'not reproduced'), repro: 'node scripts/ok.mjs' },
      { ...blockingFinding({ file: 'lib/c.mjs', line: 9 }, 'no repro'), repro: '' },
    ],
    out_of_scope: [{ summary: 'oos', file: 'docs/SPEC.md', line: 300 }],
  })));
  assert.equal(r.code, 0, r.out + r.err);
  const by = bySummary(backlog(dir));
  assert.equal(by['not in contract'].reason, 'criterion_not_in_contract');
  assert.deepEqual([by['not in contract'].file, by['not in contract'].line], ['lib/a.mjs', 7]);
  assert.equal(by['not reproduced'].reason, 'repro_not_reproduced');
  assert.deepEqual([by['not reproduced'].file, by['not reproduced'].line], ['lib/b.mjs', 8]);
  assert.equal(by['no repro'].reason, 'missing_repro');
  assert.deepEqual([by['no repro'].file, by['no repro'].line], ['lib/c.mjs', 9]);
  assert.equal(by.oos.reason, 'out_of_scope');
  assert.deepEqual([by.oos.file, by.oos.line], ['docs/SPEC.md', 300]);
});

test('F75 AC-3 a repeat reported with the same backlog_id leaves the existing item\'s file and line unchanged', async () => {
  const dir = fixture({ items: [
    { id: 'B1', summary: 'known', file: 'lib/old.mjs', line: 3 },
    { id: 'B2', summary: 'no location' },
  ] });
  const r = await evalCmd(dir, adapter(reply({
    scores: scores(),
    findings: [backlogFinding({ file: 'lib/new.mjs', line: 99, backlog_id: 'B1' }, 'known again')],
    out_of_scope: [{ summary: 'again', backlog_id: 'B2', file: 'lib/x.mjs', line: 5 }],
  })));
  assert.equal(r.code, 0, r.out + r.err);
  const items = backlog(dir);
  assert.equal(items.length, 2, JSON.stringify(items));
  assert.deepEqual([items[0].file, items[0].line, items[0].seen], ['lib/old.mjs', 3, 2]);
  assert.ok(!('file' in items[1]) && !('line' in items[1]), JSON.stringify(items[1]));
  assert.equal(items[1].seen, 2);
});

// ---------- AC-4 ----------
test('F75 AC-4 file without line keeps the file only; line without file is dropped', async () => {
  const by = await backlogOf([
    ['file only', { file: 'lib/a.mjs' }],
    ['line only', { line: 12 }],
  ]);
  assert.equal(by['file only'].file, 'lib/a.mjs');
  assert.ok(!('line' in by['file only']));
  assert.ok(!('file' in by['line only']) && !('line' in by['line only']), JSON.stringify(by['line only']));
});

test('F75 AC-4 a blocking finding with a file and no line keeps the file only in the verdict', async () => {
  const dir = fixture();
  await evalCmd(dir, adapter(reply({
    scores: scores({ functionality: 3 }), out_of_scope: [],
    findings: [blockingFinding({ file: 'lib/a.mjs' }, 'with file'), blockingFinding({ line: 4 }, 'with line')],
  })));
  const by = bySummary(verdict(dir).blocking);
  assert.equal(by['with file'].file, 'lib/a.mjs');
  assert.ok(!('line' in by['with file']));
  assert.ok(!('file' in by['with line']) && !('line' in by['with line']));
});

// ---------- AC-5 ----------
test('F75 AC-5 the evaluator prompt describes file and line as optional output fields', () => {
  const md = fs.readFileSync(path.join(REPO, 'agents', 'evaluator.md'), 'utf8');
  const output = md.slice(md.indexOf('## Output'));
  const section = output.slice(0, output.indexOf('\n## ', 4) === -1 ? undefined : output.indexOf('\n## ', 4));
  assert.match(section, /`file`/);
  assert.match(section, /`line`/);
  assert.match(section, /[Oo]ptional[^\n]*\n?[^\n]*`file`|`file`[^\n]*optional/);
  assert.match(section, /relative to the project root/);
  assert.match(section, /1-based line number/);
});

// ---------- AC-6 ----------
test('F75 AC-6 SPEC §7 describes the optional file/line fields, their validity and where they are recorded', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const start = spec.indexOf('## 7. ');
  const s7 = spec.slice(start, spec.indexOf('\n## 8', start));
  assert.match(s7, /"file":"[^"]*","line":/);
  assert.match(s7, /`file`·`line`/);
  assert.match(s7, /isSecretPath|비밀 경로/);
  assert.match(s7, /512/);
  assert.match(s7, /builder 프롬프트/);
  assert.match(s7, /verdict/);
  assert.match(s7, /backlog/);
});

// ---------- SC-1 ----------
test('F75 SC-1 a secret file drops file and line, the finding is kept as if it had no file', async () => {
  const cases = [
    ['env', { file: '.env', line: 1 }],
    ['env local', { file: 'app/.env.local', line: 2 }],
    ['pem', { file: 'certs/server.pem', line: 3 }],
    ['key', { file: 'k/private.key', line: 4 }],
    ['id', { file: 'home/id_rsa', line: 5 }],
    ['p12', { file: 'store.p12', line: 6 }],
    ['glob', { file: 'secrets/token.txt', line: 7 }],
    ['backslash', { file: 'conf\\.env', line: 8 }],
    ['plain', { file: 'lib/ok.mjs', line: 9 }],
  ];
  const by = await backlogOf(cases, { secretGlobs: ['secrets/**'] });
  for (const [summary] of cases.slice(0, -1)) {
    const item = by[summary];
    assert.ok(item, summary);
    assert.ok(!('file' in item) && !('line' in item), `${summary}: ${JSON.stringify(item)}`);
    assert.equal(item.reason, 'out_of_scope');
  }
  assert.deepEqual([by.plain.file, by.plain.line], ['lib/ok.mjs', 9]);
});

test('F75 SC-1 a blocking finding on a secret file still blocks, without file or line', async () => {
  const dir = fixture();
  const r = await evalCmd(dir, adapter(reply({
    scores: scores({ functionality: 3 }), out_of_scope: [],
    findings: [blockingFinding({ file: 'config/.env.production', line: 3 })],
  })));
  assert.equal(r.code, 1, r.out + r.err);
  const v = verdict(dir);
  assert.equal(v.blocking.length, 1);
  assert.ok(!('file' in v.blocking[0]) && !('line' in v.blocking[0]), JSON.stringify(v.blocking[0]));
  assert.ok(!JSON.stringify(v).includes('.env.production'));
});

// ---------- ES-1 ----------
test('F75 ES-1 an invalid file drops file and line but keeps the finding', async () => {
  const cases = [
    ['empty', { file: '', line: 1 }],
    ['absolute posix', { file: '/etc/passwd', line: 2 }],
    ['absolute windows', { file: 'C:\\x', line: 3 }],
    ['absolute windows slash', { file: 'C:/x', line: 3 }],
    ['unc', { file: '\\\\server\\share\\x', line: 3 }],
    ['dotdot', { file: '../outside.mjs', line: 4 }],
    ['dotdot middle', { file: 'lib/../../x.mjs', line: 4 }],
    ['dotdot backslash', { file: 'lib\\..\\x.mjs', line: 4 }],
    ['newline', { file: 'lib/a\nb.mjs', line: 5 }],
    ['nul', { file: 'lib/a\u0000.mjs', line: 5 }],
    ['del', { file: 'lib/a\u007f.mjs', line: 5 }],
    ['too long', { file: `${'a'.repeat(513)}`, line: 6 }],
    ['not a string', { file: 42, line: 7 }],
    ['max length', { file: `${'b'.repeat(512)}`, line: 8 }],
  ];
  const by = await backlogOf(cases);
  for (const [summary] of cases.slice(0, -1)) {
    const item = by[summary];
    assert.ok(item, summary);
    assert.ok(!('file' in item) && !('line' in item), `${summary}: ${JSON.stringify(item)}`);
  }
  assert.deepEqual([by['max length'].file, by['max length'].line], ['b'.repeat(512), 8]);
  assert.equal(Object.keys(by).length, cases.length);
});

// ---------- ES-2 ----------
test('F75 ES-2 a line that is not an integer ≥ 1 is dropped; the file and the finding stay', async () => {
  const cases = [
    ['zero', { file: 'lib/a.mjs', line: 0 }],
    ['negative', { file: 'lib/a.mjs', line: -1 }],
    ['fraction', { file: 'lib/a.mjs', line: 1.5 }],
    ['string', { file: 'lib/a.mjs', line: '12' }],
    ['null', { file: 'lib/a.mjs', line: null }],
    ['infinite', { file: 'lib/a.mjs', line: Number.MAX_VALUE * 2 }],
  ];
  const by = await backlogOf(cases);
  for (const [summary] of cases) {
    const item = by[summary];
    assert.ok(item, summary);
    assert.equal(item.file, 'lib/a.mjs', summary);
    assert.ok(!('line' in item), `${summary}: ${JSON.stringify(item)}`);
  }
});
