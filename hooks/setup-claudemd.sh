#!/usr/bin/env bash
#
# setup-claudemd.sh — Plugin SessionStart bootstrapper
#
# SessionStart 시 실행. 프로젝트에 harness 구성요소를 세팅:
# 1. rules → .claude/rules/ 복사·갱신 (path-scoped rules는 plugin 네이티브 미지원)
# 2. CLAUDE.md 생성/갱신 (멱등 — 중복 삽입 방지)
# 3. 버전 업그레이드 감지 시 마이그레이션 실행
#
# agents/skills/hooks는 plugin이 네이티브로 로드하므로 복사하지 않는다.
#
# 업그레이드 프로세스:
# - .claude/.cc-harness-installed 에 설치된 plugin 버전을 기록
# - 버전이 같으면 마이그레이션·rules 갱신을 건너뜀 (매 세션 비용 없음)
# - rules는 .claude/.cc-harness-rules.sha256 manifest로 pristine 여부를 판별 —
#   사용자가 수정하지 않은 파일만 새 버전으로 자동 갱신, 수정본은 보존
#
set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}" 2>/dev/null || exit 0

# Plugin root: 스크립트 위치 기준으로 결정
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ─── 버전 상태 ───
STATE_FILE=".claude/.cc-harness-installed"
RULES_MANIFEST=".claude/.cc-harness-rules.sha256"
PLUGIN_VERSION="unknown"
if command -v jq &>/dev/null && [[ -f "$PLUGIN_ROOT/.claude-plugin/plugin.json" ]]; then
  PLUGIN_VERSION=$(jq -r '.version // "unknown"' "$PLUGIN_ROOT/.claude-plugin/plugin.json" 2>/dev/null || echo "unknown")
fi
INSTALLED_VERSION=""
[[ -f "$STATE_FILE" ]] && INSTALLED_VERSION=$(head -1 "$STATE_FILE" 2>/dev/null || echo "")
FIRST_RUN=0
[[ ! -f "$STATE_FILE" ]] && FIRST_RUN=1
VERSION_CHANGED=0
[[ "$INSTALLED_VERSION" != "$PLUGIN_VERSION" ]] && VERSION_CHANGED=1

hash_file() {
  if command -v shasum &>/dev/null; then
    shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
  elif command -v sha256sum &>/dev/null; then
    sha256sum "$1" 2>/dev/null | awk '{print $1}'
  else
    echo ""
  fi
}

manifest_get() {
  [[ -f "$RULES_MANIFEST" ]] || { echo ""; return; }
  awk -v name="$1" '$1 == name {print $2}' "$RULES_MANIFEST" 2>/dev/null | head -1
}

manifest_set() {
  local name="$1" hash="$2" tmp
  [[ -z "$hash" ]] && return 0
  tmp=$(mktemp)
  if [[ -f "$RULES_MANIFEST" ]]; then
    awk -v name="$1" '$1 != name' "$RULES_MANIFEST" > "$tmp" 2>/dev/null || true
  fi
  echo "$name $hash" >> "$tmp"
  mv "$tmp" "$RULES_MANIFEST"
}

