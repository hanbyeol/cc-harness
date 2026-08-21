# cc-harness

> A full-SDLC harness for Claude Code — quality gates, security by design, and a development methodology that enforces itself.

Claude Code의 개발 생명주기 전체(설계 정제 → 기획 → 아키텍처 → 구현 → 검증 → 배포 → 관측)를 구조화하는 harness입니다.
plugin 설치 한 번으로 **8 agents · 11 skills · 11 hooks · 11 rules · 3 lifecycle profiles**가 적용됩니다.

> **Note:** 이 프로젝트는 [Harness.io](https://harness.io) (CI/CD 플랫폼)와 무관합니다. 여기서 "harness"는 [AI agent harness engineering](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) 개념 — 에이전트가 일관된 품질로 일하도록 둘러싸는 구조 — 을 의미합니다.

## 한눈에 보기

| | 개수 | 무엇 |
|---|---|---|
| **Agents** | 8 | spec-writer · architect · implementer · evaluator · test-writer · security-auditor · qa-reviewer · deploy-operator |
| **Skills** | 11 | brainstorm · change-request · implement · hotfix · debug · finish-branch · improve · plan-review · rollout · progress · sync-docs |
| **Hooks** | 11 (+ 공유 라이브러리 1) | 세션 컨텍스트, Bash/도구 방화벽, 불변식 가드, 무결성 복구, 포맷팅, 테스트 게이트, 핸드오프 |
| **Rules** | 11 | path-scoped 언어·플랫폼 규칙 |
| **Profiles** | 3 | `sdlc`(기본) · `iac`(terraform) · `ops`(k8s day-2) |
| **불변식** | 15 | `docs/INVARIANTS.md` — 검증 장치를 약화시키는 편집을 기계적으로 차단 |
| **진단 프로브** | 9 | `scripts/probes/` — 하네스가 자신의 결함을 자동 발견 |
| **테스트** | bats 778건 | CI에서 shellcheck·JSON 검증·버전 정합과 함께 강제 |

## 핵심 설계 원칙

| 원칙 | 구현 |
|------|------|
| **Generator–Evaluator 분리** | 구현자(implementer)는 자기 작업을 통과 판정할 수 없다 — 독립 evaluator만 `passes: true` 설정 가능. inline self-review로 대체 금지 (INV-1) |
| **min-of-5 품질 게이트** | 종합 점수 = 기능·품질·보안·에러처리·테스트 5개 점수의 **최솟값**. 평균으로 약점을 가릴 수 없다 (INV-2) |
| **Evidence over claims** | 실행하지 않은 검증은 완료가 아니다 — implementer는 실행 결과(`evidence`)를 첨부하고, evaluator는 미실행 차원에 7점 이상을 줄 수 없다(`unverified` 상한) |
| **기준 역전파** | 구현 중 발견한 기준 갭은 코드가 아니라 상위 산출물(SPEC, acceptance criteria)부터 보완한다 |
| **Security by design** | 기능마다 `security_tier` 태깅 — critical 기능은 보안 점수 7 미만 시 다른 점수와 무관하게 자동 fail (INV-4) |
| **결정론적 강제** | 프롬프트 규율에만 의존하지 않는다 — 위험 명령 차단, 자동 포맷, 품질 게이트, 시크릿 스캔은 **훅**이 집행 |
| **예측 + 탐지 이중화** | "이 명령이 보호 파일을 쓸 것인가"는 실행 없이 답할 수 없는 질문이다(셸이 튜링 완전). 그래서 사전 예측(방화벽·불변식 가드)에 더해 **사후 탐지·복구**(`protected-integrity.sh`)를 둔다 (INV-14) |
| **마찰 최소화** | 위험만 게이트하고 나머지는 무프롬프트 — 일반 개발 명령·읽기 전용 도구는 확인 없이 실행된다 |
| **검증 티어링** | 검증 강도를 `security_tier`·변경 크기에 매칭 — 문서/low는 경량, standard는 evaluator, critical은 evaluator + security-auditor. **경량화는 저위험에만 적용하고 critical 게이트·임계값은 절대 낮추지 않는다** |
| **모델·effort 라우팅** | 추론이 결과를 좌우하는 단계는 Opus, 실코딩은 Sonnet, 체크리스트성 QA는 Haiku. `config/models.json` 단일 출처 + model-tiering 프로브가 역전·드리프트 탐지 |

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
- 세션 컨텍스트(브랜치, phase, 미완료 기능, 이전 세션 handoff) 주입 시작

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

### 핵심 게이트

- **Plan 게이트** — Sprint Contract(acceptance / security / error criteria + 체크포인트 태스크)는 사용자가 ExitPlanMode로 승인해야 `agreed: true`가 된다. 승인 없이는 구현을 시작하지 않는다.
- **Evaluator 게이트** — 5개 점수가 모두 임계값(기본 7) 이상이어야 통과. 채점은 이 세션에서 **직접 실행한** 테스트 결과를 근거로 한다. `passes` 전환은 evaluator-feedback 레코드가 뒷받침해야 하며, SubagentStop 훅이 남긴 실행 로그와 시간창으로 대조된다(INV-11).
- **Phase 게이트** — `progress/phase-gate.json`의 criteria가 모두 충족되어야 다음 phase로 진입.

### 병렬 실행

- **검증 병렬** — evaluator(게이트) 통과 후 test-writer · security-auditor · qa-reviewer는 서로 독립이므로 한 메시지에서 동시 디스패치한다. 이 중 파일을 생성하는 에이전트는 별도 worktree로 격리해 충돌을 막는다.
- **구현 병렬** — 서로 같은 파일을 건드리지 않는 implementation_steps가 2개 이상이면 각각 worktree implementer로 병렬 디스패치 → 병합(요약 → 충돌 확인 → 전체 테스트) → **독립 evaluator 1회 판정**. 단일·의존 태스크는 직렬.
- **위임 상한** — 직접 몇 번의 도구 호출로 끝날 작업, 한 태스크를 잘게 쪼갠 병렬, 자기 작업 재확인 목적의 위임은 하지 않는다. 단 **독립 evaluator 판정과 critical 2차 판정은 예외** — 이는 모델의 자기검증이 아니라 별도 컨텍스트에서 수행하는 조직적 통제(INV-1)다.

## 구성 요소

### Agents (8개)

| Agent | Phase | 역할 | 모델 | effort |
|-------|-------|------|------|--------|
| `spec-writer` | 1. 기획 | 인터뷰 브리프 → SPEC.md + acceptance criteria (미해결 항목은 `open_questions` 반환) | Sonnet 5 | medium |
| `architect` | 2. 설계 | 아키텍처 + 위협 모델링(STRIDE) + SECURITY-CHECKLIST + ADR | **Opus 5** | high |
| `implementer` | 3. 구현 | TDD(RED-GREEN-REFACTOR) 구현 + 보안 셀프체크 + 실행 evidence | **Opus 5** | xhigh |
| `evaluator` | 게이트 | 5차원 품질 평가 (min-of-5, 점수 앵커, unverified 상한) | **Opus 5** | xhigh |
| `test-writer` | 4. 검증 | 통합/E2E/보안 테스트 (worktree 격리로 병렬 실행) | Sonnet 5 | medium |
| `security-auditor` | 4. 검증 | 보안 감사 + supply chain + 위협 모델 대비 검증 | **Opus 5** | xhigh |
| `qa-reviewer` | 4. 검증 | 크로스 기능 통합 QA (사용자 관점) | Haiku 4.5 | (미지정) |
| `deploy-operator` | 5. 배포 | 배포 전 검증 → staging → canary → prod, 자동 롤백 | Sonnet 5 | medium |

**모델·effort 라우팅** — 축은 둘입니다: **model**(누구를 쓰는가)과 **effort**(얼마나 생각하는가). 두 축 모두 `config/models.json`이 단일 출처이며, `agents/*.md` frontmatter의 `model`은 여기와 일치해야 합니다(불일치·능력 역전·미등록은 `scripts/probes/model-tiering.sh`가 정적 탐지).

- **Opus 5** (`claude-opus-5`) — 추론 품질이 결과를 좌우하는 단계: 설계, 품질 게이트, 에이전틱 코딩, 보안 감사.
- **Sonnet 5** (`claude-sonnet-5`) — 실코딩성·안전 마진이 필요한 단계: 스펙, 테스트 작성, 배포.
- **Haiku 4.5** (`claude-haiku-4-5`) — 체크리스트성 크로스 기능 QA.
- **게이트 역할의 effort는 implementer보다 낮을 수 없습니다** — model 축의 역전 금지 규칙을 effort 축에 대칭 적용하며 프로브가 검사합니다.
- **effort는 frontmatter에 선언하지 않습니다.** 플러그인 서브에이전트에서 적용되는지 규명하지 못했고(같은 계층의 `isolation`은 미적용으로 실증됨), 적용되지 않을 수 있는 선언은 거짓 보증이기 때문입니다. `config/models.json`이 단일 출처이자 설계 문서 역할을 합니다.
- **security-auditor의 알려진 위험** — Opus 5는 강화된 사이버보안 안전장치로 **방어 목적 감사도 refusal될 수 있습니다.** 이 위험을 인지한 상태에서 최신 추론 능력을 우선해 격상했고, refusal로 인한 빈 산출은 `audit-integrity` 프로브가 정상 통과와 구분해 탐지합니다. 권장 폴백은 `claude-opus-4-8`입니다 ([ADR-007](docs/DECISIONS/ADR-007-security-auditor-model-policy.md)).

phase별 **선언 단가**(per-1M)는 `scripts/cost-report.sh`로 확인할 수 있습니다 — 읽기 전용이며, 실제 청구가 아니라 config에 선언된 값입니다.

```bash
scripts/cost-report.sh                                       # phase별 단가 표
scripts/cost-report.sh --json                                # JSON
scripts/cost-report.sh --tokens-in 50000 --tokens-out 8000   # 1회 호출 비용 추정
```

**서브에이전트 제약** — 서브에이전트는 사용자에게 질문(AskUserQuestion)할 수 없습니다. 사용자 입력이 필요한 결정(인터뷰, 승인)은 메인 루프가 디스패치 전에 수집해 프롬프트로 전달합니다.

### Skills (11개)

| Skill | 설명 |
|-------|------|
| `/brainstorm` | 코드/스펙 전 소크라테스식 설계 정제 — 대안 비교, `docs/brainstorms/` 산출 (Phase 0.5) |
| `/change-request` | 기능 추가/변경/삭제 시 산출물 연쇄 업데이트 + 의존성 영향 분석 |
| `/implement` | Sprint Contract → Plan 게이트 → 체크포인트 태스크 TDD 구현 → evaluator 검증 |
| `/hotfix` | 경량 긴급 수정 — **실패 재현 테스트 먼저**, 3파일 이하, 비보안 |
| `/debug` | 원인 불명 버그의 4단계 디버깅: 재현 고정 → 근본원인 추적 → 최소 수정 → 회귀 테스트 |
| `/finish-branch` | 브랜치 마무리: 전체 테스트 → drift 확인 → PR 생성 / 로컬 머지 / 보류 |
| `/improve` | 자기개선 루프 1회전 — 진단 프로브 → 후보 → 기존 게이트 오케스트레이션 (`--auto N`으로 배치 승인 무인 반복) |
| `/plan-review` | (iac 프로파일) terraform plan diff 리뷰 게이트 — 정책·smoke·drift |
| `/rollout` | (ops 프로파일) 라이브 k8s 변경 안전 루프 — 관측 → 승인 → 롤백 준비 → health |
| `/progress` | 진행 대시보드(phase, 기능, 최근 피드백) + 다음 액션 제안 |
| `/sync-docs` | 코드-문서 drift 감지 (`--deep`: 1M 컨텍스트 전수 교차 검사) |

자연어로 말해도 됩니다 — CLAUDE.md의 라우팅 테이블이 의도를 분기합니다:
"왜 안 되지?" → `/debug` · "구현해줘" → `/implement` · "작업 끝났어" → `/finish-branch`

> 라우팅 표는 각 스킬의 `description` TRIGGER 문구와 의도적으로 중복됩니다 — 근거는 [ADR-008](docs/DECISIONS/ADR-008-routing-duplication-tradeoff.md).
>
> 프로세스 방법론(brainstorm / TDD / debug / finish-branch)은 [obra/superpowers](https://github.com/obra/superpowers)에서 선택적으로 채택했습니다. inline self-review는 독립 evaluator를 유지하기 위해 의도적으로 채택하지 않았습니다 — 근거는 [ADR-003](docs/DECISIONS/ADR-003-superpowers-adoption.md).

### Hooks (11개)

plugin 설치 시 `hooks/hooks.json`으로 **네이티브 등록**됩니다 — settings.json 수정이 필요 없습니다.

| Event | Hook | 동작 |
|-------|------|------|
| SessionStart | `setup-claudemd.sh` | rules 복사·갱신, CLAUDE.md 섹션 세팅(멱등), 버전 업그레이드 마이그레이션, 프로파일 섹션 주입 |
| SessionStart | `session-context.sh` | 브랜치·phase·미완료 기능·handoff·최근 evaluator 피드백 주입 + agent-comms 아카이빙 |
| PreToolUse (Bash) | `pre-bash-firewall.sh` | 파괴적 명령 **deny** / 위험·시크릿유출·검증파일쓰기 **ask** / 그 외 **자동 통과(default-allow)** |
| PreToolUse (Edit\|Write\|MultiEdit) | `invariant-guard.sh` | 검증 장치 약화(임계값 하향·deny 삭제·테스트 삭제·allow 계층 확장) 차단 + 정당한 편집에 무결성 티켓 발급 |
| PreToolUse (WebFetch\|WebSearch\|NotebookRead\|MCP) | `pre-tool-firewall.sh` | 읽기 전용 도구 **자동 허용** / MCP write·업로드·미분류 도구는 네이티브 프롬프트 |
| PostToolUse (Write\|Edit\|MultiEdit) | `post-edit-format.sh` | 자동 포맷팅 (gofmt, prettier, swiftformat, ktlint, dart 등) |
| PostToolUse (Bash) | `protected-integrity.sh` | Bash 실행 **후** 보호 파일이 HEAD와 달라졌는지 검사 → 티켓 없는 변경은 격리 보관 후 복구 |
| Stop | `pre-commit-gate.sh` | 변경 언어별 테스트 + 커버리지 기록 + 시크릿 스캔 (동일 트리 재실행 skip 캐시) |
| Stop | `session-handoff.sh` | 세션 상태 저장 (draft 병합 → 다음 세션 주입) |
| PreCompact | `pre-compact.sh` | 컨텍스트 컴팩션 직전 세션 상태 스냅샷 + 미기록 결정·블로커 기록 유도 (게이트 아님 · 컴팩션 미차단) |
| SubagentStop (evaluator) | `subagent-evaluator-log.sh` | evaluator 서브에이전트 실행을 `evaluator-runs.jsonl`에 기록 — INV-11이 `passes` 전환 시 '실제 evaluator 실행'을 시간창으로 대조 (순수 기록 · 비차단) |

> `hooks/lib.sh`는 이벤트 훅이 아니라 위 훅들이 공유하는 라이브러리입니다 (`cfg_get` · `version_lt` · `harness_cd` · handoff 스냅샷).

#### Bash firewall — 계층 구조

우선순위는 **deny → 우회 탐지 → ask → default-allow** 순서로 고정되어 있습니다. allow 계층은 항상 마지막이며, 위험 정의를 앞지를 수 없습니다(INV-9).

| 계층 | 판정 | 대상 |
|------|------|------|
| **Layer 1** — 파괴적 명령 | `deny` | 루트/홈/시스템 디렉토리 `rm`, `mkfs`, fork bomb, 테이블 삭제 SQL, pipe-to-shell 등 복구 불가 |
| **Layer 2** — 우회 탐지 | `deny` | 명령 치환·백틱·리다이렉트·`eval` 경유로 Layer 1을 우회하려는 간접 표기 |
| **Layer 3** — 위험하지만 정상 사용 가능 | `ask` | **하네스 자기보호**(검증 파일 쓰기), **시크릿 egress**, `terraform destroy` · `kubectl delete` · `helm uninstall` 등 |
| **Layer 3.3** — 컨트롤 플레인 삭제 | `ask` | 문자열 앵커가 아니라 **경로 토큰**으로 판정 — 훅·설정 디렉토리 삭제 시도 |
| **Layer 3.4** — 순수 읽기 면제 | (면제) | 보호 경로를 **읽기만** 하는 명령은 ask에서 제외 (읽기 마찰 제거) |
| **Layer 3.5** — 데이터 플레인 게이트 | (면제/유지) | git 추적되어 사후 복구가 가능한 경로는 예측 대신 탐지에 맡기고, 복구 불가능한 컨트롤 플레인만 예측으로 지킨다 |
| **Layer 4** — default-allow | `allow` | 위 어디에도 걸리지 않은 **나머지 모든 명령을 무프롬프트 통과** |

- **자기보호의 범위** — `harness-config.json` · `hooks/*` · `tests/*` · `INVARIANTS.md` 등 검증 파일 쓰기는 cp/mv/리다이렉트뿐 아니라 인터프리터(`python3 -c`) · 에디터(`vim`) · `git -c core.hooksPath` · `GIT_CONFIG_*` 경유까지 포함합니다.
- **시크릿 egress** — `curl` / `nc` / `scp`가 `~/.ssh` · `~/.aws` · 개인키를 외부로 전송하려 하면 ask.
- **default-allow의 실제 의미** — `python` · `node` · `git push` · `npm install` · `docker build` · `find` · `sed -i` 같은 일반 개발 명령은 확인 없이 실행됩니다. `harness-config.json`의 `firewall.auto_allow`(기본 `true`)로 **allow 계층만** on/off할 수 있고, deny/ask는 이 값과 무관하게 항상 유지됩니다.
- **사용자 override로 allow에 편입된 항목** — `git push --force` · `git reset --hard` · `git clean -f` · `git checkout --force` 4개는 원래 deny/ask였으나 사용자가 위험을 명시적으로 수용해 무프롬프트로 전환했습니다. **이 4개에는 다른 ask 항목과 달리 사후 탐지·복구가 없습니다** — 상세와 되돌리는 방법은 [INVARIANTS.md INV-15](docs/INVARIANTS.md) 및 `hooks/pre-bash-firewall.sh`의 F74 tombstone 주석을 참조하세요.

#### 크로스도구 권한 (`pre-tool-firewall.sh`)

Bash 밖의 도구도 **읽기 전용이면 무프롬프트**입니다 ([ADR-005](docs/DECISIONS/ADR-005-cross-tool-permission-tier.md)).

- 자동 허용: `WebFetch` · `WebSearch` · `NotebookRead`, 그리고 MCP 도구 중 read-verb (`get` `list` `search` `read` `fetch` `view` `describe` `query` `find` `show` `inspect` `count` `download` `suggest` `resolve` `preview` `check` `status` `explain`).
- 프롬프트: MCP write-verb(`create` `update` `delete` `send` `upload` 등), `file_upload` 계열, 그리고 **미분류·미지 verb**.
- Bash와 반대로 **화이트리스트 모델**입니다 — MCP는 한 번의 호출이 곧 액션(메일 전송·이벤트 삭제)이라 인자로 위험을 판별할 수 없기 때문입니다. 목록 누락은 오허용이 아니라 프롬프트로 떨어집니다.
- `firewall.auto_allow_tools`(기본 `true`)로 on/off. `false`로 꺼도 위험 도구는 프롬프트가 유지됩니다.

#### 무결성 — 예측과 탐지의 이중화

`invariant-guard.sh`(사전 예측)와 `protected-integrity.sh`(사후 탐지)는 짝으로 동작합니다.

1. Edit/Write가 보호 파일을 건드리면 `invariant-guard`가 편집 결과를 시뮬레이션해 불변식 위반을 판정하고, 통과시킬 때 `<sha> <경로>` 형태의 **무결성 티켓**을 남깁니다.
2. Bash 실행 후 `protected-integrity`가 보호 파일이 HEAD와 달라졌는지 확인합니다. 현재 내용 해시가 티켓과 일치하면 통과시키고 **그 티켓을 소비**합니다(경로만 기록하면 정당한 편집 한 번이 그 경로를 영구 면제로 만들기 때문).
3. 티켓 없는 변경은 **격리 보관 후 복구**합니다. 다만 merge · rebase · cherry-pick · revert · bisect 진행 중이면 워킹트리가 HEAD와 다른 것이 정상이므로 **복구하지 않고 보고만** 합니다 — 복구가 사용자의 작업을 파괴하지 않도록.
4. **도구가 없으면 fail-closed** — `jq` 또는 `awk`가 없어 편집 내용을 판정할 수 없으면 보호 파일 편집을 차단합니다(비보호 파일은 통과시켜 가용성 유지).

이 이중화의 근거는 명확합니다: "이 명령이 보호 파일을 쓸 것인가"는 실행 없이 답할 수 없는 질문이고(셸도, 셸이 부르는 도구도 튜링 완전), 실제로 표기 열거 방식은 10회전에 걸쳐 매번 새로운 우회를 만들어냈습니다. 반면 "파일이 바뀌었는가"는 사후에 자명하며 도구·표기와 무관합니다 (INV-14).

### Rules (11개)

Path-scoped 규칙 — 해당 파일 작업 시에만 로드됩니다:

`general` · `go-backend` · `react-frontend` · `k8s-infra` · `proto-api` · `ios-swift` · `android-kotlin` · `react-native` · `flutter-dart` · `spring-boot` · `unity3d`

### Lifecycle Profiles (3개)

모든 프로젝트가 "스펙 → 구현 → 검증" SDLC를 따르지는 않습니다. 프로파일은 **검증 게이트를 그 라이프사이클에 맞는 것으로 교체**하되, 게이트 자체를 제거하지는 않습니다(INV-8).

| Profile | 라이프사이클 | 게이트 | 핵심 스킬 |
|---------|-------------|--------|----------|
| `sdlc` (기본) | 기획 → 설계 → 구현 → 검증 → 배포 | evaluator (min-of-5) | `/implement` |
| `iac` | terraform plan → 리뷰 → apply → state 확인 | plan diff 리뷰 | `/plan-review` |
| `ops` | 관측 → 진단 → 조치 → 검증 | health + 회귀 | `/rollout` |

`progress/harness-config.json`에서 선택합니다. 한 repo가 여러 라이프사이클을 겸하면 배열로 동시 적용할 수 있고, 해당 워크플로우 섹션들이 CLAUDE.md에 연결 주입됩니다.

```json
{ "profiles": ["iac", "ops"] }
```

미지정·알 수 없는 값·파일 부재는 모두 `sdlc`로 폴백합니다.

## 불변식 (INVARIANTS)

검증 장치를 약화시키는 편집을 **기계적으로** 차단합니다. 전문은 [docs/INVARIANTS.md](docs/INVARIANTS.md), 집행은 `hooks/invariant-guard.sh`(사전) + `hooks/protected-integrity.sh`(사후) + `tests/invariant-guard.bats`(회귀 148건).

| # | 불변식 |
|---|--------|
| INV-1 | Evaluator 독립성 — implementer는 자기 작업의 `passes`를 바꿀 수 없다 |
| INV-2 | min-of-5 채점 — 종합 점수는 5차원의 최솟값이며 평균으로 대체할 수 없다 |
| INV-3 | 임계값은 하향·제거 불가 |
| INV-4 | `security_tier: critical`은 보안 점수 7 미만 시 자동 fail |
| INV-5 | Firewall deny 목록은 add-only (예외는 INV-15) |
| INV-6 | 테스트·기준은 add-only — 삭제로 게이트를 통과시킬 수 없다 |
| INV-7 | 안전장치 자기 보호 — 가드가 자신을 무력화하는 편집을 막는다 |
| INV-8 | 프로파일은 검증을 **교체**할 뿐 제거하지 않는다 |
| INV-9 | Firewall allow 계층은 deny/ask 이후에만 평가된다 (위험 정의 우선) |
| INV-10 | 도구 방화벽 allow 계층은 add-only (확장 불가) |
| INV-11 | `passes` 전환은 evaluator-feedback 근거 필수 (기계 검증) |
| INV-12 | 검증 장치·critical 후보는 무인 실행 불가 |
| INV-13 | 설치 경로(plugin / bootstrapper) 간 훅 배선은 대칭이다 |
| INV-14 | 검증 장치는 예측이 아니라 탐지·복구로 지킨다 |
| INV-15 | Layer 1(BLOCKED)도 사용자 override로 개별 제거될 수 있다 — 단, 사후 복구는 없다 |

## 자기개선 루프

harness는 자신의 결함을 스스로 진단합니다. `/improve` 한 번이 아래를 순서대로 실행합니다: **진단 프로브 → 후보 우선순위화 → 불변식 가드 체크 → 기존 게이트로 1건 처리 → 회전 결과 기록**. 새 게이트를 만들지 않고 이미 검증된 절차(`/change-request` → Plan → evaluator → `/finish-branch`)를 엮을 뿐입니다.

### 진단 프로브 (9개)

`scripts/probes/run-all.sh`가 9개 출력을 병합하고, 이미 `feature_list.json`이나 handoff backlog에 있는 항목을 제거한 뒤 남은 후보에 임시 id를 부여합니다. 모두 **읽기 전용**이며 도구 부재 시 graceful degrade합니다.

| Probe | 무엇을 찾는가 |
|-------|--------------|
| `consistency` | 매니페스트 버전 불일치, plugin.json의 구성요소 claim vs 실제 수, 스킬 라우팅 동기화, 산문 속 숫자와 실측의 차이 |
| `completeness` | "무엇이 빠졌나" — 테스트 없는 이벤트 훅, TRIGGER 없는 스킬, 참조되지만 없는 파일, evaluator가 남긴 후속 작업 |
| `metrics` | bats 테스트 수·shellcheck 경고 추이 + KPI(first-pass rate, 평균 반복 횟수, 게이트 차단 수, 방화벽 결정 분포)를 `progress/metrics-history.json`에 축적하고 **악화**를 후보화 |
| `self-review` | hooks/scripts의 FIXME·TODO·XXX·HACK 주석 + shellcheck 경고 |
| `model-tiering` | `config/models.json` ↔ `agents/*.md` frontmatter의 model 드리프트, 능력·비용 역전, 미등록 effort 값 |
| `evidence` | 'Evidence over claims' 집행 — 최신 evaluator 판정이 pass인데 실행 근거를 기록하지 않았으면 후보 |
| `behavioral` | 정적 검사가 못 보는 **행위** 결함 — 위험 명령/도구 코퍼스를 실제 훅에 stdin으로 주입해 `allow`가 새는지 관찰 (명령은 실행되지 않고 훅의 판정만 파싱) |
| `calibration` | evaluator 판정 자체의 산술·일관성 결함 + golden-set 대비 점수 분포 이탈 |
| `audit-integrity` | security-auditor가 refusal로 남긴 빈 산출을 "감사했는데 이슈 없음"과 구분 |

### 무인 배치 모드 (`/improve --auto N`)

배치 승인 1회로 N회전을 무인 반복합니다 ([ADR-006](docs/DECISIONS/ADR-006-batch-approval-autonomy.md)). 단 **critical 티어 후보와 불변식·firewall·guard를 건드리는 후보는 절대 무인 처리하지 않습니다** — `progress/approval-queue.json`에 사람 승인 큐로 격리됩니다(INV-12). 무인은 저위험 후보에만 적용되고 게이트는 약화되지 않습니다.

### Evaluator 보정 코퍼스

단일 judge 1회 호출에 게이트 신뢰도가 걸려 있으므로, 판정 자체를 보정합니다.

- `evals/calibration/golden-set.json` — 과거 판정 61건에서 재생성한 기준 코퍼스. `scripts/build-golden-set.sh`로 결정적으로 재생성하며, evidence 원문은 담지 않고 유무만 남깁니다(판정 기록에 명령어·경로·출력이 들어 있어 코퍼스가 유출 경로가 되지 않도록).
- `evals/calibration/false-positives.json` — evaluator가 통과시켰지만 실제로는 버그였던 사례. 이후 채점을 보정합니다.

### 실패에서 배우기

| 실패 패턴 | 해결 위치 |
|----------|----------|
| 반복되는 코딩 실수 | `.claude/rules/`에 규칙 추가, `progress/lessons.md`에 교훈 축적 |
| evaluator 오판 (통과시켰는데 버그) | `evals/calibration/false-positives.json`에 기록 → 이후 채점 보정 |
| 위험 명령어 통과 | `pre-bash-firewall.sh`에 패턴 추가 (bats 테스트와 함께) |
| 포맷팅 누락 | `post-edit-format.sh`에 케이스 추가 |
| 반복 참조하는 절차 | `.claude/skills/`에 스킬 추가 |
| 컨텍스트 오염 | sub-agent로 작업 격리, 세션 간 인계는 handoff가 담당 |

> 이 저장소 자체가 하네스의 첫 사용자입니다 — cc-harness의 모든 기능은 cc-harness의 워크플로우(change-request → Plan 게이트 → 구현 → 독립 evaluator)를 거쳐 들어왔고, 판정 기록이 `progress/agent-comms/`에 남아 있습니다.

## 자동으로 작동하는 것들

`claude` 실행만 하면 아래가 **전부 자동**입니다:

| 이벤트 | 동작 |
|--------|------|
| 세션 시작 | 브랜치, phase, 미완료 기능, 이전 세션 handoff, 마지막 evaluator 피드백 주입 |
| 코드 편집 | 언어별 포맷터 자동 실행 + 검증 장치를 약화시키는 편집 차단 |
| Bash 실행 | 파괴적 명령 deny / 위험·시크릿유출·검증파일쓰기 ask / 그 외 자동 통과(무프롬프트) |
| Bash 실행 후 | 보호 파일 무결성 검사 → 심사받지 않은 변경은 격리 보관 후 복구 |
| WebFetch·MCP 실행 | 읽기 전용 도구 자동 허용 / MCP write·업로드는 프롬프트 |
| 컴팩션 직전 | 세션 상태 스냅샷 + 미기록 결정·블로커 기록 유도 |
| 세션 종료 | 변경 파일 언어별 테스트 + 커버리지 기록(`progress/coverage-report.json`) + 시크릿 스캔, 상태 저장 |
| plugin 업데이트 | 버전 감지 → 마이그레이션 + 미수정 rules 자동 갱신 (수정본 보존) |

## 업그레이드

plugin 업데이트(`/plugin` → Installed) 후 **첫 세션에서 자동 마이그레이션**됩니다:

- `.claude/.cc-harness-installed`의 설치 버전과 비교 — 같으면 아무 작업도 하지 않습니다 (세션 비용 0)
- rules는 sha256 manifest로 pristine 판별 — **수정하지 않은 파일만** 새 버전으로 갱신하고, 수정본은 보존 + 안내
- v1.4 이하에서 복사된 `.claude/agents|skills|hooks` 중복본은 자동 정리 (과거 릴리스 해시로 pristine 식별, 커스터마이징은 보존)
- `{이전} → {새 버전}` 전환 내역을 세션 시작 시 출력

상세: [ADR-002 (versioned upgrade)](docs/DECISIONS/ADR-002-versioned-upgrade.md), [ADR-001 (plugin-native loading)](docs/DECISIONS/ADR-001-plugin-native-loading.md)

## Plugin vs Bootstrapper

| | Plugin (`/plugin install`) | Bootstrapper (`npx cc-harness`) |
|---|---|---|
| **agents** (8) / **skills** (11) / **hooks** (11) | O — 네이티브 로딩 (업데이트 즉시 반영) | O — `.claude/` 복사 |
| **rules** (11) | O — `.claude/rules/` 복사 | O — 프리셋 기반 선택 |
| settings.json | 불필요 (hooks.json 네이티브) | O |
| progress/ · docs/ · evals/ · Makefile · CLAUDE.md 스캐폴딩 | CLAUDE.md 섹션만 | O |
| 프리셋 선택 | - | O |

**Plugin** — 기존 프로젝트에 즉시 적용, 업데이트 자동 전파. **Bootstrapper** — 새 프로젝트 전체 스캐폴딩.

> 두 설치 경로의 훅 배선은 **대칭이어야 합니다**(INV-13) — 한쪽에만 훅이 배선되면 그 경로의 사용자는 게이트 없이 일하게 되기 때문이며, `tests/hook-wiring-parity.bats`가 이를 기계 검증합니다.

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

### 채점 임계값 · 정책 조정

`progress/harness-config.json`:

```json
{
  "scoring": {
    "pass_threshold": 7,
    "max_iterations": 5,
    "score_method": "min_of_5",
    "security_thresholds": { "critical": 7, "standard": 5, "low": 3 }
  },
  "hotfix": {
    "max_files": 3,
    "consecutive_limit": 3,
    "allowed_security_tiers": ["low", "standard"]
  },
  "agent_comms": { "max_files_per_type": 10, "archive_enabled": true },
  "firewall": { "auto_allow": true, "auto_allow_tools": true }
}
```

> **임계값은 상향만 가능합니다.** `pass_threshold`나 `security_thresholds`를 낮추거나 `score_method`를 평균으로 바꾸는 편집은 `invariant-guard.sh`가 차단합니다(INV-2, INV-3). 마찬가지로 방화벽 deny/ask 목록 축소, 테스트 삭제도 차단됩니다(INV-5, INV-6).

## 개발

```bash
bats tests/                              # 전체 테스트 (778건)
bats tests/pre-bash-firewall.bats        # 개별 파일
shellcheck hooks/*.sh scripts/probes/*.sh init.sh
bash scripts/probes/run-all.sh "$(date -Iseconds)"     # 진단 프로브 전체
bash scripts/verify-caller-copy-guard.sh               # 사본 가드 mutation 배터리
```

CI(`.github/workflows/ci.yml`)가 강제하는 것:

1. **ShellCheck** — 모든 훅·프로브·스크립트·`init.sh`
2. **JSON 검증** — 매니페스트와 템플릿 전부
3. **버전 정합** — `package.json` · `.claude-plugin/plugin.json` · `.claude-plugin/marketplace.json`의 버전이 동일해야 함
4. **bats 778건** — `jq` 설치를 명시적으로 보증합니다. `jq`가 없으면 invariant-guard가 fail-closed로 떨어져 기계 검증이 무력화되기 때문입니다.
5. **mutation 배터리** — 사본 가드가 실제로 드리프트를 잡는지 확인합니다. bats가 전부 초록인데도 가드가 약해진 회귀가 실제로 있었기 때문에 상설로 둡니다.

## 설계 결정 (ADRs)

| ADR | 결정 |
|-----|------|
| [ADR-001](docs/DECISIONS/ADR-001-plugin-native-loading.md) | agents/skills/hooks 복사 → plugin 네이티브 로딩 (이중 등록 제거) |
| [ADR-002](docs/DECISIONS/ADR-002-versioned-upgrade.md) | 버전 기록 + hash manifest 기반 업그레이드 프로세스 |
| [ADR-003](docs/DECISIONS/ADR-003-superpowers-adoption.md) | superpowers 방법론 선택적 채택 — 독립 evaluator는 유지 |
| [ADR-004](docs/DECISIONS/ADR-004-firewall-auto-allow.md) | Bash firewall default-allow — 위험만 게이트, 나머지 무프롬프트 |
| [ADR-005](docs/DECISIONS/ADR-005-cross-tool-permission-tier.md) | 크로스도구 권한 계층 — 읽기전용 도구 auto-allow, MCP write 게이트 |
| [ADR-006](docs/DECISIONS/ADR-006-batch-approval-autonomy.md) | 배치 승인 무인 자기개선 루프 (`/improve --auto`) |
| [ADR-007](docs/DECISIONS/ADR-007-security-auditor-model-policy.md) | security-auditor Opus 5 격상과 refusal 관측 |
| [ADR-008](docs/DECISIONS/ADR-008-routing-duplication-tradeoff.md) | CLAUDE.md 라우팅 표를 스킬 TRIGGER와의 중복에도 불구하고 유지 |

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

- `git` — 프로젝트가 git repository여야 합니다 (무결성 복구가 HEAD 비교에 의존)
- `jq` — **사실상 필수.** 없으면 Bash 방화벽이 비활성화되고(경고 출력), 세션 컨텍스트 주입이 축소되며, invariant-guard는 보호 파일 편집을 **fail-closed로 차단**합니다
- `awk` — invariant-guard의 편집 시뮬레이션에 필요. 없거나 실패하면 `jq`와 대칭으로 fail-closed
- `bash` 3.2+ (hooks), 4.0+ (bootstrapper)
- 각 언어 도구 (선택 — 없으면 해당 hook이 graceful skip)
- 개발 시: `bats`, `shellcheck`

## License

MIT
