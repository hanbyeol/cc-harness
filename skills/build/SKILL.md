---
name: build
description: Implement one approved cc-harness feature with test-driven development, then run harness verify and harness eval. Use when the user asks to implement or continue a feature whose contract is approved, or to fix the blocking findings of a failed round.
---

# build — implement one approved feature

## 0. Preconditions
Run `harness status`. The feature must be `approved` (or `in_progress` from an earlier
round) and its dependencies `passed`. If the contract is not approved, go back to the `plan`
skill — building against an unapproved target wastes rounds.

Work on a feature branch, not on a protected branch such as `main`.

## 1. Read the target
Read `.harness/contracts/F{n}.json`. The criteria and their `check` commands are the whole
target; `out_of_scope` is explicitly not your job. If this is round 2 or later, read the last
verdict in `.harness/verdicts/` and start with its blocking findings: each has a
`criterion_id` and a `repro` command.

In Claude Code you can delegate this step to the `builder` subagent; elsewhere, follow
`agents/builder.md` yourself.

## 2. Test first, per criterion
1. Write the test named after the criterion id and run it: it should fail, for the reason
   the criterion describes.
2. Make the smallest change that passes it.
3. Run the criterion's `check` from the contract.
4. Refactor only while everything stays green.

For a finding: run its `repro`, see it fail, fix the cause, see it exit 0.

Do not edit `.harness/`, do not add skip or focus markers, do not delete or weaken existing
tests. Verification detects all of these, so they only cost a round.

If a criterion is ambiguous or impossible, stop and tell the user which id and why. Do not
reinterpret it; a changed contract needs a new approval.

## 3. Verify
Run `harness verify F{n}`. It runs the profile's verify commands, checks that `.harness/` is
unchanged, that no skip markers were added and the test count did not drop, and runs every
criterion's `check` (new criteria must fail on the base). Fix failures and run it again.
A result marked flaky counts as a failure: make the test deterministic.

## 4. Evaluate
When verify passes, run `harness eval F{n}`. A separate read-only session scores the work,
and the core decides the verdict. You do not grade your own work, and you do not change
the verdict.

The core records the feature status from the verdict (the output ends with a `status:` line),
with the same convergence rules as `harness run`:

- **pass** → `passed`. Report to the user.
- **fail** → `in_progress` while rounds are left (the output shows `rounds left: n`): read the
  blocking findings in the new verdict and go back to step 2. Each round must reduce the set
  of blocking criterion ids.
- **fail** that cannot converge → `blocked`, with a reason: `divergence` (a criterion that
  was not blocking in the previous round blocks now), `stall` (the blocking set did not
  shrink), or `rounds` (the last round, `max_rounds`, failed).
- **needs-human** → `blocked` (`needs_human`). **eval_error** once leaves the status as it
  is — run `harness eval F{n}` again; twice in a row → `blocked` (`eval_error`).

When the feature is `blocked`, stop. Show the user the reason and the re-scoping options the
core wrote to `.harness/backlog.json` (split, rewrite a criterion, accept the risk). Do not
retry: `harness eval` refuses a `passed` or `blocked` feature. If the status could not be
written (exit 2, `io`), fix the cause and run `harness eval F{n}` again — it records the same
round without a new evaluation.

Findings without a reproducible defect go to the backlog automatically; do not act on them
in this feature.

## 5. Report
Tell the user: files changed, each criterion id and its result, the verdict and its round,
and anything added to the backlog. Committing is fine; pushing to or merging into a
protected branch is not — the user merges.
