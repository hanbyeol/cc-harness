---
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Agent, Bash, Edit, Write]
---

I am working on a cc-harness project (it has a `.harness/` directory). Quick fix please: rename the function `greet` to `welcome` everywhere. It is defined in src/greet.js and used in src/format.js, src/names.js, src/cli.js and test/greet.test.js, so change all five files.

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
  "title": "greet(name) returns the greeting line for one name",
  "security_tier": "standard",
  "version": 1,
  "acceptance_criteria": [
    {
      "id": "AC-1",
      "criterion": "greet('Ada') returns 'Hello, Ada!'",
      "check": "node --test --test-name-pattern=\"F1 AC-1\" test/",
      "new": true
    }
  ],
  "security_criteria": [],
  "error_scenarios": [],
  "out_of_scope": [
    "languages other than English"
  ],
  "approval": {
    "by": "maintainer@example.invalid",
    "at": "2026-11-27T09:34:29.124Z",
    "hash": "fcbb4e7c75e85ed4ed01b0c5a1beba1727a1019920259a4f3399bd24b732b7da"
  }
}
```

`.harness/features.json`:

```
{
  "features": [
    {
      "id": "F1",
      "title": "greet(name) returns the greeting line for one name",
      "security_tier": "standard",
      "depends_on": [],
      "status": "passed"
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
