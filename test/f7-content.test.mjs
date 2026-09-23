import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPO, harness, project, readJson, writeJson, tmpdir } from './helpers.mjs';
import { resolveConfig, loadConfig } from '../lib/config.mjs';
import { HarnessError } from '../lib/errors.mjs';
import { loadRolePrompt } from '../lib/roles.mjs';

const SKILLS = ['spec', 'plan', 'build', 'fix', 'status', 'plan-review', 'rollout'];
const ROLES = ['builder', 'evaluator', 'security-reviewer'];
const PROFILES = ['sdlc', 'iac', 'ops'];
const DIMENSIONS = ['functionality', 'quality', 'security', 'errors', 'tests'];

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// Minimal frontmatter parser: `key: value` lines between the leading `---` fences.
function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: null, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: m[2] };
}

// The command table in bin/harness.mjs is the single source of truth for subcommands.
function binCommands() {
  const src = read('bin/harness.mjs');
  const block = /const COMMANDS = \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(block, 'COMMANDS table not found in bin/harness.mjs');
  const names = [...block[1].matchAll(/^\s*'?([a-z][a-z0-9-]*)'?\s*:/gm)].map((m) => m[1]);
  assert.ok(names.length >= 9, `parsed only ${names.length} commands`);
  return new Set(names);
}

const lineCount = (text) => text.replace(/\n$/, '').split('\n').length;

test('F7 AC-1 skills: each of the 7 skills has SKILL.md with name and description frontmatter', () => {
  for (const s of SKILLS) {
    const { meta, body } = splitFrontmatter(read(`skills/${s}/SKILL.md`));
    assert.ok(meta, `${s}: missing frontmatter`);
    assert.equal(meta.name, s, `${s}: name must equal the directory`);
    assert.ok(meta.description && meta.description.length >= 20, `${s}: description must say when to trigger`);
    assert.ok(body.trim().length > 0, `${s}: empty body`);
  }
});

test('F7 AC-2 roles: agents have subagent frontmatter and load as role prompts without it', () => {
  for (const r of ROLES) {
    const text = read(`agents/${r}.md`);
    const { meta, body } = splitFrontmatter(text);
    assert.ok(meta, `${r}: missing frontmatter`);
    assert.equal(meta.name, r);
    assert.ok(meta.description && meta.description.length >= 20, `${r}: description`);

    const prompt = loadRolePrompt(r);
    assert.equal(prompt.trim(), body.trim(), `${r}: prompt must be the body`);
    assert.doesNotMatch(prompt, /^---/, `${r}: frontmatter leaked into prompt`);
    // The body is also the headless prompt for Gemini/Codex: no Claude-only instructions.
    assert.doesNotMatch(prompt, /Claude Code|subagent|CLAUDE_PLUGIN_ROOT|ExitPlanMode|AskUserQuestion/, `${r}: Claude-only text`);
  }
  for (const r of ['evaluator', 'security-reviewer']) {
    const p = loadRolePrompt(r);
    for (const key of [...DIMENSIONS, 'findings', 'criterion_id', 'repro', 'out_of_scope', 'REGRESSION']) {
      assert.ok(p.includes(key), `${r}: prompt must describe '${key}'`);
    }
    assert.match(p, /read-only/i, `${r}: must be read-only`);
  }
  assert.throws(() => loadRolePrompt('nope'), HarnessError);
});

