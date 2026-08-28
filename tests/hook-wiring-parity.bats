#!/usr/bin/env bats

# hook-wiring-parity tests (F52 / INV-13)
#
# cc-harness는 설치 경로가 둘이고, 각자 다른 파일로 훅을 배선한다:
#   - 플러그인 경로 : hooks/hooks.json      (${CLAUDE_PLUGIN_ROOT}/hooks/...)
#   - init.sh 경로  : settings.json         (${CLAUDE_PROJECT_DIR}/.claude/hooks/...)
#                     → init.sh:615가 .claude/settings.json으로 설치
#
# 두 배선이 비대칭이면 한쪽 경로로 설치한 사용자만 게이트 없이 동작하게 된다.
# 실제로 F52 이전에는 invariant-guard.sh·pre-tool-firewall.sh가 settings.json에
# 배선되지 않아, init.sh 경로 설치 프로젝트는 INV-1~INV-12가 전부 미집행이었다.
# (init.sh:602-609가 스크립트를 복사는 하므로 dead file로 남아 눈에 띄지 않았다.)
#
# 두 계층을 모두 검증한다:
#   1. 정적 대칭 (저장소 CI) — 두 배선 파일의 스크립트 집합 대조
#   2. 런타임 가드 (설치 프로젝트) — invariant-guard.sh의 INV-13 브랜치
# 설치된 프로젝트에는 CI가 없으므로 런타임 가드가 유일한 방어선이다. 따라서 두 계층의
# 추출기는 **같은 강도**여야 한다 — 약한 쪽이 실제 방어선이 되기 때문이다(F52 evaluator).

PLUGIN_WIRING="hooks/hooks.json"
PROJECT_WIRING="settings.json"
GUARD="hooks/invariant-guard.sh"

# ─── 의도적 제외 allowlist ───
# 여기 추가하려면 **반드시 사유를 함께 적는다**. 사유 없는 항목은 '조용한 누락'과
# 구분되지 않아 이 테스트의 의미를 무력화한다.
#
#   setup-claudemd.sh : plugin SessionStart 전용. 프로젝트로 복사하면
#                       CLAUDE_PLUGIN_ROOT가 .claude를 가리켜 자기 설치를 삭제하는
#                       self-wipe 위험이 있어 init.sh가 복사 자체를 제외한다
#                       (init.sh:278, init.sh:604).
INTENTIONAL_EXCLUSIONS="setup-claudemd.sh"

# 배선 파일에서 훅 스크립트 basename 집합을 추출한다 (정렬·중복제거).
wired_scripts() {
  jq -r '.hooks | .[] | .[] | .hooks[] | .command' "$1" 2>/dev/null \
    | grep -oE '[A-Za-z0-9_-]+\.sh' \
    | sort -u
}

# invariant-guard에 먹일 Write 페이로드 생성 (file_path는 절대경로여야 가드가 디스크와 비교한다)
payload() {
  jq -n --arg f "$(pwd)/settings.json" --arg c "$1" \
    '{tool_name:"Write", tool_input:{file_path:$f, content:$c}}'
}

# 가드를 실행하고 종료코드를 반환한다.
# 주의: `bash -c`로 감싸지 않는다 — 새 셸에는 이 파일의 함수가 없어 페이로드가 비고,
# 빈 stdin을 받은 가드는 exit 0으로 끝나 **테스트가 거짓 통과**한다(실제로 겪은 실패 모드).
run_guard() {
  payload "$1" | bash "$GUARD"
}

# jq만 없는 PATH에서 가드를 실행한다 (fail-closed 검증용).
run_guard_without_jq() {
  printf '%s' "$1" | env PATH="$2" /bin/bash "$GUARD"
}

# settings.json의 invariant-guard 배선을 변형한 JSON을 만든다.
mutate_guard_entry() {
  jq "$1" settings.json
}

setup() {
  # jq 부재 시 조용히 skip하지 않는다 — 검증 장치가 결핍으로 무력화되는 것을
  # 통과로 보고하면 F41이 닫은 fail-open을 테스트 계층에서 되살리는 셈이다.
  command -v jq >/dev/null || {
    echo "jq is required for wiring-parity verification (fail-closed)" >&2
    return 1
  }
}

@test "배선 파일 두 개가 모두 유효한 JSON이다" {
  jq -e '.' "$PLUGIN_WIRING" >/dev/null
  jq -e '.' "$PROJECT_WIRING" >/dev/null
}

@test "배선 파일에서 스크립트를 하나 이상 추출할 수 있다 (추출기 자체 검증)" {
  # 추출 정규식이 깨지면 두 집합이 모두 공집합이 되어 대칭 테스트가
  # 무의미하게 통과한다 — 그 실패 모드를 먼저 차단한다.
  [ "$(wired_scripts "$PLUGIN_WIRING" | wc -l)" -ge 5 ]
  [ "$(wired_scripts "$PROJECT_WIRING" | wc -l)" -ge 5 ]
}

@test "hooks.json에 배선된 스크립트는 settings.json에도 배선된다 (의도적 제외 제외)" {
  MISSING=""
  while read -r s; do
    [ -z "$s" ] && continue
    case " $INTENTIONAL_EXCLUSIONS " in *" $s "*) continue ;; esac
    wired_scripts "$PROJECT_WIRING" | grep -qx "$s" || MISSING="$MISSING $s"
  done < <(wired_scripts "$PLUGIN_WIRING")

  if [ -n "$MISSING" ]; then
    echo "settings.json에 배선 누락:$MISSING" >&2
    echo "init.sh 경로로 설치한 프로젝트에서 이 훅들이 동작하지 않습니다." >&2
    return 1
  fi
}

@test "settings.json에 배선된 스크립트는 hooks.json에도 배선된다 (역방향)" {
  MISSING=""
  while read -r s; do
    [ -z "$s" ] && continue
    wired_scripts "$PLUGIN_WIRING" | grep -qx "$s" || MISSING="$MISSING $s"
  done < <(wired_scripts "$PROJECT_WIRING")

  if [ -n "$MISSING" ]; then
    echo "hooks.json에 배선 누락:$MISSING" >&2
    return 1
  fi
}

@test "의도적 제외 항목은 실제로 hooks.json에만 존재한다 (stale allowlist 차단)" {
  # 제외 사유가 사라졌는데 allowlist에만 남아 있으면, 나중에 진짜 누락이
  # 생겨도 면제되어 버린다.
  for s in $INTENTIONAL_EXCLUSIONS; do
    wired_scripts "$PLUGIN_WIRING" | grep -qx "$s" \
      || { echo "allowlist가 오래됨: $s 는 $PLUGIN_WIRING 에 더는 배선되지 않습니다" >&2; return 1; }
    wired_scripts "$PROJECT_WIRING" | grep -qx "$s" \
      && { echo "allowlist 모순: $s 가 $PROJECT_WIRING 에 배선되어 있으므로 제외 대상이 아니다" >&2; return 1; }
  done
  return 0
}

@test "배선된 모든 스크립트가 hooks/ 에 실제로 존재한다" {
  for f in $(wired_scripts "$PLUGIN_WIRING"; wired_scripts "$PROJECT_WIRING"); do
    [ -f "hooks/$f" ] || { echo "배선되었으나 파일 없음: hooks/$f" >&2; return 1; }
  done
}

