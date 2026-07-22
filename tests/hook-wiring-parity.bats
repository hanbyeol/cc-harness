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
