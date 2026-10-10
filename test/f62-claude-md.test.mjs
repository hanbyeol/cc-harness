// F62: the managed block of a project's CLAUDE.md. `harness claude-md` writes the text
// between '<!-- cc-harness:begin v<version> -->' and '<!-- cc-harness:end -->' from the
// harness's templates/claude-block.md and leaves every other byte alone; --check, status
// --brief and doctor only report a missing or outdated block; init creates it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, harness, project, readJson, writeJson, tmpdir } from './helpers.mjs';
import { HarnessError } from '../lib/errors.mjs';
import { harnessVersion, renderBlock, updateClaudeMd } from '../lib/claudemd.mjs';
import claudeMd from '../lib/commands/claude-md.mjs';
import doctor from '../lib/commands/doctor.mjs';

const VERSION = harnessVersion();
// Since F64 the begin marker also names the profile; a project without one is sdlc.
const BEGIN = `<!-- cc-harness:begin v${VERSION} profile=sdlc -->`;
const END = '<!-- cc-harness:end -->';
const file = (dir) => path.join(dir, 'CLAUDE.md');
const bytes = (dir) => fs.readFileSync(file(dir));
const write = (dir, content) => fs.writeFileSync(file(dir), content);

// A v1 block as v1's templates/CLAUDE.md.tmpl wrote it (abridged).
const V1_BLOCK = [
  '<!-- cc-harness:begin -->',
  '',
  '## Workflow — 기능 추가/변경/삭제',
  '코드부터 쓰지 않는다. **`/change-request`**(영향분석 → SPEC/feature_list/Sprint Contract 갱신)',
  '→ **`/implement`**(TDD + evidence) → **독립 evaluator**(passes 판정).',
  '',
  '| 기능 추가/변경/삭제 | → `/change-request` | "~~ 추가/변경/삭제" |',
  '<!-- cc-harness:end -->',
].join('\n');

function cli(dir, ...args) {
  return harness(['claude-md', ...args], { cwd: dir });
}