@test "두 배선의 PreToolUse matcher가 같은 스크립트에 대해 일치한다" {
  # 같은 스크립트가 서로 다른 도구 집합에 걸려 있으면 한쪽 경로만 보호된다.
  matcher_of() {
    jq -r --arg s "$2" '
      .hooks.PreToolUse[]
      | select(any(.hooks[]; .command | contains($s)))
      | .matcher // ""' "$1" 2>/dev/null | head -1
  }
  for s in $(wired_scripts "$PLUGIN_WIRING"); do
    case " $INTENTIONAL_EXCLUSIONS " in *" $s "*) continue ;; esac
    wired_scripts "$PROJECT_WIRING" | grep -qx "$s" || continue
    A=$(matcher_of "$PLUGIN_WIRING" "$s")
    B=$(matcher_of "$PROJECT_WIRING" "$s")
    [ "$A" = "$B" ] || { echo "matcher 불일치: $s — hooks.json='$A' vs settings.json='$B'" >&2; return 1; }
  done
}

# ─────────────────────────────────────────────────────────────
# INV-13 런타임 가드 — settings.json 배선 무력화 차단 (F52 SC-1)
# is_protected()의 전면 차단이 아니라 **배선 약화만** 탐지하는 설계를 잠근다.
# ─────────────────────────────────────────────────────────────

@test "INV-13 하네스 자체 검증: 정상 내용은 통과한다 (가드가 항상 deny하는 게 아님)" {
  # 아래 deny 테스트들이 '무조건 2를 반환하는 고장난 가드' 때문에 통과하는 것을 배제한다.
  run run_guard "$(cat settings.json)"
  [ "$status" -eq 0 ]
}

@test "INV-13: settings.json에서 훅 배선을 제거하면 deny한다" {
  STRIPPED=$(mutate_guard_entry '.hooks.PreToolUse |= map(select(
    any(.hooks[]; .command | test("invariant-guard")) | not))')
  run run_guard "$STRIPPED"
  [ "$status" -eq 2 ]
}

@test "INV-13: 배선과 무관한 키 추가는 통과시킨다 (과잉 차단 방지)" {
  # 설치된 프로젝트에서 사용자가 env·permissions를 고치는 정당한 편집까지
  # 막으면 마찰이 과도하다 — 내용 기반 설계를 채택한 이유(계약 SC-1).
  run run_guard "$(mutate_guard_entry '.env = {"FOO":"bar"}')"
  [ "$status" -eq 0 ]
}

@test "INV-13: settings.json이 깨진 JSON이면 deny한다" {
  run run_guard '{ not json'
  [ "$status" -eq 2 ]
}

@test "INV-13: jq 부재 시 settings.json 편집은 fail-closed로 차단된다" {
  # is_wiring_file()이 has_jq 게이트에 포함되어야 성립한다. 포함되지 않으면
  # jq만 지우면 배선 검사를 통째로 우회할 수 있다 (F41이 닫은 fail-open과 동형).
  NOJQ=$(mktemp -d)
  for b in cat grep sed head basename awk wc tr ls sort dirname; do
    for d in /bin /usr/bin /usr/local/bin /opt/homebrew/bin; do
      [ -x "$d/$b" ] && { ln -sf "$d/$b" "$NOJQ/$b"; break; }
    done
  done
  [ -x "$NOJQ/grep" ] || { echo "테스트 환경 구성 실패: grep 링크 없음" >&2; rm -rf "$NOJQ"; return 1; }

  P=$(payload "$(cat settings.json)")
  run run_guard_without_jq "$P" "$NOJQ"
  rm -rf "$NOJQ"
  [ "$status" -eq 2 ]
}

@test "INV-13: jq와 추출 도구(head)가 함께 없으면 fail-closed로 차단된다" {
  # jq 부재 경로는 grep/sed/head 파이프라인으로 file_path를 추출한다. 그 도구까지
  # 없으면 보호 대상 판정 자체가 불가능하므로 통과시켜선 안 된다(F52 2차 evaluator).
  NOJQ=$(mktemp -d)
  for b in cat grep sed basename awk wc tr ls sort dirname; do   # head 제외
    for d in /bin /usr/bin /usr/local/bin /opt/homebrew/bin; do
      [ -x "$d/$b" ] && { ln -sf "$d/$b" "$NOJQ/$b"; break; }
    done
  done
  P=$(payload "$(cat settings.json)")
  run run_guard_without_jq "$P" "$NOJQ"
  rm -rf "$NOJQ"
  [ "$status" -eq 2 ]
}

# ─── 무력화 벡터 회귀 ───
#
# 이 섹션은 세 차례의 evaluator 판정이 실증한 우회들을 잠근다. 중요한 것은 개별
# 인스턴스가 아니라 **클래스**다 — 1차가 (a)(b)(c)를 찾았고, 그것들만 닫은 수정을
# 2차가 `true # ` 접두로, 그마저 닫자 3차가 형제 필드로 다시 뚫었다. 교훈: 실증된
# 인스턴스를 하나씩 닫는 수정은 클래스를 닫지 못한다.
#
# 현재 가드는 (event, matcher, **훅 오브젝트 전문(정규화 JSON)**)을 비교한다:
#   - 오브젝트 전문 바이트 동일성 → command 변조·형제 필드 추가/변조/삭제를 전부 차단
#   - matcher는 동일성이 아니라 포함관계 → 확대(강화)는 허용, 축소·무력화는 차단

@test "INV-13 무력화(a): 실제 배선을 지우고 미끼 문자열만 남기면 deny한다" {
  run run_guard "$(mutate_guard_entry '.hooks.PreToolUse |= map(
    if any(.hooks[]; .command | test("invariant-guard"))
    then .hooks = [{"type":"command","command":"echo invariant-guard.sh"}]
    else . end)')"
  [ "$status" -eq 2 ]
}

@test "INV-13 무력화(b): matcher를 무력화하면 deny한다 (집합 보존 ≠ 실행 보장)" {
  run run_guard "$(mutate_guard_entry '.hooks.PreToolUse |= map(
    if any(.hooks[]; .command | test("invariant-guard"))
    then .matcher = "NeverMatchXYZ"
    else . end)')"
  [ "$status" -eq 2 ]
}

@test "INV-13 무력화(c): hooks 키를 통째로 다른 키로 옮기면 deny한다" {
  run run_guard "$(mutate_guard_entry '{disabled_hooks: .hooks} + del(.hooks)')"
  [ "$status" -eq 2 ]
}

@test "INV-13 무력화(N1): 'true # ' 접두로 command를 주석 처리하면 deny한다" {
  # basename만 비교하던 구현은 마지막 슬래시 앞을 버려 원본과 동일한 튜플을 냈다.
  run run_guard "$(mutate_guard_entry '.hooks.PreToolUse |= map(
    if any(.hooks[]; .command | test("invariant-guard"))
    then .hooks = [{"type":"command","command":("true # " + (.hooks[0].command))}]
    else . end)')"
  [ "$status" -eq 2 ]
}

@test "INV-13 무력화(N1): 공백 없는 'true#' 접두도 deny한다" {
  run run_guard "$(mutate_guard_entry '.hooks.PreToolUse |= map(
    if any(.hooks[]; .command | test("invariant-guard"))
    then .hooks = [{"type":"command","command":("true#" + (.hooks[0].command))}]
    else . end)')"
  [ "$status" -eq 2 ]
}

@test "INV-13 무력화(N1): 슬래시를 포함한 위장 경로 주석도 deny한다" {
  run run_guard "$(mutate_guard_entry '.hooks.PreToolUse |= map(
    if any(.hooks[]; .command | test("invariant-guard"))
    then .hooks = [{"type":"command","command":"bash -c : # /x/invariant-guard.sh"}]
    else . end)')"
  [ "$status" -eq 2 ]
}

