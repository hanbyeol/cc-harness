---
name: auto
description: Run the cc-harness loop autonomously — check status, build every runnable feature in parallel worktrees, verify, evaluate, merge and push what passed, prune, repeat until nothing is left. Use when the user asks to keep going on its own, to run the backlog of approved features, or runs /loop /cc-harness:auto.
---

# auto — one pass of the autonomous loop

## Language
Talk with the user in the language set in `config.language` (`.harness/config.json`); when
it is not set, in the language the user writes in. Keep code, code comments, commit
messages and a contract's ids and `check` commands in English.

## Steps
Run it repeatedly with `/loop /cc-harness:auto`; each invocation is one pass. The plugin's `auto-allow` hook lets the core commands run without a permission prompt
(`harness approve` only when `config.approval` is `auto`).

1. Run `harness status`. When no feature is runnable and none is in progress, say there is
   nothing to do and end the pass — and the loop.
2. For every runnable feature, in parallel: `harness worktree add F{n}` (prints the path), then
   start a `builder` subagent for it in that worktree (follow the `build` skill there). Start them
   all in one message so they run at the same time.
3. When a builder returns, run `harness verify F{n}` in its worktree; fix a failed verify and
   run it again. Then `harness eval F{n}` (a separate context decides the verdict, never you).
4. `passed`: merge the feature branch into the base branch and push it — no pull request, no
   force-push — then run `harness worktree prune`.
5. Failed: fix the blocking findings within the rounds that are left (the `build` skill, round
   2 or later), then verify and eval again.
6. Stop and ask the user only for: a feature that is `blocked`, a change outside this repository,
   or anything destructive (deleting data, force-pushing, rewriting history). Everything else —
   failed checks, the next round, merge conflicts you can resolve — keep going.
7. End the pass with what needs the user first, then what passed, merged and pruned.
