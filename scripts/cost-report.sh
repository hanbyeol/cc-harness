#!/usr/bin/env bash
#
# cost-report.sh — Phase별 비용 관측성 (F24)
# config/models.json(pricing + phases + assignments)을 단일 출처로 SDLC phase별
# 모델 가격 구성을 정적 리포트로 출력. 읽기 전용 — 파일을 수정하지 않는다.
#
# 사용법:
#   cost-report.sh                         # 텍스트 표 (per-1M 단가)
#   cost-report.sh --json                  # JSON 출력
#   cost-report.sh --tokens-in N --tokens-out M   # 1회 호출 $ 추정 추가
#
# 주의: pricing은 config의 선언 데이터이며 실제 청구가 아니다(NOT actual billing).
#
set -euo pipefail

JSON=0; TIN=""; TOUT=""
usage() {
  cat >&2 <<'EOF'
usage: cost-report.sh [--json] [--tokens-in N] [--tokens-out M]
  --json              JSON 출력
  --tokens-in N       1회 호출 입력 토큰 수 (양의 정수)
  --tokens-out M      1회 호출 출력 토큰 수 (양의 정수)
EOF
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)       JSON=1; shift;;
    --tokens-in)  TIN="${2:-}"; shift; [[ $# -gt 0 ]] && shift;;
    --tokens-out) TOUT="${2:-}"; shift; [[ $# -gt 0 ]] && shift;;
    -h|--help)    usage; exit 0;;
    *)            echo "cost-report: unknown argument: $1" >&2; usage; exit 2;;
  esac
done

isnum() { [[ "$1" =~ ^[0-9]+$ ]]; }
if [[ -n "$TIN" ]]  && ! isnum "$TIN";  then echo "cost-report: --tokens-in must be a non-negative integer" >&2; usage; exit 2; fi
if [[ -n "$TOUT" ]] && ! isnum "$TOUT"; then echo "cost-report: --tokens-out must be a non-negative integer" >&2; usage; exit 2; fi

# graceful degrade: 진단/리포트를 망가뜨리지 않음 (비0 종료 회피, exit 0)
err() {
  if [[ "$JSON" == 1 ]]; then jq -n --arg m "$1" '{error:$m}'; else echo "cost-report: $1 (config/models.json)"; fi
  exit 0
}
command -v jq &>/dev/null || err "jq not found"
CONFIG="config/models.json"
[[ -f "$CONFIG" ]] || err "config not found"
CFG=$(jq -c . "$CONFIG" 2>/dev/null) || err "config malformed"
[[ -n "$CFG" ]] || err "config empty"

TIN_N=${TIN:-0}; TOUT_N=${TOUT:-0}
HAVE_TOKENS=0; [[ -n "$TIN" || -n "$TOUT" ]] && HAVE_TOKENS=1

REPORT=$(jq -c -n --argjson cfg "$CFG" --argjson tin "$TIN_N" --argjson tout "$TOUT_N" --argjson havetok "$HAVE_TOKENS" '
  ($cfg.pricing // {})     as $price
  | ($cfg.assignments // {}) as $asg
  | ($cfg.phases // {})    as $phases
  | [ $phases | to_entries[] | .key as $ph | .value as $roles
      | ([ $roles[] | $asg[.].model ])               as $models
      | ([ $models[] | select(. != null) ])          as $valid
      # 미가격(0 위장 금지) 또는 assignments 미등록 role이 있으면 플래그
      | (([ $valid[] | select($price[.] == null) ] | length > 0)
          or ([ $roles[] | select($asg[.] == null) ] | length > 0)) as $uncosted
      | ([ $valid[] | $price[.].input  // 0 ] | add // 0)  as $in
      | ([ $valid[] | $price[.].output // 0 ] | add // 0)  as $out
      | { phase:$ph, roles:$roles, models:$models,
          input_per_1m:$in, output_per_1m:$out, total_per_1m:($in + $out),
          has_uncosted:$uncosted }
      | if $havetok == 1
          then . + { est_usd_per_call:
                     ([ $roles[]
                        | ($asg[.].model) as $m
                        | if ($price[$m] == null) then 0
                          else (($tin / 1000000) * $price[$m].input)
                             + (($tout / 1000000) * $price[$m].output) end
                      ] | add // 0) }
          else . end
    ]
  | sort_by(-.total_per_1m) as $rows
  | { note: "declared pricing from config/models.json — NOT actual billing",
      tokens_in: (if $havetok==1 then $tin else null end),
      tokens_out: (if $havetok==1 then $tout else null end),
      phases: $rows,
      most_expensive_phase: ($rows[0].phase // null) }
')

if [[ "$JSON" == 1 ]]; then
  echo "$REPORT" | jq .
else
  echo "cost-report — declared pricing from config/models.json (NOT actual billing)"
  [[ "$HAVE_TOKENS" == 1 ]] && echo "  per-call estimate at tokens_in=${TIN_N}, tokens_out=${TOUT_N}"
  echo "$REPORT" | jq -r '
    .phases[]
    | "  \(.phase)"
      + "  roles=\(.roles | length)"
      + "  in/1M=$\(.input_per_1m)  out/1M=$\(.output_per_1m)  total/1M=$\(.total_per_1m)"
      + (if .has_uncosted then "  [has uncosted role]" else "" end)
      + (if .est_usd_per_call != null then "  ~$\(.est_usd_per_call)/call" else "" end)'
  echo "most expensive phase: $(echo "$REPORT" | jq -r '.most_expensive_phase')"
fi
