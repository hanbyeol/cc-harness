// F158: the plugin passes `claude plugin validate . --strict`, CI runs that check with a pinned
// Claude Code, and the build and plan skills carry an argument-hint.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpdir } from './helpers.mjs';

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

// `key: value` lines of the leading frontmatter.
function frontmatter(rel) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(read(rel));
  assert.ok(m, `${rel}: no frontmatter`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return meta;
}

// The lines of one top-level job in ci.yml: from `  <name>:` to the next two-space key.
function jobBlock(ci, name) {
  const lines = ci.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l) || /^\S/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

test('F158 AC-2: README plugin section has the one-step install line', () => {
  const readme = read('README.md');
  const at = readme.indexOf('### Claude Code 플러그인');
  assert.ok(at >= 0, 'no plugin section');
  const block = /```[a-z]*\n([\s\S]*?)```/.exec(readme.slice(at));
  assert.ok(block, 'no code block in the plugin section');
  assert.ok(block[1].split('\n').includes('/plugin install cc-harness --marketplace hanbyeol/cc-harness'), block[1]);
});

test('F158 AC-3: ci.yml has a plugin-validate job with a pinned Claude Code and the strict check', () => {
  const job = jobBlock(read('.github/workflows/ci.yml'), 'plugin-validate');
  assert.ok(job, 'no plugin-validate job');
  assert.match(job, /^\s*runs-on:\s*ubuntu-latest\s*$/m);
  const install = /npm (?:install|i) (?:-g|--global) @anthropic-ai\/claude-code@(\S+)/.exec(job);
  assert.ok(install, 'no npm install of @anthropic-ai/claude-code');
  assert.match(install[1], /^\d+\.\d+\.\d+$/, `exact version, got ${install[1]}`);
  const validate = job.indexOf('node tools/plugin-validate.mjs');
  assert.ok(validate > install.index, 'validate runs after the install');
});

test('F158 AC-4: build and plan skills carry an argument-hint, name and description unchanged', () => {
  const build = frontmatter('skills/build/SKILL.md');
  const plan = frontmatter('skills/plan/SKILL.md');
  assert.equal(build['argument-hint'], 'F{n}');
  assert.equal(plan['argument-hint'], 'F{n} [F{m} ...]');
  assert.equal(build.name, 'build');
  assert.equal(plan.name, 'plan');
  assert.match(build.description, /^Implement one approved cc-harness feature with test-driven development/);
  assert.match(plan.description, /^Lint one or more cc-harness contracts, present them as a plan/);
});

test('F158 AC-5: SPEC §11 documents the strict plugin validation in CI', () => {
  const spec = read('docs/SPEC.md');
  const start = spec.indexOf('## 11.');
  const end = spec.indexOf('\n## 12.', start);
  assert.ok(start >= 0 && end > start, 'no §11');
  const s11 = spec.slice(start, end);
  for (const w of ['plugin validate', '--strict', 'plugin-validate', 'CLAUDE.md']) assert.ok(s11.includes(w), w);
});

// ------------------------------------------------------------------ ES-2, ES-3

const SCRIPT = path.join(REPO, 'tools', 'plugin-validate.mjs');
const KNOWN_WARNING = { path: 'root', code: null, message: 'CLAUDE.md at the plugin root is not loaded as project context. To ship context with your plugin, use a skill (skills/<name>/SKILL.md) instead.' };
const report = (o = {}) => ({
  success: false, strict: true,
  manifest: { file: '/r/.claude-plugin/marketplace.json', errors: [], warnings: [] },
  contents: [{ file: '/r/CLAUDE.md', errors: [], warnings: [KNOWN_WARNING] }],
  advice: [],
  directory: { findings: [{ code: 'ICON_MISSING', severity: 'warning' }] },
  ...o,
});
function runScript(args, env = process.env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8', env });
}
function withReport(content) {
  const file = path.join(tmpdir('harness-f158-'), 'report.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return runScript(['--report', file]);
}

test('F158 ES-2: only the known root CLAUDE.md warning passes; any other warning or error fails with its message', () => {
  const ok = withReport(report());
  assert.equal(ok.status, 0, ok.stderr);
  const extra = withReport(report({ contents: [{ file: '/r/.claude-plugin/plugin.json', errors: [], warnings: [KNOWN_WARNING, { path: 'bogus', message: 'Unknown key "bogus" was removed' }] }] }));
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /Unknown key "bogus" was removed/);
  const err = withReport(report({ contents: [{ file: '/r/agents/x.md', errors: [{ message: 'agent has no description' }], warnings: [] }] }));
  assert.equal(err.status, 1);
  assert.match(err.stderr, /agent has no description/);
  const manifest = withReport(report({ manifest: { file: '/r/m.json', errors: [], warnings: [{ path: 'owner', message: 'owner.email missing' }] } }));
  assert.equal(manifest.status, 1);
  assert.match(manifest.stderr, /owner\.email missing/);
  const advice = withReport(report({ advice: [{ message: 'add an install line' }] }));
  assert.equal(advice.status, 1);
  assert.match(advice.stderr, /add an install line/);
  // The known message on another path is not the known warning.
  const moved = withReport(report({ contents: [{ file: '/r/x', errors: [], warnings: [{ ...KNOWN_WARNING, path: 'skills' }] }] }));
  assert.equal(moved.status, 1);
});

test('F158 ES-3: an unreadable report or a missing claude exits 2', () => {
  for (const bad of ['not json {', JSON.stringify({ success: true }), JSON.stringify({ contents: 'x' })]) {
    const r = withReport(bad);
    assert.equal(r.status, 2, bad);
    assert.match(r.stderr, /plugin-validate: unreadable report/, bad);
  }
  const missing = runScript(['--report', path.join(tmpdir('harness-f158-'), 'none.json')]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /plugin-validate: unreadable report/);
  // No claude on an empty PATH (the script is started by absolute node path).
  const empty = tmpdir('harness-f158-path-');
  const noClaude = runScript([], { PATH: empty, Path: empty, HOME: empty, USERPROFILE: empty, SystemRoot: process.env.SystemRoot ?? '' });
  assert.equal(noClaude.status, 2, noClaude.stderr);
  assert.match(noClaude.stderr, /plugin-validate: claude not found/);
});
