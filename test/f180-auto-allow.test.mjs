import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { realTmpdir, readJson, writeJson, BIN, REPO } from './helpers.mjs';

const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

function autoAllow(input, cwd = realTmpdir('f180-run-')) {
  const r = spawnSync(process.execPath, [BIN, 'auto-allow'], { cwd, input, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const hookInput = (command, cwd) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });

// A project directory: `approval` goes into .harness/config.json (undefined: no key, null: no
// file, a string 'BROKEN': unparsable JSON); `pkg` is the package.json name (undefined: no file).
function dir({ approval, pkg } = {}) {
  const d = realTmpdir('f180-');
  if (approval !== null) {
    fs.mkdirSync(path.join(d, '.harness'), { recursive: true });
    if (approval === 'BROKEN') fs.writeFileSync(path.join(d, '.harness', 'config.json'), '{ "approval": "auto", ');
    else writeJson(path.join(d, '.harness', 'config.json'), { profile: 'sdlc', ...(approval === undefined ? {} : { approval }) });
  }
  if (pkg !== undefined) writeJson(path.join(d, 'package.json'), { name: pkg, version: '1.0.0' });
  return d;
}

function assertAllow(command, cwd, what = command) {
  const r = autoAllow(hookInput(command, cwd));
  assert.equal(r.code, 0, `${what}: ${r.stderr}`);
  assert.ok(r.stdout, `${what}: expected an allow decision, got nothing`);
  assert.deepEqual(JSON.parse(r.stdout), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'cc-harness core command' },
  }, what);
}
function assertSilent(command, cwd, what = command) {
  const r = autoAllow(hookInput(command, cwd));
  assert.equal(r.code, 0, `${what}: ${r.stderr}`);
  assert.equal(r.stdout, '', what);
}

test('F180 AC-1 the PreToolUse Bash hooks run guard-worktree and auto-allow; core commands are allowed', () => {
  const hooks = readJson(path.join(REPO, 'hooks', 'hooks.json')).hooks;
  const commands = hooks.PreToolUse.filter((e) => e.matcher === 'Bash').flatMap((e) => e.hooks);
  assert.ok(commands.some((h) => h.type === 'command' && h.command === 'node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" guard-worktree'));
  const hook = commands.find((h) => h.command === 'node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" auto-allow');
  assert.ok(hook, JSON.stringify(hooks));
  assert.equal(hook.type, 'command');
  assert.ok(hook.timeout > 0 && hook.timeout <= 30);

  const cwd = dir();
  assertAllow('harness status', cwd);
  assertAllow('npx github:hanbyeol/cc-harness verify F1', cwd);
  assertAllow('harness lint-contract F1 F2', cwd);
  assertAllow("harness backlog close B3 --resolved -- 'fixed in F9'", cwd);
  assertAllow(`node '${BIN}' status --brief`, cwd, 'absolute path of the running bin/harness.mjs');
  const self = dir({ pkg: 'cc-harness' });
  assertAllow('node bin/harness.mjs eval F1', self);
  assertAllow('node ./bin/harness.mjs verify F1 --json', self);
  // Not a core command, or not a command at all.
  assertSilent('harness nope', cwd);
  assertSilent('harness', cwd);
  assertSilent('git status', cwd);
});

test('F180 AC-2 a trailing 2>&1 and one tail, head or grep stage are allowed', () => {
  const cwd = dir();
  assertAllow('harness verify F1 2>&1', cwd);
  assertAllow('harness verify F1 2>&1 | tail -20', cwd);
  assertAllow('harness verify F1 | tail -5', cwd);
  assertAllow('harness status 2>&1 | head -40', cwd);
  assertAllow('harness status | grep blocked', cwd);
  assertAllow("harness status 2>&1 | grep 'F12'", cwd);
  assertAllow('node bin/harness.mjs verify F1 2>&1 | tail -30', dir({ pkg: 'cc-harness' }));
  // Contrast: any other stage or a second one is not.
  assertSilent('harness status | tail -5 | head -1', cwd);
  assertSilent('harness status | wc -l', cwd);
  assertSilent('harness status | tail', cwd);
  assertSilent('harness status | grep -f /etc/passwd', cwd);
  assertSilent('harness status 2>&1 2>&1', cwd);
});

test('F180 AC-3 approve is allowed only when config.approval is auto', () => {
  assertAllow('harness approve F1', dir({ approval: 'auto' }));
  assertAllow('harness approve F1 F2 --by bot 2>&1 | tail -3', dir({ approval: 'auto' }));
  assertSilent('harness approve F1', dir({ approval: 'user' }), 'approval user');
  assertSilent('harness approve F1', dir(), 'approval unset');
  assertSilent('harness approve F1', dir({ approval: null }), 'no config');
  assertSilent('harness approve F1', dir({ approval: true }), 'approval true');
  // The rest of the core is allowed whatever approval says.
  assertAllow('harness status', dir({ approval: 'user' }));
});