@test "INV-13 과잉차단 방지: matcher 확대(|NotebookEdit)는 통과시킨다" {
  # 보호를 넓히는 정당한 강화 편집이다. matcher 동일성을 요구하면 이것까지 막힌다.
  run run_guard "$(mutate_guard_entry '.hooks.PreToolUse |= map(
    if any(.hooks[]; .command | test("invariant-guard"))
    then .matcher = (.matcher + "|NotebookEdit")
    else . end)')"
  [ "$status" -eq 0 ]
}

@test "INV-13: matcher 축소는 deny한다 (확대와 대칭)" {
  run run_guard "$(mutate_guard_entry '.hooks.PreToolUse |= map(
    if any(.hooks[]; .command | test("invariant-guard"))
    then .matcher = "Edit"
    else . end)')"
  [ "$status" -eq 2 ]
}

@test "INV-13 과잉차단 방지: 기존 배선을 유지한 채 훅을 추가하면 통과시킨다" {
  run run_guard "$(mutate_guard_entry '.hooks.PreToolUse += [{
    "matcher":"Bash",
    "hooks":[{"type":"command","command":"bash \"x/new-hook.sh\""}]}]')"
  [ "$status" -eq 0 ]
}

# ─── N2 클래스: 형제 필드 무력화 (F52 3차 evaluator) ───
#
# 2차를 통과한 (event, matcher, command) 튜플 비교를, 3차가 command를 그대로 둔 채
# `if`·`once`·`async`·`type` 등 훅 오브젝트의 **형제 필드**를 변조해 다시 뚫었다.
# 세 번째 같은 클래스 재발이다. 그래서 비교를 오브젝트 전문(정규화 JSON)으로 뒤집었다 —
# command만이 아니라 훅 오브젝트 전체가 정규화 동일해야 통과한다.
#
# 아래는 인스턴스 열거가 아니라 **속성 검증**이다: command를 바이트 동일하게 유지한 채
# 어떤 필드를 추가·변조하든 deny되어야 한다. 개별 필드는 공식 스키마
# (claude-code-settings.schema.json)의 훅 오브젝트 필드에서 뽑았고, 스키마에 없는 필드까지
# 포함해 '미래 벤더 필드도 default-deny'를 잠근다.

# command를 유지한 채 첫 invariant-guard 훅 오브젝트에 필드 하나를 얹는 헬퍼
add_sibling_field() {
  mutate_guard_entry ".hooks.PreToolUse |= map(
    if any(.hooks[]; .command | test(\"invariant-guard\"))
    then .hooks[0] += $1
    else . end)"
}

@test "INV-13 N2: command를 유지한 채 형제 필드를 얹으면 (스키마 전 필드) deny한다" {
  # 실행을 좌우하는 스키마 필드 + 미래 벤더 필드. 하나라도 통과하면 클래스가 안 닫힌 것.
  for f in '{"if":"Bash(zzz-never)"}' '{"once":true}' '{"async":true}' \
           '{"asyncRewake":true}' '{"shell":"powershell"}' '{"args":[]}' \
           '{"timeout":1}' '{"statusMessage":"x"}' '{"allowedEnvVars":[]}' \
           '{"continueOnBlock":true}' '{"xYzFutureVendorField":"neuter"}'; do
    run run_guard "$(add_sibling_field "$f")"
    [ "$status" -eq 2 ] || { echo "형제 필드 $f 가 통과됨(클래스 미봉쇄)" >&2; return 1; }
  done
}

@test "INV-13 N2: type을 prompt로 바꾸면 (command는 죽은 잔재) deny한다" {
  run run_guard "$(mutate_guard_entry '.hooks.PreToolUse |= map(
    if any(.hooks[]; .command | test("invariant-guard"))
    then .hooks[0] = {"type":"prompt","prompt":"noop","command":.hooks[0].command}
    else . end)')"
  [ "$status" -eq 2 ]
}

@test "INV-13 N2: type 필드를 삭제하면 deny한다" {
  run run_guard "$(mutate_guard_entry '.hooks.PreToolUse |= map(
    if any(.hooks[]; .command | test("invariant-guard"))
    then .hooks[0] |= del(.type)
    else . end)')"
  [ "$status" -eq 2 ]
}

@test "INV-13 과잉차단 방지: matcher 삭제(=전체매치)는 통과시킨다" {
  # matcher 부재 = 모든 도구 매치 = widening. SOH 구분자 이전에는 빈 필드가
  # 탭 병합으로 밀려 오탐 deny였다(회귀 잠금).
  run run_guard "$(mutate_guard_entry '.hooks.PreToolUse |= map(
    if any(.hooks[]; .command | test("invariant-guard"))
    then del(.matcher)
    else . end)')"
  [ "$status" -eq 0 ]
}

@test "INV-13 과잉차단 방지: matcher 빈 문자열(=전체매치)도 통과시킨다" {
  run run_guard "$(mutate_guard_entry '.hooks.PreToolUse |= map(
    if any(.hooks[]; .command | test("invariant-guard"))
    then .matcher = ""
    else . end)')"
  [ "$status" -eq 0 ]
}

# ─── 문서 레벨 도달성: 최상위 hook-kill 스위치 (F52 4차 evaluator) ───
#
# 오브젝트 default-deny(N2)를 통과한 뒤, 4차가 disableAllHooks:true 하나로 다시 뚫었다 —
# 훅 오브젝트는 바이트 동일한데 최상위 boolean이 전 훅을 죽인다. "실행 도달성"은 훅 오브젝트가
# 아니라 settings **문서 전체**의 속성이다(훅이 발화 = 배선됨 AND 최상위 스위치가 안 죽임).
# 네 번째 같은 클래스 재발이라, 검증도 문서 레벨 속성으로 재구성한다.

@test "INV-13 문서레벨: disableAllHooks:true를 켜면 deny한다" {
  run run_guard "$(mutate_guard_entry '. + {disableAllHooks:true}')"
  [ "$status" -eq 2 ]
}

@test "INV-13 문서레벨: allowManagedHooksOnly:true를 켜면 deny한다" {
  run run_guard "$(mutate_guard_entry '. + {allowManagedHooksOnly:true}')"
  [ "$status" -eq 2 ]
}

@test "INV-13 과잉차단 방지: 훅과 무관한 disable 스위치는 통과시킨다" {
  # disableWorkflows/disableArtifact 등은 훅 실행과 무관 — 막으면 과잉 차단.
  run run_guard "$(mutate_guard_entry '. + {disableWorkflows:true, disableArtifact:true}')"
  [ "$status" -eq 0 ]
}

@test "INV-13 과잉차단 방지: disableAllHooks:false 명시는 통과시킨다 (off→off)" {
  run run_guard "$(mutate_guard_entry '. + {disableAllHooks:false}')"
  [ "$status" -eq 0 ]
}

# ─── F75: disableCommandPluginSources ───
#
# 스키마 2.1.238이 추가한 hook-affecting boolean. 앞의 둘과 **의미가 대칭이 아니다** —
# on = command 소스 플러그인을 설치·갱신·재해석하지 않음이라 일반적으로는 오히려 강화이고,
# kill이 되는 것은 하네스 자신이 command 소스로 설치된 형태뿐이다(재해석이 끊겨 실행 도달성
# 상실). 게다가 스키마가 managed settings 전용이라고 명시한다. 그럼에도 등록해 fail-closed로
# 두는 근거는 invariant-guard.sh의 HOOK_KILL_SWITCHES 주석과 INV-13 본문에 있다.

