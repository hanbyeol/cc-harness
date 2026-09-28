// F69: whether the CLAUDE.md block is current is decided by its content — the text between
// the markers compared with the block the config renders now — not by the version in the
// begin marker, so a release that does not change the block text does not make it outdated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, harness, project, readJson, writeJson, tmpdir } from './helpers.mjs';
import { harnessVersion } from '../lib/claudemd.mjs';

const VERSION = harnessVersion();
const OLD = '0.0.1';
const file = (dir) => path.join(dir, 'CLAUDE.md');
const text = (dir) => fs.readFileSync(file(dir), 'utf8');

function setConfig(dir, patch) {
  const cfg = path.join(dir, '.harness', 'config.json');
  writeJson(cfg, { ...readJson(cfg), ...patch });
}

// An initialized project whose CLAUDE.md block was written by `harness claude-md` for `cfg`.
function written(cfg = {}) {
  const dir = project();
  setConfig(dir, cfg);
  const r = harness(['claude-md'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  return dir;
}

// Replaces the version in the begin marker, keeping the rest of the file.
function setMarkerVersion(dir, version) {
  const before = text(dir);
  const after = before.replace(/<!-- cc-harness:begin v\S+/, version === null ? '<!-- cc-harness:begin' : `<!-- cc-harness:begin v${version}`);
  if (version !== VERSION) assert.notEqual(after, before);
  fs.writeFileSync(file(dir), after);
}

const check = (dir) => harness(['claude-md', '--check'], { cwd: dir });
function briefBlockLines(dir) {
  const r = harness(['status', '--brief'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  return r.stdout.split('\n').filter((l) => l.startsWith('CLAUDE.md block'));
}

// ---------- AC-1 ----------
test('F69 AC-1 a block from another version with the same content is current for --check and status --brief', () => {
  for (const cfg of [{}, { language: 'ko' }, { profile: 'iac' }, { language: 'ko', profile: 'ops' }]) {
    const dir = written(cfg);
    setMarkerVersion(dir, OLD);
    const before = text(dir);
    const r = check(dir);
    assert.equal(r.code, 0, `${JSON.stringify(cfg)}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout.trim(), `CLAUDE.md block is current (content unchanged since v${OLD})`);
    assert.deepEqual(briefBlockLines(dir), [], JSON.stringify(cfg));
    assert.equal(text(dir), before, 'nothing written');
  }
});

test('F69 AC-1 CRLF line endings in the block compare as LF', () => {
  const dir = written({ language: 'ko' });
  setMarkerVersion(dir, OLD);
  fs.writeFileSync(file(dir), text(dir).replace(/\n/g, '\r\n'));
  const r = check(dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), `CLAUDE.md block is current (content unchanged since v${OLD})`);
  assert.deepEqual(briefBlockLines(dir), []);
});

// ---------- AC-2 ----------
test('F69 AC-2 an edited block is outdated with both versions, for an old and for the current version', () => {
  for (const version of [OLD, VERSION]) {
    const dir = written();
    setMarkerVersion(dir, version);
    fs.writeFileSync(file(dir), text(dir).replace('## ', '## edited '));
    const before = text(dir);
    const r = check(dir);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.ok(r.stdout.startsWith(`CLAUDE.md block is outdated (content differs; block v${version}, harness v${VERSION})`), r.stdout);
    assert.deepEqual(briefBlockLines(dir), [`CLAUDE.md block outdated (v${version}) — run harness claude-md`]);
    assert.equal(text(dir), before, 'nothing written');
  }
});

test('F69 AC-2 changing only config.language makes the block outdated', () => {
  for (const [from, to] of [[undefined, 'ko'], ['ko', 'en'], ['ko', undefined]]) {
    const dir = written(from === undefined ? {} : { language: from });
    const cfg = path.join(dir, '.harness', 'config.json');
    const next = { ...readJson(cfg) };
    if (to === undefined) delete next.language; else next.language = to;
    writeJson(cfg, next);
    const r = check(dir);
    assert.equal(r.code, 1, `${from}→${to}: ${r.stdout}${r.stderr}`);
    assert.ok(r.stdout.startsWith(`CLAUDE.md block is outdated (content differs; block v${VERSION}, harness v${VERSION})`), r.stdout);
    assert.equal(briefBlockLines(dir).length, 1, `${from}→${to}`);
  }
});

test('F69 AC-2 an empty block body is outdated', () => {
  const dir = project();
  fs.writeFileSync(file(dir), `# p\n\n<!-- cc-harness:begin v${VERSION} profile=sdlc -->\n<!-- cc-harness:end -->\n`);
  const r = check(dir);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /content differs/);
});

// ---------- AC-3 ----------
test('F69 AC-3 claude-md does not write a block whose content is current: bytes and mtime kept', () => {
  for (const crlf of [false, true]) {
    const dir = written({ language: 'ko' });
    setMarkerVersion(dir, OLD);
    if (crlf) fs.writeFileSync(file(dir), text(dir).replace(/\n/g, '\r\n'));
    const past = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(file(dir), past, past);
    const before = fs.readFileSync(file(dir));
    const r = harness(['claude-md'], { cwd: dir });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^CLAUDE\.md block already current/);
    assert.deepEqual(fs.readFileSync(file(dir)), before);
    assert.equal(fs.statSync(file(dir)).mtimeMs, past.getTime());
  }
});

test('F69 AC-3 claude-md rewrites a block whose content differs, with the current version marker', () => {
  const dir = written();
  setMarkerVersion(dir, OLD);
  fs.writeFileSync(file(dir), text(dir).replace('## ', '## edited '));
  const r = harness(['claude-md'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`v${OLD.replace(/\./g, '\\.')} → v`));
  const content = text(dir);
  assert.ok(content.includes(`<!-- cc-harness:begin v${VERSION} profile=sdlc -->`), content);
  assert.ok(!content.includes('## edited '), content);
  assert.equal(check(dir).code, 0);
});

// ---------- AC-4 ----------
test('F69 AC-4 an unversioned (v1) block is outdated even with the current content', () => {
  const dir = written();
  // The same content under an old version marker is current; without a version it is not.
  setMarkerVersion(dir, OLD);
  assert.equal(check(dir).code, 0);
  setMarkerVersion(dir, null);
  const r = check(dir);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /unversioned/);
  assert.deepEqual(briefBlockLines(dir), ['CLAUDE.md block outdated (v1, unversioned) — run harness claude-md']);
  const w = harness(['claude-md'], { cwd: dir });
  assert.equal(w.code, 0, w.stdout + w.stderr);
  assert.ok(text(dir).includes(`<!-- cc-harness:begin v${VERSION} profile=sdlc -->`));
});

test('F69 AC-4 no CLAUDE.md and no block are missing', () => {
  const dir = project();
  fs.rmSync(file(dir));
  const r = check(dir);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /CLAUDE\.md does not exist/);
  assert.deepEqual(briefBlockLines(dir), ['CLAUDE.md block missing — run harness claude-md']);
  fs.writeFileSync(file(dir), '# p\n');
  const n = check(dir);
  assert.equal(n.code, 1, n.stdout + n.stderr);
  assert.match(n.stdout, /no cc-harness block/);
  assert.deepEqual(briefBlockLines(dir), ['CLAUDE.md block missing — run harness claude-md']);
});

// ---------- AC-5 ----------
test('F69 AC-5 SPEC §4.1 and README describe the content-based check', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs/SPEC.md'), 'utf8');
  const sec = spec.slice(spec.indexOf('### 4.1 '), spec.indexOf('**프로필(`profiles/*.json`)**'));
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  for (const [name, t] of [['SPEC §4.1', sec], ['README', readme]]) {
    for (const s of ['content unchanged since', 'content differs', 'CLAUDE.md block already current']) assert.ok(t.includes(s), `${name}: ${s}`);
  }
  assert.ok(!sec.includes('블록 본문은 비교하지 않는다'), 'SPEC §4.1 no longer says the body is not compared');
});

// ---------- ES-1 ----------
test('F69 ES-1 an unreadable block template: --check exits 2 and changes nothing', () => {
  const pkg = tmpdir('harness-pkg-');
  for (const d of ['bin', 'lib', 'templates', 'profiles']) fs.cpSync(path.join(REPO, d), path.join(pkg, d), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(pkg, 'package.json'));
  const dir = written();
  fs.rmSync(path.join(pkg, 'templates', 'claude-block.md'));
  const before = fs.readFileSync(file(dir));
  const r = spawnSync(process.execPath, [path.join(pkg, 'bin', 'harness.mjs'), 'claude-md', '--check'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /claude-block\.md/);
  assert.deepEqual(fs.readFileSync(file(dir)), before);
});