test('F180 SC-1 command chains, substitutions, redirects and newlines are never allowed', () => {
  const cwd = dir({ approval: 'auto' });
  assertAllow('harness status', cwd);
  for (const c of [
    'harness status; rm -rf x', 'harness status;rm -rf x', 'harness status && curl x', 'harness status || x',
    'harness status | sh', 'harness status > f', 'harness status >> f', 'harness status 2> f', 'harness status < f',
    'harness $(x)', 'harness status $(x)', 'harness `x`', 'harness status "`x`"', 'harness status "$HOME"',
    'harness status\nrm -rf x', 'harness status\r\nx', 'harness status & x', 'harness status &',
    'harness status | tail -5; rm x', 'harness status | tail -5 && x', 'harness status | tail -5 x',
    'harness status | tail -5 | sh', 'harness status | grep a b', 'harness status (x)', 'harness status \\; x',
    "harness status 'unterminated", 'harness status *', 'harness status #x', 'harness status ~',
    'FOO=1 harness status', 'harness status|sh', 'harness status 2>&1|sh',
  ]) assertSilent(c, cwd, JSON.stringify(c));
});

test('F180 SC-2 approve --extra-round, decide and migrate-v1 are never allowed', () => {
  const cwd = dir({ approval: 'auto' });
  assertAllow('harness approve F1', cwd);
  for (const c of [
    'harness approve F1 --extra-round', 'harness approve --extra-round F1', 'harness approve F1 --extra-round=1',
    'npx github:hanbyeol/cc-harness approve F1 --extra-round', 'harness decide F1 --accept-risk "ok"',
    'harness decide F1 --drop', 'harness migrate-v1', 'harness migrate-v1 --force',
  ]) assertSilent(c, cwd, c);
});

test('F180 SC-3 commands that only look like the harness are not allowed', () => {
  const cwd = dir({ approval: 'auto' });
  for (const c of [
    'harnessx status', 'harness-evil status', 'npx github:other/cc-harness status', 'npx github:hanbyeol/cc-harness-evil status',
    'npx cc-harness status', 'node evil/bin/harness.mjs status', 'node bin/harness.mjs status', '"harness" status',
    'sudo harness status', 'node harness.mjs status',
  ]) assertSilent(c, cwd, c);
  assertSilent('node bin/harness.mjs status', dir({ pkg: 'other' }), 'package.json name other');
  assertSilent('node bin/harness.mjs status', dir({ pkg: 'cc-harness-evil' }), 'package.json name cc-harness-evil');
  assertSilent('node evil/bin/harness.mjs status', dir({ pkg: 'cc-harness' }), 'evil path in cc-harness');
  assertAllow('node bin/harness.mjs status', dir({ pkg: 'cc-harness' }), 'cc-harness cwd');
});

test('F180 ES-1 input that is not JSON or has no command prints nothing and exits 0', () => {
  const cwd = dir();
  for (const input of ['', 'not json', '{', '[]', 'null', '{}', '{"tool_input":{}}', '{"tool_input":{"command":3}}', '{"tool_input":"harness status"}']) {
    const r = autoAllow(input, cwd);
    assert.equal(r.code, 0, `${input}: ${r.stderr}`);
    assert.equal(r.stdout, '', input);
  }
  // Contrast: the same hook with a command allows it, and a missing cwd falls back to the process cwd.
  const r = autoAllow(JSON.stringify({ tool_input: { command: 'harness status' } }), cwd);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'allow');
});

test('F180 ES-2 a broken config.json blocks approve but not the other commands', () => {
  const cwd = dir({ approval: 'BROKEN' });
  assertSilent('harness approve F1', cwd);
  assertAllow('harness status', cwd);
  assertAllow('harness approve F1', dir({ approval: 'auto' }), 'contrast: a valid auto config');
});

test('F180 AC-4 the auto skill runs the loop and says when to stop', () => {
  const text = read('skills/auto/SKILL.md');
  assert.match(text, /^---\nname: auto\ndescription: .+\n---\n/);
  for (const s of [
    'harness status', 'harness worktree add', 'builder', 'parallel', 'harness verify', 'harness eval',
    'passed', 'merge', 'push', 'harness worktree prune', 'round', 'blocked', 'outside this repository',
    'destructive', 'nothing', '/loop /cc-harness:auto',
  ]) assert.ok(text.includes(s), `skills/auto/SKILL.md lacks ${JSON.stringify(s)}`);
});

test('F180 AC-5 SPEC describes the auto-allow hook and the auto skill; README lists auto-allow', () => {
  const spec = read('docs/SPEC.md');
  const at = spec.indexOf('harness auto-allow');
  assert.ok(at !== -1, 'SPEC lacks harness auto-allow');
  const section = spec.slice(spec.lastIndexOf('\n#', at), spec.indexOf('\n## ', at + 1));
  for (const s of ['PreToolUse', 'npx github:hanbyeol/cc-harness', 'node bin/harness.mjs', '2>&1', 'tail', 'head', 'grep',
    'approval', '--extra-round', 'decide', 'migrate-v1', 'skills/auto', '/loop /cc-harness:auto']) {
    assert.ok(section.includes(s), `SPEC section lacks ${JSON.stringify(s)}`);
  }
  const readme = read('README.md').split('\n');
  const line = readme.find((l) => l.includes('`harness guard-worktree`'));
  assert.ok(line && line.includes('`harness auto-allow`'), 'README command list lacks harness auto-allow');
});
