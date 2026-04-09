#!/usr/bin/env bats

# session-handoff.sh tests
# Verifies that handoff produces valid JSON and handles edge cases

HOOK="hooks/session-handoff.sh"

setup() {
  TEST_DIR=$(mktemp -d)
  export CLAUDE_PROJECT_DIR="$TEST_DIR"
  mkdir -p "$TEST_DIR/progress"
  # Initialize a git repo for git log commands
  git -C "$TEST_DIR" init -q 2>/dev/null || true
  git -C "$TEST_DIR" config user.email "test@test.com" 2>/dev/null || true
  git -C "$TEST_DIR" config user.name "Test" 2>/dev/null || true
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "produces valid JSON output" {
  echo '{}' | bash "$HOOK"
  [ -f "$TEST_DIR/progress/session-handoff.json" ]
  jq '.' "$TEST_DIR/progress/session-handoff.json" > /dev/null
}

@test "output contains required fields" {
  echo '{}' | bash "$HOOK"
  jq -e '.timestamp' "$TEST_DIR/progress/session-handoff.json" > /dev/null
  jq -e '.phase' "$TEST_DIR/progress/session-handoff.json" > /dev/null
  jq -e '.completed' "$TEST_DIR/progress/session-handoff.json" > /dev/null
  jq -e '.pending' "$TEST_DIR/progress/session-handoff.json" > /dev/null
  jq -e '.recent_commits' "$TEST_DIR/progress/session-handoff.json" > /dev/null
  jq -e '.blockers' "$TEST_DIR/progress/session-handoff.json" > /dev/null
  jq -e '.next_actions' "$TEST_DIR/progress/session-handoff.json" > /dev/null
  jq -e '.key_decisions' "$TEST_DIR/progress/session-handoff.json" > /dev/null
}

@test "phase defaults to unknown without phase-gate.json" {
  echo '{}' | bash "$HOOK"
  PHASE=$(jq -r '.phase' "$TEST_DIR/progress/session-handoff.json")
  [ "$PHASE" = "unknown" ]
}

@test "reads phase from phase-gate.json" {
  cat > "$TEST_DIR/progress/phase-gate.json" <<'EOF'
{"current_phase": "implementation"}
EOF
  echo '{}' | bash "$HOOK"
  PHASE=$(jq -r '.phase' "$TEST_DIR/progress/session-handoff.json")
  [ "$PHASE" = "implementation" ]
}

@test "reads features from feature_list.json" {
  cat > "$TEST_DIR/progress/feature_list.json" <<'EOF'
{"features":[
  {"id":"F1","name":"Auth","passes":true},
  {"id":"F2","name":"Dashboard","passes":false}
]}
EOF
  echo '{}' | bash "$HOOK"
  DONE=$(jq -r '.completed | length' "$TEST_DIR/progress/session-handoff.json")
  PEND=$(jq -r '.pending | length' "$TEST_DIR/progress/session-handoff.json")
  [ "$DONE" -eq 1 ]
  [ "$PEND" -eq 1 ]
}

@test "no leftover tmp files after execution" {
  echo '{}' | bash "$HOOK"
  TMPS=$(find "$TEST_DIR/progress" -name "session-handoff.json.tmp*" 2>/dev/null | wc -l | tr -d ' ')
  [ "$TMPS" -eq 0 ]
}

@test "concurrent executions produce valid output" {
  for i in 1 2 3 4 5; do
    echo '{}' | bash "$HOOK" &
  done
  wait
  [ -f "$TEST_DIR/progress/session-handoff.json" ]
  jq '.' "$TEST_DIR/progress/session-handoff.json" > /dev/null
  TMPS=$(find "$TEST_DIR/progress" -name "session-handoff.json.tmp*" 2>/dev/null | wc -l | tr -d ' ')
  [ "$TMPS" -eq 0 ]
}

@test "merges draft handoff when present" {
  echo '{}' | bash "$HOOK"
  cat > "$TEST_DIR/progress/session-handoff-draft.json" <<'EOF'
{"blockers":["deployment blocker"],"key_decisions":["chose JWT over sessions"]}
EOF
  echo '{}' | bash "$HOOK"
  BLOCKERS=$(jq -r '.blockers | length' "$TEST_DIR/progress/session-handoff.json")
  DECISIONS=$(jq -r '.key_decisions | length' "$TEST_DIR/progress/session-handoff.json")
  [ "$BLOCKERS" -eq 1 ]
  [ "$DECISIONS" -eq 1 ]
  # Draft should be cleaned up
  [ ! -f "$TEST_DIR/progress/session-handoff-draft.json" ]
}

@test "timestamp is valid ISO8601" {
  echo '{}' | bash "$HOOK"
  TS=$(jq -r '.timestamp' "$TEST_DIR/progress/session-handoff.json")
  [[ "$TS" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
}