@test "INV-13 문서레벨(F75): disableCommandPluginSources:true를 켜면 deny한다" {
  run run_guard "$(mutate_guard_entry '. + {disableCommandPluginSources:true}')"
  [ "$status" -eq 2 ]
  # 종료 코드만 단언하면 향후 **다른 규칙**이 같은 픽스처를 우연히 막아도 exit 2가 유지되어
  # 이 스위치의 등록이 풀린 회귀가 가려진다(1차 판정 지적). deny 사유가 이 스위치를
  # 지목하는지까지 단언한다.
  [[ "$output" == *"최상위 disableCommandPluginSources 켜짐"* ]]
}

@test "INV-13 과잉차단 방지(F75): disableCommandPluginSources:false 명시는 통과시킨다 (off→off)" {
  run run_guard "$(mutate_guard_entry '. + {disableCommandPluginSources:false}')"
  [ "$status" -eq 0 ]
}

# OLD 내용을 제어해야 하는 케이스(false→on, 배선 없는 파일)용 픽스처.
#
# **저장소 밖**에 만든다. 이유는 오직 하나 — 이 저장소의 `.tmp/` 를 쓰면 가드가 매 실행마다
# 실 티켓 원장(progress/.guarded-edits)에 소비 불가능한 항목을 적립한다(픽스처 경로가 즉시
# 삭제되므로 소비될 수 없고 PROTECTED_GLOBS 밖이라 회수도 없다). security-auditor가 실측 지적.
#
# **한때 여기에 `git init`이 있었고 그 근거는 틀렸다.** "git이 아닌 임시 디렉터리는 root 해석에
# 실패해 fail-closed가 되므로 deny 단언이 tautology가 된다"고 적었으나, F37 2차 판정이 평범한
# `mktemp -d`에서 116건 코퍼스를 돌려 **116/116 동일 판정**임을 실측해 반증했다 — `__root`는
# `! -e $FILE` arm 에서만 참조되고, 티켓 발급 실패는 경고 후 return 0 이다. 필요 없는 것을
# 필요하다고 적어 두면 다음 사람이 그 제약을 진짜로 믿는다. 그래서 `git init`을 걷어낸다.
#
# `pwd -P`는 남긴다 — macOS의 mktemp는 /var(→/private/var) 심볼릭 링크 아래를 주고, 심볼릭
# 경로와 실경로의 불일치는 F72가 세 번째 회전에서 실제로 겪은 실패 모드다.
fixture_guard() {   # $1=OLD를 만드는 jq 변형, $2=NEW를 만드는 jq 변형
  local d st new
  d=$(mktemp -d) || return 99
  d=$(cd "$d" && pwd -P) || return 99
  jq "$1" settings.json > "$d/settings.json"
  new=$(jq "$2" "$d/settings.json")
  jq -n --arg f "$d/settings.json" --arg c "$new" \
    '{tool_name:"Write", tool_input:{file_path:$f, content:$c}}' | bash "$GUARD"
  st=$?
  rm -rf "$d"
  return $st
}

@test "INV-13 하네스 자체 검증(F75): 픽스처 무변경은 통과한다 (fixture_guard가 항상 deny하는 게 아님)" {
  # 아래 픽스처 deny 테스트들이 '경로 때문에 무조건 차단되는' 상태로 거짓 통과하는 것을 배제한다.
  run fixture_guard '. + {disableCommandPluginSources:false}' '.'
  [ "$status" -eq 0 ]
}

@test "INV-13 문서레벨(F75): disableCommandPluginSources를 false→true로 바꾸면 deny한다" {
  run fixture_guard '. + {disableCommandPluginSources:false}' '. + {disableCommandPluginSources:true}'
  [ "$status" -eq 2 ]
  [[ "$output" == *"최상위 disableCommandPluginSources 켜짐"* ]]
  [[ "$output" == *"off→true"* ]]
}

@test "INV-13 문서레벨(F75): 스펙 위반 값(1·\"true\"·\"false\")도 on으로 보아 deny한다" {
  # F52 5차가 기존 두 스위치에 확립한 값 강건화 규칙이 신규 항목에도 적용되어야 한다 —
  # 한 항목만 빠지면 그 자리가 우회 표면이 된다. false/부재만 off로 보므로 문자열 "false"도 on이다.
  for v in '1' '"true"' '"false"'; do
    run fixture_guard '. + {disableCommandPluginSources:false}' \
      ". + {disableCommandPluginSources:$v}"
    [ "$status" -eq 2 ] || { echo "값 $v 가 deny되지 않았다 (exit=$status)" >&2; return 1; }
    # 사유까지 확인 — 다른 규칙의 우연한 발화로 exit 2가 유지되는 경우를 배제한다.
    # **스위치명만 찾으면 안 된다**(F37 2차 지적): 공유 deny 문자열이 어느 스위치에 걸리든
    # disableCommandPluginSources를 언급하므로, 이름만 찾는 단언은 disableAllHooks deny로도
    # 만족된다. 어느 스위치가 걸렸는지 특정하는 `최상위 <이름> 켜짐` 형태여야 한다.
    [[ "$output" == *"최상위 disableCommandPluginSources 켜짐"* ]] \
      || { echo "값 $v 의 deny 사유가 이 스위치를 지목하지 않는다: $output" >&2; return 1; }
  done
}

@test "INV-13 과잉차단 방지(F75): 훅을 배선하지 않는 settings에서는 켜도 통과시킨다" {
  # OLD 집합이 공집합이면 죽일 배선이 없다 — 기존 두 스위치와 동일한 면제 규칙.
  run fixture_guard 'del(.hooks) | . + {env:{FOO:"bar"}}' '. + {disableCommandPluginSources:true}'
  [ "$status" -eq 0 ]
}

@test "INV-13 스키마 부재(F75/ES-1): 조용한 통과가 아니라 명시적 skip이다" {
  # 계약 ES-1을 저장소 안에서 고정한다. 구현 시점에는 "완전성 테스트에 주입점을 만들어야
  # 하는데 그 주입점이 곧 검사를 끄는 우회 표면"이라는 이유로 넣지 않았으나, F37 2차 판정이
  # **소스 변경 0으로** 가능함을 실증해 그 전제를 반증했다 — PATH 앞에 `ls` 셰임을 두면
  # 스키마 조회만 빈 결과가 되고 나머지는 실제 ls에 위임된다. 주입점을 만들지 않으므로
  # SC-2가 지키려는 표면도 열지 않는다.
  #
  # 이것이 고정하는 성질: 스키마를 못 찾았을 때 테스트가 **통과로 보고되면 안 된다**.
  # 조용한 통과는 "가드가 스키마를 덮는다"는 거짓 보증이 되고, 그 상태는 정상 통과와
  # 겉보기가 같다(F41이 닫은 fail-open과 같은 계열).
  # 재귀 방지 이중 안전장치. 첫 시도에서 필터 문자열이 이 테스트 이름에도 매치해 중첩 실행이
  # 무한히 자기를 다시 불렀다(2분 타임아웃으로 발견). 이름을 필터와 겹치지 않게 바꾸고,
  # 그것과 별개로 환경변수로도 중첩을 차단한다 — 이름은 나중에 누가 다시 바꿀 수 있다.
  [[ -n "${CC_ES1_NESTED:-}" ]] && skip "중첩 실행 (재귀 방지)"
  command -v bats >/dev/null || skip "중첩 bats 실행 불가"
  local shim; shim=$(mktemp -d) || return 99
  cat > "$shim/ls" <<'SHIM'
#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in *claude-code-settings.schema.json*) exit 1 ;; esac
done
exec /bin/ls "$@"
SHIM
  chmod +x "$shim/ls"
  run env PATH="$shim:$PATH" CC_ES1_NESTED=1 \
    bats --filter 'HOOK_KILL_SWITCHES가 스키마의 hook-affecting boolean' "$BATS_TEST_FILENAME"
  rm -rf "$shim"
  # skip으로 보고되어야 한다 — ok(무조건 통과)도 not ok(실패)도 아니다.
  [[ "$output" == *"# skip"* ]] || {
    echo "스키마 부재 시 명시적 skip이 아니다:" >&2; echo "$output" >&2; return 1; }
}

