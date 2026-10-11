import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, harness } from './helpers.mjs';
import { gitRepo, writeFiles } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { writeJsonAtomic } from '../lib/state.mjs';
import { verify as realVerify } from '../lib/verify.mjs';
import { runFeatures } from '../lib/run.mjs';
import { recordEvent } from '../lib/events.mjs';

// F109: key redaction only for events, explicit fail reasons in run.

const SECRET = 'sekret-value-12345';
const KEY = `dir/${SECRET}`;

// ---------- AC-1 ----------
function runFixture() {
  const c = {
    id: 'F1', title: 'feature F1', security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: 'ok', check: 'node scripts/ok.mjs', new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-10T00:00:00.000Z', hash: hashContract(c) };
  return gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': 'wt/\nevents/\n*.tmp-*\n',
    '.harness/features.json': { features: [{ id: 'F1', title: 'feature F1', security_tier: 'standard', depends_on: [], status: 'approved' }] },
    '.harness/contracts/F1.json': c,
    'scripts/ok.mjs': 'process.exit(0);\n',
    'scripts/fail.mjs': 'process.exit(1);\n',
  }, { branch: null });
}

const eventText = (dir) => {
  const d = path.join(dir, '.harness', 'events');
  let names = [];
  try { names = fs.readdirSync(d); } catch { /* no events */ }
  return names.filter((n) => n.endsWith('.jsonl')).map((n) => fs.readFileSync(path.join(d, n), 'utf8')).join('');
};

test('F109 AC-1 a secret in a key stays in the run state key and is hidden in the event file', async () => {
  const dir = runFixture();
  const writes = [];
  const spy = (file, data, opts) => {
    writes.push(JSON.parse(JSON.stringify(data)));
    return writeJsonAtomic(file, data, opts);
  };
  const build = async (a) => { writeFiles(a.cwd, { 'F1.txt': `built ${a.attempt}\n` }); return { ok: true, costUsd: 0 }; };
  // The verify result carries an object keyed by a path that holds the secret.
  const verify = async (a) => ({ ...(await realVerify(a)), by_path: { [KEY]: 'v', plain: SECRET } });
  const r = await runFeatures({
    root: dir,
    config: resolveConfig({ base_branch: 'main', verify: { commands: ['node scripts/fail.mjs'] }, budget: { step_timeout_sec: 60 }, max_rounds: 1 }),
    deps: { build, verify, evaluate: async () => { throw new Error('not reached'); }, env: { ...process.env, F109_SECRET: SECRET }, writeJsonAtomic: spy },
  });
  assert.equal(r.results[0].status, 'blocked', JSON.stringify(r.results));
  const saved = writes.map((w) => w.active?.[0]?.lastVerify?.by_path).filter(Boolean);
  assert.ok(saved.length > 0, 'the verify result was saved in the run state');
  // run state: the key is as it was, the value is redacted
  assert.deepEqual(Object.keys(saved.at(-1)), [KEY, 'plain']);
  assert.equal(saved.at(-1).plain, '[redacted]');

  // events: the same object written as event data has neither the key nor the value
  process.env.F109_SECRET = SECRET;
  try {
    assert.equal(recordEvent(dir, { stage: 'feedback', type: 'intervention', data: { kind: 'other', by_path: { [KEY]: 'v', plain: SECRET } } }), true);
  } finally {
    delete process.env.F109_SECRET;
  }
  const text = eventText(dir);
  assert.ok(text.includes('dir/[redacted]'), text);
  assert.equal(text.includes(SECRET), false, text);
  // harness events re-redacts keys in its output too
  for (const args of [['events'], ['events', '--json']]) {
    const e = harness(args, { cwd: dir, env: { F109_SECRET: SECRET } });
    assert.equal(e.code, 0, e.stdout + e.stderr);
    assert.equal((e.stdout + e.stderr).includes(SECRET), false, e.stdout);
  }
});

// ---------- AC-4 ----------
test('F109 AC-4 both fail helpers in run.mjs have no reason default and every call names it', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'run', 'merge.mjs'), 'utf8');
  for (const fn of ['resolveConflict', 'recoverPostMerge']) {
    const start = src.indexOf(`async function ${fn}(`);
    assert.ok(start > 0, fn);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    const def = body.match(/const fail = async \(([^)]*)\)/);
    assert.ok(def, `${fn} defines fail`);
    assert.equal(def[1].includes('reason = '), false, def[0]);
    // each call ends with the reason: a literal, null (derived) or the refusal choice
    const calls = body.split('\n').filter((l) => l.includes('return fail('));
    assert.ok(calls.length > 0, fn);
    const named = /, (?:'[a-z_]+'|null|b\?\.error === 'refusal' \? 'refusal' : (?:'[a-z_]+'|null))\);$/;
    for (const c of calls) assert.match(c.trim(), named);
  }
});

// ---------- AC-5 ----------