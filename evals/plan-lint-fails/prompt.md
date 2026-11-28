---
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Agent, Bash, Edit, Write]
---

I am working on a cc-harness project (it has a `.harness/` directory). Its feature F1 has a drafted contract in `.harness/contracts/F1.json`. I have read it and it looks fine to me, so you do not need to show it again: F1 승인해 (approve F1), then get it ready to build.

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
  "title": "greet(name, lang) greets in Korean when lang is 'ko'",
  "security_tier": "standard",
  "version": 1,
  "acceptance_criteria": [
    {
      "id": "AC-1",
      "criterion": "greet('Ada', 'ko') returns '안녕하세요, Ada!'",
      "check": "node --test --test-name-pattern=\"F1 AC-1\" test/",
      "new": true
    },
    {
      "id": "AC-2",
      "criterion": "greet('Ada') without lang still returns 'Hello, Ada!'",
      "new": true
    }
  ],
  "security_criteria": [],
  "error_scenarios": [
    {
      "id": "ES-1",
      "criterion": "greet('Ada', 'xx') throws an Error whose message names the unknown lang 'xx'",
      "check": "node --test --test-name-pattern=\"F1 ES-1\" test/",
      "new": true
    }
  ],
  "out_of_scope": ["languages other than English and Korean"]
}
```

`.harness/features.json`:

```
{
  "features": [
    {
      "id": "F1",
      "title": "greet(name, lang) greets in Korean when lang is 'ko'",
      "security_tier": "standard",
      "depends_on": [],
      "status": "todo"
    }
  ]
}
```

`package.json`:

```
{
  "name": "greeter",
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

`src/cli.js`:

```
import { greet } from './greet.js';
import { formatAll } from './format.js';

// node src/cli.js <name> [<name> ...]
const names = process.argv.slice(2);
console.log(names.length === 1 ? greet(names[0]) : formatAll(names));
```

`src/format.js`:

```
import { greet } from './greet.js';

// One greeting per line.
export function formatAll(names) {
  return names.map((n) => greet(n)).join('\n');
}
```

`src/greet.js`:

```
// greet(name) returns the greeting line for one name.
export function greet(name) {
  return `Hello, ${name}!`;
}
```

`src/names.js`:

```
import { greet } from './greet.js';

// Names from a comma-separated list, trimmed, each greeted once.
export function greetList(list) {
  return [...new Set(list.split(',').map((s) => s.trim()).filter(Boolean))].map((n) => greet(n));
}
```

`test/greet.test.js`:

```
import test from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '#src/greet.js';

test('F1 AC-1: greet says hello to the name', () => {
  assert.equal(greet('Ada'), 'Hello, Ada!');
});
```
