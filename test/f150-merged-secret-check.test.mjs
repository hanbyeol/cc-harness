import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, realTmpdir } from './helpers.mjs';
import { resolveConfig, loadConfig } from '../lib/config.mjs';

const rejects = (fn, ...needles) => {
  assert.throws(fn, (e) => {
    assert.equal(e.code, 'config_invalid');
    assert.equal(e.exitCode ?? e.exit ?? 2, 2);
    for (const n of needles) assert.ok(e.message.includes(n), e.message);
    return true;
  });
};

test('F150 AC-1 the profile option replaces loadProfile', () => {
  assert.deepEqual(resolveConfig({}, { profile: { verify: { commands: ['x'] } } }).verify.commands, ['x']);
  assert.ok(resolveConfig({}).verify.commands.length >= 0);
});

test('F150 AC-2 a non-secret entry is accepted', () => {
  const c = resolveConfig({ run: { context_files: ['docs/MAP.md'] } }, { profile: { secret_globs: ['private/**'] } });
  assert.deepEqual(c.run.context_files, ['docs/MAP.md']);
});

test('F150 AC-3 SPEC §8 states the merged-config check', () => {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'SPEC.md'), 'utf8');
  const s8 = spec.slice(spec.indexOf('## 8. '), spec.indexOf('## 9. '));
  assert.ok(s8.split(/(?<=[.。])\s/).some((x) => x.includes('병합된') && x.includes('secret_globs')));
});

test('F150 SC-1 profile secret_globs reject a user context file', () => {
  rejects(() => resolveConfig({ run: { context_files: ['private/a.md'] } }, { profile: { secret_globs: ['private/**'] } }), 'run.context_files[0]', 'private/a.md');
});

test('F150 SC-2 profile context_files are checked against user secret_globs', () => {
  rejects(() => resolveConfig({ secret_globs: ['private/**'] }, { profile: { run: { context_files: ['private/a.md'] } } }), 'run.context_files[0]', 'private/a.md');
});

test('F150 SC-3 a profile giving both is checked', () => {
  rejects(() => resolveConfig({}, { profile: { secret_globs: ['private/**'], run: { context_files: ['docs/MAP.md', 'private/a.md'] } } }), 'run.context_files[1]');
  rejects(() => resolveConfig({}, { profile: { secret_globs: ['private/**'], run: { context_files: ['.env'] } } }), 'run.context_files[0]');
});

test('F150 SC-4 loadConfig still rejects the user file', () => {
  const root = realTmpdir('f150-');
  fs.mkdirSync(path.join(root, '.harness'));
  fs.writeFileSync(path.join(root, '.harness', 'config.json'), JSON.stringify({ secret_globs: ['private/**'], run: { context_files: ['private/a.md'] } }));
  rejects(() => loadConfig(root), 'run.context_files');
});

test('F150 ES-1 malformed merged values are config_invalid, not TypeError', () => {
  rejects(() => resolveConfig({}, { profile: { run: { context_files: 'private/a.md' } } }), 'run.context_files');
  rejects(() => resolveConfig({}, { profile: { secret_globs: 'private/**', run: { context_files: ['a.md'] } } }), 'secret_globs');
});
