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
  # F68 10차: hooks.json 도 settings.json 과 같은 오브젝트 전문 비교로 옮기면서, 훅 오브젝트를
  # **바꾸는** 편집(예: timeout 값 변경)은 이제 사람 승인이 필요하다(settings.json 브랜치의
  # 원칙 "무해한 편집이 막히면 사람이 직접 승인" 을 그대로 물려받는다) — 그 자체가 이번 회전의
  # 목적이다(형제 필드 변조가 튜플 비교를 뚫었었다). 그래서 "등록을 유지하는 편집"의 예시를
  # matcher 확대(오브젝트는 그대로, matcher 만 넓힘 — matcher_covers 가 widening 으로 허용)로
  # 바꾼다.
  mkdir -p "$WORK/hooks"
  cp "$PLUGIN_ROOT/hooks/hooks.json" "$WORK/hooks/hooks.json"
  NEW=$(jq '(.hooks.PreToolUse[] | select(.hooks[].command | test("invariant-guard")) | .matcher) |= (. + "|NotebookEdit")' "$WORK/hooks/hooks.json")
  run run_write "$(mk_write_input "$WORK/hooks/hooks.json" "$NEW")"
  [ "$status" -eq 0 ] || { echo "matcher 확대(강화)가 차단됐다 — 과잉 차단"; false; }
}

