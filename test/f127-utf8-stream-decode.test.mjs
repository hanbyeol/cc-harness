import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../lib/exec.mjs';

const NODE = process.execPath;
const WANT = '가나다가나다가나다';

// Writes the UTF-8 bytes of WANT to `stream`, split at byte 4, 300 ms apart.
const SPLIT = (stream) => `const b=Buffer.from(${JSON.stringify(WANT)});process.${stream}.write(b.subarray(0,4));setTimeout(()=>process.${stream}.write(b.subarray(4)),300)`;
const q = (s) => `"${s.replace(/"/g, '\\"')}"`;

test('F127 AC-1 stdout split mid-character stays intact (file/args and shell forms)', async () => {
  const a = await runCommand({ file: NODE, args: ['-e', SPLIT('stdout')] }, { timeoutSec: 30 });
  assert.equal(a.stdout, WANT);
  const b = await runCommand(`${q(NODE)} -e ${q(SPLIT('stdout'))}`, { timeoutSec: 30 });
  assert.equal(b.stdout, WANT);
});

test('F127 AC-2 stderr split mid-character stays intact', async () => {
  const a = await runCommand({ file: NODE, args: ['-e', SPLIT('stderr')] }, { timeoutSec: 30 });
  assert.equal(a.stderr, WANT);
});

test('F127 AC-3 output over MAX_OUTPUT has no U+FFFD', async () => {
  const code = `process.stdout.write(Buffer.from('가'.repeat(1200000)))`;
  const r = await runCommand({ file: NODE, args: ['-e', code] }, { timeoutSec: 60 });
  assert.equal(r.stdout.length, 1024 * 1024);
  assert.ok(!r.stdout.includes('�'));
  assert.ok(/^가+$/.test(r.stdout));
});

test('F127 ES-1 invalid byte becomes one U+FFFD', async () => {
  const code = `process.stdout.write(Buffer.from([0x61,0xff,0x62]))`;
  const r = await runCommand({ file: NODE, args: ['-e', code] }, { timeoutSec: 30 });
  assert.equal(r.stdout, 'a�b');
});

test('F127 ES-2 incomplete trailing sequence ends with one U+FFFD', async () => {
  const code = `process.stdout.write(Buffer.from('가').subarray(0,2))`;
  const r = await runCommand({ file: NODE, args: ['-e', code] }, { timeoutSec: 30 });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '�');
});