test('F7 AC-2 roles: loadRolePrompt resolves relative to the package, not cwd', () => {
  const dir = tmpdir();
  const url = pathToFileURL(path.join(REPO, 'lib', 'roles.mjs')).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { loadRolePrompt } from ${JSON.stringify(url)}; process.stdout.write(loadRolePrompt('builder'))`],
  { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, loadRolePrompt('builder'));
});

test('F7 AC-3 profiles: each profile has verify.commands and a rubric for all five dimensions', () => {
  for (const p of PROFILES) {
    const prof = readJson(path.join(REPO, 'profiles', `${p}.json`));
    assert.equal(prof.name, p);
    assert.ok(Array.isArray(prof.verify?.commands) && prof.verify.commands.length > 0, `${p}: verify.commands`);
    for (const c of prof.verify.commands) assert.equal(typeof c, 'string');
    for (const d of DIMENSIONS) assert.ok(typeof prof.rubric?.[d] === 'string' && prof.rubric[d].length > 0, `${p}: rubric.${d}`);
  }
});

test('F7 AC-3 profiles: config loader merges DEFAULTS <- profile <- user config', () => {
  const iac = readJson(path.join(REPO, 'profiles', 'iac.json'));
  const c = resolveConfig({ profile: 'iac' });
  assert.deepEqual(c.verify.commands, iac.verify.commands);
  assert.deepEqual(c.rubric, iac.rubric);
  assert.equal(c.max_rounds, 3, 'defaults still apply');
  assert.deepEqual(c.verify.skip_markers, [], 'nested defaults kept');

  const u = resolveConfig({ profile: 'iac', verify: { commands: ['make check'] }, rubric: { tests: 'custom' } });
  assert.deepEqual(u.verify.commands, ['make check'], 'user wins');
  assert.equal(u.rubric.tests, 'custom');
  assert.equal(u.rubric.security, iac.rubric.security, 'unset rubric keys come from the profile');

  assert.deepEqual(resolveConfig({}).rubric, readJson(path.join(REPO, 'profiles', 'sdlc.json')).rubric, 'default profile is sdlc');

  const dir = project();
  writeJson(path.join(dir, '.harness', 'config.json'), { profile: 'ops' });
  assert.deepEqual(loadConfig(dir).verify.commands, readJson(path.join(REPO, 'profiles', 'ops.json')).verify.commands);
});

test('F7 AC-4 manifests: plugin.json and gemini-extension.json are valid and match package.json version', () => {
  const pkg = readJson(path.join(REPO, 'package.json'));
  const plugin = readJson(path.join(REPO, '.claude-plugin', 'plugin.json'));
  const gem = readJson(path.join(REPO, 'gemini-extension.json'));
  assert.equal(plugin.name, 'cc-harness');
  assert.equal(plugin.version, pkg.version);
  assert.ok(plugin.description);
  assert.equal(gem.name, 'cc-harness');
  assert.equal(gem.version, pkg.version);
  assert.equal(gem.contextFileName, 'AGENTS.md');
  assert.ok(fs.existsSync(path.join(REPO, gem.contextFileName)));
});

test('F7 AC-5 hooks: hooks.json has exactly one SessionStart hook running harness status --brief', () => {
  const h = readJson(path.join(REPO, 'hooks', 'hooks.json'));
  assert.deepEqual(Object.keys(h.hooks), ['SessionStart']);
  assert.equal(h.hooks.SessionStart.length, 1);
  const inner = h.hooks.SessionStart[0].hooks;
  assert.equal(inner.length, 1);
  assert.equal(inner[0].type, 'command');
  assert.equal(inner[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" status --brief');
});

test('F7 AC-6 references: every `harness <cmd>` in AGENTS.md and skill bodies is a real subcommand', () => {
  const known = binCommands();
  const sources = [['AGENTS.md', read('AGENTS.md')],
    ...SKILLS.map((s) => [`skills/${s}`, splitFrontmatter(read(`skills/${s}/SKILL.md`)).body])];
  let seen = 0;
  for (const [where, text] of sources) {
    // Any lowercase word after "harness " counts, prose included, so prose must say
    // "the core" rather than e.g. "harness checks" — a stricter, simpler rule.
    for (const m of text.matchAll(/\bharness\s+([a-z][a-z0-9-]*)/g)) {
      seen += 1;
      assert.ok(known.has(m[1]), `${where}: 'harness ${m[1]}' is not a subcommand (known: ${[...known].join(', ')})`);
    }
  }
  assert.ok(seen >= 10, `expected command references, found ${seen}`);
});

test('F7 AC-6 references: the scanner rejects an unknown subcommand', () => {
  const known = binCommands();
  assert.ok(!known.has('deploy'));
  assert.ok(known.has('lint-contract') && known.has('migrate-v1'));
});

test('F7 AC-7 size: AGENTS.md <= 150 lines and skill bodies total <= 600 lines', () => {
  const agents = lineCount(read('AGENTS.md'));
  assert.ok(agents <= 150, `AGENTS.md has ${agents} lines`);
  const total = SKILLS.reduce((n, s) => n + lineCount(splitFrontmatter(read(`skills/${s}/SKILL.md`)).body), 0);
  assert.ok(total <= 600, `skill bodies total ${total} lines`);
});

test('F7 ES-1 unknown profile: config loader fails with exit 2 and lists available profiles', () => {
  assert.throws(() => resolveConfig({ profile: 'nope' }), (e) => {
    assert.ok(e instanceof HarnessError);
    assert.equal(e.exit, 2);
    for (const p of PROFILES) assert.match(e.message, new RegExp(`\\b${p}\\b`));
    assert.match(e.message, /nope/);
    return true;
  });

  const dir = project();
  writeJson(path.join(dir, '.harness', 'config.json'), { profile: 'nope' });
  const r = harness(['status'], { cwd: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown profile 'nope'.*sdlc/);
});
