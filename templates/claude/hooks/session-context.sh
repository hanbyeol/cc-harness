#!/usr/bin/env bash
set -euo pipefail
cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
LAST=$(git log --oneline -1 2>/dev/null || echo "none")
PHASE=$(jq -r '.current_phase // "unknown"' progress/phase-gate.json 2>/dev/null || echo "init")
PENDING=$(jq '[.features[] | select(.passes == false)] | length' progress/feature_list.json 2>/dev/null || echo "?")

# Iteration info
ITERATION=$(jq -r '.phases[.current_phase].current_iteration // 0' progress/phase-gate.json 2>/dev/null || echo "0")

cat <<CTX
=== Session Context ===
Branch: $BRANCH | Phase: $PHASE (iteration $ITERATION) | Pending: $PENDING
Last: $LAST
CTX

# Session handoff from previous session
if [[ -f progress/session-handoff.json ]]; then
  echo ""
  echo "=== Previous Session Handoff ==="
  jq -r '
    "Completed: " + ([.completed[]?] | join(", ")),
    "In Progress: " + (.in_progress // "none"),
    "Blockers: " + ([.blockers[]?] | join(", ")),
    "Next Actions: " + ([.next_actions[]?] | join(", ")),
    "Key Decisions: " + ([.key_decisions[]?] | join(", "))
  ' progress/session-handoff.json 2>/dev/null || true
fi

# Latest evaluator feedback
LATEST_FEEDBACK=$(ls -t progress/agent-comms/evaluator-feedback-*.json 2>/dev/null | head -1)
if [[ -n "$LATEST_FEEDBACK" ]]; then
  echo ""
  echo "=== Latest Evaluator Feedback ==="
  jq -r '"Score: \(.score)/10", "Verdict: \(.verdict)", "Issues: " + ([.issues[]?] | join("; "))' "$LATEST_FEEDBACK" 2>/dev/null || true
fi

echo ""
echo "→ progress/claude-progress.txt와 git log 먼저 확인"