@test "denies a hooks.json edit that changes a hook object's field even if the command survives" {
  # 위 테스트가 허용 방향을 고정한다면 이 테스트는 차단 방향을 고정한다 — 10차 판정이 실제로
  # 반증한 자리(형제 필드 변조)를 이 실제 배선 파일로 재현한다.
  mkdir -p "$WORK/hooks"
  cp "$PLUGIN_ROOT/hooks/hooks.json" "$WORK/hooks/hooks.json"
  NEW=$(jq '(.hooks.PreToolUse[].hooks[] | select(.command | test("invariant-guard")) | .timeout) = 999' "$WORK/hooks/hooks.json")
  run run_write "$(mk_write_input "$WORK/hooks/hooks.json" "$NEW")"
  [ "$status" -eq 2 ] || { echo "훅 오브젝트 필드 변조가 통과했다"; false; }
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
  run run_write "$(mk_write_input "$WORK/src/unrelated.sh" "echo hello")"
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

# F54: SubagentStop 훅이 캡처하는 evaluator 실행 기록 한 줄을 evaluator-runs.jsonl에 append.
# $1 = now로부터 뺄 초(기본 0=지금). INV-11의 시간창(≤48h) 검사가 이 epoch를 벽시계 NOW와 비교한다.
evrun() {
  mkdir -p "$WORK/progress/agent-comms"
  local now; now=$(date +%s)
  jq -cn --argjson e "$((now - ${1:-0}))" \
    '{agent_id:"ev-test", timestamp:"x", epoch:$e, transcript_path:"", session_id:"s"}' \
    >> "$WORK/progress/agent-comms/evaluator-runs.jsonl"
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
  evrun   # F54: 최근 evaluator 실행 기록이 있어야 통과
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$(flist true)")"
  [ "$status" -eq 0 ]
}

@test "INV-11: allows critical flip when security meets critical threshold" {
  flist false critical > "$WORK/progress/feature_list.json"
  fb '{"functionality":8,"code_quality":8,"security":8,"error_handling":8,"test_coverage":8}' pass
  evrun   # F54: 최근 evaluator 실행 기록이 있어야 통과
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$(flist true critical)")"
  [ "$status" -eq 0 ]
}

@test "INV-11: allows unrelated edit (passes untouched)" {
  flist false > "$WORK/progress/feature_list.json"
  NEW=$(flist false | jq '.features[0].description = "changed"')
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$NEW")"
  [ "$status" -eq 0 ]
}

# --- F54: evaluator 실행 기계 검증 — 실행존재 + 시간창 (INV-11 강화) ---
# feedback이 완비돼도(verdict/min/security 통과) 최근 evaluator 실행 기록이 없으면 passes 전환 차단.

@test "F54: denies passes flip when feedback complete but no evaluator run record" {
  flist false > "$WORK/progress/feature_list.json"
  fb '{"functionality":8,"code_quality":8,"security":8,"error_handling":8,"test_coverage":8}' pass
  # evrun 호출 없음 — evaluator-runs.jsonl 부재
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$(flist true)")"
  [ "$status" -eq 2 ]
  [[ "$output" == *"evaluator 실행 기록 부재"* ]]
}

@test "F54: denies passes flip when only a stale run record (>48h) exists" {
  flist false > "$WORK/progress/feature_list.json"
  fb '{"functionality":8,"code_quality":8,"security":8,"error_handling":8,"test_coverage":8}' pass
  evrun $((49 * 3600))   # 49시간 전 실행 → 시간창(48h) 밖
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$(flist true)")"
  [ "$status" -eq 2 ]
}

@test "F54: allows passes flip with a run record inside the window (47h)" {
  flist false > "$WORK/progress/feature_list.json"
  fb '{"functionality":8,"code_quality":8,"security":8,"error_handling":8,"test_coverage":8}' pass
  evrun $((47 * 3600))   # 47시간 전 실행 → 시간창(48h) 안
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$(flist true)")"
  [ "$status" -eq 0 ]
}

@test "F54: run record without epoch field does not authorize (fail-closed)" {
  flist false > "$WORK/progress/feature_list.json"
  fb '{"functionality":8,"code_quality":8,"security":8,"error_handling":8,"test_coverage":8}' pass
  mkdir -p "$WORK/progress/agent-comms"
  # epoch 없는 레거시 레코드 → 시간창 검사에서 제외 → deny
  echo '{"agent_id":"x","timestamp":"2026-07-24T00:00:00Z"}' \
    > "$WORK/progress/agent-comms/evaluator-runs.jsonl"
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" "$(flist true)")"
  [ "$status" -eq 2 ]
}

# --- F54: evaluator-runs.jsonl append-only 보호 ---

@test "F54: allows appending a new line to evaluator-runs.jsonl" {
  local runs="$WORK/progress/agent-comms/evaluator-runs.jsonl"
  mkdir -p "$WORK/progress/agent-comms"
  printf '%s\n' '{"agent_id":"a","epoch":100}' '{"agent_id":"b","epoch":200}' > "$runs"
  NEW=$(printf '%s\n' '{"agent_id":"a","epoch":100}' '{"agent_id":"b","epoch":200}' '{"agent_id":"c","epoch":300}')
  run run_write "$(mk_write_input "$runs" "$NEW")"
  [ "$status" -eq 0 ]
}

@test "F54: denies deleting a line from evaluator-runs.jsonl" {
  local runs="$WORK/progress/agent-comms/evaluator-runs.jsonl"
  mkdir -p "$WORK/progress/agent-comms"
  printf '%s\n' '{"agent_id":"a","epoch":100}' '{"agent_id":"b","epoch":200}' '{"agent_id":"c","epoch":300}' > "$runs"
  NEW=$(printf '%s\n' '{"agent_id":"a","epoch":100}' '{"agent_id":"c","epoch":300}')
  run run_write "$(mk_write_input "$runs" "$NEW")"
  [ "$status" -eq 2 ]
}

@test "F54: denies modifying an existing line in evaluator-runs.jsonl" {
  local runs="$WORK/progress/agent-comms/evaluator-runs.jsonl"
  mkdir -p "$WORK/progress/agent-comms"
  printf '%s\n' '{"agent_id":"a","epoch":100}' '{"agent_id":"b","epoch":200}' > "$runs"
  NEW=$(printf '%s\n' '{"agent_id":"a","epoch":100}' '{"agent_id":"b","epoch":999}')
  run run_write "$(mk_write_input "$runs" "$NEW")"
  [ "$status" -eq 2 ]
}

@test "F54: denies reordering lines in evaluator-runs.jsonl" {
  local runs="$WORK/progress/agent-comms/evaluator-runs.jsonl"
  mkdir -p "$WORK/progress/agent-comms"
  printf '%s\n' '{"agent_id":"a","epoch":100}' '{"agent_id":"b","epoch":200}' > "$runs"
  NEW=$(printf '%s\n' '{"agent_id":"b","epoch":200}' '{"agent_id":"a","epoch":100}')
  run run_write "$(mk_write_input "$runs" "$NEW")"
  [ "$status" -eq 2 ]
}

@test "F54: evaluator-runs.jsonl is is_protected (fail-closed coverage)" {
  # shellcheck disable=SC1090
  source <(sed -n '/^is_protected()/,/^}/p' "$HOOK")
  is_protected "/x/progress/agent-comms/evaluator-runs.jsonl"
}

# --- F54 follow-up (judge2 A6): empty-Write truncation bypass — closed as a CLASS ---
# 빈 내용 Write로 보호 파일을 통째로 비우면 개별 약화 검사를 우회하던 클래스 갭. evaluator-runs
# 뿐 아니라 모든 보호/배선 파일의 truncation을 차단한다(인스턴스가 아니라 클래스를 닫음).

@test "F54-A6: empty Write truncating a non-empty evaluator-runs.jsonl is denied" {
  local runs="$WORK/progress/agent-comms/evaluator-runs.jsonl"
  mkdir -p "$WORK/progress/agent-comms"
  printf '%s\n' '{"agent_id":"a","epoch":100}' '{"agent_id":"b","epoch":200}' > "$runs"
  run run_write "$(mk_write_input "$runs" "")"
  [ "$status" -eq 2 ]
}

@test "F54-A6 class: empty Write truncating a non-empty tests/*.bats is denied" {
  # @test 수 검사를 빈 Write로 우회하던 경로 — 클래스 픽스가 막는다
  printf '@test "x" { true; }\n' > "$WORK/tests/foo.bats"
  run run_write "$(mk_write_input "$WORK/tests/foo.bats" "")"
  [ "$status" -eq 2 ]
}

@test "F54-A6 class: empty Write truncating a non-empty harness-config.json is denied" {
  run run_write "$(mk_write_input "$WORK/progress/harness-config.json" "")"
  [ "$status" -eq 2 ]
}

@test "F54-A6: empty Write to a non-existent evaluator-runs.jsonl is allowed (nothing to destroy)" {
  run run_write "$(mk_write_input "$WORK/progress/agent-comms/evaluator-runs.jsonl" "")"
  [ "$status" -eq 0 ]
}

@test "F54-A6: empty Write to a non-protected file is allowed" {
  printf 'hello\n' > "$WORK/regular.txt"
  run run_write "$(mk_write_input "$WORK/regular.txt" "")"
  [ "$status" -eq 0 ]
}

# N1 (judge2): 새 파일로 위조 evaluator-runs를 생성하는 것은 허용된다 — 사용자 승인 설계 A+C의
# 알려진 speed-bump 한계(append/create 위조는 원천 봉쇄 못 함). 의도된 동작임을 특성화 테스트로
# 잠가, 미래 독자가 '갭'이 아니라 '문서화된 한계'임을 알게 한다(INVARIANTS.md 위협모델과 정합).
@test "F54-N1 (documented limitation): new-file Write of a forged evaluator-runs.jsonl is allowed" {
  local runs="$WORK/progress/agent-comms/evaluator-runs.jsonl"
  mkdir -p "$WORK/progress/agent-comms"
  # 파일 부재 상태에서 위조 레코드로 새로 생성 — 신규 생성 면제로 통과(append-only는 기존
  # 라인 보호가 목적이지 최초 생성을 막지 않는다). self-referential 한계, speed-bump.
  local forged; forged=$(jq -cn --argjson e "$(date +%s)" '{agent_id:"forged",epoch:$e}')
  run run_write "$(mk_write_input "$runs" "$forged")"
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
  evrun   # F54: 최근 evaluator 실행 기록이 있어야 통과
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
  run _nojq_run "$(mk_write_input "$WORK/src/unrelated.sh" 'echo hi')"
  [ "$status" -eq 0 ]
}

@test "F41: jq absent — content mentioning a protected path does not false-block unrelated file" {
  # tool_input.file_path(비보호)가 첫 매치 — content 안의 가짜 file_path는 무시된다
  poison='{"file_path": "progress/harness-config.json"}'
  run _nojq_run "$(mk_write_input "$WORK/src/unrelated.sh" "$poison")"
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

# --- F48: 티어 라우팅 스킬 3개 자기보호 (evaluator.md/F45와 동일한 fail-closed 패턴) ---
# change-request/improve/hotfix의 조건 문구가 evaluator 생략 여부를 결정하게 되면서 생긴
# 자기약화 사각지대 — 전체경로 패턴으로만 보호해 다른 스킬의 SKILL.md까지 과잉보호되지
# 않아야 한다(basename만 매칭하면 회귀).

@test "F48: is_protected protects the 3 tier-routing skill files (full-path match)" {
  # shellcheck disable=SC1090
  source <(sed -n '/^is_protected()/,/^}/p' "$HOOK")
  run is_protected "$WORK/skills/change-request/SKILL.md"
  [ "$status" -eq 0 ]
  run is_protected "$WORK/skills/improve/SKILL.md"
  [ "$status" -eq 0 ]
  run is_protected "$WORK/skills/hotfix/SKILL.md"
  [ "$status" -eq 0 ]
}

@test "F48: is_protected does not over-protect unrelated skill files (basename-only regression guard)" {
  # shellcheck disable=SC1090
  source <(sed -n '/^is_protected()/,/^}/p' "$HOOK")
  run is_protected "$WORK/skills/brainstorm/SKILL.md"
  [ "$status" -ne 0 ]
  run is_protected "$WORK/skills/debug/SKILL.md"
  [ "$status" -ne 0 ]
}

@test "F48: jq absent — Edit to skills/change-request/SKILL.md is blocked (fail-closed)" {
  run _nojq_run "$(mk_edit_input "$WORK/skills/change-request/SKILL.md" 'a' 'b')"
  [ "$status" -eq 2 ]
}

@test "F48: jq absent — Edit to skills/improve/SKILL.md is blocked (fail-closed)" {
  run _nojq_run "$(mk_edit_input "$WORK/skills/improve/SKILL.md" 'a' 'b')"
  [ "$status" -eq 2 ]
}

@test "F48: jq absent — Edit to skills/hotfix/SKILL.md is blocked (fail-closed)" {
  run _nojq_run "$(mk_edit_input "$WORK/skills/hotfix/SKILL.md" 'a' 'b')"
  [ "$status" -eq 2 ]
}

@test "F48: jq absent — Edit to an unrelated skill file still passes (availability preserved)" {
  run _nojq_run "$(mk_edit_input "$WORK/skills/brainstorm/SKILL.md" 'a' 'b')"
  [ "$status" -eq 0 ]
}

# --- F60: 3스킬 보호를 디렉터리 단위로 확장 (게이트 정의 이동에 의한 우회 차단) ---
# F48은 세 스킬을 full-path로만 매칭했다. 스킬을 분할해 배치 승인 조건이나 무인 제외
# 규칙을 하위 파일로 옮기면 게이트 정의가 보호 밖으로 나간다 — 임계값을 낮추는 대신
# 정의의 위치를 옮기는 우회이며 결과는 같다(F58 AC-1 발견).
# 위 F48 테스트는 그대로 둔다: 글롭이 기존 full-path arm을 대체한 것이 아니라 추가된
# 것임을 이 둘의 공존이 증명한다.

@test "F60: is_protected covers sub-files of the 3 tier-routing skill dirs" {
  # shellcheck disable=SC1090
  source <(sed -n '/^is_protected()/,/^}/p' "$HOOK")
  run is_protected "$WORK/skills/change-request/impact-analysis.md"
  [ "$status" -eq 0 ]
  run is_protected "$WORK/skills/improve/auto-mode.md"
  [ "$status" -eq 0 ]
  run is_protected "$WORK/skills/hotfix/scope-check.md"
  [ "$status" -eq 0 ]
}

@test "F60: is_protected covers nested paths and relative forms" {
  # shellcheck disable=SC1090
  source <(sed -n '/^is_protected()/,/^}/p' "$HOOK")
  run is_protected "$WORK/skills/improve/sub/dir/deep.md"
  [ "$status" -eq 0 ]
  run is_protected "skills/change-request/relative.md"
  [ "$status" -eq 0 ]
  run is_protected "skills/hotfix/nested/x.json"
  [ "$status" -eq 0 ]
}

@test "F60: directory widening does not over-protect unrelated skill dirs" {
  # shellcheck disable=SC1090
  source <(sed -n '/^is_protected()/,/^}/p' "$HOOK")
  run is_protected "$WORK/skills/implement/SKILL.md"
  [ "$status" -ne 0 ]
  run is_protected "$WORK/skills/implement/parallel-mode.md"
  [ "$status" -ne 0 ]
  run is_protected "$WORK/skills/debug/SKILL.md"
  [ "$status" -ne 0 ]
  run is_protected "$WORK/skills/brainstorm/sub/x.md"
  [ "$status" -ne 0 ]
}

@test "F60: jq absent — Edit to a skill sub-file is blocked (fail-closed symmetry)" {
  run _nojq_run "$(mk_edit_input "$WORK/skills/improve/auto-mode.md" 'a' 'b')"
  [ "$status" -eq 2 ]
}

@test "F60: jq absent — sub-file of an unrelated skill still passes (availability preserved)" {
  run _nojq_run "$(mk_edit_input "$WORK/skills/implement/parallel-mode.md" 'a' 'b')"
  [ "$status" -eq 0 ]
}

# --- F49: apply_replace() escape-corruption fix (false-allow prevention) ---
# 근본원인: POSIX awk의 `-v var=value` 할당은 문자열 리터럴과 동일하게 백슬래시 이스케이프를
# 처리한다 — old_string/new_string에 백슬래시(이 코드베이스의 멀티라인 case문
# line-continuation처럼 흔한 패턴)가 있으면 손상된다. 로케일/멀티바이트와 무관 — 순수 ASCII로
# 재현된다(이전 known_issue의 'macOS awk+UTF-8' 진단은 부정확했음). 수정: 환경변수(ENVIRON[])
# 경유로 리터럴 바이트를 보존.

_source_apply_replace() {
  # shellcheck disable=SC1090
  source <(sed -n '/^apply_replace()/,/^}/p' "$HOOK")
}

@test "F49: apply_replace substitutes correctly when old_string contains backslash-newline continuation" {
  _source_apply_replace
  local content old new result
  content=$(printf '  case "$f" in\n    */tests/*.bats) return 0 ;;\n    */skills/change-request/SKILL.md | \\\n    */skills/improve/SKILL.md | \\\n    */skills/hotfix/SKILL.md) return 0 ;;\n  esac\n')
  old=$(printf '    */skills/change-request/SKILL.md | \\\n    */skills/improve/SKILL.md | \\\n    */skills/hotfix/SKILL.md) return 0 ;;\n')
  new="MARKER_REPLACED_CORRECTLY"
  result=$(apply_replace "$content" "$old" "$new")
  [[ "$result" == *"MARKER_REPLACED_CORRECTLY"* ]] || { echo "치환 실패(버그 재현):[$result]"; false; }
}

@test "F49: apply_replace reflects deny()/exit-2 removal instead of silently returning unchanged content (false-allow prevention)" {
  _source_apply_replace
  local content old new result
  content=$(printf 'deny() {\n  echo "msg" >&2\n  exit 2\n}\n')
  old=$(printf 'deny() {\n  echo "msg" >&2\n  exit 2\n}\n')
  new=$(printf 'deny() {\n  echo "msg" >&2\n}\n')
  result=$(apply_replace "$content" "$old" "$new")
  # 버그 상태에서는 old_string 매치가 깨져 NEW_CONTENT=OLD와 동일해지고, exit 2가 그대로
  # 남아 훅의 약화검사가 "변경 없음"으로 오판(false-allow)한다 — 수정 후엔 실제로 제거돼야 한다.
  [[ "$result" != *"exit 2"* ]] || { echo "exit 2가 제거되지 않음(false-allow 버그 재현):[$result]"; false; }
}

@test "F49: apply_replace handles backslash-quote in old_string without truncation (escape type generalization)" {
  _source_apply_replace
  local content old new result
  content=$(printf 'echo "A\\"B" # literal backslash-quote\nnext line\n')
  old=$(printf 'echo "A\\"B" # literal backslash-quote\n')
  new="MARKER2"
  result=$(apply_replace "$content" "$old" "$new")
  [[ "$result" == *"MARKER2"* ]] || { echo "백슬래시-따옴표 치환 실패:[$result]"; false; }
}

@test "F49: MultiEdit-style sequential apply_replace calls (one containing backslash-newline) produce correct final content" {
  _source_apply_replace
  local content step1 step2 old1 new1
  content=$(printf 'first | \\\nsecond) return 0 ;;\nanother line here\n')
  old1=$(printf 'first | \\\nsecond) return 0 ;;\n')
  new1="REPLACED_STEP1"
  step1=$(apply_replace "$content" "$old1" "$new1")
  step2=$(apply_replace "$step1" "another line here" "REPLACED_STEP2")
  [[ "$step2" == *"REPLACED_STEP1"* && "$step2" == *"REPLACED_STEP2"* ]] \
    || { echo "순차 치환 실패:[$step2]"; false; }
}

# --- F50: apply_replace 실패(awk 부재/오류) 시 fail-closed — has_jq() 대칭 ---
# _nojq_run과 대칭되는 _noawk_run: awk만 가린 PATH로 훅을 실행(jq는 포함) — awk 부재 시
# apply_replace()가 실패해도 예전엔 폴백이 삼켜 "변경 없음"으로 통과(fail-open)했다.

_noawk_run() {
  local shim="$WORK/noawkbin"
  mkdir -p "$shim"
  local t p
  for t in cat grep sed head basename tr wc dirname cut env printf jq ls sort; do
    p=$(command -v "$t" 2>/dev/null || true)
    [[ -n "$p" ]] && ln -sf "$p" "$shim/$t"
  done
  local bash_bin; bash_bin=$(command -v bash)
  printf '%s' "$1" | PATH="$shim" "$bash_bin" "$HOOK"
}

@test "F50: awk absent — Edit to a protected file (non-empty old_string) is denied (fail-closed)" {
  run _noawk_run "$(mk_edit_input "$WORK/progress/harness-config.json" 'pass_threshold' 'pass_threshold')"
  [ "$status" -eq 2 ]
}

@test "F50: awk absent — MultiEdit to a protected file is denied (fail-closed)" {
  run _noawk_run "$(mk_multiedit_input "$WORK/progress/harness-config.json" 'pass_threshold' 'pass_threshold')"
  [ "$status" -eq 2 ]
}

@test "F50: awk absent — Edit to an unrelated (unprotected) file still passes (availability preserved)" {
  run _noawk_run "$(mk_edit_input "$WORK/src/unrelated.sh" 'a' 'b')"
  [ "$status" -eq 0 ]
}

@test "F50: awk present control — benign Edit to a protected file still passes (normal path unchanged)" {
  NEW='{ "scoring": { "pass_threshold": 8, "security_thresholds": { "critical": 7, "standard": 5, "low": 3 } } }'
  run run_write "$(mk_write_input "$WORK/progress/harness-config.json" "$NEW")"
  [ "$status" -eq 0 ]
}

# --- F51: has_awk() 전역 fail-closed 게이트 — has_jq() 완전 대칭(Write 경로 포함) ---
# F50은 apply_replace() 호출부(Edit/MultiEdit)만 awk 실패 시 fail-closed였다 — Write 경로는
# harness-config.json 임계값 비교(INV-3)·feature_list.json min-of-5 비교(INV-11) 등 awk 의존
# 검사가 awk 부재 시 여전히 fail-open이었다(security-auditor 재현: C1/D).

@test "F51: awk absent — Write lowering harness-config.json pass_threshold is denied (fail-closed, security-auditor C1)" {
  NEW='{ "scoring": { "pass_threshold": 4, "security_thresholds": { "critical": 7, "standard": 5, "low": 3 } } }'
  run _noawk_run "$(mk_write_input "$WORK/progress/harness-config.json" "$NEW")"
  [ "$status" -eq 2 ]
}

@test "F51: awk absent — Write flipping feature_list.json passes:true for a below-threshold feature is denied (fail-closed, security-auditor D)" {
  flist false > "$WORK/progress/feature_list.json"
  fb '{"functionality":9,"code_quality":9,"security":9,"error_handling":9,"test_coverage":3}' pass
  run _noawk_run "$(mk_write_input "$WORK/progress/feature_list.json" "$(flist true)")"
  [ "$status" -eq 2 ]
}

@test "F51: awk absent — Write to an unrelated (unprotected) file still passes (availability preserved)" {
  run _noawk_run "$(mk_write_input "$WORK/src/unrelated.sh" "echo hi")"
  [ "$status" -eq 0 ]
}

@test "F51: awk present control — benign Write to protected files still passes (normal path unchanged)" {
  NEW='{ "scoring": { "pass_threshold": 8, "security_thresholds": { "critical": 7, "standard": 5, "low": 3 } } }'
  run run_write "$(mk_write_input "$WORK/progress/harness-config.json" "$NEW")"
  [ "$status" -eq 0 ]
}

# === F68 9차 판정 — 전역 nocasematch 철회를 잠근다 ===
# 대소문자 무시 FS 의 철자 우회를 닫으려고 `shopt -s nocasematch` 를 전역으로 켰더니,
# 경로 분류만이 아니라 **내용·구조 동등비교까지** 무뎌져 게이트 둘이 새로 열렸다(9차 실증).
# 되돌렸고, 아래 셋이 재발을 막는다. 이 회전은 08ed589 가 테스트를 하나도 바꾸지 않아
# 네 변이가 전부 생존했다는 지적(test 2점)의 직접 대응이기도 하다.

@test "INV-7: hooks.json wiring is compared as a set, not by command substring" {
  # 이전 판본은 `invariant-guard.sh` 가 command 로 어딘가 남아 있는지만 봤다. 그래서
  # **이벤트 키를 대문자로 바꾸는 쓰기 하나로 훅 전체가 등록에서 사라지는데 통과**했다
  # (F68 9차 판정 실증). command 는 그대로라 이름 기반 검사에는 보이지 않는다. 더 나쁜 것은
  # 가드가 통과시키면 티켓이 발급되어 protected-integrity 도 되돌리지 않는다는 점이다.
  cat > "$WORK/hooks/hooks.json" <<'JSON'
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"bash ${CLAUDE_PLUGIN_ROOT}/hooks/pre-bash-firewall.sh"}]},
{"matcher":"Edit|Write","hooks":[{"type":"command","command":"bash ${CLAUDE_PLUGIN_ROOT}/hooks/invariant-guard.sh"}]}],
"Stop":[{"matcher":"","hooks":[{"type":"command","command":"bash ${CLAUDE_PLUGIN_ROOT}/hooks/pre-commit-gate.sh"}]}]}}
JSON
  # (a) 이벤트 키 대문자화 — 등록이 통째로 사라진다
  local UP='{"hooks":{"PRETOOLUSE":[{"matcher":"Bash","hooks":[{"type":"command","command":"bash ${CLAUDE_PLUGIN_ROOT}/hooks/pre-bash-firewall.sh"}]},{"matcher":"Edit|Write","hooks":[{"type":"command","command":"bash ${CLAUDE_PLUGIN_ROOT}/hooks/invariant-guard.sh"}]}],"STOP":[{"matcher":"","hooks":[{"type":"command","command":"bash ${CLAUDE_PLUGIN_ROOT}/hooks/pre-commit-gate.sh"}]}]}}'
  run run_write "$(mk_write_input "$WORK/hooks/hooks.json" "$UP")"
  [ "$status" -eq 2 ] || { echo "이벤트 키 대문자화로 배선이 사라졌는데 통과했다"; false; }
  # (b) matcher 만 소문자로 — 도달성이 줄어든다
  local LM='{"hooks":{"PreToolUse":[{"matcher":"bash","hooks":[{"type":"command","command":"bash ${CLAUDE_PLUGIN_ROOT}/hooks/pre-bash-firewall.sh"}]},{"matcher":"Edit|Write","hooks":[{"type":"command","command":"bash ${CLAUDE_PLUGIN_ROOT}/hooks/invariant-guard.sh"}]}],"Stop":[{"matcher":"","hooks":[{"type":"command","command":"bash ${CLAUDE_PLUGIN_ROOT}/hooks/pre-commit-gate.sh"}]}]}}'
  run run_write "$(mk_write_input "$WORK/hooks/hooks.json" "$LM")"
  [ "$status" -eq 2 ] || { echo "matcher 축소가 통과했다"; false; }
  # (c) 이벤트 하나 제거
  local RM='{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"bash ${CLAUDE_PLUGIN_ROOT}/hooks/pre-bash-firewall.sh"}]},{"matcher":"Edit|Write","hooks":[{"type":"command","command":"bash ${CLAUDE_PLUGIN_ROOT}/hooks/invariant-guard.sh"}]}]}}'
  run run_write "$(mk_write_input "$WORK/hooks/hooks.json" "$RM")"
  [ "$status" -eq 2 ] || { echo "이벤트 제거가 통과했다"; false; }
  # (d) 대조 — 추가는 강화이므로 통과해야 한다(add-only)
  local ADD='{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"bash ${CLAUDE_PLUGIN_ROOT}/hooks/pre-bash-firewall.sh"}]},{"matcher":"Edit|Write","hooks":[{"type":"command","command":"bash ${CLAUDE_PLUGIN_ROOT}/hooks/invariant-guard.sh"}]}],"Stop":[{"matcher":"","hooks":[{"type":"command","command":"bash ${CLAUDE_PLUGIN_ROOT}/hooks/pre-commit-gate.sh"}]}],"Notification":[{"matcher":"*","hooks":[{"type":"command","command":"bash new.sh"}]}]}}'
  run run_write "$(mk_write_input "$WORK/hooks/hooks.json" "$ADD")"
  [ "$status" -eq 0 ] || { echo "배선 추가(강화)가 차단됐다 — 과잉 차단"; false; }
}

