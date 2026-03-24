#!/usr/bin/env bash
#
# cc-harness — Claude Code Full-SDLC Harness Bootstrapper
#
# One-command harness setup for Claude Code projects.
# Generates .claude/ (hooks, rules, agents, skills), CLAUDE.md,
# progress files, Makefile, and phase-gate infrastructure.
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
# CREATE DIRECTORY STRUCTURE
# ═══════════════════════════════════════════════════════════════════

mkdir -p .claude/{agents,hooks,rules,skills}
mkdir -p progress docs/DECISIONS evals

# ═══════════════════════════════════════════════════════════════════
# 1. ROOT CLAUDE.md
# ═══════════════════════════════════════════════════════════════════

BUILD_CMDS=""
[[ "$HAS_GO" == true ]] && BUILD_CMDS+="- Go: \`make test-go\` / \`make lint-go\`\n"
[[ "$HAS_REACT" == true ]] && BUILD_CMDS+="- Web: \`make test-web\` / \`make lint-web\`\n"
[[ "$HAS_IOS" == true ]] && BUILD_CMDS+="- iOS: \`make test-ios\` / \`make lint-ios\`\n"
[[ "$HAS_ANDROID" == true ]] && BUILD_CMDS+="- Android: \`make test-android\` / \`make lint-android\`\n"
[[ "$HAS_PROTO" == true ]] && BUILD_CMDS+="- Proto: \`make proto-gen\` / \`make proto-lint\`\n"

cat > CLAUDE.md << CLAUDEMD
# $PROJECT_NAME

## Priority
Correctness > Safety > Speed

## Build & Test
$(echo -e "$BUILD_CMDS")
## Workflow
- 변경 전 해당 디렉토리의 CLAUDE.md 먼저 읽을 것
- 기존 코드 패턴 먼저 확인 후 구현
- 한 번에 하나의 기능만 구현
- feature_list.json의 passes만 변경 (테스트 삭제/수정 금지)
- 매 기능 완료 시 git commit + progress 업데이트

## Phase Gate
- progress/phase-gate.json 확인 후 현재 단계에 맞는 작업
- Phase 미통과 시 다음 단계 진입 금지
CLAUDEMD

log "✓ CLAUDE.md"

# ═══════════════════════════════════════════════════════════════════
# 2. .claude/rules/ — Path-scoped rules
# ═══════════════════════════════════════════════════════════════════

# General (always loaded)
cat > .claude/rules/general.md << 'EOF'
# General Rules
- 한국어 주석 OK, 코드·커밋 메시지는 영어
- PR 제목: `[component] description`
- main 직접 커밋 금지
- 공유 패키지 변경 시 의존 패키지 전체 테스트
EOF
log "✓ .claude/rules/general.md"

if [[ "$HAS_GO" == true ]]; then
cat > .claude/rules/go-backend.md << 'GORULE'
---
paths:
  - "services/**/*.go"
  - "packages/**/*.go"
  - "cmd/**/*.go"
  - "internal/**/*.go"
---
# Go Rules
- Error wrapping: `fmt.Errorf("[context]: %w", err)`
- context.Context는 첫 번째 파라미터
- Table-driven tests with t.Run()
- 구조화 로깅: slog 사용
- internal/ 패키지 경계 준수
- cmd/에는 main.go만, 비즈니스 로직 금지
- 신규 의존성 추가 시 `go mod tidy` 실행
GORULE
log "✓ .claude/rules/go-backend.md"
fi

if [[ "$HAS_REACT" == true ]]; then
cat > .claude/rules/react-frontend.md << 'REACTRULE'
---
paths:
  - "apps/web/**/*.ts"
  - "apps/web/**/*.tsx"
---
# React/TypeScript Rules
- Strict TypeScript: no `any`, no `as` casting
- Named export, Props interface 같은 파일
- Custom hooks: use* 접두어, 별도 파일
- 테스트: Vitest + Testing Library
REACTRULE
log "✓ .claude/rules/react-frontend.md"
fi

if [[ "$HAS_IOS" == true ]]; then
cat > .claude/rules/ios-swift.md << 'IOSRULE'
---
paths:
  - "apps/ios/**/*.swift"
---
# iOS/Swift Rules
- SwiftUI 우선, UIKit은 레거시 호환 시만
- async/await 사용
- 인증 토큰: Keychain only (UserDefaults 금지)
- force unwrap 금지
- 네트워크: URLSession async/await
IOSRULE
log "✓ .claude/rules/ios-swift.md"
fi

