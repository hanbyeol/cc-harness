import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { harness, fakeNodeCli, readJson, writeJson, REPO } from './helpers.mjs';
import { gitRepo, git, commitAll } from './gitfixture.mjs';

const GH_DIR = fakeNodeCli('gh', path.join(REPO, 'test', 'fixtures', 'fake-gh.mjs'));
// The directory of git's own programs: git without gh, for "gh is not on PATH".
const GIT_ONLY = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();

// The environment with PATH replaced (any spelling of the name, so Windows' Path does not win).
function withPath(dirs) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== 'path') env[k] = v;
  env.PATH = dirs.join(path.delimiter);
  return env;
}
const FAKE_ENV = withPath([GH_DIR, process.env.PATH || process.env.Path || '']);
const NO_GH_ENV = withPath([path.resolve(GIT_ONLY)]);

const runs = {
  ok: (id, wf = 'CI') => ({ databaseId: id, name: wf, workflowName: wf, status: 'completed', conclusion: 'success', url: `https://github.com/x/y/actions/runs/${id}` }),
  done: (id, conclusion, wf = 'CI') => ({ ...runs.ok(id, wf), conclusion }),
  pending: (id, wf = 'CI') => ({ ...runs.ok(id, wf), status: 'in_progress', conclusion: '' }),
};

function setup({ origin = 'https://github.com/x/y.git', ci, responses = {} } = {}) {
  const dir = gitRepo({ 'a.txt': 'a\n' });
  if (origin) git(dir, 'remote', 'add', 'origin', origin);
  const init = harness(['init'], { cwd: dir });
  assert.equal(init.code, 0, init.stderr);
  if (ci !== undefined) {
    const file = path.join(dir, '.harness', 'config.json');
    writeJson(file, { ...readJson(file), ci });
  }
  respond(dir, responses);
  return dir;
}
function respond(dir, responses) {
  const d = path.join(dir, '.git', 'fake-gh');
  fs.rmSync(d, { recursive: true, force: true });
  writeJson(path.join(d, 'responses.json'), responses);
}
const calls = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, '.git', 'fake-gh', 'calls.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};
const ci = (dir, args = [], env = FAKE_ENV) => harness(['ci', ...args], { cwd: dir, env });
const brief = (dir, env = FAKE_ENV) => harness(['status', '--brief'], { cwd: dir, env });
const lines = (s) => s.trimEnd().split(/\r?\n/);
const head = (dir, rev = 'HEAD') => git(dir, 'rev-parse', rev);

test('F186 AC-1 all runs succeeded: one line per run, ci <sha7>: success, exit 0', () => {
  const dir = setup({ responses: { list: { json: [runs.ok(11), runs.done(12, 'skipped', 'Docs'), runs.done(13, 'neutral', 'Lint')] } } });
  const sha = head(dir);
  const r = ci(dir);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const out = lines(r.stdout);
  assert.ok(out.includes('CI  success  https://github.com/x/y/actions/runs/11'), r.stdout);
  assert.ok(out.includes('Docs  skipped  https://github.com/x/y/actions/runs/12'), r.stdout);
  assert.ok(out.includes('Lint  neutral  https://github.com/x/y/actions/runs/13'), r.stdout);
  assert.equal(out.at(-1), `ci ${sha.slice(0, 7)}: success`);
  const c = calls(dir);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].slice(0, 2), ['run', 'list']);
  assert.equal(c[0][c[0].indexOf('--commit') + 1], sha);
  assert.ok(c[0][c[0].indexOf('--json') + 1].split(',').includes('conclusion'));

  // <rev> is resolved to its commit: main is not HEAD after a new commit on the branch.
  const main = head(dir, 'main');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  commitAll(dir, 'second');
  respond(dir, { list: { json: [runs.ok(21)] } });
  const m = ci(dir, ['main']);
  assert.equal(m.code, 0, m.stderr);
  assert.equal(lines(m.stdout).at(-1), `ci ${main.slice(0, 7)}: success`);
  const mc = calls(dir)[0];
  assert.equal(mc[mc.indexOf('--commit') + 1], main);
});

