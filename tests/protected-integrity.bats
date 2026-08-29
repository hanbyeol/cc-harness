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
  cp "$BATS_TEST_DIRNAME/../hooks/protected-integrity.sh" "$BATS_TEST_DIRNAME/../hooks/invariant-guard.sh" "$LAB/hooks/"
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

@test "F65: 리다이렉트로 훼손된 검증 파일이 복구된다" {
  ( cd "$LAB" && printf 'PWNED\n' > tests/probes.bats )
  [ "$(dirty)" -gt 0 ]
  integrity
  [ "$(dirty)" -eq 0 ]
}

@test "F65: 방화벽이 allow 하는 표기(부분 인용·백슬래시·경로 정규화)도 복구된다" {
  # F64로 등록한 우회들 — 예측 계층은 이 표기를 보호 경로로 인식하지 못한다.
  for form in "tests/'probes'.bats" 'tests/probes\.bats' 'tests//probes.bats' 'tests/./probes.bats'; do
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
  # 티켓 형식은 `<내용해시> <경로>` 다(F65 SC-5) — 경로만 적으면 어떤 편집과도 일치하지 않는다.
  # F67 전에는 hooks/lib.sh 가 PROTECTED_GLOBS 밖이라 검사 자체를 받지 않아 이 낡은 형식으로도
  # 통과했다. 면제 arm 이 덮는 훅 전체를 탐지 대상에 넣으면서 드러났다.
  # 해시는 훅의 file_sha() 와 같은 방식으로 계산해야 한다 — `$(cat …)` 가 후행 개행을 떨어뜨리므로
  # `git hash-object <파일>` 과 값이 다르다.
  ( cd "$LAB" && printf '\n# legit\n' >> hooks/lib.sh && \
    printf '%s hooks/lib.sh\n' "$(printf '%s' "$(cat hooks/lib.sh)" | git hash-object --stdin)" \
      > progress/.guarded-edits )
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
  ( cd "$LAB" && printf 'PWNED\n' > tests/probes.bats )
  run integrity
  [[ "$output" == *"복구"* ]]
  [[ "$output" == *"tests/probes.bats"* ]]
  [[ "$output" == *"보관"* ]]
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
  for token in 'harness-config' 'feature_list' 'INVARIANTS' 'tests/\*.bats' 'skills/improve'; do
    grep -q "$token" "$ig"
  done
  # 방화벽 쪽에도 같은 계열이 데이터 플레인 arm으로 존재해야 한다
  grep -q 'harness-config\\.json' "$fw"
  grep -q 'feature_list\\.json' "$fw"
}

# --- 1차 판정 반영: 탐지기 자신의 위협 모델 ---

@test "F65: 복구는 되돌릴 내용을 격리 보관한다 (손실 0)" {
  # 첫 구현은 무조건 git checkout 이라 git stash pop 으로 되살린 작업을 비가역으로 지웠다.
  ( cd "$LAB" && printf 'WORK\n' > progress/harness-config.json )
  integrity
  local kept
  kept=$(find "$LAB/progress/.integrity-quarantine" -name 'harness-config.json' 2>/dev/null | head -1)
  [ -n "$kept" ]
  grep -q 'WORK' "$kept"
}

@test "F65: git 작업 진행 중에는 복구하지 않고 보고만 한다" {
  ( cd "$LAB" && printf 'MERGE-WORK\n' > progress/harness-config.json \
      && touch "$(git rev-parse --git-dir)/MERGE_HEAD" )
  run integrity
  [[ "$output" == *"복구하지 않고"* ]]
  ( cd "$LAB" && grep -q 'MERGE-WORK' progress/harness-config.json )
  ( cd "$LAB" && rm -f "$(git rev-parse --git-dir)/MERGE_HEAD" )
}

