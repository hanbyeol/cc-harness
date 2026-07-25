#!/usr/bin/env bash
#
# audit-integrity.sh — security-auditor 산출 무결성 프로브 (F55)
# security-auditor는 Opus 5를 사용하며, Opus 5는 강화된 사이버보안 안전장치로 정상적인
# 방어 목적 감사도 refusal할 수 있다. refusal된 서브에이전트는 빈/부실 산출을 남길 수 있고,
# 그 상태는 "감사했는데 이슈가 없음(통과)"과 겉보기가 같아 critical 보안 게이트가 조용히
# 무력화되는 경로가 된다. 이 프로브는 둘을 구분한다:
#   - 정상 통과  : 검사를 수행한 흔적이 있다 (checklist_compliance.total_items > 0
#                  또는 scan_tools 비어있지 않음) — findings가 0건이어도 후보 아님
#   - 빈 산출    : 검사 흔적이 전혀 없다 — 후보로 표면화
#   - refusal    : summary/error/note에 거절 마커가 있다 — 후보로 표면화
# 산출 파일이 아예 없는 경우는 "아직 감사 미실행"인 정상 상태이므로 후보로 올리지 않는다(오탐 방지).
# 후보를 JSON 배열로 출력: [{name,description,security_tier,source:"audit-integrity"}]
# 읽기 전용 — 파일을 수정하지 않는다. jq/파일 부재·malformed 시 graceful degrade([]).
#
set -euo pipefail
command -v jq &>/dev/null || { echo "[]"; exit 0; }

DIR="progress/agent-comms"
[[ -d "$DIR" ]] || { echo "[]"; exit 0; }

# archive/ 제외, security-audit*.json 중 파일명 lexical 최신 1건
# (security-auditor-output.json 고정명과 security-audit-{timestamp}.json 양쪽을 커버)
LATEST=$(find "$DIR" -maxdepth 1 -type f -name 'security-audit*.json' 2>/dev/null | sort | tail -1)
[[ -n "$LATEST" ]] || { echo "[]"; exit 0; }

# malformed → graceful([]) (진단을 망가뜨리지 않음)
REC=$(jq -c . "$LATEST" 2>/dev/null) || { echo "[]"; exit 0; }
[[ -n "$REC" ]] || { echo "[]"; exit 0; }

BASE=$(basename "$LATEST")

jq -c -n --argjson rec "$REC" --arg file "$BASE" '
  # 검사 수행 흔적: 체크리스트 항목 수 또는 실행한 스캔 도구
  ((($rec.checklist_compliance.total_items // 0) | if type=="number" then . else 0 end)) as $items
  | (($rec.scan_tools // []) | if type=="array" then length else 0 end)               as $tools
  | (($rec.findings // null) | if type=="array" then length else -1 end)              as $findings
  # refusal 마커는 자유 텍스트 필드로만 한정 — findings 본문까지 훑으면
  # "refusal handling missing" 같은 정상 finding에 오탐한다
  | ([ $rec.summary?, $rec.error?, $rec.note?, $rec.notes? ]
      | map(select(type=="string")) | join(" ") | ascii_downcase)                      as $text
  | ($text | test("refus|declin|cannot assist|unable to comply|can.t help with"))     as $refused
  | (($items <= 0) and ($tools <= 0))                                                 as $no_trace
  | if $refused
      then [ { name: "security audit refused — gate not exercised",
               description: "\($file)의 자유 텍스트에 거절 마커가 있음 — security-auditor(Opus 5)가 cyber classifier로 refusal됐을 수 있다. 이 산출을 이슈 없음(통과)으로 해석하지 말 것. 재실행하거나 해당 감사만 claude-opus-4-8로 폴백(F55)",
               security_tier: "critical",
               source: "audit-integrity" } ]
    elif $no_trace
      then [ { name: "security audit produced no evidence of execution",
               description: "\($file)에 검사 수행 흔적이 없음 (checklist_compliance.total_items=\($items), scan_tools=\($tools), findings=\($findings)) — 감사를 수행하고 이슈가 없었던 것이 아니라 감사 자체가 수행되지 않았을 가능성. refusal 또는 중단된 실행. critical 보안 게이트를 통과로 간주하지 말 것",
               security_tier: "critical",
               source: "audit-integrity" } ]
      else []
    end'