# ─── F76: 파싱 불가한 배선 파일에서 집행이 사라지던 fail-open ───
#
# `OLD_R` 공집합 게이트가 "배선 없음"과 "파싱 실패"를 구분하지 못해, 디스크의 배선 파일이
# jq로 읽히지 않으면 킬스위치 검사와 배선 보존 검사가 **둘 다** 조용히 건너뛰어졌다.
# 수정 전 실측: 정상 OLD에서 exit 2 로 차단되던 편집이 파싱 불가 OLD에서 전부 exit 0.

# 디스크만 파싱 불가로 만든 배선 파일에 가드를 돌린다.
#   $1 = commit | nocommit — HEAD 기준선 유무. nocommit 은 gitignore 대상이라 HEAD 에 없는
#        `.claude/settings.json` 형태를 재현한다(그 경로가 무기준선 분기가 필요한 이유다).
#   $2 = NEW 내용
#   $3 = (선택) 원본에 적용할 jq 변형. 기본 `.`. **원본 내용을 제어할 수 있어야 '되돌리기'와
#        '새로 켜기'를 구분하는 픽스처를 만들 수 있다** — 재판정 J-1: 이 인자가 없던 시절
#        '수용된 대가' 테스트가 깨진 원본에 스위치를 넣지 못해 입력이 '새로 켜기'였고, 두 경우
#        코드 경로가 같아 단언은 참이지만 판별력이 0이었다(뮤테이션으로 실증됨).
# 저장소 밖에 만든다 — 실 티켓 원장을 오염시키지 않기 위해서(F75 감사 지적).
f76_guard() {   # 대상: settings.json
  local mode="$1" new="$2" orig_jq="${3:-.}" d st
  d=$(mktemp -d) || return 99
  d=$(cd "$d" && pwd -P) || return 99
  git init -q "$d" 2>/dev/null || { rm -rf "$d"; return 99; }
  jq "$orig_jq" settings.json > "$d/settings.json"
  if [[ "$mode" == "commit" ]]; then
    ( cd "$d" && git add settings.json \
      && git -c user.email=t@example.com -c user.name=t commit -qm init ) >/dev/null 2>&1
  fi
  # HEAD 는 정상인 채로 두고 **디스크만** 깨뜨린다 — 이 구분이 이 테스트군의 핵심이다.
  # 깨진 텍스트도 원본($orig_jq 적용본)에서 만든다: 원본에 있던 내용이 깨진 파일 안에도
  # 그대로 보여야 '되돌리기 vs 새로 켜기' 픽스처가 성립한다.
  printf '// breaks jq\n%s' "$(jq "$orig_jq" settings.json)" > "$d/settings.json"
  jq -n --arg f "$d/settings.json" --arg c "$new" \
    '{tool_name:"Write", tool_input:{file_path:$f, content:$c}}' | bash "$GUARD"
  st=$?
  rm -rf "$d"
  return $st
}

@test "INV-13(F76): 파싱 불가 + HEAD 기준선 — 배선 제거를 deny한다" {
  run f76_guard commit "$(mutate_guard_entry '.hooks.PreToolUse |= map(select(
    any(.hooks[]; .command | test("invariant-guard")) | not))')"
  [ "$status" -eq 2 ]
}

@test "INV-13(F76): 파싱 불가 + HEAD 기준선 — 킬스위치 3종 모두 deny한다" {
  # 계약 AC-6이 3종을 열거한다. 1종만 고정하면 나머지 둘이 조용히 빠져도 아무도 모른다
  # (1차 판정 지적).
  for sw in disableAllHooks allowManagedHooksOnly disableCommandPluginSources; do
    run f76_guard commit "$(mutate_guard_entry ". + {$sw:true}")"
    [ "$status" -eq 2 ] || { echo "$sw 가 deny되지 않았다 (exit=$status)" >&2; return 1; }
    [[ "$output" == *"최상위 $sw 켜짐"* ]] \
      || { echo "$sw 의 deny 사유가 이 스위치를 지목하지 않는다: $output" >&2; return 1; }
  done
}

@test "INV-13(F76): 파싱 불가 + HEAD 기준선 — 배선 보존한 복구 편집은 통과시킨다" {
  # 사용자가 깨진 파일을 고칠 수 있어야 한다. 이걸 막으면 가두는 것이다.
  run f76_guard commit "$(cat settings.json)"
  [ "$status" -eq 0 ]
}

@test "INV-13(F76): 무기준선 — 킬스위치 3종 모두 기준선 없이도 deny한다" {
  # OLD 값을 알 수 없어도 'NEW 가 켜져 있다'는 기준선 없이 판정 가능한 축이다.
  for sw in disableAllHooks allowManagedHooksOnly disableCommandPluginSources; do
    run f76_guard nocommit "$(mutate_guard_entry ". + {$sw:true}")"
    [ "$status" -eq 2 ] || { echo "$sw 가 deny되지 않았다 (exit=$status)" >&2; return 1; }
  done
}

@test "INV-13(F76): 무기준선 — 켜져 있던 스위치를 되돌리는 복구도 막힌다 (수용된 대가)" {
  # **이것은 회귀이고, 수용된 것이다.** 기준선이 없으면 '되돌리기'와 '새로 켜기'를 신뢰할 수
  # 있게 구분할 수 없어 fail-closed를 택했다. 그 결과 원래 킬스위치가 켜져 있던 파일을 그
  # 내용 그대로 복구하는 편집도 exit 2 로 막힌다(F76 이전에는 통과했다). 사람이 직접 고쳐야 한다.
  #
  # **픽스처가 진짜 '되돌리기'여야 한다 (재판정 J-1).** 이전 버전은 깨진 원본에 스위치를 넣지
  # 않아 입력이 '새로 켜기'였고, 두 경우 코드 경로가 같아 단언은 참이지만 판별력이 0이었다 —
  # 대가를 무너뜨리는 휴리스틱("깨진 원본 텍스트에 이미 보이는 스위치는 허용")을 주입해도
  # 초록이었다. 이제 원본에 스위치를 켜 두고 NEW 는 그 원본의 복구본이라, 그 휴리스틱이
  # 들어오면 이 테스트가 exit 0 으로 무너져 잡힌다.
  local orig='. + {disableAllHooks:true}'
  run f76_guard nocommit "$(mutate_guard_entry "$orig")" "$orig"
  [ "$status" -eq 2 ]
  [[ "$output" == *"이전 값을 확인할 수 없습니다"* ]]
}

@test "INV-13(F76): 무기준선 — 복구 편집은 통과하되 검사 불가를 경고로 남긴다" {
  # 통과시키되 조용히 넘기지 않는다. 경고가 없으면 '검사했고 문제없음'과 '검사하지 못했음'이
  # 구분되지 않으며, 그 구분 불가가 바로 F76이 닫은 결함이다.
  run f76_guard nocommit "$(cat settings.json)"
  [ "$status" -eq 0 ]
  [[ "$output" == *"배선 보존 검사를 수행하지 못했습니다"* ]]
}

