#!/usr/bin/env bats
#
# F78 — 복구 목표는 마지막으로 심사를 통과한 내용이다 (sprint-64)
#
# `protected-integrity.sh` 는 티켓 없는 변경을 발견하면 되돌린다. 그 **되돌릴 대상**이 HEAD 였다:
# 티켓 없는 쓰기 한 번이 그 파일에 쌓여 있던 심사 통과분 전체를 함께 버렸다. F65 작업 중 세 번
# 재발했고 방아쇠는 매번 달랐다 — python3 편집·`git stash pop`·`sed -i`. **방아쇠가 매번 다르다는
# 것이 방아쇠를 막는 것으로는 닫히지 않는다는 증거**이므로, 이 파일은 우회 형태를 열거하지 않는다.
# 대표 형태 하나("티켓 없는 임의의 Bash 쓰기")를 쓰고, 세 사례는 그 대표의 인스턴스로만 적는다
# (F63 이 형태 열거로 실패한 것과 같은 이유 — protected-integrity.bats 머리말 참조).

setup() {
  LAB="$(mktemp -d)"
  git -C "$BATS_TEST_DIRNAME/.." archive HEAD 2>/dev/null | tar -x -C "$LAB"
  cp "$BATS_TEST_DIRNAME/../hooks/protected-integrity.sh" \
     "$BATS_TEST_DIRNAME/../hooks/invariant-guard.sh" "$LAB/hooks/"
  cd "$LAB" || return 1
  git init -q .
  git add -A
  git -c user.email=t@t -c user.name=t commit -qm base
  TARGET="hooks/lib.sh"          # 보호 파일(데이터 플레인) 하나를 대표로 쓴다
}

teardown() {
  cd /
  [ -n "${LAB:-}" ] && rm -rf "$LAB"
}

integrity() { ( cd "$LAB" && CLAUDE_PROJECT_DIR="$LAB" bash hooks/protected-integrity.sh 2>&1 ) }

# invariant-guard 를 태우고 **종료 코드만** 돌려준다(0=통과, 2=차단).
# 실패를 그대로 흘리면 bats 의 errexit 가 그 자리에서 테스트를 끝내 rc 를 볼 수 없다.
guard_rc() {  # $1 파일, $2 내용, [$3 PROJECT_DIR]
  local pd="${3:-$LAB}" input rc=0
  input=$(jq -n --arg f "$1" --arg c "$2" '{tool_name:"Write",tool_input:{file_path:$f,content:$c}}')
  printf '%s' "$input" | ( cd "$pd" && CLAUDE_PROJECT_DIR="$pd" bash "$LAB/hooks/invariant-guard.sh" ) \
    >/dev/null 2>&1 || rc=$?
  printf '%s' "$rc"
}

# 심사를 통과한 편집 한 번을 흉내 낸다 — invariant-guard 가 티켓을 발행하는 것과 같은 결과를
# 만든다(내용 + 티켓 줄 + blob). 실제 훅 배선을 태우지 않는 이유: 이 파일이 잠그는 것은
# **복구 목표**이지 심사 로직이 아니고, bats 에서 PreToolUse 훅을 태우려면 도구 호출이 필요하다.
approved_edit() {  # $1 파일, $2 이어 붙일 내용
  local f="$1" text="$2" sha
  printf '%s' "$text" >> "$LAB/$f"
  # **훅과 같은 해시 규약을 쓴다.** 발행(`printf '%s' "$NEW_CONTENT"`, NEW_CONTENT 는 `$( )` 로
  # 읽혀 후행 개행이 이미 제거됨)과 검증(`printf '%s' "$(cat f)"`)이 둘 다 후행 개행을 무시한다 —
  # `git hash-object f`(파일 그대로)를 쓰면 개행으로 끝나는 파일에서 값이 달라져 티켓이 무효가 된다.
  sha=$( cd "$LAB" && printf '%s' "$(cat "$f")" | git hash-object --stdin )
  # **훅이 실제로 쓰는 형식을 쓴다(F78 SC-8)**: `<내용sha> <발행 시점 HEAD> <경로>`.
  # 구 형식(`<sha> <경로>`)으로 쓰면 staleness 판정이 비활성화돼(그 형식은 `-` 로 취급된다)
  # 이 파일의 staleness 테스트가 **아무것도 검사하지 않는 채 통과**한다 — 픽스처가 축을
  # 지우는 그 실패 양식이다(이 라운드 자체 발견).
  local head_at; head_at=$( cd "$LAB" && git rev-parse --verify -q HEAD 2>/dev/null || printf '-' )
  printf '%s %s %s\n' "$sha" "$head_at" "$f" >> "$LAB/progress/.guarded-edits"
  mkdir -p "$LAB/progress/.guarded-blobs"
  cp "$LAB/$f" "$LAB/progress/.guarded-blobs/$sha"
  printf '%s' "$sha"
}