@test "F68: case-insensitive matching is scoped to path classification, not content" {
  # 9차 판정이 전역 `nocasematch` 로 게이트 둘이 열린 것을 실증했다. 10차는 분류 술어 안에서만
  # 켠다 — 그 경계가 실제로 지켜지는지를 **양쪽에서** 확인한다. 대소문자 구분 FS(Linux CI)에서는
  # 분류 쪽 단언이 무의미해지므로 건너뛰되, **내용 쪽 단언은 항상 돌린다**(그쪽이 회귀 축이다).
  #
  # (1) 내용·구조 비교는 대소문자를 구분해야 한다 — FS 와 무관하게 성립한다.
  mkdir -p "$WORK/.claude" "$WORK/progress/agent-comms"
  cat > "$WORK/.claude/settings.json" <<'JSON'
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"bash x.sh"}]}]}}
JSON
  local LOWER='{"hooks":{"PreToolUse":[{"matcher":"bash","hooks":[{"type":"command","command":"bash x.sh"}]}]}}'
  run run_write "$(mk_write_input "$WORK/.claude/settings.json" "$LOWER")"
  [ "$status" -eq 2 ] || { echo "분류용 설정이 배선 동등비교까지 무디게 했다 (9차 회귀 재발)"; false; }

  local LOG="$WORK/progress/agent-comms/evaluator-runs.jsonl"
  printf '%s\n' '{"ts":"2026-08-01T00:00:00Z","agent_id":"a1","epoch":1}' > "$LOG"
  local UP; UP=$(tr '[:lower:]' '[:upper:]' < "$LOG")
  run run_write "$(mk_write_input "$LOG" "$UP")"
  [ "$status" -eq 2 ] || { echo "분류용 설정이 append-only 비교까지 무디게 했다 (9차 회귀 재발)"; false; }

  # (2) 분류는 대소문자를 무시해야 한다 — 대소문자 무시 FS 에서만 의미가 있다.
  local probe="$WORK/CiProbe"; mkdir -p "$probe"
  if [[ ! -e "$WORK/ciprobe" ]]; then skip "case-sensitive filesystem — 분류 축은 이 FS 에서 발화하지 않는다"; fi
  # 삭제 후 다른 철자로 재생성해도 passes 전환 근거는 요구돼야 한다
  mkdir -p "$WORK/progress"
  cat > "$WORK/progress/feature_list.json" <<'JSON'
{"features":[{"id":"F1","passes":false}]}
JSON
  local NEWFL='{"features":[{"id":"F1","passes":true}]}'
  rm -f "$WORK/progress/feature_list.json"
  run run_write "$(mk_write_input "$WORK/PROGRESS/FEATURE_LIST.JSON" "$NEWFL")"
  [ "$status" -eq 2 ] || { echo "철자를 바꿔 삭제 후 재생성하면 passes 게이트가 열린다"; false; }
}

