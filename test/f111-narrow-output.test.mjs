import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';
import { hashContract } from '../lib/contract.mjs';
import { HarnessError } from '../lib/errors.mjs';
import { OUTPUT_SCHEMA, validateOutput, buildPrompt } from '../lib/eval.mjs';
import evalCommand from '../lib/commands/eval.mjs';

const FAKE_CLI = path.join(REPO, 'test', 'fixtures', 'fake-cli.mjs');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

function contract() {
  const c = {
    id: 'F9', title: 'fixture feature', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'one', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-26T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture(items = []) {
  return gitRepo({
    '.harness/config.json': {
      profile: 'sdlc', base_branch: 'main', verify: { commands: [] },
      roles: { builder: 'claude', evaluator: 'generic', 'security-reviewer': 'generic' },
      adapters: { generic: { read_only_command: [process.execPath, FAKE_CLI, 'exit', '1'] } },
    },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': contract(),
    '.harness/backlog.json': { items },
    'scripts/ok.mjs': 'process.exit(0);\n',
    'scripts/fail.mjs': 'process.exit(3);\n',
  });
}

const PASS_VERIFY = {
  pass: true, commands: [], warnings: [],
  integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } },
  criteria: [{ id: 'AC-1', pass: true }],
};
const scores = () => ({ functionality: 9, quality: 9, security: 9, errors: 9, tests: 9 });
const reply = (json) => ({ ok: true, error: null, text: JSON.stringify(json), json, costUsd: 0, exitCode: 0 });

function adapter(...replies) {
  const q = [...replies];
  const fn = async (role, opts) => {
    fn.calls += 1;
    fn.prompts.push(opts.prompt);
    if (!q.length) throw new Error('unexpected adapter call');
    return q.shift();
  };
  fn.calls = 0;
  fn.prompts = [];
  return fn;
}

