#!/usr/bin/env bash
#
# self-review.sh — 정적 자기 리뷰 프로브 (F13)
# hooks/scripts의 FIXME/TODO/XXX/HACK 주석 + shellcheck 경고를 후보화한다.
# (전체 /code-review는 skill이라 bash에서 호출 불가 — /improve가 추가로 권고한다)
#
set -euo pipefail
command -v jq &>/dev/null || { echo "[]"; exit 0; }

CANDS="[]"
add() { CANDS=$(jq -c --arg n "$1" --arg d "$2" '. + [{name:$n, description:$d, security_tier:"low", source:"self-review"}]' <<<"$CANDS"); }

# 1. FIXME/TODO/XXX/HACK 주석
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  add "unresolved marker" "$line"
done < <(grep -rnE '(FIXME|TODO|XXX|HACK)' hooks scripts 2>/dev/null | grep -vE 'self-review\.sh' | head -10 || true)

# 2. shellcheck 경고/에러 (info 제외)
if command -v shellcheck &>/dev/null; then
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    add "shellcheck finding" "$line"
  done < <(shellcheck -f gcc hooks/*.sh scripts/probes/*.sh 2>/dev/null | grep -E ': (warning|error):' | head -10 || true)
fi

echo "$CANDS"
