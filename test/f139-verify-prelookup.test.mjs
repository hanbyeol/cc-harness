import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from './helpers.mjs';
import { gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { hashContract } from '../lib/contract.mjs';
import { verify as realVerify } from '../lib/verify.mjs';
import { initRun } from '../lib/run/state.mjs';

// F139: a run looks the result cache up before it asks for a verify pool slot, so a hit never
// waits; a miss takes the slot and computes its key again inside it.

const SCRIPTS = {
  'scripts/rec.mjs': "import fs from 'node:fs';\nconst [log, kind] = process.argv.slice(2);\n"
    + "fs.appendFileSync(log, `${kind}\\n`);\n",
  // Holds the slot until the release file exists (bounded).
  'scripts/hold.mjs': "import fs from 'node:fs';\nconst [rel, started] = process.argv.slice(2);\nfs.writeFileSync(started, 'x');\n"
    + 'const end = Date.now() + 60000;\nwhile (!fs.existsSync(rel) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));\n',
  'doc.md': 'original\n',
};
const HARNESS_IGNORE = 'wt/\n*.tmp-*\nruns/test-count-cache.json\nruns/verify-cache.json\n';
const q = (p) => JSON.stringify(p.split(path.sep).join('/'));

function mk(id, check) {
  const c = {
    id, title: `feature ${id}`, security_tier: 'standard', version: 1,
    acceptance_criteria: [{ id: 'AC-1', criterion: `${id} ok`, check, new: false }],
    security_criteria: [], error_scenarios: [], out_of_scope: [],
  };
  c.approval = { by: 'test', at: '2026-10-18T00:00:00.000Z', hash: hashContract(c) };
  return c;
}

function setup() {
  const work = tmpdir('harness-f139-');
  const log = path.join(work, 'log.txt');
  const rel = path.join(work, 'release');
  const started = path.join(work, 'started');
  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/backlog.json': { items: [] },
    '.harness/.gitignore': HARNESS_IGNORE,
    '.harness/features.json': { features: ['F8', 'F9'].map((id) => ({ id, title: id, security_tier: 'standard', depends_on: [], status: 'approved' })) },
    '.harness/contracts/F9.json': mk('F9', `node scripts/rec.mjs ${q(log)} check`),
    '.harness/contracts/F8.json': mk('F8', `node scripts/hold.mjs ${q(rel)} ${q(started)}`),
    ...SCRIPTS,
  });
  writeFiles(dir, { 'F9.txt': 'built\n' });
  commitAll(dir, 'feature');
  const config = resolveConfig({
    base_branch: 'main', run: { verify_parallel: 1 }, budget: { step_timeout_sec: 60 },
    verify: { commands: [`node scripts/rec.mjs ${q(log)} command`], check_parallel: 1, ...{} },
  });
  const ctx = initRun({ root: dir, config, ids: ['F8', 'F9'] });
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  const args = (featureId) => ({ root: dir, cwd: dir, featureId, base: 'main', config: ctx.cfg, cpus: 8, round: 1, step: 'verify' });
  // Waits until the holder runs its check (so its own command line is in the log), then clears the log.
  const waitFor = async (f) => {
    for (let i = 0; i < 3000 && !fs.existsSync(f); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(f), `${f} appeared`);
    fs.rmSync(log, { force: true });
  };
  const events = () => {
    const d = path.join(dir, '.harness', 'events');
    return (fs.existsSync(d) ? fs.readdirSync(d).sort() : []).flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  };
  const hold = () => { const p = ctx.runVerify(args('F8')); return p; };
  return { dir, log, rel, started, ctx, lines, args, waitFor, events, hold };
}
const done = (p) => { let s = false; p.then(() => { s = true; }, () => { s = true; }); return () => s; };
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test('F139 AC-1: a stored key finishes as a hit while another verify holds the only slot', async () => {
  const t = setup();
  const first = await t.ctx.runVerify(t.args('F9'));
  assert.equal(first.cache.status, 'miss');
  fs.rmSync(t.log);
  const holder = t.hold();
  const holderDone = done(holder);
  await t.waitFor(t.started);
  const r = await Promise.race([t.ctx.runVerify(t.args('F9')), tick(20000).then(() => 'timeout')]);
  assert.notEqual(r, 'timeout');
  assert.equal(r.cache.status, 'hit');
  assert.equal(holderDone(), false, 'the slot was still held');
  assert.deepEqual(t.lines(), []);
  assert.equal(t.ctx.verifyQueueMs.get('F9'), 0);
  fs.writeFileSync(t.rel, 'go');
  const h = await holder;
  assert.equal(h.pass, true);
});