async function evalCmd(dir, runAdapter) {
  const out = [];
  try {
    const code = await evalCommand({
      root: dir, args: ['F9'], out: (s) => out.push(s), err: (s) => out.push(s),
      deps: { runAdapter, verifyResult: PASS_VERIFY },
    });
    return { code, out: out.join('\n') };
  } catch (e) {
    if (!(e instanceof HarnessError)) throw e;
    return { code: e.exit, out: out.join('\n') + e.message };
  }
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const backlog = (dir) => readJson(path.join(dir, '.harness', 'backlog.json')).items;
const verdict = (dir) => readJson(path.join(dir, '.harness', 'verdicts', 'F9-r1.json'));
const events = (dir) => {
  const d = path.join(dir, '.harness', 'events');
  let names = [];
  try { names = fs.readdirSync(d).sort(); } catch { return []; }
  return names.flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
};

const buildArgs = (extra = {}) => ({
  rolePrompt: 'role', featureId: 'F9', contract: contract(), diff: { mergeBase: 'a'.repeat(40), text: '', files: ['lib/x.mjs'] },
  base: 'main', vr: PASS_VERIFY, threshold: 7, critical: false, ...extra,
});

test('F111 AC-1 the output schema requires only scores and findings and has no out_of_scope or backlog_id', () => {
  assert.deepEqual(OUTPUT_SCHEMA.required, ['scores', 'findings']);
  assert.equal(OUTPUT_SCHEMA.properties.out_of_scope, undefined);
  assert.equal(OUTPUT_SCHEMA.properties.findings.items.properties.backlog_id, undefined);
  const prompt = buildPrompt(buildArgs());
  const m = prompt.match(/## Output\n[^\n]*\n(`+)json\n([\s\S]*?)\n\1/);
  assert.ok(m, prompt);
  assert.deepEqual(JSON.parse(m[2]), JSON.parse(JSON.stringify(OUTPUT_SCHEMA)));
});

test('F111 AC-2 a non-empty out_of_scope in the reply is ignored: no problem, no backlog, no event', async () => {
  const dir = fixture();
  const json = { scores: scores(), findings: [], out_of_scope: [{ summary: 'one' }, { summary: 'two' }] };
  assert.deepEqual(validateOutput(json), []);
  const r = await evalCmd(dir, adapter(reply(json)));
  assert.equal(r.code, 0, r.out);
  assert.equal(backlog(dir).length, 0);
  assert.ok(!events(dir).some((e) => e.type === 'finding' && e.data?.reason === 'out_of_scope'));
  const v = verdict(dir);
  assert.deepEqual(v.backlogged, []);
  assert.equal(v.verdict, 'pass');
});

test('F111 AC-3 the evaluator prompt has no Open backlog section and no item ids', async () => {
  const dir = fixture([{ id: 'B1', summary: 'first item' }, { id: 'B2', summary: 'second item' }]);
  const a = adapter(reply({ scores: scores(), findings: [] }));
  assert.equal((await evalCmd(dir, a)).code, 0);
  const prompt = a.prompts[0];
  assert.ok(!prompt.includes('Open backlog'));
  assert.ok(!/\bB[12]\b/.test(prompt));
  const items = [{ id: 'B1', summary: 'first item' }, { id: 'B2', summary: 'second item' }];
  assert.equal(buildPrompt(buildArgs({ backlog: items })), buildPrompt(buildArgs()));
});

test('F111 AC-4 a backlog_id on a finding no longer merges into the open item', async () => {
  const dir = fixture([{ id: 'B1', summary: 'known', sources: ['F3-r1'] }]);
  const json = {
    scores: scores(),
    findings: [{ criterion_id: 'AC-1', dimension: 'quality', summary: 'again', repro: 'node scripts/ok.mjs', backlog_id: 'B1' }],
  };
  const r = await evalCmd(dir, adapter(reply(json)));
  assert.equal(r.code, 0, r.out);
  const items = backlog(dir);
  assert.equal(items.length, 2, JSON.stringify(items));
  assert.equal(items[0].seen, undefined);
  assert.deepEqual(items[0].sources, ['F3-r1']);
  assert.equal(items[1].summary, 'again');
  assert.ok(!('backlog_id' in items[1]));
});

test('F111 AC-5 evaluator, security-reviewer and spec skill carry the narrowed wording', () => {
  for (const f of ['agents/evaluator.md', 'agents/security-reviewer.md']) {
    const t = read(f);
    assert.ok(!t.includes('out_of_scope'), f);
    assert.ok(!t.includes('backlog_id'), f);
    assert.ok(t.includes('Report only defects that a repro reproduces'), f);
    assert.ok(t.includes('If you find no reproducible defect, score honestly high'), f);
  }
  assert.ok(!read('skills/spec/SKILL.md').includes('backlog_id'));
});

test('F111 AC-6 SPEC §7 drops out_of_scope, backlog_id, Open backlog and the merge rule', () => {
  const spec = read('docs/SPEC.md');
  assert.ok(!spec.includes('## Open backlog'));
  assert.ok(!spec.includes('반복 지적 합치기'));
  const start = spec.indexOf('2. 출력 JSON 스키마');
  const block = spec.slice(start, spec.indexOf('```', spec.indexOf('```json', start) + 7));
  assert.ok(start > 0 && !block.includes('out_of_scope') && !block.includes('backlog_id'));
  assert.match(spec, /`out_of_scope`·`backlog_id` 가 있어도 무시된다\(오류도 기록도 아님\)/);
});

test('F111 ES-1 a non-array out_of_scope is not a schema mismatch: no re-ask, verdict written', async () => {
  const dir = fixture();
  const json = { scores: scores(), findings: [], out_of_scope: 'x' };
  assert.deepEqual(validateOutput(json), []);
  const a = adapter(reply(json));
  const r = await evalCmd(dir, a);
  assert.equal(r.code, 0, r.out);
  assert.equal(a.calls, 1);
  assert.equal(verdict(dir).verdict, 'pass');
});
