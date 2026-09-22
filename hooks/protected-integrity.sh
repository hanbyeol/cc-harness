#!/usr/bin/env bash
#
# protected-integrity.sh — 검증 장치의 무결성을 사후 탐지·복구로 지킨다 (F65)
#
# ## 왜 예측이 아니라 탐지인가
#
# 이전 모델은 Bash 명령 **문자열**로 "이 명령이 보호 파일을 쓸 것인가"를 미리 판단했다.
# 그 질문은 결정 불가능하다 — 셸도, 셸이 부르는 도구도 튜링 완전하므로 실행하지 않고
# 효과를 알 수 없다. F63이 10회전을 시도했고 매번 새 우회 표기가 나왔다.
# 반면 "파일이 바뀌었는가"는 사후에 자명하며 도구·표기와 무관하다.
#
# ## 이 훅이 지키는 불변식
#
#   보호 파일의 내용은 HEAD와 같거나, 그 변경이 invariant-guard 심사를 거친 것이어야 한다.
#
# ## 복구는 절대 작업을 파괴하지 않는다 (1차 판정 반영)
#
# 첫 구현은 무조건 `git checkout HEAD --` 였고, 그것이 `git stash pop` 으로 되살린 작업을
# 되돌렸다 — stash는 이미 버려진 뒤라 **비가역 손실**이었다. merge·cherry-pick 충돌 마커도
# 조용히 HEAD로 대체됐다. 마찰을 없애려다 그보다 나쁜 해악을 만든 것이다. 그래서:
#
#   (1) git 작업이 진행 중이면(merge·rebase·cherry-pick·revert·bisect) **복구하지 않고 보고만** 한다.
#       그 상태에서는 워킹트리가 HEAD와 다른 것이 정상이므로 HEAD 비교 자체가 의미가 없다.
#   (2) 복구 전에 현재 내용을 **격리 보관**한다. 되돌린 내용은 언제나 되찾을 수 있다.
#
# ## 티켓 — 심사를 통과한 편집을 식별하는 방법
#
# invariant-guard가 편집을 허용할 때 `<sha> <경로>` 티켓을 남긴다. 이 훅은 파일의 현재
# 내용 해시가 티켓과 일치할 때만 통과시키고 **그 티켓을 소비한다**(줄 삭제).
#  - 경로만 적는 방식은 정당한 편집 한 번이 그 경로를 **영구 면제**로 만들었다.
#  - 소비하지 않는 방식은 테스트 실행이 실 저장소 티켓을 오염시켰다(실제로 209줄까지 쌓였다).
# 티켓 파일 자체는 이 훅이 복구할 수 없으므로 **컨트롤 플레인**이다(방화벽이 예측으로 막는다).
# 셸을 쥔 상대에게 위조 불가능하지는 않다 — INV-14에 그 한계를 적었다.
set -uo pipefail

# **git 이 우리에게 보여 주는 것부터 조작될 수 있다(F78 5차 판정).** `git replace` 는 객체 하나를
# 다른 객체로 바꿔치기하고, 그 한 줄이 `git diff HEAD`·`git show HEAD:<경로>` 를 전부 속인다 —
# 탐지의 기준선과 재심사의 기준선이 동시에 위조된다. 이 훅이 부르는 모든 git 은 replace 를
# 무시한다(설정으로 끌 수 없는 환경 변수이므로 훅 전체에 건다).
export GIT_NO_REPLACE_OBJECTS=1

REPO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$REPO" 2>/dev/null || exit 0
command -v git &>/dev/null || exit 0
GITDIR=$(git rev-parse --git-dir 2>/dev/null) || exit 0

# **복구 가능 화이트리스트와 재심사기(F78 5차 회전, ADR-009).** `lib.sh` 가 목록을, 같은
# 디렉터리의 invariant-guard 가 심사를 맡는다. 둘 다 이 훅과 **같은 설치본**에서 온다 — 저장소의
# 작업 트리 사본이 아니다(작업 트리 쪽은 위조 대상이다).
# lib.sh 를 읽지 못하면 목록은 **비어 있는 것으로** 본다: 모든 파일이 HEAD 로 돌아간다(fail-closed).
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P)"
# shellcheck source=/dev/null
source "$HOOK_DIR/lib.sh" 2>/dev/null || true
WHITELIST_KNOWN=1
if ! declare -f is_blob_restorable >/dev/null 2>&1; then
  is_blob_restorable() { return 1; }
  WHITELIST_KNOWN=0
fi

# 데이터 플레인 — git 추적이라 HEAD로 복구 가능한 검증 장치.
# **invariant-guard의 is_protected()와 같은 집합이어야 한다 — 단, 문서화된 예외는 남는다**
# (F65 4차 판정 이후 step 13: SC-8 테스트는 이 예외 목록을 근거로 두 집합의 대칭차를 기계
# 대조한다). 예외가 아닌 불일치는 그대로 위험이다 — 넓으면 편집 시 티켓이 발급되지 않는
# 파일이 복구 대상에 들어가 정당한 편집이 되돌려지고(실측: hooks/lib.sh 가 그랬다), 좁으면
# 그 경로는 예측도 탐지도 없이 남는다.
# 문서화된 예외:
#   - `protected-integrity.sh` 자신 — is_protected()에는 있지만 여기 없다. 파괴되면 자기를
#     복구할 수 없으므로 컨트롤 플레인이고, 방화벽이 예측으로 막는다.
#   - 티켓 파일(`.guarded-edits`·`.integrity-baseline`) — 같은 이유로 여기 없다.
#   - `evaluator-runs.jsonl` — gitignore 대상이라 HEAD 자체가 없어 원리적으로 여기 넣을 수
#     없다. is_protected()(Edit/Write 경유)에는 있고, Bash 경유는 방화벽 자기보호 arm이
#     대신한다(INV-14 참조).
# `pre-bash-firewall.sh`·`invariant-guard.sh`·`pre-tool-firewall.sh`는 예외가 **아니다** —
# is_protected()에도 있고 여기에도 있다(아래 배열). 이 셋은 편집 시 티켓이 발급되므로
# 복구 대상에 넣어도 정당한 편집이 되돌려지지 않는다(2차 판정).
PROTECTED_GLOBS=(
  'progress/harness-config.json'
  'progress/feature_list.json'
  'docs/INVARIANTS.md'
  'tests/*.bats'
  'progress/contracts/sprint-*.json'
  # F68: 무인 중단 기록. 예측(firewall·invariant-guard)만 있고 탐지가 없으면 그 경로가
  # 통제 밖에 남는다 — 이 목록의 자기 규정("좁으면 예측도 탐지도 없이 남는다")대로 편입한다.
  'progress/approval-queue.json'
  'skills/change-request/*'
  'skills/improve/*'
  'skills/hotfix/*'
  'agents/evaluator.md'
  # is_protected()가 이름으로 잡는 훅들 — 2차 판정: 1차에서 hooks/*.sh 를 통째로 뺀 것이
  # 과잉 교정이었다. 이 셋은 is_protected()에 있으므로 편집 시 티켓이 발급되고, 따라서
  # 복구 대상에 넣어도 정당한 편집이 되돌려지지 않는다. 실제 불일치는 lib.sh 하나뿐이었다.
  'hooks/invariant-guard.sh'
  'hooks/pre-bash-firewall.sh'
  'hooks/pre-tool-firewall.sh'
  'hooks/hooks.json'
  # F67 판정: 면제 arm 이 `hooks/[A-Za-z0-9_.-]+\.sh` 로 **모든 훅**을 덮는데 위 셋만 탐지
  # 대상이라, 나머지 여덟이 예측도 탐지도 없는 갭에 빠졌다(격리 랩 실증: `hooks/lib.sh` 만
  # 훼손된 채 남았고 그 파일은 Stop 훅 둘을 포함해 다섯 훅이 source 한다).
  # `is_protected()` 에 같은 arm 을 함께 넣는다 — 한쪽만 넣으면 티켓이 발급되지 않아
  # 정당한 편집이 되돌려지는 F65 회귀가 난다.
  'hooks/*.sh'
  # F67 5차 판정: `templates/progress/*` 는 HEAD 추적인데 탐지 대상이 아니어서, 면제된 명령으로
  # 신규 프로젝트 seed 의 `pass_threshold` 를 1 로 낮춰도 복구·기록·격리가 전부 없었다(격리 랩 실증).
  # INV-11 이 `templates/` 를 제외하는 것은 **passes/agreed 전환 검사**이지 보호 자체가 아니다
  # (invariant-guard 의 그 제외는 별도 조건으로 남아 있어 스캐폴딩 편집이 막히지 않는다).
  # 탐지에 넣으면 `cd templates && …` 처럼 표기 층을 빠져나간 쓰기도 되돌릴 수 있다.
  'templates/progress/*.json'
)

