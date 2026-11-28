---
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Agent, Bash, Edit, Write]
---

I am working on a cc-harness project (it has a `.harness/` directory). Quick fix please, use the fix skill: in src/token.js the error message `'invalid token'` should end with a period, `'invalid token.'`. It is a one-line change; update the test's regex too if it needs it.

The project's files, exactly as they are on disk:

`.harness/backlog.json`:

```
{
  "items": []
}
```

`.harness/config.json`:

```
{
  "profile": "sdlc",
  "base_branch": "main",
  "approval": "user",
  "verify": {
    "commands": ["npm test"]
  }
}
```

`.harness/contracts/F1.json`:

```
{
  "id": "F1",
  "title": "checkToken(given, expected) in src/token.js compares tokens in constant time",
  "security_tier": "critical",
  "version": 1,
  "acceptance_criteria": [
    {
      "id": "AC-1",
      "criterion": "checkToken('s3cret', 's3cret') in src/token.js returns true",
      "check": "node --test --test-name-pattern=\"F1 AC-1\" test/",
      "new": true
    }
  ],
  "security_criteria": [
    {
      "id": "SC-1",
      "criterion": "src/token.js compares equal-length tokens with crypto.timingSafeEqual",
      "check": "grep -q timingSafeEqual src/token.js",
      "new": true
    }
  ],
  "error_scenarios": [
    {
      "id": "ES-1",
      "criterion": "checkToken('s3', 's3cret') throws an Error whose message contains 'invalid token'",
      "check": "node --test --test-name-pattern=\"F1 ES-1\" test/",
      "new": true
    }
  ],
  "out_of_scope": [
    "token storage and rotation"
  ],
  "approval": {
    "by": "maintainer@example.invalid",
    "at": "2026-11-27T09:40:12.318Z",
    "hash": "6342c9107408cd6f5b9872b6135739cc16564aa9373af209a12cef612023ff38"
  }
}
```

`.harness/features.json`:

```
{
  "features": [
    {
      "id": "F1",
      "title": "checkToken(given, expected) in src/token.js compares tokens in constant time",
      "security_tier": "critical",
      "depends_on": [],
      "status": "passed"
    }
  ]
}
```

`package.json`:

```
{
  "name": "tokens",
  "version": "1.0.0",
  "type": "module",
  "imports": {
    "#src/*": "./src/*"
  },
  "scripts": {
    "test": "node --test \"test/**/*.test.js\""
  }
}
```

`src/token.js`:

```
import { timingSafeEqual } from 'node:crypto';

// checkToken(given, expected) is true only when both tokens are equal.
export function checkToken(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) throw new Error('invalid token');
  return timingSafeEqual(a, b);
}
```

`test/token.test.js`:

```
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkToken } from '#src/token.js';

test('F1 AC-1: checkToken accepts the expected token', () => {
  assert.equal(checkToken('s3cret', 's3cret'), true);
});

test('F1 ES-1: checkToken rejects a token of another length', () => {
  assert.throws(() => checkToken('s3', 's3cret'), /invalid token/);
});
```
