#!/usr/bin/env bash
#
# subagent-evaluator-log.sh — SubagentStop(^cc-harness:evaluator$) 훅
#
# evaluator 서브에이전트가 종료할 때 Claude Code가 이 훅을 실행한다 — 메인 루프가
# 발화 자체를 위조할 수 없는 신뢰 지점이다. 실행 사실을 progress/agent-comms/
# evaluator-runs.jsonl에 한 줄 append로 기록해, invariant-guard(INV-11)가 passes 전환 시
# 'evaluator가 실제로 돌았는가'를 이 기록과 대조하게 한다(F54).
#
# 순수 기록(side-effect) 훅이다 — evaluator 판정 결과·종료를 바꾸지 않으며, 어떤 실패에도
# evaluator 흐름을 막지 않기 위해 **항상 exit 0**한다(기록 실패는 조용히 무시; 그 경우 이후
# passes 전환이 INV-11의 실행기록 대조에서 보수적으로 차단될 수 있다 — fail-closed 방향).
#
# 한계(정직히): evaluator-runs.jsonl도 결국 파일이라 완전한 위조 방지는 불가능하다
# (self-referential 보호의 한계, docs/INVARIANTS.md 위협모델). 이 훅은 위조 난이도를
# 'feedback 파일 1개 작성'에서 '실제 evaluator 실행이 훅에 캡처됨'으로 올리는 speed-bump다.
#
set -euo pipefail

INPUT=$(cat 2>/dev/null || echo "")

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh" 2>/dev/null || exit 0

harness_cd || exit 0

# jq 없으면 안전하게 통과(기록만 못 함 — evaluator 흐름 비차단). INV-11은 jq 부재 시 이미
# 보호파일 편집을 fail-closed로 막으므로(F41), 기록 부재가 passes 전환을 무단 허용하지 않는다.
has_jq || exit 0

# 방어적 재확인: matcher가 evaluator만 매치하지만, 오배선·직접 호출에 대비해 agent type도 본다.
# SubagentStop 입력에는 agent_type이 없을 수 있으므로(버전차), 있으면만 검사한다.
AGENT_TYPE=$(printf '%s' "$INPUT" | jq -r '.agent_type // empty' 2>/dev/null || echo "")
if [[ -n "$AGENT_TYPE" && "$AGENT_TYPE" != *"evaluator"* ]]; then
  exit 0
fi

AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null || echo "")
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.agent_transcript_path // empty' 2>/dev/null || echo "")
SESSION=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || echo "")
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
# epoch(정수 초)도 함께 기록한다 — INV-11(F54)의 '시간창' 검사는 논리적/반올림된 feedback
# 파일명 타임스탬프가 아니라 신뢰 가능한 벽시계로 최근성을 판정해야 flaky하지 않다. 정수 비교라
# BSD/GNU date의 ISO 파싱 차이(-d vs -jf)에도 무관하다. date 실패 시 빈 값 → 그 레코드는
# 시간창 검사에서 보수적으로 제외된다(fail-closed 방향).
EPOCH=$(date +%s 2>/dev/null || echo "")

COMMS_DIR="progress/agent-comms"
mkdir -p "$COMMS_DIR" 2>/dev/null || exit 0
RUNS="$COMMS_DIR/evaluator-runs.jsonl"

# 한 줄 JSON append. jq -c로 유효 JSON을 보장(수동 문자열 조립의 이스케이프 버그 회피).
LINE=$(jq -cn \
  --arg id "$AGENT_ID" \
  --arg ts "$TS" \
  --arg tr "$TRANSCRIPT" \
  --arg sid "$SESSION" \
  --arg ep "$EPOCH" \
  '{agent_id:$id, timestamp:$ts, epoch:($ep|tonumber?), transcript_path:$tr, session_id:$sid}' 2>/dev/null || echo "")

[[ -n "$LINE" ]] && printf '%s\n' "$LINE" >> "$RUNS" 2>/dev/null || true

exit 0
