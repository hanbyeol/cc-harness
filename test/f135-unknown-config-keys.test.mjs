import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, harness, project, writeJson, readJson } from './helpers.mjs';
import { unknownConfigKeys, DEFAULTS, listProfiles, loadProfile } from '../lib/config.mjs';

// F135: unknown config keys are warned about on stderr (once per key per command) with a
// "did you mean"; doctor lists them; they never change the exit code.

function withConfig(extra) {
  const dir = project([]);
  const file = path.join(dir, '.harness', 'config.json');
  writeJson(file, { ...readJson(file), ...extra });
  return dir;
}
const warnings = (r) => r.stderr.split('\n').filter((l) => l.includes('unknown config key'));

test('F135 AC-1: a top-level typo warns once on stderr; exit code and stdout match a config without it', () => {
  const clean = withConfig({});
  const typo = withConfig({ max_round: 5 });
  for (const args of [['status'], ['verify', 'F1'], ['lint-contract']]) {
    const a = harness(args, { cwd: clean });
    const b = harness(args, { cwd: typo });
    assert.deepEqual(warnings(b), ["harness: warning: unknown config key 'max_round' (did you mean 'max_rounds'?)"], `${args}: ${b.stderr}`);
    assert.equal(b.code, a.code, args.join(' '));
    assert.equal(b.stdout, a.stdout, args.join(' '));
    assert.deepEqual(warnings(a), []);
  }
});

test('F135 AC-2: nested typos name the full path and the closest sibling; far keys get no suggestion', () => {
  const dir = withConfig({
    verify: { comands: ['true'], zzz: 1 },
    run: { worktree_dirs: 'x' },
    budget: { run_us: 3 },
    roles: { builder: { modle: 'm' } },
    adapters: { generic: { comand: 'x' } },
  });
  const r = harness(['status'], { cwd: dir });
  const w = warnings(r);
  for (const [k, s] of [
    ['verify.comands', 'verify.commands'], ['run.worktree_dirs', 'run.worktree_dir'], ['budget.run_us', 'budget.run_usd'],
    ['roles.builder.modle', 'roles.builder.model'], ['adapters.generic.comand', 'adapters.generic.command'],
  ]) {
    assert.ok(w.includes(`harness: warning: unknown config key '${k}' (did you mean '${s}'?)`), `${k}: ${r.stderr}`);
  }
  assert.ok(w.includes("harness: warning: unknown config key 'verify.zzz'"), r.stderr);
  assert.equal(w.length, 6, r.stderr);
});

test('F135 AC-3: unknownConfigKeys returns [] for every key the config may set', () => {
  const all = {
    ...structuredClone(DEFAULTS), language: 'ko', telemetry: { share: true },
    run: { ...DEFAULTS.run, worktree_dir: '.harness/wt' },
    roles: { builder: { adapter: 'claude', model: 'm', by_tier: { critical: 'a' }, escalate: 'b', conflict_model: 'c', effort: 'high' }, custom: { adapter: 'x' } },
    adapters: { mine: { model: 'm', command: 'c', read_only_command: 'r', help_args: ['--help'] } },
    rubric: { anything: 'goes' },
  };
  assert.deepEqual(unknownConfigKeys(all), []);
  for (const name of listProfiles()) {
    const { name: _n, description: _d, ...rest } = loadProfile(name);
    assert.deepEqual(unknownConfigKeys(rest), [], name);
  }
  assert.deepEqual(unknownConfigKeys({}), []);
});

test('F135 AC-4: doctor lists unknown keys on stdout and keeps its exit code; none, no line', () => {
  const clean = withConfig({});
  const typo = withConfig({ max_round: 5, verify: { zzz: 1 } });
  const a = harness(['doctor'], { cwd: clean });
  const b = harness(['doctor'], { cwd: typo });
  assert.equal(b.code, a.code);
  assert.ok(b.stdout.includes("config: unknown key 'max_round' (did you mean 'max_rounds'?)\n"), b.stdout);
  assert.ok(b.stdout.includes("config: unknown key 'verify.zzz'\n"), b.stdout);
  assert.doesNotMatch(a.stdout, /unknown key/);
});

test('F135 AC-5: telemetry is ignored silently next to a typo; verify.affected_command stays config_invalid', () => {
  const dir = withConfig({ telemetry: { share: true }, max_round: 2 });
  const r = harness(['status'], { cwd: dir });
  assert.deepEqual(warnings(r), ["harness: warning: unknown config key 'max_round' (did you mean 'max_rounds'?)"]);
  assert.doesNotMatch(r.stderr, /telemetry/);
  const bad = withConfig({ verify: { affected_command: 'x' } });
  assert.equal(harness(['status'], { cwd: bad }).code, 2);
});

test('F135 AC-6: SPEC §4 describes the unknown key warning', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const line = spec.split('\n').find((l) => l.startsWith('| `config.json`'));
  for (const s of ['모르는 키', 'stderr', 'did you mean', '편집 거리 2', '오류가 아니', 'telemetry', '역할·어댑터 이름', 'doctor']) {
    assert.ok(line.includes(s), s);
  }
});

test('F135 ES-1: config_invalid wins over the unknown key warning', () => {
  const dir = withConfig({ max_round: 1, verify: { commands: 'npm test' } });
  const r = harness(['status'], { cwd: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /verify\.commands/);
  assert.doesNotMatch(r.stderr, /unknown config key/);
});

test('F135 ES-2: non-object values under adapters and roles do not crash the key check', () => {
  const base = harness(['status'], { cwd: withConfig({}) }).code;
  for (const extra of [{ adapters: 'x' }, { adapters: [] }, { adapters: 3 }, { roles: { builder: 'claude' } }, { adapters: { generic: null } }]) {
    const r = harness(['status'], { cwd: withConfig(extra) });
    assert.doesNotMatch(r.stderr, /internal error/i, r.stderr);
    assert.equal(r.code, base, JSON.stringify(extra) + r.stderr);
  }
});