@test "INV-13(F76): 파싱 가능하지만 배선이 없는 파일의 면제는 유지된다" {
  # 이 수정이 '배선 없음' 면제를 없애면 과잉차단 회귀다 — INV-13이 명시한 유일한 면제 대상.
  run fixture_guard 'del(.hooks) | . + {env:{FOO:"bar"}}' '. + {disableAllHooks:true}'
  [ "$status" -eq 0 ]
}

@test "INV-13(F76): hooks.json 브랜치도 같은 클래스로 닫혔다" {
  # settings.json 만 고치면 '인스턴스만 닫고 클래스를 여는' 패턴이 된다(INV-13 본문).
  local d st
  d=$(mktemp -d) || return 99
  d=$(cd "$d" && pwd -P) || return 99
  git init -q "$d" 2>/dev/null || { rm -rf "$d"; return 99; }
  mkdir -p "$d/hooks"
  jq '.' "$PLUGIN_WIRING" > "$d/hooks/hooks.json"
  ( cd "$d" && git add hooks/hooks.json \
    && git -c user.email=t@example.com -c user.name=t commit -qm init ) >/dev/null 2>&1
  printf '// breaks jq\n%s' "$(jq '.' "$PLUGIN_WIRING")" > "$d/hooks/hooks.json"
  local stripped
  stripped=$(jq '.hooks.PreToolUse |= map(select(
    any(.hooks[]; .command | test("invariant-guard")) | not))' "$PLUGIN_WIRING")
  run bash -c 'jq -n --arg f "$1" --arg c "$2" "{tool_name:\"Write\", tool_input:{file_path:\$f, content:\$c}}" | bash "$3"' \
    _ "$d/hooks/hooks.json" "$stripped" "$GUARD"
  rm -rf "$d"
  [ "$status" -eq 2 ]
}

@test "INV-13(F76): 선두가 온전한 손상은 배선을 여전히 읽어 집행한다 (보안 감사 high 회귀)" {
  # **F76이 스스로 만든 약화를 고정한다.** 게이트를 `wired_rows` 결과에서 `jq -e '.'` 성공으로
  # 바꾸자, jq가 선두 값을 내보낸 뒤 오류를 내는 손상 형태(잘린 append·잉여 중괄호·뒤 잡문자열)
  # 에서 배선이 버려지고 무기준선 갈래로 떨어졌다 — 실측 exit 2 → exit 0. append 계열은 이
  # 기능이 근거로 든 '손편집 중 실수'에 그대로 해당한다. 게이트를 '배선 추출 가능'으로 낮춰
  # F76 이전과 같은 판정 재료를 쓰게 했고, 이 테스트가 그 복귀를 고정한다.
  local base stripped d st
  base=$(jq '.' settings.json)
  stripped=$(jq '.hooks.PreToolUse |= map(select(
    any(.hooks[]; .command | test("invariant-guard")) | not))' settings.json)
  local shape
  for shape in 'printf "%s\n{\"a\":" "$base"' 'printf "%s}" "$base"' 'printf "%s\nGARBAGE" "$base"'; do
    d=$(mktemp -d) || return 99
    d=$(cd "$d" && pwd -P) || return 99
    git init -q "$d" 2>/dev/null || { rm -rf "$d"; return 99; }
    eval "$shape" > "$d/settings.json"      # HEAD 기준선 없음 — 배선 추출만이 유일한 근거다
    # `|| st=$?` 없이 파이프라인을 그냥 두면 bats 가 비영 종료를 즉시 테스트 실패로 처리해,
    # **가드가 올바르게 deny 한 것이 테스트 실패로 보고된다**(실제로 겪었다).
    st=0
    jq -n --arg f "$d/settings.json" --arg c "$stripped" \
      '{tool_name:"Write", tool_input:{file_path:$f, content:$c}}' \
      | bash "$GUARD" >/dev/null 2>&1 || st=$?
    rm -rf "$d"
    [ "$st" -eq 2 ] || { echo "손상 형태 [$shape] 에서 배선 제거가 통과했다 (exit=$st)" >&2; return 1; }
  done
}

@test "INV-13(F76): 선두가 온전한 손상에서도 킬스위치 켜기를 deny한다 (재판정 지적)" {
  # **배선 축만 고정했더니 킬스위치 축에서 같은 no-op이 되살아났다.** 손상 원문을 그대로
  # 기준선으로 삼자 비교기가 `jq -c '.[k] // false'` 로 그것을 읽었고, jq 가 선두 값을 내보낸 뒤
  # 오류를 내면서 `|| echo false` 가 한 줄을 더 붙여 `false\nfalse` 가 됐다. 그러면 off 가 on 으로
  # 오독돼 off→on deny 가 발화하지 않고, kind=disk 라 무기준선 경고도 나오지 않는다 —
  # exit 0 에 무경고, 이 기능이 존재하는 이유인 "검사했고 문제없음과 겉보기가 같다"가 그대로
  # 재현됐다. 794건이 초록인 채로 살아 있었던 이유는 회귀 테스트가 배선 축만 봤기 때문이다.
  local base d st shape sw
  base=$(jq '.' settings.json)
  for shape in 'printf "%s\n{\"a\":" "$base"' 'printf "%s}" "$base"' 'printf "%s\nGARBAGE" "$base"'; do
    for sw in disableAllHooks allowManagedHooksOnly disableCommandPluginSources; do
      d=$(mktemp -d) || return 99
      d=$(cd "$d" && pwd -P) || return 99
      git init -q "$d" 2>/dev/null || { rm -rf "$d"; return 99; }
      eval "$shape" > "$d/settings.json"
      st=0
      jq -n --arg f "$d/settings.json" --arg c "$(jq ". + {$sw:true}" settings.json)" \
        '{tool_name:"Write", tool_input:{file_path:$f, content:$c}}' \
        | bash "$GUARD" >/dev/null 2>&1 || st=$?
      rm -rf "$d"
      [ "$st" -eq 2 ] || {
        echo "손상 [$shape] + $sw 켜기가 통과했다 (exit=$st)" >&2; return 1; }
    done
  done
}