@test "F68: the guard sets no global nocasematch" {
  # 도구의 사정거리가 문제의 사정거리보다 넓으면 그 초과분이 그대로 회귀가 된다.
  # 경로 분류 술어 몇 개에만 필요한 것을 셸 전역 옵션으로 켜지 않는다.
  run grep -c '^[[:space:]]*shopt -s nocasematch' "$HOOK"
  [ "$output" -eq 0 ] || { echo "전역 nocasematch 가 되살아났다 — 9차 판정의 회귀 둘을 먼저 읽어라"; false; }
}

@test "F68: settings.json wiring gate rejects a case-only matcher rewrite" {
  # nocasematch 아래에서 `[[ "$om" == "$nm" ]]` 가 대소문자 무시 동등비교가 되어,
  # matcher 를 소문자로 내리는 쓰기 하나로 PreToolUse 훅 전체가 사라지는데 통과했다.
  mkdir -p "$WORK/.claude"
  cat > "$WORK/.claude/settings.json" <<'JSON'
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"bash x.sh"}]}]}}
JSON
  local NEW='{"hooks":{"PreToolUse":[{"matcher":"bash","hooks":[{"type":"command","command":"bash x.sh"}]}]}}'
  run run_write "$(mk_write_input "$WORK/.claude/settings.json" "$NEW")"
  [ "$status" -eq 2 ] || { echo "matcher 대소문자만 바꾼 배선 축소가 통과했다 (INV-13)"; false; }
  # 이벤트 키 대문자화도 같은 클래스다
  local NEW2='{"hooks":{"PRETOOLUSE":[{"matcher":"Bash","hooks":[{"type":"command","command":"bash x.sh"}]}]}}'
  run run_write "$(mk_write_input "$WORK/.claude/settings.json" "$NEW2")"
  [ "$status" -eq 2 ] || { echo "이벤트 키 대문자화로 배선이 사라졌는데 통과했다 (INV-13)"; false; }
  # 대조 — 배선을 보존하는 정당한 편집은 통과해야 한다(과잉 차단 방지)
  local OK='{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"bash x.sh"}]}]},"env":{"A":"1"}}'
  run run_write "$(mk_write_input "$WORK/.claude/settings.json" "$OK")"
  [ "$status" -eq 0 ]
}

