// F64: the CLAUDE.md block carries a '## Profile: <name>' section for the iac and ops
// profiles (templates/profile-<name>.md), its begin marker names the profile, and a block
// written for another profile than the config's is outdated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, harness, project, readJson, writeJson, tmpdir } from './helpers.mjs';
import { HarnessError } from '../lib/errors.mjs';
import { harnessVersion, renderBlock } from '../lib/claudemd.mjs';

const VERSION = harnessVersion();
const END = '<!-- cc-harness:end -->';
const file = (dir) => path.join(dir, 'CLAUDE.md');
const text = (dir) => fs.readFileSync(file(dir), 'utf8');
const template = (name) => fs.readFileSync(path.join(REPO, 'templates', `profile-${name}.md`), 'utf8').replace(/\r\n/g, '\n');

function setProfile(dir, profile) {
  const cfg = path.join(dir, '.harness', 'config.json');
  const next = { ...readJson(cfg) };
  if (profile === undefined) delete next.profile;
  else next.profile = profile;
  writeJson(cfg, next);
}

// An initialized project whose CLAUDE.md was written by `harness claude-md` for `profile`.
function written(profile) {
  const dir = project();
  setProfile(dir, profile);
  const r = harness(['claude-md'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  return dir;
}

// The block between the markers, markers excluded.
function blockBody(content) {
  const m = /^<!-- cc-harness:begin [^\n]*-->\n([\s\S]*?)\n<!-- cc-harness:end -->$/m.exec(content);
  assert.ok(m, content);
  return m[1];
}

// The body of '## Profile: <name>': up to the blank line before the next '## ' heading or
// the block's closing sentence.
function profileSection(content, name) {
  const body = blockBody(content);
  const head = `## Profile: ${name}\n`;
  const at = body.indexOf(head);
  if (at === -1) return null;
  const rest = body.slice(at + head.length);
  const stop = rest.search(/\n\n(?:## |This block is managed)/);
  return stop === -1 ? rest : rest.slice(0, stop);
}

// ---------- AC-1 ----------
test('F64 AC-1 with profile iac the block has a Profile: iac section equal to templates/profile-iac.md', () => {
  const dir = written('iac');
  const section = profileSection(text(dir), 'iac');
  assert.ok(section !== null, text(dir));
  assert.equal(section, template('iac').replace(/\n+$/, ''));
  assert.equal(profileSection(renderBlock({ profile: 'iac' }), 'iac'), section);
});

test('F64 AC-1 templates/profile-iac.md covers plan diff, tf-check, plan-review, approval and destructive commands', () => {
  const t = template('iac');
  assert.match(t, /plan diff is the specification/);
  assert.ok(t.includes('`harness tf-check`'), 'verify is harness tf-check');
  assert.ok(t.includes('`plan-review` skill'), 'plan and apply through plan-review');
  assert.match(t, /terraform plan/);
  assert.match(t, /apply only after the user's explicit approval/);
  assert.match(t, /prod/);
  for (const s of ['databases', 'state backends', 'DNS']) assert.ok(t.includes(s), s);
  assert.match(t, /replace or destroy/);
  assert.match(t, /restate what will be lost, then ask/);
  for (const cmd of ['terraform apply -auto-approve', 'terraform destroy', 'terraform state rm']) assert.ok(t.includes(`\`${cmd}\``), cmd);
  assert.match(t, /without the user's approval/);
});

// ---------- AC-2 ----------
test('F64 AC-2 with profile ops the block has a Profile: ops section equal to templates/profile-ops.md', () => {
  const dir = written('ops');
  const section = profileSection(text(dir), 'ops');
  assert.ok(section !== null, text(dir));
  assert.equal(section, template('ops').replace(/\n+$/, ''));
  assert.equal(profileSection(text(dir), 'iac'), null);
});

test('F64 AC-2 templates/profile-ops.md covers offline validation, rollout, context and namespace, rollback', () => {
  const t = template('ops');
  assert.match(t, /offline/);
  assert.ok(t.includes('`kubeconform`'), 'kubeconform');
  assert.match(t, /verify/);
  assert.ok(t.includes('`rollout` skill'), 'rollout skill');
  assert.match(t, /one change at a time/);
  assert.match(t, /only after the user's approval/);
  assert.ok(t.includes('`harness run`'), 'never in harness run');
  assert.match(t, /kubectl context and the namespace/);
  assert.match(t, /rollback command/);
});

// ---------- AC-3 ----------
// The F62 block body: templates/claude-block.md with the Language rule filled in.
function f62Body(language) {
  const rule = language
    ? `Talk with the user (explanations, questions, reports) in \`${language}\` (config.language), even when a skill, agent or tool writes in English.`
    : 'Talk with the user in the language the user writes in.';
  return fs.readFileSync(path.join(REPO, 'templates', 'claude-block.md'), 'utf8').replace(/\r\n/g, '\n').replace('{{language}}', rule).replace(/\n+$/, '');
}

test('F64 AC-3 profile sdlc or no profile: no Profile section and the body equals the F62 block byte for byte', () => {
  for (const profile of ['sdlc', undefined]) {
    const dir = written(profile);
    const content = text(dir);
    assert.ok(!content.includes('## Profile:'), content);
    assert.equal(blockBody(content), f62Body());
  }
  assert.equal(blockBody(renderBlock({ language: 'ko' })), f62Body('ko'));
  assert.equal(blockBody(renderBlock({ profile: 'sdlc' })), f62Body());
  // The Profile section is the only difference from the sdlc block: without it, the iac and
  // ops bodies are the F62 block too.
  for (const name of ['iac', 'ops']) {
    const body = blockBody(renderBlock({ profile: name }));
    const section = `## Profile: ${name}\n${template(name).replace(/\n+$/, '')}\n\n`;
    assert.ok(body.includes(section), `${name}: ${body}`);
    assert.equal(body.replace(section, ''), f62Body(), name);
  }
});

// ---------- AC-4 ----------
test('F64 AC-4 the begin marker names the profile, sdlc included', () => {
  for (const [profile, name] of [['iac', 'iac'], ['ops', 'ops'], ['sdlc', 'sdlc'], [undefined, 'sdlc']]) {
    const content = text(written(profile));
    assert.ok(content.includes(`<!-- cc-harness:begin v${VERSION} profile=${name} -->\n`), content);
  }
  assert.ok(renderBlock().startsWith(`<!-- cc-harness:begin v${VERSION} profile=sdlc -->\n`));
});

test('F64 AC-4 a v2.0.30-style marker without profile= reads as sdlc', () => {
  const dir = project();
  fs.writeFileSync(file(dir), `# p\n\n<!-- cc-harness:begin v${VERSION} -->\nold\n${END}\n`);
  const r = harness(['claude-md', '--check'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  setProfile(dir, 'iac');
  const c = harness(['claude-md', '--check'], { cwd: dir });
  assert.equal(c.code, 1, c.stdout + c.stderr);
  assert.match(c.stdout, /CLAUDE\.md block is for profile sdlc, config profile is iac/);
});

test('F64 AC-4 a block for another profile is outdated for --check and status --brief until claude-md runs again', () => {
  const dir = written('sdlc');
  setProfile(dir, 'iac');
  const before = text(dir);
  const c = harness(['claude-md', '--check'], { cwd: dir });
  assert.equal(c.code, 1, c.stdout + c.stderr);
  assert.match(c.stdout, /CLAUDE\.md block is for profile sdlc, config profile is iac/);
  assert.equal(text(dir), before, '--check changes nothing');
  const b = harness(['status', '--brief'], { cwd: dir });
  assert.equal(b.code, 0, b.stdout + b.stderr);
  assert.ok(b.stdout.split('\n').some((l) => /^CLAUDE\.md block outdated .*— run harness claude-md$/.test(l)), b.stdout);
  assert.equal(text(dir), before, 'status --brief changes nothing');
  assert.equal(harness(['claude-md'], { cwd: dir }).code, 0);
  const ok = harness(['claude-md', '--check'], { cwd: dir });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  const b2 = harness(['status', '--brief'], { cwd: dir });
  assert.ok(!b2.stdout.includes('CLAUDE.md block'), b2.stdout);
  // And back: an iac block with config sdlc is outdated too.
  setProfile(dir, 'sdlc');
  const back = harness(['claude-md', '--check'], { cwd: dir });
  assert.equal(back.code, 1, back.stdout + back.stderr);
  assert.match(back.stdout, /CLAUDE\.md block is for profile iac, config profile is sdlc/);
});

// ---------- AC-5 ----------
test('F64 AC-5 the profile templates are at most 30 lines and every backticked skill exists under skills/', () => {
  for (const name of ['iac', 'ops']) {
    const t = template(name);
    assert.ok(t.replace(/\n+$/, '').split('\n').length <= 30, `${name}: more than 30 lines`);
    const skills = [...t.matchAll(/`([^`]+)` skill/g)].map((m) => m[1]);
    assert.ok(skills.length > 0, `${name}: names no skill`);
    for (const s of skills) assert.ok(fs.statSync(path.join(REPO, 'skills', s), { throwIfNoEntry: false })?.isDirectory(), `${name}: skills/${s}`);
  }
});

// ---------- AC-6 ----------
test('F64 AC-6 SPEC, docs/iac.md and README describe the profile section and the profile= marker', () => {
  for (const rel of ['docs/SPEC.md', 'docs/iac.md', 'README.md']) {
    const t = fs.readFileSync(path.join(REPO, rel), 'utf8');
    for (const s of ['## Profile:', 'profile=', 'templates/profile-iac.md']) assert.ok(t.includes(s), `${rel}: ${s}`);
  }
  const spec = fs.readFileSync(path.join(REPO, 'docs/SPEC.md'), 'utf8');
  const sec = spec.slice(spec.indexOf('### 4.1 '), spec.indexOf('**프로필(`profiles/*.json`)**'));
  for (const s of ['## Profile:', 'profile=', 'templates/profile-ops.md', 'CLAUDE.md block is for profile', 'no CLAUDE.md section for profile']) assert.ok(sec.includes(s), `SPEC §4.1: ${s}`);
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  assert.ok(readme.includes('templates/profile-ops.md'));
});

// A copy of the harness package (bin, lib, templates, profiles, package.json) in a temp dir,
// so a test can add profiles and templates without touching the repository.
function tempPackage() {
  const pkg = tmpdir('harness-pkg-');
  for (const d of ['bin', 'lib', 'templates', 'profiles']) fs.cpSync(path.join(REPO, d), path.join(pkg, d), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(pkg, 'package.json'));
  return pkg;
}

function run(pkg, dir, args) {
  const r = spawnSync(process.execPath, [path.join(pkg, 'bin', 'harness.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---------- SC-1 ----------
for (const value of ['../x', 'a/b', 'a\\b', '..']) {
  test(`F64 SC-1 profile ${JSON.stringify(value)} is unknown_profile with exit 2; no file outside profiles/ and templates/ is read`, () => {
    const pkg = tempPackage();
    const MARK = 'OUTSIDE-PROFILE-MARKER';
    // The files the value would reach if it were joined into a path.
    const targets = [path.join(pkg, 'profiles', `${value}.json`), path.join(pkg, 'templates', `profile-${value}.md`)];
    for (const t of targets) {
      fs.mkdirSync(path.dirname(t), { recursive: true });
      fs.writeFileSync(t, t.endsWith('.json') ? JSON.stringify({ rubric: { quality: MARK } }) : `${MARK}\n`);
    }
    const dir = project();
    setProfile(dir, value);
    const content = `# p\n\nmine\n`;
    fs.writeFileSync(file(dir), content);
    const r = run(pkg, dir, ['claude-md']);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /unknown profile/);
    assert.ok(!(r.stdout + r.stderr).includes(MARK));
    assert.equal(text(dir), content, 'CLAUDE.md unchanged');
    assert.throws(() => renderBlock({ profile: value }), (e) => e instanceof HarnessError && e.code === 'unknown_profile');
  });
}

// ---------- ES-1 ----------
test('F64 ES-1 a profile without templates/profile-<name>.md: block without a Profile section, one warning, exit 0', () => {
  const pkg = tempPackage();
  fs.writeFileSync(path.join(pkg, 'profiles', 'data.json'), JSON.stringify({ name: 'data', description: 'test profile' }));
  const dir = project();
  setProfile(dir, 'data');
  const r = run(pkg, dir, ['claude-md']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const warnings = r.stderr.split('\n').filter((l) => l.trim());
  assert.equal(warnings.length, 1, r.stderr);
  assert.match(warnings[0], /no CLAUDE\.md section for profile data/);
  const content = text(dir);
  assert.ok(!content.includes('## Profile:'), content);
  assert.ok(content.includes(`<!-- cc-harness:begin v${VERSION} profile=data -->`), content);
  assert.equal(blockBody(content), f62Body());
  assert.equal(run(pkg, dir, ['claude-md', '--check']).code, 0);
});
