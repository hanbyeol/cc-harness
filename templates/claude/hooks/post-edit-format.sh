#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")
[[ -z "$FILE" ]] && exit 0
cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

case "$FILE" in
  *.go)       gofmt -w "$FILE" 2>/dev/null; goimports -w "$FILE" 2>/dev/null ;;
  *.swift)    swiftformat "$FILE" 2>/dev/null ;;
  *.kt|*.kts) ktlint --format "$FILE" 2>/dev/null ;;
  *.ts|*.tsx|*.js|*.jsx) npx prettier --write "$FILE" 2>/dev/null ;;
  *.java)     google-java-format -i "$FILE" 2>/dev/null ;;
  *.proto)    buf format -w "$FILE" 2>/dev/null ;;
  *.json)     jq '.' "$FILE" > "$FILE.tmp" 2>/dev/null && mv "$FILE.tmp" "$FILE" ;;
esac
exit 0