TICKETS="$REPO/progress/.guarded-edits"
# 심사를 통과한 내용의 내용 주소 저장소(F78) — 복구 목표가 여기서 나온다.
BLOBS="$REPO/progress/.guarded-blobs"
# 복구 대장(F78 SC-6) — 소비된 티켓이 승격되는 곳. 원장(`.guarded-edits`)은 '면제'를, 이 대장은
# '복구 목표'를 뜻한다. 두 의미를 한 파일에 담았던 것이 `git stash pop` 손실의 원인이었다.
RESTORE_LEDGER="$REPO/progress/.guarded-restore"
QUARANTINE="$REPO/progress/.integrity-quarantine"

# git 작업 진행 중이면 워킹트리가 HEAD와 달라야 정상이다 — 복구하지 않는다.
git_operation_in_progress() {
  for m in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG rebase-merge rebase-apply; do
    [[ -e "$GITDIR/$m" ]] && return 0
  done
  return 1
}

# **invariant-guard와 같은 정규화로 해시한다.**
# guard는 편집 결과를 명령 치환으로 담는데 명령 치환은 후행 개행을 잘라내고, 그 상태에서
# `printf '%s' | git hash-object --stdin` 으로 티켓을 만든다. 반면 디스크의 파일은 개행으로
# 끝난다. 그래서 티켓 sha가 **개행으로 끝나는 모든 파일에서** 어긋났고, 심사를 통과한 편집이
# 매번 복구됐다(격리 저장소 실측: 단순 텍스트·이스케이프 포함·다중 줄 삽입 4/4 MISMATCH).
# guard 쪽에 개행을 되붙이는 방향은 개행 없이 끝나는 파일에서 다시 어긋나므로, 양쪽이 같은
# 정규화를 쓰게 맞춘다. 이 정규화로 구분하지 못하는 변경은 후행 개행의 증감뿐이다.
file_sha() { printf '%s' "$(cat "$1" 2>/dev/null)" | git hash-object --stdin 2>/dev/null; }

# 대장에 `<내용sha, 경로>` 쌍이 있는가 — **티켓 줄을 읽는 유일한 자리**다(F78 3차 판정).
# 구형 `<sha> <경로>` 와 신형 `<sha> <발행HEAD|-> <경로>` 를 모두 받는다. 정규식이 아니라
# 낱말 분해로 비교하므로 경로에 들어간 정규식 메타문자를 이스케이프할 필요가 없다.
__ticket_line_matches() {  # $1 대장 · $2 내용 sha · $3 경로
  local ledger="$1" sha="$2" path="$3" line a rest head_at rel
  [[ -f "$ledger" ]] || return 1
  while IFS= read -r line; do
    a="${line%% *}"
    [[ "$a" == "$sha" ]] || continue
    rest="${line#* }"
    [[ -n "$rest" && "$rest" != "$line" ]] || continue
    head_at="${rest%% *}"
    if [[ "$head_at" =~ ^([0-9a-f]{40}|-)$ && "$rest" == *" "* ]]; then rel="${rest#* }"; else rel="$rest"; fi
    [[ "$rel" == "$path" ]] && return 0
  done < "$ledger"
  return 1
}

# 티켓은 **내용이 그대로인 동안 유효하다** — 일치한다고 그 자리에서 지우지 않는다.
#
# 왜 소비 시점을 옮겼는가: 1차 설계는 일치 즉시 티켓을 지웠다. 그런데 편집된 파일은
# **커밋 전까지 계속 HEAD와 다르므로** 다음 Bash 호출에서는 남은 티켓이 없어 정당한 편집이
# 변조로 판정됐다. 편집 하나가 살아남는 창이 Bash 호출 딱 1회였다는 뜻이고, 그 사이에
# 테스트 한 번만 돌려도 작업이 사라졌다. 실측(2026-07-28): /change-request가 기록한
# feature_list.json의 F66 등록이 두 번 연속 HEAD로 되돌려졌다(progress/.integrity-restores).
# 편집 → 검증 → 커밋이라는 하네스 자신의 워크플로우가 성립하지 않는 상태였다.
#
# "경로 영구 면제"로 되돌아가지 않는 이유: 면제 근거가 경로가 아니라 **내용 해시**다.
# 내용이 한 번 더 바뀌면 sha가 달라져 어떤 티켓과도 일치하지 않고, 그 편집은 invariant-guard
# 심사를 새로 통과해야 티켓을 얻는다. 심사 없이 바꾼 내용은 여전히 즉시 탐지·복구된다.
#
# **형식을 바꿀 때는 읽는 자리를 전부 같이 옮긴다(F78 3차 판정).** SC-8 이 티켓을 3필드
# (`<sha> <발행HEAD> <경로>`)로 바꿨는데 이 함수만 구 2필드 `grep -Fxq "<sha> <경로>"` 로
# 남아, **심사를 통과한 편집이 발행 직후 '티켓 없는 변경'으로 판정**됐다. 그래서 여기서는
# 낱말 수를 손으로 세지 않고 `__ticket_line_matches()` 하나를 거친다.
#
# **유효성에 staleness 를 섞지 않는다.** HEAD 가 움직였다는 사실은 *복구 목표*로서의 티켓을
# 무효로 만들 뿐, 워킹트리에 있는 내용이 심사를 통과했다는 사실을 취소하지 않는다. 섞으면
# 무관한 커밋 한 번이 대기 중인 심사 통과분을 전부 '변조'로 만든다(3차 판정 [2]).
# 티켓이 유효한 파일의 **실제 바이트**를 blob 저장소에 올린다(AC-7). 내용 주소는 후행 개행을
# 무시하는 규약이라, 같은 sha 에 바이트가 다른 두 내용이 대응할 수 있다 — 그럴 때 사실인 쪽은
# 심사를 통과한 채 디스크에 있는 이 파일이다. 심사를 통과하지 않은 내용은 여기 오지 못한다
# (`ticket_valid` 를 지난 파일만 부른다) — 그러므로 blob 저장소 위조로 이어지지 않는다.
promote_blob() {  # $1 저장소 상대 경로
  local f="$1" sha tmp
  sha=$(file_sha "$f") || return 0
  [[ -n "$sha" ]] || return 0
  mkdir -p "$BLOBS" 2>/dev/null || return 0
  [[ -f "$BLOBS/$sha" ]] && cmp -s "$BLOBS/$sha" "$f" && return 0
  tmp=$(mktemp "$BLOBS/.tmp.XXXXXX" 2>/dev/null) || return 0
  if cp "$f" "$tmp" 2>/dev/null; then
    mv -f "$tmp" "$BLOBS/$sha" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  else
    rm -f "$tmp" 2>/dev/null
  fi
  return 0
}