@test "F68: evaluator-runs append-only rejects a case-only rewrite of existing lines" {
  mkdir -p "$WORK/progress/agent-comms"
  local LOG="$WORK/progress/agent-comms/evaluator-runs.jsonl"
  printf '%s\n' '{"ts":"2026-08-01T00:00:00Z","agent_id":"a1","epoch":1}' \
                '{"ts":"2026-08-02T00:00:00Z","agent_id":"a2","epoch":2}' > "$LOG"
  local UP; UP=$(tr '[:lower:]' '[:upper:]' < "$LOG")
  run run_write "$(mk_write_input "$LOG" "$UP")"
  [ "$status" -eq 2 ] || { echo "기존 라인 대문자 재작성이 append-only 를 통과했다"; false; }
  # 대조 — 진짜 append 는 통과한다
  local APP; APP=$(cat "$LOG"; printf '%s\n' '{"ts":"2026-08-03T00:00:00Z","agent_id":"a3","epoch":3}')
  run run_write "$(mk_write_input "$LOG" "$APP")"
  [ "$status" -eq 0 ]
}

@test "F68: a contract created from nothing carries neither agreed nor a batch approval" {
  # 파일이 없으면 OLD_* 를 읽을 수 없어 전환 검사가 전부 무발화가 된다 — 삭제 후 재생성으로
  # 승인 범위를 주입하던 경로다(8차 지적, 9ea285e 는 agreed 쪽만 닫았다).
  mkdir -p "$WORK/progress/contracts"
  local BAD='{"sprint":99,"feature_id":"F99","agreed":true,"acceptance_criteria":[{"id":"AC-1"}],"implementation_steps":["a"]}'
  run run_write "$(mk_write_input "$WORK/progress/contracts/sprint-99.json" "$BAD")"
  [ "$status" -eq 2 ] || { echo "신규 계약이 agreed:true 로 생성됐는데 통과했다"; false; }
  local BAD2='{"sprint":99,"feature_id":"F99","agreed":false,"_batch_approval":{"scope":["**/*"],"N":99},"acceptance_criteria":[{"id":"AC-1"}],"implementation_steps":["a"]}'
  run run_write "$(mk_write_input "$WORK/progress/contracts/sprint-99.json" "$BAD2")"
  [ "$status" -eq 2 ] || { echo "신규 계약이 _batch_approval 을 담고 생성됐는데 통과했다"; false; }
  # 대조 — 정상 신규 계약(agreed:false, 배치 없음)은 통과해야 한다
  local OK='{"sprint":99,"feature_id":"F99","agreed":false,"acceptance_criteria":[{"id":"AC-1"}],"implementation_steps":["a"]}'
  run run_write "$(mk_write_input "$WORK/progress/contracts/sprint-99.json" "$OK")"
  [ "$status" -eq 0 ]
}

