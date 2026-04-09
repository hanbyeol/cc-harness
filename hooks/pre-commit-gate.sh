#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)
echo "$INPUT" | jq -r '.stop_hook_active' 2>/dev/null | grep -q "true" && exit 0
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}" 2>/dev/null || exit 0

CHANGED=$(git diff --name-only HEAD 2>/dev/null || echo "")
[[ -z "$CHANGED" ]] && exit 0
ERRS=()

# Sprint Contract: warn if no contract exists (non-blocking)
if echo "$CHANGED" | grep -qE '\.(go|ts|tsx|js|jsx|dart|kt|swift|cs|java)$'; then
  if command -v jq &>/dev/null; then
    LATEST_CONTRACT=$(find progress/contracts -maxdepth 1 -name "sprint-*.json" -print 2>/dev/null | sort -r | head -1 || true)
    if [[ -z "$LATEST_CONTRACT" ]] && [[ -d progress/contracts ]]; then
      echo "info: Sprint Contract 없이 코드 변경 중 — /implement로 contract 작성 권장" >&2
    fi
  fi
fi

# Go
if echo "$CHANGED" | grep -q '\.go$'; then
  if command -v go &>/dev/null; then
    COVERAGE_DIR=$(mktemp -d)
    GO_COVERAGE_TOTAL=""
    while IFS= read -r p; do
      COVER_FILE="$COVERAGE_DIR/$(echo "$p" | tr '/' '_').out"
      go test "./$p/..." -count=1 -timeout=60s -coverprofile="$COVER_FILE" 2>/dev/null || ERRS+=("go test: $p")
    done < <(echo "$CHANGED" | grep '\.go$' | xargs -I{} dirname {} | sort -u)
    # Aggregate coverage and report
    if command -v go &>/dev/null; then
      for f in "$COVERAGE_DIR"/*.out; do
        [[ -f "$f" ]] || continue
        COV=$(go tool cover -func="$f" 2>/dev/null | tail -1 | awk '{print $NF}' || true)
        if [[ -n "$COV" ]]; then
          GO_COVERAGE_TOTAL="$COV"
          echo "info: Go coverage: $COV" >&2
        fi
      done
    fi
    rm -rf "$COVERAGE_DIR"
    # Write coverage to progress for evaluator
    if [[ -n "$GO_COVERAGE_TOTAL" ]] && command -v jq &>/dev/null; then
      mkdir -p progress
      jq -n --arg go "$GO_COVERAGE_TOTAL" '{"go": $go}' > progress/coverage-report.json 2>/dev/null || true
    fi
  else
    echo "warning: go not found, skipping Go tests" >&2
  fi
fi

# TypeScript
if echo "$CHANGED" | grep -qE '\.(ts|tsx)$'; then
  if command -v npx &>/dev/null; then
    # Find tsconfig.json dynamically (not hardcoded to apps/web)
    TS_ROOT=""
    for candidate in "apps/web" "." $(echo "$CHANGED" | grep -E '\.(ts|tsx)$' | head -1 | xargs dirname 2>/dev/null); do
      if [[ -f "$candidate/tsconfig.json" ]]; then
        TS_ROOT="$candidate"
        break
      fi
    done
    if [[ -n "$TS_ROOT" ]]; then
      (cd "$TS_ROOT" && npx tsc --noEmit 2>/dev/null) || ERRS+=("tsc type check: $TS_ROOT")
      # Coverage: check if jest is available
      if [[ -f "$TS_ROOT/package.json" ]] && grep -q '"jest"' "$TS_ROOT/package.json" 2>/dev/null; then
        TS_COV=$(cd "$TS_ROOT" && npx jest --coverage --coverageReporters=text-summary 2>/dev/null | grep 'Stmts' | awk '{print $4}' || true)
        if [[ -n "$TS_COV" ]]; then
          echo "info: TypeScript coverage (statements): $TS_COV" >&2
          if command -v jq &>/dev/null; then
            mkdir -p progress
            if [[ -f progress/coverage-report.json ]]; then
              jq --arg ts "$TS_COV" '. + {"typescript": $ts}' progress/coverage-report.json > progress/coverage-report.json.tmp 2>/dev/null && mv progress/coverage-report.json.tmp progress/coverage-report.json || true
            else
              jq -n --arg ts "$TS_COV" '{"typescript": $ts}' > progress/coverage-report.json 2>/dev/null || true
            fi
          fi
        fi
      fi
    fi
  else
    echo "warning: npx not found, skipping TypeScript check" >&2
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

# Unity (C#)
if echo "$CHANGED" | grep -q '\.cs$'; then
  if command -v dotnet &>/dev/null; then
    CSPROJ=$(find . -maxdepth 5 -name "*.csproj" 2>/dev/null | head -1)
    if [[ -n "$CSPROJ" ]]; then
      dotnet build "$CSPROJ" --no-restore -v quiet 2>/dev/null || ERRS+=("dotnet build")
    fi
  else
    echo "warning: dotnet not found, skipping Unity C# build check" >&2
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

# Secrets detection (gitleaks)
if command -v gitleaks &>/dev/null; then
  if ! gitleaks detect --source . --no-banner --no-color -v 2>/dev/null | head -5 >/dev/null 2>&1; then
    ERRS+=("gitleaks: secrets detected in repository")
  fi
else
  # Fallback: basic pattern scan on staged/changed files
  if echo "$CHANGED" | xargs grep -lEi '(AKIA[0-9A-Z]{16}|sk-[a-zA-Z0-9]{48}|ghp_[a-zA-Z0-9]{36}|-----BEGIN (RSA |EC )?PRIVATE KEY)' 2>/dev/null | head -3 | grep -q .; then
    ERRS+=("secrets: potential API key or private key detected in changed files")
  fi
fi

if [ ${#ERRS[@]} -gt 0 ]; then
  printf "Quality Gate FAILED:\n" >&2
  for e in "${ERRS[@]}"; do printf "  - %s\n" "$e" >&2; done
  exit 2
fi
exit 0
