#!/usr/bin/env bash
#
# cc-harness — Claude Code Full-SDLC Harness Bootstrapper
#
# One-command harness setup for Claude Code projects.
# Copies templates/ into target project with preset-based filtering.
#
# Install & Run:
#   npx cc-harness                    # recommended
#   npm install -g cc-harness         # global install
#   bash <(curl -sL https://raw.githubusercontent.com/hanbyeol/cc-harness/main/init.sh)
#
# Update existing harness:
#   npx cc-harness --update
#
# Presets:
#   go-minimal  — Go single service (lightest)
#   go-k8s      — Go + Kubernetes + ArgoCD
#   fullstack   — Go + React + iOS + Android + K8s + Proto
#   mobile      — React Native + Flutter
#   unity       — Unity3D + C# (with mcp-unity MCP auto-config)
#   custom      — Interactive selection
#
# https://github.com/hanbyeol/cc-harness
#
set -euo pipefail

# ─── Colors (disabled in non-TTY) ───
if [[ -t 1 ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  CYAN='\033[0;36m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' CYAN='' NC=''
fi

log()  { echo -e "${GREEN}[harness]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
err()  { echo -e "${RED}[error]${NC} $*" >&2; }
info() { echo -e "${CYAN}[info]${NC} $*"; }

# ─── Cross-platform sed -i ───
sedi() {
  if [[ "$OSTYPE" == darwin* ]]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

# ─── Parse args ───
PRESET=""
PROJECT_NAME=""
FORCE=false
UPDATE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --preset)  PRESET="$2"; shift 2 ;;
    --name)    PROJECT_NAME="$2"; shift 2 ;;
    --force)   FORCE=true; shift ;;
    --update)  UPDATE=true; shift ;;
    -h|--help)
      echo "cc-harness — Claude Code Full-SDLC Harness Bootstrapper"
      echo ""
      echo "Usage: npx cc-harness [OPTIONS]"
      echo "       cc-harness [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --preset <name>   Preset: go-minimal | go-k8s | fullstack | mobile | unity | custom"
      echo "  --name <name>     Project name (default: directory name)"
      echo "  --force           Overwrite existing .claude/ (backs up to .claude.bak.*)"
      echo "  --update          Update harness in existing project (preserves user data)"
      echo "  -h, --help        Show this help"
      echo ""
      echo "Install:"
      echo "  npx cc-harness                             # one-time run (recommended)"
      echo "  npm install -g cc-harness && cc-harness    # global install"
      echo "  bash <(curl -sL https://raw.githubusercontent.com/hanbyeol/cc-harness/main/init.sh)"
      echo ""
      echo "Examples:"
      echo "  npx cc-harness                             # interactive"
      echo "  npx cc-harness --preset go-k8s             # Go + Kubernetes"
      echo "  npx cc-harness --preset fullstack --force   # full stack, overwrite"
      echo "  npx cc-harness --update                    # update existing harness"
      exit 0 ;;
    *) err "Unknown arg: $1"; exit 1 ;;
  esac
done

# ─── Detect project root ───
if ! command -v git &>/dev/null; then
  err "git이 설치되어 있지 않습니다."
  exit 1
fi

if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  err "git 리포지토리가 아닙니다. 프로젝트 루트에서 실행하세요."
  exit 1
fi

PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT"

if [[ -z "$PROJECT_NAME" ]]; then
  PROJECT_NAME=$(basename "$PROJECT_ROOT")
fi

