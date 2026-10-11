import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness } from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';
import { hashContract } from '../lib/contract.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { evaluate } from '../lib/eval.mjs';

// F101: `harness events` redacts again and repro_program is redacted before lower-casing.

function contract(id = 'F9') {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'one', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [{ id: 'SC-1', criterion: 'no secrets', check: 'node scripts/ok.mjs', new: false }],
    error_scenarios: [{ id: 'ES-1', criterion: 'errors reported', check: 'node scripts/ok.mjs', new: false }],
    out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-09-23T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function fixture({ config = {}, status = 'approved' } = {}) {
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] }, telemetry: { share: true }, ...config },
    '.harness/features.json': { features: [{ id: 'F9', title: 'feature F9', status, depends_on: [] }] },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/contracts/F9.json': contract(),
    'scripts/ok.mjs': 'process.exit(0);\n',
  }, { branch: null });
}

const listFiles = (d) => {
  try { return fs.readdirSync(d).sort(); } catch { return []; }
};

// ---------- AC-3 ----------
test('F101 AC-3: harness events redacts every line it prints, text and --json', () => {
  const SECRET = 'sekret-value-12345';
  const ALLOWED = 'allowed-value-777';
  const dir = fixture({ config: { env_allowlist: ['F101_ALLOWED'] } });
  const events = path.join(dir, '.harness', 'events');
  fs.mkdirSync(events, { recursive: true });
  const line = {
    ts: '2026-09-01T00:00:00.000Z', stage: 'feedback', type: 'intervention', feature: 'F9',
    harness_version: '2.0.0', profile: 'sdlc', project: 'aaaaaaaaaaaaaaaa',
    data: { kind: 'other', text: `token ${SECRET} and ${ALLOWED}`, nested: [{ v: SECRET }] },
  };
  fs.writeFileSync(path.join(events, '2026-09.jsonl'), `${JSON.stringify(line)}\n`);
  const env = { F101_SECRET: SECRET, F101_ALLOWED: ALLOWED };
  const text = harness(['events'], { cwd: dir, env });
  assert.equal(text.code, 0, text.stdout + text.stderr);
  assert.equal(text.stdout.trim().split('\n').length, 1);
  const json = harness(['events', '--json'], { cwd: dir, env });
  assert.equal(json.code, 0, json.stdout + json.stderr);
  const [e] = JSON.parse(json.stdout);
  assert.equal(e.data.kind, 'other');
  for (const r of [text, json]) {
    assert.equal((r.stdout + r.stderr).includes(SECRET), false, r.stdout);
    assert.ok(r.stdout.includes('[redacted]'), r.stdout);
    // an allowed variable's value is not redacted
    assert.ok(r.stdout.includes(ALLOWED), r.stdout);
  }
  // the file itself is not changed
  assert.ok(fs.readFileSync(path.join(events, '2026-09.jsonl'), 'utf8').includes(SECRET));
});

// ---------- AC-4 ----------
const PASS_VERIFY = {
  pass: true, commands: [], warnings: [],
  integrity: { markers: [], harnessPaths: [], testCount: { status: 'unset' } },
  criteria: [{ id: 'AC-1', pass: true }, { id: 'SC-1', pass: true }, { id: 'ES-1', pass: true }],
};
const scores = { functionality: 9, quality: 9, security: 9, errors: 9, tests: 9 };
const reply = (json) => ({ ok: true, error: null, text: JSON.stringify(json), json, costUsd: 0.01, exitCode: 0 });

test('F101 AC-4: repro_program is taken after redaction, so a mixed-case secret is in neither form', async () => {
  const SECRET = 'AbCSecretValue123';
  const dir = fixture();
  const replies = {
    evaluator: [reply({ scores, findings: [{ criterion_id: 'AC-1', dimension: 'functionality', summary: 'defect', repro: `${SECRET} arg` }], out_of_scope: [] })],
    'security-reviewer': [reply({ scores, findings: [], out_of_scope: [] })],
  };
  await evaluate({
    root: dir, featureId: 'F9', base: 'main',
    config: resolveConfig({ base_branch: 'main', roles: { builder: 'claude', evaluator: 'claude', 'security-reviewer': 'claude' }, verify: { commands: [] }, budget: { step_timeout_sec: 30 } }),
    verifyResult: PASS_VERIFY, runAdapter: async (role) => replies[role].shift(),
    env: { ...process.env, F101_TOKEN: SECRET },
  });
  const events = path.join(dir, '.harness', 'events');
  const text = listFiles(events).filter((n) => n.endsWith('.jsonl')).map((n) => fs.readFileSync(path.join(events, n), 'utf8')).join('');
  const findings = text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.stage === 'eval' && e.type === 'finding');
  assert.equal(findings.length, 1);
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes(SECRET.toLowerCase()), false);
  assert.equal(text.toLowerCase().includes(SECRET.toLowerCase()), false);
});

test('F101 AC-3: harness events redacts text and --json the same way with a leftover telemetry key in the config', () => {
  const SECRET = 'sekret-value-67890';
  const dir = fixture({ config: { telemetry: { share: true, auto_export: true } } });
  const events = path.join(dir, '.harness', 'events');
  fs.mkdirSync(events, { recursive: true });
  const line = {
    ts: '2026-09-02T00:00:00.000Z', stage: 'feedback', type: 'decision', feature: 'F9',
    harness_version: '2.0.0', profile: 'sdlc', project: 'aaaaaaaaaaaaaaaa',
    data: { decision: 'split', reason: `token ${SECRET}`, [SECRET]: 1 },
  };
  fs.writeFileSync(path.join(events, '2026-09.jsonl'), `${JSON.stringify(line)}\n`);
  for (const args of [['events'], ['events', '--json']]) {
    const r = harness(args, { cwd: dir, env: { F101_SECRET: SECRET } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal((r.stdout + r.stderr).includes(SECRET), false, r.stdout);
    assert.ok(r.stdout.includes('[redacted]'), r.stdout);
    assert.equal(r.stderr, '');
  }
  // reading the log does not rewrite it
  assert.ok(fs.readFileSync(path.join(events, '2026-09.jsonl'), 'utf8').includes(SECRET));
});
