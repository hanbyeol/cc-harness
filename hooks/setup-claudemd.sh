#!/usr/bin/env bash
#
# setup-claudemd.sh — Plugin SessionStart bootstrapper
#
# SessionStart 시 실행. 프로젝트에 harness 구성요소를 자동 세팅:
# 1. CLAUDE.md 생성/업데이트
# 2. agents, skills, hooks, rules → .claude/ 에 복사
# 3. settings.json에 hooks 등록
#
# 이미 세팅된 항목은 건너뛴다 (idempotent).
#
set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}" 2>/dev/null || exit 0

# Plugin root: 스크립트 위치 기준으로 결정
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ─── 1. Agents 복사 ───
if [[ -d "$PLUGIN_ROOT/agents" ]]; then
  mkdir -p .claude/agents
  for f in "$PLUGIN_ROOT"/agents/*.md; do
    [[ -f "$f" ]] || continue
    BASENAME=$(basename "$f")
    if [[ ! -f ".claude/agents/$BASENAME" ]]; then
      cp "$f" ".claude/agents/$BASENAME"
    fi
  done
fi

# ─── 2. Skills 복사 ───
if [[ -d "$PLUGIN_ROOT/skills" ]]; then
  for skill_dir in "$PLUGIN_ROOT"/skills/*/; do
    [[ -d "$skill_dir" ]] || continue
    SKILL_NAME=$(basename "$skill_dir")
    if [[ ! -d ".claude/skills/$SKILL_NAME" ]]; then
      mkdir -p ".claude/skills/$SKILL_NAME"
      cp -r "$skill_dir"* ".claude/skills/$SKILL_NAME/"
    fi
  done
fi

# ─── 3. Hooks 복사 (hooks.json 제외) ───
if [[ -d "$PLUGIN_ROOT/hooks" ]]; then
  mkdir -p .claude/hooks
  for f in "$PLUGIN_ROOT"/hooks/*.sh; do
    [[ -f "$f" ]] || continue
    BASENAME=$(basename "$f")
    # setup-claudemd.sh 자체는 복사하지 않음 (plugin hook으로만 실행)
    [[ "$BASENAME" == "setup-claudemd.sh" ]] && continue
    if [[ ! -f ".claude/hooks/$BASENAME" ]]; then
      cp "$f" ".claude/hooks/$BASENAME"
      chmod +x ".claude/hooks/$BASENAME"
    fi
  done
fi

# ─── 4. Rules 복사 ───
if [[ -d "$PLUGIN_ROOT/rules" ]]; then
  mkdir -p .claude/rules
  for f in "$PLUGIN_ROOT"/rules/*.md; do
    [[ -f "$f" ]] || continue
    BASENAME=$(basename "$f")
    if [[ ! -f ".claude/rules/$BASENAME" ]]; then
      cp "$f" ".claude/rules/$BASENAME"
    fi
  done
fi

# ─── 5. settings.json에 hooks 등록 ───
SETTINGS=".claude/settings.json"
if [[ -f "$SETTINGS" ]]; then
  # hooks 키가 없으면 추가
  if command -v jq &>/dev/null; then
    if ! jq -e '.hooks' "$SETTINGS" &>/dev/null; then
      MERGED=$(jq -s '.[0] * .[1]' "$SETTINGS" "$PLUGIN_ROOT/settings.json" 2>/dev/null) || true
      if [[ -n "$MERGED" ]]; then
        echo "$MERGED" | jq '.' > "$SETTINGS"
      fi
    fi
  fi
fi

# ─── 6. CLAUDE.md 생성/업데이트 ───
HARNESS_CLAUDE="$PLUGIN_ROOT/CLAUDE.md"
if [[ ! -f "$HARNESS_CLAUDE" ]]; then
  exit 0
fi

MARKER="<!-- cc-harness:begin -->"
MARKER_END="<!-- cc-harness:end -->"

harness_section() {
  echo "$MARKER"
  tail -n +2 "$HARNESS_CLAUDE"
  echo ""
  echo "$MARKER_END"
}

if [[ ! -f CLAUDE.md ]]; then
  {
    PROJECT_NAME=$(basename "${CLAUDE_PROJECT_DIR:-$(pwd)}")
    echo "# $PROJECT_NAME"
    echo ""
    harness_section
  } > CLAUDE.md
  exit 0
fi

if grep -q "$MARKER" CLAUDE.md 2>/dev/null; then
  TMPFILE=$(mktemp)
  trap 'rm -f "$TMPFILE"' EXIT
  sed -n "1,/^${MARKER}$/{ /^${MARKER}$/!p; }" CLAUDE.md > "$TMPFILE"
  harness_section >> "$TMPFILE"
  sed -n "/^${MARKER_END}$/,\${ /^${MARKER_END}$/!p; }" CLAUDE.md >> "$TMPFILE"
  mv "$TMPFILE" CLAUDE.md
else
  {
    echo ""
    harness_section
  } >> CLAUDE.md
fi