# === F68 10차 — 삭제 후 재생성을 개별 파일명이 아니라 원리적으로 닫는다 ===
# 6·8·9차는 각각 `feature_list.json`·`sprint-*.json` 하나씩만 열거해서 닫았다. 10차 판정이
# 나머지 여덟(harness-config.json·tests/*.bats·hooks.json·settings.json·invariant-guard.sh·
# evaluator-runs.jsonl·.integrity-baseline·approval-queue.json)이 그대로 열려 있음을 실증했다.
# 해법은 열거를 하나 더 늘리는 것이 아니라, 파일이 없을 때 **HEAD의 마지막 내용을 그 경로에
# 실체화**해 이후의 모든 비교가 원래 있던 파일과 똑같이 동작하게 하는 것이다.

setup_git_repo() {
  GITWORK=$(mktemp -d)
  git -C "$GITWORK" init -q
  git -C "$GITWORK" config user.email t@t
  git -C "$GITWORK" config user.name t
  mkdir -p "$GITWORK/progress" "$GITWORK/hooks" "$GITWORK/tests" "$GITWORK/.claude"
  cat > "$GITWORK/progress/harness-config.json" <<'JSON'
{ "scoring": { "pass_threshold": 7, "security_thresholds": { "critical": 7, "standard": 5, "low": 3 } } }
JSON
  printf '@test "x" {\n  true\n}\n' > "$GITWORK/tests/sample.bats"
  cat > "$GITWORK/hooks/hooks.json" <<'JSON'
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"bash ${CLAUDE_PLUGIN_ROOT}/hooks/pre-bash-firewall.sh"}]}]}}
JSON
  git -C "$GITWORK" add -A
  git -C "$GITWORK" commit -q -m baseline
}

@test "F68: deleting harness-config.json and recreating it with a lowered threshold still denies" {
  command -v git >/dev/null || skip "git not installed"
  setup_git_repo
  rm -f "$GITWORK/progress/harness-config.json"
  local BAD='{ "scoring": { "pass_threshold": 1, "security_thresholds": { "critical": 1, "standard": 1, "low": 1 } } }'
  CLAUDE_PROJECT_DIR="$GITWORK" run bash "$HOOK" <<<"$(mk_write_input "$GITWORK/progress/harness-config.json" "$BAD")"
  [ "$status" -eq 2 ] || { echo "삭제 후 재생성으로 임계값 하향이 통과했다"; false; }
  rm -rf "$GITWORK"
}

@test "F68: deleting hooks.json and recreating with a sibling-field kill switch still denies" {
  # 9차 대응(튜플 대조)이 뚫린 자리 — command 는 그대로 두고 `type` 을 대문자로 바꾸면
  # 스펙상 무효값이 되어 훅이 죽지만 튜플 추출값은 동일했다. 오브젝트 전문 비교로 잡는다.
  command -v git >/dev/null || skip "git not installed"
  setup_git_repo
  rm -f "$GITWORK/hooks/hooks.json"
  local BAD='{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"COMMAND","command":"bash ${CLAUDE_PLUGIN_ROOT}/hooks/pre-bash-firewall.sh"}]}]}}'
  CLAUDE_PROJECT_DIR="$GITWORK" run bash "$HOOK" <<<"$(mk_write_input "$GITWORK/hooks/hooks.json" "$BAD")"
  [ "$status" -eq 2 ] || { echo "삭제 후 형제 필드 우회로 재생성한 hooks.json 이 통과했다"; false; }
  rm -rf "$GITWORK"
}

@test "F68: deleting tests/*.bats and recreating it empty still denies (truncation)" {
  command -v git >/dev/null || skip "git not installed"
  setup_git_repo
  rm -f "$GITWORK/tests/sample.bats"
  CLAUDE_PROJECT_DIR="$GITWORK" run bash "$HOOK" <<<"$(mk_write_input "$GITWORK/tests/sample.bats" "")"
  [ "$status" -eq 2 ] || { echo "삭제 후 빈 파일로 재생성한 .bats 가 통과했다"; false; }
  rm -rf "$GITWORK"
}

@test "F68: a spelling variant of harness-config.json is treated as the same file" {
  # 대소문자 무시 FS 에서만 의미가 있다 — `git show HEAD:<철자>` 는 정확한 철자만 찾으므로
  # (core.ignorecase=true 여도) 재생성한 표기와 HEAD 의 실제 철자가 다르면 그 표기로는
  # 조회가 실패한다. HEAD 트리를 훑어 대소문자 무시로 일치하는 실제 철자를 먼저 찾아야 한다.
  command -v git >/dev/null || skip "git not installed"
  mkdir -p "$WORK/CiProbe"
  if [[ ! -e "$WORK/ciprobe" ]]; then skip "case-sensitive filesystem — 이 검사는 발화하지 않는다"; fi
  rmdir "$WORK/CiProbe" 2>/dev/null || rm -rf "$WORK/CiProbe"
  setup_git_repo
  rm -f "$GITWORK/progress/harness-config.json"
  local BAD='{ "scoring": { "pass_threshold": 1, "security_thresholds": { "critical": 1, "standard": 1, "low": 1 } } }'
  CLAUDE_PROJECT_DIR="$GITWORK" run bash "$HOOK" <<<"$(mk_write_input "$GITWORK/PROGRESS/HARNESS-CONFIG.JSON" "$BAD")"
  [ "$status" -eq 2 ] || { echo "표기를 바꿔 재생성한 harness-config.json 이 통과했다"; false; }
  rm -rf "$GITWORK"
}

@test "F68: materialization does not block a genuinely new file or a legitimate edit" {
  # 과잉 차단 방지 — HEAD 에 전혀 없던 경로(진짜 신규)는 여전히 정상 생성이고, 삭제 없이
  # 값을 올리는 정당한 편집도 그대로 통과해야 한다.
  command -v git >/dev/null || skip "git not installed"
  setup_git_repo
  CLAUDE_PROJECT_DIR="$GITWORK" run bash "$HOOK" <<<"$(mk_write_input "$GITWORK/hooks/brandnew.sh" "#!/bin/bash\necho hi\n")"
  [ "$status" -eq 0 ] || { echo "진짜 신규 훅 스크립트가 막혔다"; false; }
  local OK='{ "scoring": { "pass_threshold": 8, "security_thresholds": { "critical": 7, "standard": 5, "low": 3 } } }'
  CLAUDE_PROJECT_DIR="$GITWORK" run bash "$HOOK" <<<"$(mk_write_input "$GITWORK/progress/harness-config.json" "$OK")"
  [ "$status" -eq 0 ] || { echo "삭제 없는 정당한 임계값 상향이 막혔다"; false; }
  rm -rf "$GITWORK"
}

