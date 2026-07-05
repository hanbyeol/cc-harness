#!/usr/bin/env bash
#
# pre-compact.sh — PreCompact 훅
#
# 컨텍스트 컴팩션 직전에 세션 상태 스냅샷을 저장하고(공용 로직은 lib.sh — Stop 훅과 공유),
# 아직 기록되지 않은 결정·블로커가 컴팩션으로 유실되지 않도록 기록을 유도한다.
#
# 관측·유도 장치이지 게이트가 아니다:
#  - 어떤 실패에도 컴팩션을 막지 않도록 항상 exit 0 (set -e 미사용 + 방어적 || true).
#  - decision:block 을 절대 방출하지 않는다 — 컴팩션을 중단시키지 않는다.
#  - jq 부재 시 session-handoff.sh와 동일하게 degrade(스냅샷·신호 생략).
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || exit 0
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh" 2>/dev/null || exit 0

harness_cd || exit 0

# 1) 컴팩션 직전 자동 상태 스냅샷 (Stop 훅과 동일 로직). 실패해도 컴팩션은 진행.
harness_write_handoff_snapshot || true

# 2) draft가 없으면 — 미기록 결정·블로커가 컴팩션으로 유실될 수 있으므로 기록을 유도한다.
#    draft가 이미 있으면 에이전트가 이미 기록한 것이므로 중복 신호를 생략(스냅샷만).
if [[ ! -f progress/session-handoff-draft.json ]] && has_jq; then
  MSG="컨텍스트 컴팩션이 임박했습니다. 이 세션의 핵심 결정·블로커·다음 작업이 아직 progress/session-handoff-draft.json에 기록되지 않았다면, 컴팩션으로 유실되기 전에 지금 기록하세요 — key_decisions·blockers·next_actions·in_progress 필드."
  jq -cn --arg ctx "$MSG" \
    '{hookSpecificOutput: {hookEventName: "PreCompact", additionalContext: $ctx}}' 2>/dev/null || true
fi

exit 0
