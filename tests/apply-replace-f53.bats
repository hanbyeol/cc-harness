#!/usr/bin/env bats

# apply_replace() awk 구현 독립성 테스트 (F53)
#
# hooks/invariant-guard.sh의 apply_replace()는 old_string의 첫 출현을 new_string으로 치환한
# 전체 내용을 반환한다 — 모든 보호파일 Edit/MultiEdit 검증의 관문이다.
#
# 버그(F53): 원래 apply_replace는 awk `BEGIN{RS="\0"}`로 파일 전체를 1레코드로 읽으려 했으나,
# BSD one-true-awk(macOS 기본)는 `RS="\0"`를 `RS=""`(문단 모드)로 강등해 파일을 빈 줄 경계로
# 쪼갠다. 그러면 빈 줄을 걸친 old_string이 매칭 실패(편집 미반영 → false-deny 및 약화 편집
# 미탐지 false-allow)하고 레코드 사이 빈 줄이 소실된다(실측 518→473줄). 라인 버퍼 축적으로
# 재작성해 awk 구현 독립성을 확보했다.
#
# 이 파일은 **빈 줄 픽스처**를 잠근다 — 기존 F49~F51 테스트(invariant-guard.bats)가 전부
# 단일라인 old_string이라 이 분기를 놓쳤다. apply_replace의 다섯 번째 결함을 막는다.

PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
HOOK="$PLUGIN_ROOT/hooks/invariant-guard.sh"

# apply_replace 함수만 소스한다 (F49 테스트와 동일 패턴)
_source_apply_replace() {
  # shellcheck disable=SC1090
  source <(sed -n '/^apply_replace()/,/^}/p' "$HOOK")
}

@test "F53: apply_replace가 빈 줄을 걸친 old_string을 정확히 치환한다 (문단 모드 버그)" {
  _source_apply_replace
  local content old new result
  content=$(printf 'block A\n\nMIDDLE\n\nblock B\n')
  old=$(printf 'block A\n\nMIDDLE\n\nblock B')
  new="REPLACED_SPANNING_BLANKS"
  result=$(apply_replace "$content" "$old" "$new")
  [[ "$result" == *"REPLACED_SPANNING_BLANKS"* ]] \
    || { echo "빈 줄 걸친 치환 실패(버그 재현):[$result]"; false; }
}

@test "F53: apply_replace가 no-op 시 빈 줄을 보존한다 (문단 붕괴 없음)" {
  _source_apply_replace
  local content result
  content=$(printf 'x1\n\nx2\n\nx3\n')
  result=$(apply_replace "$content" "NOMATCH_ZZZ" "")
  [[ "$result" == "$content" ]] || { echo "빈 줄 소실(문단 모드 붕괴):[$result]"; false; }
}

@test "F53: apply_replace가 매치 없을 때 원본을 반환한다 (빈 줄 다수 실제 파일, \$() 정규화)" {
  _source_apply_replace
  local content result
  content=$(cat "$HOOK")
  result=$(apply_replace "$content" "ZZZ_NO_SUCH_STRING_XYZ" "")
  [[ "$result" == "$content" ]] || { echo "빈 줄 다수 파일 원본 미보존"; false; }
}

@test "F53: apply_replace가 첫 출현만 치환한다" {
  _source_apply_replace
  local result
  result=$(apply_replace "$(printf 'DUP\nmid\nDUP\n')" "DUP" "X")
  [[ "$result" == "$(printf 'X\nmid\nDUP')" ]] || { echo "첫 출현만 아님:[$result]"; false; }
}

@test "F53: apply_replace가 빈 줄을 걸친 deny 제거를 반영한다 (false-allow 방지, SC-1)" {
  # 빈 줄을 걸쳐 deny 블록 하나를 제거하는 편집 — 버그 상태에선 매칭 실패로 미반영돼
  # exit 2가 남아 약화검사가 '변경 없음'으로 오판(false-allow). 수정 후엔 실제로 제거된다.
  _source_apply_replace
  local content old new result
  content=$(printf 'deny() {\n  echo x\n  exit 2\n}\n\nother() {\n  :\n}\n')
  old=$(printf 'deny() {\n  echo x\n  exit 2\n}\n\nother() {\n  :\n}')
  new=$(printf 'deny() {\n  echo x\n}\n\nother() {\n  :\n}')
  result=$(apply_replace "$content" "$old" "$new")
  [[ "$result" != *"exit 2"* ]] \
    || { echo "빈 줄 걸친 deny 제거 미반영(false-allow 버그):[$result]"; false; }
}