if [[ "$HAS_ANDROID" == true ]]; then
cat > .claude/rules/android-kotlin.md << 'ANDROIDRULE'
---
paths:
  - "apps/android/**/*.kt"
  - "apps/android/**/*.kts"
---
# Android/Kotlin Rules
- Kotlin-first, Java 금지 (레거시 제외)
- Jetpack Compose 우선
- DI: Hilt
- Coroutines + Flow
- ProGuard/R8 규칙 업데이트 확인
ANDROIDRULE
log "✓ .claude/rules/android-kotlin.md"
fi

if [[ "$HAS_SPRING" == true ]]; then
cat > .claude/rules/spring-boot.md << 'SPRINGRULE'
---
paths:
  - "services/legacy/**/*.java"
---
# Spring Boot Rules (Legacy)
- Constructor injection (field injection 금지)
- @Transactional은 서비스 레이어만
- 새 기능은 Go 마이그레이션 검토 우선
SPRINGRULE
log "✓ .claude/rules/spring-boot.md"
fi

if [[ "$HAS_K8S" == true ]]; then
cat > .claude/rules/k8s-infra.md << 'K8SRULE'
---
paths:
  - "deploy/**/*.yaml"
  - "deploy/**/*.yml"
---
# Kubernetes Rules
- Kustomize overlay: base → dev/staging/prod
- Image tag: git SHA short
- SecurityContext: runAsNonRoot=true
- Resource limits 필수
- Secret: External Secrets Operator
K8SRULE
log "✓ .claude/rules/k8s-infra.md"
fi

if [[ "$HAS_PROTO" == true ]]; then
cat > .claude/rules/proto-api.md << 'PROTORULE'
---
paths:
  - "proto/**/*.proto"
---
# Protocol Buffers Rules
- proto3 syntax
- 필드 번호 재사용 금지
- breaking change → 새 버전(v2) 생성
- 변경 후 `make proto-gen` 필수
PROTORULE
log "✓ .claude/rules/proto-api.md"
fi

# ═══════════════════════════════════════════════════════════════════
# 3. HOOKS
# ═══════════════════════════════════════════════════════════════════

# ─── Session Context ───
cat > .claude/hooks/session-context.sh << 'HOOKEOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
LAST=$(git log --oneline -1 2>/dev/null || echo "none")
PHASE=$(jq -r '.current_phase // "unknown"' progress/phase-gate.json 2>/dev/null || echo "init")
PENDING=$(jq '[.features[] | select(.passes == false)] | length' progress/feature_list.json 2>/dev/null || echo "?")

cat <<CTX
=== Session Context ===
Branch: $BRANCH | Phase: $PHASE | Pending: $PENDING
Last: $LAST
→ progress/claude-progress.txt와 git log 먼저 확인
CTX
HOOKEOF
chmod +x .claude/hooks/session-context.sh
log "✓ .claude/hooks/session-context.sh"

# ─── Pre-bash Firewall ───
cat > .claude/hooks/pre-bash-firewall.sh << 'HOOKEOF'
#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")
[[ -z "$CMD" ]] && exit 0

BLOCKED=(
  "rm -rf /"
  "git push.*--force"
  "git reset --hard"
  "kubectl delete namespace"
  "DROP TABLE"
  "DROP DATABASE"
)

for p in "${BLOCKED[@]}"; do
  if echo "$CMD" | grep -qiE "$p"; then
    echo "BLOCKED: 위험 명령어 — '$p'" >&2
    exit 2
  fi
done
exit 0
HOOKEOF
chmod +x .claude/hooks/pre-bash-firewall.sh
log "✓ .claude/hooks/pre-bash-firewall.sh"

# ─── Post-edit Format (language-aware) ───
cat > .claude/hooks/post-edit-format.sh << 'HOOKEOF'
#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")
[[ -z "$FILE" ]] && exit 0
cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

case "$FILE" in
  *.go)       gofmt -w "$FILE" 2>/dev/null; goimports -w "$FILE" 2>/dev/null ;;
  *.swift)    swiftformat "$FILE" 2>/dev/null ;;
  *.kt|*.kts) ktlint --format "$FILE" 2>/dev/null ;;
  *.ts|*.tsx|*.js|*.jsx) npx prettier --write "$FILE" 2>/dev/null ;;
  *.java)     google-java-format -i "$FILE" 2>/dev/null ;;
  *.proto)    buf format -w "$FILE" 2>/dev/null ;;
  *.json)     jq '.' "$FILE" > "$FILE.tmp" 2>/dev/null && mv "$FILE.tmp" "$FILE" ;;
