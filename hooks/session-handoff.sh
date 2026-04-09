#!/usr/bin/env bash
set -euo pipefail
cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

# Read current progress state (with validation)
PHASE="unknown"
PENDING="[]"
DONE="[]"
if [[ -f progress/phase-gate.json ]] && command -v jq &>/dev/null; then
  PHASE=$(jq -r '.current_phase // "unknown"' progress/phase-gate.json 2>/dev/null || echo "unknown")
fi
if [[ -f progress/feature_list.json ]] && command -v jq &>/dev/null; then
  PENDING=$(jq -c '[.features[] | select(.passes == false) | .id + ": " + .name]' progress/feature_list.json 2>/dev/null || echo "[]")
  DONE=$(jq -c '[.features[] | select(.passes == true) | .id + ": " + .name]' progress/feature_list.json 2>/dev/null || echo "[]")
fi

# Recent commits this session (last 2 hours)
RECENT_COMMITS="[]"
if COMMITS_RAW=$(git log --oneline --since="2 hours ago" 2>/dev/null | head -10); then
  if [[ -n "$COMMITS_RAW" ]]; then
    RECENT_COMMITS=$(echo "$COMMITS_RAW" | jq -Rs 'split("\n") | map(select(length > 0))' 2>/dev/null || echo "[]")
  fi
fi

TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Build handoff JSON safely using jq instead of heredoc interpolation
jq -n \
  --arg ts "$TIMESTAMP" \
  --arg phase "$PHASE" \
  --argjson completed "$DONE" \
  --argjson pending "$PENDING" \
  --argjson recent_commits "$RECENT_COMMITS" \
  '{
    timestamp: $ts,
    phase: $phase,
    completed: $completed,
    pending: $pending,
    recent_commits: $recent_commits,
    in_progress: null,
    blockers: [],
    next_actions: [],
    key_decisions: []
  }' > progress/session-handoff.json.tmp 2>/dev/null

# Validate and move
if jq '.' progress/session-handoff.json.tmp &>/dev/null; then
  mv progress/session-handoff.json.tmp progress/session-handoff.json
else
  rm -f progress/session-handoff.json.tmp
  exit 0
fi

# Merge in agent-written fields if draft exists (recursive deep merge)
if [[ -f progress/session-handoff-draft.json ]]; then
  if command -v jq &>/dev/null; then
    if jq -s '
      def deep_merge(a; b):
        a as $a | b as $b |
        if ($a | type) == "object" and ($b | type) == "object" then
          ($a | keys) as $ak | ($b | keys) as $bk |
          ([$ak[], $bk[]] | unique) | reduce .[] as $k (
            {};
            if ($a | has($k)) and ($b | has($k)) then
              . + { ($k): deep_merge($a[$k]; $b[$k]) }
            elif ($b | has($k)) then
              . + { ($k): $b[$k] }
            else
              . + { ($k): $a[$k] }
            end
          )
        elif ($b | type) == "null" then $a
        else $b end;
      deep_merge(.[0]; .[1])
    ' progress/session-handoff.json progress/session-handoff-draft.json \
        > progress/session-handoff.json.tmp 2>/dev/null; then
      mv progress/session-handoff.json.tmp progress/session-handoff.json
      rm -f progress/session-handoff-draft.json
    else
      rm -f progress/session-handoff.json.tmp
    fi
  fi
fi

exit 0