# Validate PROJECT_NAME (alphanumeric, hyphens, underscores, dots only)
if ! [[ "$PROJECT_NAME" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  err "프로젝트 이름에 허용되지 않는 문자가 포함되어 있습니다: $PROJECT_NAME"
  err "영문, 숫자, 하이픈(-), 언더스코어(_), 점(.)만 사용 가능합니다."
  exit 1
fi

# ═══════════════════════════════════════════════════════════════════
# RESOLVE TEMPLATE SOURCE
# ═══════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/templates"
PLUGIN_DIR="$SCRIPT_DIR"
CLEANUP_TEMP=false

# ─── Cleanup trap for temp directories ───
cleanup() { [[ "$CLEANUP_TEMP" == true ]] && rm -rf "/tmp/cc-harness-$$" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

if [[ ! -d "$TEMPLATE_DIR" ]]; then
  TEMP_CLONE="/tmp/cc-harness-$$"
  log "템플릿 다운로드 중..."
  if ! git clone --depth 1 --single-branch https://github.com/hanbyeol/cc-harness.git "$TEMP_CLONE" 2>&1 | tail -3; then
    err "템플릿 다운로드 실패. 인터넷 연결을 확인하세요."
    rm -rf "$TEMP_CLONE"
    exit 1
  fi
  TEMPLATE_DIR="$TEMP_CLONE/templates"
  PLUGIN_DIR="$TEMP_CLONE"
  if [[ ! -d "$TEMPLATE_DIR" ]]; then
    err "다운로드된 템플릿 구조가 올바르지 않습니다."
    rm -rf "$TEMP_CLONE"
    exit 1
  fi
  CLEANUP_TEMP=true
fi

# ═══════════════════════════════════════════════════════════════════
# UPDATE MODE
# ═══════════════════════════════════════════════════════════════════

if [[ "$UPDATE" == true ]]; then
  if [[ ! -d ".claude" ]]; then
    err "harness가 설치되어 있지 않습니다. --update 대신 init을 먼저 실행하세요."
    [[ "$CLEANUP_TEMP" == true ]] && [[ -d "/tmp/cc-harness-$$" ]] && rm -rf "/tmp/cc-harness-$$"
    exit 1
  fi

  echo ""
  echo -e "${CYAN}━━━ cc-harness · Update Mode ━━━${NC}"
  echo ""

  UPDATED=0
  SKIPPED=0
  CONFLICTED=0

  # ─── Helper: update a file with diff check ───
  # Usage: update_file <template_src> <dest> <category>
  #   category: "overwrite" — always replace (harness infra)
  #             "preserve"  — never touch (user data)
  #             "merge"     — show diff, ask user
  update_file() {
    local src="$1" dest="$2" category="$3"

    if [[ ! -f "$dest" ]]; then
      cp "$src" "$dest"
      log "✓ [new] $dest"
      UPDATED=$((UPDATED + 1))
      return
    fi

    if diff -q "$src" "$dest" &>/dev/null; then
      SKIPPED=$((SKIPPED + 1))
      return
    fi

    case "$category" in
      overwrite)
        cp "$src" "$dest"
        log "✓ [updated] $dest"
        UPDATED=$((UPDATED + 1))
        ;;
      preserve)
        SKIPPED=$((SKIPPED + 1))
        ;;
      merge)
        echo ""
        echo -e "${YELLOW}─── 변경 감지: $dest ───${NC}"
        diff --color=auto -u "$dest" "$src" 2>/dev/null | head -40 || true
        echo ""
        read -rp "  업데이트 적용? [y/N/d(diff 전체)]: " answer
        case "${answer,,}" in
          y|yes)
            cp "$src" "$dest"
            log "✓ [updated] $dest"
            UPDATED=$((UPDATED + 1))
            ;;
          d|diff)
            diff --color=auto -u "$dest" "$src" 2>/dev/null || true
            read -rp "  업데이트 적용? [y/N]: " answer2
            if [[ "${answer2,,}" == "y" ]]; then
              cp "$src" "$dest"
              log "✓ [updated] $dest"
              UPDATED=$((UPDATED + 1))
            else
              warn "[skipped] $dest"
              CONFLICTED=$((CONFLICTED + 1))
            fi
            ;;
          *)
            warn "[skipped] $dest"
            CONFLICTED=$((CONFLICTED + 1))
            ;;
        esac
        ;;
    esac
  }

  # ─── Detect preset from saved info or installed rules ───
  if [[ -z "$PRESET" ]] && [[ -f .claude/preset.txt ]]; then
    PRESET=$(cat .claude/preset.txt)
    log "저장된 프리셋 사용: $PRESET"
  fi
  if [[ -z "$PRESET" ]]; then
    HAS_GO=false; HAS_REACT=false; HAS_RN=false; HAS_FLUTTER=false
    HAS_IOS=false; HAS_ANDROID=false
    HAS_SPRING=false; HAS_K8S=false; HAS_PROTO=false; HAS_UNITY=false
    [[ -f .claude/rules/go-backend.md ]]       && HAS_GO=true
    [[ -f .claude/rules/react-frontend.md ]]   && HAS_REACT=true
    [[ -f .claude/rules/react-native.md ]]     && HAS_RN=true
    [[ -f .claude/rules/flutter-dart.md ]]     && HAS_FLUTTER=true
    [[ -f .claude/rules/ios-swift.md ]]        && HAS_IOS=true
    [[ -f .claude/rules/android-kotlin.md ]]   && HAS_ANDROID=true
    [[ -f .claude/rules/spring-boot.md ]]      && HAS_SPRING=true
    [[ -f .claude/rules/k8s-infra.md ]]        && HAS_K8S=true
    [[ -f .claude/rules/proto-api.md ]]        && HAS_PROTO=true
    [[ -f .claude/rules/unity3d.md ]]          && HAS_UNITY=true
    log "기존 설치에서 프리셋 자동 감지 (fallback)"
  else
    # Use preset flags as in init mode
    HAS_GO=false; HAS_REACT=false; HAS_RN=false; HAS_FLUTTER=false
    HAS_IOS=false; HAS_ANDROID=false
    HAS_SPRING=false; HAS_K8S=false; HAS_PROTO=false; HAS_UNITY=false
    case "$PRESET" in
      go-minimal) HAS_GO=true ;;
      go-k8s) HAS_GO=true; HAS_K8S=true ;;
      fullstack) HAS_GO=true; HAS_REACT=true; HAS_IOS=true; HAS_ANDROID=true; HAS_K8S=true; HAS_PROTO=true ;;
      mobile) HAS_RN=true; HAS_FLUTTER=true ;;
      unity) HAS_UNITY=true ;;
      *) err "Unknown preset: $PRESET"; exit 1 ;;
    esac
  fi

  # ─── 1. Agents: always overwrite (harness infra, no user data) ───
  info "Agents 업데이트..."
  for f in "$PLUGIN_DIR"/agents/*.md; do
    update_file "$f" ".claude/agents/$(basename "$f")" "overwrite"
  done

  # ─── 2. Hooks: always overwrite ───
  info "Hooks 업데이트..."
  for f in "$PLUGIN_DIR"/hooks/*.sh; do
    update_file "$f" ".claude/hooks/$(basename "$f")" "overwrite"
  done
  chmod +x .claude/hooks/*.sh 2>/dev/null || true

  # ─── 3. Rules: overwrite existing, add new conditional ones ───
  info "Rules 업데이트..."
  update_file "$PLUGIN_DIR/rules/general.md" ".claude/rules/general.md" "overwrite"

  declare -A RULE_FLAGS=(
    [go-backend.md]=HAS_GO
    [react-frontend.md]=HAS_REACT
    [react-native.md]=HAS_RN
    [flutter-dart.md]=HAS_FLUTTER
    [ios-swift.md]=HAS_IOS
    [android-kotlin.md]=HAS_ANDROID
    [spring-boot.md]=HAS_SPRING
    [k8s-infra.md]=HAS_K8S
    [proto-api.md]=HAS_PROTO
    [unity3d.md]=HAS_UNITY
  )
  for rule in "${!RULE_FLAGS[@]}"; do
    flag_var="${RULE_FLAGS[$rule]}"
    if [[ "${!flag_var}" == true ]]; then
      update_file "$PLUGIN_DIR/rules/$rule" ".claude/rules/$rule" "overwrite"
    fi
  done

  # ─── 4. Settings: interactive merge (user may have custom hooks) ───
  info "Settings 업데이트..."
  update_file "$PLUGIN_DIR/settings.json" ".claude/settings.json" "merge"

  # ─── Unity MCP (update mode) ───
  if [[ "$HAS_UNITY" == true ]] && command -v jq &>/dev/null && [[ -f .claude/settings.json ]]; then
    if ! jq -e '.mcpServers.unity' .claude/settings.json &>/dev/null; then
      jq '.mcpServers = (.mcpServers // {}) + {
        "unity": {
          "command": "npx",
          "args": ["-y", "mcp-unity"],
          "env": { "UNITY_PORT": "8090" }
        }
      }' .claude/settings.json > .claude/settings.json.tmp && \
        jq '.' .claude/settings.json.tmp > /dev/null 2>&1 && \
        mv .claude/settings.json.tmp .claude/settings.json || \
        { rm -f .claude/settings.json.tmp; warn "Unity MCP JSON 병합 실패"; }
      log "✓ Unity MCP 설정 추가"
    fi
  fi

  # ─── 5. CLAUDE.md: interactive merge (user may have customized) ───
  info "CLAUDE.md 업데이트..."
  CLAUDE_MD_TMP=$(mktemp)
  cp "$TEMPLATE_DIR"/CLAUDE.md.tmpl "$CLAUDE_MD_TMP"

  strip_conditional_file() {
    local flag="$1" tag="$2" file="$3"
    if [[ "${!flag}" != true ]]; then
      sedi "/<!-- IF:${tag} -->/,/<!-- ENDIF:${tag} -->/d" "$file"
    else
      sedi "/<!-- IF:${tag} -->/d" "$file"
      sedi "/<!-- ENDIF:${tag} -->/d" "$file"
    fi
  }

  strip_conditional_file HAS_GO      GO      "$CLAUDE_MD_TMP"
  strip_conditional_file HAS_REACT   REACT   "$CLAUDE_MD_TMP"
  strip_conditional_file HAS_RN      RN      "$CLAUDE_MD_TMP"
  strip_conditional_file HAS_FLUTTER FLUTTER "$CLAUDE_MD_TMP"
  strip_conditional_file HAS_IOS     IOS     "$CLAUDE_MD_TMP"
  strip_conditional_file HAS_ANDROID ANDROID "$CLAUDE_MD_TMP"
  strip_conditional_file HAS_PROTO   PROTO   "$CLAUDE_MD_TMP"
  strip_conditional_file HAS_UNITY   UNITY   "$CLAUDE_MD_TMP"
  SAFE_NAME=$(printf '%s' "$PROJECT_NAME" | sed 's/[&/\]/\\&/g')
  sedi "s/{{PROJECT_NAME}}/${SAFE_NAME}/g" "$CLAUDE_MD_TMP"

  update_file "$CLAUDE_MD_TMP" "CLAUDE.md" "merge"
  rm -f "$CLAUDE_MD_TMP"

  # ─── 6. Phase gate: schema merge (add new criteria, preserve values) ───
  info "Phase gate 스키마 업데이트..."
  if ! command -v jq &>/dev/null; then
    warn "jq가 설치되어 있지 않습니다. phase-gate 병합 및 일부 기능이 제한됩니다."
    warn "설치: brew install jq (macOS) / apt install jq (Linux)"
  fi
  if command -v jq &>/dev/null && [[ -f progress/phase-gate.json ]]; then
    # Deep merge: template provides new keys/structure, existing values are preserved
    MERGED=$(jq -s '
      def deep_merge(a; b):
        a as $a | b as $b |
        if ($a | type) == "object" and ($b | type) == "object" then
          ($a | keys) as $ak | ($b | keys) as $bk |
          ([$ak[], $bk[]] | unique) | reduce .[] as $k (
            {};
            if ($a | has($k)) and ($b | has($k)) then
              if ($a[$k] | type) == "object" and ($b[$k] | type) == "object" then
                . + { ($k): deep_merge($a[$k]; $b[$k]) }
              else
                . + { ($k): $a[$k] }
              end
            elif ($a | has($k)) then
              . + { ($k): $a[$k] }
            else
              . + { ($k): $b[$k] }
            end
          )
        else
          $a
        end;
      deep_merge(.[0]; .[1])
    ' progress/phase-gate.json "$TEMPLATE_DIR/progress/phase-gate.json" 2>/dev/null) || true

    if [[ -n "$MERGED" ]]; then
      # Check if anything actually changed
      if ! echo "$MERGED" | diff -q - progress/phase-gate.json &>/dev/null 2>&1; then
        echo "$MERGED" | jq '.' > progress/phase-gate.json.tmp
        mv progress/phase-gate.json.tmp progress/phase-gate.json
        log "✓ [merged] progress/phase-gate.json (새 criteria 추가, 기존 값 보존)"
        UPDATED=$((UPDATED + 1))
      else
        SKIPPED=$((SKIPPED + 1))
      fi
    else
      warn "phase-gate.json 병합 실패 — 수동 확인 필요"
      CONFLICTED=$((CONFLICTED + 1))
    fi
  else
    warn "jq 없음 또는 phase-gate.json 없음 — phase gate 스키마 업데이트 생략"
    SKIPPED=$((SKIPPED + 1))
  fi

  # ─── 7. Skills: always overwrite (harness infra) ───
  info "Skills 업데이트..."
  for skill_dir in "$PLUGIN_DIR"/skills/*/; do
    [[ -d "$skill_dir" ]] || continue
    skill_name=$(basename "$skill_dir")
    mkdir -p ".claude/skills/$skill_name"
    update_file "$skill_dir/SKILL.md" ".claude/skills/$skill_name/SKILL.md" "overwrite"
  done

  # ─── 8. Evals calibration: add if missing, don't touch if exists ───
  mkdir -p evals/calibration
  if [[ ! -f evals/calibration/false-positives.json ]]; then
    cp "$TEMPLATE_DIR"/evals/calibration/false-positives.json evals/calibration/
    log "✓ [new] evals/calibration/false-positives.json"
    UPDATED=$((UPDATED + 1))
  fi

  # ─── 9. Harness Guide: always overwrite (harness documentation) ───
  info "Harness Guide 업데이트..."
  update_file "$TEMPLATE_DIR/docs/HARNESS-GUIDE.md" "docs/HARNESS-GUIDE.md" "overwrite"

  # ─── 10. New directories: ensure they exist ───
  mkdir -p progress/agent-comms progress/contracts docs/DECISIONS evals/calibration

  # ─── 10. .gitignore additions ───
  GITIGNORE_ADDITIONS=(
    "CLAUDE.local.md"
    ".claude/settings.local.json"
    "trace/"
    "progress/session-handoff-draft.json"
    "evals/screenshots/"
  )
  for entry in "${GITIGNORE_ADDITIONS[@]}"; do
    if ! grep -qxF "$entry" .gitignore 2>/dev/null; then
      echo "$entry" >> .gitignore
    fi
  done

  # ─── Cleanup ───
  if [[ "$CLEANUP_TEMP" == true ]]; then
    rm -rf "/tmp/cc-harness-$$"
  fi

  # ─── Summary ───
  echo ""
  echo -e "${GREEN}━━━ cc-harness · Update 완료 ━━━${NC}"
  echo ""
  echo -e "  ${GREEN}Updated:${NC}    $UPDATED 파일"
  echo -e "  ${BLUE}Unchanged:${NC}  $SKIPPED 파일"
  if [[ $CONFLICTED -gt 0 ]]; then
    echo -e "  ${YELLOW}Skipped:${NC}    $CONFLICTED 파일 (사용자 선택)"
  fi
  echo ""
  echo -e "  ${CYAN}보존됨 (변경 없음):${NC}"
  echo "    progress/feature_list.json, claude-progress.txt"
  echo "    progress/agent-comms/*, progress/contracts/*"
  echo "    docs/SPEC.md, docs/ARCHITECTURE.md"
  echo "    evals/acceptance-criteria.json"
  echo ""
  echo -e "  ${YELLOW}Tip:${NC} git diff로 변경 사항 확인 후 커밋하세요."
  echo ""
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════
# INIT MODE (fresh install)
# ═══════════════════════════════════════════════════════════════════