esac
exit 0
HOOKEOF
chmod +x .claude/hooks/post-edit-format.sh
log "✓ .claude/hooks/post-edit-format.sh"

# ─── Pre-commit Gate ───
cat > .claude/hooks/pre-commit-gate.sh << 'HOOKEOF'
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
  PKGS=$(echo "$CHANGED" | grep '\.go$' | xargs -I{} dirname {} | sort -u)
  for p in $PKGS; do
    go test "./$p/..." -count=1 -timeout=60s 2>/dev/null || ERRS+=("go test: $p")
  done
fi

# TypeScript
if echo "$CHANGED" | grep -qE '\.(ts|tsx)$'; then
  if [[ -f "apps/web/package.json" ]]; then
    (cd apps/web && npx tsc --noEmit 2>/dev/null) || ERRS+=("tsc type check")
  fi
fi

# Proto
if echo "$CHANGED" | grep -q '\.proto$'; then
  buf lint 2>/dev/null || ERRS+=("buf lint")
fi

if [ ${#ERRS[@]} -gt 0 ]; then
  printf "Quality Gate FAILED:\n" >&2
  for e in "${ERRS[@]}"; do printf "  - %s\n" "$e" >&2; done
  exit 2
fi
exit 0
HOOKEOF
chmod +x .claude/hooks/pre-commit-gate.sh
log "✓ .claude/hooks/pre-commit-gate.sh"

# ═══════════════════════════════════════════════════════════════════
# 4. .claude/settings.json
# ═══════════════════════════════════════════════════════════════════

cat > .claude/settings.json << 'SETTINGS'
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [{ "type": "command", "command": ".claude/hooks/session-context.sh" }]
      },
      {
        "matcher": "compact",
        "hooks": [{ "type": "command", "command": ".claude/hooks/session-context.sh" }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": ".claude/hooks/pre-bash-firewall.sh" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [{ "type": "command", "command": ".claude/hooks/post-edit-format.sh" }]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": ".claude/hooks/pre-commit-gate.sh", "timeout": 120 }]
      }
    ]
  }
}
SETTINGS
log "✓ .claude/settings.json"

# ═══════════════════════════════════════════════════════════════════
# 5. AGENTS
# ═══════════════════════════════════════════════════════════════════

cat > .claude/agents/spec-writer.md << 'AGENTEOF'
# Spec Writer Agent

## Role
사용자 요구사항을 체계적 스펙으로 변환

## Process
1. AskUserQuestion으로 상세 인터뷰
2. docs/SPEC.md 작성
3. progress/feature_list.json 생성 (모든 기능 passes: false)
4. evals/acceptance-criteria.json 생성

## Constraints
- 코드 작성 금지, 문서만 작성
- 모호한 요구사항은 반드시 질문
AGENTEOF

cat > .claude/agents/architect.md << 'AGENTEOF'
# Architect Agent

## Role
SPEC.md 기반으로 기술 아키텍처 설계

## Process
1. docs/SPEC.md 읽기
2. docs/ARCHITECTURE.md 작성 (Mermaid 다이어그램 포함)
3. docs/API-DESIGN.md 작성
4. docs/DECISIONS/에 ADR 작성

## Constraints
- 비즈니스 로직 구현 금지
- 스캐폴딩만 가능 (디렉토리, interface)
AGENTEOF

cat > .claude/agents/implementer.md << 'AGENTEOF'
# Implementer Agent

## Role
feature_list.json에서 기능을 선택하여 구현

## Process
1. progress/claude-progress.txt + git log 확인
2. feature_list.json에서 미완료 기능 중 최우선 선택
3. 해당 디렉토리의 CLAUDE.md 읽기
4. 기능 구현 + 테스트 작성
5. 린트 + 테스트 실행
6. passes → true, git commit, progress 업데이트

## Constraints
- 한 세션에 1-2개 기능만
- feature_list.json 테스트 삭제 금지
AGENTEOF

cat > .claude/agents/security-auditor.md << 'AGENTEOF'
# Security Auditor Agent

## Role
코드베이스 보안 취약점 탐지 및 리포트

