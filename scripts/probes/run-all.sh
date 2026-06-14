#!/usr/bin/env bash
#
# run-all.sh <iso-timestamp> — 프로브 러너 (F13)
# 4개 프로브 출력을 합치고, 이미 feature_list.json 또는 session-handoff backlog에 있는
# 항목을 제거한 뒤, 남은 후보에 임시 id(C1,C2…)를 부여해 JSON 배열로 출력한다.
#
set -euo pipefail
command -v jq &>/dev/null || { echo "[]"; exit 0; }
TS="${1:-unknown}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. 집계 (각 프로브는 독립 — 하나 실패해도 나머지 수집)
ALL="[]"
for p in consistency metrics completeness self-review model-tiering evidence; do
  OUT=$(bash "$DIR/$p.sh" "$TS" 2>/dev/null || echo "[]")
  echo "$OUT" | jq -e 'type=="array"' &>/dev/null || OUT="[]"
  ALL=$(jq -c --argjson a "$ALL" --argjson b "$OUT" '$a + $b' <<<"null")
done

# 2. 기존 항목 수집 (중복 제거 기준: name 또는 description 부분일치)
SEEN=""
if [[ -f progress/feature_list.json ]]; then
  SEEN+=$(jq -r '.features[]? | "\(.name)\n\(.description)"' progress/feature_list.json 2>/dev/null || true)
  SEEN+=$'\n'
fi
if [[ -f progress/session-handoff-draft.json ]]; then
  SEEN+=$(jq -r '.follow_ups_backlog[]? // empty' progress/session-handoff-draft.json 2>/dev/null || true)
fi

# 3. 중복 제거 + id 부여
RESULT="[]"; n=0
LEN=$(jq 'length' <<<"$ALL")
for ((i = 0; i < LEN; i++)); do
  NAME=$(jq -r ".[$i].name" <<<"$ALL")
  # 후보 name이 기존 항목 텍스트에 포함되거나 그 반대면 중복으로 간주
  DUP=0
  if [[ -n "$SEEN" ]] && grep -qiF "$NAME" <<<"$SEEN"; then DUP=1; fi
  [[ "$DUP" == "1" ]] && continue
  n=$((n + 1))
  RESULT=$(jq -c --argjson item "$(jq -c ".[$i]" <<<"$ALL")" --arg id "C$n" \
    '. + [($item + {id:$id})]' <<<"$RESULT")
done

echo "$RESULT"
