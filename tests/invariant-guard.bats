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

mk_multiedit_input() {
  # $1=file_path, 그 뒤 old,new 쌍 반복
  local fp="$1"; shift
  local edits="[]"
  while [[ $# -ge 2 ]]; do
    edits=$(jq -c --arg o "$1" --arg n "$2" '. + [{old_string:$o, new_string:$n}]' <<<"$edits")
    shift 2
  done
  jq -n --arg fp "$fp" --argjson edits "$edits" \
    '{tool_name:"MultiEdit", tool_input:{file_path:$fp, edits:$edits}}'
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

@test "denies pass_threshold lowered via MultiEdit (no-op bypass closed)" {
  run run_write "$(mk_multiedit_input "$WORK/progress/harness-config.json" '"pass_threshold": 7' '"pass_threshold": 3')"
  [ "$status" -eq 2 ]
}

@test "denies threshold KEY removal (not just lowering)" {
  NEW='{ "scoring": { "pass_threshold": 7, "security_thresholds": { "standard": 5, "low": 3 } } }'
  run run_write "$(mk_write_input "$WORK/progress/harness-config.json" "$NEW")"
  [ "$status" -eq 2 ]
}

@test "denies whole security_thresholds removal" {
  NEW='{ "scoring": { "pass_threshold": 7 } }'
  run run_write "$(mk_write_input "$WORK/progress/harness-config.json" "$NEW")"
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

@test "denies cross-array swap (BLOCKED+1, INDIRECT-1, total unchanged)" {
  cat > "$WORK/hooks/pre-bash-firewall.sh" <<'SH'
BLOCKED=(
  'rm -rf /'
)
INDIRECT_PATTERNS=(
  'eval'
  'sudo rm'
)
SH
  # INDIRECT에서 하나 삭제하고 BLOCKED에 하나 추가 → 총수 동일하지만 INDIRECT 약화
  NEW=$'BLOCKED=(\n  \'rm -rf /\'\n  \'mkfs\'\n)\nINDIRECT_PATTERNS=(\n  \'eval\'\n)\n'
  run run_write "$(mk_write_input "$WORK/hooks/pre-bash-firewall.sh" "$NEW")"
  [ "$status" -eq 2 ]
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

@test "denies semantic gutting of guard (deny calls removed, line count kept)" {
  cp "$HOOK" "$WORK/hooks/invariant-guard.sh"
  # 라인 수는 유지하되 모든 deny 호출을 no-op(주석)로 — line-count 가드를 우회 시도
  GUTTED=$(sed 's/  deny /  : deny_DISABLED /g' "$HOOK")
  run run_write "$(mk_write_input "$WORK/hooks/invariant-guard.sh" "$GUTTED")"
  [ "$status" -eq 2 ]
}

@test "denies removing invariant-guard registration from hooks.json" {
  mkdir -p "$WORK/hooks"
  cp "$PLUGIN_ROOT/hooks/hooks.json" "$WORK/hooks/hooks.json"
  # invariant-guard 등록을 제거한 hooks.json
  NEW=$(jq 'del(.hooks.PreToolUse[] | select(.hooks[].command | test("invariant-guard")))' "$WORK/hooks/hooks.json")
  run run_write "$(mk_write_input "$WORK/hooks/hooks.json" "$NEW")"
  [ "$status" -eq 2 ]
}

@test "allows editing hooks.json while keeping invariant-guard registration" {
  mkdir -p "$WORK/hooks"
  cp "$PLUGIN_ROOT/hooks/hooks.json" "$WORK/hooks/hooks.json"
  # timeout만 바꾸고 invariant-guard 등록은 유지
  NEW=$(jq '(.hooks.PreToolUse[].hooks[] | select(.command | test("invariant-guard")) | .timeout) = 8' "$WORK/hooks/hooks.json")
  run run_write "$(mk_write_input "$WORK/hooks/hooks.json" "$NEW")"
  [ "$status" -eq 0 ]
}

@test "denies hooks.json del + decoy field (semantic, not substring)" {
  mkdir -p "$WORK/hooks"
  cp "$PLUGIN_ROOT/hooks/hooks.json" "$WORK/hooks/hooks.json"
  NEW=$(jq 'del(.hooks.PreToolUse[] | select(.hooks[].command | test("invariant-guard"))) | . + {"_legacy_invariant-guard_note":"moved"}' "$WORK/hooks/hooks.json")
  run run_write "$(mk_write_input "$WORK/hooks/hooks.json" "$NEW")"
  [ "$status" -eq 2 ]
}

@test "denies hooks.json renaming guard command to disabled variant" {
  mkdir -p "$WORK/hooks"
  cp "$PLUGIN_ROOT/hooks/hooks.json" "$WORK/hooks/hooks.json"
  NEW=$(jq '(.hooks.PreToolUse[].hooks[].command) |= sub("invariant-guard.sh"; "invariant-guard-disabled.sh")' "$WORK/hooks/hooks.json")
  run run_write "$(mk_write_input "$WORK/hooks/hooks.json" "$NEW")"
  [ "$status" -eq 2 ]
}

@test "denies guard exit-2 disabled via comment disguise (line-anchored)" {
  cp "$HOOK" "$WORK/hooks/invariant-guard.sh"
  GUTTED=$(sed 's/^  exit 2$/  : # exit 2/' "$HOOK")
  run run_write "$(mk_write_input "$WORK/hooks/invariant-guard.sh" "$GUTTED")"
  [ "$status" -eq 2 ]
}

@test "denies guard deny() function body neutralized" {
  cp "$HOOK" "$WORK/hooks/invariant-guard.sh"
  # deny() 함수 본문을 무력화 (echo + return 0), 토큰은 주석으로 위장
  GUTTED=$(awk '
    /^deny\(\) \{/ { print "deny() {"; print "  echo \"$1\" >&2  # exit 2"; print "  return 0"; print "}"; skip=1; next }
    skip && /^\}/ { skip=0; next }
    !skip { print }
  ' "$HOOK")
  run run_write "$(mk_write_input "$WORK/hooks/invariant-guard.sh" "$GUTTED")"
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

# --- F26: 우회 회귀 보강 (미커버 tool×target · 값타입 엣지) ---
# firewall fixture는 무해한 플레이스홀더 패턴(PAT_*) 사용 — 가드는 quote-시작 라인 수만 셈.

@test "denies firewall pattern reduction via MultiEdit" {
  cat > "$WORK/hooks/pre-bash-firewall.sh" <<'SH'
BLOCKED=(
  'PAT_A'
  'PAT_B'
  'PAT_C'
)
SH
  # MultiEdit: 'PAT_C' 라인의 따옴표 제거 → quote-시작 라인 수 감소 → deny
  run run_write "$(mk_multiedit_input "$WORK/hooks/pre-bash-firewall.sh" "  'PAT_C'" "  PAT_C")"
  [ "$status" -eq 2 ]
}

@test "denies @test reduction via MultiEdit" {
  T='@test'
  printf '%s "a" { true; }\n%s "b" { true; }\n' "$T" "$T" > "$WORK/tests/sample.bats"
  run run_write "$(mk_multiedit_input "$WORK/tests/sample.bats" '@test "b" { true; }' '# removed b')"
  [ "$status" -eq 2 ]
}

@test "denies pass_threshold lowered via string value" {
  run run_write "$(mk_edit_input "$WORK/progress/harness-config.json" '"pass_threshold": 7' '"pass_threshold": "5"')"
  [ "$status" -eq 2 ]
}

@test "denies pass_threshold lowered via float" {
  run run_write "$(mk_edit_input "$WORK/progress/harness-config.json" '"pass_threshold": 7' '"pass_threshold": 6.5')"
  [ "$status" -eq 2 ]
}

@test "denies firewall pattern commented out (total count drops)" {
  cat > "$WORK/hooks/pre-bash-firewall.sh" <<'SH'
BLOCKED=(
  'PAT_A'
  'PAT_B'
)
SH
  NEW=$'BLOCKED=(\n  \'PAT_A\'\n  # \'PAT_B\'\n)\n'
  run run_write "$(mk_write_input "$WORK/hooks/pre-bash-firewall.sh" "$NEW")"
  [ "$status" -eq 2 ]
}

@test "denies guard deny() call removed via Edit (line count kept)" {
  cp "$HOOK" "$WORK/hooks/invariant-guard.sh"
  LINE=$(grep -m1 -E '^[[:space:]]*deny ' "$WORK/hooks/invariant-guard.sh")
  run run_write "$(mk_edit_input "$WORK/hooks/invariant-guard.sh" "$LINE" "  : neutralized")"
  [ "$status" -eq 2 ]
}

@test "passes through non-edit tool (Read) on harness-config" {
  IN=$(jq -n --arg fp "$WORK/progress/harness-config.json" \
    '{tool_name:"Read", tool_input:{file_path:$fp}}')
  run run_write "$IN"
  [ "$status" -eq 0 ]
}

# --- INV-10 (F34): 도구 방화벽 pre-tool-firewall allow 확장 차단 ---

@test "INV-10: blocks write-verb into read-verb whitelist" {
  cp "$PLUGIN_ROOT/hooks/pre-tool-firewall.sh" "$WORK/hooks/pre-tool-firewall.sh"
  weak=$(sed 's/get|list|search|read|fetch/get|list|search|read|fetch|create/' "$WORK/hooks/pre-tool-firewall.sh")
  run run_write "$(mk_write_input "$WORK/hooks/pre-tool-firewall.sh" "$weak")"
  [ "$status" -eq 2 ]
}

@test "INV-10: blocks a mutating builtin into the read-only builtin list" {
  cp "$PLUGIN_ROOT/hooks/pre-tool-firewall.sh" "$WORK/hooks/pre-tool-firewall.sh"
  weak=$(sed 's/WebFetch|WebSearch|NotebookRead)/WebFetch|WebSearch|NotebookRead|file_upload)/' "$WORK/hooks/pre-tool-firewall.sh")
  run run_write "$(mk_write_input "$WORK/hooks/pre-tool-firewall.sh" "$weak")"
  [ "$status" -eq 2 ]
}

@test "INV-10: blocks adding an emit_allow site (default-allow flip)" {
  cp "$PLUGIN_ROOT/hooks/pre-tool-firewall.sh" "$WORK/hooks/pre-tool-firewall.sh"
  weak=$(printf '%s\nemit_allow "hacked"\n' "$(cat "$WORK/hooks/pre-tool-firewall.sh")")
  run run_write "$(mk_write_input "$WORK/hooks/pre-tool-firewall.sh" "$weak")"
  [ "$status" -eq 2 ]
}

@test "INV-10: allows a legit read-verb addition (browse)" {
  cp "$PLUGIN_ROOT/hooks/pre-tool-firewall.sh" "$WORK/hooks/pre-tool-firewall.sh"
  ok=$(sed 's/get|list|search|read|fetch/get|list|search|read|fetch|browse/' "$WORK/hooks/pre-tool-firewall.sh")
  run run_write "$(mk_write_input "$WORK/hooks/pre-tool-firewall.sh" "$ok")"
  [ "$status" -eq 0 ]
}

@test "INV-10: allows a harmless comment edit" {
  cp "$PLUGIN_ROOT/hooks/pre-tool-firewall.sh" "$WORK/hooks/pre-tool-firewall.sh"
  ok=$(printf '%s\n# harmless\n' "$(cat "$WORK/hooks/pre-tool-firewall.sh")")
  run run_write "$(mk_write_input "$WORK/hooks/pre-tool-firewall.sh" "$ok")"
  [ "$status" -eq 0 ]
}
