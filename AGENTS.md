# cc-harness — development workflow

This project uses cc-harness: every feature goes from a written contract, through human
approval, to code that is checked by deterministic verification and then by an independent
evaluator. The rules below exist so that work always converges — either a feature passes,
or it stops and a human decides. They apply to any AI coding CLI reading this file.

`harness` below is the cc-harness CLI. If it is not on PATH, use `npx cc-harness <command>`.
The commands are: `harness init`, `harness lint-contract`, `harness approve`,
`harness verify`, `harness eval`, `harness run`, `harness status`, `harness doctor`,
`harness migrate-v1`. Run `harness --help` for options.

## State
All workflow state lives in `.harness/` and is tracked in git:
- `config.json` — profile, verify commands, thresholds, budgets, which CLI plays which role.
- `features.json` — each feature's id, title, security tier, dependencies and status.
- `contracts/F{n}.json` — the acceptance contract for one feature, frozen by hash on approval.
- `verdicts/F{n}-r{k}.json` — the verdict of each round.
- `backlog.json` — out-of-scope observations and re-scoping proposals.

Only the core writes status and verdicts. You read these files; you do not edit them
outside the `spec` step described below.

## The workflow
1. **Contract** (skill `spec`). Turn the request into `.harness/contracts/F{n}.json` and an
   entry in `features.json` with status `todo`. Every criterion needs a `check`: a shell
   command that exits 0 when the criterion is met. Ask the user about anything unclear
   before writing — a guess here becomes a wrong target later.
2. **Lint** (skill `plan`). Run `harness lint-contract F{n}` and fix every error it reports.
3. **Approval** (skill `plan`). Present the contract to the user. Only after they say yes,
   run `harness approve F{n}`. This records who approved it and freezes the contract by hash.
4. **Build** (skill `build`). Implement with test-driven development: failing test first,
   then the smallest change that passes, then the criterion's `check`.
5. **Verify**. Run `harness verify F{n}`. It runs the profile's verify commands, checks test
   integrity against the base branch, and runs every criterion's `check`.
6. **Evaluate**. Run `harness eval F{n}`. A separate, read-only session scores the feature
   and reports findings; the core decides pass or fail and records the verdict.
7. **Status**. `harness status` shows where every feature stands and what can run next.

Small, low-risk fixes use the skill `fix`: at most three files, not security-critical, and
still verified. Anything larger or security-related goes through the full workflow.

`harness run` performs steps 4–6 unattended for approved features, each in its own git
worktree, and writes a report to `.harness/runs/`. It never merges into protected branches.

## Why a contract must be decidable
A criterion that no command can decide ("cannot be bypassed in any way", "never leaks
anything") can always be argued to fail, so review of it never ends. The linter rejects
such universal claims unless they list concrete `cases`, each with its own `check`. Write
criteria as specific, finite behaviours: "`login` with an expired token exits 1 and prints
`token expired`", not "authentication is secure".

## Convergence rules
- The contract is frozen once approved. Changing a criterion means a new contract version
  and a new approval, never a silent edit.
- A finding blocks a feature only if it names a criterion id from the contract (or
  `REGRESSION`) and gives a `repro` command that the core re-runs and sees fail.
  Everything else goes to the backlog.
- A feature gets at most `max_rounds` rounds (default 3). From round 2 on, the set of
  blocking findings must shrink. If a previously passing criterion fails again, if the
  failures stop shrinking, or if the rounds run out, the feature becomes `blocked`.
- `blocked` means a human decides: split the feature, rewrite a criterion, or accept the
  risk. Do not keep retrying a blocked feature, and do not work around the block.
- Score = the lowest of five dimensions (functionality, quality, security, errors, tests).
  For `security_tier: critical`, a security score below 7 fails, and a second review by the
  security reviewer is required.

## Never do these
They either break the guarantees above or cause damage that is hard to undo:
- Edit anything under `.harness/` other than drafting a contract or feature entry during
  `spec`. Approved contracts, config, verdicts and statuses belong to the core and the user.
  `harness verify` fails a round whose diff touches `.harness/`.
- Mark a feature as passed, or set any status by hand.
- Push to, or merge into, `main` or any other protected branch. Merging to main is always
  a human decision.
- Skip, focus, delete or weaken tests to make verification pass.
- Run `harness approve` without the user's explicit approval in this conversation.
- Put a live infrastructure change (the `rollout` skill) into `harness run`. Live changes
  are always approved by a human, one at a time.

## Skills
Skills live in `skills/<name>/SKILL.md`. Load the one that matches the request:

| Skill | Use when |
|-------|----------|
| `spec` | A new feature or change is requested and needs a contract |
| `plan` | A contract exists and needs linting and user approval |
| `build` | An approved feature needs implementing, or a round's findings need fixing |
| `fix` | A small bug with a known cause: ≤3 files, not security-critical |
| `status` | The user asks where things stand or what to do next |
| `plan-review` | iac profile: review a `terraform plan` before apply |
| `rollout` | ops profile: change a live Kubernetes cluster, with human approval |

If a request is unclear, ask before choosing a skill. If a skill's steps conflict with what
the user asks for, follow the user and say what you skipped.

## Roles
`agents/builder.md`, `agents/evaluator.md` and `agents/security-reviewer.md` describe the
three roles. The core uses them as prompts for headless sessions; in Claude Code they are
also subagents. The evaluator and security reviewer are read-only and never the session
that wrote the code.

## Setup
- `harness init` creates `.harness/` in the project.
- `harness doctor` checks which CLIs are installed and whether the flags each role needs
  are available.
- `harness migrate-v1` converts state from the version 1 layout (`progress/`).
