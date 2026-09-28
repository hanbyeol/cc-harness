// The managed block of a project's CLAUDE.md (SPEC §4.1): the text between
// '<!-- cc-harness:begin v<version> profile=<name> -->' and '<!-- cc-harness:end -->' comes
// from the harness's own templates/claude-block.md (plus templates/profile-<name>.md for a
// profile that has one); every byte outside it belongs to the user.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessError } from './errors.mjs';
import { isInitialized } from './state.mjs';
import { loadConfig, loadProfile } from './config.mjs';

// The package root of this installation — never the target project (SC-2).
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATE = path.join(PACKAGE_ROOT, 'templates', 'claude-block.md');

// A marker without profile= (v2.0.30 and older, v1) is read as the sdlc profile.
const BEGIN = /^<!-- cc-harness:begin(?: v(\S+))?(?: profile=(\S+))? -->[ \t]*$/;
const DEFAULT_PROFILE = 'sdlc';
const END = /^<!-- cc-harness:end -->[ \t]*$/;
const HEADING = /^#{1,6}(?:[ \t]|$)/;

export function harnessVersion() {
  return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
}

export const claudeMdPath = (root) => path.join(root, 'CLAUDE.md');

// '## Profile: <name>' and templates/profile-<name>.md, or '' for sdlc and for a profile
// without a template (reported through `warn`). loadProfile rejects names that are not a
// profile of this installation — a path separator or '..' included — before any file is read.
function profileSection(profile, warn) {
  loadProfile(profile);
  if (profile === DEFAULT_PROFILE) return '';
  const file = path.join(PACKAGE_ROOT, 'templates', `profile-${profile}.md`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw new HarnessError(`${file}: cannot read (${e.code || e.message})`, { code: 'io' });
    warn?.(`no CLAUDE.md section for profile ${profile}`);
    return '';
  }
  return `## Profile: ${profile}\n${text.replace(/\r\n/g, '\n').replace(/\n+$/, '')}`;
}

/**
 * The block for `language` (config.language, optional) and `profile` (config.profile, default
 * sdlc), markers included, '\n' line endings. The profile section goes before the closing
 * paragraph of templates/claude-block.md.
 */
export function renderBlock({ language, profile = DEFAULT_PROFILE, warn } = {}) {
  const rule = language
    ? `Talk with the user (explanations, questions, reports) in \`${language}\` (config.language), even when a skill, agent or tool writes in English.`
    : 'Talk with the user in the language the user writes in.';
  let template;
  try {
    template = fs.readFileSync(TEMPLATE, 'utf8');
  } catch (e) {
    throw new HarnessError(`${TEMPLATE}: cannot read (${e.code || e.message})`, { code: 'io' });
  }
  let body = template.replace(/\r\n/g, '\n').replace('{{language}}', rule).replace(/\n+$/, '');
  const section = profileSection(profile, warn);
  if (section) {
    const at = body.lastIndexOf('\n\n');
    body = `${body.slice(0, at)}\n\n${section}${body.slice(at)}`;
  }
  return `<!-- cc-harness:begin v${harnessVersion()} profile=${profile} -->\n${body}\n<!-- cc-harness:end -->`;
}

// Lines of a buffer with byte offsets. latin1 maps each byte to one char, so offsets are
// byte offsets and the markers (ASCII) are found whatever the file's encoding.
function linesOf(buf) {
  const text = buf.toString('latin1');
  const lines = [];
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf('\n', start);
    const next = nl === -1 ? text.length : nl + 1;
    const eolLen = nl === -1 ? 0 : (nl > start && text[nl - 1] === '\r' ? 2 : 1);
    lines.push({ start, contentEnd: next - eolLen, end: next, eol: text.slice(next - eolLen, next), text: text.slice(start, next - eolLen) });
    start = next;
  }
  return lines;
}

/**
 * Finds the block in `buf`. Returns null when there is none, else
 * { start, end, bodyStart, bodyEnd, version, profile, eol } (byte offsets of the begin line
 * start and the end line end, excluding its line terminator; the body is the bytes between
 * the begin line's terminator and the end line). Malformed markers throw HarnessError (exit 2)
 * with line numbers.
 */
