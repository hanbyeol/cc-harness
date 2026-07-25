# cc-harness

> A full-SDLC harness for Claude Code — quality gates, security by design, and a development methodology that enforces itself.

Claude Code의 전체 개발 생명주기(설계 정제 → 기획 → 아키텍처 → 구현 → 검증 → 배포 → 관측)를 구조화하는 harness입니다. plugin 설치 한 번으로 8 agents · 11 skills · 10 hooks · 11 rules가 적용됩니다.

> **Note:** 이 프로젝트는 [Harness.io](https://harness.io) (CI/CD 플랫폼)와 무관합니다. 여기서 "harness"는 [AI agent harness engineering](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) 개념 — 에이전트가 일관된 품질로 일하도록 둘러싸는 구조 — 을 의미합니다.

## 핵심 설계 원칙

| 원칙 | 구현 |
|------|------|
| **Generator–Evaluator 분리** | 구현자(implementer)는 자기 작업을 통과 판정할 수 없다 — 독립 evaluator만 `passes: true` 설정 가능 |
| **min-of-5 품질 게이트** | 종합 점수 = 기능·품질·보안·에러처리·테스트 5개 점수의 **최솟값**. 평균으로 약점을 가릴 수 없다 |
| **Evidence over claims** | 실행하지 않은 검증은 완료가 아니다 — implementer는 실행 결과(`evidence`)를 첨부, evaluator는 미실행 차원에 7점 이상을 줄 수 없다(`unverified` 상한) |
| **기준 역전파** | 구현 중 발견한 기준 갭은 코드가 아니라 상위 산출물(SPEC, acceptance criteria)부터 보완한다 |
| **Security by design** | 기능마다 `security_tier` 태깅 — critical 기능은 보안 점수 7 미만 시 다른 점수와 무관하게 자동 fail |
| **결정론적 강제** | 프롬프트 규율에만 의존하지 않는다 — 위험 명령 차단, 자동 포맷, 품질 게이트, 시크릿 스캔은 **훅**이 집행 |
| **모델 라우팅** | 설계·판정·코딩·보안처럼 추론이 결과를 좌우하는 단계는 Opus, 스펙·테스트·배포는 Sonnet, 체크리스트성 QA는 Haiku — 할당은 `config/models.json` 단일 출처로 관리하고 model-tiering 프로브가 역전을 탐지 |

## Quick Start

### Plugin Install (권장)

```bash
# 1. Marketplace 등록
/plugin marketplace add hanbyeol/cc-harness

# 2. Plugin 설치
/plugin install cc-harness
```

또는 `/plugin` → Discover 탭에서 cc-harness 검색 → Install.

설치 후 첫 세션에서 자동으로:
- agents·skills·hooks가 **네이티브 로딩** (프로젝트에 복사하지 않음 — 업데이트 즉시 반영)
- rules가 `.claude/rules/`에 복사 (path-scoped 규칙은 프로젝트 단위)
- `CLAUDE.md`에 하네스 워크플로우 섹션 삽입 (멱등 — 중복 삽입 없음)
- 세션 컨텍스트(브랜치, phase, 미완료 기능) 주입 시작

`/progress`를 실행하면 현재 상태와 다음 작업을 확인할 수 있습니다.

### Bootstrapper (전체 프로젝트 스캐폴딩)

progress 추적, docs 템플릿, Makefile까지 포함한 전체 스캐폴딩이 필요하면:

```bash
npx cc-harness --preset go-k8s            # npx
bash <(curl -sL https://raw.githubusercontent.com/hanbyeol/cc-harness/main/init.sh)   # npm 없이
```

```bash
git add .claude/ CLAUDE.md progress/ docs/ evals/ Makefile
git commit -m "chore: initialize SDLC harness"
claude
```

## 동작 방식 — 워크플로우

### 개발 흐름

```
 Phase 0.5         Phase 1        Phase 2        Phase 3            Phase 4             Phase 5      Phase 6
 설계 정제     ▶   기획       ▶   설계       ▶   구현           ▶   검증            ▶   배포     ▶   관측
 /brainstorm       spec-writer    architect      /implement         evaluator(게이트)    deploy-op    metrics
 (소크라테스식      (인터뷰 브리프  (위협 모델링,   Sprint Contract    ──병렬──▶            (staging→    logs
  질문, 대안        → SPEC,       SECURITY-      → Plan 게이트       test-writer          canary→      alerts
  비교)            criteria)      CHECKLIST,     → TDD 구현          security-auditor     prod,        runbooks
                                  ADR)           → 검증 요청         qa-reviewer          롤백)
```

### 기능 하나의 생애 (Generator–Evaluator Loop)

```
 /change-request ─▶ 산출물 갱신 ─▶ Sprint Contract(agreed:false) ─▶ Plan 게이트(사용자 승인)
                                                                          │ 승인
                                                                          ▼
        ┌──────────────────────────────  implementer (TDD: RED→GREEN→REFACTOR + evidence)
        │ 반려(피드백)                              │ 구현 완료
        ▼                                          ▼
   /implement --retry ◀───────────────  evaluator (5차원 채점, min-of-5, 실행 근거 기반)
                                                   │ pass → passes: true
                                                   ▼
                          test-writer + security-auditor + qa-reviewer (병렬)
                                                   │ 통과
                                                   ▼
                                          /finish-branch → PR/머지
```

핵심 게이트:
- **Plan 게이트**: Sprint Contract(acceptance/security/error criteria + 체크포인트 태스크)는 사용자가 ExitPlanMode로 승인해야 `agreed: true` — 승인 없이 구현 시작 불가
- **Evaluator 게이트**: 5개 점수 모두 임계값(기본 7) 이상이어야 통과. 채점은 이 세션에서 직접 실행한 테스트 결과 기반
- **Phase 게이트**: `progress/phase-gate.json`의 criteria가 모두 충족되어야 다음 phase 진입

## 구성 요소

### Agents (8개)

| Agent | Phase | 역할 | 모델 |
|-------|-------|------|------|
| `spec-writer` | 1. 기획 | 인터뷰 브리프 → SPEC.md + acceptance criteria (미해결 항목은 `open_questions` 반환) | Sonnet 5 |
| `architect` | 2. 설계 | 아키텍처 + 위협 모델링(STRIDE) + SECURITY-CHECKLIST + ADR | **Opus 5** |
| `implementer` | 3. 구현 | TDD(RED-GREEN-REFACTOR) 구현 + 보안 셀프체크 + 실행 evidence | Opus 5 |
| `evaluator` | 게이트 | 5차원 품질 평가 (min-of-5, 점수 앵커, unverified 상한) | **Opus 5** |
| `test-writer` | 4. 검증 | 통합/E2E/보안 테스트 (worktree 격리로 병렬 실행) | Sonnet 5 |
| `security-auditor` | 4. 검증 | 보안 감사 + supply chain + 위협 모델 대비 검증 | Opus 5 |
| `qa-reviewer` | 4. 검증 | 크로스 기능 통합 QA (사용자 관점) | Haiku 4.5 |
| `deploy-operator` | 5. 배포 | 배포 전 검증 → staging → canary → prod, 자동 롤백 | Sonnet 5 |

> **모델 라우팅** — 작업 난이도에 맞춰 차등 배치. 할당은 `config/models.json`을 단일 출처로 관리하며
> `agents/*.md` frontmatter와 일치해야 한다(불일치·역전·미등록은 model-tiering 프로브가 정적 탐지):
> - **Opus 5** (`claude-opus-5`): 추론 품질이 결과를 좌우하는 단계 — 설계(architect),
>   품질 게이트(evaluator), 에이전틱 코딩(implementer), 보안 감사(security-auditor).
>   Opus 5는 강화된 사이버보안 안전장치를 탑재해 **방어 목적 감사도 refusal될 수 있다** —
>   이 위험을 인지하고 최신 추론 능력을 우선해 격상했으며(F55), refusal로 인한 빈 산출은
>   `audit-integrity` 프로브가 정상 통과와 구분해 탐지한다. 권장 폴백은 `claude-opus-4-8`이다.
> - **Sonnet 5** (`claude-sonnet-5`): 실코딩성·안전 마진이 필요한 단계 — 스펙(spec-writer),
>   테스트 작성(test-writer, evaluator의 커버리지 차원에 직결), 배포(deploy-operator).
> - **Haiku 4.5** (`claude-haiku-4-5`): 체크리스트성 크로스 기능 QA(qa-reviewer).
>
> phase별 선언 단가(per-1M)는 `scripts/cost-report.sh`로 확인할 수 있습니다 — 읽기 전용, 실제 청구가 아닌 config 선언값입니다.

**서브에이전트 제약**: 서브에이전트는 사용자에게 질문할 수 없습니다 — 사용자 입력이 필요한 결정(인터뷰, 승인)은 메인 루프가 디스패치 전에 수집해 프롬프트로 전달하는 구조입니다.

### Skills (11개)

| Skill | 설명 |
|-------|------|
| `/brainstorm` | 코드/스펙 전 소크라테스식 설계 정제 — 대안 비교, `docs/brainstorms/` 산출 (Phase 0.5) |
| `/change-request` | 기능 추가/변경/삭제 시 산출물 연쇄 업데이트 + 의존성 영향 분석 |
| `/implement` | Sprint Contract → Plan 게이트 → 체크포인트 태스크 TDD 구현 → evaluator 검증 |
| `/hotfix` | 경량 긴급 수정 — **실패 재현 테스트 먼저**, 3파일 이하, 비보안 |
| `/debug` | 원인 불명 버그의 4단계 디버깅: 재현 고정 → 근본원인 추적 → 최소 수정 → 회귀 테스트 |
| `/finish-branch` | 브랜치 마무리: 전체 테스트 → drift 확인 → PR 생성/로컬 머지/보류 |
| `/improve` | 자기개선 루프 1회전 — 진단 프로브 → 후보 → 기존 게이트 오케스트레이션 |
| `/plan-review` | (iac 프로파일) terraform plan diff 리뷰 게이트 — 정책·smoke·drift |
| `/rollout` | (ops 프로파일) 라이브 k8s 변경 안전 루프 — 관측→승인→롤백→health |
| `/progress` | 진행 대시보드(phase, 기능, 최근 피드백) + 다음 액션 제안 |
| `/sync-docs` | 코드-문서 drift 감지 (`--deep`: 1M 컨텍스트 전수 교차 검사) |

자연어로 말해도 됩니다 — CLAUDE.md의 라우팅 테이블이 의도를 분기합니다:
"왜 안 되지?" → `/debug` · "구현해줘" → `/implement` · "작업 끝났어" → `/finish-branch`

> 프로세스 방법론(brainstorm/TDD/debug/finish-branch)은 [obra/superpowers](https://github.com/obra/superpowers)에서
> 선택적으로 채택했습니다. inline self-review는 독립 evaluator를 유지하기 위해 의도적으로 채택하지
> 않았습니다 — 근거는 [ADR-003](docs/DECISIONS/ADR-003-superpowers-adoption.md).

### Hooks (10개)

plugin 설치 시 `hooks.json`으로 **네이티브 등록**됩니다 — settings.json 수정 불필요:

| Event | Hook | 동작 |
|-------|------|------|
| SessionStart | `setup-claudemd.sh` | rules 복사·갱신, CLAUDE.md 섹션 세팅(멱등), 버전 업그레이드 마이그레이션 |
| SessionStart | `session-context.sh` | 브랜치·phase·미완료 기능·handoff 주입 + agent-comms 아카이빙 |
| PreToolUse (Bash) | `pre-bash-firewall.sh` | 파괴적 명령 **deny** / 위험·시크릿유출·검증파일쓰기 **ask** / 그 외 **자동 통과(default-allow)** |
| PreToolUse (WebFetch\|WebSearch\|MCP) | `pre-tool-firewall.sh` | 읽기 전용 도구(WebFetch·WebSearch·MCP read-verb) **자동 허용** / MCP write·업로드·미분류 도구 프롬프트 ([ADR-005](docs/DECISIONS/ADR-005-cross-tool-permission-tier.md)) |
| PreToolUse (Edit\|Write) | `invariant-guard.sh` | 검증 장치 약화(임계값 하향·deny 삭제·테스트 삭제·방화벽 allow 확장) 차단 ([INVARIANTS.md](docs/INVARIANTS.md)) |
| PostToolUse | `post-edit-format.sh` | 자동 포맷팅 (gofmt, prettier, swiftformat, ktlint, dart 등) |
| Stop | `pre-commit-gate.sh` | 변경 언어별 테스트 + 커버리지 기록 + 시크릿 스캔 (동일 트리 재실행 skip 캐시) |
| Stop | `session-handoff.sh` | 세션 상태 저장 (draft 병합 → 다음 세션 주입) |
| PreCompact | `pre-compact.sh` | 컨텍스트 컴팩션 직전 세션 상태 스냅샷(session-handoff와 로직 공유) + draft 부재 시 미기록 결정·블로커 기록 유도 (게이트 아님·컴팩션 미차단) |
| SubagentStop (evaluator) | `subagent-evaluator-log.sh` | evaluator 서브에이전트 실행을 `evaluator-runs.jsonl`에 기록 — INV-11이 passes 전환 시 '실제 evaluator 실행'을 시간창으로 대조(F54, 순수 기록·비차단) |

> `hooks/lib.sh`는 이벤트 훅이 아니라 위 훅들이 공유하는 라이브러리(cfg_get·version_lt·harness_cd·handoff snapshot)입니다.

**Firewall 정책** — **default-allow(위험만 게이트, 나머지 무프롬프트)** (우선순위: deny → ask → default-allow):
- **deny**: 루트/홈/시스템 디렉토리 `rm`, `git push --force`(`--force-with-lease`는 허용), pipe-to-shell(중간 파이프 우회 포함), fork bomb, `DROP TABLE`, eval/명령치환 우회 등 복구 불가·파괴
- **ask**: uncommitted 손실 위험(`git reset --hard`·`git clean -f`) + **하네스 자기보호**(검증파일 `harness-config.json`·`hooks/*`·`tests/*`·`INVARIANTS.md` 쓰기 — cp/mv/리다이렉트뿐 아니라 인터프리터(`python3 -c`)·에디터(`vim`)·`git -c core.hooksPath`·`GIT_CONFIG_*` 경유 포함) + **시크릿 egress**(`curl/nc/scp`가 `~/.ssh`·`~/.aws`·개인키를 외부 전송) + `terraform destroy`·`kubectl delete`·`helm uninstall` 등
- **default-allow**: deny/ask에 걸리지 않은 **나머지 모든 명령을 무프롬프트 통과** — `python`·`node`·`git push`·`npm install`·`docker build`·`find` 등 일반 개발은 확인 없이 실행된다(위험 명령만 게이트). `harness-config.json`의 `firewall.auto_allow`(기본 true)로 allow만 on/off — deny/ask는 항상 유지

**크로스도구 권한** (`pre-tool-firewall.sh`, [ADR-005](docs/DECISIONS/ADR-005-cross-tool-permission-tier.md)): Bash 외 도구도 **읽기 전용은 무프롬프트** — WebFetch·WebSearch·MCP read-verb(`get`/`list`/`search`/`read` 등)는 자동 허용, MCP write(`create`/`delete`/`send`/`upload`)·`file_upload`·미분류 도구는 프롬프트. `firewall.auto_allow_tools`(기본 true)로 on/off.

### Rules (11개)

Path-scoped 규칙 — 해당 파일 작업 시에만 로드:

`general` · `go-backend` · `react-frontend` · `k8s-infra` · `proto-api` · `ios-swift` · `android-kotlin` · `react-native` · `flutter-dart` · `spring-boot` · `unity3d`

## 자동으로 작동하는 것들

`claude` 실행만 하면 아래가 **전부 자동**입니다:

| 이벤트 | 동작 |
|--------|------|
| 세션 시작 | 브랜치, phase, 미완료 기능, 이전 세션 handoff, 마지막 evaluator 피드백 주입 |
| 코드 편집 | 언어별 포맷터 자동 실행 |
| Bash 실행 | 파괴적 명령 deny / 위험·시크릿유출·검증파일쓰기 ask / 그 외 자동 통과(default-allow, 무프롬프트) |
| WebFetch·MCP 실행 | 읽기 전용 도구 자동 허용 / MCP write·업로드는 프롬프트 |
| 세션 종료 | 변경 파일 언어별 테스트 + 커버리지 기록(`progress/coverage-report.json`) + 시크릿 스캔, 상태 저장 |
| plugin 업데이트 | 버전 감지 → 마이그레이션 + 미수정 rules 자동 갱신 (수정본 보존) |

## 업그레이드

plugin 업데이트(`/plugin` → Installed) 후 **첫 세션에서 자동 마이그레이션**됩니다:

- `.claude/.cc-harness-installed`의 설치 버전과 비교 — 같으면 아무 작업 안 함 (세션 비용 0)
- rules는 sha256 manifest로 pristine 판별 — **수정하지 않은 파일만** 새 버전으로 갱신, 수정본은 보존 + 안내
- v1.4 이하에서 복사된 `.claude/agents|skills|hooks` 중복본은 자동 정리 (과거 릴리스 해시로 pristine 식별, 커스터마이징은 보존)
- `{이전} → {새 버전}` 전환 내역을 세션 시작 시 출력

> 한 repo가 여러 라이프사이클을 겸하면 `harness-config.json`의 `"profiles": ["iac","ops"]` 배열로 동시 적용할 수 있습니다(워크플로우 섹션이 연결 주입됨).

상세: [ADR-002 (versioned upgrade)](docs/DECISIONS/ADR-002-versioned-upgrade.md), [ADR-001 (plugin-native loading)](docs/DECISIONS/ADR-001-plugin-native-loading.md)

## Plugin vs Bootstrapper

| | Plugin (`/plugin install`) | Bootstrapper (`npx cc-harness`) |
|---|---|---|
| **agents** (8) / **skills** (11) / **hooks** (10) | O — 네이티브 로딩 (업데이트 즉시 반영) | O — `.claude/` 복사 |
| **rules** (11) | O — `.claude/rules/` 복사 | O — 프리셋 기반 선택 |
| settings.json | 불필요 (hooks.json 네이티브) | O |
| progress/ · docs/ · evals/ · Makefile · CLAUDE.md 스캐폴딩 | CLAUDE.md 섹션만 | O |
| 프리셋 선택 | - | O |

**Plugin** — 기존 프로젝트에 즉시 적용, 업데이트 자동 전파. **Bootstrapper** — 새 프로젝트 전체 스캐폴딩.

### Presets (Bootstrapper)

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
npx cc-harness --update                       # 기존 설치 업데이트
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

> plugin이 관리하는 기본 rules를 수정해도 됩니다 — 업그레이드 시 수정본은 덮어쓰지 않고 보존됩니다.

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
EOF
```

`description`의 TRIGGER 문구가 자연어 자동 라우팅의 단서가 됩니다.

### Hook 추가

프로젝트 전용 훅은 `.claude/settings.json`에 추가합니다 (plugin 훅과 공존):

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "mcp__github__create_pull_request",
      "hooks": [{ "type": "command", "command": "bash \"${CLAUDE_PROJECT_DIR}/.claude/hooks/pre-pr-test.sh\"" }]
    }]
  }
}
```

### 채점 임계값 조정

`progress/harness-config.json`:

```json
{
  "scoring": {
    "pass_threshold": 7,
    "security_thresholds": { "critical": 7, "standard": 5, "low": 3 }
  },
  "agent_comms": { "max_files_per_type": 10, "archive_enabled": true }
}
```

## Improvement Loop

harness 자체도 실패에서 배웁니다:

| 실패 패턴 | 해결 위치 |
|----------|----------|
| 반복되는 코딩 실수 | `.claude/rules/`에 규칙 추가, `progress/lessons.md`에 교훈 축적 |
| evaluator 오판 (통과시켰는데 버그) | `evals/calibration/false-positives.json`에 기록 → 이후 채점 보정 |
| 위험 명령어 통과 | `pre-bash-firewall.sh`에 패턴 추가 (bats 테스트와 함께) |
| 포맷팅 누락 | `post-edit-format.sh`에 케이스 추가 |
| 반복 참조하는 절차 | `.claude/skills/`에 스킬 추가 |
| 컨텍스트 오염 | sub-agent로 작업 격리, 세션 간 인계는 handoff가 담당 |

## 설계 결정 (ADRs)

| ADR | 결정 |
|-----|------|
| [ADR-001](docs/DECISIONS/ADR-001-plugin-native-loading.md) | agents/skills/hooks 복사 → plugin 네이티브 로딩 (이중 등록 제거, v1.5.0) |
| [ADR-002](docs/DECISIONS/ADR-002-versioned-upgrade.md) | 버전 기록 + hash manifest 기반 업그레이드 프로세스 (v1.5.0) |
| [ADR-003](docs/DECISIONS/ADR-003-superpowers-adoption.md) | superpowers 방법론 선택적 채택 — 독립 evaluator는 유지 (v1.6.0) |
| [ADR-004](docs/DECISIONS/ADR-004-firewall-auto-allow.md) | Bash firewall default-allow — 위험만 게이트, 나머지 무프롬프트 (v1.13.0, 정밀화 v1.13.1) |
| [ADR-005](docs/DECISIONS/ADR-005-cross-tool-permission-tier.md) | 크로스도구 권한 계층 — 읽기전용 도구 auto-allow, MCP write 게이트 (v1.14.0) |

## Background

이 프로젝트는 다음 자료들의 best practice를 하나의 실행 가능한 harness로 통합한 것입니다:

- [Anthropic: Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Claude Code Best Practices](https://code.claude.com/docs/en/best-practices)
- [Claude Code Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
- [obra/superpowers](https://github.com/obra/superpowers) — TDD·디버깅·브레인스토밍 방법론의 원전
- [HumanLayer: Harness Engineering for Coding Agents](https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents)
- [HumanLayer: Writing a Good CLAUDE.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md)
- [muraco.ai: Harness Engineering 101](https://muraco.ai/en/articles/harness-engineering-claude-code-codex/)

## Requirements

- `git` — 프로젝트가 git repository여야 합니다
- `jq` — **권장**. 없으면 bash firewall이 비활성화되고(경고 출력) 세션 컨텍스트 주입이 축소됩니다
- `bash` 3.2+ (hooks), 4.0+ (bootstrapper)
- 각 언어 도구 (선택 — 없으면 해당 hook이 graceful skip)
- 개발 시: `bats`, `shellcheck` (테스트 600개, CI에서 강제)

## License

MIT
