#!/usr/bin/env bats

# session-context.sh tests
# Verifies context injection and agent-comms archive rotation

PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
HOOK="$PLUGIN_ROOT/hooks/session-context.sh"

setup() {
  WORK=$(mktemp -d)
  cd "$WORK" && git init -q .
}

teardown() {
  rm -rf "$WORK"
}

run_hook() {
  CLAUDE_PROJECT_DIR="$WORK" bash "$HOOK"
}

@test "emits session context block" {
  run run_hook
  [ "$status" -eq 0 ]
  [[ "$output" == *"Session Context"* ]]
}

@test "archives evaluator-feedback files beyond max_files_per_type" {
  mkdir -p progress/agent-comms
  for i in 01 02 03 04 05 06 07 08 09 10 11 12 13; do
    echo '{}' > "progress/agent-comms/evaluator-feedback-2026-06-${i}T00-00-00.json"
  done
  run_hook >/dev/null
  [ "$(find progress/agent-comms -maxdepth 1 -name 'evaluator-feedback-*.json' | wc -l | tr -d ' ')" -eq 10 ]
  [ "$(find progress/agent-comms/archive -name 'evaluator-feedback-*.json' | wc -l | tr -d ' ')" -eq 3 ]
  # oldest files are the ones archived
  [ -f progress/agent-comms/archive/evaluator-feedback-2026-06-01T00-00-00.json ]
  [ -f progress/agent-comms/evaluator-feedback-2026-06-13T00-00-00.json ]
}

@test "respects custom max_files_per_type from harness-config.json" {
  mkdir -p progress/agent-comms
  echo '{"agent_comms": {"max_files_per_type": 2, "archive_enabled": true}}' > progress/harness-config.json
  for i in 1 2 3 4; do
    echo '{}' > "progress/agent-comms/change-request-2026-06-0${i}.json"
  done
  run_hook >/dev/null
  [ "$(find progress/agent-comms -maxdepth 1 -name 'change-request-*.json' | wc -l | tr -d ' ')" -eq 2 ]
}

@test "archive disabled: files left in place" {
  mkdir -p progress/agent-comms
  echo '{"agent_comms": {"max_files_per_type": 2, "archive_enabled": false}}' > progress/harness-config.json
  for i in 1 2 3 4; do
    echo '{}' > "progress/agent-comms/evaluator-feedback-2026-06-0${i}.json"
  done
  run_hook >/dev/null
  [ "$(find progress/agent-comms -maxdepth 1 -name 'evaluator-feedback-*.json' | wc -l | tr -d ' ')" -eq 4 ]
}

@test "non-timestamped agent outputs are never archived" {
  mkdir -p progress/agent-comms
  echo '{}' > progress/agent-comms/implementer-output.json
  for i in 01 02 03 04 05 06 07 08 09 10 11; do
    echo '{}' > "progress/agent-comms/evaluator-feedback-2026-06-${i}.json"
  done
  run_hook >/dev/null
  [ -f progress/agent-comms/implementer-output.json ]
}
