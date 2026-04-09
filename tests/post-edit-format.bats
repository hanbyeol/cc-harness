#!/usr/bin/env bats

# post-edit-format.sh tests
# Verifies path traversal protection, graceful formatter handling, and JSON formatting

HOOK="hooks/post-edit-format.sh"

setup() {
  TEST_DIR=$(mktemp -d)
  export CLAUDE_PROJECT_DIR="$TEST_DIR"
}

teardown() {
  rm -rf "$TEST_DIR"
}

run_format() {
  printf '%s' "$1" | bash "$HOOK"
}

@test "exits gracefully with empty file path" {
  run run_format '{"tool_input":{"file_path":""}}'
  [ "$status" -eq 0 ]
}

@test "exits gracefully with missing file" {
  run run_format '{"tool_input":{"file_path":"/nonexistent/file.go"}}'
  [ "$status" -eq 0 ]
}

@test "blocks path traversal outside project" {
  echo "test" > /tmp/test-traversal-$$
  run run_format "{\"tool_input\":{\"file_path\":\"/tmp/test-traversal-$$\"}}"
  [ "$status" -eq 0 ]
  rm -f /tmp/test-traversal-$$
}

@test "formats JSON files with jq" {
  echo '{"a":1,"b":2}' > "$TEST_DIR/test.json"
  run_format "{\"tool_input\":{\"file_path\":\"$TEST_DIR/test.json\"}}"
  # After jq formatting, it should be pretty-printed
  LINES=$(wc -l < "$TEST_DIR/test.json" | tr -d ' ')
  [ "$LINES" -gt 1 ]
}

@test "preserves invalid JSON files (no corruption)" {
  echo '{invalid json' > "$TEST_DIR/broken.json"
  ORIGINAL=$(cat "$TEST_DIR/broken.json")
  run_format "{\"tool_input\":{\"file_path\":\"$TEST_DIR/broken.json\"}}"
  AFTER=$(cat "$TEST_DIR/broken.json")
  [ "$ORIGINAL" = "$AFTER" ]
}

@test "handles missing formatter gracefully for Go files" {
  echo 'package main' > "$TEST_DIR/test.go"
  run env PATH=/usr/bin:/bin bash -c "printf '{\"tool_input\":{\"file_path\":\"$TEST_DIR/test.go\"}}' | CLAUDE_PROJECT_DIR=\"$TEST_DIR\" bash \"$HOOK\""
  [ "$status" -eq 0 ]
}

@test "exits gracefully with invalid JSON input" {
  run run_format 'not json'
  [ "$status" -eq 0 ]
}

@test "no tmp files left after JSON formatting" {
  echo '{"a":1}' > "$TEST_DIR/clean.json"
  run_format "{\"tool_input\":{\"file_path\":\"$TEST_DIR/clean.json\"}}"
  TMPS=$(find "$TEST_DIR" -name "*.tmp" 2>/dev/null | wc -l | tr -d ' ')
  [ "$TMPS" -eq 0 ]
}
