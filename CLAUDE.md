# cc-harness (v2) — developing the harness itself

This repository is cc-harness v2 and uses its own workflow. The workflow for any project,
including this one, is in @AGENTS.md. Design rationale: `docs/brainstorms/2026-09-23-v2-from-scratch.md`.
Requirements: `docs/SPEC.md`. v1 is preserved at tag `v1.39.18-final`.

## Priority
Correctness > Safety > Speed.

## Running the core from this checkout
- `node bin/harness.mjs <command>` (there is no global install here).
- Tests: `node --test "test/**/*.test.mjs"`. One criterion: `node test/t.mjs "F3 AC-2"` —
  it fails when no test name starts with the id, so a mistyped check can never pass vacuously.
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
