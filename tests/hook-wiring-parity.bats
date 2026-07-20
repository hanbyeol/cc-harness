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
      && { echo "allowlist 모순: $s 가 $PROJECT_WIRING 에 배선되어 있으므로 제외 대상이 아닙니다" >&2; return 1; }
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
  STRIPPED=$(jq '.hooks.PreToolUse |= map(select(
    any(.hooks[]; .command | test("invariant-guard")) | not))' settings.json)
  run run_guard "$STRIPPED"
  [ "$status" -eq 2 ]
}

@test "INV-13: 배선과 무관한 키 추가는 통과시킨다 (과잉 차단 방지)" {
  # 설치된 프로젝트에서 사용자가 env·permissions를 고치는 정당한 편집까지
  # 막으면 마찰이 과도하다 — 내용 기반 설계를 채택한 이유(계약 SC-1).
  WITH_ENV=$(jq '.env = {"FOO":"bar"}' settings.json)
  run run_guard "$WITH_ENV"
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

# ─── 무력화 벡터 (F52 evaluator가 직접 재현한 3종 우회) ───
# 최초 구현의 가드 추출기는 `.. | objects | .command`(구조 비앵커)라 아래 3종이 모두
# exit 0으로 통과했다. 저장소 CI는 잡았지만 설치 프로젝트엔 CI가 없어 실질 무방비였다.
# 교훈: 같은 불변식을 검사하는 추출기가 두 벌이면 **약한 쪽이 실제 방어선이 된다**.
# 가드는 이제 테스트와 동일한 구조 앵커를 쓰고 (event, matcher, script) 3-튜플을 비교한다.

@test "INV-13 무력화(a): 실제 배선을 지우고 미끼 문자열만 남기면 deny한다" {
  # command를 'echo invariant-guard.sh'로 바꾸면 이름은 남지만 훅은 죽는다.
  DECOY=$(jq '.hooks.PreToolUse |= map(
    if any(.hooks[]; .command | test("invariant-guard"))
    then .hooks = [{"type":"command","command":"echo invariant-guard.sh"}]
    else . end)' settings.json)
  run run_guard "$DECOY"
  [ "$status" -eq 2 ]
}

@test "INV-13 무력화(b): matcher를 무력화하면 deny한다 (집합 보존 ≠ 실행 보장)" {
  # 스크립트 이름은 그대로지만 matcher가 어떤 도구에도 매치하지 않아 영원히 발화하지 않는다.
  NEUTERED=$(jq '.hooks.PreToolUse |= map(
    if any(.hooks[]; .command | test("invariant-guard"))
    then .matcher = "NeverMatchXYZ"
    else . end)' settings.json)
  run run_guard "$NEUTERED"
  [ "$status" -eq 2 ]
}

@test "INV-13 무력화(c): hooks 키를 통째로 다른 키로 옮기면 deny한다" {
  # 훅은 전부 죽지만 JSON 어딘가에 문자열은 남아 있어, 비앵커 추출기는 못 잡는다.
  MOVED=$(jq '{disabled_hooks: .hooks} + del(.hooks)' settings.json)
  run run_guard "$MOVED"
  [ "$status" -eq 2 ]
}