# === F68 마지막 알려진 한계 — 계약 디렉터리 안 파일 심볼릭 링크 ===
# `canon_file()`은 디렉터리를 `pwd -P`로 풀지만 **경로의 마지막 성분 자체가 링크**인 경우는
# 남아 있었다(8차 판정이 발견, 10차 판정이 완화 두 겹으로 medium 격하하며 INV-12에 문서화).
# `progress/contracts/alias.json -> sprint-53.json`에 쓰면 OS는 링크를 따라가 실제로
# sprint-53.json을 수정하지만, `BASENAME`이 여전히 `alias.json`이라 SC-4의 `_batch_approval`
# 불변성 검사가 발화하지 않았다(실측: exit 0, 승인 범위가 근거 없이 교체됨).

setup_git_contract_repo() {
  GITWORK=$(mktemp -d)
  git -C "$GITWORK" init -q
  git -C "$GITWORK" config user.email t@t
  git -C "$GITWORK" config user.name t
  mkdir -p "$GITWORK/progress/contracts"
  cat > "$GITWORK/progress/contracts/sprint-53.json" <<'JSON'
{"sprint":53,"feature_id":"F67","agreed":true,"_batch_approval":{"scope":["hooks/pre-bash-firewall.sh"],"N":3},"acceptance_criteria":[{"id":"AC-1"}],"implementation_steps":["a"]}
JSON
  git -C "$GITWORK" add -A
  git -C "$GITWORK" commit -q -m baseline
}

@test "F68: writing through a file symlink to a contract still enforces SC-4" {
  command -v git >/dev/null || skip "git not installed"
  setup_git_contract_repo
  ln -s sprint-53.json "$GITWORK/progress/contracts/alias.json"
  local BAD='{"sprint":53,"feature_id":"F67","agreed":true,"_batch_approval":{"scope":["**/*"],"N":99},"acceptance_criteria":[{"id":"AC-1"}],"implementation_steps":["a"]}'
  CLAUDE_PROJECT_DIR="$GITWORK" run bash "$HOOK" <<<"$(mk_write_input "$GITWORK/progress/contracts/alias.json" "$BAD")"
  [ "$status" -eq 2 ] || { echo "심볼릭 링크를 통한 계약 쓰기가 SC-4 를 우회했다"; false; }
  rm -rf "$GITWORK"
}

@test "F68: file-symlink resolution does not block unrelated links or cyclic ones" {
  # 과잉 차단 방지 — 보호와 무관한 대상을 가리키는 링크는 그대로 통과하고, 순환 링크는
  # 얕은 한도(10단계)에서 종료해 무한 루프가 되지 않는다.
  command -v git >/dev/null || skip "git not installed"
  setup_git_contract_repo
  ln -s ../../README.md "$GITWORK/progress/contracts/readme-link.md" 2>/dev/null || true
  touch "$GITWORK/README.md"
  CLAUDE_PROJECT_DIR="$GITWORK" run bash "$HOOK" <<<"$(mk_write_input "$GITWORK/progress/contracts/readme-link.md" "# hi")"
  [ "$status" -eq 0 ] || { echo "보호와 무관한 링크 대상 쓰기가 막혔다"; false; }

  ln -s loopb "$GITWORK/progress/contracts/loopa"
  ln -s loopa "$GITWORK/progress/contracts/loopb"
  CLAUDE_PROJECT_DIR="$GITWORK" run bash "$HOOK" <<<"$(mk_write_input "$GITWORK/progress/contracts/loopa" "{}")"
  # 11차 판정 지적: 이전 판본은 판정을 확인하지 않아 "종료했다"는 사실만 보고 있었다 —
  # 무한 루프가 아니라는 것과 **한도 초과를 안전한 방향으로 처리하는가**는 다른 질문이다.
  # 종료 시점에도 여전히 링크이므로 fail-closed(deny)여야 한다.
  [ "$status" -eq 2 ] || { echo "순환 링크가 한도 초과 후 fail-open 으로 통과했다"; false; }
  rm -rf "$GITWORK"
}

@test "F68: a symlink chain exceeding the resolution depth is denied, not judged by the last hop" {
  # 11차 판정 실증: 10단계에서 멈춘 뒤 마지막 상태로 판정하면 그 마지막이 여전히 링크일 때
  # `BASENAME` 이 링크 이름이라 SC-4 가 다시 발화하지 않는다 — 실측으로 10홉은 deny·11홉은
  # allow가 나왔다(프로그램에겐 11홉이 1홉보다 싸다). 한도 초과는 예외가 아니라 fail-closed
  # 대상이어야 한다. 9~12홉 경계를 전부 고정해 어느 길이에서도 우회가 열리지 않게 한다.
  command -v git >/dev/null || skip "git not installed"
  setup_git_contract_repo
  local n i
  for n in 9 10 11 12; do
    rm -f "$GITWORK"/progress/contracts/c[0-9]*
    ln -s sprint-53.json "$GITWORK/progress/contracts/c0"
    for i in $(seq 1 "$n"); do ln -s "c$((i - 1))" "$GITWORK/progress/contracts/c$i"; done
    local BAD='{"sprint":53,"feature_id":"F67","agreed":true,"_batch_approval":{"scope":["**/*"],"N":99},"acceptance_criteria":[{"id":"AC-1"}],"implementation_steps":["a"]}'
    CLAUDE_PROJECT_DIR="$GITWORK" run bash "$HOOK" <<<"$(mk_write_input "$GITWORK/progress/contracts/c$n" "$BAD")"
    [ "$status" -eq 2 ] || { echo "${n}홉 체인이 승인 범위 확대를 통과시켰다"; false; }
  done
  rm -rf "$GITWORK"
}

@test "F68: a chain broken by an inaccessible intermediate directory is denied, not passed through" {
  # 12차 판정 실증: 11차가 도입한 게이트(`resolve_file_symlink` 뒤 `[[ -L "$FILE" ]]`)는 그
  # 자체가 lstat 술어라서, 판정 불능(중간 디렉터리 접근 거부로 stat 실패)일 때도 false로
  # 평가돼 무력화된다. alias.json -> sub/inner -> ../sprint-53.json 에서 sub 를 접근 불가로
  # 만들면 두 번째 홉의 readlink/cd 가 실패하는데, 판정은 "여전히 링크"임을 확인할 수 없어
  # 그대로 통과했다(실측 exit 0). 판정 불가능은 성공이 아니다 — fail-closed 여야 한다.
  [[ "$(id -u)" -eq 0 ]] && skip "root bypasses directory permission bits"
  command -v git >/dev/null || skip "git not installed"
  setup_git_contract_repo
  mkdir -p "$GITWORK/progress/contracts/sub"
  ln -s ../sprint-53.json "$GITWORK/progress/contracts/sub/inner"
  ln -s sub/inner "$GITWORK/progress/contracts/alias.json"
  chmod 000 "$GITWORK/progress/contracts/sub"
  local BAD='{"sprint":53,"feature_id":"F67","agreed":true,"_batch_approval":{"scope":["**/*"],"N":99},"acceptance_criteria":[{"id":"AC-1"}],"implementation_steps":["a"]}'
  CLAUDE_PROJECT_DIR="$GITWORK" run bash "$HOOK" <<<"$(mk_write_input "$GITWORK/progress/contracts/alias.json" "$BAD")"
  chmod 755 "$GITWORK/progress/contracts/sub"
  [ "$status" -eq 2 ] || { echo "중간 디렉터리 접근 거부로 판정 불능이 된 체인이 fail-open 으로 통과했다 (status=$status)"; false; }
  rm -rf "$GITWORK"
}