# 티켓 없는 임의의 Bash 쓰기 — 이 파일의 **대표 형태**.
# 세 재발 사례는 이 대표의 인스턴스다: python3 로 쓴 것도, `git stash pop` 이 되살린 것도,
# `sed -i` 가 남긴 것도, 전부 "티켓 없이 파일 내용이 바뀐 상태"라는 같은 사실로 귀착한다.
untracked_write() {  # $1 파일, $2 내용
  printf '%s' "$2" > "$LAB/$1"
}

@test "F78: 복구 목표는 HEAD 가 아니라 **마지막으로 심사를 통과한 내용**이다" {
  approved_edit "$TARGET" $'\n# approved-1\n' > /dev/null
  approved_edit "$TARGET" $'\n# approved-2\n' > /dev/null
  approved_edit "$TARGET" $'\n# approved-3\n' > /dev/null
  local want; want=$(cat "$LAB/$TARGET")

  untracked_write "$TARGET" 'PWNED'
  integrity > /dev/null

  local got; got=$(cat "$LAB/$TARGET")
  [ "$got" = "$want" ] || {
    echo "복구 내용이 마지막 심사 통과분과 다르다."
    ( cd "$LAB" && git diff --stat HEAD -- "$TARGET" )
    grep -c 'approved-' "$LAB/$TARGET" || true
    false
  }
  # 세 번의 심사 통과분이 모두 남아 있어야 한다 — HEAD 복구는 이 셋을 전부 버렸다.
  grep -q 'approved-1' "$LAB/$TARGET"
  grep -q 'approved-2' "$LAB/$TARGET"
  grep -q 'approved-3' "$LAB/$TARGET"
}

@test "F78: 티켓 이력이 없는 파일은 종전대로 HEAD 로 복구된다(폴백)" {
  local head_content; head_content=$(cat "$LAB/$TARGET")
  untracked_write "$TARGET" 'PWNED'
  integrity > /dev/null
  [ "$(cat "$LAB/$TARGET")" = "$head_content" ]
}

@test "F78: 되돌리기 전 격리본이 남는다(손실 0) — 복구 목표가 바뀌어도 유지" {
  approved_edit "$TARGET" $'\n# approved-1\n' > /dev/null
  untracked_write "$TARGET" 'PWNED-KEEPME'
  integrity > /dev/null
  local found=""
  if [ -d "$LAB/progress/.integrity-quarantine" ]; then
    found=$(grep -rl 'PWNED-KEEPME' "$LAB/progress/.integrity-quarantine" 2>/dev/null | head -1)
  fi
  [ -n "$found" ] || { echo "격리본에 훼손된 내용이 보관되지 않았다"; false; }
}

@test "F78: blob 이 조작되면 그 티켓을 쓰지 않고 HEAD 로 폴백하며 그 사실을 보고한다" {
  local sha; sha=$(approved_edit "$TARGET" $'\n# approved-1\n')
  local head_content; head_content=$( cd "$LAB" && git show "HEAD:$TARGET" )
  printf 'TAMPERED' > "$LAB/progress/.guarded-blobs/$sha"   # 내용 주소 위반
  untracked_write "$TARGET" 'PWNED'
  local out; out=$(integrity)
  [ "$(cat "$LAB/$TARGET")" = "$head_content" ] || { echo "조작된 blob 이 복구에 쓰였다"; false; }
  grep -qiE 'blob|불일치|폴백' <<<"$out" || { echo "폴백 사유가 보고되지 않았다: $out"; false; }
}

