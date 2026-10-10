import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpdir } from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';
import { recordEvent } from '../lib/events.mjs';
import { redactor, redactDeep } from '../lib/failures.mjs';
import { planExport, writeExport, exportedFile, SALT_PENDING } from '../lib/telemetry.mjs';
import { autoExport, runExport } from '../lib/commands/export.mjs';
import { HarnessError } from '../lib/errors.mjs';

// F110: a real export never writes with the '<salt-pending>' placeholder, writeExport refuses a
// placeholder plan, and redactDeep redacts keys only when asked (the events ask).

const SALT = 'ab'.repeat(32);

function fixture() {
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, telemetry: { share: true, auto_export: true } },
    '.harness/features.json': { features: [] },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\nevents/\n',
  }, { branch: null });
  recordEvent(dir, { stage: 'feedback', type: 'ci', data: { sha: 'abc123', result: 'failure', tests: ['test one'], test: 'test two' } }, { now: new Date('2026-09-01T00:00:00Z') });
  return dir;
}

// Every path under `dir` (relative), or [] when it does not exist.
function listAll(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(String);
}

// ---------- AC-1 ----------
// A temporary home, so a run against code that ignores getSalt never touches the real salt.
function withHome(fn) {
  const saved = [process.env.HOME, process.env.USERPROFILE];
  const home = tmpdir();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn();
  } finally {
    [process.env.HOME, process.env.USERPROFILE] = saved;
  }
}

test('F110 AC-1 harness export without a salt warns once, writes no bundle and exits 0', () => {
  const dir = fixture();
  const hub = path.join(tmpdir(), 'hub');
  const out = [];
  const err = [];
  const code = withHome(() => runExport({ root: dir, hub, out: (l) => out.push(l), err: (l) => err.push(l), env: {}, getSalt: () => null }));
  assert.equal(code, 0, err.join('\n'));
  assert.equal(err.length, 1, err.join('\n'));
  assert.match(err[0], /^harness: warning: .*salt.* — nothing exported$/);
  assert.equal(out.join('\n').includes(SALT_PENDING), false, out.join('\n'));
  assert.deepEqual(listAll(hub), []);
  assert.equal(fs.existsSync(exportedFile(dir)), false);
});

test('F110 AC-1 the automatic export of run and eval without a salt writes nothing under the hub', () => {
  const dir = fixture();
  const hub = path.join(tmpdir(), 'hub');
  const err = [];
  withHome(() => autoExport({ root: dir, err: (l) => err.push(l), env: { CC_HARNESS_HUB: hub }, getSalt: () => null }));
  assert.equal(err.filter((l) => /— nothing exported$/.test(l)).length, 1, err.join('\n'));
  assert.equal(err.some((l) => l.includes(SALT_PENDING)), false, err.join('\n'));
  assert.deepEqual(listAll(hub), []);
  assert.equal(listAll(hub).some((p) => p.includes(SALT_PENDING)), false);
  assert.equal(fs.existsSync(exportedFile(dir)), false);
});

// ---------- AC-2 ----------
test('F110 AC-2 writeExport refuses a plan made with the placeholder and writes nothing', () => {
  const dir = fixture();
  const hub = tmpdir();
  const now = new Date('2026-10-10T00:00:00Z');
  const pending = planExport(dir, { hub, env: {}, now, salt: SALT_PENDING });
  assert.ok(pending.lines.length > 0);
  assert.throws(() => writeExport(dir, pending, { now }), HarnessError);
  assert.deepEqual(fs.readdirSync(hub), []);
  assert.equal(fs.existsSync(exportedFile(dir)), false);
});

test('F110 AC-2 writeExport refuses a plan whose lines carry a placeholder hash', () => {
  const dir = fixture();
  const hub = tmpdir();
  const now = new Date('2026-10-10T00:00:00Z');
  const real = planExport(dir, { hub, env: {}, now, salt: SALT });
  assert.ok(real.lines.length > 0);
  const mixed = { ...real, lines: real.lines.map((l) => ({ ...l, data: { ...l.data, test: SALT_PENDING } })) };
  assert.throws(() => writeExport(dir, mixed, { now }), HarnessError);
  const pendingDir = { ...real, file: path.join(hub, SALT_PENDING, path.basename(real.file)) };
  assert.throws(() => writeExport(dir, pendingDir, { now }), HarnessError);
  assert.deepEqual(fs.readdirSync(hub), []);
  assert.equal(fs.existsSync(exportedFile(dir)), false);
  // the real plan is still written
  assert.equal(writeExport(dir, real, { now }).count, real.lines.length);
});

// ---------- AC-3 ----------
test('F110 AC-3 redactDeep keeps keys by default and the event paths ask for key redaction', () => {
  const secret = 'f110-secret-value-987';
  const redact = redactor({ F110_SECRET: secret });
  const plain = redactDeep({ [secret]: secret, nested: { [`k-${secret}`]: 1 } }, redact);
  assert.deepEqual(plain, { [secret]: '[redacted]', nested: { [`k-${secret}`]: 1 } });
  const keyed = redactDeep({ [secret]: secret }, redact, undefined, { keys: true });
  assert.deepEqual(keyed, { '[redacted]': '[redacted]' });
  for (const file of [path.join('lib', 'events.mjs'), path.join('lib', 'commands', 'events.mjs')]) {
    const src = fs.readFileSync(path.join(REPO, file), 'utf8');
    const calls = src.split('\n').filter((l) => l.includes('redactDeep(') && !l.includes('import'));
    assert.ok(calls.length > 0, file);
    for (const c of calls) assert.ok(c.includes('keys: true'), `${file}: ${c.trim()}`);
  }
});

// ---------- AC-4 ----------
test('F110 AC-4 SPEC §2 says a real export without a salt writes no bundle and the placeholder is for dry runs only', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s2 = spec.slice(spec.indexOf('## 2.'), spec.indexOf('## 3.'));
  assert.match(s2, /실제 export[^\n]*salt 를 얻지 못하면[^\n]*묶음을 쓰지 않는다/);
  assert.match(s2, /`<salt-pending>` 은\s*dry-run 출력에만 쓰인다/);
});
