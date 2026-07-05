#!/usr/bin/env bash
#
# calibration.sh — evaluator 판정 보정 프로브 (F37)
#
# 단일 judge 1회 호출에 게이트 신뢰도가 걸려 있으므로, 최신 evaluator 판정을 감사해
# judge 자체의 산술·일관성 결함을 후보로 보고한다(golden-set은 사람 검토·향후 분포분석용).
# 최신 1건만 본다 — evidence.sh와 동일하게 historical 노이즈를 피한다(0건 != 건강).
# 읽기 전용, jq/파일 부재·malformed graceful degrade.
#
set -euo pipefail
command -v jq &>/dev/null || { echo "[]"; exit 0; }

COMMS="progress/agent-comms"
CFG="progress/harness-config.json"
PASS_T=7
[[ -f "$CFG" ]] && PASS_T=$(jq -r '.scoring.pass_threshold // 7' "$CFG" 2>/dev/null || echo 7)

CANDS="[]"
add() { CANDS=$(jq -c --arg n "$1" --arg d "$2" --arg t "${3:-standard}" \
  '. + [{name:$n, description:$d, security_tier:$t, source:"calibration"}]' <<<"$CANDS"); }

# 최신(비archive) 판정 레코드
LATEST=$(ls -1 "$COMMS"/evaluator-feedback-*.json 2>/dev/null | sort -r | head -1)
[[ -z "$LATEST" || ! -f "$LATEST" ]] && { echo "[]"; exit 0; }
jq -e '.' "$LATEST" &>/dev/null || { echo "[]"; exit 0; }  # malformed → 조용히 skip

FEAT=$(jq -r '.features_evaluated // [] | join(",")' "$LATEST" 2>/dev/null || echo "?")
VERDICT=$(jq -r '.verdict // "unknown"' "$LATEST" 2>/dev/null || echo "unknown")
SCORE=$(jq -r '.score // "null"' "$LATEST" 2>/dev/null || echo "null")
# 5차원 min (숫자가 아닌/누락 차원은 제외 후 5개 미만이면 null)
MIN=$(jq -r '[.scores.functionality, .scores.code_quality, .scores.security, .scores.error_handling, .scores.test_coverage] | map(select(type=="number")) | if length==5 then min else null end' "$LATEST" 2>/dev/null || echo "null")

# (a) 산술 정합: recorded score != min-of-5 (INV-2를 어긴 판정 기록)
if [[ "$SCORE" != "null" && "$MIN" != "null" && "$SCORE" != "$MIN" ]]; then
  add "evaluator score mismatch ($FEAT)" "최신 판정 score=$SCORE 이지만 min-of-5=$MIN — 종합점수가 최솟값과 불일치(INV-2 산술 오류). $LATEST 재검토 필요" "standard"
fi

# (b) 5차원 불완전한데 판정을 내림 (min 재검증 불가)
if [[ "$MIN" == "null" ]]; then
  add "evaluator scores incomplete ($FEAT)" "최신 판정의 5차원 점수가 불완전/비수치 — min-of-5 재검증 불가. $LATEST" "standard"
fi

# (c) verdict/score 모순: pass인데 min-of-5 < pass_threshold
if [[ "$VERDICT" == pass* && "$MIN" != "null" ]] && awk -v m="$MIN" -v t="$PASS_T" 'BEGIN{exit !(m+0 < t+0)}'; then
  add "evaluator verdict/score contradiction ($FEAT)" "verdict=pass 이지만 min-of-5=$MIN < pass_threshold=$PASS_T — 통과 요건 미달 판정. $LATEST" "critical"
fi

# (d) evidence 없는 pass (evidence.sh와 상보 — calibration 관점 재확인)
HAS_EV=$(jq -r '(.evidence // {}) | (type=="object" and length>0)' "$LATEST" 2>/dev/null || echo "false")
if [[ "$VERDICT" == pass* && "$HAS_EV" != "true" ]]; then
  add "evaluator pass without evidence ($FEAT)" "verdict=pass인데 evidence 객체가 비어있음 — evidence over claims 위반. $LATEST" "standard"
fi

echo "$CANDS"
