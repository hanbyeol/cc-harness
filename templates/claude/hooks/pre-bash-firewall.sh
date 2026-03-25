#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")
[[ -z "$CMD" ]] && exit 0

BLOCKED=(
  "rm -rf /"
  "git push.*--force"
  "git reset --hard"
  "kubectl delete namespace"
  "DROP TABLE"
  "DROP DATABASE"
)

for p in "${BLOCKED[@]}"; do
  if echo "$CMD" | grep -qiE "$p"; then
    echo "BLOCKED: 위험 명령어 — '$p'" >&2
    exit 2
  fi
done
exit 0
