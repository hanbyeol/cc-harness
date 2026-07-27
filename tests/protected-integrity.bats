#!/usr/bin/env bats
#
# protected-integrity.sh — 탐지·복구 (F65)
#
# 이 파일이 잠그는 것은 하나다: **보호 파일이 Bash 경로로 바뀌면 되돌아온다.**
# 어떤 도구로 어떻게 바꿨는지는 묻지 않는다 — 그것을 묻는 것이 F63의 실패 원인이었다.
#
# 그래서 케이스를 "우회 형태 목록"으로 늘리지 않는다. 대신 **판정 계층이 서로 다른 결론을
# 내는 형태**를 골라 둔다: 방화벽이 allow 하는 것과 ask 하는 것을 섞어, 탐지가 방화벽의
# 판정과 무관하게 동작함을 보인다.

setup() {
  LAB="$(mktemp -d)"
  git -C "$BATS_TEST_DIRNAME/.." archive HEAD 2>/dev/null | tar -x -C "$LAB"
  cp "$BATS_TEST_DIRNAME/../hooks/protected-integrity.sh" "$LAB/hooks/"
  cd "$LAB" || return 1
  git init -q .
  git add -A
  git -c user.email=t@t -c user.name=t commit -qm base
}

teardown() {
  cd /
  [ -n "${LAB:-}" ] && rm -rf "$LAB"
}

integrity() { ( cd "$LAB" && CLAUDE_PROJECT_DIR="$LAB" bash hooks/protected-integrity.sh ) }
dirty()     { ( cd "$LAB" && git diff --name-only | wc -l | tr -d ' ' ) }

@test "F65: 리다이렉트로 훼손된 훅이 복구된다" {
  ( cd "$LAB" && printf 'PWNED\n' > hooks/lib.sh )
  [ "$(dirty)" -gt 0 ]
  integrity
  [ "$(dirty)" -eq 0 ]
}

@test "F65: 방화벽이 allow 하는 표기(부분 인용·백슬래시·경로 정규화)도 복구된다" {
  # F64로 등록한 우회들 — 예측 계층은 이 표기를 보호 경로로 인식하지 못한다.
  for form in "hooks/'lib'.sh" 'hooks/lib\.sh' 'hooks//lib.sh' 'hooks/./lib.sh'; do
    ( cd "$LAB" && git checkout -q -- . && eval "printf 'PWNED\n' > $form" )
    [ "$(dirty)" -gt 0 ]
    integrity
    [ "$(dirty)" -eq 0 ]
  done
}

@test "F65: 경로가 명령행에 없는 형태(스크립트 파일 경유)도 복구된다" {
  ( cd "$LAB" && printf 'open("tests/probes.bats","w").write("x")\n' > w.py && python3 w.py && rm -f w.py )
  [ "$(dirty)" -gt 0 ]
  integrity
  [ "$(dirty)" -eq 0 ]
}

@test "F65: 임계값 하향이 복구된다 (INV-3와 같은 대상)" {
  ( cd "$LAB" && printf '{"pass_threshold":1}\n' > progress/harness-config.json )
  integrity
  ( cd "$LAB" && grep -q '"pass_threshold": *7' progress/harness-config.json )
}

@test "F65: invariant-guard를 거친 편집은 보존된다 (오탐 없음)" {
  ( cd "$LAB" && printf '\n# legit\n' >> hooks/lib.sh && echo "hooks/lib.sh" > progress/.guarded-edits )
  integrity
  ( cd "$LAB" && grep -q 'legit' hooks/lib.sh )
}

@test "F65: git checkout으로 HEAD가 함께 움직이면 오탐하지 않는다" {
  ( cd "$LAB" && git checkout -qb other && printf '\n# branch\n' >> hooks/lib.sh \
      && git add -A && git -c user.email=t@t -c user.name=t commit -qm other )
  integrity
  ( cd "$LAB" && grep -q 'branch' hooks/lib.sh )
}

@test "F65: 복구 사실을 조용히 넘기지 않는다" {
  ( cd "$LAB" && printf 'PWNED\n' > hooks/lib.sh )
  run integrity
  [[ "$output" == *"복구"* ]]
  [[ "$output" == *"hooks/lib.sh"* ]]
}

@test "F65: 훅이 hooks.json과 settings.json 양쪽에 배선돼 있다" {
  # 배선이 빠지면 방화벽의 데이터 플레인 게이트가 fail-safe로 다시 켜지지만,
  # 두 설치 경로 중 하나만 배선되면 그 경로의 프로젝트에서 탐지가 동작하지 않는다(F52 대칭).
  run jq -e '.hooks.PostToolUse[] | select((.matcher // "") | test("Bash"))
               | .hooks[] | select(.command | contains("protected-integrity.sh"))' \
      "$BATS_TEST_DIRNAME/../hooks/hooks.json"
  [ "$status" -eq 0 ]
  run jq -e '.hooks.PostToolUse[] | select((.matcher // "") | test("Bash"))
               | .hooks[] | select(.command | contains("protected-integrity.sh"))' \
      "$BATS_TEST_DIRNAME/../settings.json"
  [ "$status" -eq 0 ]
}

@test "F65: 방화벽의 데이터 플레인 게이트는 배선이 없으면 켜진 상태로 남는다 (fail-safe)" {
  # 탐지가 없는데 예측까지 끄면 보호가 사라진다. 배선 확인 실패 시 게이트가 유지돼야 한다.
  local fw="$BATS_TEST_DIRNAME/../hooks/pre-bash-firewall.sh"
  grep -q 'DATA_PLANE_DETECTED=1' "$fw"
  grep -q 'integrity_wired && DATA_PLANE_DETECTED=0' "$fw"
}

@test "F65: 탐지 대상 목록이 방화벽의 데이터 플레인 경로와 어긋나지 않는다" {
  # 두 파일이 같은 집합을 가리켜야 한다 — 한쪽만 늘면 그 경로는 예측도 탐지도 없이 남는다.
  local ig="$BATS_TEST_DIRNAME/../hooks/protected-integrity.sh"
  local fw="$BATS_TEST_DIRNAME/../hooks/pre-bash-firewall.sh"
  for token in 'harness-config' 'feature_list' 'INVARIANTS' 'hooks/\*.sh' 'tests/\*.bats'; do
    grep -q "$token" "$ig"
  done
  # 방화벽 쪽에도 같은 계열이 데이터 플레인 arm으로 존재해야 한다
  grep -q 'harness-config\\.json' "$fw"
  grep -q 'feature_list\\.json' "$fw"
}
