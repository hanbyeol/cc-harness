#!/usr/bin/env bash
#
# evidence.sh — Evidence 클로징 프로브 (F25)
# 'Evidence over claims' 원칙을 정적 집행: progress/agent-comms의 가장 최근
# evaluator-feedback 레코드(archive/ 제외)가 pass 판정이면서 실행 근거(evidence)를
# 기록하지 않았으면 후보로 보고. 전방위(최신 1건) — historical 노이즈 회피.
# 후보를 JSON 배열로 출력: [{name,description,security_tier,source:"evidence"}]
# 읽기 전용. jq/파일 부재·malformed 시 graceful degrade([]).
#
set -euo pipefail
command -v jq &>/dev/null || { echo "[]"; exit 0; }

DIR="progress/agent-comms"
[[ -d "$DIR" ]] || { echo "[]"; exit 0; }

# 1. archive/ 제외, evaluator-feedback-*.json 중 파일명(ISO 타임스탬프) lexical 최신 1건
LATEST=$(find "$DIR" -maxdepth 1 -type f -name 'evaluator-feedback-*.json' 2>/dev/null \
  | sort | tail -1)
[[ -n "$LATEST" ]] || { echo "[]"; exit 0; }

# 2. malformed → graceful([]) (크래시 금지)
REC=$(jq -c . "$LATEST" 2>/dev/null) || { echo "[]"; exit 0; }
[[ -n "$REC" ]] || { echo "[]"; exit 0; }

BASE=$(basename "$LATEST")

# 3. pass류(verdict에 'pass' 포함, 단 'fail'·'downgrade' 제외) + non-empty evidence 객체 부재 → 후보
jq -c -n --argjson rec "$REC" --arg file "$BASE" '
  ($rec.verdict // "") as $v
  | (($v | ascii_downcase) | test("pass")) as $is_pass_word
  | (($v | ascii_downcase) | test("fail|downgrade")) as $is_fail
  | (($rec.evidence | type) == "object" and (($rec.evidence | length) > 0)) as $has_evidence
  | if ($is_pass_word and ($is_fail | not) and ($has_evidence | not))
      then [ { name: "evaluator pass without recorded evidence",
               description: "최신 게이트 결정 \($file)이 verdict=\($v)이나 non-empty evidence 객체가 없음 — Evidence over claims 위반. 실행 명령·출력을 evidence에 기록할 것",
               security_tier: "standard",
               source: "evidence" } ]
      else []
    end'