@test "F78: blob 이 없으면(저장소만 비었을 때) HEAD 로 폴백한다" {
  local sha; sha=$(approved_edit "$TARGET" $'\n# approved-1\n')
  local head_content; head_content=$( cd "$LAB" && git show "HEAD:$TARGET" )
  rm -f "$LAB/progress/.guarded-blobs/$sha"
  untracked_write "$TARGET" 'PWNED'
  integrity > /dev/null
  [ "$(cat "$LAB/$TARGET")" = "$head_content" ]
}

@test "F78: 심사를 통과한 편집 자체는 여전히 복구되지 않는다(오탐 없음)" {
  approved_edit "$TARGET" $'\n# legit\n' > /dev/null
  integrity > /dev/null
  grep -q 'legit' "$LAB/$TARGET"
}

@test "F78: 원장은 보호 대상이 아닌 경로 줄을 쌓아 두지 않는다(GC)" {
  # 실측 배경: 운영 중인 원장이 2099줄까지 불었고 대부분이 보호 대상 밖 한 경로였다.
  mkdir -p "$LAB/progress"
  local i
  for i in $(seq 1 50); do printf 'deadbeef settings.json\n' >> "$LAB/progress/.guarded-edits"; done
  printf 'cafebabe ../outside/x.sh\n' >> "$LAB/progress/.guarded-edits"
  local sha; sha=$(approved_edit "$TARGET" $'\n# approved-1\n')
  integrity > /dev/null
  # 보호 대상 밖 줄은 사라지고, 유효 티켓은 남아야 한다.
  # **`! cmd` 로 쓰지 않는다**: 부정된 명령은 errexit 대상이 아니라 실패해도 테스트가 통과한다
  # (이 파일 초안에서 실제로 거짓 통과했다 — 측정 도구의 조용한 성공은 이 세션에서 네 번째다).
  if grep -q ' settings.json$' "$LAB/progress/.guarded-edits"; then
    echo "보호 대상이 아닌 경로 줄이 원장에 남아 있다"; return 1
  fi
  if grep -q 'outside' "$LAB/progress/.guarded-edits"; then
    echo "저장소 root 밖 경로 줄이 원장에 남아 있다"; return 1
  fi
  if ! grep -q " $TARGET\$" "$LAB/progress/.guarded-edits"; then
    echo "유효 티켓이 GC 에 함께 지워졌다"; return 1
  fi
}

@test "F78: 티켓을 발행할 수 없으면 보호 파일 편집이 **차단**된다(조용한 통과 금지)" {
  # 조용한 `return 0` 은 "티켓 없이 통과"였고, 그 편집은 다음 Bash 호출에서 되돌아갔다 —
  # 사용자에게는 편집이 성공한 것처럼 보였다가 사라지는 형태다. 지금 막는다.
  # 차단 조건은 **복구 평면이 살아 있을 때**로 좁힌다(아래 두 대조군이 그 경계다).
  # 종료 코드를 **직접** 받는다 — bats 의 errexit 아래에서 실패하는 파이프라인을 그냥 쓰면
  # 그 자리에서 테스트가 중단돼 rc 를 볼 수 없다.
  local rc
  mv "$LAB/progress" "$LAB/progress.bak"        # root 해석 실패를 만든다(progress/ 없음)
  rc=$(guard_rc "$LAB/hooks/lib.sh" 'x')
  [ "$rc" -eq 2 ] || { mv "$LAB/progress.bak" "$LAB/progress"; echo "티켓 미발행인데 통과했다(rc=$rc)"; return 1; }
  # 비보호 파일은 같은 조건에서도 통과한다 — 원장 오염을 막으려면 티켓을 만들지 않는 것이 맞다.
  rc=$(guard_rc "$LAB/README.md" 'x')
  mv "$LAB/progress.bak" "$LAB/progress"
  [ "$rc" -eq 0 ] || { echo "비보호 파일 편집까지 막혔다(rc=$rc)"; return 1; }
}