test('F186 AC-2 a failed run prints its failed jobs and ci <sha7>: failure, exit 1', () => {
  const dir = setup({
    responses: {
      list: { json: [runs.done(11, 'failure'), runs.ok(12, 'Docs')] },
      'view:11': { json: { jobs: [{ name: 'test (windows-latest)', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'completed', conclusion: 'success' }] } },
    },
  });
  const sha7 = head(dir).slice(0, 7);
  const r = ci(dir);
  assert.equal(r.code, 1, r.stderr + r.stdout);
  const out = lines(r.stdout);
  assert.ok(out.includes('CI  failure  https://github.com/x/y/actions/runs/11'), r.stdout);
  assert.ok(out.includes('  failed job: test (windows-latest)'), r.stdout);
  assert.ok(!out.includes('  failed job: lint'), r.stdout);
  assert.equal(out.at(-1), `ci ${sha7}: failure`);
  const views = calls(dir).filter((a) => a[1] === 'view');
  assert.deepEqual(views.map((a) => a[2]), ['11']);
  assert.ok(views[0].includes('--json') && views[0].includes('jobs'));

  for (const conclusion of ['cancelled', 'timed_out', 'startup_failure', 'action_required']) {
    respond(dir, { list: { json: [runs.done(31, conclusion)] }, 'view:31': { json: { jobs: [{ name: 'build', conclusion }] } } });
    const x = ci(dir);
    assert.equal(x.code, 1, `${conclusion}: ${x.stderr}`);
    assert.ok(lines(x.stdout).includes('  failed job: build'), x.stdout);
    assert.equal(lines(x.stdout).at(-1), `ci ${sha7}: failure`);
  }
});

test('F186 AC-3 a run not completed is pending (exit 3); --wait polls until all are completed', () => {
  const dir = setup({ ci: { poll_sec: 1 }, responses: { list: { json: [runs.pending(11), runs.ok(12, 'Docs')] } } });
  const sha7 = head(dir).slice(0, 7);
  const r = ci(dir);
  assert.equal(r.code, 3, r.stderr + r.stdout);
  assert.equal(lines(r.stdout).at(-1), `ci ${sha7}: pending`);
  assert.equal(calls(dir).length, 1);

  // Contrast: a failed run next to a pending one is a failure, not pending.
  respond(dir, { list: { json: [runs.pending(11), runs.done(12, 'failure', 'Docs')] }, 'view:12': { json: { jobs: [{ name: 'docs', conclusion: 'failure' }] } } });
  const f = ci(dir);
  assert.equal(f.code, 1, f.stdout);
  assert.equal(lines(f.stdout).at(-1), `ci ${sha7}: failure`);

  respond(dir, { list: [{ json: [runs.pending(11)] }, { json: [runs.ok(11)] }] });
  const w = ci(dir, ['--wait']);
  assert.equal(w.code, 0, w.stderr + w.stdout);
  assert.equal(lines(w.stdout).at(-1), `ci ${sha7}: success`);
  assert.equal(calls(dir).filter((a) => a[1] === 'list').length, 2);

  respond(dir, { list: [{ json: [runs.pending(11)] }, { json: [runs.done(11, 'failure')] }], 'view:11': { json: { jobs: [{ name: 'test', conclusion: 'failure' }] } } });
  const wf = ci(dir, ['--wait']);
  assert.equal(wf.code, 1, wf.stderr + wf.stdout);
  assert.ok(lines(wf.stdout).includes('  failed job: test'));
  assert.equal(lines(wf.stdout).at(-1), `ci ${sha7}: failure`);
});