# === F70: canon_file() 의 대소문자 무시 lookup 을 FS 의 실제 성질로 게이팅한다 ===
# `canon_file()` 은 대상이 존재하면 `ls -1 | grep -ixF` 로 "FS 가 인식하는 실제 철자" 를 물어봤다.
# 그 물음은 **FS 가 실제로 대소문자를 무시할 때만** 뜻이 있다. 구분하는 FS(이 저장소의 CI 인
# ubuntu-latest 포함)에서는 `feature_list.json` 과 `FEATURE_LIST.json` 이 서로 다른 두 파일로
# 공존하고, `grep -ixF` 는 둘 다 매치해 `head -1` 이 정렬 순서대로 하나를 고른다 — 공격자가
# 무방비 Write 로 만든 **디코이가 원본을 밀어내고 판정 대상이 된다.** security-auditor 실측:
# 디코이 하나로 일곱 게이트(passes 주입·임계값 하향·_batch_approval 교체·@test 삭제·hooks.json
# 과 settings.json 언와이어링·가드 자신의 deny() 무력화)가 전부 exit 0 이 됐다.
# `is_protected()` 가 nocasematch 를 `fs_is_case_insensitive()` 로 게이팅하는 것과 **같은 근거**를
# 이 lookup 에도 적용한다 — 새 판단축을 만들지 않는다.

@test "F70: canon_file's case-insensitive lookup is gated by fs_is_case_insensitive" {
  # 두 분기는 각각 한쪽 FS 에서만 자연히 성립한다(디코이 공존은 구분 FS 에서만 가능하고,
  # 변형 철자로 기존 파일에 닿는 것은 무시 FS 에서만 가능하다). 그래서 픽스처는 FS 에 맞춰
  # 고르되 **단언은 양쪽에서 동일**하게 둔다 — 게이트가 술어를 따르는가만 본다.
  # 술어를 스텁으로 갈아끼우므로, lookup 이 `fs_is_case_insensitive` 가 아닌 다른 축에
  # 걸려 있으면 스텁이 무시돼 이 테스트가 깨진다(같은 근거 재사용을 행동으로 고정).
  source <(sed -n '/^canon_file()/,/^}/p' "$HOOK")
  export LC_ALL=C   # ls 정렬을 고정해 어느 철자가 head -1 에 걸리는지 결정론적으로 만든다
  local D="$WORK/progress" req got
  : > "$D/feature_list.json"
  mkdir -p "$WORK/CiProbe"
  if [[ -e "$WORK/ciprobe" ]]; then
    req="FEATURE_LIST.JSON"          # 무시 FS: 두 철자가 공존 불가 — 변형 철자로 요청한다
  else
    : > "$D/FEATURE_LIST.json"       # 구분 FS: 디코이를 실제로 만든다 (원본과 공존)
    req="feature_list.json"
  fi
  rmdir "$WORK/CiProbe" 2>/dev/null || rm -rf "$WORK/CiProbe"

  # (1) FS 가 대소문자를 구분하면 lookup 을 하지 않는다 — 요청한 철자가 그대로 유지된다.
  fs_is_case_insensitive() { return 1; }
  got=$(canon_file "$D/$req")
  [ "$(basename "$got")" = "$req" ] || {
    echo "구분 FS 에서 판정 대상이 '$req' -> '$(basename "$got")' 로 재바인딩됐다"; false; }

  # (2) FS 가 대소문자를 무시하면 기존대로 실제 철자를 물어본다 (정당한 철자 변형 인식).
  fs_is_case_insensitive() { return 0; }
  got=$(canon_file "$D/$req")
  [ "$(basename "$got")" != "$req" ] || {
    echo "무시 FS 에서 lookup 이 돌지 않았다 — 정당한 철자 변형 인식이 깨진다"; false; }
}

@test "F70: a case-variant decoy does not rebind the guard's target (case-sensitive FS)" {
  # 종단 확인 — 디코이는 **이미 통과할 모양**으로 만든다(임계값이 낮고, passes 가 참이고,
  # @test 가 이미 하나). 그래야 판정이 디코이로 옮겨간 순간 "약화 없음" 으로 보여 exit 0 이
  # 된다. 원본 기준으로 판정하면 셋 다 약화이므로 deny 여야 한다.
  mkdir -p "$WORK/CiProbe"
  if [[ -e "$WORK/ciprobe" ]]; then
    rmdir "$WORK/CiProbe" 2>/dev/null || rm -rf "$WORK/CiProbe"
    skip "case-insensitive filesystem — 두 철자가 공존할 수 없어 디코이를 만들 수 없다"
  fi
  export LC_ALL=C   # 대문자가 먼저 정렬돼 디코이가 head -1 에 걸리는 것을 고정한다

  # (1) harness-config.json — 임계값 하향
  printf '%s\n' '{ "scoring": { "pass_threshold": 1, "security_thresholds": { "critical": 1, "standard": 1, "low": 1 } } }' > "$WORK/progress/HARNESS-CONFIG.json"
  local BAD='{ "scoring": { "pass_threshold": 1, "security_thresholds": { "critical": 1, "standard": 1, "low": 1 } } }'
  run run_write "$(mk_write_input "$WORK/progress/harness-config.json" "$BAD")"
  [ "$status" -eq 2 ] || { echo "디코이가 있으면 임계값 하향이 통과한다"; false; }

  # (2) feature_list.json — passes 주입
  printf '%s\n' '{"features":[{"id":"F1","passes":true}]}' > "$WORK/progress/FEATURE_LIST.json"
  printf '%s\n' '{"features":[{"id":"F1","passes":false}]}' > "$WORK/progress/feature_list.json"
  run run_write "$(mk_write_input "$WORK/progress/feature_list.json" '{"features":[{"id":"F1","passes":true}]}')"
  [ "$status" -eq 2 ] || { echo "디코이가 있으면 passes 주입이 통과한다"; false; }

  # (3) tests/*.bats — @test 삭제
  printf '@test "a" {\n  true\n}\n' > "$WORK/tests/SAMPLE.bats"
  printf '@test "a" {\n  true\n}\n@test "b" {\n  true\n}\n' > "$WORK/tests/sample.bats"
  run run_write "$(mk_write_input "$WORK/tests/sample.bats" '@test "a" {
  true
}
')"
  [ "$status" -eq 2 ] || { echo "디코이가 있으면 @test 삭제가 통과한다"; false; }
}

@test "F70: on a case-insensitive FS a variant spelling of an existing protected file is still gated" {
  # AC-2 의 앵커 — 과잉 게이팅 방지. 기존 F68 테스트들은 **삭제 후 재생성**(HEAD 실체화) 경로를
  # 덮는다. 파일이 **그대로 있는 채** 변형 철자로 닿는 경로는 canon_file 의 lookup 만이 닫으므로,
  # 게이팅을 너무 넓게 걸면 여기서 조용히 열린다.
  mkdir -p "$WORK/CiProbe"
  if [[ ! -e "$WORK/ciprobe" ]]; then skip "case-sensitive filesystem — 이 축은 이 FS 에서 발화하지 않는다"; fi
  rmdir "$WORK/CiProbe" 2>/dev/null || rm -rf "$WORK/CiProbe"
  local BAD='{ "scoring": { "pass_threshold": 1, "security_thresholds": { "critical": 1, "standard": 1, "low": 1 } } }'
  run run_write "$(mk_write_input "$WORK/progress/HARNESS-CONFIG.JSON" "$BAD")"
  [ "$status" -eq 2 ] || { echo "존재하는 harness-config.json 을 변형 철자로 쓰면 임계값 게이트가 열린다"; false; }
}
