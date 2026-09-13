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
  printf '%s %s\n' "$sha" "$f" >> "$LAB/progress/.guarded-edits"
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

@test "F78: 참조되지 않는 blob 은 정리된다" {
  mkdir -p "$LAB/progress/.guarded-blobs"
  printf 'orphan' > "$LAB/progress/.guarded-blobs/0000000000000000000000000000000000000000"
  local sha; sha=$(approved_edit "$TARGET" $'\n# approved-1\n')
  integrity > /dev/null
  [ ! -f "$LAB/progress/.guarded-blobs/0000000000000000000000000000000000000000" ] || {
    echo "원장이 참조하지 않는 blob 이 남아 있다"; false; }
  [ -f "$LAB/progress/.guarded-blobs/$sha" ] || { echo "유효 blob 이 지워졌다"; false; }
}