# ─── 1. Rules 동기화 ───
RULES_UPDATED=()
RULES_PRESERVED=()
if [[ -d "$PLUGIN_ROOT/rules" ]]; then
  mkdir -p .claude/rules
  for f in "$PLUGIN_ROOT"/rules/*.md; do
    [[ -f "$f" ]] || continue
    BASENAME=$(basename "$f")
    DEST=".claude/rules/$BASENAME"
    if [[ ! -f "$DEST" ]]; then
      # 신규 복사 (없는 파일은 버전과 무관하게 항상 채움)
      cp "$f" "$DEST"
      manifest_set "$BASENAME" "$(hash_file "$DEST")"
    elif [[ "$VERSION_CHANGED" == "1" ]]; then
      NEW_HASH=$(hash_file "$f")
      CUR_HASH=$(hash_file "$DEST")
      REC_HASH=$(manifest_get "$BASENAME")
      if [[ "$CUR_HASH" == "$NEW_HASH" ]]; then
        # 이미 최신 — manifest만 보정 (pre-1.5 설치는 manifest가 없음)
        manifest_set "$BASENAME" "$NEW_HASH"
      elif [[ -n "$REC_HASH" && "$CUR_HASH" == "$REC_HASH" ]]; then
        # pristine (사용자 미수정) → 새 버전으로 갱신
        cp "$f" "$DEST"
        manifest_set "$BASENAME" "$NEW_HASH"
        RULES_UPDATED+=("$BASENAME")
      else
        # 사용자 수정본 또는 출처 불명 → 보존
        RULES_PRESERVED+=("$BASENAME")
      fi
    fi
  done
fi

# ─── 2. 마이그레이션 (버전 변경 시에만) ───
# v1.4 이하: agents/skills/hooks를 .claude/에 복사하던 방식 → 네이티브 로딩으로 전환.
# plugin 원본과 동일한 복사본만 제거하고, 수정된 파일은 사용자 커스터마이징으로 보존.
MIGRATED=0
CUSTOMIZED=()
if [[ "$VERSION_CHANGED" == "1" ]]; then
  if [[ -d .claude/agents && -d "$PLUGIN_ROOT/agents" ]]; then
    for f in .claude/agents/*.md; do
      [[ -f "$f" ]] || continue
      SRC="$PLUGIN_ROOT/agents/$(basename "$f")"
      if [[ -f "$SRC" ]]; then
        if cmp -s "$f" "$SRC"; then
          rm -f "$f"; MIGRATED=1
        else
          CUSTOMIZED+=("$f")
        fi
      fi
    done
    rmdir .claude/agents 2>/dev/null || true
  fi

  if [[ -d .claude/skills && -d "$PLUGIN_ROOT/skills" ]]; then
    for d in .claude/skills/*/; do
      [[ -d "$d" ]] || continue
      NAME=$(basename "$d")
      SRC="$PLUGIN_ROOT/skills/$NAME"
      if [[ -d "$SRC" ]]; then
        if diff -rq "$d" "$SRC" &>/dev/null; then
          rm -rf "$d"; MIGRATED=1
        else
          CUSTOMIZED+=("$d")
        fi
      fi
    done
    rmdir .claude/skills 2>/dev/null || true
  fi

  # hooks: settings.json의 hooks 섹션이 plugin 기본값과 동일할 때만 함께 제거
  # (스크립트만 지우면 settings.json의 참조가 깨져 매 세션 에러가 나므로 쌍으로 처리)
  SETTINGS=".claude/settings.json"
  if [[ -d .claude/hooks ]] && command -v jq &>/dev/null; then
    SETTINGS_HOOKS_MATCH=0
    if [[ -f "$SETTINGS" && -f "$PLUGIN_ROOT/settings.json" ]]; then
      if [[ "$(jq -S '.hooks // empty' "$SETTINGS" 2>/dev/null)" == "$(jq -S '.hooks // empty' "$PLUGIN_ROOT/settings.json" 2>/dev/null)" ]]; then
        SETTINGS_HOOKS_MATCH=1
      fi
    elif [[ ! -f "$SETTINGS" ]]; then
      SETTINGS_HOOKS_MATCH=1
    fi
    if [[ "$SETTINGS_HOOKS_MATCH" == "1" ]]; then
      for f in .claude/hooks/*.sh; do
        [[ -f "$f" ]] || continue
        SRC="$PLUGIN_ROOT/hooks/$(basename "$f")"
        if [[ -f "$SRC" ]] && cmp -s "$f" "$SRC"; then
          rm -f "$f"; MIGRATED=1
        fi
      done
      rmdir .claude/hooks 2>/dev/null || true
      if [[ ! -d .claude/hooks && -f "$SETTINGS" ]]; then
        TMP=$(mktemp)
        if jq 'del(.hooks)' "$SETTINGS" > "$TMP" 2>/dev/null; then
          mv "$TMP" "$SETTINGS"
        else
          rm -f "$TMP"
        fi
        MIGRATED=1
      fi
    fi
  fi
fi

# ─── 3. CLAUDE.md 생성/갱신 (멱등 — 매 세션 self-heal) ───
HARNESS_CLAUDE="$PLUGIN_ROOT/CLAUDE.md"
if [[ -f "$HARNESS_CLAUDE" ]]; then
  MARKER="<!-- cc-harness:begin -->"
  MARKER_END="<!-- cc-harness:end -->"
  # 마커 밖에 이미 하네스 내용이 존재하는지 판별하는 센티널 (CLAUDE.md 고유 문구)
  SENTINEL="## 기준 역전파 원칙"

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
  elif grep -qF "$MARKER" CLAUDE.md 2>/dev/null; then
    if ! grep -qF "$MARKER_END" CLAUDE.md 2>/dev/null; then
      # 손상된 마커(begin만 존재): 사용자 내용 파괴 위험 — 건드리지 않음
      echo "cc-harness: CLAUDE.md의 마커가 손상되어(end 누락) 갱신을 건너뜁니다." >&2
    else
      TMPFILE=$(mktemp)
      trap 'rm -f "$TMPFILE"' EXIT
      sed -n "1,/^${MARKER}$/{ /^${MARKER}$/!p; }" CLAUDE.md > "$TMPFILE"
      OUTSIDE_AFTER=$(sed -n "/^${MARKER_END}$/,\${ /^${MARKER_END}$/!p; }" CLAUDE.md)
      if grep -qF "$SENTINEL" "$TMPFILE" 2>/dev/null || { [[ -n "$OUTSIDE_AFTER" ]] && grep -qF "$SENTINEL" <<<"$OUTSIDE_AFTER"; }; then
        # 마커 밖에 이미 하네스 내용 존재 → 중복 섹션 제거 (dedupe)
        printf '%s\n' "$OUTSIDE_AFTER" >> "$TMPFILE"
        mv "$TMPFILE" CLAUDE.md
      else
        # 정상 케이스: 마커 섹션을 최신 내용으로 교체
        harness_section >> "$TMPFILE"
        printf '%s\n' "$OUTSIDE_AFTER" >> "$TMPFILE"
        mv "$TMPFILE" CLAUDE.md
      fi
    fi
  elif grep -qF "$SENTINEL" CLAUDE.md 2>/dev/null; then
    # 마커는 없지만 하네스 내용이 이미 존재 (템플릿으로 생성된 경우) → 삽입 스킵
    :
  else
    {
      echo ""
      harness_section
    } >> CLAUDE.md
  fi
fi

# ─── 4. 버전 기록 + 안내 ───
mkdir -p .claude
echo "$PLUGIN_VERSION" > "$STATE_FILE"

if [[ "$FIRST_RUN" == "1" ]]; then
  cat <<MSG

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  cc-harness v${PLUGIN_VERSION} 설치 완료
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

agents·skills·hooks는 plugin이 네이티브로 로드하며,
rules(.claude/rules/)와 CLAUDE.md 하네스 섹션이 프로젝트에 세팅되었습니다.

[첫 사용]
/progress 를 실행하면 현재 프로젝트 상태와 다음 작업을 확인할 수 있습니다.
Phase 1 시작: "SPEC.md를 작성해줘" → 인터뷰 후 spec-writer agent가 스펙을 작성합니다.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MSG
elif [[ "$VERSION_CHANGED" == "1" ]]; then
  echo "cc-harness: ${INSTALLED_VERSION:-pre-1.5} → ${PLUGIN_VERSION} 업그레이드를 적용했습니다."
  [[ "$MIGRATED" == "1" ]] && echo "  - .claude/ 복사본을 정리했습니다 (plugin이 네이티브로 로드 — ADR-001 참조)"
  if [[ ${#RULES_UPDATED[@]} -gt 0 ]]; then
    echo "  - rules 갱신: ${RULES_UPDATED[*]}"
  fi
  if [[ ${#RULES_PRESERVED[@]} -gt 0 ]]; then
    echo "  - 사용자 수정 rules 보존 (새 버전과 직접 비교 권장): ${RULES_PRESERVED[*]}"
  fi
fi

if [[ ${#CUSTOMIZED[@]} -gt 0 ]]; then
  echo "cc-harness: 커스터마이징된 복사본을 보존했습니다 (plugin 버전과 이중 등록될 수 있음):"
  printf '  - %s\n' "${CUSTOMIZED[@]}"
fi
