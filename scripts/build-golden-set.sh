#!/usr/bin/env bash
#
# build-golden-set.sh — evaluator 보정 코퍼스(F37 golden-set) 재생성 (F61)
#
# 왜 필요한가: F37이 만든 golden-set에는 생성 경로가 없었다. calibration.sh는 코퍼스를
# 소비만 하고, 코퍼스 자체는 수작업 산출물이라 판정이 40건 쌓이는 동안 갱신되지 않았다.
# 그 결과 standard pass 표본이 6건에 머물렀고 test_coverage 분포 폭이 0이 되어 정상
# 판정을 연속 오탐했다. 노후를 반복하지 않으려면 재생성이 1회성 작업이 아니라 명령이어야 한다.
#
# 정책:
#  - 원본은 읽기 전용. progress/agent-comms의 판정 기록을 수정하지 않는다(SC-4).
#  - evidence 원문은 담지 않는다. 판정 기록에는 명령어·경로·출력이 들어 있어 그대로
#    복사하면 코퍼스가 유출 경로가 된다 — 기존 정책대로 유무(has_evidence)만 남긴다(SC-3).
#  - 결정적(deterministic). 같은 입력이면 바이트 동일한 출력. 정렬 키를 고정한다.
#  - scores가 없거나 비수치인 파일은 건너뛰되 그 수를 stderr로 보고한다 — 조용히 누락하지 않는다(ES-1).
#
# 사용법: bash scripts/build-golden-set.sh [출력경로]
#         기본 출력 evals/calibration/golden-set.json
#
set -euo pipefail
command -v jq &>/dev/null || { echo "build-golden-set: jq가 필요합니다" >&2; exit 1; }

COMMS="progress/agent-comms"
OUT="${1:-evals/calibration/golden-set.json}"

[[ -d "$COMMS" ]] || { echo "build-golden-set: $COMMS 없음" >&2; exit 1; }

TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT

TOTAL=0; SKIPPED=0
# 현행 + archive 양쪽. 파일명 정렬로 순서를 고정해 결정성을 보장한다.
while IFS= read -r f; do
  [[ -f "$f" ]] || continue
  TOTAL=$((TOTAL + 1))
  # 5차원이 모두 수치인 판정만 코퍼스에 넣는다. computed_min을 여기서 계산해 두면
  # calibration.sh의 (a) 산술 검사와 같은 기준을 코퍼스가 이미 만족하게 된다.
  if ! jq -e '.scores
        | [.functionality, .code_quality, .security, .error_handling, .test_coverage]
        | map(select(type == "number")) | length == 5' "$f" &>/dev/null; then
    SKIPPED=$((SKIPPED + 1)); continue
  fi
  jq -c '
    .scores as $s
    | [$s.functionality, $s.code_quality, $s.security, $s.error_handling, $s.test_coverage] as $v
    | {
        features: ((.features_evaluated // .features // []) | map(tostring) | sort),
        tier: (.security_tier // "unknown"),
        scores: {
          functionality: $s.functionality,
          code_quality: $s.code_quality,
          security: $s.security,
          error_handling: $s.error_handling,
          test_coverage: $s.test_coverage
        },
        recorded_score: (.score // null),
        computed_min: ($v | min),
        verdict: (.verdict // "unknown"),
        has_evidence: ((.evidence // null) != null),
        iteration: (.iteration // null)
      }' "$f" >> "$TMP"
done < <(find "$COMMS" -name 'evaluator-feedback-*.json' -type f 2>/dev/null | sort)

[[ -s "$TMP" ]] || { echo "build-golden-set: 수집된 판정이 없습니다" >&2; exit 1; }

# 축소 방지 가드 — 입력의 대부분(현재 61건 중 51건)이 gitignore된 archive/에 있다.
# clean clone처럼 archive가 없는 환경에서 실행하면 커밋된 코퍼스를 훨씬 작은 것으로
# 덮어쓰고, tier별 표본이 calibration.sh의 N≥5 게이트 아래로 떨어져 그 tier의 검사가
# 조용히 꺼진다. 결정성 검사(2회 실행 동일)로는 이 구멍이 드러나지 않는다.
NEW_N=$(wc -l < "$TMP" | tr -d ' ')
if [[ -f "$OUT" ]]; then
  PREV_N=$(jq '.records | length' "$OUT" 2>/dev/null || echo 0)
  if [[ "$NEW_N" -lt "$PREV_N" && "${GOLDEN_SET_ALLOW_SHRINK:-}" != "1" ]]; then
    echo "build-golden-set: 중단 — 새 코퍼스가 기존보다 작습니다(${NEW_N} < ${PREV_N})." >&2
    echo "  입력 대부분이 gitignore된 ${COMMS}/archive/ 에 있어, 그 디렉터리가 없는 환경에서" >&2
    echo "  실행하면 코퍼스가 축소되고 tier별 표본이 N게이트 아래로 떨어집니다." >&2
    echo "  의도한 축소라면 GOLDEN_SET_ALLOW_SHRINK=1 을 지정하십시오." >&2
    exit 1
  fi
fi

# 정렬 키를 고정해 입력 순서와 무관하게 같은 출력을 낸다.
jq -s --sort-keys '{
  description: "과거 evaluator 판정 정규화 코퍼스 (F37). calibration.sh가 판정 산술·분포 감사에 사용. evidence 원문은 시크릿 회피 위해 유무만 기록. scripts/build-golden-set.sh로 재생성한다(F61) — 수작업 갱신 금지.",
  generated_from: "progress/agent-comms/evaluator-feedback-*.json (현행+archive)",
  generated_by: "scripts/build-golden-set.sh",
  records: (sort_by([(.features | join(",")), .tier, .verdict, .computed_min]))
}' "$TMP" > "$OUT"

echo "build-golden-set: $OUT — records $(jq '.records | length' "$OUT")건 (판정 파일 ${TOTAL}건 중 ${SKIPPED}건 skip: scores 부재/비수치)" >&2
