# cc-harness

> One command to bootstrap a full-SDLC harness for Claude Code.

Claude Code의 전체 개발 생명주기(기획 → 설계 → 구현 → 테스트 → 보안 → QA → 배포 → 관측)를 자동화하는 harness를 프로젝트에 원커맨드로 적용합니다.

> **Note:** 이 프로젝트는 [Harness.io](https://harness.io) (CI/CD 플랫폼)와 무관합니다. 여기서 "harness"는 [AI agent harness engineering](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) 개념을 의미합니다.

## Quick Start

### Plugin Install (권장)

Claude Code에서 marketplace를 등록하고 plugin으로 설치합니다:

```bash
# 1. Marketplace 등록
/plugin marketplace add hanbyeol/cc-harness

# 2. Plugin 설치
/plugin install cc-harness
```

또는 Claude Code의 plugin manager UI에서:

```bash
/plugin    # → Discover 탭에서 cc-harness 검색 → Install
```

### Bootstrapper (전체 프로젝트 스캐폴딩)

plugin은 agents, skills, hooks, rules를 설치합니다.
progress 추적, docs 템플릿, Makefile 등 전체 프로젝트 스캐폴딩이 필요하면 bootstrapper를 사용하세요:

```bash
# npx
npx cc-harness --preset go-k8s

# curl (npm 없이)
bash <(curl -sL https://raw.githubusercontent.com/hanbyeol/cc-harness/main/init.sh)

# clone 후 실행
git clone https://github.com/hanbyeol/cc-harness.git ~/.cc-harness
bash ~/.cc-harness/init.sh --preset go-k8s
```

그 다음:

```bash
git add .claude/ CLAUDE.md progress/ docs/ evals/ Makefile
git commit -m "chore: initialize SDLC harness"
claude    # ← 자동으로 harness 적용
```

## Plugin vs Bootstrapper

| | Plugin (`/plugin install`) | Bootstrapper (`npx cc-harness`) |
|---|---|---|
| **agents** (8개) | O (네이티브 로딩) | O (.claude/ 복사) |
| **hooks** (6개) | O (네이티브 등록) | O (.claude/ 복사) |
| **skills** (8개) | O (네이티브 로딩) | O (.claude/ 복사) |
| **rules** (11개) | O (.claude/rules/ 복사) | O (프리셋 기반 선택) |
| **settings.json** | 불필요 (hooks.json 네이티브) | O |
| progress/ | - | O |
| docs/ (SPEC, ARCHITECTURE) | - | O |
| evals/ | - | O |
| Makefile | - | O |
| CLAUDE.md | - | O |
| 프리셋 선택 | - | O (go-minimal, fullstack 등) |

**Plugin** — Claude Code 네이티브 통합. agents, skills, hooks, rules를 즉시 사용.
**Bootstrapper** — 전체 SDLC 스캐폴딩 포함. 새 프로젝트 초기 세팅에 적합.

## Presets (Bootstrapper)

| Preset | 포함 항목 | 사용 예 |
|--------|----------|---------|
| `go-minimal` | Go rules + hooks | Go 단일 서비스 |
| `go-k8s` | Go + K8s + deploy agent | Go 마이크로서비스 |
| `fullstack` | Go + React + iOS + Android + K8s + Proto | 폴리글랏 모노레포 |
| `mobile` | React Native + Flutter | 모바일 전용 |
| `unity` | Unity3D + C# + mcp-unity | 게임 개발 |
| `custom` | 대화형 선택 | 맞춤 구성 |

```bash
npx cc-harness --preset fullstack --name my-project
npx cc-harness --preset go-minimal --force    # 기존 .claude/ 덮어쓰기
npx cc-harness                                 # 대화형
```

## 포함 항목

### Agents (8개)

| Agent | Phase | 역할 | 모델 |
|-------|-------|------|------|
| `spec-writer` | 1. 기획 | 요구사항 인터뷰 → SPEC.md 작성 | Sonnet 4.6 |
| `architect` | 2. 설계 | 아키텍처 설계 + 위협 모델링 | **Fable 5** |
| `implementer` | 3. 구현 | 코드 구현 + 보안 셀프체크 | Opus 4.8 |
| `test-writer` | 4. 검증 | 단위/통합/E2E 테스트 작성 | Haiku 4.5 |
| `security-auditor` | 4. 검증 | 보안 감사 + 위협 모델링 검증 | Opus 4.8 |
| `qa-reviewer` | 4. 검증 | 사용자 관점 QA + 통합 테스트 | Haiku 4.5 |
| `evaluator` | 게이트 | 5차원 품질 평가 (min-of-5 scoring) | **Fable 5** |
| `deploy-operator` | 5. 배포 | staging → production 배포 관리 | Haiku 4.5 |

> **모델 라우팅 (v1.4.0)** — 추론 강도에 따라 모델을 차등 배치:
> - **Fable 5** (`claude-fable-5`): 설계·품질 게이트처럼 판단 품질이 결과를 좌우하는 단계.
>   1M 컨텍스트 기본. 단, **30일 데이터 보존 정책 필수**(ZDR 조직 사용 불가), 단가 $10/$50 per MTok.
>   Fable 5를 사용할 수 없는 환경은 `agents/architect.md`, `agents/evaluator.md`의 `model:`을 `claude-opus-4-8`로 변경.
> - **Opus 4.8**: 에이전틱 코딩(implementer)과 보안 감사(security-auditor).
>   security-auditor는 Fable 5의 cyber 안전 분류기가 보안 분석을 refusal할 수 있어 **의도적으로 Opus 사용**.
> - **Haiku 4.5**: 체크리스트성 검증·배포 등 비용 효율이 중요한 단계.

### Skills (8개)

| Skill | 설명 |
|-------|------|
| `/brainstorm` | 코드/스펙 전 소크라테스식 설계 정제 (Phase 0.5) |
| `/change-request` | 기능 변경 요청 + 연쇄 영향 분석 |
| `/implement` | 가이드 기반 기능 구현 (Plan 게이트 + 체크포인트 태스크 + TDD) |
| `/hotfix` | 긴급 버그 수정 경량 워크플로우 (재현 테스트 먼저, 3파일 이하, 비보안) |
| `/debug` | 원인 불명 버그의 4단계 근본원인 디버깅 |
| `/finish-branch` | 브랜치 마무리: 테스트 → drift 확인 → PR/머지/보류 |
| `/progress` | 상태 대시보드 + 다음 액션 |
| `/sync-docs` | 코드-문서 드리프트 감지 (`--deep` 1M 컨텍스트 전수 검사) |

> 프로세스 방법론(brainstorm/TDD/debug/finish-branch)은 [obra/superpowers](https://github.com/obra/superpowers)에서
> 선택적으로 채택했습니다 — 채택/미채택 근거는 [ADR-003](docs/DECISIONS/ADR-003-superpowers-adoption.md) 참조.

### Hooks (6개)

plugin 설치 시 `hooks.json`을 통해 **네이티브 등록**됩니다 — settings.json 수정 불필요:

| Event | Hook | 동작 |
|-------|------|------|
| SessionStart | `setup-claudemd.sh` | rules 복사, CLAUDE.md 섹션 세팅 (멱등), v1.4 복사본 마이그레이션 |
| SessionStart | `session-context.sh` | 브랜치, Phase, 미완료 기능 주입 + agent-comms 아카이빙 |
| PreToolUse | `pre-bash-firewall.sh` | 파괴적 명령어 차단(deny) / 위험 명령어 확인(ask) |
| PostToolUse | `post-edit-format.sh` | 자동 포맷팅 (gofmt, prettier 등) |
| Stop | `pre-commit-gate.sh` | 선택적 린트 + 테스트 + 시크릿 스캔 |
| Stop | `session-handoff.sh` | 세션 상태 저장 (draft 병합) |

### Rules (11개)

Path-scoped 규칙 — 해당 파일 작업 시에만 로드:

`general` · `go-backend` · `react-frontend` · `k8s-infra` · `proto-api` · `ios-swift` · `android-kotlin` · `react-native` · `flutter-dart` · `spring-boot` · `unity3d`

## 6-Phase SDLC

```
Phase 1        Phase 2        Phase 3        Phase 4           Phase 5       Phase 6
기획 ──────▶ 설계 ──────▶ 구현 ──────▶ 검증 ────────▶ 배포 ──────▶ 관측
spec-writer   architect    implementer   test-writer      deploy-op    observability
                            (병렬)       security-auditor  (staging→    (metrics,
                                         qa-reviewer       prod)        logs, traces)
                                          (병렬)
```

각 Phase는 `progress/phase-gate.json`으로 관리됩니다. Phase 미통과 시 다음 단계 진입이 차단됩니다.

## 자동으로 작동하는 것들

`claude` 실행만 하면 아래가 **전부 자동**입니다:

| 이벤트 | 동작 |
|--------|------|
| 세션 시작 | 브랜치, Phase, 미완료 기능, 마지막 커밋 주입 |
| 코드 편집 | gofmt, prettier, swiftformat, ktlint, dart format 등 자동 실행 |
| Bash 실행 | `rm -rf /`, `git push --force`, `DROP TABLE` 등 차단(deny), `git reset --hard` 등은 확인(ask) |
| 세션 종료 | 변경 파일 언어별 린트 + 테스트, 상태 저장 |
| plugin 업데이트 | 버전 감지 → 마이그레이션 + 미수정 rules 자동 갱신 (수정본은 보존, [ADR-002](docs/DECISIONS/ADR-002-versioned-upgrade.md)) |

## 커스터마이징

### 규칙 추가

```bash
cat > .claude/rules/my-rule.md << 'EOF'
---
paths:
  - "src/special/**/*.go"
---
# Special Directory Rules
- 이 디렉토리는 특별한 규칙을 따른다
EOF
```

### Hook 추가

`.claude/settings.json`의 hooks 섹션에 추가:

```json
{
  "PreToolUse": [{
    "matcher": "mcp__github__create_pull_request",
    "hooks": [{ "type": "command", "command": "bash \"${CLAUDE_PROJECT_DIR}/.claude/hooks/pre-pr-test.sh\"" }]
  }]
}
```

### Skill 추가

```bash
mkdir -p .claude/skills/deploy-checklist
cat > .claude/skills/deploy-checklist/SKILL.md << 'EOF'
---
name: deploy-checklist
description: "배포 전 체크리스트. TRIGGER: '배포 준비', 'deploy checklist' 요청 시 실행."
---
# Deploy Checklist
1. 모든 테스트 통과 확인
2. staging 배포 및 스모크 테스트
...
EOF
```

## Improvement Loop

| 실패 패턴 | 해결 위치 |
|----------|----------|
| 반복되는 코딩 실수 | `.claude/rules/`에 규칙 추가 |
| 위험 명령어 실행 | `pre-bash-firewall.sh`에 패턴 추가 |
| 포맷팅 누락 | `post-edit-format.sh`에 케이스 추가 |
| 복잡한 참조 자료 | `.claude/skills/`에 스킬 파일 추가 |
| 컨텍스트 오염 | Sub-agent로 작업 격리 |

## Background

이 프로젝트는 다음 자료들의 best practice를 하나의 실행 가능한 부트스트래퍼로 통합한 것입니다:

- [Anthropic: Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Claude Code Best Practices](https://code.claude.com/docs/en/best-practices)
- [Claude Code Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
- [HumanLayer: Harness Engineering for Coding Agents](https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents)
- [HumanLayer: Writing a Good CLAUDE.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md)
- [muraco.ai: Harness Engineering 101](https://muraco.ai/en/articles/harness-engineering-claude-code-codex/)

## Requirements

- `git` — 프로젝트가 git repository여야 합니다
- `bash` 4.0+ (bootstrapper 사용 시)
- `jq` (선택 — 없으면 sed fallback)
- 각 언어 도구 (선택 — 없으면 해당 hook이 graceful skip)

## License

MIT