@test "F78: 차단은 복구 평면이 살아 있을 때로 좁혀진다 — 신규 경로와 비-git 저장소는 통과" {
  # HEAD 에 없는 경로는 `protected-integrity` 의 감시 목록(`git ls-tree HEAD`)에 없어 되돌려지지
  # 않는다. 비-git 저장소에는 되돌릴 주체 자체가 없다. 둘 다 티켓이 의미 없으므로 막지 않는다 —
  # 막으면 새 훅·새 테스트를 만들 수 없고, 비-git 프로젝트에서 하네스가 통째로 잠긴다.
  local rc nogit
  rc=$(guard_rc "$LAB/hooks/brandnew.sh" '#!/bin/bash')
  [ "$rc" -eq 0 ] || { echo "HEAD 에 없는 신규 보호 경로가 막혔다(rc=$rc)"; return 1; }

  nogit=$(mktemp -d); mkdir -p "$nogit/progress" "$nogit/hooks"; printf 'x\n' > "$nogit/hooks/lib.sh"
  rc=$(guard_rc "$nogit/hooks/lib.sh" 'y' "$nogit")
  rm -rf "$nogit"
  [ "$rc" -eq 0 ] || { echo "비-git 저장소의 보호 파일 편집이 막혔다(rc=$rc)"; return 1; }
}

# ---------------------------------------------------------------------------
# 1차 독립 판정(2026-09-14)이 실측한 다섯 축 — 대표 형태 추상화가 지운 것들.
# 교훈: "티켓 없는 임의의 쓰기" 하나로 묶으면서 **`git stash` 가 HEAD 일치를 경유한다**는
# 성질이 사라졌고, blob 이 **언제나 신규 파일**이라는 성질도 검사되지 않았다.
# ---------------------------------------------------------------------------

@test "F78 1차 판정: git stash → 훅 → git stash pop → 훅 인터리빙에서도 심사 통과분이 보존된다" {
  # 실제 배선에서는 **모든 Bash 호출이 훅을 발화**시키므로 이 인터리빙이 유일하게 가능한
  # 순서다: stash 로 파일이 HEAD 와 같아지면 그 시점의 훅이 티켓을 **소비**하고, pop 이
  # 되살린 내용은 티켓이 없어 HEAD 로 되돌아간다 — 심사 통과분 3건이 전부 사라진다.
  approved_edit "$TARGET" $'\n# approved-1\n' > /dev/null
  approved_edit "$TARGET" $'\n# approved-2\n' > /dev/null
  approved_edit "$TARGET" $'\n# approved-3\n' > /dev/null
  local want; want=$(cat "$LAB/$TARGET")

  ( cd "$LAB" && git -c user.email=t@t -c user.name=t stash -q )
  integrity > /dev/null          # stash 직후의 훅 발화(파일 == HEAD)
  ( cd "$LAB" && git stash pop -q )
  integrity > /dev/null          # pop 직후의 훅 발화

  [ "$(cat "$LAB/$TARGET")" = "$want" ] || {
    echo "stash/pop 인터리빙에서 심사 통과분이 사라졌다"
    grep -c 'approved-' "$LAB/$TARGET" || true
    return 1
  }
}

@test "F78 1차 판정: 훅이 몇 번 발화하든 복구 목표는 같다(소비 ≠ 복구 목표 폐기)" {
  approved_edit "$TARGET" $'\n# approved-1\n' > /dev/null
  local want; want=$(cat "$LAB/$TARGET")
  local i
  for i in 1 2 3 4 5; do
    ( cd "$LAB" && git checkout -q -- "$TARGET" )   # HEAD 일치 상태를 만든다(소비 유발)
    integrity > /dev/null
  done
  untracked_write "$TARGET" 'PWNED'
  integrity > /dev/null
  [ "$(cat "$LAB/$TARGET")" = "$want" ] || {
    echo "훅이 반복 발화한 뒤 복구 목표가 사라졌다"; return 1; }
}