export function findBlock(buf, label = 'CLAUDE.md') {
  const lines = linesOf(buf);
  const begins = [];
  const ends = [];
  lines.forEach((l, i) => {
    if (BEGIN.test(l.text)) begins.push(i);
    else if (END.test(l.text)) ends.push(i);
  });
  const at = (idx) => idx.map((i) => i + 1).join(', ');
  if (begins.length > 1) throw new HarnessError(`${label}: more than one '<!-- cc-harness:begin -->' marker (lines ${at(begins)}); fix the file by hand, it was not changed`, { code: 'claude_md_invalid' });
  if (ends.length > 1) throw new HarnessError(`${label}: more than one '<!-- cc-harness:end -->' marker (lines ${at(ends)}); fix the file by hand, it was not changed`, { code: 'claude_md_invalid' });
  if (!begins.length && !ends.length) return null;
  if (!ends.length) throw new HarnessError(`${label}: '<!-- cc-harness:begin -->' at line ${at(begins)} has no '<!-- cc-harness:end -->'; fix the file by hand, it was not changed`, { code: 'claude_md_invalid' });
  if (!begins.length || ends[0] < begins[0]) throw new HarnessError(`${label}: '<!-- cc-harness:end -->' at line ${at(ends)} has no '<!-- cc-harness:begin -->' before it; fix the file by hand, it was not changed`, { code: 'claude_md_invalid' });
  const b = lines[begins[0]];
  const e = lines[ends[0]];
  const m = BEGIN.exec(b.text);
  return { start: b.start, end: e.contentEnd, bodyStart: b.end, bodyEnd: e.start, version: m[1] ?? null, profile: m[2] ?? DEFAULT_PROFILE, eol: b.eol || e.eol || '\n' };
}

function refuseSymlink(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw new HarnessError(`${file}: cannot read (${e.code || e.message})`, { code: 'io' });
  }
  if (st.isSymbolicLink()) throw new HarnessError('CLAUDE.md is a symbolic link — harness does not write through links; replace it with a regular file or manage the block by hand', { code: 'claude_md_symlink' });
  return true;
}

// The text between the markers of `block` (from findBlock or renderBlock), '\r\n' read as '\n'.
const bodyOf = (buf, found) => buf.subarray(found.bodyStart, found.bodyEnd).toString('utf8').replace(/\r\n/g, '\n');
const renderedBody = (block) => block.slice(block.indexOf('\n') + 1, block.lastIndexOf('\n') + 1);

// A versioned block whose marker names `profile` and whose body equals `block` (rendered for
// the config now) is current, whatever version its marker names (SPEC §4.1).
const sameContent = (buf, found, block, profile) =>
  found.version !== null && found.profile === profile && bodyOf(buf, found) === renderedBody(block);

/**
 * The block state of <root>/CLAUDE.md without changing anything:
 * { state: 'missing'|'outdated'|'current', reason, version, current, profile? } — 'missing'
 * covers a missing file; an unversioned (v1) block is 'outdated'; a block written for another
 * profile than the config's is 'outdated' with `profile` set to the block's; otherwise the
 * block is 'current' when its body equals the block the config renders now.
 * A symbolic link, malformed markers or an unreadable template throw HarnessError (exit 2).
 */
