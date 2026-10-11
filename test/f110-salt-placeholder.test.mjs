import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { redactor, redactDeep } from '../lib/failures.mjs';

// F110: redactDeep redacts keys only when asked (the events ask).

// ---------- AC-3 ----------
test('F110 AC-3 redactDeep keeps keys by default and the event paths ask for key redaction', () => {
  const secret = 'f110-secret-value-987';
  const redact = redactor({ F110_SECRET: secret });
  const plain = redactDeep({ [secret]: secret, nested: { [`k-${secret}`]: 1 } }, redact);
  assert.deepEqual(plain, { [secret]: '[redacted]', nested: { [`k-${secret}`]: 1 } });
  const keyed = redactDeep({ [secret]: secret }, redact, undefined, { keys: true });
  assert.deepEqual(keyed, { '[redacted]': '[redacted]' });
  for (const file of [path.join('lib', 'events.mjs'), path.join('lib', 'commands', 'events.mjs')]) {
    const src = fs.readFileSync(path.join(REPO, file), 'utf8');
    const calls = src.split('\n').filter((l) => l.includes('redactDeep(') && !l.includes('import'));
    assert.ok(calls.length > 0, file);
    for (const c of calls) assert.ok(c.includes('keys: true'), `${file}: ${c.trim()}`);
  }
});
