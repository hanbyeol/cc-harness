#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")
[[ -z "$FILE" ]] && exit 0
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}" 2>/dev/null || exit 0
[[ ! -f "$FILE" ]] && exit 0

# Path traversal protection: resolve real path and verify within project
REAL_FILE=$(realpath "$FILE" 2>/dev/null) || exit 0
REAL_PROJECT=$(realpath "$CLAUDE_PROJECT_DIR" 2>/dev/null) || exit 0
[[ "$REAL_FILE" != "$REAL_PROJECT"/* ]] && exit 0

case "$FILE" in
  *.go)
    command -v gofmt &>/dev/null && gofmt -w "$FILE" 2>/dev/null || true
    command -v goimports &>/dev/null && goimports -w "$FILE" 2>/dev/null || true
    ;;
  *.swift)
    command -v swiftformat &>/dev/null && swiftformat "$FILE" 2>/dev/null || true
    ;;
  *.kt|*.kts)
    command -v ktlint &>/dev/null && ktlint --format "$FILE" 2>/dev/null || true
    ;;
  *.ts|*.tsx|*.js|*.jsx)
    command -v npx &>/dev/null && npx prettier --write "$FILE" 2>/dev/null || true
    ;;
  *.java)
    command -v google-java-format &>/dev/null && google-java-format -i "$FILE" 2>/dev/null || true
    ;;
  *.dart)
    command -v dart &>/dev/null && dart format "$FILE" 2>/dev/null || true
    ;;
  *.proto)
    command -v buf &>/dev/null && buf format -w "$FILE" 2>/dev/null || true
    ;;
  *.cs)
    if command -v dotnet &>/dev/null; then
      PROJ=$(find "$(dirname "$FILE")" -maxdepth 4 -name "*.csproj" 2>/dev/null | head -1)
      if [[ -n "$PROJ" ]]; then
        dotnet format "$(dirname "$PROJ")" --include "$FILE" 2>/dev/null || true
      fi
    fi
    ;;
  *.json)
    if command -v jq &>/dev/null; then
      if jq '.' "$FILE" > "$FILE.tmp" 2>/dev/null; then
        mv "$FILE.tmp" "$FILE"
      else
        rm -f "$FILE.tmp"
      fi
    fi
    ;;
esac
exit 0