@test "F53: apply_replace가 F49 백슬래시-개행 old_string을 회귀 없이 치환한다" {
  # F49(ENVIRON[] 경유)를 라인 버퍼 재작성이 되돌리지 않았는지 확인.
  _source_apply_replace
  local content old new result
  content=$(printf '  case "$f" in\n    a) ;;\n    b | \\\n    c) return 0 ;;\n  esac\n')
  old=$(printf '    b | \\\n    c) return 0 ;;\n')
  new="F49_MARK"
  result=$(apply_replace "$content" "$old" "$new")
  [[ "$result" == *"F49_MARK"* ]] || { echo "F49 백슬래시-개행 회귀:[$result]"; false; }
}

@test "F53: apply_replace가 awk 실패 시 non-zero로 종료한다 (F50 fail-closed 메커니즘 보존)" {
  # o/n을 정상 전달하되 awk 자체를 못 찾게 하면 함수 종료 상태가 non-zero여야 한다 —
  # 호출부 fail_closed_on_apply_failure()가 이 종료 상태로 보호파일을 deny한다(F50).
  _source_apply_replace
  local rc
  # awk가 없는 PATH에서 실행
  PATH=/nonexistent-dir apply_replace "content" "old" "new" >/dev/null 2>&1 && rc=0 || rc=$?
  [ "$rc" -ne 0 ] || { echo "awk 실패인데 0 종료(fail-closed 깨짐)"; false; }
}

# --- 후속(F53 evaluator low): multibyte 픽스처 + live-hook end-to-end 회귀 ---
# 양 judge가 남긴 non-blocking 후속을 영구 잠금으로 편입한다:
#  (1) ko_KR.UTF-8(멀티바이트)에서 빈 줄 걸친 치환 — index/substr가 바이트/문자 경계에서
#      안전한지(단일 awk 내 일관 단위)를 픽스처로 고정.
#  (2) SC-1 false-allow 차단을 함수 레벨(위 테스트)뿐 아니라 **라이브 훅 end-to-end**로 잠근다.

@test "F53: apply_replace가 멀티바이트(한글) old_string을 빈 줄 걸쳐 치환한다 (ko_KR.UTF-8)" {
  _source_apply_replace
  local content old new result
  content=$(printf '한글 블록 가\n\n중간 나\n\n한글 블록 다\n')
  old=$(printf '한글 블록 가\n\n중간 나\n\n한글 블록 다')
  new="MB_REPLACED"
  result=$(apply_replace "$content" "$old" "$new")
  [[ "$result" == *"MB_REPLACED"* ]] || { echo "멀티바이트 빈 줄 걸친 치환 실패:[$result]"; false; }
}

@test "F53: apply_replace가 멀티바이트 no-op 시 한글·빈 줄을 완전 보존한다" {
  _source_apply_replace
  local content result
  content=$(printf '설명 하나\n\n둘째 줄\n\n셋째 줄\n')
  result=$(apply_replace "$content" "존재하지않는문자열" "")
  [[ "$result" == "$content" ]] || { echo "멀티바이트 no-op 손상:[$result]"; false; }
}

# 라이브 훅을 Edit 페이로드로 구동한다 (함수 소스가 아니라 실제 PreToolUse 경로).
_run_guard_edit() {
  jq -n --arg f "$1" --arg o "$2" --arg n "$3" \
    '{tool_name:"Edit",tool_input:{file_path:$f,old_string:$o,new_string:$n}}' | bash "$HOOK"
}

@test "F53: 라이브 훅이 빈 줄 걸친 deny 제거 편집을 deny한다 (SC-1 end-to-end 회귀)" {
  # 미니 보호파일(basename invariant-guard.sh → is_protected)에서 빈 줄을 걸쳐 deny 블록을
  # 제거하는 Edit. RS 문단 모드 버그가 재발하면 apply_replace 매칭 실패로 편집이 미반영돼
  # deny_has_exit가 TRUE→TRUE(변화 없음)로 오판, 약화가 통과(exit 0 = false-allow)한다.
  # 라인 버퍼 구현에선 실제 제거가 반영돼 deny(exit 2). 이 테스트가 그 회귀를 영구 잠근다.
  local W rc old new
  W=$(mktemp -d)
  cat > "$W/invariant-guard.sh" <<'SH'
deny() {
  echo msg
  exit 2
}

other() {
  :
}
SH
  old=$(printf 'deny() {\n  echo msg\n  exit 2\n}\n\nother() {\n  :\n}')
  new=$(printf 'deny() {\n  echo msg\n}\n\nother() {\n  :\n}')
  _run_guard_edit "$W/invariant-guard.sh" "$old" "$new" >/dev/null 2>&1 && rc=0 || rc=$?
  rm -rf "$W"
  [ "$rc" -eq 2 ] \
    || { echo "빈 줄 걸친 deny 제거가 라이브 훅에서 deny되지 않음(false-allow 재발):rc=$rc"; false; }
}
