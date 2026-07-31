#!/usr/bin/env bash
# shellcheck disable=SC2015  # `command -v X && X || true` 는 의도적 graceful-skip 패턴
set -euo pipefail
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")
[[ -z "$FILE" ]] && exit 0
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}" 2>/dev/null || exit 0
[[ ! -f "$FILE" ]] && exit 0

# Path traversal protection: resolve real path and verify within project
REAL_FILE=$(realpath "$FILE" 2>/dev/null) || exit 0
REAL_PROJECT=$(realpath "${CLAUDE_PROJECT_DIR:-$(pwd)}" 2>/dev/null) || exit 0
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
    # 보호 파일은 **포맷하지 않는다.** invariant-guard(PreToolUse:Edit)가 편집 결과를 해시해
    # `<sha> <경로>` 티켓을 발급하는데, 그 뒤 여기서 재포맷하면 파일 내용이 티켓과 어긋난다.
    # 그러면 protected-integrity.sh(PostToolUse:Bash)가 심사를 통과한 편집을 변조로 보고
    # HEAD로 되돌린다 — 실측: feature_list.json 티켓 f23259d… vs 실제 89f29b2…(= jq 재포맷본),
    # F66 등록이 조용히 폐기됐다. 포맷은 편의이고 무결성은 게이트다. 충돌하면 게이트를 살린다.
    # 아래 목록은 protected-integrity.sh의 PROTECTED_GLOBS 중 **.json 확장자를 갖는 것 전부**와
    # 같아야 한다. tests/protected-integrity.bats 가 두 목록의 정합을 검사한다.
    REL="${REAL_FILE#"$REAL_PROJECT"/}"
    case "$REL" in
      progress/harness-config.json | progress/feature_list.json | progress/contracts/sprint-*.json | progress/approval-queue.json | hooks/hooks.json)
        exit 0
        ;;
    esac
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
