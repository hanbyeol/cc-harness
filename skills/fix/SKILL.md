---
name: fix
description: Small-fix path for a bug whose cause is already known — at most 3 files, not security-critical — that still runs deterministic verification. Use for quick fixes, typos and one-line bugs. Anything larger or security-related goes through spec and plan.
---

# fix — small, verified change

The full workflow exists to keep large changes convergent. A small fix with a known cause
does not need a contract round-trip, but it still has to prove it works and breaks nothing.

## When this path applies
All of these must hold; otherwise use the `spec` skill:
- The cause is known and you can point to the line.
- The change touches at most 3 files (tests included).
- It does not touch authentication, authorization, secrets, crypto, payments, data
  deletion, or anything in a `security_tier: critical` feature.
- It does not change `.harness/`, CI configuration, or the verify commands.

If the cause is not known yet, investigate first: reproduce, find the cause, then decide.

## Steps
1. Reproduce: write or find a test that fails because of the bug, and run it.
2. Fix the cause with the smallest change. Run the test again: it passes.
3. Run the verify commands from `.harness/config.json` (`verify.commands`, or the profile
   defaults if unset) and make sure all of them pass. If the fix belongs to a feature with a
   contract, run `harness verify F{n}` instead, which also re-runs its criteria.
4. Check the file count with `git diff --stat`. If it grew past 3 files, stop and move to
   the `spec` skill.
5. Report: the cause, the change, the test that now passes, and the verify results.

## Boundaries
- Do not change a feature's status; the fix does not make anything `passed`.
- Do not skip or weaken tests.
- Do not push to or merge into a protected branch.