# **재심사(F78 SC-11, ADR-009) — 복구 직전과 면제 판정 양쪽이 부른다.** 1~4차 판정은 모두 같은
# 공격을 재현했다 — 복구 목표 저장소에 무언가를 심고 보호 파일을 훼손하면, 이 훅이 그 내용을
# '심사를 통과한 내용'이라 믿고 설치했다. 매 회전이 저장소로 가는 **입구**를 막았고 판정자는
# 매번 다음 표기를 찾았다. 입구를 명령 문자열로 판정하는 일은 결정 불가이므로 **출구**를 막는다:
# 설치하거나 면제하기 전에 그 내용이 정상 편집으로도 통과했을지를 invariant-guard 에게 다시
# 묻는다. 위조가 성공해도 남길 수 있는 것은 정상 편집으로 남길 수 있었던 내용뿐이 된다.
#
# 규칙을 복제하지 않는다 — invariant-guard 를 그대로 부른다(단일 출처). 기준선은 **HEAD** 여야
# 한다: 훼손된 현재 파일을 기준으로 쓰면, 먼저 더 약하게 훼손해 두는 것만으로 위조가 '강화'로
# 보인다. 그래서 임시 저장소에 HEAD 내용을 **커밋**해 두고 그 안에서 부른다(계약 분기는
# `git show HEAD:` 로 커밋된 승인과 비교하므로 커밋까지 해야 같은 판정이 나온다).
# invariant-guard 가 대상 외에 읽는 파일은 둘이다(실측):
#   - `progress/harness-config.json` — 임계값. **HEAD 판**을 놓는다. 작업 트리 판은 위조 면제로
#     낮춰진 채 남아 있을 수 있다 — 분류는 모든 파일을 본 뒤에 복구하므로, 다른 파일을 재심사할
#     때 그 낮춘 값이 아직 디스크에 있다(변이 P3 가 살아남았던 자리).
#   - `progress/agent-comms/` — passes 전환의 근거. 실제 디렉터리를 가리킨다. 편집 시점의 심사도
#     같은 디렉터리를 보므로 정상 편집보다 넓히는 것이 없다.
#
# **재심사 환경은 사용자 git 설정에서 격리한다(5차 판정).** 임시 저장소가 전역·시스템 설정을
# 상속하면 그 설정이 판정을 좌우한다 — 실측된 것 둘: `commit.gpgsign=true` 하나로 기준선 커밋이
# 실패해 **정상 편집이 전부 되돌려졌고**(AC-6 위반), `core.hooksPath`·`init.templateDir` 의 훅이
# 기준선 저장소 안에서 돌 수 있었다. 두 파일을 `/dev/null` 로 가리켜 전역·시스템 설정을 통째로
# 끊고, 그래도 남는 것은 명시적으로 덮는다.
# blob 은 **내용 주소로만** 신뢰한다(SC-2): 파일명(sha)과 내용의 해시가 같을 때만 쓴다.
# 이 검사가 없으면 blob 저장소에 내용을 심는 것이 '심사 통과'를 위조하는 것과 같아진다.
blob_trustworthy() {
  local sha="$1" got
  [[ -f "$BLOBS/$sha" ]] || return 1
  got=$(printf '%s' "$(cat "$BLOBS/$sha" 2>/dev/null)" | git hash-object --stdin 2>/dev/null) || return 1
  [[ "$got" == "$sha" ]]
}

REVIEW_REASON=""
REVIEW_RAN=0          # 재심사기가 실제로 판정을 냈는가(0/2 로 끝났는가)
REVIEW_PHYS=""        # 재심사용 임시 저장소(물리 경로)

# 임시 저장소를 만든다. `$2` 가 1 이면 판정 근거 디렉터리를 **복사본**으로 두고 합성 실행 기록을
# 한 줄 더한다 — 시간 축만 바꿔 다시 묻기 위한 것이다(아래 `review_reachable` 참조).
__review_repo_make() {  # $1 저장소 상대 경로 · $2 fresh(0|1)
  local rel="$1" fresh="${2:-0}" tmp phys
  REVIEW_PHYS=""
  # 템플릿을 명시한다 — macOS 의 인자 없는 `mktemp -d` 는 TMPDIR 을 무시해 정리 검사가 헛돈다.
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/cc-review.XXXXXX" 2>/dev/null) || { REVIEW_REASON="재심사용 임시 저장소를 만들 수 없음"; return 1; }
  phys=$(cd "$tmp" 2>/dev/null && pwd -P) || { rm -rf "$tmp"; REVIEW_REASON="재심사용 임시 저장소를 만들 수 없음"; return 1; }
  if ! {
      git -c init.templateDir= -C "$phys" init -q \
      && mkdir -p "$phys/$(dirname "$rel")" "$phys/progress" \
      && git show "HEAD:$rel" > "$phys/$rel" \
      && { [[ "$rel" == "progress/harness-config.json" ]] \
           || git show "HEAD:progress/harness-config.json" > "$phys/progress/harness-config.json" 2>/dev/null \
           || true; } \
      && git -C "$phys" add -A \
      && __review_commit "$phys" review-base
    } >/dev/null 2>&1; then
    rm -rf "$tmp"; REVIEW_REASON="재심사용 HEAD 기준선을 만들 수 없음"; return 1
  fi
  if [[ -d "$REPO/progress/agent-comms" ]]; then
    if [[ "$fresh" == "1" ]]; then
      # **복사본에만** 합성 기록을 더한다 — 실제 `agent-comms` 는 건드리지 않는다.
      cp -R "$REPO/progress/agent-comms" "$phys/progress/agent-comms" 2>/dev/null \
        && printf '{"epoch": %s}\n' "$(date +%s 2>/dev/null || echo 0)" \
             >> "$phys/progress/agent-comms/evaluator-runs.jsonl" 2>/dev/null
    else
      ln -s "$REPO/progress/agent-comms" "$phys/progress/agent-comms" 2>/dev/null
    fi
  fi
  REVIEW_PHYS="$phys"
  return 0
}

__review_commit() {  # $1 임시 저장소 · $2 메시지
  git -C "$1" -c user.email=review@cc-harness -c user.name=cc-harness-review \
      -c commit.gpgsign=false -c core.hooksPath=/dev/null -c core.fsmonitor= \
      commit -qm "$2"
}

# 임시 저장소에 대고 한 번 묻는다. 종료 코드를 그대로 돌려준다(0 통과 · 2 거부 · 그 밖 실행 실패).
__review_ask() {  # $1 임시 저장소 · $2 상대 경로 · $3 내용 파일
  local out rc
  out=$(jq -n --arg f "$1/$2" --rawfile c "$3" \
          '{tool_name:"Write",tool_input:{file_path:$f,content:$c}}' 2>/dev/null \
        | ( cd "$1" && CLAUDE_PROJECT_DIR="$1" bash "$HOOK_DIR/invariant-guard.sh" ) 2>&1 >/dev/null)
  rc=$?
  if [[ "$rc" -eq 2 ]]; then
    REVIEW_REASON="재심사 거부 — $(printf '%s' "$out" | grep -m1 'INVARIANT 위반' | sed 's/^INVARIANT 위반: //')"
    [[ "$REVIEW_REASON" == "재심사 거부 — " ]] && REVIEW_REASON="재심사 거부(사유 미상)"
  fi
  return "$rc"
}

review_restore_candidate() {  # $1 저장소 상대 경로 · $2 심사할 내용 파일 → 0 통과
  local rel="$1" blob="$2" guard="$HOOK_DIR/invariant-guard.sh" rc
  local -x GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
  REVIEW_REASON=""; REVIEW_RAN=0
  [[ -f "$guard" ]] || { REVIEW_REASON="재심사기(invariant-guard.sh)를 찾을 수 없어 재심사를 할 수 없음"; return 1; }
  # 존재가 아니라 **실행**을 본다 — 깨진 jq 는 `command -v` 를 통과한다(6차 회전 자체 변이 실측).
  jq -n 'empty' >/dev/null 2>&1 || { REVIEW_REASON="jq 가 없거나 실행되지 않아 재심사를 할 수 없음"; return 1; }
  __review_repo_make "$rel" 0 || return 1
  rc=0; __review_ask "$REVIEW_PHYS" "$rel" "$blob" || rc=$?
  rm -rf "$REVIEW_PHYS"
  case "$rc" in
    0) REVIEW_RAN=1; return 0 ;;
    2) REVIEW_RAN=1; return 1 ;;
    *) REVIEW_REASON="재심사 실행 실패(rc=$rc)"; return 1 ;;
  esac
}