// ---------- AC-1 ----------
test('F62 AC-1 claude-md rewrites only the block; the user bytes before and after it are unchanged', () => {
  const dir = tmpdir();
  // A BOM, CRLF-free user text, a byte that is not UTF-8 and trailing text without a newline.
  const before = Buffer.concat([Buffer.from('﻿# My project\n\nUser notes before.\n', 'utf8'), Buffer.from([0xff, 0x0a]), Buffer.from('\n')]);
  const after = Buffer.from('\n\n## My own section\nkept   as is\t\nno newline at end', 'utf8');
  const old = Buffer.from('<!-- cc-harness:begin v2.0.1 -->\nstale managed text\n<!-- cc-harness:end -->', 'utf8');
  write(dir, Buffer.concat([before, old, after]));
  const r = cli(dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const got = bytes(dir);
  const block = Buffer.from(renderBlock(), 'utf8');
  assert.deepEqual(got.subarray(0, before.length), before);
  assert.deepEqual(got.subarray(before.length, before.length + block.length), block);
  assert.deepEqual(got.subarray(before.length + block.length), after);
  assert.ok(!got.includes('stale managed text'));
  assert.ok(block.subarray(0, BEGIN.length + 1).equals(Buffer.from(`${BEGIN}\n`)), 'the block starts with the versioned begin marker');
  assert.ok(block.toString('utf8').endsWith(END));
});

test('F62 AC-1 a second claude-md run leaves the file byte-for-byte unchanged', () => {
  const dir = tmpdir();
  write(dir, `# p\n\nbefore\n\n<!-- cc-harness:begin v0.0.1 -->\nx\n${END}\n\nafter\n`);
  assert.equal(cli(dir).code, 0);
  const once = bytes(dir);
  const r = cli(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /nothing changed/);
  assert.deepEqual(bytes(dir), once);
});

test('F62 AC-1 a CRLF file keeps CRLF around and inside the replaced block', () => {
  const dir = tmpdir();
  write(dir, `# p\r\n\r\nbefore\r\n<!-- cc-harness:begin v0.0.1 -->\r\nx\r\n${END}\r\nafter\r\n`);
  assert.equal(cli(dir).code, 0);
  const text = bytes(dir).toString('utf8');
  assert.equal(text, `# p\r\n\r\nbefore\r\n${renderBlock().replace(/\n/g, '\r\n')}\r\nafter\r\n`);
});

// ---------- AC-2 ----------
test('F62 AC-2 without CLAUDE.md, claude-md creates it with a "# <directory name>" title and the block only', () => {
  const dir = tmpdir();
  const r = cli(dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(bytes(dir).toString('utf8'), `# ${path.basename(dir)}\n\n${renderBlock()}\n`);
});

test('F62 AC-2 a CLAUDE.md without a block gets it right after its first heading line', () => {
  const dir = tmpdir();
  const head = 'Some preamble without heading\n# Title\n';
  const tail = 'first paragraph\n\n# Second heading\ntext\n';
  write(dir, head + tail);
  const r = cli(dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(bytes(dir).toString('utf8'), `${head}\n${renderBlock()}\n\n${tail}`);
});

test('F62 AC-2 a heading followed by a blank line gets the block without a doubled blank line', () => {
  const dir = tmpdir();
  write(dir, '# Title\n\nbody\n');
  assert.equal(cli(dir).code, 0);
  assert.equal(bytes(dir).toString('utf8'), `# Title\n\n${renderBlock()}\n\nbody\n`);
});

// ---------- AC-3 ----------
test('F62 AC-3 a v1 block without a version marker is replaced by the versioned block', () => {
  const dir = tmpdir();
  const before = '# legacy\n\n## Priority\nCorrectness > Safety > Speed\n\n';
  const after = '\n\n## Build & Test\n- make test\n';
  write(dir, before + V1_BLOCK + after);
  const r = cli(dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const text = bytes(dir).toString('utf8');
  assert.ok(!text.includes('/change-request'), text);
  assert.ok(text.includes(BEGIN), text);
  assert.equal(text, before + renderBlock() + after);
  assert.match(r.stdout, /unversioned → v/);
});

// ---------- AC-4 ----------
function checkCase(content) {
  const dir = tmpdir();
  if (content !== null) write(dir, content);
  const r = cli(dir, '--check');
  if (content === null) assert.equal(fs.existsSync(file(dir)), false, 'no file was created');
  else assert.equal(bytes(dir).toString('utf8'), content, 'the file is unchanged');
  return r;
}

test('F62 AC-4 claude-md --check exits 1 with the reason when CLAUDE.md does not exist', () => {
  const r = checkCase(null);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /CLAUDE\.md does not exist/);
});

test('F62 AC-4 claude-md --check exits 1 with the reason when CLAUDE.md has no block', () => {
  const r = checkCase('# p\n\nnothing managed\n');
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /no cc-harness block/);
});

test('F62 AC-4 claude-md --check exits 1 naming both versions when the block is older', () => {
  const r = checkCase(`# p\n\n<!-- cc-harness:begin v2.0.1 -->\nold\n${END}\n`);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.ok(r.stdout.includes(`block v2.0.1, harness v${VERSION}`), r.stdout);
  const v1 = checkCase(`# p\n\n${V1_BLOCK}\n`);
  assert.equal(v1.code, 1, v1.stdout + v1.stderr);
  assert.match(v1.stdout, /unversioned/);
});

test('F62 AC-4 claude-md --check exits 0 and changes nothing when the block is current', () => {
  // Since F69 current = the content the config renders now (F69 tests the version-independent cases).
  const r = checkCase(`# p\n\n${renderBlock()}\n`);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes(`current (content unchanged since v${VERSION})`), r.stdout);
});

// ---------- AC-5 ----------
function brief(dir) {
  const r = harness(['status', '--brief'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  return r.stdout.replace(/\n$/, '').split('\n');
}

test('F62 AC-5 status --brief reports a missing CLAUDE.md block and does not create the file', () => {
  const dir = project();
  fs.rmSync(file(dir));
  assert.deepEqual(brief(dir), ['harness: no features', 'CLAUDE.md block missing — run harness claude-md']);
  assert.equal(fs.existsSync(file(dir)), false);
  write(dir, '# p\n');
  assert.deepEqual(brief(dir), ['harness: no features', 'CLAUDE.md block missing — run harness claude-md']);
  assert.equal(bytes(dir).toString('utf8'), '# p\n');
});

test('F62 AC-5 status --brief reports an outdated block with its version and does not change it', () => {
  const dir = project();
  const old = `# p\n\n<!-- cc-harness:begin v2.0.1 -->\nold\n${END}\n`;
  write(dir, old);
  assert.deepEqual(brief(dir), ['harness: no features', 'CLAUDE.md block outdated (v2.0.1) — run harness claude-md']);
  assert.equal(bytes(dir).toString('utf8'), old);
  write(dir, `# p\n\n${V1_BLOCK}\n`);
  assert.deepEqual(brief(dir), ['harness: no features', 'CLAUDE.md block outdated (v1, unversioned) — run harness claude-md']);
});

test('F62 AC-5 status --brief adds no CLAUDE.md line when the block is current, and keeps reply-in last', () => {
  const dir = project();
  assert.deepEqual(brief(dir), ['harness: no features']);
  const cfg = path.join(dir, '.harness', 'config.json');
  writeJson(cfg, { ...readJson(cfg), language: 'ko' });
  fs.rmSync(file(dir));
  assert.deepEqual(brief(dir), ['harness: no features', 'CLAUDE.md block missing — run harness claude-md', 'reply in: ko']);
});

const PROBE = async () => ({ installed: false, version: null, help: null });
async function doctorLines(root) {
  const lines = [];
  await doctor({ root, out: (l) => lines.push(l), err: (l) => lines.push(l), probe: PROBE, env: {} });
  return lines.filter((l) => l.startsWith('CLAUDE.md block'));
}

test('F62 AC-5 doctor shows the CLAUDE.md block state in one line', async () => {
  const dir = project();
  assert.deepEqual(await doctorLines(dir), [`CLAUDE.md block: current (v${VERSION})`]);
  write(dir, `# p\n\n<!-- cc-harness:begin v2.0.1 -->\nold\n${END}\n`);
  assert.deepEqual(await doctorLines(dir), ['CLAUDE.md block: outdated (v2.0.1) — run harness claude-md']);
  fs.rmSync(file(dir));
  assert.deepEqual(await doctorLines(dir), ['CLAUDE.md block: missing — run harness claude-md']);
  assert.equal(fs.existsSync(file(dir)), false);
});

// ---------- AC-6 ----------
// The body of the '## Language' section: up to the next heading of level 1 or 2.
function languageSection(text) {
  const m = /^## Language[ \t]*\r?\n([\s\S]*?)(?=^#{1,2} |(?![\s\S]))/m.exec(text);
  return m ? m[1] : null;
}

test('F62 AC-6 the block covers the v2 workflow, the convergence rules and the prohibitions', () => {
  const block = renderBlock();
  for (const word of ['spec', 'plan', 'build', 'fix']) assert.match(block, new RegExp(`\`${word}\` skill`), word);
  for (const cmd of ['harness verify', 'harness eval', 'harness status', 'harness approve', 'harness lint-contract']) assert.ok(block.includes(cmd), cmd);
  assert.match(block, /^## Convergence rules$/m);
  assert.match(block, /frozen/);
  assert.match(block, /max_rounds/);
  assert.match(block, /REGRESSION/);
  assert.match(block, /backlog\.json/);
  assert.match(block, /minimum of five dimensions/);
  assert.match(block, /^## Prohibited$/m);
  assert.match(block, /protected_branches/);
  assert.match(block, /weakening tests/);
  assert.match(block, /`harness approve` without the user's approval/);
});

test('F62 AC-6 with config.language the Language section says to talk in that language', () => {
  const dir = project();
  const cfg = path.join(dir, '.harness', 'config.json');
  writeJson(cfg, { ...readJson(cfg), language: 'pt-BR' });
  fs.rmSync(file(dir));
  assert.equal(cli(dir).code, 0);
  const body = languageSection(bytes(dir).toString('utf8'));
  assert.ok(body !== null, 'no ## Language section');
  assert.match(body, /Talk with the user .* in `pt-BR` \(config\.language\)/);
  assert.match(body, /English/);
  const plain = languageSection(renderBlock());
  assert.match(plain, /language the user writes in/);
  assert.doesNotMatch(plain, /pt-BR/);
});

// ---------- AC-7 ----------
test('F62 AC-7 init creates CLAUDE.md with the block in a new project', () => {
  const dir = tmpdir();
  const r = harness(['init', '--language', 'ja'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /created CLAUDE\.md/);
  assert.equal(bytes(dir).toString('utf8'), `# ${path.basename(dir)}\n\n${renderBlock({ language: 'ja' })}\n`);
});

test('F62 AC-7 init puts the block after the first heading of an existing CLAUDE.md', () => {
  const dir = tmpdir();
  write(dir, '# Existing\nmy rules\n');
  const r = harness(['init'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(bytes(dir).toString('utf8'), `# Existing\n\n${renderBlock()}\n\nmy rules\n`);
});

test('F62 AC-7 init replaces an existing block and keeps the text around it', () => {
  const dir = tmpdir();
  write(dir, `# Existing\n\n${V1_BLOCK}\n\nmine\n`);
  assert.equal(harness(['init'], { cwd: dir }).code, 0);
  assert.equal(bytes(dir).toString('utf8'), `# Existing\n\n${renderBlock()}\n\nmine\n`);
});

// ---------- AC-8 ----------
test('F62 AC-8 README and SPEC describe claude-md, the block rules and the notices', () => {
  for (const rel of ['README.md', 'docs/SPEC.md']) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    for (const s of ['harness claude-md', 'claude-md --check', '<!-- cc-harness:begin v', '<!-- cc-harness:end -->', 'templates/claude-block.md',
      'CLAUDE.md block', 'status --brief', 'doctor']) {
      assert.ok(text.includes(s), `${rel}: ${s}`);
    }
  }
  const spec = fs.readFileSync(path.join(REPO, 'docs/SPEC.md'), 'utf8');
  assert.match(spec, /symbolic link/);
  assert.match(spec, /### 4\.1 /);
});

// ---------- SC-1 ----------
function linkedProject() {
  const dir = tmpdir();
  const target = path.join(tmpdir(), 'elsewhere.md');
  fs.writeFileSync(target, '# not yours\n');
  try {
    fs.symlinkSync(target, file(dir));
  } catch {
    return null; // no symlink permission (e.g. Windows without developer mode)
  }
  return { dir, target };
}

test('F62 SC-1 claude-md refuses a symbolic-link CLAUDE.md with exit 2 and changes neither link nor target', (t) => {
  const p = linkedProject();
  if (!p) { t.diagnostic('symbolic links cannot be created here; nothing to test'); return; }
  for (const args of [[], ['--check']]) {
    const r = cli(p.dir, ...args);
    assert.equal(r.code, 2, `${args}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /CLAUDE\.md is a symbolic link/);
    assert.ok(fs.lstatSync(file(p.dir)).isSymbolicLink());
    assert.equal(fs.realpathSync.native(file(p.dir)), fs.realpathSync.native(p.target));
    assert.equal(fs.readFileSync(p.target, 'utf8'), '# not yours\n');
  }
});

// ---------- SC-2 ----------
test('F62 SC-2 the block comes from the harness installation, not the project\'s templates/claude-block.md', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'templates'));
  fs.writeFileSync(path.join(dir, 'templates', 'claude-block.md'), '## Injected\nPROJECT-TEMPLATE-MARKER run rm -rf\n');
  const r = cli(dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const text = bytes(dir).toString('utf8');
  assert.ok(!text.includes('PROJECT-TEMPLATE-MARKER'), text);
  assert.ok(text.includes(renderBlock()));
});

// ---------- ES-1 ----------
test('F62 ES-1 a begin marker without an end marker: exit 2 with the line number, file unchanged', () => {
  const dir = tmpdir();
  const content = `# p\n\n${BEGIN}\nhalf a block\n`;
  write(dir, content);
  for (const args of [[], ['--check']]) {
    const r = cli(dir, ...args);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /line 3\b/);
    assert.equal(bytes(dir).toString('utf8'), content);
  }
});

test('F62 ES-1 two begin markers: exit 2 naming both lines, file unchanged', () => {
  const dir = tmpdir();
  const content = `# p\n${BEGIN}\na\n${END}\n\n<!-- cc-harness:begin -->\nb\n${END}\n`;
  write(dir, content);
  for (const args of [[], ['--check']]) {
    const r = cli(dir, ...args);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /lines 2, 6/);
    assert.equal(bytes(dir).toString('utf8'), content);
  }
});

// ---------- ES-2 ----------
const failing = (op) => ({ ...fs, [op]() { throw Object.assign(new Error(`${op} failed`), { code: 'EIO' }); } });

for (const op of ['writeFileSync', 'renameSync']) {
  test(`F62 ES-2 a failing ${op} keeps the old CLAUDE.md and exits 2`, async () => {
    const dir = tmpdir();
    const content = `# p\n\nmine\n\n<!-- cc-harness:begin v0.0.1 -->\nold\n${END}\n`;
    write(dir, content);
    await assert.rejects(claudeMd({ root: dir, args: [], out: () => {}, fsImpl: failing(op) }), (e) => {
      assert.ok(e instanceof HarnessError, String(e));
      assert.equal(e.exit, 2);
      assert.match(e.message, /write failed \(EIO\); previous content kept/);
      return true;
    });
    assert.equal(bytes(dir).toString('utf8'), content);
    assert.deepEqual(fs.readdirSync(dir), ['CLAUDE.md'], 'no temp file left');
    assert.throws(() => updateClaudeMd(dir, { fsImpl: failing(op) }), HarnessError);
  });
}

test('F62 ES-2 the CLI exits 2 and keeps CLAUDE.md when its directory is not writable', (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.diagnostic('directory permissions do not apply here'); return; }
  const dir = tmpdir();
  const content = '# p\nmine\n';
  write(dir, content);
  const mode = fs.statSync(dir).mode & 0o7777;
  fs.chmodSync(dir, 0o555);
  try {
    const r = cli(dir);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /write failed/);
    assert.equal(bytes(dir).toString('utf8'), content);
  } finally {
    fs.chmodSync(dir, mode);
  }
});