## Process
1. 언어별 보안 스캔 (gosec, govulncheck, npm audit 등)
2. OWASP Top 10 기준 수동 리뷰
3. Secret 하드코딩 검사
4. K8s SecurityContext 검증
5. progress/security-report.json 작성

## Constraints
- 보안 이슈 발견 시 즉시 보고
AGENTEOF

cat > .claude/agents/test-writer.md << 'AGENTEOF'
# Test Writer Agent

## Role
통합/E2E 테스트 작성 및 실행

## Process
1. evals/acceptance-criteria.json 읽기
2. 통합 테스트 작성
3. 전체 테스트 실행 + 커버리지 리포트
4. progress/test-report.json 기록
AGENTEOF

cat > .claude/agents/deploy-operator.md << 'AGENTEOF'
# Deploy Operator Agent

## Role
검증 완료된 코드를 배포

## Process
1. Phase Gate 확인 (검증 완료 여부)
2. 이미지 빌드 + 태깅
3. K8s manifest 업데이트
4. staging 배포 → 스모크 테스트
5. progress/deploy-log.json 기록

## Constraints
- 검증 미통과 시 배포 거부
- staging 먼저, prod 나중에
AGENTEOF
log "✓ .claude/agents/ (6 agents)"

# ═══════════════════════════════════════════════════════════════════
# 6. PROGRESS FILES
# ═══════════════════════════════════════════════════════════════════

cat > progress/claude-progress.txt << 'PROGRESS'
# Claude Progress Log
# 각 세션 종료 시 업데이트

## Latest
- Harness 초기화 완료
PROGRESS

cat > progress/feature_list.json << 'FEATURES'
{
  "project": "",
  "features": []
}
FEATURES
# project name injection
if command -v jq &>/dev/null; then
  jq --arg name "$PROJECT_NAME" '.project = $name' progress/feature_list.json > progress/feature_list.json.tmp \
    && mv progress/feature_list.json.tmp progress/feature_list.json
else
  sed -i "s/\"project\": \"\"/\"project\": \"$PROJECT_NAME\"/" progress/feature_list.json
fi

cat > progress/phase-gate.json << 'PHASEGATE'
{
  "current_phase": "specification",
  "phases": {
    "specification": {
      "status": "pending",
      "criteria": {
        "spec_written": false,
        "feature_list_created": false,
        "acceptance_criteria_defined": false,
        "user_approved": false
      }
    },
    "architecture": {
      "status": "pending",
      "criteria": {
        "architecture_doc": false,
        "api_design": false,
        "adr_written": false
      }
    },
    "implementation": {
      "status": "pending",
      "criteria": {
        "all_features_passing": false,
        "lint_clean": false
      }
    },
    "verification": {
      "status": "pending",
      "criteria": {
        "tests_pass": false,
        "security_scan_clean": false,
        "qa_review_complete": false
      }
    },
    "deployment": {
      "status": "pending",
      "criteria": {
        "staging_deployed": false,
        "smoke_test_pass": false
      }
    },
    "observability": {
      "status": "pending",
      "criteria": {
        "metrics_instrumented": false,
        "logging_structured": false,
        "alerts_configured": false
      }
    }
  }
}
PHASEGATE
log "✓ progress/ (phase-gate, feature_list, progress)"

# ═══════════════════════════════════════════════════════════════════
# 7. EVALS
# ═══════════════════════════════════════════════════════════════════

cat > evals/acceptance-criteria.json << 'EVALS'
{
  "project": "",
  "criteria": []
}
EVALS
if command -v jq &>/dev/null; then
  jq --arg name "$PROJECT_NAME" '.project = $name' evals/acceptance-criteria.json > evals/acceptance-criteria.json.tmp \
    && mv evals/acceptance-criteria.json.tmp evals/acceptance-criteria.json
else
  sed -i "s/\"project\": \"\"/\"project\": \"$PROJECT_NAME\"/" evals/acceptance-criteria.json
fi

# ═══════════════════════════════════════════════════════════════════
# 8. DOCS STUBS
# ═══════════════════════════════════════════════════════════════════

[[ ! -f docs/SPEC.md ]] && echo "# $PROJECT_NAME — Specification\n\n> Phase 1에서 spec-writer agent가 작성" > docs/SPEC.md
[[ ! -f docs/ARCHITECTURE.md ]] && echo "# $PROJECT_NAME — Architecture\n\n> Phase 2에서 architect agent가 작성" > docs/ARCHITECTURE.md