# **거부를 원인별로 가른다 — 사유 문자열이 아니라 차등 질문으로(F78 6차 회전).**
# 재심사는 'HEAD → 지금' 을 한 번의 Write 로 모델링한다. 그런데 가드의 규칙 일부는 **경로 의존**
# (전이를 본다: `agreed` 를 내렸다가 올리는 정상 흐름)이고 일부는 **시간 의존**(판정 기록이 48시간
# 창 안인가)이다. 둘 다 내용의 문제가 아니므로, 한 번 거부됐다고 되돌리면 **정상 작업이 사라진다**
# — 5차 독립 판정이 둘 다 실측했다. 사유 문자열로 분기하는 것은 또 하나의 열거이므로(그 열거가 이
# 스프린트를 다섯 번 실패시켰다), 변수를 하나씩만 바꿔 다시 묻는다:
#   (1) **승인 사슬 재생** — 원장에 쌓인 그 경로의 티켓을 순서대로 재생한다. HEAD → 티켓1 → …
#       → 지금 의 각 단계가 통과하면 그 내용은 정상 편집의 연속으로 도달 가능하다.
#   (2) **시간 축 분리** — 사슬도 거부하면, 판정 근거 복사본에 합성 실행 기록을 더해 한 번 더
#       묻는다. 그때 통과하면 막은 것은 '기록의 최근성' 하나뿐이다.
# 어느 쪽도 통과하지 못하면 그 내용은 **정상 편집으로 도달할 수 없다** — 위조 신호다.
# 사슬을 심는 것으로 이 판정을 속일 수는 없다: 사슬의 각 단계가 심사를 통과해야 하므로, 통과하는
# 사슬이 있다는 것은 곧 정상 편집으로도 그 내용에 이를 수 있다는 뜻이다(SC-11 이 약속한 성질 그대로).
REVIEW_STALE=0        # 시간 축 분리로만 통과했는가(보고에 싣는다)
review_reachable() {  # $1 저장소 상대 경로 · $2 최종 내용 파일 → 0 정상 편집으로 도달 가능
  local rel="$1" final="$2" fresh
  REVIEW_STALE=0
  for fresh in 0 1; do
    if __review_chain "$rel" "$final" "$fresh"; then
      [[ "$fresh" == "1" ]] && REVIEW_STALE=1
      return 0
    fi
  done
  return 1
}

__review_chain() {  # $1 상대 경로 · $2 최종 내용 파일 · $3 fresh(0|1)
  local rel="$1" final="$2" fresh="$3" line sha rest head_at ok=1
  local -x GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
  __review_repo_make "$rel" "$fresh" || return 1
  # 그 경로의 티켓을 **원장에 쌓인 순서대로** 재생한다(마지막 티켓은 지금 내용과 같으므로 건너뛴다).
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    sha="${line%% *}"; rest="${line#* }"
    head_at="${rest%% *}"
    case "$head_at" in
      [0-9a-f]*|-) [[ "$rest" == *" "* ]] && rest="${rest#* }" ;;
    esac
    [[ "$rest" == "$rel" ]] || continue
    [[ -f "$BLOBS/$sha" ]] || continue            # blob 이 없으면 그 단계는 재생할 수 없다
    blob_trustworthy "$sha" || continue
    cmp -s "$BLOBS/$sha" "$final" && continue      # 마지막 단계는 아래에서 한 번만 본다
    if ! __review_ask "$REVIEW_PHYS" "$rel" "$BLOBS/$sha"; then ok=0; break; fi
    cp "$BLOBS/$sha" "$REVIEW_PHYS/$rel" 2>/dev/null || { ok=0; break; }
    git -C "$REVIEW_PHYS" add -A >/dev/null 2>&1 || { ok=0; break; }
    __review_commit "$REVIEW_PHYS" review-step >/dev/null 2>&1 || { ok=0; break; }
  done < <(cat "$TICKETS" 2>/dev/null)
  if [[ "$ok" -eq 1 ]]; then
    __review_ask "$REVIEW_PHYS" "$rel" "$final" || ok=0
  fi
  rm -rf "$REVIEW_PHYS"
  [[ "$ok" -eq 1 ]]
}

ticket_valid() {
  local path="$1" sha
  [[ -f "$TICKETS" ]] || return 1
  sha=$(file_sha "$path") || return 1
  [[ -n "$sha" ]] || return 1
  __ticket_line_matches "$TICKETS" "$sha" "$path"
}

# 티켓을 **소비**한다(줄 삭제) — 변경이 정착했을 때, 즉 파일이 다시 HEAD와 같아졌을 때
# 호출한다(커밋했거나 되돌렸거나). 소비하지 않는 설계가 티켓 파일을 209줄까지 불린 문제는
# 여기서 닫힌다(실측: settings.json 티켓이 33줄 중복돼 있었다).
consume_ticket() {
  local path="$1" tmp
  [[ -f "$TICKETS" ]] || return 1
  grep -q " $path\$" "$TICKETS" 2>/dev/null || return 1
  # **F78 1차 독립 판정(2026-09-14) — 소비는 '면제 무효화'이지 '복구 목표 폐기'가 아니다(SC-6).**
  # 소비 시점에 그 경로의 마지막 티켓을 복구 대장(`.guarded-restore`)으로 **승격**한다.
  # 승격이 없으면 HEAD 일치를 경유하는 워크플로우에서 복구 목표가 사라진다: 실제 배선에서는
  # 모든 Bash 호출이 훅을 발화시키므로 `git stash`(파일 == HEAD → 여기서 소비) → `git stash pop`
  # 순서가 유일하게 가능한 인터리빙이고, pop 이 되살린 내용은 티켓이 없어 HEAD 로 되돌아가
  # 심사 통과분이 전부 사라졌다(1차 판정 재현). 대장은 경로당 한 줄만 유지한다(마지막 것).
  # **두 형식을 모두 받는다(SC-8)**: 구 `<sha> <경로>` · 신 `<sha> <HEAD|-> <경로>`.
  # 구 형식 패턴만 보면 신 형식 티켓이 승격되지 않아 `git stash pop` 축이 다시 열린다
  # (이 라운드 자체 발견 — 형식을 바꾸면 그 형식을 읽는 **모든** 자리를 함께 옮겨야 한다).
  local __last __esc
  __esc=$(printf '%s' "$path" | sed 's/[].[^$\\*\/]/\\&/g')
  __last=$(grep -E "^[0-9a-f]{40} ($__esc|([0-9a-f]{40}|-) $__esc)\$" "$TICKETS" 2>/dev/null | tail -1)
  if [[ -n "$__last" ]]; then
    local __rtmp
    __rtmp=$(mktemp) || __rtmp=""
    if [[ -n "$__rtmp" ]]; then
      grep -v " $path\$" "$RESTORE_LEDGER" 2>/dev/null > "$__rtmp" || true
      printf '%s\n' "$__last" >> "$__rtmp"
      mv -f "$__rtmp" "$RESTORE_LEDGER" 2>/dev/null || rm -f "$__rtmp"
    fi
  fi
  tmp=$(mktemp) || return 1
  grep -v " $path\$" "$TICKETS" > "$tmp" 2>/dev/null || true
  mv "$tmp" "$TICKETS" 2>/dev/null || rm -f "$tmp"
  # **소비를 기록한다** (2차 판정: 우회가 아무 흔적도 남기지 않는다는 지적).
  # 티켓 파일은 셸을 쥔 상대에게 위조 불가능하지 않으므로, 최소한 '무엇이 면제되었는가'는
  # 남아야 사후에 확인할 수 있다. 이 로그는 탐지의 근거가 아니라 감사 추적이다.
  [[ -d "$REPO/progress" ]] && printf '%s\tconsumed\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$path" \
    >> "$REPO/progress/.integrity-restores" 2>/dev/null || true
  return 0
}