@test "INV-13(F76): 다중 문서 settings.json 은 OLD·NEW 어느 쪽에서도 통하지 않는다" {
  # **회귀 테스트가 매번 한 축만 고정해 결함이 옆 축에서 살아남았다** — 처음엔 배선 축만,
  # 다음엔 디스크(OLD) 축만. 그래서 여기서는 손상 형태를 OLD 와 NEW **양쪽에** 건다.
  #
  # 다중 문서(`{...}{...}`)는 jq 가 값 스트림 파서라 `jq -e '.'` 를 통과하지만 JSON.parse 로는
  # 파싱되지 않는다 — 쓰이는 순간 settings.json 이 소비자에게 파싱 불가가 되고 배선된 훅 전부가
  # 실행 도달성을 잃는다. 종전에는 비교기가 문서마다 한 줄씩 뱉는 부작용으로 **우연히** 막혔고,
  # 선두 문서 정규화가 그 우연을 걷어내자 열렸다(재판정 실측 exit 2 → exit 0).
  #
  # OLD 축은 별개의 공격이다: 디스크가 `{"disableAllHooks":true}\n<정상>` 이면 배선은 두 번째
  # 문서에서 뽑혀 kind=disk 가 되고, 선두만 읽는 비교기가 `__o=true` 를 얻어 off→on 이 성립하지
  # 않아 스위치를 켜는 편집이 통과했다(pre-F76·직전 리비전 모두 exit 0).
  local base multi attack d st
  base=$(jq -c '.' settings.json)
  multi=$(printf '%s\n{}' "$base")
  attack=$(printf '{"disableAllHooks":true}\n%s' "$base")

  # NEW 축 — 정상 디스크에 다중 문서를 쓰려는 편집
  d=$(mktemp -d) || return 99; d=$(cd "$d" && pwd -P) || return 99
  git init -q "$d" 2>/dev/null || { rm -rf "$d"; return 99; }
  printf '%s' "$base" > "$d/settings.json"
  st=0
  jq -n --arg f "$d/settings.json" --arg c "$multi" \
    '{tool_name:"Write", tool_input:{file_path:$f, content:$c}}' | bash "$GUARD" >/dev/null 2>&1 || st=$?
  rm -rf "$d"
  [ "$st" -eq 2 ] || { echo "다중 문서 NEW 가 통과했다 (exit=$st)" >&2; return 1; }

  # OLD 축 — 선두 문서를 조작해 킬스위치 비교기를 속이는 경로
  d=$(mktemp -d) || return 99; d=$(cd "$d" && pwd -P) || return 99
  git init -q "$d" 2>/dev/null || { rm -rf "$d"; return 99; }
  printf '%s' "$attack" > "$d/settings.json"
  st=0
  jq -n --arg f "$d/settings.json" --arg c "$(jq -c '. + {disableAllHooks:true}' settings.json)" \
    '{tool_name:"Write", tool_input:{file_path:$f, content:$c}}' | bash "$GUARD" >/dev/null 2>&1 || st=$?
  rm -rf "$d"
  [ "$st" -eq 2 ] || { echo "선두 조작으로 킬스위치 켜기가 통과했다 (exit=$st)" >&2; return 1; }
}

@test "INV-13(F76): 다중 문서에 켜져 있던 스위치를 유지하는 편집은 막힌다 (수용된 새 비용)" {
  # 단일 문서 요구가 만든 비용을 고정한다. 디스크가 다중 문서이고 그중 킬스위치가 정당하게
  # 켜져 있어도, `__switch_val` 이 다중 문서를 신뢰하지 않아 `__o=false` 가 되므로 스위치를
  # 유지하는 편집이 off→on 으로 판정돼 막힌다. 승인 프롬프트는 없다(exit 2).
  #
  # 이 테스트가 있는 이유: INV-13 이 이 비용을 서술하는데 고정하는 것이 없으면, 나중에 동작이
  # 바뀌어도 문서만 남아 어긋난다 — 이 기능이 일곱 번 반복한 결함 클래스가 정확히 그것이다.
  local base d st
  base=$(jq -c '.' settings.json)
  d=$(mktemp -d) || return 99; d=$(cd "$d" && pwd -P) || return 99
  git init -q "$d" 2>/dev/null || { rm -rf "$d"; return 99; }
  printf '{"disableAllHooks":true}\n%s' "$base" > "$d/settings.json"
  st=0
  jq -n --arg f "$d/settings.json" --arg c "$(jq -c '. + {disableAllHooks:true}' settings.json)" \
    '{tool_name:"Write", tool_input:{file_path:$f, content:$c}}' | bash "$GUARD" >/dev/null 2>&1 || st=$?
  rm -rf "$d"
  [ "$st" -eq 2 ] || { echo "다중 문서에서 스위치 유지 편집이 통과했다 (exit=$st)" >&2; return 1; }

  # 문서가 적은 우회 경로가 실제로 열려 있는지도 함께 고정한다 — 스위치 없이 단일 문서로
  # 고쳐 쓰는 편집은 통과해야 한다. 그러지 않으면 사용자가 가둬진다.
  d=$(mktemp -d) || return 99; d=$(cd "$d" && pwd -P) || return 99
  git init -q "$d" 2>/dev/null || { rm -rf "$d"; return 99; }
  printf '{"disableAllHooks":true}\n%s' "$base" > "$d/settings.json"
  st=0
  jq -n --arg f "$d/settings.json" --arg c "$base" \
    '{tool_name:"Write", tool_input:{file_path:$f, content:$c}}' | bash "$GUARD" >/dev/null 2>&1 || st=$?
  rm -rf "$d"
  [ "$st" -eq 0 ] || { echo "우회 경로(스위치 없이 단일 문서로 복구)가 막혔다 (exit=$st)" >&2; return 1; }
}

@test "INV-13(F76): 선두가 온전해도 문서 전체가 손상되면 킬스위치 켜기를 deny한다 (6차 판정 반례)" {
  # **"선두가 온전하면 몇째 줄인지 단정할 수 있다"는 가정이 틀렸다는 것을 고정한다.**
  # `{sw:true}\n<정상settings>\nGARBAGE` 는 선두 문서가 완전하지만 스트림 전체는 `jq -e '.'`
  # 를 통과하지 못한다(모든 문서가 유효해야 하므로) — 그래서 "구조적으로 둘째 줄일 수 없다"던
  # 단정이 틀렸고, 이 픽스처가 정확히 둘째 줄로 간다. `__switch_val`의 단일 문서 요구(d05d778)가
  # 이미 이 입력을 막고 있었다 — 실측: `7807135`(그 이전)는 exit 0, `d05d778`와 현재는 exit 2.
  # 즉 여기서 고친 것은 코드가 아니라 "구조적으로 불가능하다"던 문서의 단정이며, 이 테스트는
  # 그 단정이 다시 코드보다 강하게(또는 틀리게) 서술되는 회귀를 잡는다.
  local base d st
  base=$(jq -c '.' settings.json)
  d=$(mktemp -d) || return 99; d=$(cd "$d" && pwd -P) || return 99
  git init -q "$d" 2>/dev/null || { rm -rf "$d"; return 99; }
  printf '{"disableAllHooks":true}\n%s\nGARBAGE' "$base" > "$d/settings.json"
  st=0
  jq -n --arg f "$d/settings.json" --arg c "$(jq -c '. + {disableAllHooks:true}' settings.json)" \
    '{tool_name:"Write", tool_input:{file_path:$f, content:$c}}' | bash "$GUARD" >/dev/null 2>&1 || st=$?
  rm -rf "$d"
  [ "$st" -eq 2 ] || { echo "선두 온전 + 전체 손상 입력에서 킬스위치 켜기가 통과했다 (exit=$st)" >&2; return 1; }
}

