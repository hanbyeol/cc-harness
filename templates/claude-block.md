## Language
{{language}}
Keep code, code comments, commit messages and a contract's ids and `check` commands in English.

## Workflow — cc-harness v2
In this project a feature is added, changed or removed **contract first**, code second.
When `harness` is not on PATH, run `npx github:hanbyeol/cc-harness <command>`.

1. **`spec` skill** — write `.harness/contracts/F{n}.json` and its `features.json` entry (`todo`).
   Every criterion needs an executable `check` (exit 0 on success). When unclear, ask the user first.
2. **`plan` skill** — `harness lint-contract F{n}` passes → show it to the user → only after
   **explicit approval** run `harness approve F{n}` (freezes the contract by hash).
3. **`build` skill** — TDD: a failing test → the smallest implementation → the criterion `check`.
4. `harness verify F{n}` → `harness eval F{n}`. The verdict comes from a separate session
   (ideally a different model) and the core.
5. `harness status` shows where things stand. Small, non-security fixes (3 files or fewer): **`fix` skill**.

## When to keep going and when to stop
- Keep going without asking when the next step needs no decision from the user: fixing a failed verify, the next round while rounds are left, running checks and tests. Put progress notes in the same message as the next action.
- Stop and ask only when you cannot continue without the user: approving a contract (`harness approve`), a feature that is `blocked`, a criterion that is ambiguous or contradictory, merging or pushing to a protected branch, and anything destructive (deleting data, force-pushing, changing anything outside this repository).
- End a long piece of work with what needs the user first, then what changed, then what was found.

## Convergence rules
- An approved contract is frozen. Changing a criterion = a new contract version + user re-approval.
- A finding blocks a feature only with a criterion id of the contract (or `REGRESSION`) and a
  `repro` the core reproduces. Anything else goes to `.harness/backlog.json`.
- At most `max_rounds` (default 3) rounds per feature, with a strictly shrinking set of failing
  criteria; otherwise the feature is `blocked` and the user decides.
- Score = the minimum of five dimensions (functionality, quality, security, errors, tests).
  `security_tier: critical` fails below security 7.
- A gap in the SPEC found during implementation is fixed in the SPEC in the same change.

## Prohibited
- Editing `.harness/` (except contract and feature drafts in the spec step), changing a feature's
  status by hand, marking your own work passed.
- Pushing or merging to a protected branch (`protected_branches`) — a human always decides.
- Skipping, deleting or weakening tests to get verify green.
- `harness approve` without the user's approval.

This block is managed by `harness claude-md`; edits inside it are replaced on the next update.
