#!/usr/bin/env bash
#
# setup-claudemd.sh — CLAUDE.md 자동 생성/업데이트
#
# SessionStart 시 실행. 프로젝트의 CLAUDE.md에 harness 섹션이 없으면 추가.
# 기존 CLAUDE.md가 있으면 내용을 보존하고 harness 섹션만 append.
#
set -euo pipefail
cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

# Plugin root에서 harness CLAUDE.md 참조
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [[ -z "$PLUGIN_ROOT" ]]; then
  # fallback: 이 스크립트 기준으로 plugin root 추정
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

HARNESS_CLAUDE="$PLUGIN_ROOT/CLAUDE.md"
if [[ ! -f "$HARNESS_CLAUDE" ]]; then
  exit 0
fi

MARKER="<!-- cc-harness:begin -->"
MARKER_END="<!-- cc-harness:end -->"

# harness 섹션 내용 생성
harness_section() {
  echo "$MARKER"
  # CLAUDE.md에서 첫 번째 줄(# cc-harness) 제외하고 출력
  tail -n +2 "$HARNESS_CLAUDE"
  echo ""
  echo "$MARKER_END"
}

if [[ ! -f CLAUDE.md ]]; then
  # CLAUDE.md가 없으면 새로 생성
  {
    echo "# $(basename "$CLAUDE_PROJECT_DIR")"
    echo ""
    harness_section
  } > CLAUDE.md
  exit 0
fi

# CLAUDE.md가 이미 있는 경우
if grep -q "$MARKER" CLAUDE.md 2>/dev/null; then
  # 기존 harness 섹션 교체 (업데이트)
  # marker 사이 내용을 새 내용으로 교체
  TMPFILE=$(mktemp)
  trap 'rm -f "$TMPFILE"' EXIT

  # begin 마커 이전 내용
  sed -n "1,/^${MARKER}$/{ /^${MARKER}$/!p; }" CLAUDE.md > "$TMPFILE"
  # 새 harness 섹션
  harness_section >> "$TMPFILE"
  # end 마커 이후 내용
  sed -n "/^${MARKER_END}$/,\${ /^${MARKER_END}$/!p; }" CLAUDE.md >> "$TMPFILE"

  mv "$TMPFILE" CLAUDE.md
else
  # harness 섹션이 없으면 끝에 추가
  {
    echo ""
    harness_section
  } >> CLAUDE.md
fi