# ─── Guard: existing harness ───
if [[ -d ".claude" ]] && [[ "$FORCE" != true ]]; then
  warn ".claude/ 디렉토리가 이미 존재합니다."
  warn "--force 옵션으로 덮어쓸 수 있습니다 (기존 파일은 .bak으로 백업)."
  warn "--update 옵션으로 기존 harness를 업데이트할 수 있습니다."
  exit 1
fi

# ─── Interactive preset selection ───
if [[ -z "$PRESET" ]]; then
  echo ""
  echo -e "${CYAN}━━━ cc-harness · Claude Code SDLC Bootstrapper ━━━${NC}"
  echo ""
  echo "  프로젝트: $PROJECT_NAME"
  echo "  경로: $PROJECT_ROOT"
  echo ""
  echo "  프리셋을 선택하세요:"
  echo ""
  echo "    1) go-minimal   — Go 단일 서비스 (가장 가벼움)"
  echo "    2) go-k8s       — Go + Kubernetes + ArgoCD"
  echo "    3) fullstack    — Go + React + iOS + Android + K8s"
  echo "    4) mobile       — React Native + Flutter (모바일 전용)"
  echo "    5) unity        — Unity3D + C# (MCP 자동 설정)"
  echo "    6) custom       — 대화형으로 구성"
  echo ""
  read -rp "  선택 [1-6]: " choice
  case $choice in
    1) PRESET="go-minimal" ;;
    2) PRESET="go-k8s" ;;
    3) PRESET="fullstack" ;;
    4) PRESET="mobile" ;;
    5) PRESET="unity" ;;
    6) PRESET="custom" ;;
    *) err "잘못된 선택"; exit 1 ;;
  esac
