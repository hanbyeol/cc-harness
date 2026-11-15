// F179: parallel-first workflow — `harness status` names the features that can be built at
// the same time, the skills and role prompts say to work in parallel and decide on a best
// effort, and config.approval 'auto' lets the plan skill approve without asking.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, harness, project, readJson, writeJson, realTmpdir } from './helpers.mjs';
import { resolveConfig, loadConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
// Whitespace-insensitive: documents wrap lines at different columns.
const flat = (s) => s.replace(/\s+/g, ' ');

// The body of a "## heading" section, up to the next "## " heading.
function section(text, heading) {
  const at = text.indexOf(`\n${heading}\n`);
  assert.notEqual(at, -1, `no section ${heading}`);
  const rest = text.slice(at + heading.length + 2);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

const contract = (id) => ({ id, title: id, security_tier: 'standard', version: 1,
  acceptance_criteria: [{ id: 'AC-1', criterion: 'x', check: 'true' }], security_criteria: [], error_scenarios: [] });

// A project with `n` approved, independent features F1..Fn plus one todo feature.
function projectWith(n) {
  const ids = Array.from({ length: n }, (_, i) => `F${i + 1}`);
  const dir = project([
    ...ids.map((id) => ({ id, title: id, status: 'todo', depends_on: [] })),
    { id: 'F9', title: 'later', status: 'todo', depends_on: [] },
  ]);
  for (const id of ids) writeJson(path.join(dir, '.harness', 'contracts', `${id}.json`), contract(id));
  if (ids.length) assert.equal(harness(['approve', ...ids, '--by', 't'], { cwd: dir }).code, 0);
  return dir;
}

const PARALLEL = (ids) => `parallel: harness run ${ids.join(' ')} — independent, can be built at the same time`;
const parallelLines = (out) => out.split(/\r?\n/).filter((l) => l.startsWith('parallel:'));

test('F179 AC-1 status prints the parallel line with two or more runnable features, not with one or none; --brief too', () => {
  for (const n of [2, 3]) {
    const dir = projectWith(n);
    const ids = Array.from({ length: n }, (_, i) => `F${i + 1}`);
    for (const args of [['status'], ['status', '--brief']]) {
      const r = harness(args, { cwd: dir });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(parallelLines(r.stdout), [PARALLEL(ids)], `${args.join(' ')}: ${r.stdout}`);
    }
  }
  for (const n of [0, 1]) {
    const dir = projectWith(n);
    for (const args of [['status'], ['status', '--brief']]) {
      const r = harness(args, { cwd: dir });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(parallelLines(r.stdout), [], `${n} runnable, ${args.join(' ')}: ${r.stdout}`);
    }
  }
});

test('F179 ES-1 exactly one runnable feature: no parallel line, runnable: <id> still printed; two give the line', () => {
  const one = harness(['status'], { cwd: projectWith(1) });
  assert.equal(one.code, 0, one.stderr);
  assert.match(one.stdout, /^runnable: F1$/m);
  assert.deepEqual(parallelLines(one.stdout), []);
  const two = harness(['status'], { cwd: projectWith(2) });
  assert.match(two.stdout, /^runnable: F1, F2$/m);
  assert.deepEqual(parallelLines(two.stdout), [PARALLEL(['F1', 'F2'])]);
});

test('F179 AC-2 the build skill has a Parallel section: one worktree and builder per feature, or harness run', () => {
  const build = read('skills/build/SKILL.md');
  const par = flat(section(build, '## Parallel'));
  for (const s of ['harness worktree add', 'harness run', 'one writer per worktree']) assert.ok(par.includes(s), `## Parallel: ${s}`);
  assert.match(par, /runnable/);
});

test('F179 AC-3 the build skill says to keep working while verify or eval runs', () => {
  const build = flat(read('skills/build/SKILL.md'));
  assert.ok(build.includes('while verify or eval runs'), 'while verify or eval runs');
});

test('F179 AC-4 every role prompt says to make independent tool calls in parallel in one turn', () => {
  for (const f of ['agents/builder.md', 'agents/evaluator.md', 'agents/security-reviewer.md']) {
    assert.ok(flat(read(f)).includes('in parallel in one turn'), f);
  }
});

test('F179 AC-5 the builder prompt says to run the full suite once, after iterating on checks and changed test files', () => {
  const b = flat(read('agents/builder.md'));
  assert.ok(b.includes('full suite once'), 'full suite once');
});

test('F179 AC-6 spec drafts several contracts together; plan presents and approves them in one batch', () => {
  assert.ok(flat(read('skills/spec/SKILL.md')).includes('draft them together'), 'spec: draft them together');
  const plan = flat(read('skills/plan/SKILL.md'));
  assert.ok(plan.includes('in one batch'), 'plan: in one batch');
  assert.ok(plan.includes('harness approve F{n} F{m}'), 'plan: harness approve F{n} F{m}');
});

test('F179 AC-7 SPEC has a parallel-first section describing the status line and the guidance', () => {
  const spec = read('docs/SPEC.md');
  const at = spec.indexOf('### 2.1 병렬 우선 워크플로');
  assert.notEqual(at, -1, 'SPEC §2.1');
  const sec = flat(spec.slice(at, spec.indexOf('\n## ', at)));
  for (const s of ['parallel: harness run', 'harness worktree add', 'one writer per worktree', 'while verify or eval runs',
    'in parallel in one turn', 'full suite once', 'draft them together', 'in one batch']) {
    assert.ok(sec.includes(s), `SPEC §2.1: ${s}`);
  }
});

test('F179 AC-8 spec and build decide on a best effort and limit questions to approve, blocked, destructive or outside work', () => {
  for (const f of ['skills/spec/SKILL.md', 'skills/build/SKILL.md']) {
    const t = flat(read(f));
    assert.ok(t.includes('best effort'), `${f}: best effort`);
    for (const s of ['harness approve', 'blocked', 'destructive', 'outside the repository', 'in one message']) assert.ok(t.includes(s), `${f}: ${s}`);
  }
});

test('F179 AC-9 approval defaults to user, init writes auto, approve --by auto freezes by hash', () => {
  assert.equal(resolveConfig({}).approval, 'user');
  assert.equal(resolveConfig({ approval: 'auto' }).approval, 'auto');
  const dir = realTmpdir('harness-f179-');
  const r = harness(['init'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readJson(path.join(dir, '.harness', 'config.json')).approval, 'auto');
  assert.equal(loadConfig(dir).approval, 'auto');
  writeJson(path.join(dir, '.harness', 'features.json'), { features: [{ id: 'F1', title: 'a', status: 'todo', depends_on: [] }] });
  writeJson(path.join(dir, '.harness', 'contracts', 'F1.json'), contract('F1'));
  const ap = harness(['approve', 'F1', '--by', 'auto'], { cwd: dir });
  assert.equal(ap.code, 0, ap.stderr);
  const c = readJson(path.join(dir, '.harness', 'contracts', 'F1.json'));
  assert.equal(c.approval.by, 'auto');
  assert.equal(c.approval.hash, hashContract(c));
  assert.equal(readJson(path.join(dir, '.harness', 'features.json')).features[0].status, 'approved');
  // Frozen as before: an edit after approval is a hash mismatch.
  writeJson(path.join(dir, '.harness', 'contracts', 'F1.json'), { ...c, title: 'changed' });
  assert.notEqual(harness(['lint-contract', 'F1'], { cwd: dir }).code, 0);
});

test('F179 ES-2 an approval other than auto or user is config_invalid; auto is accepted', () => {
  for (const bad of [true, 'yes', null, 1, 'Auto']) {
    const dir = project();
    const cfg = path.join(dir, '.harness', 'config.json');
    writeJson(cfg, { ...readJson(cfg), approval: bad });
    const r = harness(['status', '--brief'], { cwd: dir });
    assert.equal(r.code, 2, `${JSON.stringify(bad)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /'approval'/);
    assert.match(r.stderr, /config_invalid|must be 'auto' or 'user'/);
    assert.throws(() => resolveConfig({ approval: bad }), (e) => e.code === 'config_invalid');
  }
  for (const ok of ['auto', 'user']) {
    const dir = project();
    const cfg = path.join(dir, '.harness', 'config.json');
    writeJson(cfg, { ...readJson(cfg), approval: ok });
    assert.equal(harness(['status', '--brief'], { cwd: dir }).code, 0, ok);
    assert.equal(resolveConfig({ approval: ok }).approval, ok);
  }
});

test('F179 AC-10 plan approves with --by auto when approval is "auto"; AGENTS.md, the CLAUDE.md block and SPEC say the same', () => {
  const plan = flat(read('skills/plan/SKILL.md'));
  assert.ok(plan.includes('approval is "auto"'), 'plan: approval is "auto"');
  assert.ok(plan.includes('harness approve F{n} --by auto'), 'plan: harness approve F{n} --by auto');
  assert.ok(plan.includes('approval is "user"'), 'plan: approval is "user" asks as before');
  assert.match(plan, /best solution/);
  for (const f of ['AGENTS.md', 'templates/claude-block.md']) {
    const t = flat(read(f));
    assert.ok(t.includes('approval is "auto"'), `${f}: approval is "auto"`);
    assert.ok(t.includes('--by auto'), `${f}: --by auto`);
    assert.match(t, /blocked[^.]*stay[s]? with the user/, `${f}: blocked decisions stay with the user`);
  }
  const block = flat(read('templates/claude-block.md'));
  const prohibited = flat(section(read('templates/claude-block.md'), '## Prohibited'));
  assert.match(prohibited, /`harness approve` without the user's approval, unless config\.approval is "auto"/);
  assert.ok(block.includes('only after **explicit approval**'), 'the user-approval rule is kept');
  const spec = flat(read('docs/SPEC.md'));
  assert.ok(spec.includes('`approval`'), 'SPEC: approval key');
  assert.ok(spec.includes('--by auto'), 'SPEC: --by auto');
  // The repository's own CLAUDE.md block carries the new rule.
  assert.ok(flat(read('CLAUDE.md')).includes('approval is "auto"'), 'CLAUDE.md block regenerated');
});
