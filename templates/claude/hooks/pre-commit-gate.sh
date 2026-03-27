#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)
echo "$INPUT" | jq -r '.stop_hook_active' 2>/dev/null | grep -q "true" && exit 0
cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

CHANGED=$(git diff --name-only HEAD 2>/dev/null || echo "")
[[ -z "$CHANGED" ]] && exit 0
ERRS=()

# Go
if echo "$CHANGED" | grep -q '\.go$'; then
  if command -v go &>/dev/null; then
    while IFS= read -r p; do
      go test "./$p/..." -count=1 -timeout=60s 2>/dev/null || ERRS+=("go test: $p")
    done < <(echo "$CHANGED" | grep '\.go$' | xargs -I{} dirname {} | sort -u)
  else
    echo "warning: go not found, skipping Go tests" >&2
  fi
fi

# TypeScript
if echo "$CHANGED" | grep -qE '\.(ts|tsx)$'; then
  if [[ -f "apps/web/package.json" ]]; then
    if command -v npx &>/dev/null; then
      (cd apps/web && npx tsc --noEmit 2>/dev/null) || ERRS+=("tsc type check")
    else
      echo "warning: npx not found, skipping TypeScript check" >&2
    fi
  fi
fi

# Dart/Flutter
if echo "$CHANGED" | grep -q '\.dart$'; then
  if command -v flutter &>/dev/null; then
    flutter analyze 2>/dev/null || ERRS+=("flutter analyze")
  elif command -v dart &>/dev/null; then
    dart analyze 2>/dev/null || ERRS+=("dart analyze")
  else
    echo "warning: dart/flutter not found, skipping Dart analysis" >&2
  fi
fi

# Proto
if echo "$CHANGED" | grep -q '\.proto$'; then
  if command -v buf &>/dev/null; then
    buf lint 2>/dev/null || ERRS+=("buf lint")
  else
    echo "warning: buf not found, skipping proto lint" >&2
  fi
fi

if [ ${#ERRS[@]} -gt 0 ]; then
  printf "Quality Gate FAILED:\n" >&2
  for e in "${ERRS[@]}"; do printf "  - %s\n" "$e" >&2; done
  exit 2
fi
exit 0