fi

# ─── Feature flags by preset ───
HAS_GO=false
HAS_REACT=false
HAS_RN=false
HAS_FLUTTER=false
HAS_IOS=false
HAS_ANDROID=false
HAS_SPRING=false
HAS_K8S=false
HAS_PROTO=false
HAS_UNITY=false

case "$PRESET" in
  go-minimal)
    HAS_GO=true
    ;;
  go-k8s)
    HAS_GO=true
    HAS_K8S=true
    ;;
  fullstack)
    HAS_GO=true
    HAS_REACT=true
    HAS_IOS=true
    HAS_ANDROID=true
    HAS_K8S=true
    HAS_PROTO=true
    ;;
  mobile)
    HAS_RN=true
    HAS_FLUTTER=true
    ;;
  unity)
    HAS_UNITY=true
    ;;
  custom)
    read -rp "  Go backend? [Y/n]: " r; [[ "${r,,}" != "n" ]] && HAS_GO=true
    read -rp "  React frontend (web)? [y/N]: " r; [[ "${r,,}" == "y" ]] && HAS_REACT=true
    read -rp "  React Native? [y/N]: " r; [[ "${r,,}" == "y" ]] && HAS_RN=true
    read -rp "  Flutter? [y/N]: " r; [[ "${r,,}" == "y" ]] && HAS_FLUTTER=true
    read -rp "  iOS (Swift)? [y/N]: " r; [[ "${r,,}" == "y" ]] && HAS_IOS=true
    read -rp "  Android (Kotlin)? [y/N]: " r; [[ "${r,,}" == "y" ]] && HAS_ANDROID=true
    read -rp "  Spring Boot (legacy)? [y/N]: " r; [[ "${r,,}" == "y" ]] && HAS_SPRING=true
    read -rp "  Kubernetes? [y/N]: " r; [[ "${r,,}" == "y" ]] && HAS_K8S=true
    read -rp "  Protocol Buffers? [y/N]: " r; [[ "${r,,}" == "y" ]] && HAS_PROTO=true
    read -rp "  Unity3D? [y/N]: " r; [[ "${r,,}" == "y" ]] && HAS_UNITY=true
    ;;
  *)
    err "Unknown preset: $PRESET"
    exit 1
    ;;