@test "F65: 티켓은 내용에 묶이고 정착할 때 소비된다" {
  # 경로만 적으면 정당한 편집 한 번이 그 경로를 영구 면제로 만든다 — 그래서 티켓은 내용 해시에
  # 묶는다. 다만 **소비 시점**은 일치 즉시가 아니다. 편집된 파일은 커밋 전까지 계속 HEAD와
  # 다르므로, 일치하자마자 티켓을 지우면 그 편집은 Bash 호출 한 번만 살아남고 다음 호출에서
  # 되돌려졌다(실측: F66 등록이 두 번 연속 폐기됨). 편집 → 검증 → 커밋이 성립해야 하므로
  # 내용이 그대로인 동안 유효하고, 변경이 정착(HEAD 일치)할 때 소비한다.
  local f="$LAB/progress/harness-config.json" new
  new=$( cd "$LAB" && jq '.scoring.pass_threshold = 8' progress/harness-config.json )
  printf '%s' "$new" | jq -Rs --arg p "$f" '{tool_name:"Write", tool_input:{file_path:$p, content:.}}' \
    | ( cd "$LAB" && CLAUDE_PROJECT_DIR="$LAB" bash hooks/invariant-guard.sh ) >/dev/null 2>&1
  # **후행 개행을 포함해 쓴다.** 이전 픽스처는 `printf '%s'` 로 개행 없이 써서, 티켓 sha가
  # 개행을 잃은 채 계산되던 결함과 우연히 형태가 같았다 — 그래서 실사용에서는 모든 편집이
  # 복구되는데 테스트는 통과했다. 실제 파일과 같은 형태로 써야 그 결함이 드러난다.
  printf '%s\n' "$new" > "$f"
  # 티켓 형식이 <해시> <경로> 인지
  ( cd "$LAB" && head -1 progress/.guarded-edits | grep -qE '^[0-9a-f]{40} progress/harness-config\.json$' )
  # 내용이 그대로인 동안은 몇 번을 검사해도 살아남는다
  integrity
  [ "$( cd "$LAB" && jq -r .scoring.pass_threshold progress/harness-config.json )" = "8" ]
  integrity
  [ "$( cd "$LAB" && jq -r .scoring.pass_threshold progress/harness-config.json )" = "8" ]
  # 그러나 티켓 없는 **다른 내용**은 면제되지 않는다 — 경로 면제가 아니라 내용 면제다
  ( cd "$LAB" && jq '.scoring.pass_threshold = 9' progress/harness-config.json > /tmp/hc-9.json \
      && cp /tmp/hc-9.json progress/harness-config.json && rm -f /tmp/hc-9.json )
  integrity
  [ "$( cd "$LAB" && jq -r .scoring.pass_threshold progress/harness-config.json )" = "7" ]
  # 정착(HEAD 일치)하면 그 경로의 티켓은 소비된다
  integrity
  ( cd "$LAB" && ! grep -q ' progress/harness-config.json$' progress/.guarded-edits )
}

@test "F65: 저장소 밖 편집은 티켓을 오염시키지 않는다" {
  # 테스트가 임시 디렉터리에서 돌 때 실 저장소 티켓이 209줄까지 쌓인 적이 있다.
  local outside before after
  outside="$(mktemp -d)/x.bats"; printf 'x\n' > "$outside"
  before=$( cd "$LAB" && wc -l < progress/.guarded-edits 2>/dev/null || echo 0 )
  printf 'y\n' | jq -Rs --arg p "$outside" '{tool_name:"Write", tool_input:{file_path:$p, content:.}}' \
    | ( cd "$LAB" && CLAUDE_PROJECT_DIR="$LAB" bash hooks/invariant-guard.sh ) >/dev/null 2>&1
  after=$( cd "$LAB" && wc -l < progress/.guarded-edits 2>/dev/null || echo 0 )
  [ "$before" = "$after" ]
}

@test "F65: 훼손 후 커밋으로 기준선을 옮겨도 보고된다" {
  # HEAD 비교만으로는 tamper-then-commit 을 볼 수 없다 — 세션 기준선이 그것을 드러낸다.
  integrity   # 기준선 생성
  ( cd "$LAB" && printf 'TAMPERED\n' > progress/harness-config.json && git add -A \
      && git -c user.email=t@t -c user.name=t commit -qm wip )
  [ "$( cd "$LAB" && git diff --name-only HEAD | wc -l | tr -d ' ' )" -eq 0 ]
  run integrity
  [[ "$output" == *"커밋으로"* ]]
}

@test "F65: 탐지기 자신과 티켓 파일은 컨트롤 플레인이다" {
  # 파괴되면 자기를 복구할 수 없으므로 예측 계층이 막아야 한다.
  local fw="$BATS_TEST_DIRNAME/../hooks/pre-bash-firewall.sh"
  for cmd in "echo x > hooks/protected-integrity.sh" \
             "chmod 000 hooks/protected-integrity.sh" \
             "echo p >> progress/.guarded-edits" \
             "git update-index --assume-unchanged progress/harness-config.json" \
             "git rm --cached progress/feature_list.json"; do
    run bash -c "jq -n --arg c '$cmd' '{tool_name:\"Bash\",tool_input:{command:\$c}}' | bash '$fw'"
    [[ "$output" == *'"permissionDecision": "ask"'* ]]
  done
}

