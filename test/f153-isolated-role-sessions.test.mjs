import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpdir } from './helpers.mjs';
import claude, { DENY, UNUSED_TOOLS } from '../lib/adapters/claude.mjs';
import codex from '../lib/adapters/codex.mjs';
import { createGenericAdapter } from '../lib/adapters/generic.mjs';
import { missingFlags } from '../lib/adapters/index.mjs';

// F153: claude role sessions without user hooks and auto-memory; exit 0 without a result wrapper fails.

const settingsOf = (argv) => {
  const i = argv.indexOf('--settings');
  assert.ok(i >= 0, '--settings missing');
  return JSON.parse(argv[i + 1]);
};

// A fake CLI that drains stdin, then writes `out` (may be empty) and exits 0.
function fakeCli(out) {
  const dir = tmpdir('harness-f153-');
  const script = path.join(dir, 'cli.mjs');
  fs.writeFileSync(script, `for await (const _ of process.stdin) { /* drain */ }\nprocess.stdout.write(${JSON.stringify(out)});\n`);
  return script;
}

const runWith = (adapter, out, opts = {}) =>
  adapter.run({ prompt: 'p', bin: process.execPath, binArgs: [fakeCli(out)], timeoutSec: 60, ...opts });

test('F153 AC-1: --settings is followed by JSON that disables hooks and auto-memory', () => {
  for (const readOnly of [false, true]) {
    const s = settingsOf(claude.buildArgs({ readOnly }));
    assert.equal(s.disableAllHooks, true);
    assert.equal(s.autoMemoryEnabled, false);
  }
});

test('F153 AC-2: --settings is a required flag and the 2.1.314 help has it', () => {
  for (const readOnly of [false, true]) {
    assert.ok(claude.requiredFlags({ readOnly }).includes('--settings'));
    const help = fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'help', 'claude-2.1.314.txt'), 'utf8');
    assert.deepEqual(missingFlags(help, claude.requiredFlags({ readOnly })), []);
  }
});

test('F153 AC-3: exit 0 with no stdout is exit_nonzero with "no result"', async () => {
  const r = await runWith(claude, '');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'exit_nonzero');
  assert.match(r.detail, /no result/);
});

test('F153 AC-4: a normal result wrapper is ok with its cost', async () => {
  const r = await runWith(claude, JSON.stringify({ type: 'result', is_error: false, result: 'done', total_cost_usd: 0.01 }));
  assert.equal(r.ok, true);
  assert.equal(r.costUsd, 0.01);
});

test('F153 AC-5: codex and generic still succeed on empty output without a schema', async () => {
  assert.equal((await runWith(codex, '')).ok, true);
  const generic = createGenericAdapter({ adapters: { generic: { command: [process.execPath, fakeCli('')] } } });
  const r = await generic.run({ prompt: 'p', timeoutSec: 60 });
  assert.equal(r.ok, true);
});

test('F153 AC-6: CI triggers on main only', () => {
  const ci = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  const found = [...ci.matchAll(/^\s*branches:\s*(\[[^\]]*\])/gm)].map((m) => m[1].replace(/\s/g, ''));
  assert.deepEqual(found, ['[main]', '[main]']);
});

test('F153 AC-7: SPEC §10 documents --settings and the wrapper-less exit 0', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  assert.match(spec, /disableAllHooks/);
  assert.match(spec, /autoMemoryEnabled/);
  const sentences = spec.split(/(?<=[.。])\s|\n/);
  assert.ok(sentences.some((s) => s.includes('wrapper') && s.includes('exit_nonzero') && s.includes('exit 0')));
});

test('F153 SC-1: --settings holds exactly the two keys', () => {
  for (const readOnly of [false, true]) {
    assert.deepEqual(Object.keys(settingsOf(claude.buildArgs({ readOnly }))).sort(), ['autoMemoryEnabled', 'disableAllHooks']);
  }
});

test('F153 SC-2: permission arguments are unchanged', () => {
  const b = claude.buildArgs({ readOnly: false });
  const i = b.indexOf('--permission-mode');
  assert.equal(b[i + 1], 'auto');
  const d = b.indexOf('--disallowedTools');
  assert.deepEqual(b.slice(d + 1, d + 1 + DENY.length), [...DENY]);
  for (const t of ['CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'PushNotification', 'SendMessage', 'DesignSync', 'EnterWorktree', 'ExitWorktree']) assert.ok(b.includes(t), t);
  const r = claude.buildArgs({ readOnly: true });
  assert.equal(r[r.indexOf('--permission-mode') + 1], 'plan');
  assert.ok(UNUSED_TOOLS.readOnly.every((t) => r.includes(t)));
});

test('F153 ES-1: exit 0 with plain text is exit_nonzero', async () => {
  const r = await runWith(claude, 'hello');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'exit_nonzero');
});

test('F153 ES-2: a usage limit wrapper with exit 0 is still usage_limit', async () => {
  const r = await runWith(claude, JSON.stringify({ type: 'result', is_error: true, api_error: 'usage_limit_reached', result: 'limit' }));
  assert.equal(r.error, 'usage_limit');
});