esac

log "프리셋: $PRESET"
log "생성을 시작합니다..."

# ─── Backup existing ───
if [[ -d ".claude" ]]; then
  BACKUP=".claude.bak.$(date +%Y%m%d%H%M%S)"
  warn "기존 .claude/ → $BACKUP 으로 백업"
  mv .claude "$BACKUP"
fi

# ═══════════════════════════════════════════════════════════════════
# CREATE DIRECTORY STRUCTURE
# ═══════════════════════════════════════════════════════════════════

mkdir -p .claude/{agents,hooks,rules,skills}
mkdir -p progress/agent-comms progress/contracts docs/DECISIONS evals/calibration

# ═══════════════════════════════════════════════════════════════════
# COPY TEMPLATES
# ═══════════════════════════════════════════════════════════════════

# ─── Agents ───
cp "$PLUGIN_DIR"/agents/*.md .claude/agents/
log "✓ .claude/agents/ (8 agents)"

# ─── Hooks ───
cp "$PLUGIN_DIR"/hooks/*.sh .claude/hooks/
chmod +x .claude/hooks/*.sh
log "✓ .claude/hooks/ (5 hooks)"

# ─── Settings ───
cp "$PLUGIN_DIR"/settings.json .claude/settings.json
log "✓ .claude/settings.json"

# ─── Unity MCP ───
if [[ "$HAS_UNITY" == true ]]; then
  if command -v jq &>/dev/null; then
    jq '.mcpServers = {
      "unity": {
        "command": "npx",
        "args": ["-y", "mcp-unity"],
        "env": { "UNITY_PORT": "8090" }
      }
    }' .claude/settings.json > .claude/settings.json.tmp && \
      jq '.' .claude/settings.json.tmp > /dev/null 2>&1 && \
      mv .claude/settings.json.tmp .claude/settings.json || \
      { rm -f .claude/settings.json.tmp; warn "Unity MCP JSON 병합 실패"; }
    log "✓ Unity MCP 설정 주입 (mcp-unity, 포트 8090)"
    info "Unity Editor에서 'Tools > MCP Server'로 서버를 시작한 뒤 Claude를 실행하세요."
  else
    warn "jq가 없어 Unity MCP를 자동 설정할 수 없습니다."
    warn "수동으로 .claude/settings.json에 다음을 추가하세요:"
    warn '  "mcpServers": { "unity": { "command": "npx", "args": ["-y", "mcp-unity"], "env": { "UNITY_PORT": "8090" } } }'
  fi
fi

# ─── Skills ───
for skill_dir in "$PLUGIN_DIR"/skills/*/; do
  [[ -d "$skill_dir" ]] || continue
  skill_name=$(basename "$skill_dir")
  mkdir -p ".claude/skills/$skill_name"
  cp "$skill_dir/SKILL.md" ".claude/skills/$skill_name/SKILL.md"