test('F139 AC-2: a hit has queue_ms 0 while the slot is held (metrics source)', async () => {
  const t = setup();
  await t.ctx.runVerify(t.args('F9'));
  const holder = t.hold();
  await t.waitFor(t.started);
  const a = { ...t.args('F9'), step: 'post_merge_verify' };
  const r = await t.ctx.runVerify(a);
  assert.equal(r.cache.status, 'hit');
  assert.equal(t.ctx.verifyQueueMs.get('F9'), 0);
  fs.writeFileSync(t.rel, 'go');
  await holder;
});

test('F139 AC-3: a miss waits for the slot, then runs everything like verify()', async () => {
  const t = setup();
  const holder = t.hold();
  await t.waitFor(t.started);
  const p = t.ctx.runVerify(t.args('F9'));
  const pDone = done(p);
  await tick(400);
  assert.equal(pDone(), false);
  assert.deepEqual(t.lines(), [], 'nothing ran before the slot was free');
  fs.writeFileSync(t.rel, 'go');
  const r = await p;
  await holder;
  assert.equal(r.cache.status, 'miss');
  assert.ok(t.ctx.verifyQueueMs.get('F9') >= 300);
  assert.deepEqual(t.lines(), ['command', 'check']);
  fs.rmSync(path.join(t.dir, '.harness', 'runs', 'verify-cache.json'));
  const direct = await realVerify({ ...t.args('F9'), cwd: t.dir });
  const pick = (x) => ({ c: x.commands.map((c) => [c.pass, c.exit_code ?? c.exitCode]), k: x.criteria.map((c) => [c.id, c.pass, c.exit_code ?? c.exitCode]), pass: x.pass });
  assert.deepEqual(pick(r), pick(direct));
});

test('F139 AC-4: a change made while waiting is verified and stored under the new tree, the old tree misses', async () => {
  const t = setup();
  const holder = t.hold();
  await t.waitFor(t.started);
  const p = t.ctx.runVerify(t.args('F9'));
  await tick(300);
  fs.writeFileSync(path.join(t.dir, 'doc.md'), 'changed\n');
  fs.writeFileSync(t.rel, 'go');
  const r = await p;
  await holder;
  assert.equal(r.cache.status, 'miss');
  assert.deepEqual(t.lines(), ['command', 'check']);
  const file = path.join(t.dir, '.harness', 'runs', 'verify-cache.json');
  const entry = JSON.parse(fs.readFileSync(file, 'utf8')).entries.find((e) => e.feature === 'F9');
  fs.writeFileSync(path.join(t.dir, 'doc.md'), 'original\n');
  const back = await t.ctx.runVerify(t.args('F9'));
  assert.equal(back.cache.status, 'miss');
  const entries = JSON.parse(fs.readFileSync(file, 'utf8')).entries.filter((e) => e.feature === 'F9');
  assert.notEqual(entry.tree, entries.find((e) => e.key !== entry.key)?.tree);
  assert.equal(t.lines().length, 4);
});

test('F139 AC-5: a result stored by another verify while waiting is a hit inside the slot', async () => {
  const t = setup();
  const holder = t.hold();
  await t.waitFor(t.started);
  const p = t.ctx.runVerify(t.args('F9'));
  await tick(300);
  // Another verify of the same key stores its pass (standalone, outside the pool).
  const other = await realVerify({ ...t.args('F9') });
  assert.equal(other.cache.status, 'miss');
  fs.rmSync(t.log);
  fs.writeFileSync(t.rel, 'go');
  const r = await p;
  await holder;
  assert.equal(r.cache.status, 'hit');
  assert.deepEqual(t.lines(), []);
  assert.ok(t.ctx.verifyQueueMs.get('F9') >= 250);
});

