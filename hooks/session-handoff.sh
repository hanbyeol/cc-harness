#!/usr/bin/env bash
#
# session-handoff.sh — Stop 훅
#
# 세션 종료 시 자동 상태 스냅샷을 저장하고(공용 로직은 lib.sh),
# 에이전트가 기록한 draft를 병합해 다음 세션에 넘긴다.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh" 2>/dev/null || exit 0

harness_cd || exit 0

# 1) 자동 상태 스냅샷 (phase·features·recent commits) — PreCompact 훅과 공유하는 로직.
#    스냅샷 생성에 실패하면 draft 병합 대상이 없으므로 그대로 종료(원 동작 보존).
harness_write_handoff_snapshot || exit 0

# 2) 에이전트가 남긴 draft를 병합하고 정리(세션 종료 시맨틱).
harness_merge_handoff_draft

exit 0