@test "F78 1차 판정: blob 은 **신규 파일**로도 심을 수 없다(도구 경로)" {
  # blob 이름이 내용 해시라 심는 행위는 언제나 신규 파일 생성이다 — 신규 파일을 통과시키는
  # 조기 종료가 차단보다 앞서면 그 차단은 죽은 코드다(1차 판정 실측 rc: 신규 0 / 기존 2).
  local content='# BACKDOOR' sha rc
  sha=$( cd "$LAB" && printf '%s' "$content" | git hash-object --stdin )
  mkdir -p "$LAB/progress/.guarded-blobs"
  rc=$(guard_rc "$LAB/progress/.guarded-blobs/$sha" "$content")
  [ "$rc" -eq 2 ] || { echo "신규 blob 심기가 도구 경로로 통과했다(rc=$rc)"; return 1; }
}

@test "F78 1차 판정: 원장·blob 에 쓰는 **입구**가 막힌다 — 철자가 아니라 실체 경로로 (종단)" {
  # 1차 판정이 성공시킨 시나리오는 'blob 을 심고 원장에 sha 를 적으면 다음 복구가 그 내용을
  # **설치**한다' 였다. 두 기록이 곧 '심사를 통과했다'는 근거이므로, 그 기록을 쓸 수 있는 상대는
  # 정의상 심사를 위조할 수 있다 — 이 파일의 오래된 주석이 적어 둔 대로 티켓은 셸을 쥔 상대에게
  # 위조 불가능하지 않다. 따라서 **막아야 하는 것은 복구가 아니라 입구**다: 도구 경로는
  # invariant-guard 가(위 테스트), Bash 경로는 방화벽이 막는다. 방화벽 판정은 **철자가 아니라
  # 실체 경로**여야 한다 — 판정자가 `ln -s .guarded-blobs progress/blobs` 한 줄로 철자를 피했다.
  local d fw="$BATS_TEST_DIRNAME/../hooks/pre-bash-firewall.sh" c
  mkdir -p "$LAB/progress/.guarded-blobs"
  ( cd "$LAB/progress" && ln -sf .guarded-blobs blobs )
  for c in "printf x > progress/.guarded-blobs/abc" \
           "printf x > progress/blobs/abc" \
           "cp /tmp/evil progress/blobs/abc" \
           "printf x >> progress/.guarded-edits"; do
    d=$( cd "$LAB" && printf '%s' "$(jq -n --arg c "$c" '{tool_input:{command:$c}}')" | bash "$fw" 2>&1 \
           | jq -r '.hookSpecificOutput.permissionDecision // "allow"' 2>/dev/null || printf 'allow' )
    [ "$d" != "allow" ] || { echo "탐지기 상태 저장소 쓰기가 allow 다: $c"; return 1; }
  done
  # 일상 리다이렉트에는 마찰이 없어야 한다(실체 판정이 과잉 차단으로 번지지 않는지).
  for c in "echo hi > progress/notes.txt" "git diff > /tmp/d.patch"; do
    d=$( cd "$LAB" && printf '%s' "$(jq -n --arg c "$c" '{tool_input:{command:$c}}')" | bash "$fw" 2>&1 \
           | jq -r '.hookSpecificOutput.permissionDecision // "allow"' 2>/dev/null || printf 'allow' )
    [ "$d" = "allow" ] || { echo "무관한 리다이렉트에 새 마찰: $c -> $d"; return 1; }
  done
}

@test "F78 1차 판정: 티켓 없이 HEAD 로 되돌린 경우 보고가 그 사실을 말한다" {
  # 헤더가 무조건 '마지막으로 심사를 통과한 내용으로 복구했습니다' 를 찍으면, 심사 통과분이
  # 사라진 실행조차 그 문구를 출력한다(1차 판정이 그 출력을 근거로 '보고가 거짓' 이라고 적었다).
  local out
  untracked_write "$TARGET" 'PWNED'        # 티켓 이력 없음 → HEAD 폴백
  out=$(integrity)
  grep -qE 'HEAD' <<<"$out" || { echo "HEAD 폴백인데 보고가 그 사실을 말하지 않는다: $out"; return 1; }
}

