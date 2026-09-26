---
name: spec
description: Turn a feature request, change or removal into a decidable cc-harness contract (.harness/contracts/F{n}.json). Use when the user asks to add, change or remove a feature and no approved contract exists yet. Interviews the user first when interactive.
---

# spec — write a decidable contract

The contract is the only target the builder and evaluator will aim at, and it is frozen
once approved. Time spent making it precise here saves whole rounds later.

## 1. Understand the request
If you can talk to the user, interview them before writing anything. Ask only what you
cannot find in the code, a few questions at a time:
- What should be observably different when this is done? Ask for concrete examples:
  input, expected output, expected error.
- What is explicitly out of scope?
- Does it touch authentication, secrets, payments, permissions, or data deletion?
  If so, it is `security_tier: critical`.
- Does it depend on another feature that has not passed yet?

When running without a user (headless), do not guess missing requirements. Write down what
is unclear in the report and stop.

## 2. Draft the contract
Pick the next free id `F{n}` from `.harness/features.json`. Write
`.harness/contracts/F{n}.json`:

```json
{
  "id": "F3", "title": "Reject expired tokens", "security_tier": "standard", "version": 1,
  "acceptance_criteria": [
    {"id": "AC-1", "criterion": "login with an expired token exits 1 and prints 'token expired'",
     "check": "node test/t.mjs \"F3 AC-1\"", "new": true}
  ],
  "security_criteria": [],
  "error_scenarios": [
    {"id": "ES-1", "criterion": "a malformed token exits 2 with 'invalid token'",
     "check": "node test/t.mjs \"F3 ES-1\"", "new": true}
  ],
  "out_of_scope": ["token refresh"]
}
```

### Backlog items this feature resolves
Before drafting, read `.harness/backlog.json` (or `harness status`, which lists the open
`high` items). Each item has an id `B<n>`; it is open while it has no `resolved_by`.
Review the open `high` items and, for each one this feature actually fixes, put its id in
the optional `resolves` array (e.g. `"resolves": ["B12"]`) and cover the fix with a
criterion. When the feature is recorded `passed` (by `harness eval` or `harness run`), the
core sets `resolved_by` on those items; a fail or blocked leaves them open.
`harness lint-contract` rejects a `resolves` that is not an array of strings and warns
about an id that does not exist or is already resolved.

How the backlog is kept (the core does this; you only read it):
- ids `B1`, `B2`, … are given in file order to items without one; existing ids never change.
- the evaluator may give each backlog entry a `severity` (`high`, `medium`, `low`), recorded
  as the item's `priority`; any other value is ignored.
- the evaluator sees the open items and sets `backlog_id` when it reports the same issue
  again; the core then bumps that item's `seen` and adds the round to its `sources`
  instead of adding a duplicate. An unknown or resolved `backlog_id` adds a new item.

Then add `{"id": "F3", "title": "...", "security_tier": "standard", "depends_on": [], "status": "todo"}`
to `features.json`. Do not add an `approval` block; approval writes it.

## 3. Rules that make a criterion decidable
- Every criterion has a `check`: a shell command that exits 0 when it is met. Prefer
  running a named test (`node test/t.mjs "F3 AC-1"`, `pytest -k F3_AC_1`, `go test -run F3AC1`),
  so the test and the criterion share an id.
- Describe one observable behaviour per criterion: a command, an input, an output.
- `"new": true` marks behaviour that does not exist yet. Its check must fail on the base
  branch; a check that already passes proves nothing and is reported as vacuous.
- Avoid universal claims ("never", "cannot be bypassed", "any possible input", "no way to").
  No command can prove them, so they cause endless review. If the property matters, list
  the concrete cases in a `cases` array, each with its own `check`, or move the guarantee
  to an OS or platform control and say so in `out_of_scope`.
- Size limits: at most 12 AC, 8 SC, 8 ES. A bigger feature should be split.
- `security_tier: critical` needs at least one SC.
- IDs are `AC-n`, `SC-n`, `ES-n`, unique within the contract.
- Documentation criteria: put the feature's detailed description in a file under `docs/`
  (the SPEC or a topic page) and check that file. Keep a README change to one summary line,
  or none — features built in parallel each add README text, and together they can break a
  size limit that each of them met alone.

## 4. Hand off
Run `harness lint-contract F{n}` and fix every error. Then continue with the `plan` skill
to get the user's approval. Do not start implementing.
