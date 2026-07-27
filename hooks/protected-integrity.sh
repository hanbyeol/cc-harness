#!/usr/bin/env bash
#
# protected-integrity.sh — 하네스 검증 장치의 무결성을 **사후 탐지·복구**로 지킨다 (F65)
#
# ## 왜 이 방식인가
#
# 이전 설계는 Bash 명령 **문자열**을 보고 "이 명령이 보호 파일을 쓸 것인가"를 미리 판단했다.
# 그 질문은 결정 불가능하다 — 셸도, 셸이 부르는 sed·awk·perl·python도 튜링 완전하므로
# 실행하지 않고 효과를 아는 방법이 없다. 실제로 그 방향으로 10회전을 시도했고 매번
# 새로운 우회 표기가 나왔다(붙여쓴 optarg · 중괄호 확장 · 명령 치환 · 프로세스 치환 ·
# 인용 제거 미수행 · 이름 변형 · 경로 표기). 예측이 불가능하니 알려진 형태를 나열하는 수밖에
# 없었고, 그것이 곧 커버리지 상한이 됐다.
#
# 반면 **"파일이 바뀌었는가"는 사후에 자명하게 결정된다.** 해시 하나를 비교하면 끝이고,
# 무슨 도구로 바꿨는지와 무관하다. 그래서 판정을 예측에서 탐지로 옮긴다.
#
# ## 무엇을 비교하는가 — 명령 전후가 아니라 HEAD
#
# "명령 실행 전후 비교"로 하면 `git checkout <브랜치>` 처럼 워킹트리를 정당하게 바꾸는
# 작업이 전부 오탐된다. 그래서 기준을 **HEAD**로 둔다. 지켜야 할 불변식은 이것이다:
#
#   보호 파일의 내용은 HEAD와 같거나, 그 변경이 invariant-guard를 거친 것이어야 한다.
#
# - `git checkout <브랜치>` → HEAD가 함께 바뀌므로 차이 없음 → 무동작 (오탐 없음)
# - `sed -i` 로 훅 변조    → HEAD와 다르고 가드 기록 없음 → 복구 + 보고
# - Edit/Write 로 정당 수정 → invariant-guard가 심사 후 원장에 기록 → 허용
#
# ## 무엇을 다루지 않는가 (정직한 경계)
#
# - **컨트롤 플레인은 여기서 다루지 않는다.** hooks/hooks.json 과 .claude/settings*.json 은
#   이 훅의 배선 자체를 끌 수 있으므로 예측 계층(pre-bash-firewall.sh)이 계속 막는다.
#   settings.json 은 gitignore 대상이라 HEAD 기준 복구도 불가능하다.
# - **되돌릴 수 없는 것은 여기 없다.** rm -rf / · mkfs · 시크릿 외부 유출은 사후 복구가
#   불가능하므로 예측·차단이 유일한 수단이며 그대로 둔다(Layer 1·2·egress).
# - **같은 Bash 호출 안에서의 소비는 막지 못한다.** `sed -i s/7/1/ <config> && <그 값을 읽는 명령>`
#   처럼 한 명령 안에서 변조와 소비가 함께 일어나면 복구는 그 뒤다. 하네스에서 임계값·훅을
#   소비하는 것은 다음 도구 호출이므로 실무 노출은 낮지만, 없는 위험이라고 적지 않는다.
set -uo pipefail

REPO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$REPO" 2>/dev/null || exit 0
command -v git &>/dev/null || exit 0
git rev-parse --git-dir &>/dev/null || exit 0

# 데이터 플레인 — git 추적이라 HEAD로 복구 가능한 검증 장치.
# 목록의 완전성은 tests/protected-integrity.bats 가 invariant-guard 의 is_protected() 와 대조한다.
PROTECTED_GLOBS=(
  'progress/harness-config.json'
  'progress/feature_list.json'
  'docs/INVARIANTS.md'
  'hooks/*.sh'
  'tests/*.bats'
)

LEDGER="$REPO/progress/.guarded-edits"

is_guarded() {
  [[ -f "$LEDGER" ]] && grep -Fxq "$1" "$LEDGER"
}

RESTORED=()
for glob in "${PROTECTED_GLOBS[@]}"; do
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    # HEAD와 동일하면 볼 것 없음 — git checkout 등으로 HEAD가 함께 움직인 경우 포함
    git diff --quiet HEAD -- "$f" 2>/dev/null && continue
    # invariant-guard 를 거친 편집이면 정당한 변경
    is_guarded "$f" && continue
    git checkout HEAD -- "$f" 2>/dev/null && RESTORED+=("$f")
  done < <(git ls-files "$glob" 2>/dev/null)
done

[[ ${#RESTORED[@]} -eq 0 ]] && exit 0

# 복구했으면 조용히 넘어가지 않는다 — 무엇이 왜 되돌려졌는지 알려야 다음 판단이 가능하다.
{
  echo "cc-harness: 보호 파일이 Bash 경로로 변경되어 HEAD 내용으로 복구했습니다."
  for f in "${RESTORED[@]}"; do echo "  - $f"; done
  echo "  하네스 검증 장치는 Edit/Write(invariant-guard 심사)로만 변경할 수 있습니다."
  echo "  의도한 변경이라면 같은 편집을 Edit/Write 툴로 다시 수행하세요."
} >&2

# 기록 — /improve 의 프로브와 세션 핸드오프가 읽는다
if [[ -d "$REPO/progress" ]]; then
  printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${RESTORED[*]}" \
    >> "$REPO/progress/.integrity-restores" 2>/dev/null || true
fi
exit 0