# **F78(sprint-64) — 원장과 blob 저장소를 유계로 유지한다.**
# 원장은 append-only 인데 정리 규칙이 없어 보호 대상 밖 경로까지 쌓였다(실측: 2099줄, 그 중
# 1859줄이 보호 대상이 아닌 한 경로). 길어진 원장은 비용이자 잡음이고, 유효 티켓을 찾기
# 어렵게 만들어 이 훅의 판단 근거를 흐린다.
# 남기는 줄의 조건은 셋이다: (1) `sha rel` 형식일 것, (2) rel 이 보호 대상 glob 에 맞을 것,
# (3) rel 이 저장소 root 안의 상대 경로일 것(`../` 금지). blob 저장소는 정리된 원장이
# 참조하지 않는 파일을 지운다 — blob 은 내용 주소라 지워도 같은 내용이 다시 나타나면 같은
# 이름으로 되살아난다.
# 비용을 유계로 둔다: 원장이 상한(2000줄)을 넘으면 **오래된 쪽부터 잘라** 상한 안으로 들인 뒤
# 정리한다. 자르는 것이 안전한 이유는 티켓이 오래될수록 그 내용이 이미 커밋돼(=HEAD 와 같아져)
# 소비됐을 가능성이 크고, 남지 않은 티켓은 HEAD 폴백으로 내려갈 뿐 보호가 약해지지 않기 때문이다.
GC_MAX_LINES=2000
# **두 대장에 같은 규칙을 적용한다(F78 SC-7·SC-8, 2차 독립 판정).** 2차 회전은 원장만 정리하고
# **복구 대장에는 GC·형식 검증을 두지 않았다** — `deadbeef ../../etc/passwd`·`GARBAGE` 같은 줄이
# 훅을 세 번 돌려도 남았고, `last_ticket_sha()` 가 그리로 폴스루하므로 **검증 없는 평면이 복구
# 목표를 결정**했다. 정리 규칙을 파일 인자로 받는 함수 하나로 두고 둘 다 그것을 거친다.
# 줄에서 내용 sha 와 발행 시점 HEAD 를 뽑는다. 두 형식을 받는다(F78 SC-8):
#   신형 `<내용sha> <HEAD sha|-> <경로>` · 구형 `<내용sha> <경로>`(staleness 판정 없음)
# **정의는 GC 보다 앞에 있어야 한다** — GC 가 이 둘을 쓴다(자체 발견: 뒤에 두었더니
# `__ticket_fresh: 명령을 찾을 수 없음` 으로 GC 가 모든 줄을 버렸고 복구 목표가 통째로 사라졌다).
__ticket_fields() {  # $1 줄 → "sha head" (head 가 없으면 "-")
  local line="$1" a b
  a="${line%% *}"; b="${line#* }"; b="${b%% *}"
  if [[ "$b" =~ ^([0-9a-f]{40}|-)$ ]]; then printf '%s %s' "$a" "$b"; else printf '%s -' "$a"; fi
}
# 그 줄이 **지금 복구 목표로 쓰기에 유효한가** — 발행 시점 HEAD 가 현재 HEAD 와 같아야 한다.
# 다르면 그 사이에 다른 내용이 커밋됐다는 뜻이고, 그 티켓으로 복구하면 커밋된 내용을 덮는다.
__ticket_fresh() {  # $1 head_at
  local head_at="$1" now
  [[ "$head_at" == "-" ]] && return 0      # 구 형식·빈 저장소 — 종전대로 취급
  now=$(git rev-parse --verify -q HEAD 2>/dev/null || printf '-')
  [[ "$head_at" == "$now" ]]
}

gc_ledger_file() {  # $1 대장 경로
  local TICKETS="$1"
  [[ -f "$TICKETS" ]] || return 0
  local tmp n
  n=$(wc -l < "$TICKETS" 2>/dev/null | tr -d ' ')
  [[ -z "$n" ]] && return 0
  tmp=$(mktemp) || return 0
  # **거른 뒤 자른다(F78 1차 판정).** 반대 순서였을 때는 잡음 2500줄이 상한을 채워 **유효 티켓을
  # 상한 밖으로 밀어냈다** — 운영 원장이 2119줄 중 보호 대상 0건이라 실제 경계에 있었다.
  # 여기서는 전량을 거르고, 거른 결과가 상한을 넘을 때만 오래된 쪽을 버린다.
  cat "$TICKETS" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 0; }
  local keep; keep=$(mktemp) || { rm -f "$tmp"; return 0; }
  local line sha rel g ok head_at rest
  while IFS= read -r line; do
    sha="${line%% *}"; rest="${line#* }"
    # (1) 형식 — **버리되 세어 둔다(F78 error_scenario).** 계약은 '손상된 줄만 무시하고
    # **보고**한다' 였는데 지금까지 조용히 버렸다. 원장이 깨졌다는 사실이 사용자에게도, 다음
    # 라운드에게도 보이지 않았다. 보호 대상이 아니라 걸러지는 줄은 손상이 아니므로 세지 않는다.
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { GC_CORRUPT=$((GC_CORRUPT + 1)); continue; }
    [[ -n "$rest" && "$rest" != "$line" ]] || { GC_CORRUPT=$((GC_CORRUPT + 1)); continue; }
    # 신형 `<sha> <HEAD|-> <경로>` 와 구형 `<sha> <경로>` 를 모두 받는다(SC-8).
    head_at="${rest%% *}"
    if [[ "$head_at" =~ ^([0-9a-f]{40}|-)$ && "$rest" == *" "* ]]; then
      rel="${rest#* }"
    else
      # 구 형식(`<sha> <경로>`) — 두 번째 낱말은 **경로**지 HEAD 가 아니다. 여기서 `head_at` 을
      # 되돌리지 않으면 `__ticket_fresh` 가 경로를 HEAD 로 비교해 **모든 구 형식 줄을 버린다**
      # (자체 발견: 원장이 통째로 비고 복구 목표가 사라졌다).
      rel="$rest"; head_at="-"
    fi
    # (3) root 안의 상대 경로 — 저장소 밖을 가리키는 줄도 손상으로 센다.
    case "$rel" in /*|*..*) GC_CORRUPT=$((GC_CORRUPT + 1)); continue ;; esac
    # **낡음(SC-8)은 여기서 버리는 근거가 아니다(F78 3차 판정 [2]).** 2차 회전은 GC 에서
    # `__ticket_fresh` 로 낡은 줄을 지웠는데, 그러면 무관한 파일을 커밋해 HEAD 가 움직이는
    # 것만으로 대기 중인 심사 통과분의 티켓이 사라지고 그 파일이 곧바로 '티켓 없는 변경'으로
    # 복구된다 — F78 이 닫으려던 손실이 원래 세 방아쇠보다 훨씬 흔한 방아쇠로 되살아났다.
    # 낡음은 *복구 목표*로서의 자격을 잃는 것이지 심사를 통과했다는 사실이 취소되는 것이
    # 아니므로, 판정은 조회 시점(`last_ticket_sha`) 한 곳에만 둔다. 지우지 않고 남겨 두어야
    # 폴백 사유("발행 시점 HEAD 가 달라 무효")를 사실대로 보고할 수 있다는 이유도 있다 —
    # GC 가 먼저 지우면 훅은 티켓이 있었다는 것조차 모른 채 '티켓 이력이 없어'라고 말한다.
    # 무한히 쌓이지는 않는다: 정착한 티켓은 소비되고, 남은 것은 아래 상한이 자른다.
    ok=1
    for g in "${PROTECTED_GLOBS[@]}"; do                 # (2) 보호 대상
      # shellcheck disable=SC2053
      [[ "$rel" == $g ]] && { ok=0; break; }
    done
    [[ "$ok" -eq 0 ]] && printf '%s\n' "$line"
  done < "$tmp" > "$keep"
  rm -f "$tmp"
  # 거른 결과가 그래도 상한을 넘으면 그때 오래된 쪽부터 버린다.
  if [[ "$(wc -l < "$keep" | tr -d ' ')" -gt "$GC_MAX_LINES" ]]; then
    local trimmed; trimmed=$(mktemp) || trimmed=""
    if [[ -n "$trimmed" ]]; then
      tail -n "$GC_MAX_LINES" "$keep" > "$trimmed" 2>/dev/null && mv -f "$trimmed" "$keep" || rm -f "$trimmed"
    fi
  fi
  mv -f "$keep" "$TICKETS" 2>/dev/null || rm -f "$keep"
}

gc_ledger_and_blobs() {
  gc_ledger_file "$TICKETS"
  gc_ledger_file "$RESTORE_LEDGER"
  # 참조되지 않는 blob 정리.
  [[ -d "$BLOBS" ]] || return 0
  local b base
  for b in "$BLOBS"/*; do
    [[ -f "$b" ]] || continue
    base="${b##*/}"
    case "$base" in .tmp.*) rm -f "$b" 2>/dev/null; continue ;; esac
    # **두 대장을 모두 본다(F78 SC-6).** 소비된 티켓은 원장에서 사라지고 복구 대장으로 승격되므로,
    # 원장만 보면 **방금 승격된 복구 목표의 blob 을 지운다** — 그러면 `git stash pop` 축이 다시
    # 열린다(이 라운드 자체 발견: 승격만 넣고 여기를 고치지 않았더니 테스트가 계속 red 였다).
    grep -q "^$base " "$TICKETS" 2>/dev/null && continue
    grep -q "^$base " "$RESTORE_LEDGER" 2>/dev/null && continue
    rm -f "$b" 2>/dev/null
  done
}

