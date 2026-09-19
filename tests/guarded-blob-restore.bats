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
  # 시험 대상 훅 **셋**을 작업 트리에서 가져온다. `lib.sh` 가 빠지면 protected-integrity 가 HEAD 의
  # 옛 lib.sh 를 읽어 복구 화이트리스트를 모른 채 **모든 파일을 HEAD 로** 돌린다 — fail-closed
  # 폴백이 설계대로 작동하는 것이지만, 시험하려는 코드를 시험하지 않게 된다(5차 회전 실측).
  cp "$BATS_TEST_DIRNAME/../hooks/protected-integrity.sh" \
     "$BATS_TEST_DIRNAME/../hooks/invariant-guard.sh" \
     "$BATS_TEST_DIRNAME/../hooks/lib.sh" "$LAB/hooks/"
  cd "$LAB" || return 1
  git init -q .
  git add -A
  git -c user.email=t@t -c user.name=t commit -qm base
  # **대표 복구 대상은 내용 규칙이 있는 데이터 파일이다(F78 5차 회전, ADR-009).** 4차 판정까지는
  # `hooks/lib.sh` 를 썼는데, 이제 심사 통과분(blob)으로 되살리는 것은 invariant-guard 가 **보안
  # 의미를 온전히 검사하는 파일**뿐이다(`BLOB_RESTORABLE_GLOBS`). 코드 파일은 HEAD 로 돌아간다.
  # 그래서 복구 의미를 검사하는 테스트는 임계값 규칙이 걸린 이 파일을 쓴다. 가드 자체의 동작을
  # 보는 테스트는 `hooks/lib.sh` 를 **명시적으로** 쓴다 — 이 JSON 에 텍스트를 덧붙이면 가드가
  # 'JSON 이 깨졌다'는 다른 이유로 거부해 그 테스트가 아무것도 검사하지 않게 된다.
  TARGET="progress/harness-config.json"
}

# JSON 보호 파일에 표식을 **JSON 을 깨지 않고** 남긴다(`_edits` 키에 이어 붙인다). 임계값 키는
# 건드리지 않으므로 invariant-guard 의 재심사를 통과하는 정상 편집이다.
json_mark() {  # $1 파일(LAB 상대), $2 표식
  local f="$LAB/$1" tmp
  tmp=$(mktemp)
  jq --arg m "$2" '._edits = ((._edits // "") + $m)' "$f" > "$tmp" && mv "$tmp" "$f"
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
  case "$f" in
    *.json) json_mark "$f" "$text" ;;
    *)      printf '%s' "$text" >> "$LAB/$f" ;;
  esac
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

# 방화벽 판정 하나. **조용히 allow 로 떨어지지 않는다** — 훅이 죽거나 출력이 깨지면 `ERROR` 를
# 돌려준다. 이전 판은 `|| printf 'allow'` 라, 프로브가 고장 나면 누수와 구별되지 않았다.
fw_decide() {  # $1 방화벽 경로, $2 명령
  local fw="$1" cmd="$2" out dec
  out=$( cd "$LAB" && jq -n --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}' \
           | CLAUDE_PROJECT_DIR="$LAB" bash "$fw" 2>/dev/null ) || { printf 'ERROR'; return 0; }
  if [[ -z "$out" ]]; then printf 'allow'; return 0; fi   # 무출력 = 판정 없음 = allow
  dec=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // empty' 2>/dev/null)
  [[ -n "$dec" ]] || { printf 'ERROR'; return 0; }
  printf '%s' "$dec"
}

