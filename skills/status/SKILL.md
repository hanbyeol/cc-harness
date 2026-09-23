---
name: status
description: Show where every cc-harness feature stands and suggest the next step. Use when the user asks for progress, status, what is left, or what to do next.
---

# status — where things stand

1. Run `harness status`. It prints counts per status, every feature, and which approved
   features can run now (dependencies passed). If it says the project is not initialized,
   suggest `harness init`.
2. For features that are `blocked`, read the latest `.harness/verdicts/F{n}-r{k}.json` and
   the matching entries in `.harness/backlog.json`, and summarise the reason in one line.
3. Suggest the next step, in this order:
   - a `blocked` critical feature — needs the user's decision before anything else runs;
   - other `blocked` features — the user picks split, rewrite, or accept the risk;
   - runnable `approved` features — `build` skill, or `harness run` for unattended work;
   - `todo` features — `plan` skill to lint and approve;
   - nothing left — new work starts with the `spec` skill.
4. If `.harness/runs/` has a recent report, mention its file name and headline result.

Keep the answer short: the counts, anything blocked with its reason, and one recommended
next action. Status is read-only; do not change any file.
