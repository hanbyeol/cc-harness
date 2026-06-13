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

# 공용 헬퍼 (version_lt 등). 부재 시 폴백 정의로 동작 보장.
# shellcheck source=lib.sh
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" 2>/dev/null || true
if ! command -v version_lt &>/dev/null; then
  version_lt() { [[ "$1" != "$2" ]] && { [[ -z "$1" ]] || [[ "$1" == "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" ]]; }; }
fi

# 자기 방어: init.sh가 이 스크립트를 .claude/hooks/로 복사한 사본이 프로젝트 안에서
# 실행되면 PLUGIN_ROOT가 프로젝트의 .claude를 가리킨다 — 마이그레이션이 설치 자체를
# 자기 자신과 비교해 삭제(self-wipe)하므로 즉시 중단한다.
if [[ -d "$PWD/.claude" ]] && [[ "$PLUGIN_ROOT" -ef "$PWD/.claude" ]]; then
  exit 0
fi

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
# 복사본이 "현재 plugin 원본과 동일" 또는 "과거 릴리스 배포본과 동일(legacy hash)"일 때만
# 제거하고, 그 외(사용자 수정본)는 보존한다.
#
# v1.4.0 배포 파일들의 sha256 — 이번 릴리스에서 내용이 바뀐 파일의 pristine 구버전
# 복사본을 식별하기 위함. 새 릴리스에서 파일을 변경하면 직전 릴리스 해시를 여기 추가한다.
LEGACY_HASHES="
005b956f3c9e71dbdafbbe84fa4cf35fdad5ed0ff345acb53449f05b46032002
048804bcaec4dc2062a4edbac55a32402ff1af2be5926c4c310525604356f746
0a5249d8459ccc1a905c5f8848ccf95810435928e7853c97a91ab112a1c28712
1ae92c0ce6bb6ac7847ec49279af691b5f9955f96bd3e97b5dd085785e2d820b
1bd21fd5ae000c86023989acc4d5964b057897571060e86b4372e28b08f3119e
2ebc8b1b6da8726ca6859da6a9372d82a0030d736fe9fcba485379c004e1f927
4cf614e1d7c3d0dedfd0dc28eea749ae55287dd3a8cfc3f7d1004292f34b4e74
4e43213ee0f946440100498ec3de0736eafc50c2752d169b13f8e25724bb541e
91a37d04c980332efafc62d7e7b7dff92f8fde9d3fabd12c20d5293c2ecc0de2
95c3a7493b2dbbb964638479f1a73ce27f91b410c8320428947ef3a13580523d
9f805bf96bd6b589e20a64aae325e5163fb23043ac6f5a8bd6d8c2dd5b1996e4
af9b8d8d3b56d16ef3fb3ab943faa167c38e4b381d1e75cbc59d0a53947fe3cf
bcfce525e5463ee9b2aaaed34267acc6f6e81b51612c8ae93f5793ffeeddeb9b
c8b33ac956790d995292c23bbc209d8a3cde2d5f53d45ea30e5cf5ed666dc851
ced1f27b3b1446cb5850c596f312cefc338cd2d01b04e8e18e06f8679d3e669d
d1e4ca70a2192e1d8a56a9745c1624976d348fa3e1385e9ba3abaa54fc546e19
df79886572da82b97b2f2713d8a99405b9ecefe6910aff3b3996d060d126bbfb
e9859eadbc83be9a64443e9036ba4ae5a76065e3910e2cd52f129bfae4c806cf
f019975f6a8083cb641153d403103766fffb7285b4e5eac5d78b61eddd1da3ef
"

# 파일이 제거 가능한가: 현재 plugin 원본과 동일 OR 과거 배포본 해시와 일치
removable_copy() {
  local file="$1" src="$2" h
  if [[ -f "$src" ]] && cmp -s "$file" "$src"; then
    return 0
  fi
  h=$(hash_file "$file")
  [[ -n "$h" && "$LEGACY_HASHES" == *"$h"* ]]
}

MIGRATED=0
CUSTOMIZED=()
# v1.4 네이티브 로딩 마이그레이션은 "1.5.0 이전에서 올라올 때"만 필요하다.
# version_lt로 적용 범위를 가드 — 1.5+ 에서 1.6/1.7로 올라갈 땐 이 블록을 건너뛴다
# (이미 .claude 복사본이 없으므로 무해하지만, 비멱등 마이그레이션 추가 시 이 가드가 안전판).
NEEDS_V15_MIGRATION=0
if [[ "$VERSION_CHANGED" == "1" ]] && version_lt "$INSTALLED_VERSION" "1.5.0"; then
  NEEDS_V15_MIGRATION=1
