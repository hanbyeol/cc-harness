#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")
[[ -z "$CMD" ]] && exit 0

# Normalize whitespace to prevent bypass via extra spaces
NORMALIZED_CMD=$(echo "$CMD" | tr -s '[:space:]' ' ')

BLOCKED=(
  "rm -rf /"
  "rm -rf /\\*"
  "git push.*--force[^-]"
  "git push.*--force$"
  "git reset --hard"
  "kubectl delete namespace"
  "DROP TABLE"
  "DROP DATABASE"
)

for p in "${BLOCKED[@]}"; do
  if echo "$NORMALIZED_CMD" | grep -qiE "$p"; then
    echo "BLOCKED: 위험 명령어 감지" >&2
    echo "  Pattern: $p" >&2
    echo "  Command: ${CMD:0:120}" >&2
    exit 2
  fi
done
exit 0