# 세션 기준선 — HEAD 비교만으로는 **훼손 후 커밋**을 볼 수 없다(1차 판정 지적).
# `printf evil > <파일>; git add -A; git commit` 을 한 명령으로 하면 HEAD가 훼손을 포함하므로
# 워킹트리와 HEAD가 같아진다. 세션 첫 실행 때의 내용을 따로 적어 두면 그 변화가 드러난다.
# 커밋된 변경은 **복구하지 않고 보고만** 한다 — 되돌리면 HEAD와 어긋난 더티 트리를 만들고,
# 정당한 커밋(내가 Edit로 고친 뒤 커밋한 경우)까지 되돌리게 된다.
BASELINE="$REPO/progress/.integrity-baseline"
# **인덱스가 아니라 커밋 트리에서 열거한다** (2차 판정). `git ls-files` 는 인덱스를 읽으므로
# 인덱스를 건드리는 모든 명령이 탐지를 실명시킨다 — `update-index --assume-unchanged`·
# `--skip-worktree`·`--force-remove`·`rm --cached`. 1차에서 그 셋을 ASK 패턴으로 열거했더니
# 2차가 즉시 네 번째(`--force-remove`)를 찾아냈다. 열거로는 닫히지 않는 축이었다.
# `ls-tree`는 HEAD 커밋 트리를 읽으므로 인덱스 조작과 무관하다 — 클래스가 통째로 닫힌다.
# (커밋으로 트리 자체를 옮기는 회피는 아래 세션 기준선이 담당한다.)
FILES=()
while IFS= read -r f; do [[ -n "$f" ]] && FILES+=("$f"); done \
  < <(git ls-tree -r --name-only HEAD 2>/dev/null | while IFS= read -r p; do
        for g in "${PROTECTED_GLOBS[@]}"; do
          # shellcheck disable=SC2053
          [[ "$p" == $g ]] && { printf '%s\n' "$p"; break; }
        done
      done)

if [[ ! -f "$BASELINE" ]]; then
  # `"${FILES[@]}"` 를 FILES 가 빈 배열일 때 그대로 펼치면 bash 3.2(4.4 이전 공통 결함,
  # set -u 상태)에서 "unbound variable" 로 죽는다 — F65 9차 판정이 실제로 잡은 형태다:
  # PROTECTED_GLOBS 어느 패턴도 매치하지 않는 저장소(플러그인이 설치된 일반 사용자 저장소의
  # 흔한 상태)에서는 FILES 가 비어 있고, 그러면 이 훅이 통째로 죽어 탐지·복구 평면 자체가
  # 무력화된다. `"${arr[@]+"${arr[@]}"}"` 관용구가 두 버전 모두에서 안전하다.
  for f in "${FILES[@]+"${FILES[@]}"}"; do printf '%s %s\n' "$(file_sha "$f")" "$f"; done > "$BASELINE" 2>/dev/null || true
fi

# 원장·blob 정리(F78 AC-4) — 판정 **전에** 돌려도 안전하다: 지우는 것은 형식이 깨졌거나 보호
# 대상이 아니거나 저장소 밖을 가리키는 줄, 그리고 상한을 넘은 오래된 줄뿐이다. 유효 티켓은 남고,
# 남지 않은 티켓은 HEAD 폴백으로 내려갈 뿐이라 보호가 약해지는 방향이 아니다.
GC_CORRUPT=0
gc_ledger_and_blobs
# 계약의 error_scenario: '원장이 손상됐다(줄 형식 불일치) → 손상된 줄만 무시하고 **보고**한다'.
# 유효한 줄은 그대로 쓰이므로 동작은 계속된다 — 보고는 그 사실을 사용자가 알게 하는 몫이다.
if [[ "$GC_CORRUPT" -gt 0 ]]; then
  {
    echo "cc-harness: 심사 원장에서 **손상된 줄 ${GC_CORRUPT}개**를 무시했습니다(유효한 줄은 그대로 씁니다)."
    echo "  형식이 어긋나거나 저장소 밖을 가리키는 줄입니다: progress/.guarded-edits · progress/.guarded-restore"
  } >&2
fi

CHANGED=(); COMMITTED=(); EXEMPT_DENIED=(); EXEMPT_UNVERIFIED=(); EXEMPT_STALE=(); EXEMPT_UNRULED=()
for f in "${FILES[@]+"${FILES[@]}"}"; do
  if git diff --quiet HEAD -- "$f" 2>/dev/null; then
    # HEAD와 같다 = 변경이 정착했다(커밋했거나 되돌렸거나). 남은 티켓은 여기서 소비한다.
    consume_ticket "$f" || true
    # 그래도 세션 시작 시점과 다르면 그 사이에 커밋된 것이다
    base=$(grep -F " $f" "$BASELINE" 2>/dev/null | head -1 | cut -d' ' -f1)
    [[ -n "$base" && "$base" != "$(file_sha "$f")" ]] && COMMITTED+=("$f")
    continue
  fi
  # 아직 워킹트리에만 있는 변경 — 내용이 심사를 통과한 그대로면 통과시킨다(티켓 유지).
  # **실제 바이트를 blob 으로 승격한다(F78 AC-7).** 발행 시점의 blob 은 PreToolUse 의 *예측*
  # 에서 나오고 그 예측은 명령 치환을 거치므로 후행 개행이 사라진다 — 복구가 원본과 1바이트
  # 다른 원인이 그것이다. 여기서는 티켓이 유효하다고 판정된 **디스크의 실제 내용**을 올리므로
  # 예측이 아니라 사실이고, 바이트가 그대로다.
  if ticket_valid "$f"; then
    # **면제도 내용으로 판정한다(F78 5차 회전, ADR-009).** 티켓은 원장의 한 줄이고, 원장은 셸을
    # 쥔 상대가 위조할 수 있다 — 낮춘 임계값에 위조 티켓을 붙이면 이 분기가 그것을 '심사 통과분'
    # 으로 보고 **복구하지 않고 남겼다**. 복구 경로에 둔 재심사를 여기에도 둔다: 화이트리스트
    # 파일은 지금 내용이 HEAD 기준으로 정상 편집이었을지 다시 묻고, 아니면 복구 대상으로 돌린다.
    # 코드 파일은 내용을 판정할 규칙이 없어 원장을 믿는다 — ADR-009 의 알려진 한계.
    if [[ "$WHITELIST_KNOWN" -eq 0 ]]; then
      # **목록의 출처를 모르면 면제 판정을 믿지 않는다(F78 6차, fail-closed 방향 정렬).** 복구
      # 경로는 목록을 모를 때 전부 HEAD 로 간다. 면제 쪽은 되돌리지 않지만(그것이 AC-6 이다)
      # 통과시켰다는 사실을 반드시 보이게 한다 — 그러지 않으면 목록이 사라지는 것만으로 면제
      # 검사가 조용히 꺼진다.
      EXEMPT_UNVERIFIED+=("$f: 복구 화이트리스트의 출처(lib.sh)를 읽지 못해 면제 검사를 하지 못했습니다")
    elif ! is_blob_restorable "$f"; then
      # 코드·산문 — 내용을 판정할 규칙이 없어 **원장을 믿고** 통과시킨다. 5차 판정이 '완전 침묵'
      # 이라고 적은 자리다. 되돌릴 근거는 없지만, 믿었다는 사실은 남긴다(ADR-009 의 알려진 한계).
      EXEMPT_UNRULED+=("$f")
    elif ! review_restore_candidate "$f" "$REPO/$f"; then
      if [[ "$REVIEW_RAN" -eq 1 ]]; then
        # 한 번 거부됐다고 되돌리지 않는다 — 경로 의존·시간 의존 규칙 때문일 수 있다.
        if review_reachable "$f" "$REPO/$f"; then
          if [[ "$REVIEW_STALE" -eq 1 ]]; then
            EXEMPT_STALE+=("$f: 판정 기록이 최근성 창 밖이지만 내용은 정상 편집으로 도달 가능합니다 — 되돌리지 않았습니다")
          fi
        else
          EXEMPT_DENIED+=("$f: 티켓이 있지만 $REVIEW_REASON")
          CHANGED+=("$f"); continue
        fi
      else
        # **재심사를 실행하지 못한 것은 위조의 증거가 아니다(5차 판정, AC-6).** 여기서 되돌리면
        # 환경 문제(전역 git 설정·의존성 부재) 하나로 **심사를 통과한 작업이 사라진다** — 실측:
        # `commit.gpgsign=true` 만으로 정상 편집이 전부 HEAD 로 갔다. 판정이 나오지 않았을 때는
        # 되돌리지 않고 **보고만** 한다. 복구 경로는 반대로 fail-closed 다 — 그쪽 파일 내용은
        # 이미 티켓 없이 바뀐 상태라 믿을 수 없지만, 여기 내용은 티켓과 일치한다.
        EXEMPT_UNVERIFIED+=("$f: $REVIEW_REASON — 되돌리지 않고 보고만 합니다(환경을 고치면 다시 검사합니다)")
      fi
    fi
    promote_blob "$f"; continue
  fi
  CHANGED+=("$f")
