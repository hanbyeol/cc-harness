// F73: the CLAUDE.md block tells the agent when to keep going without asking and when to
// stop and ask — a '## When to keep going and when to stop' section before
// '## Convergence rules', in every profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, harness, project, readJson, writeJson } from './helpers.mjs';
import { blockStatus, findBlock, renderBlock } from '../lib/claudemd.mjs';

const HEADING = '## When to keep going and when to stop';
const KEEP_GOING = '- Keep going without asking when the next step needs no decision from the user: fixing a failed verify, the next round while rounds are left, running checks and tests. Put progress notes in the same message as the next action.';
const STOP = '- Stop and ask only when you cannot continue without the user: approving a contract (`harness approve`), a feature that is `blocked`, a criterion that is ambiguous or contradictory, merging or pushing to a protected branch, and anything destructive (deleting data, force-pushing, changing anything outside this repository).';
const REPORT = '- End a long piece of work with what needs the user first, then what changed, then what was found.';
const CLOSING = 'This block is managed by `harness claude-md`;';

// The lines of the section: from its heading up to the blank line before the next heading.
function section(block) {
  const at = block.indexOf(`\n${HEADING}\n`);
  assert.notEqual(at, -1, block);
  const rest = block.slice(at + 1);
  const stop = rest.indexOf('\n\n');
  return (stop === -1 ? rest : rest.slice(0, stop)).split('\n');
}

const PROFILES = ['sdlc', 'iac', 'ops'];

// ---------- AC-1 ----------
test('F73 AC-1 the sdlc block has the keep-going section before Convergence rules', () => {
  for (const block of [renderBlock(), renderBlock({ profile: 'sdlc' }), renderBlock({ profile: 'sdlc', language: 'ko' })]) {
    const at = block.indexOf(`\n${HEADING}\n`);
    const conv = block.indexOf('\n## Convergence rules\n');
    assert.notEqual(at, -1, block);
    assert.notEqual(conv, -1, block);
    assert.ok(at < conv, 'section comes before Convergence rules');
    // Directly before it: no other heading in between.
    assert.ok(!block.slice(at + 1 + HEADING.length, conv).includes('\n## '), 'no heading in between');
    assert.equal(block.split(`\n${HEADING}\n`).length, 2, 'exactly one section');
  }
});

// ---------- AC-2 ----------
test('F73 AC-2 the keep-going line', () => {
  const lines = section(renderBlock());
  assert.ok(lines.includes(KEEP_GOING), lines.join('\n'));
});

// ---------- AC-3 ----------
test('F73 AC-3 the stop-and-ask line', () => {
  const lines = section(renderBlock());
  assert.ok(lines.includes(STOP), lines.join('\n'));
});

// ---------- AC-4 ----------
test('F73 AC-4 the report line', () => {
  const lines = section(renderBlock());
  assert.ok(lines.includes(REPORT), lines.join('\n'));
  assert.deepEqual(lines, [HEADING, KEEP_GOING, STOP, REPORT]);
});

// ---------- AC-5 ----------
test('F73 AC-5 iac and ops blocks have the same section in the same place; the profile section stays before the closing paragraph', () => {
  const sdlc = section(renderBlock());
  for (const profile of ['iac', 'ops']) {
    const block = renderBlock({ profile });
    assert.deepEqual(section(block), sdlc, profile);
    const at = block.indexOf(`\n${HEADING}\n`);
    const conv = block.indexOf('\n## Convergence rules\n');
    assert.ok(at !== -1 && at < conv, profile);
    assert.ok(!block.slice(at + 1 + HEADING.length, conv).includes('\n## '), profile);
    const prof = block.indexOf(`\n## Profile: ${profile}\n`);
    const closing = block.indexOf(`\n\n${CLOSING}`);
    assert.ok(prof !== -1 && closing !== -1 && prof < closing, profile);
    assert.ok(!block.slice(closing + 2).includes('\n## '), `${profile}: the closing paragraph is last`);
    // The profile section directly precedes the closing paragraph.
    assert.ok(!block.slice(prof + 1 + `## Profile: ${profile}`.length, closing).includes('\n## '), profile);
  }
});

// ---------- AC-6 ----------
test('F73 AC-6 this repository CLAUDE.md block matches the new template', () => {
  const buf = fs.readFileSync(path.join(REPO, 'CLAUDE.md'));
  const found = findBlock(buf);
  assert.ok(found, 'CLAUDE.md has a cc-harness block');
  assert.equal(blockStatus(REPO).state, 'current', blockStatus(REPO).reason);
  assert.ok(buf.toString('utf8').includes(`\n${HEADING}\n`));
  const r = harness(['claude-md', '--check'], { cwd: REPO });
  assert.equal(r.code, 0, r.stdout + r.stderr);
});

// ---------- AC-7 ----------
test('F73 AC-7 SPEC §4.1 describes the keep-going section and its three lines', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs/SPEC.md'), 'utf8');
  const sec = spec.slice(spec.indexOf('### 4.1 '), spec.indexOf('**프로필(`profiles/*.json`)**'));
  for (const s of [HEADING.slice(3), 'Keep going without asking', 'Stop and ask only', 'End a long piece of work', 'Convergence rules']) {
    assert.ok(sec.includes(s), `SPEC §4.1: ${s}`);
  }
});

// ---------- ES-1 ----------
test('F73 ES-1 a block written by the pre-feature template is replaced; bytes outside it are kept', () => {
  for (const profile of PROFILES) {
    const dir = project();
    const cfg = path.join(dir, '.harness', 'config.json');
    writeJson(cfg, { ...readJson(cfg), profile });
    const current = renderBlock({ profile });
    // The pre-feature block: the current one without the section and its blank line.
    const old = current
      .replace(`${section(current).join('\n')}\n\n`, '')
      .replace(/^<!-- cc-harness:begin v\S+/, '<!-- cc-harness:begin v0.0.1');
    assert.ok(!old.includes(HEADING));
    const before = Buffer.from('# p\n\nuser text before\n\n', 'utf8');
    const after = Buffer.from('\n\n## Mine\nuser text after, no newline', 'utf8');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), Buffer.concat([before, Buffer.from(old, 'utf8'), after]));
    assert.equal(harness(['claude-md', '--check'], { cwd: dir }).code, 1, profile);
    const r = harness(['claude-md'], { cwd: dir });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const got = fs.readFileSync(path.join(dir, 'CLAUDE.md'));
    const block = Buffer.from(current, 'utf8');
    assert.deepEqual(got.subarray(0, before.length), before, profile);
    assert.deepEqual(got.subarray(before.length, before.length + block.length), block, profile);
    assert.deepEqual(got.subarray(before.length + block.length), after, profile);
    assert.ok(got.toString('utf8').includes(`\n${HEADING}\n${KEEP_GOING}\n${STOP}\n${REPORT}\n`), profile);
  }
});