test('F186 AC-4 status --brief names a failing base branch run; a successful one prints nothing', () => {
  const sha = 'abcdef0123456789abcdef0123456789abcdef01';
  const dir = setup({ responses: { branch: { json: [{ databaseId: 5, headSha: sha, name: 'CI', workflowName: 'CI', status: 'completed', conclusion: 'failure', url: 'u' }] } } });
  const r = brief(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(lines(r.stdout).includes('ci: main abcdef0 failing — CI (harness ci abcdef0)'), r.stdout);
  const c = calls(dir);
  assert.equal(c.length, 1);
  assert.equal(c[0][c[0].indexOf('--branch') + 1], 'main');
  assert.equal(c[0][c[0].indexOf('--limit') + 1], '1');

  respond(dir, { branch: { json: [{ databaseId: 6, headSha: sha, name: 'CI', workflowName: 'CI', status: 'completed', conclusion: 'success', url: 'u' }] } });
  const s = brief(dir);
  assert.equal(s.code, 0, s.stderr);
  assert.ok(!s.stdout.includes('ci:'), s.stdout);
  assert.ok(s.stdout.startsWith('harness:'), s.stdout);
  assert.equal(calls(dir).length, 1);
});

test('F186 AC-5 CI is checked only for a github.com origin and ci.enabled not false', () => {
  const failing = { branch: { json: [{ databaseId: 5, headSha: 'abcdef0123456789', workflowName: 'CI', status: 'completed', conclusion: 'failure' }] }, list: { json: [runs.ok(1)] } };
  const cases = [
    setup({ ci: { enabled: false }, responses: failing }),
    setup({ origin: 'https://gitlab.com/x/y.git', responses: failing }),
    setup({ origin: 'git@gitlab.com:x/y.git', responses: failing }),
    setup({ origin: null, responses: failing }),
  ];
  for (const dir of cases) {
    const r = ci(dir);
    assert.equal(r.code, 2, r.stdout);
    assert.ok(r.stderr.includes('ci: not enabled for this project'), r.stderr);
    const b = brief(dir);
    assert.equal(b.code, 0, b.stderr);
    assert.ok(!b.stdout.includes('ci:'), b.stdout);
    assert.deepEqual(calls(dir), []);
  }
  // Contrast: github.com origins, https and ssh, are checked.
  for (const origin of ['https://github.com/x/y.git', 'git@github.com:x/y.git', 'ssh://git@github.com/x/y']) {
    const dir = setup({ origin, ci: { enabled: true }, responses: failing });
    const b = brief(dir);
    assert.equal(b.code, 0, b.stderr);
    assert.ok(b.stdout.includes('ci: main abcdef0 failing'), `${origin}: ${b.stdout}`);
    assert.equal(calls(dir).length, 1, origin);
    const r = ci(dir);
    assert.equal(r.code, 0, `${origin}: ${r.stderr}`);
    assert.equal(calls(dir).length, 2, origin);
  }
});

const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

test('F186 AC-6 the skills and AGENTS.md watch CI in the background after a push', () => {
  for (const f of ['skills/auto/SKILL.md', 'skills/build/SKILL.md', 'skills/fix/SKILL.md', 'AGENTS.md']) {
    const text = read(f).replace(/\s+/g, ' ');
    const i = text.indexOf('harness ci --wait');
    assert.ok(i >= 0, `${f}: harness ci --wait`);
    const para = text.slice(Math.max(0, i - 300), i + 900);
    assert.match(para, /push/i, f);
    assert.match(para, /in the background/i, f);
    assert.match(para, /without waiting/i, f);
    assert.match(para, /exit 1/, f);
    assert.match(para, /failed job/i, f);
    assert.match(para, /REGRESSION/, f);
    assert.match(para, /new commit/i, f);
    assert.match(para, /no force-push/i, f);
    assert.match(para, /rewrit/i, f);
    assert.match(para, /exit 2/, f);
    assert.match(para, /tell the user/i, f);
  }
});

test('F186 AC-7 ci is in the help, the SPEC and the README command list', () => {
  const top = harness(['--help'], { cwd: REPO });
  assert.equal(top.code, 0);
  assert.match(top.stdout, /^ {2}ci +\S/m);
  const h = harness(['ci', '--help'], { cwd: REPO });
  assert.equal(h.code, 0, h.stderr);
  assert.ok(h.stdout.startsWith('usage: harness ci [<rev>] [--wait]'), h.stdout);
  assert.ok(h.stdout.includes('--wait'));
  const spec = read('docs/SPEC.md');
  for (const s of ['`harness ci [<rev>] [--wait]`', 'ci: <base_branch> <sha7> failing', 'ci.enabled', 'ci.poll_sec', 'ci.find_timeout_sec', 'ci.timeout_sec', 'gh not found (install the GitHub CLI)']) {
    assert.ok(spec.includes(s), s);
  }
  const readme = read('README.md').split('\n');
  const line = readme.find((l) => l.includes('`harness ci`'));
  assert.ok(line, 'README lists harness ci');
  assert.ok(line.includes('`harness merge-check`') || line.includes('`harness run`'), line);
});

test('F186 ES-1 gh missing or failing exits 2 with the reason', () => {
  const dir = setup({ responses: { list: { code: 1, stderr: 'error connecting to api.github.com\nTo get started with GitHub CLI, please run:  gh auth login\n' } } });
  const missing = ci(dir, [], NO_GH_ENV);
  assert.equal(missing.code, 2, missing.stdout);
  assert.ok(missing.stderr.includes('gh not found (install the GitHub CLI)'), missing.stderr);
  assert.deepEqual(calls(dir), []);
  const r = ci(dir);
  assert.equal(r.code, 2, r.stdout);
  assert.ok(r.stderr.includes('To get started with GitHub CLI, please run:  gh auth login'), r.stderr);
  assert.ok(!r.stderr.includes('error connecting'), r.stderr);
  // Contrast: a gh that answers is used.
  respond(dir, { list: { json: [runs.ok(1)] } });
  assert.equal(ci(dir).code, 0);
});

test('F186 ES-2 no run for the commit, or runs that never complete, exit 2', () => {
  // Bounds several poll intervals wide, so a slow gh start under load still leaves room for a second read.
  const dir = setup({ ci: { poll_sec: 1, find_timeout_sec: 6, timeout_sec: 6 }, responses: { list: { json: [] } } });
  const sha7 = head(dir).slice(0, 7);
  const now = ci(dir);
  assert.equal(now.code, 2, now.stdout);
  assert.ok(now.stderr.includes(`no CI run for ${sha7}`), now.stderr);
  assert.equal(calls(dir).length, 1);

  respond(dir, { list: { json: [] } });
  const w = ci(dir, ['--wait']);
  assert.equal(w.code, 2, w.stdout);
  assert.ok(w.stderr.includes(`no CI run for ${sha7}`), w.stderr);
  assert.ok(calls(dir).length >= 2, 'polled again before giving up');

  respond(dir, { list: { json: [runs.pending(11)] } });
  const t = ci(dir, ['--wait']);
  assert.equal(t.code, 2, t.stdout);
  assert.ok(t.stderr.includes(`ci ${sha7}: timed out waiting`), t.stderr);
  assert.ok(calls(dir).length >= 2, 'polled again before giving up');

  // Contrast: a run that appears on the second read is waited for.
  respond(dir, { list: [{ json: [] }, { json: [runs.ok(11)] }] });
  const ok = ci(dir, ['--wait']);
  assert.equal(ok.code, 0, ok.stderr);
});

test('F186 ES-3 status --brief omits the ci line when gh is missing, fails, prints no JSON or hangs', () => {
  const failing = { json: [{ databaseId: 5, headSha: 'abcdef0123456789', workflowName: 'CI', status: 'completed', conclusion: 'failure' }] };
  const dir = setup({ responses: { branch: failing } });
  // Contrast: the line is there when gh answers.
  assert.ok(brief(dir).stdout.includes('ci: main abcdef0 failing'));

  const check = (r) => {
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.startsWith('harness: no features'), r.stdout);
    assert.ok(!r.stdout.includes('ci:'), r.stdout);
  };
  check(brief(dir, NO_GH_ENV));
  respond(dir, { branch: { code: 1, stderr: 'not logged in\n' } });
  check(brief(dir));
  respond(dir, { branch: { stdout: 'not json at all' } });
  check(brief(dir));
  respond(dir, { branch: { ...failing, sleep_ms: 10000, done_file: 'slept' } });
  const start = Date.now();
  const slow = brief(dir);
  const elapsed = Date.now() - start;
  check(slow);
  assert.equal(calls(dir).length, 1, 'gh was called');
  assert.ok(!fs.existsSync(path.join(dir, '.git', 'fake-gh', 'slept')), 'gh was stopped before its sleep ended');
  assert.ok(elapsed < 10000, `took ${elapsed} ms`);
});

