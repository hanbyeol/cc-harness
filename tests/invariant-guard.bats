#!/usr/bin/env bats

# invariant-guard.sh tests
# PreToolUse(Edit|Write|MultiEdit) 가드: 검증 장치 약화를 deny, add-only 강화는 허용

PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
HOOK="$PLUGIN_ROOT/hooks/invariant-guard.sh"

setup() {
  WORK=$(mktemp -d)
  mkdir -p "$WORK/progress" "$WORK/hooks" "$WORK/tests"
  # 기준 harness-config (현재 디스크 상태 = old)
  cat > "$WORK/progress/harness-config.json" <<'JSON'
{ "scoring": { "pass_threshold": 7, "security_thresholds": { "critical": 7, "standard": 5, "low": 3 } } }
JSON
}

teardown() { rm -rf "$WORK"; }

# Write 툴 입력 — file_path + content(new 전체)
run_write() {
  printf '%s' "$1" | bash "$HOOK"
}

mk_write_input() {
  jq -n --arg fp "$1" --arg content "$2" \
    '{tool_name:"Write", tool_input:{file_path:$fp, content:$content}}'
}

mk_edit_input() {
  jq -n --arg fp "$1" --arg old "$2" --arg new "$3" \
    '{tool_name:"Edit", tool_input:{file_path:$fp, old_string:$old, new_string:$new}}'
}

# --- harness-config threshold ---

@test "denies pass_threshold lowered 7 -> 5 (Write)" {
  NEW='{ "scoring": { "pass_threshold": 5, "security_thresholds": { "critical": 7, "standard": 5, "low": 3 } } }'
  run run_write "$(mk_write_input "$WORK/progress/harness-config.json" "$NEW")"
  [ "$status" -eq 2 ]
}

@test "allows pass_threshold raised 7 -> 8 (Write)" {
  NEW='{ "scoring": { "pass_threshold": 8, "security_thresholds": { "critical": 7, "standard": 5, "low": 3 } } }'
  run run_write "$(mk_write_input "$WORK/progress/harness-config.json" "$NEW")"
  [ "$status" -eq 0 ]
}

@test "denies security_thresholds.critical lowered 7 -> 6" {
  NEW='{ "scoring": { "pass_threshold": 7, "security_thresholds": { "critical": 6, "standard": 5, "low": 3 } } }'
  run run_write "$(mk_write_input "$WORK/progress/harness-config.json" "$NEW")"
  [ "$status" -eq 2 ]
}

@test "allows security_thresholds raised" {
  NEW='{ "scoring": { "pass_threshold": 7, "security_thresholds": { "critical": 8, "standard": 6, "low": 3 } } }'
  run run_write "$(mk_write_input "$WORK/progress/harness-config.json" "$NEW")"
  [ "$status" -eq 0 ]
}

@test "denies invalid JSON in harness-config" {
  run run_write "$(mk_write_input "$WORK/progress/harness-config.json" '{ not valid json ')"
  [ "$status" -eq 2 ]
}

@test "denies pass_threshold lowered via Edit new_string" {
  run run_write "$(mk_edit_input "$WORK/progress/harness-config.json" '"pass_threshold": 7' '"pass_threshold": 4')"
  [ "$status" -eq 2 ]
}

# --- firewall deny list add-only ---

@test "denies removal of a BLOCKED pattern (fewer patterns)" {
  cat > "$WORK/hooks/pre-bash-firewall.sh" <<'SH'
BLOCKED=(
  'rm -rf /'
  'git push.*--force'
  'mkfs'
)
SH
  NEW=$'BLOCKED=(\n  \'rm -rf /\'\n  \'git push.*--force\'\n)\n'
  run run_write "$(mk_write_input "$WORK/hooks/pre-bash-firewall.sh" "$NEW")"
  [ "$status" -eq 2 ]
}

@test "allows adding a BLOCKED pattern (more patterns)" {
  cat > "$WORK/hooks/pre-bash-firewall.sh" <<'SH'
BLOCKED=(
  'rm -rf /'
  'git push.*--force'
)
SH
  NEW=$'BLOCKED=(\n  \'rm -rf /\'\n  \'git push.*--force\'\n  \'mkfs\'\n)\n'
  run run_write "$(mk_write_input "$WORK/hooks/pre-bash-firewall.sh" "$NEW")"
  [ "$status" -eq 0 ]
}

# --- tests add-only ---

# 주의: bats 파서가 줄머리 @test 를 테스트로 오인하므로 heredoc 대신 printf로 작성한다.
@test "denies removal of @test cases" {
  T='@test'
  printf '%s "a" { true; }\n%s "b" { true; }\n%s "c" { true; }\n' "$T" "$T" "$T" > "$WORK/tests/sample.bats"
  NEW="$(printf '%s "a" { true; }\n%s "b" { true; }\n' "$T" "$T")"
  run run_write "$(mk_write_input "$WORK/tests/sample.bats" "$NEW")"
  [ "$status" -eq 2 ]
}

@test "allows adding @test cases" {
  T='@test'
  printf '%s "a" { true; }\n' "$T" > "$WORK/tests/sample.bats"
  NEW="$(printf '%s "a" { true; }\n%s "b" { true; }\n' "$T" "$T")"
  run run_write "$(mk_write_input "$WORK/tests/sample.bats" "$NEW")"
  [ "$status" -eq 0 ]
}

# --- self-protection ---

@test "denies shrinking invariant-guard.sh itself" {
  cp "$HOOK" "$WORK/hooks/invariant-guard.sh"
  NEW='#!/usr/bin/env bash
exit 0'
  run run_write "$(mk_write_input "$WORK/hooks/invariant-guard.sh" "$NEW")"
  [ "$status" -eq 2 ]
}

@test "denies shrinking INVARIANTS.md" {
  mkdir -p "$WORK/docs"
  cp "$PLUGIN_ROOT/docs/INVARIANTS.md" "$WORK/docs/INVARIANTS.md"
  run run_write "$(mk_write_input "$WORK/docs/INVARIANTS.md" "# INVARIANTS\n(gutted)")"
  [ "$status" -eq 2 ]
}

# --- unrelated files pass through ---

@test "allows edits to unrelated files" {
  run run_write "$(mk_write_input "$WORK/hooks/post-edit-format.sh" "echo hello")"
  [ "$status" -eq 0 ]
}

@test "allows new harness-config (no prior file = first creation)" {
  rm -f "$WORK/progress/harness-config.json"
  NEW='{ "scoring": { "pass_threshold": 7, "security_thresholds": { "critical": 7, "standard": 5, "low": 3 } } }'
  run run_write "$(mk_write_input "$WORK/progress/harness-config.json" "$NEW")"
  [ "$status" -eq 0 ]
}

@test "passes through missing file_path gracefully" {
  run run_write '{"tool_name":"Write","tool_input":{}}'
  [ "$status" -eq 0 ]
}

@test "passes through invalid hook input gracefully" {
  run run_write 'not json'
  [ "$status" -eq 0 ]
}
