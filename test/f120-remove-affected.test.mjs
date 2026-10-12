import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, harness } from './helpers.mjs';
import { resolveConfig } from '../lib/config.mjs';

const REMOVED_KEY = `affected${'_'}command`;
const WORDS = [REMOVED_KEY, `affected${'T'}estFiles`, `final${'_'}verify`];

function mjsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return mjsFiles(p);
    return e.name.endsWith('.mjs') ? [p] : [];
  });
}

test('F120 AC-1 lib/ has none of the removed names and the affected-verify test file is gone', () => {
  const files = mjsFiles(path.join(REPO, 'lib'));
  assert.ok(files.length > 20);
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const w of WORDS) assert.ok(!text.includes(w), `${path.relative(REPO, f)} contains ${w}`);
  }
  assert.equal(fs.existsSync(path.join(REPO, 'test', 'f114-affected-verify.test.mjs')), false);
});

test('F120 AC-2 config verify key removed in v2.0.67 is config_invalid naming the key', () => {
  assert.throws(
    () => resolveConfig({ verify: { [REMOVED_KEY]: 'node --test {files}' } }),
    (e) => e.code === 'config_invalid' && e.message.includes(`verify.${REMOVED_KEY}`) && e.message.includes('removed in v2.0.67'),
  );
});

test('F120 AC-2 harness verify --full is an unknown option (usage, exit 2)', () => {
  const r = harness(['verify', 'F1', '--full'], { cwd: REPO });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /unknown option '--full'/);
});

test('F120 AC-5 docs no longer mention the removed mode and SPEC 6.1 says it was removed in v2.0.67', () => {
  const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
  for (const f of ['docs/SPEC.md', 'docs/MAP.md', 'README.md']) {
    const text = read(f);
    for (const w of [REMOVED_KEY, `final${'_'}verify`, `final${' '}verify`]) assert.ok(!text.includes(w), `${f} contains ${w}`);
  }
  const spec = read('docs/SPEC.md');
  const s61 = spec.slice(spec.indexOf('### 6.1'), spec.indexOf('### 6.2'));
  assert.match(s61, /affected 모드[^\n]*v2\.0\.67 에서 뺐다/);
});