test('F186 ES-4 an unknown revision or a bad ci setting exits 2 without calling gh', () => {
  const dir = setup({ responses: { list: { json: [runs.ok(1)] } } });
  for (const rev of ['nope', 'HEAD~9']) {
    const r = ci(dir, [rev]);
    assert.equal(r.code, 2, r.stdout);
    assert.ok(r.stderr.includes(`unknown revision ${rev}`), r.stderr);
  }
  assert.deepEqual(calls(dir), []);
  assert.equal(ci(dir, ['HEAD']).code, 0);
  assert.equal(calls(dir).length, 1);

  const file = path.join(dir, '.harness', 'config.json');
  const base = readJson(file);
  for (const key of ['poll_sec', 'find_timeout_sec', 'timeout_sec']) {
    for (const bad of [0, -1, 1.5, '30', null]) {
      writeJson(file, { ...base, ci: { [key]: bad } });
      respond(dir, { list: { json: [runs.ok(1)] } });
      const r = ci(dir);
      assert.equal(r.code, 2, `${key}=${JSON.stringify(bad)}: ${r.stdout}`);
      assert.ok(r.stderr.includes(`ci.${key}`), r.stderr);
      assert.deepEqual(calls(dir), []);
    }
  }
  writeJson(file, { ...base, ci: { poll_sec: 5, find_timeout_sec: 10, timeout_sec: 20 } });
  assert.equal(ci(dir).code, 0);
});
