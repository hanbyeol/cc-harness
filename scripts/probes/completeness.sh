#!/usr/bin/env bash
#
# completeness.sh — 완전성 critic 프로브 (F13)
# "무엇이 빠졌나": 테스트 없는 이벤트 훅, TRIGGER 없는 skill, 참조되나 없는 파일.
# 각 갭을 개선 후보로 출력.
#
set -euo pipefail
command -v jq &>/dev/null || { echo "[]"; exit 0; }

CANDS="[]"
add() { CANDS=$(jq -c --arg n "$1" --arg d "$2" --arg t "${3:-low}" \
  '. + [{name:$n, description:$d, security_tier:$t, source:"completeness"}]' <<<"$CANDS"); }

# 1. 이벤트 훅(lib/setup 제외) 중 대응 테스트 없는 것
if [[ -d hooks ]]; then
  for h in hooks/*.sh; do
    [[ -f "$h" ]] || continue
    b=$(basename "$h" .sh)
    [[ "$b" == "lib" || "$b" == "setup-claudemd" ]] && continue
    if ! find tests -name "*${b}*" -type f 2>/dev/null | grep -q .; then
      add "hook '$b' has no test" "이벤트 훅 hooks/${b}.sh 에 대응하는 tests/ 파일이 없음 — 회귀 위험" "standard"
    fi
  done
fi

# 2. TRIGGER 없는 skill (자동 라우팅 불가)
if [[ -d skills ]]; then
  for d in skills/*/; do
    [[ -f "$d/SKILL.md" ]] || continue
    s=$(basename "$d")
    grep -q 'TRIGGER' "$d/SKILL.md" 2>/dev/null || add "skill '$s' missing TRIGGER" "skills/$s/SKILL.md description에 TRIGGER 문구 없음 — 자동 라우팅 누락" "low"
  done
fi

# 3. INVARIANTS.md / ADR이 참조하는 hooks 파일이 실제 존재하는지
if [[ -f docs/INVARIANTS.md ]]; then
  while IFS= read -r ref; do
    [[ -f "$ref" ]] || add "referenced file missing: $ref" "docs/INVARIANTS.md가 $ref 를 참조하나 파일이 없음" "standard"
  done < <(grep -oE 'hooks/[a-zA-Z0-9_-]+\.sh' docs/INVARIANTS.md 2>/dev/null | sort -u)
fi

echo "$CANDS"
