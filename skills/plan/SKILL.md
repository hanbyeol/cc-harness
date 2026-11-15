---
name: plan
description: Lint one or more cc-harness contracts, present them as a plan, and record the user's approval with harness approve. Use after a contract is drafted and before any implementation, or when the user asks to approve features.
argument-hint: F{n} [F{m} ...]
---

# plan — lint, present, approve

Approval freezes a contract: from then on it is the fixed target for building and
evaluation. That is why it comes after the linter, and why the user gives it unless the
project's `config.approval` (`.harness/config.json`) is "auto".

## Language
Talk with the user in the language set in `config.language` (`.harness/config.json`); when
it is not set, in the language the user writes in. Keep code, code comments, commit
messages and a contract's ids and `check` commands in English.

## 1. Lint
Run `harness lint-contract F{n}` for each contract in the plan. Fix every error in the
contract file and run it again until it is clean. Common fixes:
- missing `check` — add a command that exits 0 when the criterion is met;
- universal claim ("never", "any possible", "cannot be bypassed") — rewrite as specific
  behaviour or list concrete `cases`, each with a `check`;
- too many criteria — split the feature;
- critical tier without SC — add a security criterion.

If a contract was already approved and you changed it, the linter reports a hash mismatch.
That is expected: bump `version` and get approval again.

## 2. Present the plan
Before presenting, pick the best solution for each feature and finish preparing the build:
read the code it touches, settle the approach and the build order, so building can start
right after approval. When several contracts are drafted together, present them in one batch.

Show the user, for each feature:
- id, title, security tier, dependencies;
- every criterion id with its one-line criterion and its `check`;
- what is out of scope;
- the build order (dependencies first) and whether it will be built interactively
  (`build` skill) or unattended (`harness run`).

Keep it short enough to read in a minute. Point out anything you are unsure about rather
than hiding it — this is the last cheap moment to change the target.

## 3. Approve
Read `approval` in `.harness/config.json` (missing means "user").

When config.approval is "auto": do not ask. Once lint passes and the plan is shown, run
`harness approve F{n} --by auto` (`harness approve F{n} F{m} --by auto` for the batch) right
away and continue with the `build` skill. The contract is frozen by hash exactly as with a
user approval. Decisions on a `blocked` feature (`harness decide`, `--extra-round`) still
stay with the user.

When config.approval is "user": ask the user explicitly whether to approve. Use your CLI's
plan-approval or question mechanism if it has one; otherwise ask in plain text and wait.

- On a clear yes: run `harness approve F{n} F{m} ...` for exactly the approved features, in
  one batch.
- On requested changes: edit the contract, lint again, present again.
- On no: leave the features as `todo`.

Unless config.approval is "auto", never run `harness approve` on your own judgement, and never
approve a feature the user did not name. Afterwards, `harness status` shows which features are ready to build.
