# Module map

One line per file under `lib/` (`.mjs`) and `bin/`: the path, then what the file is responsible for.
A test (`F112 AC-6`) fails when a file is missing here. Requirements are in `docs/SPEC.md`.

## bin
- bin/harness.mjs — CLI entry point: parses the command line, dispatches to lib/commands/*, maps errors to exit codes

## Core
- lib/run.mjs — `harness run`: `runFeatures`, the scheduler over the modules below (re-exports their public names)
- lib/run/state.mjs — run context (`initRun`), state file, resume, metrics, cost and stop controls
- lib/run/worktree.mjs — core git runner, integration branch and worktrees, taking over a blocked run's work
- lib/run/feature.mjs — one feature's rounds: build → verify → eval, convergence, final status
- lib/run/merge.mjs — merge into integration, pre/post-merge verify, conflict and verify recovery
- lib/run/report.mjs — run report and step tables
- lib/run/prompt.mjs — builder prompt, default build and evaluate calls; lib/run/preflight.mjs — role preflight, effective tier; lib/run/common.mjs — stop signals, constants, pure helpers
- lib/eval.mjs — independent evaluation: evaluator and security-reviewer calls, verdict rules, secret-path filtering of diffs
- lib/eval-status.mjs — interactive `harness eval`: records feature status with the same convergence rules as a run
- lib/verify.mjs — deterministic verify: verify commands, criterion checks, integrity (skip markers, test count, .harness changes)
- lib/verify-cache.mjs — verify result cache keyed by a digest of everything that decides the result
- lib/contract.mjs — contract loading, lint rules, canonical hash and approval
- lib/config.mjs — config defaults, validation and resolution (profile ← user config)
- lib/state.mjs — `.harness/` paths, features.json and JSON file reading/writing, verdict rounds
- lib/backlog.mjs — backlog.json items: findings that did not block, ids, priorities, closing
- lib/failures.mjs — failure records cut to prompt size, the redactor for secrets, flaky test names
- lib/retryfiles.mjs — partial re-run of a failed `node --test` command from the test files that failed
- lib/testcount.mjs — verify.test_count presets that count tests per runner

## Support
- lib/errors.mjs — HarnessError with exit code and error code
- lib/exec.mjs — process spawning with timeouts, restricted environment, git timeout errors
- lib/glob.mjs — path globs and the secret-path rule (isSecretPath)
- lib/util.mjs — small shared helpers
- lib/tmp.mjs — temporary directories the core creates and removes at exit
- lib/sleep.mjs — keeps the machine awake during a run and detects timeouts caused by sleep
- lib/jsonpos.mjs — locates the offset of a JSON syntax error for messages
- lib/roles.mjs — loads the role prompts (agents/*.md) used by headless calls
- lib/claudemd.mjs — builds the managed block of a project's CLAUDE.md from templates

## Records and feedback
- lib/events.mjs — event log (.harness/events/*.jsonl) writer and reader
- lib/metrics.mjs — step metrics lines (.harness/runs/*.metrics.jsonl) and their aggregation
- lib/usage.mjs — adapter usage (turns, tokens, session) and model mismatch detection

## Adapters
- lib/adapters/index.mjs — adapter registry, role resolution, model policy and independence classification
- lib/adapters/common.mjs — shared adapter machinery: process invocation, output extraction, never-throwing run
- lib/adapters/claude.mjs — Claude Code CLI adapter
- lib/adapters/codex.mjs — Codex CLI adapter (experimental)
- lib/adapters/gemini.mjs — Gemini CLI adapter
- lib/adapters/generic.mjs — configurable adapter for any headless CLI that reads its prompt on stdin

## Commands
- lib/commands/approve.mjs — `harness approve`: freezes a contract by hash after user approval
- lib/commands/backlog.mjs — `harness backlog close`: closes backlog items with a reason
- lib/commands/claude-md.mjs — `harness claude-md`: writes or checks the managed CLAUDE.md block
- lib/commands/decide.mjs — `harness decide`: records a human decision about a blocked feature
- lib/commands/doctor.mjs — `harness doctor`: detects CLIs and reports whether each role is usable
- lib/commands/eval.mjs — `harness eval`: one interactive evaluation round
- lib/commands/events.mjs — `harness events`: prints the redacted event log
- lib/commands/init.mjs — `harness init`: creates `.harness/` for a project
- lib/commands/lint-contract.mjs — `harness lint-contract`: checks contracts against the lint rules
- lib/commands/migrate-v1.mjs — `harness migrate-v1`: converts a v1 project
- lib/commands/run.mjs — `harness run`: argument handling and report output around lib/run.mjs
- lib/commands/stats.mjs — `harness stats`: aggregates run metrics
- lib/commands/status.mjs — `harness status`: feature and backlog overview
- lib/commands/tf-check.mjs — `harness tf-check`: terraform validate and fmt check for the iac profile
- lib/commands/verify.mjs — `harness verify`: runs deterministic verification for a feature
