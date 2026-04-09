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

# ─── 7. 첫 실행 시 설치 완료 메시지 ───
FIRSTRUN_MARKER=".claude/.cc-harness-installed"
if [[ ! -f "$FIRSTRUN_MARKER" ]]; then
  mkdir -p .claude
  touch "$FIRSTRUN_MARKER"
  cat <<'MSG'

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  cc-harness 설치 완료
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

하네스 구성을 완료하려면 Claude Code를 재실행해주세요.

  $ claude

[왜 재실행이 필요한가요?]
하네스는 SessionStart 훅을 통해 부트스트래핑됩니다.
새 세션을 시작해야 다음 구성요소들이 프로젝트에 자동 복사됩니다:

  Agents   → .claude/agents/    (spec-writer, architect, evaluator 등 8개)
  Skills   → .claude/skills/    (/change-request, /implement, /progress, /sync-docs)
  Hooks    → .claude/hooks/     (bash-firewall, auto-formatter, session-handoff 등)
  Rules    → .claude/rules/     (언어/플랫폼별 코딩 규칙 11개)
  CLAUDE.md → 프로젝트 루트      (하네스 워크플로우 가이드 자동 삽입)

[부트스트래핑 확인 방법]
재실행 후 정상 완료되면:
  1. .claude/agents/, skills/, hooks/, rules/ 디렉토리 생성됨
  2. CLAUDE.md에 cc-harness 섹션이 삽입됨
  3. 세션 시작 시 브랜치, phase, pending features 컨텍스트 자동 주입됨

[첫 사용]
부트스트래핑 완료 후 /progress 를 실행하면
현재 프로젝트 상태와 다음 작업을 확인할 수 있습니다.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MSG
fi