test('F139 AC-6: exactly one verify/cache event per runVerify, with the same data keys', async () => {
  const t = setup();
  await t.ctx.runVerify(t.args('F9'));
  await t.ctx.runVerify(t.args('F9'));
  const ev = t.events().filter((e) => e.stage === 'verify' && e.feature === 'F9');
  const cache = ev.filter((e) => e.type === 'cache');
  assert.deepEqual(cache.map((e) => e.data.status), ['miss', 'hit']);
  for (const e of cache) assert.deepEqual(Object.keys(e.data).sort(), ['status', 'step']);
  assert.equal(ev.filter((e) => e.type === 'phases').length, 2);
  assert.equal(ev.filter((e) => e.type === 'command').length, 1);
});

test('F139 AC-7: SPEC §8, §8.11 and §6.4 describe the lookup before the slot', () => {
  const s = fs.readFileSync(new URL('../docs/SPEC.md', import.meta.url), 'utf8');
  const lines = s.split('\n');
  const pool = lines.find((l) => l.startsWith('- **verify 풀**'));
  assert.match(pool, /슬롯을 잡기 전에 결과 캐시/);
  assert.match(pool, /`queue_ms` 0/);
  const metrics = lines.find((l) => l.startsWith('- `harness run` 은 단계가 끝날 때마다'));
  assert.match(metrics, /슬롯 전 조회[^;]*`queue_ms`|0 이고, miss 면 슬롯 안에서 키를 다시 계산/);
  const hit = lines.find((l) => l.startsWith('- **적중**'));
  assert.match(hit, /슬롯\(§8.10\)을 잡기 전에/);
  assert.match(hit, /슬롯 안에서 키를 다시 계산/);
});

test('F139 ES-1: a corrupt cache file warns once, misses and is rewritten', async () => {
  const t = setup();
  const file = path.join(t.dir, '.harness', 'runs', 'verify-cache.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  const r = await t.ctx.runVerify(t.args('F9'));
  assert.equal(r.cache.status, 'miss');
  assert.equal(r.warnings.filter((w) => w.startsWith('verify cache ')).length, 1, JSON.stringify(r.warnings));
  assert.deepEqual(t.lines(), ['command', 'check']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries.length, 1);
});

test('F139 ES-2: ignored files outside the project (skipped) and cache off run everything once each', async () => {
  const t = setup();
  const off = initRun({ root: t.dir, config: { ...t.ctx.cfg, verify: { ...t.ctx.cfg.verify, cache: 'off' } }, ids: ['F9'], fresh: false }).runVerify;
  const r1 = await off({ ...t.args('F9'), config: { ...t.ctx.cfg, verify: { ...t.ctx.cfg.verify, cache: 'off' } } });
  assert.equal(r1.cache.status, 'off');
  fs.writeFileSync(path.join(t.dir, '.gitignore'), 'stray.txt\n');
  fs.writeFileSync(path.join(t.dir, 'stray.txt'), 'x');
  const r2 = await t.ctx.runVerify(t.args('F9'));
  assert.equal(r2.cache.status, 'skipped');
  assert.match(r2.cache.reason, /ignored files/);
  assert.equal(t.lines().length, 4);
  const c = t.events().filter((e) => e.stage === 'verify' && e.type === 'cache').map((e) => e.data.status);
  assert.deepEqual(c, ['off', 'skipped']);
});

test('F139 ES-3: a missing worktree is rejected with usage', async () => {
  const t = setup();
  await assert.rejects(t.ctx.runVerify({ ...t.args('F9'), cwd: path.join(t.dir, 'nope') }), (e) => e.code === 'usage' && /worktree not found/.test(e.message));
});