@test "F78 1차 판정: 복구는 바이트 동일하다(후행 개행을 임의로 붙이지 않는다)" {
  approved_edit "$TARGET" $'\n# approved-1\n' > /dev/null
  local want_sum; want_sum=$(cksum < "$LAB/$TARGET")
  untracked_write "$TARGET" 'PWNED'
  integrity > /dev/null
  [ "$(cksum < "$LAB/$TARGET")" = "$want_sum" ] || {
    echo "복구 결과가 바이트 동일하지 않다(후행 개행 등)"; return 1; }
}

@test "F78 1차 판정: GC 상한 경계에서 잡음이 유효 티켓을 밀어내지 않는다" {
  # 자르고 나서 거르면 잡음 2500줄이 유효 티켓을 상한 밖으로 밀어낸다 — 걸러낸 뒤 잘라야 한다.
  local sha i
  sha=$(approved_edit "$TARGET" $'\n# approved-1\n')
  mkdir -p "$LAB/progress"
  for i in $(seq 1 2500); do printf 'deadbeef settings.json\n' >> "$LAB/progress/.guarded-edits"; done
  untracked_write "$TARGET" 'PWNED'
  integrity > /dev/null
  grep -q 'approved-1' "$LAB/$TARGET" || {
    echo "잡음이 상한을 채워 유효 티켓이 밀려났다"; return 1; }
}

# ---------------------------------------------------------------------------
# 2차 독립 판정(2026-09-14) — **생성 규칙**으로 쓴다.
# 2차의 요지는 "손으로 열거하면 다음 라운드에 또 한 원소가 빠진다" 였다. 실제로 1차 대응이
# 상태 파일 넷 중 **하나만** 조기 종료 앞으로 옮겨서 같은 백도어가 `.guarded-restore` 로
# 옮겨갔다. 그래서 여기서는 {상태 파일} × {존재·부재} × {쓰기 수단} × {별칭}을 **코드로 생성**한다.
# ---------------------------------------------------------------------------

# 단일 출처를 테스트도 그대로 읽는다 — 훅과 다른 목록을 테스트가 따로 적으면 그 순간 축이 갈라진다.
guarded_state_names() {
  # shellcheck disable=SC1090
  source "$BATS_TEST_DIRNAME/../hooks/lib.sh" 2>/dev/null || true
  printf '%s\n' "${GUARDED_STATE_NAMES[@]}"
}

@test "F78 2차 판정: 상태 파일 목록 자체를 고정한다(생성기가 축소를 따라가지 않도록)" {
  # **생성 규칙 테스트의 맹점**: 곱을 단일 출처에서 읽으면, 목록에서 원소를 빼는 변이가
  # 테스트의 기대까지 함께 줄여 **아무것도 실패하지 않는다**(이 라운드 변이 M1 이 그렇게
  # 살아남았다). F65 에서 생성기 산출 수를 고정한 것과 같은 이유로 목록 자체를 고정한다 —
  # 원소를 더하는 것은 add-only 로 허용하고, **빼는 것은 이 테스트가 막는다**.
  local names; names=$(guarded_state_names)
  local n; n=$(printf '%s\n' "$names" | grep -c .)
  [ "$n" -eq 4 ] || { echo "상태 파일 목록이 4종이 아니다: $n (원소를 더했으면 이 수를 올린다)"; return 1; }
  local want
  for want in .guarded-edits .guarded-restore .guarded-blobs .integrity-baseline; do
    grep -qxF "$want" <<<"$names" || { echo "상태 파일 목록에서 빠졌다: $want"; return 1; }
  done
}

