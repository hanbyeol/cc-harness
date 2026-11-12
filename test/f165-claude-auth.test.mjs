// F165: harness doctor and the run preflight judge claude authentication without a model call,
// from `claude auth status --json` (loggedIn). Unknown output never blocks a role.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BIN, REPO, tmpdir, fakeNodeCli } from './helpers.mjs';
import { gitRepo } from './gitfixture.mjs';
import { hashContract } from '../lib/contract.mjs';

const claudeAdapter = await import('../lib/adapters/claude.mjs');
const authFromStatus = (s) => {
  assert.equal(typeof claudeAdapter.authFromStatus, 'function', 'claude adapter exports authFromStatus');
  return claudeAdapter.authFromStatus(s);
};

const FAKE_CLAUDE = path.join(REPO, 'test', 'fixtures', 'fake-claude.mjs');
const GIT_DIR = path.dirname(spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim());
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

const PRIVATE = { email: 'f165@example.com', orgName: 'F165 Org', orgId: 'org-f165-id' };
const LOGGED_IN = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', loginExpiresAt: '2026-12-09T17:45:51.283Z', ...PRIVATE, subscriptionType: 'max' };
// Measured 2.1.322 with an empty CLAUDE_CONFIG_DIR: exit 1.
const LOGGED_OUT = { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', loginExpiresAt: null };

const authFile = (reply) => {
  const f = path.join(tmpdir('harness-f165-auth-'), 'auth.json');
  fs.writeFileSync(f, typeof reply === 'string' ? reply : JSON.stringify(reply, null, 2));
  return f;
};

// Runs the CLI with only the fake claude, node and git on PATH (no gemini, no codex).
function harness(args, { cwd, auth, authExit, log } = {}) {
  const env = { ...process.env, [pathKey]: [fakeNodeCli('claude', FAKE_CLAUDE), path.dirname(process.execPath), GIT_DIR].join(path.delimiter) };
  delete env.FAKE_CLAUDE_AUTH;
  delete env.FAKE_CLAUDE_AUTH_EXIT;
  delete env.FAKE_CLAUDE_AUTH_LOG;
  if (auth !== undefined) env.FAKE_CLAUDE_AUTH = authFile(auth);
  if (authExit !== undefined) env.FAKE_CLAUDE_AUTH_EXIT = String(authExit);
  if (log) env.FAKE_CLAUDE_AUTH_LOG = log;
  return spawnSync(process.execPath, [BIN, ...args], { cwd: cwd ?? tmpdir('harness-f165-cwd-'), env, encoding: 'utf8', timeout: 120000 });
}

const claudeLine = (stdout) => stdout.split('\n').find((l) => /^ {2}claude\s/.test(l)) ?? '';

// ------------------------------------------------------------------ AC-1

test('F165 AC-1: authFromStatus reads loggedIn from claude auth status --json', () => {
  assert.deepEqual(authFromStatus({ code: 0, stdout: JSON.stringify(LOGGED_IN) }), { ok: true, via: 'claude.ai' });
  assert.deepEqual(authFromStatus({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' }) }), { ok: true, via: 'api_key' });
  for (const authMethod of ['has space', 'x'.repeat(41), 42, undefined, '']) {
    assert.deepEqual(authFromStatus({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod }) }), { ok: true, via: 'claude' }, String(authMethod));
  }
  const out = authFromStatus({ code: 1, stdout: JSON.stringify(LOGGED_OUT) });
  assert.equal(out.ok, false);
  assert.match(out.reason, /not authenticated/);
  assert.match(out.reason, /claude auth login/);
});

test('F165 AC-1: authFromStatus is null (unknown) for output that is not a loggedIn JSON', () => {
  for (const stdout of ['', 'Not logged in. Run claude auth login to authenticate.', '[]', 'null', '{"loggedIn":"yes"}', '{"authMethod":"claude.ai"}']) {
    assert.equal(authFromStatus({ code: 1, stdout }), null, stdout);
  }
  assert.equal(authFromStatus(null), null);
});

// ------------------------------------------------------------------ AC-2

test('F165 AC-2: doctor runs claude auth status --json once and shows authenticated (claude.ai)', () => {
  const log = path.join(tmpdir('harness-f165-log-'), 'auth.log');
  const r = harness(['doctor'], { auth: LOGGED_IN, log });
  assert.match(claudeLine(r.stdout), /authenticated \(claude\.ai\)/, r.stdout + r.stderr);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['auth status --json']);
  assert.match(r.stdout, /builder\s+claude\s+write\s+usable/);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// ------------------------------------------------------------------ AC-3

test('F165 AC-3: a logged-out claude makes its roles NOT usable in doctor (exit 1)', () => {
  const r = harness(['doctor'], { auth: LOGGED_OUT, authExit: 1 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  for (const role of ['builder', 'evaluator', 'security-reviewer']) {
    const line = r.stdout.split('\n').find((l) => l.trimStart().startsWith(`${role} `)) ?? '';
    assert.match(line, /NOT usable: not authenticated/, line);
  }
  assert.match(claudeLine(r.stdout), /not authenticated/);
});

function runFixture() {
  const c = {
    id: 'F1', title: 'feature F1', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-11-12T00:00:00.000Z', hash: hashContract(c) };
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': c,
    'scripts/ok.mjs': 'process.exit(0);\n',
  }, { branch: null });
}

test('F165 AC-3: the run preflight stops a logged-out claude builder with exit 2 and creates nothing', () => {
  const dir = runFixture();
  const r = harness(['run'], { cwd: dir, auth: LOGGED_OUT, authExit: 1 });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /builder \(claude\): not authenticated/);
  const branches = spawnSync('git', ['branch', '--list'], { cwd: dir, encoding: 'utf8' }).stdout;
  assert.doesNotMatch(branches, /harness\/integration/);
  assert.doesNotMatch(branches, /harness\/F1/);
});

// ------------------------------------------------------------------ AC-4

test('F165 AC-4: doctor never prints the email, organization name or organization id from auth status', () => {
  for (const [auth, authExit] of [[LOGGED_IN, 0], [{ ...LOGGED_OUT, ...PRIVATE }, 1]]) {
    const r = harness(['doctor'], { auth, authExit });
    const all = r.stdout + r.stderr;
    // The output was read: the claude line carries its verdict.
    assert.match(claudeLine(r.stdout), authExit ? /not authenticated/ : /authenticated \(claude\.ai\)/, all);
    for (const v of Object.values(PRIVATE)) assert.ok(!all.includes(v), `${v} in doctor output`);
  }
});

// ------------------------------------------------------------------ AC-5

test('F165 AC-5: SPEC §10 describes the claude auth check and no longer says claude auth is not judged', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s10 = spec.slice(spec.indexOf('\n## 10.'), spec.indexOf('\n## 11.'));
  const line = s10.split('\n').find((l) => l.includes('claude auth status --json'));
  assert.ok(line, 'no §10 line with claude auth status --json');
  assert.match(line, /loggedIn/);
  assert.match(line, /알 수 없/);
  assert.ok(!spec.includes('claude·codex 의 인증은 판정하지 않는다'));
});

// ------------------------------------------------------------------ ES-1

test('F165 ES-1: unknown auth status output leaves claude usable and the CLI line without auth text', () => {
  for (const [auth, authExit] of [['Not logged in. Run claude auth login to authenticate.', 1], ['', 1], [undefined, undefined]]) {
    const log = path.join(tmpdir('harness-f165-log-'), 'auth.log');
    const r = harness(['doctor'], { auth, authExit, log });
    // auth status was asked, and its answer was unknown.
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['auth status --json']);
    const line = claudeLine(r.stdout);
    assert.ok(line, r.stdout + r.stderr);
    assert.doesNotMatch(line, /authenticated/, line);
    assert.match(r.stdout, /builder\s+claude\s+write\s+usable/, r.stdout);
    assert.equal(r.status, 0, `${String(auth)}: ${r.stdout}${r.stderr}`);
  }
});