fi
if [[ "$NEEDS_V15_MIGRATION" == "1" ]]; then
  if [[ -d .claude/agents && -d "$PLUGIN_ROOT/agents" ]]; then
    for f in .claude/agents/*.md; do
      [[ -f "$f" ]] || continue
      SRC="$PLUGIN_ROOT/agents/$(basename "$f")"
      if [[ -f "$SRC" ]]; then
        if removable_copy "$f" "$SRC"; then
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
        elif [[ -f "$d/SKILL.md" && $(find "$d" -type f | wc -l) -eq 1 ]] && removable_copy "$d/SKILL.md" "$SRC/SKILL.md"; then
          # SKILL.md 하나뿐인 디렉토리가 과거 배포본과 일치 → 제거 가능
          rm -rf "$d"; MIGRATED=1
        else
          CUSTOMIZED+=("$d")
        fi
      fi
    done
    rmdir .claude/skills 2>/dev/null || true
  fi

  # hooks: 스크립트와 settings.json 등록은 쌍으로만 제거한다 (부분 삭제 시 깨진 참조가
  # 매 이벤트마다 에러를 냄). 조건: (a) .claude/hooks의 모든 스크립트가 제거 가능하고
  # (b) settings.json의 hooks 섹션이 plugin 기본값과 동일(또는 settings.json 부재).
  SETTINGS=".claude/settings.json"
  if [[ -d .claude/hooks ]] && command -v jq &>/dev/null; then
    HOOKS_ALL_REMOVABLE=1
    for f in .claude/hooks/*.sh; do
      [[ -f "$f" ]] || continue
      if ! removable_copy "$f" "$PLUGIN_ROOT/hooks/$(basename "$f")"; then
        HOOKS_ALL_REMOVABLE=0
        CUSTOMIZED+=("$f")
      fi
    done
    SETTINGS_HOOKS_MATCH=0
    if [[ -f "$SETTINGS" && -f "$PLUGIN_ROOT/settings.json" ]]; then
      if [[ "$(jq -S '.hooks // empty' "$SETTINGS" 2>/dev/null)" == "$(jq -S '.hooks // empty' "$PLUGIN_ROOT/settings.json" 2>/dev/null)" ]]; then
        SETTINGS_HOOKS_MATCH=1
      fi
    elif [[ ! -f "$SETTINGS" ]]; then
      SETTINGS_HOOKS_MATCH=1
    fi
    if [[ "$HOOKS_ALL_REMOVABLE" == "1" && "$SETTINGS_HOOKS_MATCH" == "1" ]]; then
      rm -f .claude/hooks/*.sh
      rmdir .claude/hooks 2>/dev/null || true
      if [[ -f "$SETTINGS" ]]; then
        TMP=$(mktemp)
        if jq 'del(.hooks)' "$SETTINGS" > "$TMP" 2>/dev/null; then
          mv "$TMP" "$SETTINGS"
        else
          rm -f "$TMP"
        fi
      fi
      MIGRATED=1
    fi
  fi
fi

# ─── 3. CLAUDE.md 생성/갱신 (멱등 — 매 세션 self-heal, 내용 동일 시 재작성 없음) ───
HARNESS_CLAUDE="$PLUGIN_ROOT/CLAUDE.md"
if [[ -f "$HARNESS_CLAUDE" ]]; then
  MARKER="<!-- cc-harness:begin -->"
  MARKER_END="<!-- cc-harness:end -->"
  # 마커 밖에 이미 하네스 내용이 존재하는지 판별하는 센티널 (CLAUDE.md 고유 문구)
  SENTINEL="## 기준 역전파 원칙"

  SECTION_TMP=""
  OUTSIDE_TMP=""
  NEW_TMP=""
  trap 'rm -f "$SECTION_TMP" "$OUTSIDE_TMP" "$NEW_TMP"' EXIT

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
    BEGIN_COUNT=$(grep -cF "$MARKER" CLAUDE.md 2>/dev/null || true)
    END_COUNT=$(grep -cF "$MARKER_END" CLAUDE.md 2>/dev/null || true)
    if [[ "$BEGIN_COUNT" != "$END_COUNT" ]]; then
      # 손상된 마커(쌍 불일치): 사용자 내용 파괴 위험 — 건드리지 않음
      echo "cc-harness: CLAUDE.md의 마커 쌍이 불일치하여(begin=$BEGIN_COUNT end=$END_COUNT) 갱신을 건너뜁니다." >&2
    else
      SECTION_TMP=$(mktemp)
      OUTSIDE_TMP=$(mktemp)
      NEW_TMP=$(mktemp)
      harness_section > "$SECTION_TMP"
      # 마커 섹션(복수 가능)을 모두 제외한 바깥 내용 — 위치·개수와 무관하게 정확함
      awk -v b="$MARKER" -v e="$MARKER_END" '$0==b{s=1;next} $0==e{s=0;next} !s' CLAUDE.md > "$OUTSIDE_TMP"
      if grep -qF "$SENTINEL" "$OUTSIDE_TMP" 2>/dev/null; then
        # 마커 밖에 이미 하네스 내용 존재 → 마커 섹션 전부 제거 (dedupe)
        cp "$OUTSIDE_TMP" "$NEW_TMP"
      else
        # 첫 마커 섹션을 최신 내용으로 교체, 나머지 중복 섹션은 제거
        awk -v b="$MARKER" -v e="$MARKER_END" -v sec="$SECTION_TMP" '
          $0==b { if (!r) { while ((getline line < sec) > 0) print line; r=1 } s=1; next }
          $0==e { s=0; next }
          !s { print }
        ' CLAUDE.md > "$NEW_TMP"
      fi
      # 내용이 같으면 재작성하지 않음 (mtime 불필요 갱신 방지)
      if ! cmp -s "$NEW_TMP" CLAUDE.md; then
        mv "$NEW_TMP" CLAUDE.md
      fi
    fi
  elif grep -qF "$SENTINEL" CLAUDE.md 2>/dev/null; then
    # 마커는 없지만 하네스 내용이 이미 존재 (구버전 템플릿으로 생성된 경우) → 삽입 스킵
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