done

if [[ ${#COMMITTED[@]} -gt 0 ]]; then
  {
    echo "cc-harness: 검증 장치가 세션 시작 이후 **커밋으로** 바뀌었습니다(복구하지 않음)."
    for f in "${COMMITTED[@]}"; do echo "  - $f"; done
    echo "  의도한 변경이 아니면 git log -p -- <경로> 로 확인하세요."
  } >&2
fi

# **되돌리지 않기로 한 면제들을 먼저 알린다(F78 6차).** 복구할 것이 하나도 없어도 이 보고는
# 나가야 한다 — 그러지 않으면 '아무 일도 없었다' 와 '믿고 통과시켰다' 가 구별되지 않는다.
# 5차 판정이 '완전 침묵' 이라고 적은 자리이고, 조용한 통과를 없애는 것이 이 블록의 전부다.
report_unreverted_exemptions() {
  [[ ${#EXEMPT_UNVERIFIED[@]} -gt 0 || ${#EXEMPT_STALE[@]} -gt 0 || ${#EXEMPT_UNRULED[@]} -gt 0 ]] || return 0
  local r
  {
    echo "cc-harness: 티켓으로 면제 중인 보호 파일이 있습니다(되돌리지 않았습니다)."
    for r in "${EXEMPT_UNVERIFIED[@]+"${EXEMPT_UNVERIFIED[@]}"}"; do echo "    - 재심사 실행 불가: $r"; done
    for r in "${EXEMPT_STALE[@]+"${EXEMPT_STALE[@]}"}"; do echo "    - $r"; done
    for r in "${EXEMPT_UNRULED[@]+"${EXEMPT_UNRULED[@]}"}"; do
      echo "    - 내용 규칙이 없어 원장을 믿고 통과: $r"
    done
  } >&2
}

if [[ ${#CHANGED[@]} -eq 0 ]]; then
  report_unreverted_exemptions
  exit 0
fi

if git_operation_in_progress; then
  {
    echo "cc-harness: git 작업 진행 중이라 보호 파일 변경을 **복구하지 않고 보고만** 합니다."
    for f in "${CHANGED[@]}"; do echo "  - $f"; done
    echo "  작업을 마친 뒤 의도치 않은 변경이면 git checkout HEAD -- <경로> 로 되돌리세요."
  } >&2
  exit 0
fi

# **F78(sprint-64) — 복구 목표는 HEAD 가 아니라 '마지막으로 심사를 통과한 내용'이다.**
# 이 훅은 티켓 없는 변경을 되돌릴 때 `git checkout HEAD --` 를 썼다. 그러면 티켓 없는 쓰기 한
# 번이 그 파일에 쌓여 있던 **심사 통과분 전체**를 함께 버린다 — F65 작업 중 3회 재발했고
# 방아쇠는 매번 달랐다(python3 편집·`git stash pop`·`sed -i`). 방아쇠가 매번 다르다는 것이
# '방아쇠를 막는 것으로는 닫히지 않는다'는 증거이므로, 고칠 곳은 **복구 목표**다.
# 원장의 그 파일 마지막 티켓이 가리키는 blob 으로 되돌리고, 없거나 믿을 수 없으면 HEAD 로
# 폴백한다. 폴백은 **조용히 하지 않는다** — 사유를 사용자 보고에 넣는다.
# 그 파일의 마지막 티켓 sha(원장은 append-only 라 마지막 줄이 가장 최근이다).
STALE_REASON=""
# **결과를 전역으로 돌려준다 — 명령 치환으로 부르지 않는다(F78 3차 판정).** 이전 판은 sha 를
# stdout 으로 찍고 호출부가 `$( … )` 로 받았는데, 명령 치환은 서브셸이라 그 안에서 세운
# `STALE_REASON` 이 호출부에 도달하지 못했다 — 낡은 티켓 사유를 싣는 분기가 통째로 죽은
# 코드였고, 훅은 그 경우에도 '티켓 이력이 없어' 라고 **틀리게** 보고했다.
LAST_TICKET_SHA=""
last_ticket_sha() {
  local path="$1" esc line
  LAST_TICKET_SHA=""
  esc=$(printf '%s' "$path" | sed 's/[].[^$\\*\/]/\\&/g')
  # 원장(아직 소비되지 않은 티켓)을 먼저 보고, 없으면 **복구 대장**(소비되며 승격된 것)을 본다.
  # 소비가 복구 목표를 지우지 않는다는 것이 SC-6 이다.
  # 두 형식을 모두 읽는다: `<sha> <경로>`(구) · `<sha> <HEAD|-> <경로>`(신, SC-8).
  local f sha head_at
  STALE_REASON=""
  for f in "$TICKETS" "$RESTORE_LEDGER"; do
    [[ -f "$f" ]] || continue
    line=$(grep -E "^[0-9a-f]{40} ($esc|([0-9a-f]{40}|-) $esc)\$" "$f" 2>/dev/null | tail -1)
    [[ -n "$line" ]] || continue
    read -r sha head_at <<<"$(__ticket_fields "$line")"
    if __ticket_fresh "$head_at"; then LAST_TICKET_SHA="$sha"; return 0; fi
    # **낡은 목표는 쓰지 않는다(SC-8).** 발행 이후 HEAD 가 움직였다면 그 사이 커밋된 내용이
    # 있고, 이 티켓으로 복구하면 그것을 덮는다 — 2차 판정이 `FEATURE-A` 로 `COMMITTED-B` 를
    # 덮어 실증한 회귀다. 조용히 넘기지 않고 사유를 남겨 보고에 싣는다.
    STALE_REASON="발행 시점 HEAD(${head_at:0:8})가 현재 HEAD 와 달라 티켓을 무효로 봄"
  done
  return 1
}
# blob 은 **내용 주소로만** 신뢰한다(SC-2): 파일명(sha)과 내용의 해시가 같을 때만 쓴다.
# 이 검사가 없으면 blob 저장소에 내용을 심는 것이 '심사 통과'를 위조하는 것과 같아진다.
# `blob_trustworthy` 의 정의는 위쪽(재심사 앞)으로 옮겼다 — 승인 사슬 재생이 그것을 쓴다.
# 정의를 호출보다 뒤에 두면 '명령을 찾을 수 없음' 으로 **조용히 틀린 판정**이 난다(이 파일에서
# `__ticket_fresh`·`review_restore_candidate` 에 이어 세 번째다).

# 재심사(`review_restore_candidate`)는 위쪽, 분류 루프보다 앞에 정의돼 있다 — 면제 분기도 그것을
# 부르기 때문이다(정의가 호출보다 뒤에 있으면 '명령을 찾을 수 없음'으로 조용히 틀린 판정이 난다.
# 이 파일에서 `__ticket_fresh` 로 한 번, 이 회전에서 한 번 더 실측했다).

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST="$QUARANTINE/$STAMP"
RESTORED=(); FALLBACK=()
for f in "${CHANGED[@]}"; do
  mkdir -p "$DEST/$(dirname "$f")" 2>/dev/null
  cp "$f" "$DEST/$f" 2>/dev/null || true      # 되돌리기 전에 반드시 보관 — 손실 0
  tsha=""
  last_ticket_sha "$f" 2>/dev/null && tsha="$LAST_TICKET_SHA"
  if [[ -n "$tsha" ]] && blob_trustworthy "$tsha" && ! is_blob_restorable "$f"; then
    # **화이트리스트 밖(코드·산문) — 심사 통과분으로 되살리지 않는다(ADR-009).** 재심사가 그
    # 내용을 가려낼 수 없는 파일이다. 대신 내용을 잃지 않도록 위치를 알려 준다 — 다시 적용하는
    # 길은 Edit/Write(심사를 거치는 도구 경로)다. 위조일 수 있으므로 '확인한 뒤'를 붙인다.
    FALLBACK+=("$f: 내용 규칙이 없는 파일이라 심사 통과분으로 되살리지 않고 HEAD 로 되돌림 — 마지막 티켓의 내용은 progress/.guarded-blobs/$tsha 에 있습니다(확인한 뒤 Edit/Write 로 다시 적용)")
  elif [[ -n "$tsha" ]] && blob_trustworthy "$tsha" && ! review_restore_candidate "$f" "$BLOBS/$tsha"; then
    FALLBACK+=("$f: $REVIEW_REASON — 설치하지 않고 HEAD 로 되돌림")
  elif [[ -n "$tsha" ]] && blob_trustworthy "$tsha"; then
    if cp "$BLOBS/$tsha" "$f" 2>/dev/null; then
      # 복원 결과가 그 티켓과 실제로 일치하는지 다시 확인한다 — 일치하지 않으면 HEAD 로 간다.
      if [[ "$(file_sha "$f")" == "$tsha" ]]; then
        RESTORED+=("$f"); continue
      fi
      FALLBACK+=("$f: 복원 내용이 티켓 해시와 달라 HEAD 로 되돌림")
    else
      FALLBACK+=("$f: blob 을 쓸 수 없어 HEAD 로 되돌림")
    fi
  elif [[ -n "$tsha" ]]; then
    FALLBACK+=("$f: blob 이 없거나 내용 주소가 어긋나(위조 가능성) HEAD 로 되돌림")
  elif [[ -n "${STALE_REASON:-}" ]]; then
    # SC-8: 티켓은 있었으나 발행 이후 HEAD 가 움직여 무효다.
    FALLBACK+=("$f: $STALE_REASON — HEAD 로 되돌림")
  else
    # **티켓 부재도 폴백 사유다(F78 1차 판정).** 이 줄이 없으면 `FALLBACK` 이 빈 채로 남아
    # 헤더가 '마지막으로 심사를 통과한 내용으로 복구했습니다' 를 찍는다 — 심사 통과분이
    # 사라진 실행조차 그 문구를 출력했다(판정자가 '보고가 거짓' 이라고 적은 근거).
    FALLBACK+=("$f: 이 경로의 티켓 이력이 없어 HEAD 로 되돌림")
  fi
  # **HEAD 복구는 체크아웃이 아니라 blob 을 그대로 쓴다(5차 판정).** `git checkout` 은 smudge
  # 필터를 태운다 — `filter.<x>.smudge` 와 `.git/info/attributes` 두 줄이면 'HEAD 로 복구했습니다'
  # 라고 보고하면서 공격자의 내용이 설치된다. `cat-file blob` 은 필터를 거치지 않는다.
  if git cat-file blob "HEAD:$f" > "$f" 2>/dev/null; then
    RESTORED+=("$f")
  elif git checkout HEAD -- "$f" 2>/dev/null; then
    # 그 경로가 HEAD 에 없거나 blob 을 읽을 수 없는 경우의 폴백(삭제된 파일 등).
    RESTORED+=("$f")
  fi
done

# **되돌리지 않기로 한 것들은 보이게 한다.** 복구가 하나도 없어도 알려야 하므로, 아래 보고
# 블록(복구가 있을 때만 도는)에 기대지 않는다. 셋 다 '조용한 통과' 를 막는 것이 전부인 분기다:
#   - 재심사를 실행하지 못한 면제(환경 문제일 수 있다)
#   - 시간 축으로만 통과한 면제(판정 기록이 최근성 창 밖이다)
#   - 화이트리스트 밖(코드·산문) 파일의 면제 — 내용을 판정할 규칙이 없어 **원장을 믿고** 통과시킨
#     것들이다(ADR-009 의 알려진 한계). 5차 판정이 '완전 침묵' 이라고 적은 자리이며, 위조된
#     면제가 아무 흔적 없이 남던 것이 여기서 끝난다.
[[ ${#RESTORED[@]} -eq 0 ]] && report_unreverted_exemptions

[[ ${#RESTORED[@]} -eq 0 ]] && exit 0

{
  # **헤더는 실제로 일어난 일을 말한다(F78 1차 판정).** 티켓 기반 복구가 하나도 없었는데
  # '심사를 통과한 내용으로 복구했습니다' 를 찍으면, 심사 통과분이 사라진 실행이 성공처럼 읽힌다.
  if [[ ${#FALLBACK[@]} -eq 0 ]]; then
    echo "cc-harness: 보호 파일이 티켓 없이 변경되어 **마지막으로 심사를 통과한 내용**으로 복구했습니다."
  elif [[ ${#FALLBACK[@]} -ge ${#RESTORED[@]} ]]; then
    echo "cc-harness: 보호 파일이 티켓 없이 변경되어 **HEAD 내용**으로 복구했습니다(심사 통과 내용을 쓸 수 없었습니다)."
  else
    echo "cc-harness: 보호 파일이 티켓 없이 변경되어 복구했습니다 — 일부는 심사 통과 내용, 일부는 HEAD 입니다."
  fi
  for f in "${RESTORED[@]}"; do echo "  - $f"; done
  if [[ ${#FALLBACK[@]} -gt 0 ]]; then
    echo "  아래는 HEAD 로 되돌렸습니다(폴백 사유):"
    for r in "${FALLBACK[@]}"; do echo "    - $r"; done
  fi
  # 면제를 거부한 파일은 **티켓이 있었는데도** 복구했다는 뜻이다 — 원장이 위조됐을 수 있다는
  # 신호이므로 따로 적는다(조용히 복구만 하면 원장이 공격받았다는 사실이 보이지 않는다).
  if [[ ${#EXEMPT_DENIED[@]} -gt 0 ]]; then
    echo "  아래는 원장에 티켓이 있었지만 재심사를 통과하지 못해 면제하지 않았습니다(원장 위조 가능성):"
    for r in "${EXEMPT_DENIED[@]}"; do echo "    - $r"; done
  fi
  if [[ ${#EXEMPT_UNVERIFIED[@]} -gt 0 ]]; then
    echo "  아래는 재심사를 **실행하지 못해** 확인되지 않은 채 남겨 두었습니다(되돌리지 않았습니다):"
    for r in "${EXEMPT_UNVERIFIED[@]}"; do echo "    - $r"; done
  fi
  if [[ ${#EXEMPT_STALE[@]} -gt 0 ]]; then
    for r in "${EXEMPT_STALE[@]}"; do echo "    - $r"; done
  fi
  if [[ ${#EXEMPT_UNRULED[@]} -gt 0 ]]; then
    echo "  아래는 내용 규칙이 없어 **원장을 믿고** 면제했습니다(ADR-009 의 알려진 한계):"
    for r in "${EXEMPT_UNRULED[@]}"; do echo "    - $r"; done
  fi
  echo "  되돌린 내용은 버리지 않고 보관했습니다: ${DEST#"$REPO"/}"
  echo "  하네스 검증 장치는 Edit/Write(invariant-guard 심사)로만 변경할 수 있습니다."
} >&2

[[ -d "$REPO/progress" ]] && printf '%s\t%s\t%s\n' "$STAMP" "$DEST" "${RESTORED[*]}" \
  >> "$REPO/progress/.integrity-restores" 2>/dev/null || true
exit 0
