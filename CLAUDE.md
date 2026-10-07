# cc-harness (v2) — developing the harness itself

<!-- cc-harness:begin v2.0.35 profile=sdlc -->
## Language
Talk with the user in the language the user writes in.
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
<!-- cc-harness:end -->

This repository is cc-harness v2 and uses its own workflow. The workflow for any project,
including this one, is in @AGENTS.md. Design rationale: `docs/brainstorms/2026-09-23-v2-from-scratch.md`.
Requirements: `docs/SPEC.md`. v1 is preserved at tag `v1.39.18-final`.

## Priority
Correctness > Safety > Speed.

## Running the core from this checkout
- `node bin/harness.mjs <command>` (there is no global install here).
- Tests: `node --test "test/**/*.test.mjs"`. One criterion: `node test/t.mjs "F3 AC-2"` —
  it fails when no test name starts with the id, so a mistyped check can never pass vacuously.
  It loads only the test files whose source contains the id; when no file contains it (a test
  name built from a template), it runs every test file.
- Load stress: `node test/stress.mjs 2` runs two complete test suites concurrently — the load
  a parallel `harness run` puts on one machine (verify pool plus builders) — and exits 0
  only if every run passes; otherwise it prints each failing test with the number of runs it
  failed in. Run it whenever you write or change a test that depends on timing (timeouts,
  sleeps, process start, waiting for a file) and before you finish such a change; it takes a few
  minutes. A test that only passes on an idle machine is not done. Fix it by waiting on an
  explicit condition with a generous bound, not by asserting a tighter wall-clock time. It is not
  part of CI. `node test/stress.mjs 3` is the harder bar — three concurrent suites still fail
  some timing tests; that is backlog. `--files '<glob>'` (e.g. `node test/stress.mjs 3 --files
  'test/f2[3568]-*.test.mjs'`) stresses only the matching test files.
- Weakened tests: `node test/assert-count.mjs` compares each test file with its version at the
  merge base of the base branch and exits 1 when an assert was removed, a test name changed or
  a file was deleted. Run it after changing existing tests to make them stable.
- Node ≥ 22, zero runtime dependencies, must work on Windows, macOS and Linux.

## Rules that keep this project converging
These exist because v1 looped 43+ evaluator rounds on one feature. Do not relax them.
- Every criterion has a finite, executable `check`. Universal negatives ("no way to bypass")
  are rejected by `harness lint-contract`; enumerate cases or move the control to the OS.
- Contracts are frozen by hash on approval. Changing one means `harness approve` again,
  which only the user can authorize.
- A finding blocks only with an in-contract criterion id (or REGRESSION) and a repro the
  core reproduces. Anything else goes to `.harness/backlog.json`.
- Threat model D1: the builder is cooperative. Findings that need deliberate manipulation of
  git internals/config or shell semantics are out of scope, even with a repro.
- At most 3 rounds per feature with a strictly shrinking set of failing criteria; otherwise
  the feature is blocked and the user decides. No in-process firewall or integrity hooks.
- Evaluation runs in a separate context (ideally a different model) and only it decides
  pass/fail. The implementer never marks a feature passed.
- A regression test for a fix must fail with the fix removed — check it by reverting the fix.

## Conventions
- Code, comments in code, and commit messages in English; discussion with the user in Korean.
- When implementation reveals a gap in `docs/SPEC.md`, fix the spec in the same change.
