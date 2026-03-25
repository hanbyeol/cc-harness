#!/usr/bin/env bash
set -euo pipefail
cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

# Read current progress state
PHASE=$(jq -r '.current_phase // "unknown"' progress/phase-gate.json 2>/dev/null || echo "unknown")
PENDING=$(jq -c '[.features[] | select(.passes == false) | .id + ": " + .name]' progress/feature_list.json 2>/dev/null || echo "[]")
DONE=$(jq -c '[.features[] | select(.passes == true) | .id + ": " + .name]' progress/feature_list.json 2>/dev/null || echo "[]")

# Recent commits this session (last 2 hours)
RECENT_COMMITS=$(git log --oneline --since="2 hours ago" 2>/dev/null | head -10 | jq -Rs 'split("\n") | map(select(length > 0))' 2>/dev/null || echo "[]")

# Build handoff JSON
cat > progress/session-handoff.json << HANDOFF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "phase": "$PHASE",
  "completed": $DONE,
  "pending": $PENDING,
  "recent_commits": $RECENT_COMMITS,
  "in_progress": null,
  "blockers": [],
  "next_actions": [],
  "key_decisions": []
}
HANDOFF

# Merge in agent-written fields if draft exists
if [[ -f progress/session-handoff-draft.json ]]; then
  if command -v jq &>/dev/null; then
    jq -s '.[0] * .[1]' progress/session-handoff.json progress/session-handoff-draft.json \
      > progress/session-handoff.json.tmp 2>/dev/null \
      && mv progress/session-handoff.json.tmp progress/session-handoff.json
    rm -f progress/session-handoff-draft.json
  fi
fi

exit 0