@test "F78 3차 판정: 상태 파일 × 별칭 × 쓰기 수단 — 빈 셀 없이 전수 차단(생성, Bash 경로)" {
  # 3차 판정의 핵심 지적: 2차의 생성기가 곱을 만들면서 **셀을 비운 채** 통과했다. 별칭 축이
  # `.guarded-blobs` 에만 값을 주고 나머지 세 이름에는 `alias_base=""` 였고, 백도어는 정확히
  # 그 빈 셀(파일 대상 심볼릭 링크)에 있었다. 그래서 여기서는 (1) 네 이름 **모두**에 별칭을
  # 만들고, (2) **생성된 셀 수 자체를 핀**한다 — 생성기가 조용히 셀을 비우면 곱이 아니라 셀 수가
  # 먼저 걸린다. 쓰기 수단은 열거로 막는 것이 아니라 **대상 경로**로 판정하므로, 계약이 적어 둔
  # `python3 -c`·`perl -e` 도 같은 판정에 걸려야 한다.
  local fw="$BATS_TEST_DIRNAME/../hooks/pre-bash-firewall.sh"
  local n suffix tmpl target d fails=() cells=0 targets
  mkdir -p "$LAB/progress/.guarded-blobs"
  # 별칭은 **매달린 채로** 둔다(대상 파일을 만들지 않는다) — 실제 공격이 그렇다: 아직 없는
  # 대장을 심는 것이 곧 위조다. `readlink` 는 대상 존재와 무관하게 링크를 읽는다.
  while IFS= read -r n; do
    ( cd "$LAB/progress" && ln -sfn "$n" "alias-${n#.}" )
  done < <(guarded_state_names)
  while IFS= read -r n; do
    suffix=""; [[ "$n" == ".guarded-blobs" ]] && suffix="/abc"
    targets=(
      "progress/$n$suffix"                 # 철자
      "progress/alias-${n#.}$suffix"       # 심볼릭 링크 별칭(파일·디렉터리 모두)
      "$LAB/progress/$n$suffix"            # 절대 경로
      "progress//$n$suffix"                # 이중 슬래시
    )
    [[ ${#targets[@]} -eq 4 ]] || { echo "별칭 축이 비었다: $n"; return 1; }
    for tmpl in 'printf x > %s' 'printf x >> %s' 'cp /tmp/e %s' 'dd if=/dev/zero of=%s' 'tee %s' \
                "python3 -c \"open('%s','w').write('x')\"" "perl -e \"open(F,'>','%s')\""; do
      for target in "${targets[@]}"; do
        cells=$((cells + 1))
        # shellcheck disable=SC2059
        d=$(fw_decide "$fw" "$(printf "$tmpl" "$target")")
        [ "$d" = "allow" ] && fails+=("$(printf "$tmpl" "$target") -> allow")
        [ "$d" = "ERROR" ] && fails+=("$(printf "$tmpl" "$target") -> 프로브 오류")
      done
    done
  done < <(guarded_state_names)
  # 이름 4 × 별칭 4 × 쓰기 수단 7 = 112. 이 수가 곧 '빈 셀이 없다'는 증거다.
  [ "$cells" -eq 112 ] || { echo "생성된 셀이 112개가 아니다: $cells"; return 1; }
  [[ ${#fails[@]} -eq 0 ]] || { printf 'LEAK %s\n' "${fails[@]}"; return 1; }
}

@test "F78 3차 판정: 상태 파일 이름은 모두 점으로 시작한다 (방화벽 빠른 기각의 전제)" {
  # `__guarded_state_write_target()` 은 토큰에 점으로 시작하는 요소가 없으면 철자 판정을
  # 건너뛴다 — 경로 800개짜리 평범한 명령을 예산 안에 끝내기 위한 기각이다. 그 기각이 옳으려면
  # **모든 상태 파일 이름이 `.` 로 시작**해야 한다. 이름을 하나 추가하면서 이 성질을 깨면
  # 그 이름에 대한 철자 판정이 조용히 사라지므로, 여기서 고정한다.
  local n bad=()
  while IFS= read -r n; do
    case "$n" in .*) ;; *) bad+=("$n") ;; esac
  done < <(guarded_state_names)
  [[ ${#bad[@]} -eq 0 ]] || {
    printf '점으로 시작하지 않는 상태 파일 이름: %s\n' "${bad[@]}"
    echo "방화벽의 빠른 기각(case .*|*/.*)을 함께 고쳐야 한다"; return 1; }
}

@test "F78 3차 판정: 실체 판정 상한을 넘기면 allow 가 아니라 ask 로 떨어진다 (fail-closed)" {
  # `__guarded_state_write_target()` 의 상한 초과는 종전에 `return 1`, 즉 **allow** 였다.
  # 상한 초과는 '모른다'는 뜻이지 안전하다는 뜻이 아니다(F65 32차가 래퍼 탐지 예산에서 이미
  # 같은 결론을 냈다). **상한에 실제로 닿는 명령으로 잰다** — 철자로 잡히는 대상을 쓰면 판정이
  # 그 앞에서 끝나 상한이 발동하지 않고, 테스트가 아무것도 검사하지 않는다(변이 N2 가 그 사실을
  # 잡아냈다). 그래서 부모가 심볼릭 링크인 토큰만 스무 개 늘어놓아 비싼 판정의 예산을 소진시킨다.
  local fw="$BATS_TEST_DIRNAME/../hooks/pre-bash-firewall.sh" pad="" i d
  mkdir -p "$LAB/progress/.guarded-blobs"
  ( cd "$LAB/progress" && ln -sfn . L && ln -sfn .guarded-restore rr )
  for ((i = 0; i < 20; i++)); do pad="$pad progress/L/x$i.txt"; done
  d=$(fw_decide "$fw" "cp$pad progress/rr")
  [ "$d" != "allow" ] || { echo "실체 판정 상한 밖으로 밀려 통과했다"; return 1; }
  [ "$d" != "ERROR" ] || { echo "프로브 오류"; return 1; }
}

@test "F78 3차 판정: 앞 토큰이 많아도 철자로 지목된 상태 파일은 통과하지 않는다" {
  local fw="$BATS_TEST_DIRNAME/../hooks/pre-bash-firewall.sh" pad="" i d
  mkdir -p "$LAB/progress/.guarded-blobs"
  for ((i = 0; i < 12; i++)); do pad="$pad a/b$i.txt"; done
  d=$(fw_decide "$fw" "cp$pad progress/.guarded-edits")
  [ "$d" != "allow" ] || { echo "토큰이 많다는 이유로 통과했다"; return 1; }
  [ "$d" != "ERROR" ] || { echo "프로브 오류"; return 1; }
}

@test "F78 3차 판정: cd 로 기준을 옮긴 상태 파일 쓰기도 차단된다" {
  local fw="$BATS_TEST_DIRNAME/../hooks/pre-bash-firewall.sh" n d fails=()
  mkdir -p "$LAB/progress/.guarded-blobs"
  while IFS= read -r n; do
    local t="$n"; [[ "$n" == ".guarded-blobs" ]] && t="$n/abc"
    d=$(fw_decide "$fw" "cd progress && printf x > $t")
    [ "$d" = "allow" ] && fails+=("cd progress && printf x > $t -> allow")
    [ "$d" = "ERROR" ] && fails+=("cd progress && printf x > $t -> 프로브 오류")
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
  json_mark "$TARGET" 'COMMITTED-B'
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

# 실제 invariant-guard 를 태워 티켓과 blob 을 받고, 도구가 쓰는 것과 **같은 바이트**를 파일에
# 쓴다. 내용은 `--rawfile` 로 넘긴다 — `$( )` 로 읽으면 후행 개행이 사라져 픽스처 자신이
# 검사하려는 축을 지운다(1·2차 판정이 두 번 지적한 실패 양식).
byte_mint() {  # $1 저장소 상대 경로 · $2 원본 바이트가 든 파일
  jq -n --arg f "$LAB/$1" --rawfile c "$2" \
     '{tool_name:"Write",tool_input:{file_path:$f,content:$c}}' \
    | ( cd "$LAB" && CLAUDE_PROJECT_DIR="$LAB" bash hooks/invariant-guard.sh ) >/dev/null 2>&1
  cp "$2" "$LAB/$1"
}

@test "F78 3차 판정: 복구는 바이트 동일하다 (개행 없이 끝나는 파일·개행 여러 개 포함)" {
  # 3차 판정 실측: blob 저장이 `printf '%s\n' "$NEW_CONTENT"` 이고 `NEW_CONTENT` 는 `$( )` 로
  # 읽혀 후행 개행이 이미 잘려 있다. `file_sha`·`blob_trustworthy` 가 후행 개행을 무시하므로
  # **아무도 그 변형을 관측하지 못한다**(feature_list.json 165674→165675, hooks/lib.sh
  # 9951→9952). 여기서는 `cmp` 로 바이트를 직접 본다.
  # 내용은 HEAD 에 표식 키 하나를 더한 **유효한 JSON** 이다 — 복구 직전 재심사(SC-11)를 통과하는
  # 정상 편집이어야 복구 경로의 바이트를 볼 수 있다. 후행 개행 수만 바꾼다.
  local want="$LAB/.want-bytes" ending base
  base=$( cd "$LAB" && git show "HEAD:$TARGET" | jq -c '. + {"_bytes":"x"}' )
  for ending in none one three; do
    ( cd "$LAB" && git checkout -q -- "$TARGET" )
    case "$ending" in
      none)  printf '%s'       "$base" > "$want" ;;
      one)   printf '%s\n'     "$base" > "$want" ;;
      three) printf '%s\n\n\n' "$base" > "$want" ;;
    esac
    byte_mint "$TARGET" "$want"
    integrity > /dev/null                      # 티켓이 유효하므로 복구가 없어야 한다
    cmp -s "$want" "$LAB/$TARGET" \
      || { echo "$ending: 훅 1회만으로 파일이 바뀌었다 ($(wc -c < "$want") → $(wc -c < "$LAB/$TARGET") 바이트)"; return 1; }
    untracked_write "$TARGET" 'PWNED'
    integrity > /dev/null
    cmp -s "$want" "$LAB/$TARGET" \
      || { echo "$ending: 복구가 바이트 동일하지 않다 ($(wc -c < "$want") → $(wc -c < "$LAB/$TARGET") 바이트)"; return 1; }
  done
}

@test "F78 3차 판정: 훅이 한 번도 돌지 않은 채 훼손돼도 복구는 바이트 동일하다" {
  # 앞의 두 바이트 동일성 테스트는 훼손 전에 훅을 한 번 돌리므로 `promote_blob()` 이 실제
  # 바이트를 올린다 — 그래서 **발행 시점 blob 이 정확한지**는 검사되지 않았다(변이 N5 가 그
  # 사실을 잡아냈다). 여기서는 심사 직후 아무 훅도 돌지 않은 상태에서 훼손한다. 이때 존재하는
  # blob 은 invariant-guard 가 발행 시점에 남긴 것뿐이므로, 그것이 바이트 그대로여야 한다.
  local want="$LAB/.want-mint" base
  base=$( cd "$LAB" && git show "HEAD:$TARGET" | jq -c '. + {"_mint":"x"}' )
  ( cd "$LAB" && git checkout -q -- "$TARGET" )
  printf '%s' "$base" > "$want"                # 개행 없이 끝난다
  byte_mint "$TARGET" "$want"
  untracked_write "$TARGET" 'PWNED'            # 훅 실행 없이 곧바로 훼손
  integrity > /dev/null
  cmp -s "$want" "$LAB/$TARGET" \
    || { echo "발행 시점 blob 이 바이트 그대로가 아니다 ($(wc -c < "$want") → $(wc -c < "$LAB/$TARGET") 바이트)"; return 1; }
}

@test "F78 4차 판정: 같은 내용을 후행 개행만 바꿔 다시 심사받으면 blob 도 새 바이트가 된다" {
  # 내용 주소는 후행 개행을 무시하므로 두 편집이 **같은 sha** 를 받는다. 발행이 '이미 있으면
  # 쓰지 않는다'였다면 먼저 심사받은 바이트가 남아, 곧바로 훼손될 때 옛 바이트로 복구된다.
  local want="$LAB/.want-remint" first="$LAB/.first" base
  base=$( cd "$LAB" && git show "HEAD:$TARGET" | jq -c '. + {"_remint":"x"}' )
  ( cd "$LAB" && git checkout -q -- "$TARGET" )
  printf '%s'     "$base" > "$first"           # 개행 없음
  printf '%s\n\n' "$base" > "$want"            # 같은 내용, 개행 둘
  byte_mint "$TARGET" "$first"
  byte_mint "$TARGET" "$want"                  # 훅 실행 없이 연달아 심사
  untracked_write "$TARGET" 'PWNED'
  integrity > /dev/null
  cmp -s "$want" "$LAB/$TARGET" \
    || { echo "먼저 심사받은 바이트로 복구됐다 ($(wc -c < "$want") 기대 → $(wc -c < "$LAB/$TARGET") 바이트)"; return 1; }
}

# Edit·MultiEdit 로 심사받은 직후, 훅이 한 번도 돌지 않은 채 곧바로 훼손한다(4차 판정 [2]).
# protected-integrity 는 PostToolUse:Bash 에만 걸리므로 'Edit 뒤 첫 Bash 호출이 곧 훼손'인
# 경우가 정확히 이것이다 — 사후 승격이 일어나지 않고, 존재하는 blob 은 발행 시점의 것뿐이다.
edit_then_corrupt() {  # $1 도구(Edit|MultiEdit) · $2 기준 내용 파일 · $3 기대 결과 파일
  local tool="$1" base="$2" want="$3" input
  ( cd "$LAB" && git checkout -q -- "$TARGET" )
  cp "$base" "$LAB/$TARGET"
  ( cd "$LAB" && git add -A && git -c user.email=t@t -c user.name=t commit -qm edit-base )
  if [[ "$tool" == "Edit" ]]; then
    input=$(jq -n --arg f "$LAB/$TARGET" --arg o '"_e":"OLD"' --arg n '"_e":"NEW"' \
      '{tool_name:"Edit",tool_input:{file_path:$f,old_string:$o,new_string:$n}}')
  else
    input=$(jq -n --arg f "$LAB/$TARGET" \
      '{tool_name:"MultiEdit",tool_input:{file_path:$f,edits:[
          {old_string:"\"_e\":\"OLD\"",new_string:"\"_e\":\"MID\""},
          {old_string:"\"_e\":\"MID\"",new_string:"\"_e\":\"NEW\""}]}}')
  fi
  printf '%s' "$input" | ( cd "$LAB" && CLAUDE_PROJECT_DIR="$LAB" bash hooks/invariant-guard.sh ) >/dev/null 2>&1
  cp "$want" "$LAB/$TARGET"                    # 도구가 실제로 쓴 결과
  untracked_write "$TARGET" 'PWNED'            # 훅 실행 없이 곧바로 훼손
  integrity > /dev/null
  cmp -s "$want" "$LAB/$TARGET"
}

@test "F78 4차 판정: Edit·MultiEdit 직후 곧바로 훼손돼도 복구는 바이트 동일하다" {
  local base="$LAB/.edit-base" want="$LAB/.edit-want" core tool ending
  core=$( cd "$LAB" && git show "HEAD:$TARGET" | jq -c '. + {"_e":"OLD"}' )
  for tool in Edit MultiEdit; do
    for ending in none two; do
      case "$ending" in
        none) printf '%s'     "$core" > "$base" ;;
        two)  printf '%s\n\n' "$core" > "$base" ;;
      esac
      sed 's/"_e":"OLD"/"_e":"NEW"/' "$base" > "$want"
      # sed 는 마지막 줄에 개행이 없어도 그대로 둔다(BSD·GNU 공통). 기대값 자체를 한 번 확인한다.
      [ "$(wc -c < "$base")" -eq "$(wc -c < "$want")" ] || { echo "기대값 픽스처가 잘못 만들어졌다"; return 1; }
      edit_then_corrupt "$tool" "$base" "$want" || {
        echo "$tool / 후행 개행 $ending: 복구가 바이트 동일하지 않다 ($(wc -c < "$want") 기대 → $(wc -c < "$LAB/$TARGET") 바이트)"
        return 1; }
    done
  done
}

