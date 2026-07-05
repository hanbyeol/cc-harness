#!/usr/bin/env bash
#
# metrics.sh <iso-timestamp> — 메트릭 프로브 (F13)
# bats @test 총수 + shellcheck 경고 수를 progress/metrics-history.json에 append하고,
# 직전 엔트리 대비 악화(테스트 감소, 경고 증가)를 후보화한다. 첫 실행은 baseline만.
# 타임스탬프는 인자로 주입(Date 불가 환경 대비). 미제공 시 "unknown".
#
set -euo pipefail
command -v jq &>/dev/null || { echo "[]"; exit 0; }
TS="${1:-unknown}"
HIST="progress/metrics-history.json"

# 측정
TESTS=$(grep -rhcE '^@test ' tests/*.bats 2>/dev/null | paste -sd+ - 2>/dev/null | bc 2>/dev/null || echo 0)
TESTS=${TESTS:-0}
WARN=0
if command -v shellcheck &>/dev/null; then
  # 경고/에러 라인 수 (info 제외) — 결정론적 카운트
  WARN=$(shellcheck -f gcc hooks/*.sh scripts/probes/*.sh 2>/dev/null | grep -cE ': (warning|error):' || true)
fi

PREV="{}"
[[ -f "$HIST" ]] && PREV=$(jq -c '.[-1] // {}' "$HIST" 2>/dev/null || echo "{}")
PREV_TESTS=$(jq -r '.tests // empty' <<<"$PREV"); PREV_WARN=$(jq -r '.shellcheck_warnings // empty' <<<"$PREV")

# F38: 하네스 효과 KPI (add-only, 하위호환 — 필드 부재는 null 허용) ================
# first-pass rate·평균 iteration: passed 기능이 몇 회 iteration만에 통과했나 (게이트 마찰 지표).
FL="progress/feature_list.json"
FP_RATE="null"; AVG_ITER="null"
if [[ -f "$FL" ]]; then
  read -r FP_RATE AVG_ITER < <(jq -r '
    [.features[]? | select(.passes == true)] as $p
    | if ($p | length) == 0 then "null null"
      else
        ([$p[] | select(.iteration <= 1)] | length) as $first
        | (($first / ($p | length) * 100) | floor) as $rate
        | (([$p[].iteration] | add) / ($p | length) * 100 | floor / 100) as $avg
        | "\($rate) \($avg)"
      end' "$FL" 2>/dev/null || echo "null null")
  [[ -z "$FP_RATE" ]] && FP_RATE="null"
  [[ -z "$AVG_ITER" ]] && AVG_ITER="null"
fi
# Stop 게이트 차단 횟수(.gate-stats 줄 수) — 관측 로그, 게이트 아님.
GATE_BLOCKS=0
[[ -f progress/.gate-stats ]] && GATE_BLOCKS=$(grep -c . progress/.gate-stats 2>/dev/null || echo 0)
GATE_BLOCKS=${GATE_BLOCKS:-0}
# 방화벽 결정 분포(.firewall-stats: deny/ask/allow 줄).
FW_DENY=0; FW_ASK=0; FW_ALLOW=0
if [[ -f progress/.firewall-stats ]]; then
  FW_DENY=$(grep -cx deny progress/.firewall-stats 2>/dev/null || echo 0)
  FW_ASK=$(grep -cx ask progress/.firewall-stats 2>/dev/null || echo 0)
  FW_ALLOW=$(grep -cx allow progress/.firewall-stats 2>/dev/null || echo 0)
fi
FW_DENY=${FW_DENY:-0}; FW_ASK=${FW_ASK:-0}; FW_ALLOW=${FW_ALLOW:-0}

# append
mkdir -p progress
ENTRY=$(jq -n --arg ts "$TS" --argjson t "$TESTS" --argjson w "$WARN" \
  --argjson fp "$FP_RATE" --argjson ai "$AVG_ITER" --argjson gb "$GATE_BLOCKS" \
  --argjson fd "$FW_DENY" --argjson fk "$FW_ASK" --argjson fa "$FW_ALLOW" \
  '{timestamp:$ts, tests:$t, shellcheck_warnings:$w,
    first_pass_rate_pct:$fp, avg_iterations:$ai, gate_blocks:$gb,
    firewall_decisions:{deny:$fd, ask:$fk, allow:$fa}}')
if [[ -f "$HIST" ]]; then
  jq --argjson e "$ENTRY" '. + [$e]' "$HIST" > "$HIST.tmp" && mv "$HIST.tmp" "$HIST"
else
  jq -n --argjson e "$ENTRY" '[$e]' > "$HIST"
fi

# 악화 판정
CANDS="[]"
add() { CANDS=$(jq -c --arg n "$1" --arg d "$2" '. + [{name:$n, description:$d, security_tier:"standard", source:"metrics"}]' <<<"$CANDS"); }
if [[ -n "$PREV_TESTS" ]] && [[ "$TESTS" -lt "$PREV_TESTS" ]]; then
  add "test count regressed" "@test 총수 $PREV_TESTS → $TESTS 감소 — 삭제된 테스트 확인 필요"
fi
if [[ -n "$PREV_WARN" ]] && [[ "$WARN" -gt "$PREV_WARN" ]]; then
  add "shellcheck warnings increased" "경고 $PREV_WARN → $WARN 증가 — 신규 린트 경고 정리 필요"
fi
echo "$CANDS"
