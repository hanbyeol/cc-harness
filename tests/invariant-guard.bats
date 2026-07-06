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

# --- INV-11: passes-transition guard (F35) ---
# passes:false→true 전환은 evaluator-feedback 근거(존재·verdict pass·min-of-5≥threshold·
# critical은 security≥critical threshold)를 기계 검증. 근거 없으면 deny.

flist() {
  # $1=passes(bool), $2=security_tier(기본 standard)
  jq -n --argjson p "$1" --arg tier "${2:-standard}" \
    '{project:"t", features:[{id:"FT1", name:"n", description:"d", security_tier:$tier, status:"implementing", passes:$p, iteration:0, dependencies:[], assigned_sprint:1}]}'
}

fb() {
  # $1=scores(json), $2=verdict, $3=feature id(기본 FT1)
  mkdir -p "$WORK/progress/agent-comms"
  jq -n --argjson s "$1" --arg v "$2" --arg id "${3:-FT1}" \
    '{timestamp:"2026-07-05T00:00:00Z", features_evaluated:[$id], scores:$s, verdict:$v}' \
    > "$WORK/progress/agent-comms/evaluator-feedback-2026-07-05T00-00-00.json"
}

@test "INV-11: denies passes false->true with no evaluator feedback" {
  flist false > "$WORK/progress/feature_list.json"
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$(flist true)")"
  [ "$status" -eq 2 ]
}

@test "INV-11: denies passes flip when min-of-5 below threshold" {
  flist false > "$WORK/progress/feature_list.json"
  fb '{"functionality":9,"code_quality":9,"security":9,"error_handling":9,"test_coverage":6}' pass
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$(flist true)")"
  [ "$status" -eq 2 ]
}

@test "INV-11: denies passes flip when verdict is fail" {
  flist false > "$WORK/progress/feature_list.json"
  fb '{"functionality":8,"code_quality":8,"security":8,"error_handling":8,"test_coverage":8}' fail
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$(flist true)")"
  [ "$status" -eq 2 ]
}

@test "INV-11: denies passes flip when a score dimension is missing" {
  flist false > "$WORK/progress/feature_list.json"
  fb '{"functionality":8,"code_quality":8,"security":8,"error_handling":8}' pass
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$(flist true)")"
  [ "$status" -eq 2 ]
}

@test "INV-11: denies critical feature flip when security below critical threshold" {
  cat > "$WORK/progress/harness-config.json" <<'JSON'
{ "scoring": { "pass_threshold": 5, "security_thresholds": { "critical": 7, "standard": 5, "low": 3 } } }
JSON
  flist false critical > "$WORK/progress/feature_list.json"
  fb '{"functionality":8,"code_quality":8,"security":6,"error_handling":8,"test_coverage":8}' pass
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$(flist true critical)")"
  [ "$status" -eq 2 ]
}

@test "INV-11: allows passes flip with complete passing feedback" {
  flist false > "$WORK/progress/feature_list.json"
  fb '{"functionality":8,"code_quality":8,"security":8,"error_handling":7,"test_coverage":7}' pass
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$(flist true)")"
  [ "$status" -eq 0 ]
}

@test "INV-11: allows critical flip when security meets critical threshold" {
  flist false critical > "$WORK/progress/feature_list.json"
  fb '{"functionality":8,"code_quality":8,"security":8,"error_handling":8,"test_coverage":8}' pass
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$(flist true critical)")"
  [ "$status" -eq 0 ]
}

@test "INV-11: allows unrelated edit (passes untouched)" {
  flist false > "$WORK/progress/feature_list.json"
  NEW=$(flist false | jq '.features[0].description = "changed"')
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$NEW")"
  [ "$status" -eq 0 ]
}

@test "INV-11: allows passes true->false reset (not a weakening)" {
  flist true > "$WORK/progress/feature_list.json"
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$(flist false)")"
  [ "$status" -eq 0 ]
}

