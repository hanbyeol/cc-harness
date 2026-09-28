// F61: the conversation language. Every instruction file tells the model to talk with the
// user in config.language (or the user's own language) and to keep code, comments, commits
// and contract ids/checks in English; config.language is validated, reported by
// `status --brief` (read by the SessionStart hook) and `doctor`, and set by `init --language`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, harness, project, readJson, writeJson, tmpdir } from './helpers.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { HarnessError } from '../lib/errors.mjs';
import doctor from '../lib/commands/doctor.mjs';

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const FILES = [
  'AGENTS.md',
  ...['spec', 'plan', 'build', 'fix', 'status', 'plan-review', 'rollout'].map((s) => `skills/${s}/SKILL.md`),
  ...['builder', 'evaluator', 'security-reviewer'].map((r) => `agents/${r}.md`),
];

// The body of the '## Language' section: up to the next heading of level 1 or 2.
function languageSection(text) {
  const m = /^## Language[ \t]*\r?\n([\s\S]*?)(?=^#{1,2} |(?![\s\S]))/m.exec(text);
  return m ? m[1] : null;
}

for (const file of FILES) {
  test(`F61 AC-1 ${file} has a '## Language' section with the conversation language rule`, () => {
    const body = languageSection(read(file));
    assert.ok(body !== null, `${file}: no '## Language' section`);
    const flat = body.replace(/\s+/g, ' ');
    assert.match(flat, /config\.language/, `${file}: names config.language`);
    assert.match(flat, /language the user writes in/i, `${file}: falls back to the user's language`);
    assert.match(flat, /English/, `${file}: names English`);
    for (const word of [/\bcode\b/i, /\bcomments\b/i, /\bcommit/i, /\bids\b/i, /\bcheck\b/i]) {
      assert.match(flat, word, `${file}: the English rule covers ${word}`);
    }
  });
}

function rejects(language) {
  assert.throws(() => resolveConfig({ language }, { label: 'cfg' }), (e) => {
    assert.ok(e instanceof HarnessError, String(e));
    assert.equal(e.code, 'config_invalid', e.message);
    assert.equal(e.exit, 2);
    assert.ok(e.message.includes('language'), e.message);
    return true;
  });
}

for (const good of ['ko', 'en', 'ja', 'pt-BR']) {
  test(`F61 AC-2 language ${JSON.stringify(good)} is accepted`, () => {
    assert.equal(resolveConfig({ language: good }).language, good);
  });
}

for (const bad of ['KO', 'Ko', 'kor', 'k', '', 'pt-br', 'PT-BR', 'pt_BR', 'pt-BRA', 'en-', ' ko', 'ko\n', 'korean', 42, null, true, ['ko'], { code: 'ko' }]) {
  test(`F61 AC-2 language ${JSON.stringify(bad)} is config_invalid naming language`, () => rejects(bad));
}

test('F61 AC-2 the CLI exits 2 with language in the message for an invalid config.language', () => {
  const dir = project();
  const file = path.join(dir, '.harness', 'config.json');
  writeJson(file, { ...readJson(file), language: 'Korean' });
  const r = harness(['status'], { cwd: dir });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /language/);
  assert.doesNotMatch(r.stderr, /internal error/);
});

const setLanguage = (dir, language) => {
  const file = path.join(dir, '.harness', 'config.json');
  writeJson(file, { ...readJson(file), language });
};

test('F61 AC-3 status --brief ends with a reply-in line when config.language is set', () => {
  for (const language of ['ko', 'pt-BR']) {
    const dir = project([{ id: 'F1', title: 'one', security_tier: 'standard', depends_on: [], status: 'todo' }]);
    setLanguage(dir, language);
    const r = harness(['status', '--brief'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.replace(/\n$/, '').split('\n');
    assert.equal(lines.length, 2, r.stdout);
    assert.match(lines[0], /^harness: 1 todo/);
    assert.equal(lines.at(-1), `reply in: ${language}`);
  }
});

test('F61 AC-3 status --brief has no reply-in line without config.language', () => {
  const dir = project([{ id: 'F1', title: 'one', security_tier: 'standard', depends_on: [], status: 'todo' }]);
  const r = harness(['status', '--brief'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /reply in/);
});

test('F61 AC-4 init --language writes language to a new config.json', () => {
  const dir = tmpdir();
  const r = harness(['init', '--language', 'ja'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(readJson(path.join(dir, '.harness', 'config.json')).language, 'ja');
});

test('F61 AC-4 init without --language writes no language key', () => {
  const dir = tmpdir();
  assert.equal(harness(['init'], { cwd: dir }).code, 0);
  assert.equal(Object.hasOwn(readJson(path.join(dir, '.harness', 'config.json')), 'language'), false);
});

test('F61 AC-4 init --language rejects an invalid or missing code and writes no config', () => {
  for (const args of [['--language', 'Korean'], ['--language']]) {
    const dir = tmpdir();
    const r = harness(['init', ...args], { cwd: dir });
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /language/);
    assert.equal(fs.existsSync(path.join(dir, '.harness', 'config.json')), false);
  }
});

test('F61 AC-4 init --language keeps an existing config.json unchanged', () => {
  const dir = project();
  const file = path.join(dir, '.harness', 'config.json');
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(harness(['init', '--language', 'ko'], { cwd: dir }).code, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

const PROBE = async () => ({ installed: false, version: null, help: null });
async function doctorLines(dir) {
  const lines = [];
  await doctor({ root: dir, args: [], out: (s) => lines.push(s), err: (s) => lines.push(s), probe: PROBE, env: {} });
  return lines;
}

test('F61 AC-4 doctor shows the configured language on one line', async () => {
  const dir = project();
  setLanguage(dir, 'pt-BR');
  const lines = await doctorLines(dir);
  assert.deepEqual(lines.filter((l) => /^language:/.test(l)), ['language: pt-BR']);
});

test('F61 AC-4 doctor shows language as not set without config.language', async () => {
  const lines = await doctorLines(project());
  const shown = lines.filter((l) => /^language:/.test(l));
  assert.equal(shown.length, 1, lines.join('\n'));
  assert.match(shown[0], /^language: not set/);
});

test('F61 AC-5 README explains the language setting and the conversation language rule', () => {
  const text = read('README.md');
  assert.match(text, /`language`/);
  assert.match(text, /--language/);
  assert.match(text, /reply in:/);
  assert.match(text, /pt-BR/);
});

test('F61 AC-5 SPEC §4 explains config.language', () => {
  const spec = read('docs/SPEC.md');
  const s4 = /^## 4\. [\s\S]*?(?=^## 5\. )/m.exec(spec)?.[0];
  assert.ok(s4, 'SPEC §4 not found');
  assert.match(s4, /`language`/);
  assert.match(s4, /--language/);
  assert.match(s4, /reply in:/);
  assert.match(s4, /pt-BR/);
  assert.match(s4, /## Language/);
});

test('F61 ES-1 a config without language loads and status --brief prints only the summary line', () => {
  const dir = project([{ id: 'F1', title: 'one', security_tier: 'standard', depends_on: [], status: 'todo' }]);
  const file = path.join(dir, '.harness', 'config.json');
  assert.equal(Object.hasOwn(readJson(file), 'language'), false);
  assert.equal(Object.hasOwn(resolveConfig(readJson(file)), 'language'), false);
  const r = harness(['status', '--brief'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'harness: 1 todo\n');
});
