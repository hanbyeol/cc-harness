import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, tmpdir } from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';
import { recordEvent } from '../lib/events.mjs';
import { redactor, redactDeep } from '../lib/failures.mjs';

// F107: event re-redaction covers keys; a leftover salt file in the home directory is ignored.

function fixture(config = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, telemetry: { share: true }, ...config },
    '.harness/features.json': { features: [] },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\nevents/\n',
  }, { branch: null });
}

const listFiles = (d) => {
  try { return fs.readdirSync(d).sort(); } catch { return []; }
};
const saltPath = (home) => path.join(home, '.cc-harness', 'salt');
const homeEnv = (home, hub, extra = {}) => ({ HOME: home, USERPROFILE: home, CC_HARNESS_HUB: hub, ...extra });
const writeSalt = (home, text) => {
  fs.mkdirSync(path.join(home, '.cc-harness'), { recursive: true });
  fs.writeFileSync(saltPath(home), text);
};
const eventText = (dir) => {
  const d = path.join(dir, '.harness', 'events');
  return listFiles(d).filter((n) => n.endsWith('.jsonl')).map((n) => fs.readFileSync(path.join(d, n), 'utf8')).join('');
};

// ---------- AC-3 ----------
const SECRET = 'sekret-value-12345';

test('F107 AC-3: redactDeep redacts object keys too and keeps the values under a keep key', () => {
  const redact = redactor({ F107_SECRET: SECRET });
  const out = redactDeep({ [SECRET]: 'a', nested: [{ [`k-${SECRET}`]: SECRET }], feature: SECRET }, redact, new Set(['feature']), { keys: true });
  assert.equal(JSON.stringify(out).includes('[redacted]'), true);
  assert.deepEqual(Object.keys(out), ['[redacted]', 'nested', 'feature']);
  assert.deepEqual(out.nested, [{ 'k-[redacted]': '[redacted]' }]);
  assert.equal(out.feature, SECRET);
});

test('F107 AC-3: harness events text and --json hide a secret in a data key', () => {
  const dir = fixture();
  const events = path.join(dir, '.harness', 'events');
  fs.mkdirSync(events, { recursive: true });
  const line = {
    ts: '2026-09-01T00:00:00.000Z', stage: 'feedback', type: 'intervention', feature: 'F9',
    harness_version: '2.0.0', profile: 'sdlc', project: 'aaaaaaaaaaaaaaaa',
    data: { kind: 'other', [SECRET]: 'x', nested: { [`path/${SECRET}`]: 1 } },
  };
  fs.writeFileSync(path.join(events, '2026-09.jsonl'), `${JSON.stringify(line)}\n`);
  const env = { F107_SECRET: SECRET };
  for (const args of [['events'], ['events', '--json']]) {
    const r = harness(args, { cwd: dir, env });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal((r.stdout + r.stderr).includes(SECRET), false, r.stdout);
    assert.ok(r.stdout.includes('[redacted]'), r.stdout);
  }
});

test('F107 AC-3: an event written with a secret in a data key does not contain it', () => {
  const dir = fixture();
  process.env.F107_SECRET = SECRET;
  try {
    assert.equal(recordEvent(dir, { stage: 'feedback', type: 'intervention', data: { kind: 'other', [SECRET]: 1, deep: [{ [`a ${SECRET} b`]: true }] } }), true);
  } finally {
    delete process.env.F107_SECRET;
  }
  const text = eventText(dir);
  assert.equal(text.split('\n').filter(Boolean).length, 1);
  assert.equal(text.includes(SECRET), false, text);
  assert.ok(text.includes('[redacted]'), text);
});

// ---------- SC-1 ----------
test('F107 SC-1: two secret keys that redact to the same key are still recorded, neither secret in the file', () => {
  const S1 = 'first-secret-aaaa';
  const S2 = 'second-secret-bbbb';
  const dir = fixture();
  process.env.F107_S1 = S1;
  process.env.F107_S2 = S2;
  try {
    assert.equal(recordEvent(dir, { stage: 'feedback', type: 'intervention', data: { [`${S1}값`]: 1, [`${S2}값`]: 2 } }), true);
  } finally {
    delete process.env.F107_S1;
    delete process.env.F107_S2;
  }
  const text = eventText(dir);
  const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(lines[0].data), ['[redacted]값']);
  assert.equal(text.includes(S1), false, text);
  assert.equal(text.includes(S2), false, text);
  // harness events shows the line without either secret
  const r = harness(['events', '--json'], { cwd: dir, env: { F107_S1: S1, F107_S2: S2 } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).length, 1);
  assert.equal(r.stdout.includes(S1) || r.stdout.includes(S2), false, r.stdout);
});

// ---------- ES-1 ----------
for (const [what, content] of [['not hex', 'not-a-hex-salt'], ['63 hex characters', 'a'.repeat(63)], ['empty', '']]) {
  // (the name predates F116: `harness export` is gone, so a leftover salt file is ignored with no warning)
  test(`F107 ES-1: export --dry-run with a salt file that is ${what} — one warning, exit 0, file unchanged`, () => {
    const home = tmpdir();
    const hub = path.join(tmpdir(), 'hub');
    writeSalt(home, content);
    const dir = fixture();
    const r = harness(['status'], { cwd: dir, env: homeEnv(home, hub) });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.stderr.split('\n').filter(Boolean).length, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /salt/);
    assert.equal(fs.readFileSync(saltPath(home), 'utf8'), content);
    assert.equal(fs.existsSync(hub), false);
  });
}
