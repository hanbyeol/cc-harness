# cc-harness

> One command to bootstrap a full-SDLC harness for Claude Code.

Claude Code의 전체 개발 생명주기(기획 → 설계 → 구현 → 테스트 → 보안 → QA → 배포 → 관측)를 자동화하는 harness를 프로젝트에 원커맨드로 적용합니다.

> **Note:** 이 프로젝트는 [Harness.io](https://harness.io) (CI/CD 플랫폼)와 무관합니다. 여기서 "harness"는 [AI agent harness engineering](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) 개념을 의미합니다.

## Quick Start

```bash
# 프로젝트 루트에서 실행 (git repo 필요)
bash <(curl -sL https://raw.githubusercontent.com/hanbyeol/cc-harness/main/init.sh)
```

또는:

```bash
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

## Presets

| Preset | 포함 항목 | 사용 예 |
|--------|----------|---------|
| `go-minimal` | Go rules + hooks | Go 단일 서비스 |
| `go-k8s` | Go + K8s + deploy agent | Go 마이크로서비스 |
| `fullstack` | Go + React + iOS + Android + K8s + Proto | 폴리글랏 모노레포 |
| `custom` | 대화형 선택 | 맞춤 구성 |

```bash
bash init.sh --preset fullstack --name my-project
bash init.sh --preset go-minimal --force    # 기존 .claude/ 덮어쓰기
bash init.sh                                 # 대화형
```

## 생성되는 구조

```
your-project/
├── CLAUDE.md                       # 핵심 규칙 (30줄 이하)
├── .claude/
│   ├── settings.json               # Hooks 자동 설정
│   ├── agents/                     # Sub-agent 정의 (6개)
│   │   ├── spec-writer.md          #   Phase 1: 기획
│   │   ├── architect.md            #   Phase 2: 설계
│   │   ├── implementer.md          #   Phase 3: 구현
│   │   ├── test-writer.md          #   Phase 4: 테스트
│   │   ├── security-auditor.md     #   Phase 4: 보안
│   │   └── deploy-operator.md      #   Phase 5: 배포
│   ├── hooks/                      # 자동 실행 스크립트 (4개)
│   │   ├── session-context.sh      #   세션 시작 시 상태 주입
│   │   ├── pre-bash-firewall.sh    #   위험 명령어 차단
│   │   ├── post-edit-format.sh     #   편집 후 자동 포맷팅
│   │   └── pre-commit-gate.sh      #   종료 시 린트+테스트
│   ├── rules/                      # Path-scoped 언어별 규칙
│   │   ├── general.md              #   항상 로드
│   │   ├── go-backend.md           #   *.go 작업 시만 로드
│   │   ├── react-frontend.md       #   *.ts/*.tsx 작업 시만
│   │   └── ...                     #   (프리셋에 따라)
│   └── skills/                     # 빈 폴더 (필요 시 추가)
├── progress/
│   ├── phase-gate.json             # 6-Phase 게이트
│   ├── feature_list.json           # 기능 목록 + 완료 상태
│   └── claude-progress.txt         # 세션 간 상태 전달
├── docs/
│   ├── SPEC.md                     # Phase 1 산출물
│   ├── ARCHITECTURE.md             # Phase 2 산출물
│   ├── HARNESS-GUIDE.md            # 개발 전과정 실전 가이드
│   └── DECISIONS/                  # ADR
├── evals/
│   └── acceptance-criteria.json    # 인수 기준
└── Makefile                        # 통합 빌드 인터페이스
```

## 자동으로 작동하는 것들

`claude` 실행만 하면 아래가 **전부 자동**입니다:

### 🚀 세션 시작 시

```
=== Session Context ===
Branch: feature/push | Phase: implementation | Pending: 7
Last: abc1234 feat: implement NATS publisher
→ progress/claude-progress.txt와 git log 먼저 확인
```

### ✏️ 코드 편집 시

| 파일 확장자 | 자동 실행 |
|------------|----------|
| `*.go` | `gofmt` + `goimports` |
| `*.swift` | `swiftformat` |
| `*.kt` | `ktlint --format` |
| `*.ts`, `*.tsx` | `prettier --write` |
| `*.java` | `google-java-format` |
| `*.proto` | `buf format` |
| `*.json` | `jq` 정렬 |

### 🛡️ 위험 명령어 실행 시

`rm -rf /`, `git push --force`, `DROP TABLE` 등 → **차단 (exit 2)**

### ✅ 세션 종료 시

변경된 파일의 언어만 선택적으로 린트 + 테스트 실행.
실패 시 에이전트에게 수정 지시.

### 📂 Path-scoped Rules

Go 파일 작업 → Go 규칙만 로드, Swift 규칙은 로드 안 됨.
컨텍스트 budget(~150 instructions) 효율적 사용.

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

### 사용 예시

```bash
# Phase 1: 기획
> "SPEC.md를 작성해줘. AskUserQuestion으로 인터뷰부터."

# Phase 2: 설계
> "SPEC.md 기반으로 ARCHITECTURE.md, API-DESIGN.md 작성해."

# Phase 3: 구현
> "feature_list.json에서 다음 미완료 기능 구현해."

# Phase 4: 검증 (병렬)
> "3개 subagent 병렬: test-writer, security-auditor, qa-reviewer"

# Phase 5: 배포
> "staging 배포 → 스모크 테스트"
```

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
    "hooks": [{ "type": "command", "command": ".claude/hooks/pre-pr-test.sh" }]
  }]
}
```

### Skill 추가

```bash
cat > .claude/skills/deploy-checklist.md << 'EOF'
---
name: deploy-checklist
description: 배포 전 체크리스트
---
# Deploy Checklist
1. 모든 테스트 통과 확인
2. staging 배포 및 스모크 테스트
...
EOF
```

## Improvement Loop

에이전트가 같은 실수를 반복하면:

| 실패 패턴 | 해결 위치 |
|----------|----------|
| 반복되는 코딩 실수 | `.claude/rules/`에 규칙 추가 |
| 위험 명령어 실행 | `pre-bash-firewall.sh`에 패턴 추가 |
| 포맷팅 누락 | `post-edit-format.sh`에 케이스 추가 |
| 복잡한 참조 자료 | `.claude/skills/`에 스킬 파일 추가 |
| 컨텍스트 오염 | Sub-agent로 작업 격리 |

```bash
git commit -m "chore: add guardrail for [실패 패턴]"
```

## 기존 프로젝트에 적용

```bash
# 기존 .claude/가 있으면 자동 백업 후 생성
bash init.sh --force --preset go-k8s

# 기존 CLAUDE.md가 있으면 수동 병합 필요:
#   공통 규칙     → CLAUDE.md (30줄 이하)
#   언어별 규칙   → .claude/rules/ (path-scoped)
#   참조 문서     → .claude/skills/
```

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
- `bash` 4.0+
- `jq` (선택 — 없으면 sed fallback)
- 각 언어 도구 (선택 — 없으면 해당 hook이 graceful skip)

## License

MIT