@test "INV-13(F76): 문서의 갈래 표와 가드의 실제 분기 순서가 일치한다" {
  # 표에 행이 추가되면서(7807135) 뒤이은 산문의 서수 참조("세 번째 줄"·"두 번째 갈래")가
  # 갱신되지 않아 6·7차 판정이 반려됐다 — 7차는 문서가 같은 사실을 450행 "세 번째 줄", 461행
  # "두 번째 줄"로 **자기모순**되게 적은 경우였다. 매번 사람이 전문을 다시 훑어 잡았는데, 그
  # 스윕에는 종료 조건이 없다(7차 판정 지적).
  #
  # 이 테스트는 표 자체(기준선 열)의 행 순서가 코드의 분기 순서와 어긋나는 것만 기계로 잡는다.
  # **8차 판정이 실측으로 확인한 한계**: 이 테스트를 그 반려들이 실제로 일어났던 문서
  # 스냅샷(d05d778·ecb5b21·dea7ee0, 모두 위 자기모순 문장을 담고 있었다)에 돌려도 **셋 다
  # 통과한다** — 표 자체는 그때도 올바른 순서였고, 틀린 것은 표 밖 산문의 서수 참조였기
  # 때문이다. 즉 이 테스트는 6·7차가 실제로 겪은 결함 형태를 잡지 못하며, "표 행이 추가됐는데
  # 코드 분기 순서가 안 따라가는" 다른(아직 발생한 적 없는) 결함 형태만 잡는다. 산문 속 개별
  # 서수 참조 하나하나를 표와 대조하는 것은 이 테스트의 범위 밖이며, SC-4의 "전문을 읽고
  # 상충 구절이 없는지 확인"은 이 테스트로 대체되지 않고 여전히 사람의 통독을 요구한다.
  local doc="docs/INVARIANTS.md"
  [ -f "$doc" ] || return 99

  # 표에서 "디스크 파싱"(2번째)·"기준선"(4번째) 두 열을 함께 뽑는다. 헤더 구분선(---)은 제외.
  # **"기준선" 한 열만 보면 안 된다** — 1·2행은 그 값이 둘 다 "디스크 내용"이라 두 행을 서로
  # 바꿔도 통과한다(8차 판정 실측 지적). 두 행은 "디스크 파싱" 열(OK/실패)에서만 갈린다.
  # 행 수도 상한을 두지 않는다 — `n<=4` 로 잘랐던 이전 버전은 표에 다섯째 행이 추가돼도 보지
  # 못했다(같은 지적). 상한 없이 전부 모으면 기대 문자열(4줄)과 줄 수부터 달라져 잡힌다.
  local rows
  rows=$(awk '
    /^\| 디스크 파싱 \| 배선 추출 \| HEAD 기준선 \| 기준선 \| 검사 범위 \|$/ { found=1; next }
    found && /^\|---/ { next }
    found && /^\|/ {
      split($0,a,"|")
      gsub(/^[ \t]+|[ \t]+$/,"",a[2]); gsub(/^[ \t]+|[ \t]+$/,"",a[5])
      print a[2] "|" a[5]
    }
    found && !/^\|/ { exit }
  ' "$doc")
  local expect=$'OK|디스크 내용\n실패|디스크 내용\n실패|HEAD 내용\n실패|없음'
  [ "$rows" = "$expect" ] || {
    echo "표의 행 순서/개수가 기대와 다르다:" >&2; echo "$rows" >&2; return 1; }

  # 이제 코드가 실제로 그 네 순서를 만드는지 각 대표 입력으로 계측한다.
  local base d
  base=$(jq -c '.' settings.json)
  local instr; instr=$(mktemp)
  sed 's|^  __wiring_baseline_for "\$FILE"$|  __wiring_baseline_for "$FILE"; echo "ARM=$__baseline_kind" >\&2|' \
    "$GUARD" > "$instr"

  arm_of() {   # $1 = 디스크에 쓸 내용
    local dd; dd=$(mktemp -d); dd=$(cd "$dd" && pwd -P)
    if [ "$2" = "commit" ]; then
      git init -q "$dd" 2>/dev/null
      printf '%s' "$base" > "$dd/settings.json"
      ( cd "$dd" && git add -A && git -c user.email=t@t -c user.name=t commit -qm b ) >/dev/null 2>&1
    else
      git init -q "$dd" 2>/dev/null
    fi
    printf '%s' "$1" > "$dd/settings.json"
    jq -n --arg f "$dd/settings.json" --arg c "$base" \
      '{tool_name:"Write", tool_input:{file_path:$f, content:$c}}' \
      | bash "$instr" 2>&1 >/dev/null | grep -o 'ARM=[a-z]*' | head -1
    rm -rf "$dd"
  }

  local f1="$base" f2 f3 f4
  f2=$(printf '%s\nGARBAGE' "$base")
  f3=$(printf '// c\n%s' "$base")
  f4="$f3"

  local a1 a2 a3 a4
  a1=$(arm_of "$f1" nocommit)   # 행1: 파싱 OK
  a2=$(arm_of "$f2" nocommit)   # 행2: 파싱 실패, 배선 추출 가능
  a3=$(arm_of "$f3" commit)     # 행3: 파싱 실패, HEAD 기준선 있음
  a4=$(arm_of "$f4" nocommit)   # 행4: 파싱 실패, 기준선 없음
  rm -f "$instr"

  local got=$'ARM=disk\nARM=disk\nARM=head\nARM=none'
  local actual="$a1"$'\n'"$a2"$'\n'"$a3"$'\n'"$a4"
  [ "$actual" = "$got" ] || {
    echo "가드의 실제 분기 순서가 기대와 다르다 (disk,disk,head,none 이어야 함):" >&2
    echo "$actual" >&2; return 1; }

  # `ARM=disk`가 1·2행 공통이라 그 라벨만으로는 서로 못 갈랐던 것과 같은 이유로, 여기서도
  # 각 픽스처가 표의 "디스크 파싱" 열(OK/실패)과 실제로 일치하는지 jq로 직접 확인한다.
  echo -n "$f1" | jq -e '.' >/dev/null 2>&1 \
    || { echo "행1 픽스처가 실제로는 파싱 실패다" >&2; return 1; }
  echo -n "$f2" | jq -e '.' >/dev/null 2>&1 \
    && { echo "행2 픽스처가 실제로는 파싱 성공이다(GARBAGE가 붙었는데도)" >&2; return 1; }
  true
}

@test "INV-13 완전성: HOOK_KILL_SWITCHES가 스키마의 hook-affecting boolean을 전부 덮는다" {
  # 인스턴스 열거가 아니라 클래스 봉쇄의 핵심 — 가드의 하드코딩 목록이 공식 스키마의
  # 'hook 실행에 영향을 주는 최상위 boolean' 전체와 일치해야 한다. 새 스위치가 스키마에
  # 추가되면 이 테스트가 실패해 등록을 강제한다(F52 4차 evaluator). 스키마 파일이 없는
  # 환경(CI 등)에서는 skip — 단, 조용한 통과가 아니라 명시적 skip.
  SCHEMA=$(ls /Users/*/.vscode*/extensions/anthropic.claude-code-*/claude-code-settings.schema.json 2>/dev/null | sort -V | tail -1)
  [ -n "$SCHEMA" ] && [ -f "$SCHEMA" ] || skip "claude-code settings 스키마 없음 — 완전성 검사 skip"

  # 스키마에서 description에 'hook'을 언급하는 최상위 boolean = hook 실행 영향 스위치
  SCHEMA_SET=$(jq -r '.properties | to_entries[]
    | select(.value.type=="boolean")
    | select((.value.description // "") | test("hook"; "i"))
    | .key' "$SCHEMA" 2>/dev/null | sort)

  # 가드의 하드코딩 목록
  GUARD_SET=$(grep -oE 'HOOK_KILL_SWITCHES="[^"]*"' "$GUARD" | sed -E 's/.*="([^"]*)"/\1/' | tr ' ' '\n' | sort)

  # 스키마의 각 스위치가 가드 목록에 있어야 한다 (가드가 스키마를 덮는가)
  MISSING=""
  while read -r sw; do
    [ -z "$sw" ] && continue
    grep -qxF "$sw" <<<"$GUARD_SET" || MISSING="$MISSING $sw"
  done <<< "$SCHEMA_SET"
  if [ -n "$MISSING" ]; then
    echo "스키마에 hook-affecting boolean이 추가됐으나 HOOK_KILL_SWITCHES에 미등록:$MISSING" >&2
    echo "invariant-guard.sh의 HOOK_KILL_SWITCHES에 추가하고 문서레벨 deny 테스트를 더하세요." >&2
    return 1
  fi
}