@test "INV-11: denies new feature inserted directly with passes:true (no feedback)" {
  flist false > "$WORK/progress/feature_list.json"
  NEW=$(flist false | jq '.features += [{id:"FT2", name:"x", security_tier:"low", passes:true}]')
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$NEW")"
  [ "$status" -eq 2 ]
}

@test "INV-11: denies duplicate-id entry smuggling passes:true" {
  flist false > "$WORK/progress/feature_list.json"
  NEW=$(flist false | jq '.features += [{id:"FT1", name:"n", security_tier:"standard", passes:true}]')
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$NEW")"
  [ "$status" -eq 2 ]
}

@test "INV-11: denies flip on malformed feedback JSON (fail-closed)" {
  flist false > "$WORK/progress/feature_list.json"
  mkdir -p "$WORK/progress/agent-comms"
  echo '{broken' > "$WORK/progress/agent-comms/evaluator-feedback-2026-07-05T00-00-00.json"
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$(flist true)")"
  [ "$status" -eq 2 ]
}

@test "INV-11: feedback for a different feature id does not authorize flip" {
  flist false > "$WORK/progress/feature_list.json"
  fb '{"functionality":8,"code_quality":8,"security":8,"error_handling":8,"test_coverage":8}' pass OTHER
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$(flist true)")"
  [ "$status" -eq 2 ]
}

@test "INV-11: denies invalid JSON feature_list write" {
  flist false > "$WORK/progress/feature_list.json"
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" '{ not valid json ')"
  [ "$status" -eq 2 ]
}

@test "INV-11: skips templates/ feature_list (bootstrap scaffolding unaffected)" {
  mkdir -p "$WORK/templates/progress"
  flist false > "$WORK/templates/progress/feature_list.json"
  run run_write "$(mk_write_input "$WORK/templates/progress/feature_list.json" "$(flist true)")"
  [ "$status" -eq 0 ]
}

@test "INV-11: delete-then-recreate cannot smuggle passes:true (F-2, missing file not exempt)" {
  # feature_list.json이 디스크에 없는 상태에서 passes:true Write → 근거 없으면 차단
  rm -f "$WORK/progress/feature_list.json"
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$(flist true)")"
  [ "$status" -eq 2 ]
}

@test "INV-11: recreate WITH complete feedback is allowed (F-2 no false-positive)" {
  rm -f "$WORK/progress/feature_list.json"
  fb '{"functionality":8,"code_quality":8,"security":8,"error_handling":8,"test_coverage":8}' pass
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$(flist true)")"
  [ "$status" -eq 0 ]
}

@test "INV-11: string-typed score is fail-closed (F-4, min-of-5 masking)" {
  flist false > "$WORK/progress/feature_list.json"
  fb '{"functionality":8,"code_quality":8,"security":"3","error_handling":8,"test_coverage":8}' pass
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$(flist true)")"
  [ "$status" -eq 2 ]
}

@test "INV-11: feedback under agent-comms/archive/ does not authorize flip" {
  flist false > "$WORK/progress/feature_list.json"
  mkdir -p "$WORK/progress/agent-comms/archive"
  jq -n '{features_evaluated:["FT1"], scores:{functionality:8,code_quality:8,security:8,error_handling:8,test_coverage:8}, verdict:"pass"}' \
    > "$WORK/progress/agent-comms/archive/evaluator-feedback-2026-07-05T00-00-00.json"
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$(flist true)")"
  [ "$status" -eq 2 ]
}

@test "INV-11: denies agreed false->true with empty acceptance_criteria" {
  mkdir -p "$WORK/progress/contracts"
  jq -n '{sprint:99, acceptance_criteria:[], implementation_steps:[], agreed:false}' \
    > "$WORK/progress/contracts/sprint-99.json"
  NEW=$(jq -n '{sprint:99, acceptance_criteria:[], implementation_steps:[], agreed:true}')
  run run_write "$(mk_write_input "$WORK/progress/contracts/sprint-99.json" "$NEW")"
  [ "$status" -eq 2 ]
}