@test "F78 3차 판정: Edit 경로의 복구도 바이트 동일하다 (예측이 아니라 실제 바이트)" {
  # Write 는 `jq -j` 로 바이트를 그대로 뜰 수 있지만 Edit·MultiEdit 의 결과는 awk 치환을 거쳐
  # 후행 개행이 정규화된다. 그 경로의 정확성은 `promote_blob()` 이 책임진다 — 티켓이 유효하다고
  # 판정된 **디스크의 실제 내용**을 blob 으로 올린다. 이 테스트가 그 승격을 고정한다.
  local want="$LAB/.want-edit" core
  core=$( cd "$LAB" && git show "HEAD:$TARGET" | jq -c '. + {"_e":"OLD"}' )
  ( cd "$LAB" && git checkout -q -- "$TARGET" )
  printf '%s' "$core" > "$LAB/$TARGET"         # 개행 없이 끝나는 파일
  ( cd "$LAB" && git add -A && git -c user.email=t@t -c user.name=t commit -qm edit-base )
  jq -n --arg f "$LAB/$TARGET" --arg o '"_e":"OLD"' --arg n '"_e":"NEW"' \
     '{tool_name:"Edit",tool_input:{file_path:$f,old_string:$o,new_string:$n}}' \
    | ( cd "$LAB" && CLAUDE_PROJECT_DIR="$LAB" bash hooks/invariant-guard.sh ) >/dev/null 2>&1
  printf '%s' "${core/\"_e\":\"OLD\"/\"_e\":\"NEW\"}" > "$want"
  cp "$want" "$LAB/$TARGET"
  integrity > /dev/null                        # 승격이 일어나는 실행
  cmp -s "$want" "$LAB/$TARGET" \
    || { echo "훅 1회만으로 파일이 바뀌었다 ($(wc -c < "$want") → $(wc -c < "$LAB/$TARGET") 바이트)"; return 1; }
  untracked_write "$TARGET" 'PWNED'
  integrity > /dev/null
  cmp -s "$want" "$LAB/$TARGET" \
    || { echo "Edit 경로의 복구가 바이트 동일하지 않다 ($(wc -c < "$want") → $(wc -c < "$LAB/$TARGET") 바이트)"; return 1; }
}

