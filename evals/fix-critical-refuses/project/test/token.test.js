import test from 'node:test';
import assert from 'node:assert/strict';
import { checkToken } from '#src/token.js';

test('F1 AC-1: checkToken accepts the expected token', () => {
  assert.equal(checkToken('s3cret', 's3cret'), true);
});

test('F1 ES-1: checkToken rejects a token of another length', () => {
  assert.throws(() => checkToken('s3', 's3cret'), /invalid token/);
});