@test "INV-11: allows agreed false->true with criteria and steps present" {
  mkdir -p "$WORK/progress/contracts"
  jq -n '{sprint:99, acceptance_criteria:["a1"], implementation_steps:[{step:"s1", done:false}], agreed:false}' \
    > "$WORK/progress/contracts/sprint-99.json"
  NEW=$(jq -n '{sprint:99, acceptance_criteria:["a1"], implementation_steps:[{step:"s1", done:false}], agreed:true}')
  run run_write "$(mk_write_input "$WORK/progress/contracts/sprint-99.json" "$NEW")"
  [ "$status" -eq 0 ]
}

@test "INV-11: allows contract update that keeps agreed true (post-approval step check-off)" {
  mkdir -p "$WORK/progress/contracts"
  jq -n '{sprint:99, acceptance_criteria:["a1"], implementation_steps:[{step:"s1", done:false}], agreed:true}' \
    > "$WORK/progress/contracts/sprint-99.json"
  NEW=$(jq -n '{sprint:99, acceptance_criteria:["a1"], implementation_steps:[{step:"s1", done:true}], agreed:true}')
  run run_write "$(mk_write_input "$WORK/progress/contracts/sprint-99.json" "$NEW")"
  [ "$status" -eq 0 ]
}

# --- F41: jq 부재 시 fail-closed (보호 파일 편집 차단, 비보호 통과) ---

# jq만 가린 PATH로 훅을 실행. 입력 JSON은 정상 PATH(jq 존재)에서 미리 생성한다.
_nojq_run() {
  local shim="$WORK/nojqbin"
  mkdir -p "$shim"
  local t p
  for t in cat grep sed head basename tr wc awk dirname cut env printf; do
    p=$(command -v "$t" 2>/dev/null || true)
    [[ -n "$p" ]] && ln -sf "$p" "$shim/$t"
  done
  local bash_bin; bash_bin=$(command -v bash)
  printf '%s' "$1" | PATH="$shim" "$bash_bin" "$HOOK"
}

@test "F41: jq absent — Edit to harness-config.json is blocked (fail-closed)" {
  run _nojq_run "$(mk_edit_input "$WORK/progress/harness-config.json" 'x' 'y')"
  [ "$status" -eq 2 ]
}

@test "F41: jq absent — Edit to invariant-guard.sh is blocked" {
  cp "$HOOK" "$WORK/hooks/invariant-guard.sh"
  run _nojq_run "$(mk_edit_input "$WORK/hooks/invariant-guard.sh" 'a' 'b')"
  [ "$status" -eq 2 ]
}

@test "F41: jq absent — Write to a tests/*.bats file is blocked" {
  run _nojq_run "$(mk_write_input "$WORK/tests/sample.bats" 'anything')"
  [ "$status" -eq 2 ]
}

@test "F41: jq absent — Edit to feature_list.json is blocked" {
  run _nojq_run "$(mk_edit_input "$WORK/progress/feature_list.json" 'a' 'b')"
  [ "$status" -eq 2 ]
}

@test "F41: jq absent — Edit to pre-tool-firewall.sh is blocked" {
  run _nojq_run "$(mk_edit_input "$WORK/hooks/pre-tool-firewall.sh" 'a' 'b')"
  [ "$status" -eq 2 ]
}

@test "F41: jq absent — Edit to pre-bash-firewall.sh is blocked" {
  run _nojq_run "$(mk_edit_input "$WORK/hooks/pre-bash-firewall.sh" 'a' 'b')"
  [ "$status" -eq 2 ]
}

@test "F41: jq absent — Edit to hooks.json is blocked" {
  run _nojq_run "$(mk_edit_input "$WORK/hooks/hooks.json" 'a' 'b')"
  [ "$status" -eq 2 ]
}

@test "F41: jq absent — Edit to INVARIANTS.md is blocked" {
  run _nojq_run "$(mk_edit_input "$WORK/docs/INVARIANTS.md" 'a' 'b')"
  [ "$status" -eq 2 ]
}