@test "F78 3차 판정 종단: blob 주조 → 대장 별칭 쓰기 → 훼손 경로로 임계값을 설치할 수 없다" {
  # 3차 독립 판정이 세 번째로 재현한 백도어의 조립 순서를 그대로 밟는다. 1·2단계는 **정상**
  # 이다 — payload 를 심사에 통과시켜 blob 을 만드는 것은 누구나 할 수 있다. 공격이 성립하는
  # 유일한 자리는 3단계, 즉 **복구 대장에 한 줄을 심는 것**이고 그 줄은 '이 sha 가 저 경로의
  # 심사 통과 내용이다'라는 뜻이다. 그러므로 대장 쓰기에 이르는 모든 표기가 막혀야 한다.
  local fw="$BATS_TEST_DIRNAME/../hooks/pre-bash-firewall.sh" payload sha d
  payload='{"pass_threshold": 1}'
  # 1) 정상 심사로 payload blob 을 주조한다(비보호 경로라 티켓 없이도 통과한다 — 이 단계는 합법).
  mkdir -p "$LAB/progress/.guarded-blobs"
  sha=$( cd "$LAB" && printf '%s' "$payload" | git hash-object --stdin )
  printf '%s' "$payload" > "$LAB/progress/.guarded-blobs/$sha"
  # 2) 대장 별칭을 만든다(심볼릭 링크 생성 자체는 막지 않는다).
  ( cd "$LAB/progress" && ln -sfn .guarded-restore rr )
  # 3) 대장에 줄을 심는 모든 표기가 allow 가 아니어야 한다.
  local head_at; head_at=$( cd "$LAB" && git rev-parse --verify -q HEAD )
  local line="$sha $head_at progress/harness-config.json"
  local fails=()
  local c
  for c in "printf '%s\\n' '$line' >> progress/rr" \
           "printf '%s\\n' '$line' >> progress/.guarded-restore" \
           "printf '%s\\n' '$line' >> $LAB/progress/rr" \
           "cd progress && printf '%s\\n' '$line' >> rr" \
           "python3 -c \"open('progress/rr','a').write('$line')\"" \
           "tee -a progress/rr"; do
    d=$(fw_decide "$fw" "$c")
    [ "$d" = "allow" ] && fails+=("$c -> allow")
    [ "$d" = "ERROR" ] && fails+=("$c -> 프로브 오류")
  done
  [[ ${#fails[@]} -eq 0 ]] || { printf '백도어 경로가 열려 있다: %s\n' "${fails[@]}"; return 1; }
  # 방화벽을 지나지 못했으므로 임계값은 그대로여야 한다.
  grep -q '"pass_threshold": *7' "$LAB/progress/harness-config.json" \
    || { echo "임계값이 7 이 아니다"; return 1; }
}

@test "F78 3차 판정: blob 저장소에 쓸 수 없으면 편집이 차단된다 (error_scenario)" {
  # 계약의 error_scenario: '티켓을 발행할 수 없으면 편집을 통과시키지 않는다'(AC-3). 세 라운드
  # 내내 rc=0 이었고, 그 결과 **원장에는 줄이 있고 blob 에는 내용이 없는 손실 상태**가 만들어졌다
  # — 복구할 내용이 없으니 HEAD 로 내려간다. 조용한 통과가 곧 손실인 자리다.
  # 대상은 `hooks/lib.sh` 로 **명시**한다 — 임계값 JSON 에 텍스트를 덧붙이면 가드가 'JSON 이
  # 깨졌다'는 다른 이유로 rc=2 를 내 이 테스트가 헛돈다(5차 회전에서 대표 대상을 바꾸며 확인).
  local g="hooks/lib.sh" rc
  mkdir -p "$LAB/progress/.guarded-blobs"
  chmod 500 "$LAB/progress/.guarded-blobs"
  rc=$(guard_rc "$LAB/$g" "$(cat "$LAB/$g")
# blob-store-readonly")
  chmod 700 "$LAB/progress/.guarded-blobs"
  [ "$rc" = "2" ] || { echo "blob 을 쓸 수 없는데 편집이 통과했다 (rc=$rc)"; return 1; }
}

@test "F78 4차 판정: blob 을 쓰는 도중 디스크가 가득 차면 편집이 차단된다 (error_scenario, E10)" {
  # 4차 판정의 생존 변이 E10: 'blob 쓰기 실패 → 차단' 분기 중 **쓰기 자체가 실패**하는 경우가
  # 테스트되지 않았다(위 테스트는 임시 파일 생성 단계에서 실패한다). `ulimit -f 0` 으로 파일
  # 크기 한도를 0 으로 두면 첫 바이트를 쓰는 순간 실패한다 — 디스크 가득 참과 같은 증상이다.
  # SIGXFSZ 는 기본 동작이 종료이므로 무시하도록 물려준다(무시된 신호는 exec 를 넘어 상속된다).
  local g="hooks/lib.sh" input rc=0
  input=$(jq -n --arg f "$LAB/$g" --arg c "$(cat "$LAB/$g")
# disk-full" '{tool_name:"Write",tool_input:{file_path:$f,content:$c}}')
  printf '%s' "$input" | ( cd "$LAB" && trap '' XFSZ && ulimit -f 0 \
      && CLAUDE_PROJECT_DIR="$LAB" bash "$LAB/hooks/invariant-guard.sh" ) >/dev/null 2>&1 || rc=$?
  [ "$rc" = "2" ] || { echo "blob 을 쓰지 못했는데 편집이 통과했다 (rc=$rc)"; return 1; }
  if grep -q " $g\$" "$LAB/progress/.guarded-edits" 2>/dev/null; then
    echo "blob 없이 원장 줄만 남았다 — 손실 상태"; return 1
  fi
}

@test "F78 3차 판정: 원장에 쓸 수 없으면 편집이 차단된다 (error_scenario)" {
  local g="hooks/lib.sh" rc
  mkdir -p "$LAB/progress"
  : > "$LAB/progress/.guarded-edits"
  chmod 400 "$LAB/progress/.guarded-edits"
  rc=$(guard_rc "$LAB/$g" "$(cat "$LAB/$g")
# ledger-readonly")
  chmod 600 "$LAB/progress/.guarded-edits"
  [ "$rc" = "2" ] || { echo "원장에 쓸 수 없는데 편집이 통과했다 (rc=$rc)"; return 1; }
}

@test "F78 3차 판정: 원장의 손상된 줄은 무시하되 보고한다 (error_scenario)" {
  # 계약: '손상된 줄만 무시하고 **보고**한다'. 지금까지는 조용히 버렸다 — 원장이 깨졌다는
  # 사실이 사용자에게도 다음 라운드에게도 보이지 않았다. **개수까지 고정한다**(4차 판정의 생존
  # 변이 E8: 개수를 세지 않고 '손상' 이라는 낱말만 찍어도 통과했다).
  mkdir -p "$LAB/progress"
  printf 'GARBAGE\n%040d ../../etc/passwd\nNOT A LINE\n' 1 > "$LAB/progress/.guarded-edits"
  untracked_write "$TARGET" 'PWNED'
  local out; out=$(integrity)
  [[ "$out" == *"손상된 줄 3개"* ]] || { echo "손상된 줄 개수(3)가 보고되지 않았다: $out"; return 1; }
}

@test "F78 4차 판정: 다단 심볼릭 링크 체인으로 상태 파일을 가리켜도 방화벽이 통과시키지 않는다 (E15)" {
  local fw="$BATS_TEST_DIRNAME/../hooks/pre-bash-firewall.sh" d
  mkdir -p "$LAB/progress/.guarded-blobs"
  ( cd "$LAB/progress" && ln -sfn .guarded-restore h1 && ln -sfn h1 h2 && ln -sfn h2 h3 )
  d=$(fw_decide "$fw" "printf x >> progress/h3")
  [ "$d" != "allow" ] || { echo "3단 체인이 allow 다"; return 1; }
  [ "$d" != "ERROR" ] || { echo "프로브 오류"; return 1; }
}

# ---------------------------------------------------------------------------
# 5차 회전(2026-09-19) — 방어를 **출구**로 옮긴다 (SC-11, ADR-009).
# 1~4차는 저장소로 가는 입구를 하나씩 막았고 판정자는 매번 다음 표기를 찾았다. 여기서는
# 입구가 샜다고 **가정**하고(위조를 랩에 직접 심는다) 출구가 막는지를 본다.
# ---------------------------------------------------------------------------

# 복구 목표 저장소에 위조를 직접 심는다 — 방화벽이 어떤 표기로 샜든 결과는 이것과 같다.
plant_forgery() {  # $1 저장소 상대 경로 · $2 위조 내용이 든 파일
  local sha head_at
  sha=$( cd "$LAB" && printf '%s' "$(cat "$2")" | git hash-object --stdin )
  head_at=$( cd "$LAB" && git rev-parse --verify -q HEAD )
  mkdir -p "$LAB/progress/.guarded-blobs"
  cp "$2" "$LAB/progress/.guarded-blobs/$sha"
  printf '%s %s %s\n' "$sha" "$head_at" "$1" >> "$LAB/progress/.guarded-restore"
}

# 위조를 심고 대상을 훼손한 뒤 훅을 돌린다. 대상이 HEAD 로 돌아왔으면 0.
forgery_blocked() {  # $1 경로 · $2 위조 파일 · $3 위조에만 있는 표식
  local head; head=$( cd "$LAB" && git show "HEAD:$1" | cksum )
  plant_forgery "$1" "$2"
  untracked_write "$1" 'PWNED'
  FORGERY_OUT=$(integrity)
  if grep -q -- "$3" "$LAB/$1" 2>/dev/null; then return 1; fi
  [ "$(cksum < "$LAB/$1")" = "$head" ]
}

@test "F78 5차 회전 SC-11: 복구 저장소에 위조를 심어도 약화 네 부류는 설치되지 않는다" {
  local ev="$LAB/.ev" fid
  # (1) 임계값 하향 — 내용 규칙이 있는 데이터 파일이므로 **재심사**가 막는다.
  ( cd "$LAB" && git show HEAD:progress/harness-config.json ) \
    | jq '.scoring.pass_threshold = 1 | ._forged = "FORGED-THRESHOLD"' > "$ev"
  # 픽스처가 **실제로** 약화인지 먼저 확인한다 — 첫 시도는 최상위에 같은 이름의 키를 만들어
  # 규칙이 보지 않는 값을 바꿨고, 가드는 옳게 통과시켰다(시험이 헛돌았다).
  [ "$(jq -r '.scoring.pass_threshold' "$ev")" = "1" ] \
    && [ "$( cd "$LAB" && git show HEAD:progress/harness-config.json | jq -r '.scoring.pass_threshold')" -gt 1 ] \
    || { echo "픽스처가 임계값을 낮추지 않는다"; return 1; }
  forgery_blocked progress/harness-config.json "$ev" FORGED-THRESHOLD \
    || { echo "임계값 하향 위조가 설치됐다: $FORGERY_OUT"; return 1; }
  [[ "$FORGERY_OUT" == *"재심사"* ]] || { echo "재심사 거부 사유가 보고되지 않았다: $FORGERY_OUT"; return 1; }
  # (2) 근거 없는 passes 전환 — 판정 기록이 없는 기능을 true 로.
  fid=$( cd "$LAB" && git show HEAD:progress/feature_list.json | jq -r '[.features[] | select(.passes == false)][0].id' )
  [[ -n "$fid" && "$fid" != "null" ]] || { echo "passes:false 기능을 찾지 못해 픽스처를 만들 수 없다"; return 1; }
  ( cd "$LAB" && git show HEAD:progress/feature_list.json ) \
    | jq --arg id "$fid" '(.features[] | select(.id == $id) | .passes) = true | ._forged = "FORGED-PASSES"' > "$ev"
  forgery_blocked progress/feature_list.json "$ev" FORGED-PASSES \
    || { echo "근거 없는 passes 전환 위조가 설치됐다: $FORGERY_OUT"; return 1; }
  # (3) @test 감소 — 코드 파일이므로 **화이트리스트 밖**이다: blob 을 쓰지 않고 HEAD 로 간다.
  printf '#!/usr/bin/env bats\n# FORGED-TESTS\n' > "$ev"
  forgery_blocked tests/protected-integrity.bats "$ev" FORGED-TESTS \
    || { echo "@test 감소 위조가 설치됐다: $FORGERY_OUT"; return 1; }
  # (4) 차단 로직 감소 — 역시 코드 파일.
  ( cd "$LAB" && git show HEAD:hooks/invariant-guard.sh ) | sed '1a\
exit 0 # FORGED-GUARD' > "$ev"
  forgery_blocked hooks/invariant-guard.sh "$ev" FORGED-GUARD \
    || { echo "차단 로직 무력화 위조가 설치됐다: $FORGERY_OUT"; return 1; }
}

@test "F78 5차 회전: 4차 판정의 종단 랩 — lib.sh 에 심은 has_jq 백도어가 설치되지 않는다" {
  # 판정자 labC7 의 페이로드 그대로다. invariant-guard 는 lib.sh 의 내용을 검사하지 않으므로
  # **정상 Write 로도 같은 내용이 통과한다**(5차 회전 실측 rc=0). 그래서 재심사로는 막히지 않고,
  # 코드 파일을 심사 통과분으로 되살리지 않는다는 결정(화이트리스트)이 막는다.
  local ev="$LAB/.ev-lib"
  cp "$LAB/hooks/lib.sh" "$ev"
  printf '\nhas_jq() { return 1; }  # BACKDOOR-EV4\n' >> "$ev"
  forgery_blocked hooks/lib.sh "$ev" BACKDOOR-EV4 \
    || { echo "lib.sh 백도어가 설치됐다: $FORGERY_OUT"; return 1; }
  [[ "$FORGERY_OUT" == *"hooks/lib.sh"* ]] || { echo "복구 보고에 경로가 없다: $FORGERY_OUT"; return 1; }
}

@test "F78 5차 회전: 셸 확장 표기로 심은 위조도 출구에서 거부된다 (4차 판정 labB4)" {
  # 방화벽이 어떤 표기를 놓쳤는지와 무관하게 결과가 같아야 한다 — 실제로 셸 확장 표기로 심는다.
  local ev="$LAB/.ev-sh" sha head_at mode
  for mode in bs brace py; do
    ( cd "$LAB" && git checkout -q -- progress/harness-config.json && rm -rf progress/.guarded-blobs progress/.guarded-restore )
    ( cd "$LAB" && git show HEAD:progress/harness-config.json ) \
      | jq '.scoring.pass_threshold = 1 | ._forged = "FORGED-SHELL"' > "$ev"
    sha=$( cd "$LAB" && printf '%s' "$(cat "$ev")" | git hash-object --stdin )
    head_at=$( cd "$LAB" && git rev-parse HEAD )
    mkdir -p "$LAB/progress/.guarded-blobs"
    case "$mode" in
      bs)    ( cd "$LAB" && bash -c "cp '$ev' progress/.guarded\\-blobs/$sha && printf '%s %s %s\\n' $sha $head_at progress/harness-config.json >> progress/.guarded\\-restore" ) ;;
      brace) ( cd "$LAB" && bash -c "cp '$ev' progress/.guarded-{blobs,zz}/$sha 2>/dev/null; cp '$ev' progress/.guarded\\-blobs/$sha; printf '%s %s %s\\n' $sha $head_at progress/harness-config.json | tee -a progress/.guarded-{restore,zz} >/dev/null" ) ;;
      py)    command -v python3 >/dev/null || continue
             ( cd "$LAB" && python3 -c "import shutil;shutil.copy('$ev','progress/.guarded-'+'blobs/$sha');open('progress/.guarded-'+'restore','a').write('$sha $head_at progress/harness-config.json\n')" ) ;;
    esac
    untracked_write progress/harness-config.json 'PWNED'
    integrity > /dev/null
    if grep -q FORGED-SHELL "$LAB/progress/harness-config.json"; then
      echo "$mode 표기로 심은 위조가 설치됐다"; return 1
    fi
  done
}

@test "F78 5차 회전: 정상 심사를 통과한 편집은 재심사도 통과해 그대로 복구된다 (반대 방향)" {
  # 재심사가 정당한 복구까지 막으면 F78 이 되돌리려던 손실이 다른 모양으로 돌아온다.
  local g input
  # 임계값 **상향**은 정상 편집이다.
  g="progress/harness-config.json"
  # 임계값의 실제 위치는 `.scoring.pass_threshold` 다 — 최상위에 같은 이름의 키를 만들면 규칙이
  # 보지 않는 키라 아무것도 검사하지 않는다(5차 회전 첫 시도의 픽스처 결함).
  input=$( cd "$LAB" && jq '.scoring.pass_threshold = 8' "$g" )
  jq -n --arg f "$LAB/$g" --arg c "$input" '{tool_name:"Write",tool_input:{file_path:$f,content:$c}}' \
    | ( cd "$LAB" && CLAUDE_PROJECT_DIR="$LAB" bash hooks/invariant-guard.sh ) >/dev/null 2>&1
  printf '%s\n' "$input" > "$LAB/$g"
  untracked_write "$g" 'PWNED'
  integrity > /dev/null
  [ "$(jq -r '.scoring.pass_threshold' "$LAB/$g" 2>/dev/null)" = "8" ] \
    || { echo "정상 임계값 상향이 복구되지 않았다: $(head -c 80 "$LAB/$g")"; return 1; }
  # feature_list 의 설명 편집도 정상 편집이다.
  g="progress/feature_list.json"
  input=$( cd "$LAB" && jq '.features[0].description += " (LEGIT-DESC)"' "$g" )
  jq -n --arg f "$LAB/$g" --arg c "$input" '{tool_name:"Write",tool_input:{file_path:$f,content:$c}}' \
    | ( cd "$LAB" && CLAUDE_PROJECT_DIR="$LAB" bash hooks/invariant-guard.sh ) >/dev/null 2>&1
  printf '%s\n' "$input" > "$LAB/$g"
  untracked_write "$g" 'PWNED'
  integrity > /dev/null
  grep -q 'LEGIT-DESC' "$LAB/$g" || { echo "정상 feature_list 편집이 복구되지 않았다"; return 1; }
}

@test "F78 5차 회전: 재심사를 실행할 수 없으면 blob 을 설치하지 않는다 (fail-closed)" {
  # 운영에서 훅은 플러그인 설치본(저장소 밖)에서 돈다. 그 배치를 흉내 내 **저장소 밖 훅 디렉터리**
  # 에 protected-integrity 와 lib.sh 만 두고 invariant-guard 는 두지 않는다. 저장소 안의
  # hooks/invariant-guard.sh 를 치우는 방식은 같은 실행이 그 파일을 HEAD 로 먼저 복구해 버려
  # 이 경우를 시험하지 못한다.
  local bin; bin=$(mktemp -d)
  cp "$LAB/hooks/protected-integrity.sh" "$LAB/hooks/lib.sh" "$bin/"
  approved_edit "$TARGET" $'\n# approved-1\n' > /dev/null
  local head; head=$( cd "$LAB" && git show "HEAD:$TARGET" | cksum )
  untracked_write "$TARGET" 'PWNED'
  local out; out=$( cd "$LAB" && CLAUDE_PROJECT_DIR="$LAB" bash "$bin/protected-integrity.sh" 2>&1 )
  rm -rf "$bin"
  [ "$(cksum < "$LAB/$TARGET")" = "$head" ] || { echo "재심사 없이 blob 이 설치됐다"; return 1; }
  [[ "$out" == *"재심사기"* ]] || { echo "재심사 불가 사유가 보고되지 않았다: $out"; return 1; }
}

@test "F78 5차 회전: 재심사기가 0·2 외의 코드로 끝나면 설치하지 않는다 (fail-closed)" {
  # 재심사기가 **실행은 됐지만** 판정을 내지 못한 경우(크래시·의존성 부재 등)다. 거부(2)가
  # 아니라고 통과로 읽으면 재심사가 조용히 꺼진다.
  local bin; bin=$(mktemp -d)
  cp "$LAB/hooks/protected-integrity.sh" "$LAB/hooks/lib.sh" "$bin/"
  printf '#!/usr/bin/env bash\nexit 1\n' > "$bin/invariant-guard.sh"
  approved_edit "$TARGET" $'\n# approved-1\n' > /dev/null
  local head; head=$( cd "$LAB" && git show "HEAD:$TARGET" | cksum )
  untracked_write "$TARGET" 'PWNED'
  local out; out=$( cd "$LAB" && CLAUDE_PROJECT_DIR="$LAB" bash "$bin/protected-integrity.sh" 2>&1 )
  rm -rf "$bin"
  [ "$(cksum < "$LAB/$TARGET")" = "$head" ] || { echo "판정 없는 재심사로 blob 이 설치됐다"; return 1; }
  [[ "$out" == *"재심사 실행 실패"* ]] || { echo "재심사 실패 사유가 보고되지 않았다: $out"; return 1; }
}

@test "F78 5차 회전: lib.sh 를 읽지 못하면 화이트리스트가 비어 모든 파일이 HEAD 로 돌아간다 (fail-closed)" {
  # 화이트리스트의 출처가 사라졌을 때 '전부 허용'으로 떨어지면 목록이 곧 무의미해진다.
  local bin; bin=$(mktemp -d)
  cp "$LAB/hooks/protected-integrity.sh" "$LAB/hooks/invariant-guard.sh" "$bin/"   # lib.sh 없음
  approved_edit "$TARGET" $'\n# approved-1\n' > /dev/null
  local head; head=$( cd "$LAB" && git show "HEAD:$TARGET" | cksum )
  untracked_write "$TARGET" 'PWNED'
  ( cd "$LAB" && CLAUDE_PROJECT_DIR="$LAB" bash "$bin/protected-integrity.sh" >/dev/null 2>&1 )
  rm -rf "$bin"
  [ "$(cksum < "$LAB/$TARGET")" = "$head" ] || { echo "화이트리스트 출처 없이 blob 이 설치됐다"; return 1; }
}

@test "F78 5차 회전: 화이트리스트 밖 파일은 HEAD 로 돌아가되 심사 통과분의 위치를 알려 준다" {
  # 결정(ADR-009): 코드 파일은 심사 통과분으로 되살리지 않는다. 대신 그 내용을 잃지 않도록
  # blob 위치와 '다시 적용하려면 Edit/Write 로' 라는 안내를 보고에 싣는다.
  local g="hooks/lib.sh" sha
  sha=$(approved_edit "$g" $'\n# approved-code\n')
  untracked_write "$g" 'PWNED'
  local out; out=$(integrity)
  grep -q 'approved-code' "$LAB/$g" && { echo "코드 파일이 blob 으로 되살아났다"; return 1; }
  [[ "$out" == *"$sha"* ]] || { echo "심사 통과분의 위치(blob sha)가 보고되지 않았다: $out"; return 1; }
  [ -f "$LAB/progress/.guarded-blobs/$sha" ] || { echo "심사 통과분 blob 이 사라졌다"; return 1; }
}

# 면제 원장에 **현재 내용**의 티켓을 위조한다 — 이 줄이 있으면 protected-integrity 는 그 파일을
# '심사를 통과한 편집'으로 보고 복구하지 않는다. 방화벽이 어떤 표기로 샜든 결과는 이것과 같다.
forge_exemption() {  # $1 저장소 상대 경로
  local sha head_at
  sha=$( cd "$LAB" && printf '%s' "$(cat "$1")" | git hash-object --stdin )
  head_at=$( cd "$LAB" && git rev-parse --verify -q HEAD )
  printf '%s %s %s\n' "$sha" "$head_at" "$1" >> "$LAB/progress/.guarded-edits"
}

@test "F78 5차 회전: 면제 원장을 위조해도 낮춘 임계값은 남지 않는다 (면제 경로 재심사)" {
  # 복구 경로만 재심사하면 **면제 경로**가 남는다: 낮춘 임계값에 위조 티켓을 붙이면 훅은 그것을
  # 심사 통과분으로 보고 **아예 복구하지 않았다**. 복구 위조보다 한 단계 짧은 공격이다.
  local g="progress/harness-config.json"
  ( cd "$LAB" && jq '.scoring.pass_threshold = 1' "$g" > "$g.tmp" && mv "$g.tmp" "$g" )
  forge_exemption "$g"
  local out; out=$(integrity)
  [ "$(jq -r '.scoring.pass_threshold' "$LAB/$g")" != "1" ] \
    || { echo "위조 면제로 낮춘 임계값이 그대로 남았다: $out"; return 1; }
  [[ "$out" == *"원장 위조 가능성"* ]] || { echo "면제 거부가 보고되지 않았다: $out"; return 1; }
}

@test "F78 5차 회전: 재심사의 임계값은 작업 트리가 아니라 HEAD 에서 온다 (보조 입력)" {
  # passes 전환 심사는 판정 점수를 임계값과 비교한다. 재심사가 **작업 트리의** 임계값을 읽으면,
  # 먼저 임계값을 낮춰(위조 면제로 남겨) 두고 낮은 점수의 판정 기록으로 passes 를 위조할 수 있다.
  # 분류 단계는 모든 파일을 본 뒤에 복구하므로, feature_list 를 볼 때 낮춘 임계값은 아직 디스크에
  # 있다 — 재심사가 그 값을 읽는지 HEAD 판을 읽는지가 결과를 가른다(변이 P3 가 살아남은 자리).
  local g="progress/harness-config.json" fl="progress/feature_list.json" fid now
  fid=$( cd "$LAB" && jq -r '[.features[] | select(.passes == false)][0].id' "$fl" )
  [[ -n "$fid" && "$fid" != "null" ]] || { echo "passes:false 기능이 없어 픽스처를 만들 수 없다"; return 1; }
  now=$(date +%s)
  # 판정 근거: pass 판정이지만 점수가 3 — HEAD 임계값(7)에는 못 미치고 낮춘 임계값(2)은 넘는다.
  jq -n --arg id "$fid" '{verdict:"pass", features_evaluated:[$id],
      scores:{functionality:3,code_quality:3,security:3,error_handling:3,test_coverage:3}}' \
    > "$LAB/progress/agent-comms/evaluator-feedback-9999-12-31T00-00-00+0900.json"
  printf '{"epoch": %s}\n' "$now" >> "$LAB/progress/agent-comms/evaluator-runs.jsonl"
  # 임계값을 2 로 낮추고 위조 면제를 붙인다.
  ( cd "$LAB" && jq '.scoring.pass_threshold = 2 | .scoring.security_thresholds.critical = 2' "$g" > "$g.tmp" && mv "$g.tmp" "$g" )
  forge_exemption "$g"
  # passes 를 위조하고 위조 면제를 붙인다.
  ( cd "$LAB" && jq --arg id "$fid" '(.features[] | select(.id == $id) | .passes) = true' "$fl" > "$fl.tmp" && mv "$fl.tmp" "$fl" )
  forge_exemption "$fl"
  integrity > /dev/null
  [ "$( cd "$LAB" && jq -r --arg id "$fid" '.features[] | select(.id == $id) | .passes' "$fl" )" = "false" ] \
    || { echo "낮춘 임계값에 기대 위조한 passes 가 남았다"; return 1; }
}

@test "F78 5차 회전: 화이트리스트 목록 자체를 고정한다" {
  # 목록이 조용히 넓어지면(예: hooks/*.sh 추가) 코드 파일 위조가 다시 설치된다. 생성 규칙
  # 테스트에서 목록을 단일 출처로 읽다가 변이가 살아남았던 것과 같은 이유로 여기서 핀한다.
  # shellcheck disable=SC1090
  source "$BATS_TEST_DIRNAME/../hooks/lib.sh"
  local got; got=$(printf '%s\n' "${BLOB_RESTORABLE_GLOBS[@]}" | sort | tr '\n' ' ')
  [ "$got" = "progress/approval-queue.json progress/contracts/sprint-*.json progress/feature_list.json progress/harness-config.json templates/progress/harness-config.json " ] \
    || { echo "화이트리스트가 바뀌었다: $got"; return 1; }
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