# ═══════════════════════════════════════════════════════════════════
# 9. MAKEFILE (if not exists)
# ═══════════════════════════════════════════════════════════════════

if [[ ! -f Makefile ]]; then
cat > Makefile << 'MAKEFILE'
.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ─── Go ───
.PHONY: test-go lint-go
test-go: ## Run Go tests
	@for dir in $$(find . -name 'go.mod' -not -path '*/vendor/*' -exec dirname {} \;); do \
		echo "Testing $$dir..."; (cd "$$dir" && go test ./... -count=1 -timeout=120s) || exit 1; \
	done

lint-go: ## Lint Go code
	@for dir in $$(find . -name 'go.mod' -not -path '*/vendor/*' -exec dirname {} \;); do \
		echo "Linting $$dir..."; (cd "$$dir" && golangci-lint run) || exit 1; \
	done

security-go: ## Security scan Go
	@for dir in $$(find . -name 'go.mod' -not -path '*/vendor/*' -exec dirname {} \;); do \
		(cd "$$dir" && gosec ./... && govulncheck ./...) || exit 1; \
	done

MAKEFILE

# Conditional targets
if [[ "$HAS_REACT" == true ]]; then
cat >> Makefile << 'MK'

# ─── Web ───
.PHONY: test-web lint-web
test-web: ## Run web tests
	cd apps/web && pnpm test

lint-web: ## Lint web code
	cd apps/web && pnpm lint
MK
fi

if [[ "$HAS_IOS" == true ]]; then
cat >> Makefile << 'MK'

# ─── iOS ───
.PHONY: test-ios lint-ios
test-ios: ## Run iOS tests
	cd apps/ios && xcodebuild test -scheme MerchantApp -destination 'platform=iOS Simulator,name=iPhone 16'

lint-ios: ## Lint Swift code
	cd apps/ios && swiftlint
MK
fi

if [[ "$HAS_ANDROID" == true ]]; then
cat >> Makefile << 'MK'

# ─── Android ───
.PHONY: test-android lint-android
test-android: ## Run Android tests
	cd apps/android && ./gradlew testDebugUnitTest

lint-android: ## Lint Kotlin code
	cd apps/android && ./gradlew ktlintCheck
MK
fi

if [[ "$HAS_PROTO" == true ]]; then
cat >> Makefile << 'MK'

# ─── Proto ───
.PHONY: proto-gen proto-lint
proto-gen: ## Generate protobuf code
	buf generate proto/

proto-lint: ## Lint protobuf
	buf lint proto/
	buf breaking --against '.git#branch=main' proto/
MK
fi

if [[ "$HAS_K8S" == true ]]; then
cat >> Makefile << 'MK'

# ─── Deploy ───
IMAGE_TAG ?= $(shell git rev-parse --short HEAD)

.PHONY: deploy-staging
deploy-staging: ## Deploy to staging
	kustomize build deploy/k8s/overlays/staging | kubectl apply -f -
	kubectl rollout status deployment -l app=$(shell basename $(CURDIR)) --timeout=300s
MK
fi

# All targets
cat >> Makefile << 'MK'

# ─── All ───
.PHONY: test-all lint-all
test-all: test-go ## Run all tests
lint-all: lint-go ## Run all linters
MK

log "✓ Makefile"
fi

# ═══════════════════════════════════════════════════════════════════
# 10. .gitignore additions
# ═══════════════════════════════════════════════════════════════════

GITIGNORE_ADDITIONS=(
  "CLAUDE.local.md"
  ".claude/settings.local.json"
  "trace/"
)

for entry in "${GITIGNORE_ADDITIONS[@]}"; do
  if ! grep -qxF "$entry" .gitignore 2>/dev/null; then
    echo "$entry" >> .gitignore
  fi
done
log "✓ .gitignore updated"

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
  echo "    ├── agents/           (6 sub-agents)"
  echo "    ├── hooks/            (4 hook scripts)"
  echo "    ├── rules/            (path-scoped rules)"
  echo "    └── skills/           (빈 폴더, 필요 시 추가)"
  echo "  progress/"
  echo "    ├── phase-gate.json"
  echo "    ├── feature_list.json"
  echo "    └── claude-progress.txt"
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
echo -e "  ${YELLOW}Tip:${NC} CLAUDE.md는 /init 결과보다 수동 정제가 낫습니다."
echo -e "  ${YELLOW}Tip:${NC} 실패 패턴 발견 시 → rules/ 또는 hooks/에 가드레일 추가"
echo ""
