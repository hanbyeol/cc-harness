import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, realTmpdir, writeJson, REPO } from './helpers.mjs';
import { gitRepo, git } from './gitfixture.mjs';

// F162: `harness deploy-log record|list` — live apply/rollout results attached to a feature
// in the git-tracked .harness/deployments.jsonl.

const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FEATURES = [
  { id: 'F1', title: 'passed one', status: 'passed' },
  { id: 'F2', title: 'approved one', status: 'approved' },
  { id: 'F3', title: 'blocked one', status: 'blocked', blocked_reason: 'stuck' },
];
const CONFIG = { profile: 'ops', base_branch: 'main', verify: { commands: [] } };

function repo({ config = CONFIG } = {}) {
  return gitRepo({
    '.harness/config.json': config,
    '.harness/features.json': { features: FEATURES },
    '.harness/verdicts/F1-r1.json': { feature: 'F1', round: 1, passed: true },
  });
}

const logFile = (dir) => path.join(dir, '.harness', 'deployments.jsonl');
const records = (dir) => fs.readFileSync(logFile(dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const record = (dir, args, env) => harness(['deploy-log', 'record', ...args], { cwd: dir, env });
const list = (dir, args = []) => harness(['deploy-log', 'list', ...args], { cwd: dir });

test('F162 AC-1 record appends one JSON line with every field and prints a summary', () => {
  const dir = repo();
  const head = git(dir, 'rev-parse', 'HEAD');
  const r1 = record(dir, ['F1', '--apply', '--ok', '--target', 'prod/us-east-1', 'applied tfplan']);
  assert.equal(r1.code, 0, r1.stderr);
  assert.equal(r1.stdout, 'recorded apply ok for F1 (prod/us-east-1)\n');
  const firstLine = fs.readFileSync(logFile(dir), 'utf8');
  assert.equal(firstLine.split('\n').length, 2, 'one line ending in a newline');
  const [a] = records(dir);
  assert.deepEqual(Object.keys(a).sort(), ['at', 'by', 'commit', 'feature', 'kind', 'note', 'result', 'target']);
  assert.equal(a.feature, 'F1');
  assert.equal(a.kind, 'apply');
  assert.equal(a.result, 'ok');
  assert.equal(a.target, 'prod/us-east-1');
  assert.equal(a.note, 'applied tfplan');
  assert.match(a.at, AT);
  assert.equal(a.by, 'Harness Test');
  assert.equal(a.commit, head);

  const r2 = record(dir, ['F1', '--rollout', '--rolled-back', '--target', 'ctx/ns', '--', '-5% error rate, undone']);
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(r2.stdout, 'recorded rollout rolled_back for F1 (ctx/ns)\n');
  const r3 = record(dir, ['F1', '--target', 'stage', '--failed', '--apply', 'apply failed']);
  assert.equal(r3.code, 0, r3.stderr);
  assert.equal(r3.stdout, 'recorded apply failed for F1 (stage)\n');
  const text = fs.readFileSync(logFile(dir), 'utf8');
  assert.ok(text.startsWith(firstLine), 'the existing line is unchanged');
  const all = records(dir);
  assert.equal(all.length, 3);
  assert.deepEqual(all[0], a);
  assert.equal(all[1].kind, 'rollout');
  assert.equal(all[1].result, 'rolled_back');
  assert.equal(all[1].note, '-5% error rate, undone');
  assert.equal(all[2].result, 'failed');
});

test('F162 AC-1 record keeps a last line without newline and has a null commit outside git', () => {
  const dir = repo();
  fs.writeFileSync(logFile(dir), '{"feature":"F1","kind":"apply"}');
  assert.equal(record(dir, ['F1', '--apply', '--ok', '--target', 't', 'n']).code, 0);
  const lines = fs.readFileSync(logFile(dir), 'utf8').split('\n');
  assert.equal(lines[0], '{"feature":"F1","kind":"apply"}');
  assert.equal(JSON.parse(lines[1]).target, 't');

  const plain = realTmpdir('harness-f162-nogit-');
  writeJson(path.join(plain, '.harness', 'config.json'), CONFIG);
  writeJson(path.join(plain, '.harness', 'features.json'), { features: FEATURES });
  const r = record(plain, ['F1', '--apply', '--ok', '--target', 't', 'n']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(records(plain)[0].commit, null);
});

test('F162 AC-2 list prints records in file order, filters by feature, and --json', () => {
  const dir = repo();
  assert.equal(record(dir, ['F1', '--apply', '--ok', '--target', 'prod', 'first']).code, 0);
  assert.equal(record(dir, ['F2', '--rollout', '--failed', '--target', 'kind/default', 'second']).code, 0);
  assert.equal(record(dir, ['F1', '--rollout', '--rolled-back', '--target', 'kind/web', 'third']).code, 0);
  const recs = records(dir);
  const line = (x) => `${x.at} ${x.feature} ${x.kind} ${x.result} ${x.target} — ${x.note}`;

  const all = list(dir);
  assert.equal(all.code, 0, all.stderr);
  assert.equal(all.stdout, recs.map(line).join('\n') + '\n');

  const f1 = list(dir, ['F1']);
  assert.equal(f1.code, 0);
  assert.equal(f1.stdout, [recs[0], recs[2]].map(line).join('\n') + '\n');

  const json = list(dir, ['F2', '--json']);
  assert.equal(json.code, 0);
  const lines = json.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), recs[1]);
  const jsonAll = list(dir, ['--json']);
  assert.deepEqual(jsonAll.stdout.trimEnd().split('\n').map((l) => JSON.parse(l)), recs);
});

test('F162 AC-2 list says no deployments without a file or without matching records', () => {
  const dir = repo();
  for (const args of [[], ['F1'], ['--json']]) {
    const r = list(dir, args);
    assert.equal(r.code, 0, args.join(' '));
    assert.equal(r.stdout, 'no deployments\n', args.join(' '));
  }
  assert.equal(record(dir, ['F1', '--apply', '--ok', '--target', 'prod', 'x']).code, 0);
  const r = list(dir, ['F2']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'no deployments\n');
});

test('F162 AC-3 record does not change status, features.json or verdicts; warns when not passed', () => {
  const dir = repo();
  const features = path.join(dir, '.harness', 'features.json');
  const verdict = path.join(dir, '.harness', 'verdicts', 'F1-r1.json');
  const before = [fs.readFileSync(features, 'utf8'), fs.readFileSync(verdict, 'utf8'), fs.readdirSync(path.dirname(verdict))];

  const ok = record(dir, ['F1', '--apply', '--ok', '--target', 'prod', 'fine']);
  assert.equal(ok.code, 0);
  assert.equal(ok.stderr, '');

  for (const [id, status] of [['F2', 'approved'], ['F3', 'blocked']]) {
    const r = record(dir, [id, '--rollout', '--ok', '--target', 'ctx/ns', 'early']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, `harness: warning: ${id} is ${status}, not passed\n`);
    assert.equal(r.stdout, `recorded rollout ok for ${id} (ctx/ns)\n`);
  }
  assert.deepEqual(records(dir).map((x) => x.feature), ['F1', 'F2', 'F3']);
  assert.deepEqual([fs.readFileSync(features, 'utf8'), fs.readFileSync(verdict, 'utf8'), fs.readdirSync(path.dirname(verdict))], before);
  assert.equal(git(dir, 'status', '--porcelain', '--', '.harness/features.json', '.harness/verdicts'), '');
});

test('F162 AC-4 deploy-log is listed after backlog, has its options and is in the docs', () => {
  const help = harness(['--help'], { cwd: realTmpdir() }).stdout.split('\n')
    .map((l) => /^ {2}(\S+) +/.exec(l)?.[1]).filter(Boolean);
  assert.equal(help[help.indexOf('backlog') + 1], 'deploy-log');
  const own = harness(['deploy-log', '--help'], { cwd: realTmpdir() });
  assert.equal(own.code, 0);
  assert.ok(own.stdout.startsWith('usage: harness deploy-log'), own.stdout);
  const options = own.stdout.slice(own.stdout.indexOf('options:'));
  for (const o of ['--apply', '--rollout', '--ok', '--failed', '--rolled-back', '--target', '--json']) {
    assert.ok(options.includes(o), `options lack ${o}`);
  }
  const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
  assert.ok(read('AGENTS.md').includes('`harness deploy-log`'), 'AGENTS.md');
  assert.ok(read('README.md').includes('`harness deploy-log`'), 'README.md');
  assert.match(read('docs/MAP.md'), /^- lib\/commands\/deploy-log\.mjs — `harness deploy-log/m);
  assert.ok(read('README.md').split('\n').length < 200, 'README.md stays under 200 lines');
});

// The body of the `## <heading>` section, up to the next `## `.
const section = (text, heading) => {
  const start = text.indexOf(`\n${heading}`);
  if (start < 0) return '';
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
};
const frontmatter = (text) => /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];

test('F162 AC-5 plan-review and rollout skills record the result with deploy-log', () => {
  const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
  const plan = read('skills/plan-review/SKILL.md');
  const after = section(plan, '## 4. After apply');
  assert.match(after, /harness deploy-log record F<n> --apply/);
  for (const f of ['--ok', '--failed', '--target']) assert.ok(after.includes(f), `plan-review §4 lacks ${f}`);
  assert.match(after, /workspace|environment/);

  const roll = read('skills/rollout/SKILL.md');
  const s45 = section(roll, '## 4.') + section(roll, '## 5.');
  assert.match(s45, /harness deploy-log record F<n> --rollout/);
  for (const f of ['--ok', '--failed', '--rolled-back', '--target']) assert.ok(s45.includes(f), `rollout §4/§5 lacks ${f}`);
  assert.match(s45, /context/);
  assert.match(s45, /namespace/);

  assert.equal(frontmatter(plan), [
    'name: plan-review',
    'description: Review a terraform plan before apply (iac profile). Use when the user asks to check a terraform plan, review infrastructure changes, or decide whether an apply is safe. Apply always needs the user\'s explicit approval.',
  ].join('\n'));
  assert.equal(frontmatter(roll), [
    'name: rollout',
    'description: Apply a change to a live Kubernetes cluster (ops profile) — observe, get the user\'s approval, apply with a rollback path, verify health, roll back on failure. Use for rollouts, scaling, restarts or image updates. Always human-approved; never part of harness run.',
  ].join('\n'));
});

test('F162 AC-6 SPEC §4 has a deployments.jsonl row and describes deploy-log record and list', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s4 = spec.slice(spec.indexOf('\n## 4.'), spec.indexOf('\n## 5.'));
  const row = s4.split('\n').find((l) => l.startsWith('| `deployments.jsonl` |'));
  assert.ok(row, 'no deployments.jsonl row');
  assert.ok(row.includes('deploy-log record'), 'who writes it');
  for (const f of ['feature', 'kind', 'result', 'target', 'note', 'at', 'by', 'commit']) assert.ok(row.includes(f), `row lacks ${f}`);
  assert.match(row, /status/);
  assert.ok(s4.includes('deploy-log record'), 'record described');
  assert.ok(s4.includes('deploy-log list'), 'list described');
});

test('F162 SC-1 secrets in note and target are redacted before writing, then the note is cut to 500', () => {
  const dir = repo({ config: { ...CONFIG, env_allowlist: ['F162_SAFE_VALUE'] } });
  const secret = 'f162-s3cr3t-token-value';
  const env = { F162_SECRET: secret, F162_SAFE_VALUE: 'visible-allowlisted-value' };
  const r = record(dir, ['F1', '--apply', '--ok', '--target', `prod-${secret}`, `token ${secret} and visible-allowlisted-value`], env);
  assert.equal(r.code, 0, r.stderr);
  const text = fs.readFileSync(logFile(dir), 'utf8');
  assert.ok(!text.includes(secret), text);
  const [a] = records(dir);
  assert.equal(a.target, 'prod-[redacted]');
  assert.equal(a.note, 'token [redacted] and visible-allowlisted-value');
  assert.ok(!r.stdout.includes(secret), r.stdout);

  assert.equal(record(dir, ['F1', '--apply', '--ok', '--target', 't', 'y'.repeat(600)], env).code, 0);
  assert.equal(records(dir)[1].note, 'y'.repeat(500));

  // Redacted first, then cut: a secret crossing the 500th character leaves no fragment.
  assert.equal(record(dir, ['F1', '--apply', '--ok', '--target', 't', 'x'.repeat(490) + secret + 'z'.repeat(50)], env).code, 0);
  assert.equal(records(dir)[2].note, 'x'.repeat(490) + '[redacted]');
  assert.ok(!fs.readFileSync(logFile(dir), 'utf8').includes(secret.slice(0, 10)));
});

test('F162 ES-1 malformed record arguments are usage errors and write nothing', () => {
  const dir = repo();
  const cases = [
    ['F1', '--ok', '--target', 't', 'n'],
    ['F1', '--apply', '--rollout', '--ok', '--target', 't', 'n'],
    ['F1', '--apply', '--target', 't', 'n'],
    ['F1', '--apply', '--ok', '--failed', '--target', 't', 'n'],
    ['F1', '--apply', '--ok', '--rolled-back', '--target', 't', 'n'],
    ['F1', '--apply', '--ok', 'n'],
    ['F1', '--apply', '--ok', '--target', '', 'n'],
    ['F1', '--apply', '--ok', '--target', '  ', 'n'],
    ['F1', '--apply', '--ok', 'n', '--target'],
    ['f1', '--apply', '--ok', '--target', 't', 'n'],
    ['B1', '--apply', '--ok', '--target', 't', 'n'],
    ['--apply', '--ok', '--target', 't', 'n'],
    ['F1', '--apply', '--ok', '--target', 't', 'one', 'two'],
    ['F1', '--apply', '--ok', '--target', 't', '--', 'one', 'two'],
  ];
  for (const args of cases) {
    const r = record(dir, args);
    assert.equal(r.code, 2, `${JSON.stringify(args)}: ${r.stderr}`);
    assert.match(r.stderr, /usage: harness deploy-log/, JSON.stringify(args));
    assert.equal(fs.existsSync(logFile(dir)), false, JSON.stringify(args));
  }
});

test('F162 ES-2 an unknown feature or a missing .harness/ is an error and writes nothing', () => {
  const dir = repo();
  const r = record(dir, ['F99', '--apply', '--ok', '--target', 't', 'n']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown feature F99/);
  assert.equal(fs.existsSync(logFile(dir)), false);

  const bare = realTmpdir('harness-f162-bare-');
  for (const args of [['record', 'F1', '--apply', '--ok', '--target', 't', 'n'], ['list']]) {
    const x = harness(['deploy-log', ...args], { cwd: bare });
    assert.equal(x.code, 2, args.join(' '));
    assert.match(x.stderr, /not initialized/);
    assert.equal(fs.existsSync(path.join(bare, '.harness')), false);
  }
});

test('F162 ES-3 list skips lines that are not JSON with a warning', () => {
  const dir = repo();
  const a = { feature: 'F1', kind: 'apply', result: 'ok', target: 'prod', note: 'one', at: '2026-11-01T00:00:00.000Z', by: null, commit: null };
  const b = { ...a, feature: 'F2', note: 'two', at: '2026-11-02T00:00:00.000Z' };
  fs.writeFileSync(logFile(dir), `${JSON.stringify(a)}\nnot json {\n${JSON.stringify(b)}\n`);
  const r = list(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, 'harness: warning: deployments.jsonl line 2 is not JSON\n');
  assert.equal(r.stdout, '2026-11-01T00:00:00.000Z F1 apply ok prod — one\n2026-11-02T00:00:00.000Z F2 apply ok prod — two\n');
  const j = list(dir, ['F2', '--json']);
  assert.equal(j.code, 0);
  assert.match(j.stderr, /deployments\.jsonl line 2 is not JSON/);
  assert.deepEqual(JSON.parse(j.stdout), b);
});