done
log "✓ .claude/skills/ (4 skills)"

# ─── Rules (always-included) ───
cp "$PLUGIN_DIR"/rules/general.md .claude/rules/
log "✓ .claude/rules/general.md"

# ─── Rules (conditional) ───
declare -A RULE_FLAGS=(
  [go-backend.md]=HAS_GO
  [react-frontend.md]=HAS_REACT
  [react-native.md]=HAS_RN
  [flutter-dart.md]=HAS_FLUTTER
  [ios-swift.md]=HAS_IOS
  [android-kotlin.md]=HAS_ANDROID
  [spring-boot.md]=HAS_SPRING
  [k8s-infra.md]=HAS_K8S
  [proto-api.md]=HAS_PROTO
  [unity3d.md]=HAS_UNITY
)
for rule in "${!RULE_FLAGS[@]}"; do
  flag_var="${RULE_FLAGS[$rule]}"
  if [[ "${!flag_var}" == true ]]; then
    cp "$PLUGIN_DIR/rules/$rule" .claude/rules/
    log "✓ .claude/rules/$rule"
  fi
done

# ─── Progress ───
cp "$TEMPLATE_DIR"/progress/phase-gate.json progress/
cp "$TEMPLATE_DIR"/progress/feature_list.json progress/
cp "$TEMPLATE_DIR"/progress/claude-progress.txt progress/
log "✓ progress/"

