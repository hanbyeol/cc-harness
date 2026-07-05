#!/usr/bin/env bats

# pre-compact.sh tests (F42 — PreCompact 훅)
# Verifies: (a) pre-compact writes a snapshot, (b) emits compaction-imminent
# guidance when no draft exists, (c) suppresses the signal when a draft exists
# (snapshot only), (d) fails open (exit 0) when snapshot inputs are malformed.

HOOK="hooks/pre-compact.sh"

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

@test "pre-compact writes a session-handoff snapshot" {
  run bash "$HOOK" <<< '{}'
  [ "$status" -eq 0 ]
  [ -f "$TEST_DIR/progress/session-handoff.json" ]
  jq '.' "$TEST_DIR/progress/session-handoff.json" > /dev/null
  jq -e '.timestamp' "$TEST_DIR/progress/session-handoff.json" > /dev/null
  jq -e '.phase' "$TEST_DIR/progress/session-handoff.json" > /dev/null
}

@test "snapshot reflects phase and features like the Stop hook" {
  cat > "$TEST_DIR/progress/phase-gate.json" <<'EOF'
{"current_phase": "implementation"}
EOF
  cat > "$TEST_DIR/progress/feature_list.json" <<'EOF'
{"features":[
  {"id":"F1","name":"Auth","passes":true},
  {"id":"F2","name":"Dashboard","passes":false}
]}
EOF
  run bash "$HOOK" <<< '{}'
  [ "$status" -eq 0 ]
  PHASE=$(jq -r '.phase' "$TEST_DIR/progress/session-handoff.json")
  [ "$PHASE" = "implementation" ]
  DONE=$(jq -r '.completed | length' "$TEST_DIR/progress/session-handoff.json")
  PEND=$(jq -r '.pending | length' "$TEST_DIR/progress/session-handoff.json")
  [ "$DONE" -eq 1 ]
  [ "$PEND" -eq 1 ]
}

@test "emits compaction-imminent guidance when no draft exists" {
  run bash "$HOOK" <<< '{}'
  [ "$status" -eq 0 ]
  # stdout must be valid JSON carrying additionalContext for the PreCompact event
  echo "$output" | jq -e '.hookSpecificOutput.hookEventName == "PreCompact"' > /dev/null
  echo "$output" | jq -e '.hookSpecificOutput.additionalContext | test("session-handoff-draft")' > /dev/null
}

@test "suppresses guidance signal when a draft already exists (snapshot only)" {
  cat > "$TEST_DIR/progress/session-handoff-draft.json" <<'EOF'
{"blockers":["deploy blocker"],"key_decisions":["chose X over Y"]}
EOF
  run bash "$HOOK" <<< '{}'
  [ "$status" -eq 0 ]
  # No guidance JSON emitted (avoid duplicate nudge)
  [ -z "$output" ]
  # Snapshot is still written
  [ -f "$TEST_DIR/progress/session-handoff.json" ]
  # Draft is NOT consumed by PreCompact — the Stop hook owns draft merge/cleanup
  [ -f "$TEST_DIR/progress/session-handoff-draft.json" ]
}

@test "fails open (exit 0) when snapshot inputs are malformed" {
  printf 'not valid json {{{' > "$TEST_DIR/progress/phase-gate.json"
  printf 'not valid json {{{' > "$TEST_DIR/progress/feature_list.json"
  run bash "$HOOK" <<< '{}'
  [ "$status" -eq 0 ]
}