export function blockStatus(root) {
  const file = claudeMdPath(root);
  const current = harnessVersion();
  if (!refuseSymlink(file)) return { state: 'missing', reason: 'CLAUDE.md does not exist', version: null, current };
  const buf = fs.readFileSync(file);
  const block = findBlock(buf);
  if (!block) return { state: 'missing', reason: 'CLAUDE.md has no cc-harness block', version: null, current };
  if (!block.version) {
    return { state: 'outdated', reason: `CLAUDE.md block is an unversioned (v1) block, harness is v${current}`, version: null, current };
  }
  const { language, profile = DEFAULT_PROFILE } = isInitialized(root) ? loadConfig(root) : {};
  if (block.profile !== profile) {
    return { state: 'outdated', reason: `CLAUDE.md block is for profile ${block.profile}, config profile is ${profile}`, version: block.version, current, profile: block.profile };
  }
  if (!sameContent(buf, block, renderBlock({ language, profile }), profile)) {
    return { state: 'outdated', reason: `CLAUDE.md block is outdated (content differs; block v${block.version}, harness v${current})`, version: block.version, current };
  }
  return { state: 'current', reason: `CLAUDE.md block is current (content unchanged since v${block.version})`, version: block.version, current };
}

/** 'missing' | 'outdated (v…)' | 'current (v…)' — the short form status and doctor print. */
export function describeStatus(s) {
  if (s.state === 'missing') return 'missing';
  if (s.state === 'outdated' && s.profile) return `outdated (profile ${s.profile})`;
  if (s.state === 'outdated') return `outdated (${s.version ? `v${s.version}` : 'v1, unversioned'})`;
  return `current (v${s.version})`;
}

/** The new file content for `buf` (null = no file) with `block` in place (SPEC §4.1). */
export function applyBlock(buf, block, { title }) {
  if (buf === null) return Buffer.from(`# ${title}\n\n${block}\n`, 'utf8');
  const found = findBlock(buf);
  if (found) {
    const text = found.eol === '\n' ? block : block.replace(/\n/g, found.eol);
    return Buffer.concat([buf.subarray(0, found.start), Buffer.from(text, 'utf8'), buf.subarray(found.end)]);
  }
  const lines = linesOf(buf);
  const heading = lines.find((l) => HEADING.test(l.text));
  const eol = lines.find((l) => l.eol)?.eol || '\n';
  const nl = (s) => (eol === '\n' ? s : s.replace(/\n/g, eol));
  if (!heading) {
    return Buffer.concat([Buffer.from(nl(`${block}\n\n`), 'utf8'), buf]);
  }
  const rest = buf.subarray(heading.end);
  const next = lines[lines.indexOf(heading) + 1];
  const pre = heading.eol ? '' : eol;
  const post = next && next.text.trim() !== '' ? `${eol}${eol}` : eol;
  return Buffer.concat([buf.subarray(0, heading.end), Buffer.from(`${pre}${eol}${nl(block)}${post}`, 'utf8'), rest]);
}

// Temp file in the same directory, then rename over the target: the old content stays
// whole when anything fails. `fsImpl` is injectable so tests can simulate a failure.
export function writeFileAtomic(file, data, { fsImpl = fs } = {}) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fsImpl.writeFileSync(tmp, data, { flag: 'wx' });
    try { fsImpl.chmodSync(tmp, fsImpl.statSync(file).mode & 0o7777); } catch { /* new file: default mode */ }
    fsImpl.renameSync(tmp, file);
  } catch (e) {
    try { fsImpl.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw new HarnessError(`${file}: write failed (${e.code || e.message}); previous content kept`, { code: 'io' });
  }
}

/**
 * Writes the current block into <root>/CLAUDE.md. Returns { action: 'created'|'updated'|'inserted'|'unchanged', from }.
 */
export function updateClaudeMd(root, { language, profile, warn, fsImpl = fs } = {}) {
  const file = claudeMdPath(root);
  const exists = refuseSymlink(file);
  const buf = exists ? fs.readFileSync(file) : null;
  const found = buf ? findBlock(buf) : null;
  const block = renderBlock({ language, profile, warn });
  if (found && sameContent(buf, found, block, profile ?? DEFAULT_PROFILE)) return { action: 'unchanged', from: found.version };
  const next = applyBlock(buf, block, { title: path.basename(path.resolve(root)) });
  const action = !buf ? 'created' : !found ? 'inserted' : next.equals(buf) ? 'unchanged' : 'updated';
  if (action !== 'unchanged') writeFileAtomic(file, next, { fsImpl });
  return { action, from: found ? found.version : null };
}