# ─── Evals ───
cp "$TEMPLATE_DIR"/evals/acceptance-criteria.json evals/
cp "$TEMPLATE_DIR"/evals/calibration/false-positives.json evals/calibration/
log "✓ evals/"

# ─── Docs (only if not already existing, except guide which is always updated) ───
[[ ! -f docs/SPEC.md ]] && cp "$TEMPLATE_DIR"/docs/SPEC.md docs/
[[ ! -f docs/ARCHITECTURE.md ]] && cp "$TEMPLATE_DIR"/docs/ARCHITECTURE.md docs/
cp "$TEMPLATE_DIR"/docs/HARNESS-GUIDE.md docs/HARNESS-GUIDE.md
log "✓ docs/ (HARNESS-GUIDE.md 포함)"

# ═══════════════════════════════════════════════════════════════════
# CLAUDE.md — process template with conditionals
# ═══════════════════════════════════════════════════════════════════

cp "$TEMPLATE_DIR"/CLAUDE.md.tmpl CLAUDE.md

# Strip disabled conditional blocks, keep enabled ones (remove markers only)
strip_conditional() {
  local flag="$1" tag="$2" file="$3"
  if [[ "${!flag}" != true ]]; then
    sedi "/<!-- IF:${tag} -->/,/<!-- ENDIF:${tag} -->/d" "$file"
  else
    sedi "/<!-- IF:${tag} -->/d" "$file"
    sedi "/<!-- ENDIF:${tag} -->/d" "$file"
  fi
}

strip_conditional HAS_GO      GO      CLAUDE.md
strip_conditional HAS_REACT   REACT   CLAUDE.md
strip_conditional HAS_RN      RN      CLAUDE.md
strip_conditional HAS_FLUTTER FLUTTER CLAUDE.md
strip_conditional HAS_IOS     IOS     CLAUDE.md
strip_conditional HAS_ANDROID ANDROID CLAUDE.md
strip_conditional HAS_PROTO   PROTO   CLAUDE.md
strip_conditional HAS_UNITY   UNITY   CLAUDE.md

log "✓ CLAUDE.md"

# ─── Save preset info for future --update ───
echo "$PRESET" > .claude/preset.txt
log "✓ .claude/preset.txt (preset=$PRESET)"

# ═══════════════════════════════════════════════════════════════════
# VARIABLE SUBSTITUTION — {{PROJECT_NAME}}
# ═══════════════════════════════════════════════════════════════════

# Escape sed special chars in PROJECT_NAME to prevent injection
SAFE_PROJECT_NAME=$(printf '%s' "$PROJECT_NAME" | sed 's/[&/\]/\\&/g')
sedi "s/{{PROJECT_NAME}}/${SAFE_PROJECT_NAME}/g" \
  CLAUDE.md \
  progress/feature_list.json \
  evals/acceptance-criteria.json \
  docs/SPEC.md \
  docs/ARCHITECTURE.md

log "✓ 변수 치환 (PROJECT_NAME=$PROJECT_NAME)"

# ═══════════════════════════════════════════════════════════════════
# MAKEFILE (if not exists)
# ═══════════════════════════════════════════════════════════════════

