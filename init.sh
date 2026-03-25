#!/usr/bin/env bash
#
# cc-harness — Claude Code Full-SDLC Harness Bootstrapper
#
# One-command harness setup for Claude Code projects.
# Copies templates/ into target project with preset-based filtering.
#
# Install & Run:
#   bash <(curl -sL https://raw.githubusercontent.com/hanbyeol/cc-harness/main/init.sh)
#
# Or clone & run:
#   git clone https://github.com/hanbyeol/cc-harness.git /tmp/cc-harness
#   bash /tmp/cc-harness/init.sh --preset go-k8s
#
# Presets:
#   go-minimal  — Go single service (lightest)
#   go-k8s      — Go + Kubernetes + ArgoCD
#   fullstack   — Go + React + iOS + Android + K8s + Proto
#   custom      — Interactive selection
#
# https://github.com/hanbyeol/cc-harness
#
set -euo pipefail

# ─── Colors ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

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

while [[ $# -gt 0 ]]; do
  case $1 in
    --preset)  PRESET="$2"; shift 2 ;;
    --name)    PROJECT_NAME="$2"; shift 2 ;;
    --force)   FORCE=true; shift ;;
    -h|--help)
      echo "cc-harness — Claude Code Full-SDLC Harness Bootstrapper"
      echo ""
      echo "Usage: init.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --preset <name>   Preset: go-minimal | go-k8s | fullstack | custom"
      echo "  --name <name>     Project name (default: directory name)"
      echo "  --force           Overwrite existing .claude/ (backs up to .claude.bak.*)"
      echo "  -h, --help        Show this help"
      echo ""
      echo "Examples:"
      echo "  bash init.sh                              # interactive"
      echo "  bash init.sh --preset go-k8s              # Go + Kubernetes"
      echo "  bash init.sh --preset fullstack --force    # full stack, overwrite"
      exit 0 ;;
    *) err "Unknown arg: $1"; exit 1 ;;
  esac
done

# ─── Detect project root ───
if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  err "git 리포지토리가 아닙니다. 프로젝트 루트에서 실행하세요."
  exit 1
fi

PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT"

if [[ -z "$PROJECT_NAME" ]]; then
  PROJECT_NAME=$(basename "$PROJECT_ROOT")
fi

# ─── Guard: existing harness ───
if [[ -d ".claude" ]] && [[ "$FORCE" != true ]]; then
  warn ".claude/ 디렉토리가 이미 존재합니다."
  warn "--force 옵션으로 덮어쓸 수 있습니다 (기존 파일은 .bak으로 백업)."
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
  echo "    4) custom       — 대화형으로 구성"
  echo ""
  read -rp "  선택 [1-4]: " choice
  case $choice in
    1) PRESET="go-minimal" ;;
    2) PRESET="go-k8s" ;;
    3) PRESET="fullstack" ;;
    4) PRESET="custom" ;;
    *) err "잘못된 선택"; exit 1 ;;
  esac
fi

# ─── Feature flags by preset ───
HAS_GO=false
HAS_REACT=false
HAS_IOS=false
HAS_ANDROID=false
HAS_SPRING=false
HAS_K8S=false
HAS_PROTO=false

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
  custom)
    read -rp "  Go backend? [Y/n]: " r; [[ "${r,,}" != "n" ]] && HAS_GO=true
    read -rp "  React frontend? [y/N]: " r; [[ "${r,,}" == "y" ]] && HAS_REACT=true
    read -rp "  iOS (Swift)? [y/N]: " r; [[ "${r,,}" == "y" ]] && HAS_IOS=true
    read -rp "  Android (Kotlin)? [y/N]: " r; [[ "${r,,}" == "y" ]] && HAS_ANDROID=true
    read -rp "  Spring Boot (legacy)? [y/N]: " r; [[ "${r,,}" == "y" ]] && HAS_SPRING=true
    read -rp "  Kubernetes? [y/N]: " r; [[ "${r,,}" == "y" ]] && HAS_K8S=true
    read -rp "  Protocol Buffers? [y/N]: " r; [[ "${r,,}" == "y" ]] && HAS_PROTO=true
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
# RESOLVE TEMPLATE SOURCE
# ═══════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/templates"
CLEANUP_TEMP=false

if [[ ! -d "$TEMPLATE_DIR" ]]; then
  TEMPLATE_DIR="/tmp/cc-harness-$$"
  log "템플릿 다운로드 중..."
  git clone --depth 1 https://github.com/hanbyeol/cc-harness.git "$TEMPLATE_DIR" 2>/dev/null
  TEMPLATE_DIR="$TEMPLATE_DIR/templates"
  CLEANUP_TEMP=true
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
cp "$TEMPLATE_DIR"/claude/agents/*.md .claude/agents/
log "✓ .claude/agents/ (8 agents)"

# ─── Hooks ───
cp "$TEMPLATE_DIR"/claude/hooks/*.sh .claude/hooks/
chmod +x .claude/hooks/*.sh
log "✓ .claude/hooks/ (5 hooks)"

# ─── Settings ───
cp "$TEMPLATE_DIR"/claude/settings.json .claude/settings.json
log "✓ .claude/settings.json"

# ─── Rules (always-included) ───
cp "$TEMPLATE_DIR"/claude/rules/general.md .claude/rules/
log "✓ .claude/rules/general.md"

# ─── Rules (conditional) ───
declare -A RULE_FLAGS=(
  [go-backend.md]=HAS_GO
  [react-frontend.md]=HAS_REACT
  [ios-swift.md]=HAS_IOS
  [android-kotlin.md]=HAS_ANDROID
  [spring-boot.md]=HAS_SPRING
  [k8s-infra.md]=HAS_K8S
  [proto-api.md]=HAS_PROTO
)
for rule in "${!RULE_FLAGS[@]}"; do
  flag_var="${RULE_FLAGS[$rule]}"
  if [[ "${!flag_var}" == true ]]; then
    cp "$TEMPLATE_DIR/claude/rules/$rule" .claude/rules/
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

# ─── Docs (only if not already existing) ───
[[ ! -f docs/SPEC.md ]] && cp "$TEMPLATE_DIR"/docs/SPEC.md docs/
[[ ! -f docs/ARCHITECTURE.md ]] && cp "$TEMPLATE_DIR"/docs/ARCHITECTURE.md docs/
log "✓ docs/"

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
strip_conditional HAS_IOS     IOS     CLAUDE.md
strip_conditional HAS_ANDROID ANDROID CLAUDE.md
strip_conditional HAS_PROTO   PROTO   CLAUDE.md

log "✓ CLAUDE.md"

# ═══════════════════════════════════════════════════════════════════
# VARIABLE SUBSTITUTION — {{PROJECT_NAME}}
# ═══════════════════════════════════════════════════════════════════

sedi "s/{{PROJECT_NAME}}/$PROJECT_NAME/g" \
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

if [[ "$CLEANUP_TEMP" == true ]]; then
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
  echo "    └── skills/           (빈 폴더, 필요 시 추가)"
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
  echo "    └── ARCHITECTURE.md"
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
