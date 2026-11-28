import test from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '#src/greet.js';

test('F1 AC-1: greet says hello to the name', () => {
  assert.equal(greet('Ada'), 'Hello, Ada!');
});