@test "F41: jq absent — Edit to contracts/sprint-*.json is blocked (9th branch, no drift)" {
  run _nojq_run "$(mk_edit_input "$WORK/progress/contracts/sprint-99.json" 'a' 'b')"
  [ "$status" -eq 2 ]
}

@test "F41: jq absent — Edit to an unrelated file passes (availability preserved)" {
  run _nojq_run "$(mk_write_input "$WORK/hooks/post-edit-format.sh" 'echo hi')"
  [ "$status" -eq 0 ]
}

@test "F41: jq absent — content mentioning a protected path does not false-block unrelated file" {
  # tool_input.file_path(비보호)가 첫 매치 — content 안의 가짜 file_path는 무시된다
  poison='{"file_path": "progress/harness-config.json"}'
  run _nojq_run "$(mk_write_input "$WORK/hooks/post-edit-format.sh" "$poison")"
  [ "$status" -eq 0 ]
}

@test "F41: jq absent — missing file_path passes gracefully" {
  run _nojq_run '{"tool_name":"Write","tool_input":{}}'
  [ "$status" -eq 0 ]
}

@test "F41: jq present control — benign (non-lowering) harness-config edit still passes (jq-present path unchanged)" {
  NEW='{ "scoring": { "pass_threshold": 7, "security_thresholds": { "critical": 7, "standard": 5, "low": 3 } } }'
  run run_write "$(mk_write_input "$WORK/progress/harness-config.json" "$NEW")"
  [ "$status" -eq 0 ]
}

# --- F45: is_protected ↔ INV-12 완전 대칭 + evaluator.md fail-closed 갭 수정 ---

# evaluator.md는 min-of-5 채점 기준이자 INV-12 무인 제외 대상이다. jq 부재 시
# fail-closed가 이를 차단해야 한다(F41이 커버 못 하던 비대칭 — is_protected에 없었음).
@test "F45: jq absent — Edit to agents/evaluator.md is blocked (fail-closed gap fix)" {
  run _nojq_run "$(mk_edit_input "$WORK/agents/evaluator.md" 'a' 'b')"
  [ "$status" -eq 2 ]
}

# 대칭 (a): INV-12 섹션이 열거하는 모든 검증장치 파일은 is_protected()에서 return 0.
# 어느 하나라도 미보호면 실패 — INV-12엔 있으나 가드가 못 막는 비대칭을 잡는다.
@test "F45: symmetry (a) — every INV-12 device file is is_protected" {
  # shellcheck disable=SC1090
  source <(sed -n '/^is_protected()/,/^}/p' "$HOOK")
  local inv="$PLUGIN_ROOT/docs/INVARIANTS.md"
  # '검증 장치 파일:' bullet만 파싱한다 — approval-queue.json(무인 루프가 적립하는 데이터
  # 파일, 보호 대상 아님)·ADR 링크 등 섹션 내 다른 백틱 토큰을 배제한다.
  local files
  files=$(sed -n '/검증 장치 파일:/,/security_tier/p' "$inv" | grep -oE '`[^`]+\.(json|sh|md|bats)`' | tr -d '`' | sort -u)
  local missing="" f
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    [[ "$f" == *contracts/sprint-* ]] && continue   # 문서화된 예외(무인 대상, INV-11이 보호)
    [[ "$f" == *"*.bats" ]] && f="tests/x.bats"       # glob 토큰 → 실제 경로 대표값
    is_protected "$f" || missing="$missing $f"
  done <<< "$files"
  [[ -z "$missing" ]] || { echo "INV-12엔 있으나 is_protected 미보호:$missing"; false; }
}