@test "F78 2차 판정: 상태 파일 × 존재·부재 × 도구 경로 — 전수 차단(생성)" {
  local n target rc fails=()
  while IFS= read -r n; do
    case "$n" in
      .guarded-blobs) target="progress/$n/0000000000000000000000000000000000000000" ;;
      *)              target="progress/$n" ;;
    esac
    # (1) 파일 부재 상태 — blob 이름은 내용 해시라 심는 행위가 **언제나 신규 생성**이다.
    rm -f "$LAB/$target"
    rc=$(guard_rc "$LAB/$target" 'x')
    [ "$rc" -eq 2 ] || fails+=("부재 상태에서 통과: $target (rc=$rc)")
    # (2) 파일 존재 상태
    mkdir -p "$(dirname "$LAB/$target")"; printf 'y' > "$LAB/$target"
    rc=$(guard_rc "$LAB/$target" 'x')
    [ "$rc" -eq 2 ] || fails+=("존재 상태에서 통과: $target (rc=$rc)")
    rm -f "$LAB/$target"
  done < <(guarded_state_names)
  [[ ${#fails[@]} -eq 0 ]] || { printf 'LEAK %s\n' "${fails[@]}"; return 1; }
}

@test "F78 2차 판정: 상태 파일 × 쓰기 수단 × 별칭 — 전수 차단(생성, Bash 경로)" {
  # 쓰기 수단을 열거해서 막는 것이 아니라 **대상 경로**로 판정한다 — 그래야 `dd of=`·인터프리터
  # 처럼 열거 밖의 수단도 같은 판정에 걸린다(2차 판정이 실측한 우회 3종).
  local fw="$BATS_TEST_DIRNAME/../hooks/pre-bash-firewall.sh"
  local n base alias_base tmpl d fails=()
  mkdir -p "$LAB/progress/.guarded-blobs"
  ( cd "$LAB/progress" && ln -sf .guarded-blobs blobs )
  while IFS= read -r n; do
    case "$n" in
      .guarded-blobs) base="progress/$n/abc"; alias_base="progress/blobs/abc" ;;
      *)              base="progress/$n";     alias_base="" ;;
    esac
    for tmpl in 'printf x > %s' 'printf x >> %s' 'cp /tmp/e %s' 'dd if=/dev/zero of=%s' 'tee %s'; do
      # shellcheck disable=SC2059
      for target in "$base" ${alias_base:+"$alias_base"}; do
        d=$( cd "$LAB" && printf '%s' "$(jq -n --arg c "$(printf "$tmpl" "$target")" '{tool_input:{command:$c}}')" \
               | bash "$fw" 2>&1 | jq -r '.hookSpecificOutput.permissionDecision // "allow"' 2>/dev/null || printf 'allow' )
        [ "$d" = "allow" ] && fails+=("$(printf "$tmpl" "$target") -> allow")
      done
    done
  done < <(guarded_state_names)
  [[ ${#fails[@]} -eq 0 ]] || { printf 'LEAK %s\n' "${fails[@]}"; return 1; }
}

@test "F78 2차 판정: 낡은 티켓은 커밋된 내용을 덮지 않는다(staleness)" {
  # 2차 판정 실증: 버려진 `FEATURE-A` 편집의 티켓이 대장에 남은 채 `COMMITTED-B` 를 커밋하면,
  # 이후 복구가 FEATURE-A 를 되살려 커밋된 내용을 덮었다. 승격이 낡은 목표의 수명을 무한으로
  # 만든 것이 원인이다 — 티켓을 발행 시점 HEAD 에 묶어 그 사이 HEAD 가 움직이면 무효로 본다.
  approved_edit "$TARGET" $'\n# FEATURE-A\n' > /dev/null
  ( cd "$LAB" && git checkout -q -- "$TARGET" )        # 편집을 버린다(티켓만 남는다)
  integrity > /dev/null                                # 소비 → 복구 대장으로 승격
  printf '\n# COMMITTED-B\n' >> "$LAB/$TARGET"
  ( cd "$LAB" && git add -A && git -c user.email=t@t -c user.name=t commit -qm b )
  local want; want=$(cat "$LAB/$TARGET")
  untracked_write "$TARGET" 'PWNED'
  local out; out=$(integrity)
  [ "$(cat "$LAB/$TARGET")" = "$want" ] || {
    echo "낡은 티켓이 커밋된 내용을 덮었다"; grep -c 'FEATURE-A' "$LAB/$TARGET" || true; return 1; }
  grep -q 'FEATURE-A' "$LAB/$TARGET" && { echo "버려진 편집이 되살아났다"; return 1; }
  grep -qE 'HEAD' <<<"$out" || { echo "무효 사유가 보고되지 않았다: $out"; return 1; }
}

@test "F78 2차 판정: 복구 대장에도 원장과 같은 GC·형식 검증이 적용된다" {
  # 2차 판정: 대장에 GC·형식 검증이 전혀 없어 `deadbeef ../../etc/passwd`·`GARBAGE` 가 남았고,
  # 조회가 그 파일로 폴스루하므로 **검증 없는 평면이 복구 목표를 결정**했다.
  approved_edit "$TARGET" $'\n# approved-1\n' > /dev/null
  ( cd "$LAB" && git checkout -q -- "$TARGET" )
  integrity > /dev/null                                 # 대장 생성(승격)
  {
    printf 'deadbeef ../../etc/passwd\n'
    printf 'GARBAGE\n'
    printf '%040d settings.json\n' 0
  } >> "$LAB/progress/.guarded-restore"
  integrity > /dev/null
  local bad
  for bad in 'etc/passwd' 'GARBAGE' ' settings.json'; do
    if grep -qF "$bad" "$LAB/progress/.guarded-restore" 2>/dev/null; then
      echo "복구 대장에 걸러져야 할 줄이 남았다: $bad"; return 1
    fi
  done
}

@test "F78 3차 판정: 낡은 티켓으로 폴백할 때 사유를 사실대로 보고한다" {
  # `last_ticket_sha()` 는 낡은 티켓을 만나면 `STALE_REASON` 을 세우는데, 호출부가 그 함수를
  # **명령 치환**으로 불렀다 — 서브셸이라 값이 호출부에 도달하지 못했고 그 분기는 도달 불가
  # 코드였다. 훅은 티켓이 있었는데도 '티켓 이력이 없어'라고 틀리게 보고했다. GC 가 낡은 줄을
  # 지우던 것도 같은 증상을 만들었다(지우면 티켓이 있었다는 사실 자체가 사라진다).
  approved_edit "$TARGET" $'\n# STALE-A\n' > /dev/null
  ( cd "$LAB" && git checkout -q -- "$TARGET" )
  ( cd "$LAB" && echo unrelated > unrelated.txt && git add unrelated.txt \
      && git -c user.email=t@t -c user.name=t commit -qm unrelated )   # HEAD 이동 → 티켓이 낡는다
  untracked_write "$TARGET" 'PWNED'
  local out; out=$(integrity)
  [[ "$out" == *"발행 시점 HEAD"* ]] || {
    echo "낡은 티켓 사유가 보고되지 않았다(도달 불가 분기): $out"; return 1; }
  [[ "$out" != *"티켓 이력이 없어"* ]] || {
    echo "티켓이 있었는데 없다고 보고했다: $out"; return 1; }
  grep -q 'STALE-A' "$LAB/$TARGET" && { echo "낡은 티켓이 복구 목표로 쓰였다"; return 1; }
  return 0
}

@test "F78: 참조되지 않는 blob 은 정리된다" {
  mkdir -p "$LAB/progress/.guarded-blobs"
  printf 'orphan' > "$LAB/progress/.guarded-blobs/0000000000000000000000000000000000000000"
  local sha; sha=$(approved_edit "$TARGET" $'\n# approved-1\n')
  integrity > /dev/null
  [ ! -f "$LAB/progress/.guarded-blobs/0000000000000000000000000000000000000000" ] || {
    echo "원장이 참조하지 않는 blob 이 남아 있다"; false; }
  [ -f "$LAB/progress/.guarded-blobs/$sha" ] || { echo "유효 blob 이 지워졌다"; false; }
}
