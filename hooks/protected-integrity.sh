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

REPO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$REPO" 2>/dev/null || exit 0
command -v git &>/dev/null || exit 0
GITDIR=$(git rev-parse --git-dir 2>/dev/null) || exit 0

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
ticket_valid() {
  local path="$1" sha
  [[ -f "$TICKETS" ]] || return 1
  sha=$(file_sha "$path") || return 1
  [[ -n "$sha" ]] || return 1
  grep -Fxq "$sha $path" "$TICKETS"
}

# 티켓을 **소비**한다(줄 삭제) — 변경이 정착했을 때, 즉 파일이 다시 HEAD와 같아졌을 때
# 호출한다(커밋했거나 되돌렸거나). 소비하지 않는 설계가 티켓 파일을 209줄까지 불린 문제는
# 여기서 닫힌다(실측: settings.json 티켓이 33줄 중복돼 있었다).
consume_ticket() {
  local path="$1" tmp
  [[ -f "$TICKETS" ]] || return 1
  grep -q " $path\$" "$TICKETS" 2>/dev/null || return 1
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

CHANGED=(); COMMITTED=()
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
  ticket_valid "$f" && continue
  CHANGED+=("$f")
done

if [[ ${#COMMITTED[@]} -gt 0 ]]; then
  {
    echo "cc-harness: 검증 장치가 세션 시작 이후 **커밋으로** 바뀌었습니다(복구하지 않음)."
    for f in "${COMMITTED[@]}"; do echo "  - $f"; done
    echo "  의도한 변경이 아니면 git log -p -- <경로> 로 확인하세요."
  } >&2
fi

[[ ${#CHANGED[@]} -eq 0 ]] && exit 0

if git_operation_in_progress; then
  {
    echo "cc-harness: git 작업 진행 중이라 보호 파일 변경을 **복구하지 않고 보고만** 합니다."
    for f in "${CHANGED[@]}"; do echo "  - $f"; done
    echo "  작업을 마친 뒤 의도치 않은 변경이면 git checkout HEAD -- <경로> 로 되돌리세요."
  } >&2
  exit 0
fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST="$QUARANTINE/$STAMP"
RESTORED=()
for f in "${CHANGED[@]}"; do
  mkdir -p "$DEST/$(dirname "$f")" 2>/dev/null
  cp "$f" "$DEST/$f" 2>/dev/null || true      # 되돌리기 전에 반드시 보관 — 손실 0
  git checkout HEAD -- "$f" 2>/dev/null && RESTORED+=("$f")
done

[[ ${#RESTORED[@]} -eq 0 ]] && exit 0

{
  echo "cc-harness: 보호 파일이 Bash 경로로 변경되어 HEAD 내용으로 복구했습니다."
  for f in "${RESTORED[@]}"; do echo "  - $f"; done
  echo "  되돌린 내용은 버리지 않고 보관했습니다: ${DEST#"$REPO"/}"
  echo "  하네스 검증 장치는 Edit/Write(invariant-guard 심사)로만 변경할 수 있습니다."
} >&2

[[ -d "$REPO/progress" ]] && printf '%s\t%s\t%s\n' "$STAMP" "$DEST" "${RESTORED[*]}" \
  >> "$REPO/progress/.integrity-restores" 2>/dev/null || true
exit 0