# 대칭 (b): is_protected()의 모든 case arm은 INV-12 섹션에 등장해야 한다(contracts 예외 제외).
# 가드엔 있으나 INV-12에 문서화 안 된 파일이면 실패 — 반대 방향 drift를 잡는다.
@test "F45: symmetry (b) — every is_protected arm is documented in INV-12" {
  local inv="$PLUGIN_ROOT/docs/INVARIANTS.md"
  # (a)와 동일하게 '검증 장치 파일:' bullet만 파싱한다(F46) — arm이 위협모델 산문 등
  # 섹션 내 다른 문맥에 우연 등장해도 통과하던 느슨함을 제거해 대칭 검증을 엄격히 한다.
  local sec; sec=$(sed -n '/검증 장치 파일:/,/security_tier/p' "$inv")
  local arms
  arms=$(sed -n '/^is_protected()/,/^}/p' "$HOOK" | grep -oE '[a-zA-Z0-9_*-]+\.(json|sh|md|bats)' | sort -u)
  local missing="" a
  while IFS= read -r a; do
    [[ -z "$a" ]] && continue
    [[ "$a" == sprint-*.json ]] && continue           # 문서화된 예외
    grep -qF "$a" <<< "$sec" || missing="$missing $a"
  done <<< "$arms"
  [[ -z "$missing" ]] || { echo "is_protected엔 있으나 INV-12 미기재:$missing"; false; }
}

# --- F46: 대칭 파서 음성(meta) 테스트 — 파서가 실제로 drift를 감지하는지 자기검증 ---
# F45 대칭 테스트가 tautology로 퇴화(sed 범위가 깨져 빈 목록을 무언 통과)하면 놓칠
# drift를, 가짜 토큰을 주입한 fixture로 실증한다. 실제 소스는 건드리지 않는다(read-only).

@test "F46: symmetry (a) parser reports drift on an injected unprotected device file (meta)" {
  # shellcheck disable=SC1090
  source <(sed -n '/^is_protected()/,/^}/p' "$HOOK")
  # INV-12 device bullet에 보호되지 않는 가짜 파일을 주입한 fixture 복제본(실제 파일 불변)
  local invfix="$WORK/INVARIANTS-fixture.md"
  sed 's|검증 장치 파일:|검증 장치 파일: `foo-bogus-device.json`·|' \
    "$PLUGIN_ROOT/docs/INVARIANTS.md" > "$invfix"
  local files missing="" f
  files=$(sed -n '/검증 장치 파일:/,/security_tier/p' "$invfix" | grep -oE '`[^`]+\.(json|sh|md|bats)`' | tr -d '`' | sort -u)
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    [[ "$f" == *contracts/sprint-* ]] && continue
    [[ "$f" == *"*.bats" ]] && f="tests/x.bats"
    is_protected "$f" || missing="$missing $f"
  done <<< "$files"
  # 가짜 파일이 missing으로 잡혀야 파서가 drift를 실제로 감지하는 것 — 안 잡히면 파서 tautology
  [[ "$missing" == *"foo-bogus-device.json"* ]] || { echo "파서가 주입된 미보호 device를 놓침:[$missing]"; false; }
}

@test "F46: symmetry (b) parser reports drift on an injected undocumented arm (meta)" {
  local inv="$PLUGIN_ROOT/docs/INVARIANTS.md"
  local sec; sec=$(sed -n '/검증 장치 파일:/,/security_tier/p' "$inv")
  # is_protected에 가짜 미문서화 arm(bogus-undocumented.json)이 있다고 가정
  local arms="bogus-undocumented.json harness-config.json" missing="" a
  for a in $arms; do
    [[ "$a" == sprint-*.json ]] && continue
    grep -qF "$a" <<< "$sec" || missing="$missing $a"
  done
  # 가짜 arm이 미기재로 잡혀야 — 실제 arm(harness-config.json)은 안 잡혀야(대조)
  [[ "$missing" == *"bogus-undocumented.json"* ]] || { echo "파서가 주입된 미문서화 arm을 놓침:[$missing]"; false; }
  [[ "$missing" != *"harness-config.json"* ]] || { echo "파서가 문서화된 arm을 오탐:[$missing]"; false; }
}