if [[ ! -f Makefile ]]; then
  cp "$TEMPLATE_DIR"/Makefile.base Makefile
  [[ "$HAS_REACT" == true ]]   && cat "$TEMPLATE_DIR"/Makefile.react   >> Makefile
  [[ "$HAS_RN" == true ]]      && cat "$TEMPLATE_DIR"/Makefile.rn      >> Makefile
  [[ "$HAS_FLUTTER" == true ]] && cat "$TEMPLATE_DIR"/Makefile.flutter >> Makefile
  [[ "$HAS_IOS" == true ]]     && cat "$TEMPLATE_DIR"/Makefile.ios     >> Makefile
  [[ "$HAS_ANDROID" == true ]] && cat "$TEMPLATE_DIR"/Makefile.android >> Makefile
  [[ "$HAS_PROTO" == true ]]   && cat "$TEMPLATE_DIR"/Makefile.proto   >> Makefile
  [[ "$HAS_K8S" == true ]]     && cat "$TEMPLATE_DIR"/Makefile.k8s     >> Makefile
  cat "$TEMPLATE_DIR"/Makefile.tail >> Makefile
  log "✓ Makefile"
fi

# ═══════════════════════════════════════════════════════════════════
# .gitignore additions
# ═══════════════════════════════════════════════════════════════════

GITIGNORE_ADDITIONS=(
  "CLAUDE.local.md"
  ".claude/settings.local.json"
  "trace/"
  "progress/session-handoff-draft.json"
  "evals/screenshots/"
)

for entry in "${GITIGNORE_ADDITIONS[@]}"; do
  if ! grep -qxF "$entry" .gitignore 2>/dev/null; then
    echo "$entry" >> .gitignore
  fi
done
log "✓ .gitignore updated"

# ═══════════════════════════════════════════════════════════════════
# CLEANUP
# ═══════════════════════════════════════════════════════════════════

if [[ "$CLEANUP_TEMP" == true ]] && [[ -d "/tmp/cc-harness-$$" ]]; then
  rm -rf "/tmp/cc-harness-$$"
fi

# ═══════════════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════════════

echo ""
echo -e "${GREEN}━━━ cc-harness · 생성 완료! ━━━${NC}"
echo ""
echo "  생성된 구조:"
echo ""

# Show tree if available, otherwise manual listing
if command -v tree &>/dev/null; then
  tree -a --dirsfirst -I '.git|node_modules|vendor' \
    .claude/ progress/ docs/ evals/ 2>/dev/null || true
else
  echo "  .claude/"
  echo "    ├── settings.json     (hooks 설정)"
  echo "    ├── agents/           (8 agents — evaluator + QA)"
  echo "    ├── hooks/            (5 hook scripts)"
  echo "    ├── rules/            (path-scoped rules)"
  echo "    └── skills/           (4 skills: change-request, sync-docs, progress, implement)"
  echo "  progress/"
  echo "    ├── phase-gate.json   (iteration 추적 포함)"
  echo "    ├── feature_list.json"
  echo "    ├── claude-progress.txt"
  echo "    ├── agent-comms/      (에이전트 간 통신)"
  echo "    └── contracts/        (sprint contracts)"
  echo "  evals/"
  echo "    ├── acceptance-criteria.json"
  echo "    └── calibration/      (evaluator 보정 데이터)"
  echo "  docs/"
  echo "    ├── SPEC.md"
  echo "    ├── ARCHITECTURE.md"
  echo "    └── HARNESS-GUIDE.md  (실전 가이드)"
fi

echo ""
echo -e "${CYAN}━━━ 다음 단계 ━━━${NC}"
echo ""
echo "  1. git add & commit:"
echo "     git add .claude/ CLAUDE.md progress/ docs/ evals/ Makefile"
echo "     git commit -m 'chore: initialize SDLC harness'"
echo ""
echo "  2. Claude Code 시작:"
echo "     claude"
echo ""
echo "  3. Phase 1 (기획) 시작:"
echo '     "SPEC.md를 작성해줘. AskUserQuestion으로 상세 인터뷰부터 시작해.'
echo '      완료 후 feature_list.json과 acceptance-criteria.json 생성해."'
echo ""
echo "  4. 구현 후 평가:"
echo '     "evaluator agent로 구현 결과를 검증해줘."'
echo ""
echo -e "  ${YELLOW}Tip:${NC} CLAUDE.md는 /init 결과보다 수동 정제가 낫습니다."
echo -e "  ${YELLOW}Tip:${NC} 실패 패턴 발견 시 → rules/ 또는 hooks/에 가드레일 추가"
echo -e "  ${YELLOW}Tip:${NC} evaluator가 너무 관대/엄격하면 evals/calibration/에 오판 기록 추가"
echo ""