@test "F65 step 13: PROTECTED_GLOBS와 is_protected()는 전체 추적 파일에서 문서화된 예외 밖으로 어긋나지 않는다 (SC-8 기계 대조)" {
  # 4차 판정 지적: 이전 테스트는 hooks/*.sh 글롭 하나의 대칭만 봤다 — evaluator-runs.jsonl 류의
  # 개별 불일치는 그 표본 밖에 있으면 놓친다. 여기서는 저장소가 실제로 추적하는 파일 **전체**를
  # 대상으로 두 판정을 직접 호출해 대조한다 — 손으로 고른 표본이 아니라 `git ls-tree`가 반환하는
  # 실제 집합이다. 한쪽만 넓으면 티켓 미발급 파일이 복구 대상이 되어 정당한 편집이 되돌려지고
  # (F65 때 hooks/lib.sh 가 실제로 그랬다), 좁으면 그 경로는 예측도 탐지도 없이 남는다.
  local repo="$BATS_TEST_DIRNAME/.."
  local ig="$repo/hooks/protected-integrity.sh"
  local guard="$repo/hooks/invariant-guard.sh"

  local -a GLOBS=()
  while IFS= read -r line; do GLOBS+=("$line"); done < <(
    sed -n '/^PROTECTED_GLOBS=($/,/^)$/p' "$ig" | grep -oE "'[^']+'" | tr -d "'"
  )
  [ "${#GLOBS[@]}" -ge 10 ] || { echo "PROTECTED_GLOBS 추출 실패 — 배열 형식이 바뀌었는지 확인하라"; false; }

  source <(sed -n '/^is_protected() {$/,/^}$/p' "$guard")

  in_globs() {
    local p="$1" g
    for g in "${GLOBS[@]}"; do
      # shellcheck disable=SC2053
      [[ "$p" == $g ]] && return 0
    done
    return 1
  }

  # 문서화된 예외 — protected-integrity.sh 자신(파괴되면 자기를 복구할 수 없으므로 is_protected()
  # 에는 있지만 PROTECTED_GLOBS에는 못 넣는다; hooks/protected-integrity.sh 헤더 주석 참조).
  # `.guarded-edits`·`.integrity-baseline`·`evaluator-runs.jsonl`은 gitignore 대상이라 애초에
  # `git ls-tree`에 나타나지 않으므로 이 배터리의 표본에서 구조적으로 제외된다 — 별도 예외 처리가
  # 필요 없다.
  local -a EXCEPTIONS=('hooks/protected-integrity.sh')
  is_exception() {
    local p="$1" e
    for e in "${EXCEPTIONS[@]}"; do [[ "$p" == "$e" ]] && return 0; done
    return 1
  }

  local -a FILES=()
  while IFS= read -r f; do [[ -n "$f" ]] && FILES+=("$f"); done < <(
    git -C "$repo" ls-tree -r --name-only HEAD
  )
  [ "${#FILES[@]}" -ge 50 ] || { echo "git ls-tree 결과가 비정상적으로 적다"; false; }

  local mismatches="" f a b
  for f in "${FILES[@]}"; do
    is_exception "$f" && continue
    a=1; in_globs "$f" && a=0
    b=1; is_protected "$f" && b=0
    [[ "$a" == "$b" ]] || mismatches="$mismatches
$f (PROTECTED_GLOBS=$([ "$a" = 0 ] && echo yes || echo no), is_protected=$([ "$b" = 0 ] && echo yes || echo no))"
  done
  [[ -z "$mismatches" ]] || { echo "두 집합이 문서화된 예외 밖에서 어긋난다:$mismatches"; false; }
}

@test "F65: invariant-guard 심사를 거친 hooks/*.sh 편집은 대칭 보호 하에서도 보존된다 (오탐 없음)" {
  # 위 대칭 대조가 통과하는 상태에서, 정당한 편집(티켓 있음)이 복구로 되돌려지지 않는지 확인한다.
  ( cd "$LAB" && printf '\n# legit\n' >> hooks/lib.sh && \
    printf '%s hooks/lib.sh\n' "$(printf '%s' "$(cat hooks/lib.sh)" | git hash-object --stdin)" \
      > progress/.guarded-edits )
  integrity
  ( cd "$LAB" && grep -q 'legit' hooks/lib.sh )
}
