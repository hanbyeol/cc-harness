# cc-harness 실전 가이드

이 문서는 cc-harness를 활용한 개발 전과정(기획 → 설계 → 구현 → 검증 → 배포)의 실전 가이드입니다.

> **이 파일은 harness 업데이트 시 자동으로 최신 버전으로 교체됩니다.**
> 프로젝트 고유 가이드는 별도 파일에 작성하세요.

---

## 목차

1. [시작하기](#1-시작하기)
2. [Phase 1: 기획 (Specification)](#2-phase-1-기획-specification)
3. [Phase 2: 설계 (Architecture)](#3-phase-2-설계-architecture)
4. [Phase 3: 구현 (Implementation)](#4-phase-3-구현-implementation)
5. [Phase 4: 검증 (Verification)](#5-phase-4-검증-verification)
6. [Phase 5: 배포 (Deployment)](#6-phase-5-배포-deployment)
7. [일상 워크플로우](#7-일상-워크플로우)
8. [Skills 활용법](#8-skills-활용법)
9. [커스터마이징](#9-커스터마이징)
10. [트러블슈팅](#10-트러블슈팅)

---

## 1. 시작하기

### harness 설치 후 첫 세션

```bash
claude
```

세션 시작 시 자동으로 현재 상태가 출력됩니다:

```
=== Session Context ===
Branch: main | Phase: init (iteration 0) | Features: 0/0 passed
Last: abc1234 chore: initialize SDLC harness

=== Suggested Next Action ===
Phase 1 시작: spec-writer agent로 SPEC.md 작성
  → "SPEC.md를 작성해줘. 상세 인터뷰부터 시작해."
```

이 안내를 따라가면 됩니다.

### 핵심 원칙

- **코드부터 작성하지 않는다** — 기능 요청 시 산출물(SPEC, criteria) 업데이트가 먼저
- **Evaluator만 passes: true를 설정한다** — 구현자가 자체 통과 판정을 내리지 않음
- **기준 갭은 즉시 보완한다** — 구현 중 발견한 누락 기준은 미루지 않고 즉시 반영

### 진행 상태 확인

언제든 현재 상태를 확인하려면:

```
/progress
```

또는 자연어로:

```
현재 어디까지 진행됐어?
다음에 뭐 해야 돼?
```

---

## 2. Phase 1: 기획 (Specification)

### 목표

사용자 요구사항을 **테스트 가능한 스펙**으로 변환합니다.

### 실행 방법

```
SPEC.md를 작성해줘. AskUserQuestion으로 상세 인터뷰부터 시작해.
```

### spec-writer agent가 하는 일

1. **사용자 인터뷰** — AskUserQuestion으로 요구사항 상세 파악
2. **docs/SPEC.md 작성** — 기능 요구사항 + 보안 요구사항 + 에러 시나리오
3. **progress/feature_list.json 생성** — 각 기능에 security_tier 태깅
4. **evals/acceptance-criteria.json 생성** — 기능별 인수 조건

### 산출물 예시

```
docs/SPEC.md                    ← 요구사항 문서
progress/feature_list.json      ← F1, F2, ... 기능 목록
evals/acceptance-criteria.json  ← 기능별 pass/fail 기준
```

### 체크포인트

Phase 1이 완료되려면:

- [ ] SPEC.md에 모든 기능 요구사항이 문서화됨
- [ ] 각 기능에 보안 요구사항이 명시됨
- [ ] feature_list.json에 security_tier가 태깅됨 (critical/standard/low)
- [ ] acceptance-criteria.json에 정상/보안/에러 기준이 포함됨
- [ ] 사용자가 스펙을 승인함

### 팁

- "결제 기능 추가해줘" 같은 모호한 요청 → agent가 자동으로 상세 질문
- 보안 요구사항 누락 시 agent가 확인 질문을 함 (예: 인증 방식, 데이터 분류)
- 기능이 많으면 우선순위를 정해달라고 요청하세요

---

## 3. Phase 2: 설계 (Architecture)

### 목표

스펙을 기반으로 **시스템 구조 + 위협 모델 + 보안 체크리스트**를 설계합니다.

### 실행 방법

```
SPEC.md 기반으로 아키텍처를 설계해줘. ARCHITECTURE.md와 SECURITY-CHECKLIST.md 작성해.
```

### architect agent가 하는 일

1. SPEC.md를 읽고 시스템 구조 설계
2. **docs/ARCHITECTURE.md** 작성 — 컴포넌트, API, 데이터 모델, 시퀀스 다이어그램
3. **docs/SECURITY-CHECKLIST.md** 생성 — 기능별 보안 체크 항목
4. **docs/DECISIONS/** — 주요 설계 결정을 ADR로 기록
5. 위협 모델링 (STRIDE 기반)

### 산출물 예시

```
docs/ARCHITECTURE.md            ← 시스템 구조
docs/SECURITY-CHECKLIST.md      ← 보안 체크리스트
docs/API-DESIGN.md              ← API 엔드포인트 설계 (선택)
docs/DECISIONS/001-auth-jwt.md  ← 아키텍처 결정 기록
```

### 팁

- 아키텍처 다이어그램은 Mermaid 형식으로 생성됨 — 마크다운에서 바로 렌더링
- "마이크로서비스 vs 모놀리스" 같은 설계 결정은 ADR로 기록 요청
- SECURITY-CHECKLIST.md는 이후 구현/검증에서 계속 참조됨

---

## 4. Phase 3: 구현 (Implementation)

### 목표

Sprint Contract를 합의하고, 기능을 하나씩 구현합니다.

### 실행 방법 — 3가지 방식

**방법 1: 자연어로 구현 요청**

```
다음 기능을 구현해줘.
```

→ harness가 자동으로 `/implement` 스킬을 실행합니다.

**방법 2: 특정 기능 지정**

```
/implement F3
```

**방법 3: evaluator 피드백 반영 후 재구현**

```
/implement --retry
```

### 구현 흐름

```
기준 검증 → Sprint Contract 합의 → 구현 + 테스트 → Evaluator 검증 요청
```

각 단계를 상세히 설명합니다:

#### Step 1. 기준 검증

`/implement` 실행 시 자동으로 진행됩니다:

- acceptance-criteria.json의 해당 기능 기준이 **구체적이고 검증 가능**한지 확인
- 누락된 에러 시나리오, 보안 기준이 있으면 **먼저 보완** 후 진행
- 이전 evaluator 피드백에 `criteria_gaps`가 있으면 반드시 반영

#### Step 2. Sprint Contract

implementer가 Sprint Contract를 작성하고 사용자에게 확인을 요청합니다:

```json
{
  "sprint": 1,
  "features": ["F1: User Auth"],
  "security_tier": "critical",
  "acceptance_criteria": ["POST /login returns JWT on valid credentials", ...],
  "security_criteria": ["JWT secret from env, not hardcoded", ...],
  "error_scenarios": ["invalid password → 401", ...],
  "test_scenarios": ["happy path login", "SQL injection attempt", ...],
  "agreed": false
}
```

**"agreed: true"가 되어야 코드 작성을 시작합니다.**

내용을 검토하고 수정 요청이 있으면 말씀하세요. 문제 없으면:

```
contract 승인해.
```

#### Step 3. 구현 + 테스트

- 기능 코드 + 테스트 코드를 함께 작성
- security_tier: critical → 보안 테스트 필수
- **구현 중 기준 갭 발견 시 즉시 보완** (기준 역전파 원칙)

#### Step 4. Evaluator 검증 요청

구현 완료 후:

```
evaluator agent로 F1 구현 결과를 검증해줘.
Sprint Contract: progress/contracts/sprint-1.json
```

### Evaluator 결과

**통과 시:**

```
Score: 8/10 | Verdict: pass
→ feature_list.json의 F1.passes = true
```

**반려 시:**

```
Score: 5/10 | Verdict: fail
Issues:
  - [security] JWT secret 하드코딩
  - [error] 토큰 만료 시 500 반환
```

반려 시 피드백을 반영하여 재구현:

```
/implement --retry
```

### 팁

- 한 세션에 1~2개 기능만 구현 (집중도 유지)
- security_tier: critical 기능을 먼저 구현 (보안 이슈 조기 발견)
- Evaluator 점수 7/10 이상이면 통과, critical 기능은 보안 점수 7 미만이면 자동 fail

---

## 5. Phase 4: 검증 (Verification)

### 목표

구현된 코드를 **다각도로 독립 검증**합니다.

### 4가지 검증 에이전트

| Agent | 역할 | 언제 사용 |
|-------|------|-----------|
| **evaluator** | 기능별 pass/fail 판정 (5가지 점수) | 각 기능 구현 완료 후 |
| **test-writer** | 통합/E2E/보안 테스트 작성 | 주요 기능 구현 후 |
| **security-auditor** | 보안 취약점 탐지 + 체크리스트 검증 | 전체 구현 완료 후 |
| **qa-reviewer** | 사용자 관점 크로스 기능 검증 | 전체 구현 완료 후 |

### 실행 예시

```
# 개별 기능 검증
evaluator agent로 F3 검증해줘.

# 통합 테스트 작성
test-writer agent로 통합 테스트를 작성해줘. 특히 인증 플로우 E2E 테스트.

# 보안 감사
security-auditor agent로 전체 코드 보안 감사해줘.

# QA 검증
qa-reviewer agent로 사용자 시나리오 기반 QA 검증해줘.
```

### Evaluator 점수 체계

| 항목 | 설명 | 범위 |
|------|------|------|
| 기능 완성도 | acceptance criteria 충족 | 1-10 |
| 코드 품질 | 에러 핸들링, 구조 | 1-10 |
| 보안 | security_criteria + SECURITY-CHECKLIST | 1-10 |
| 에러 처리 | error_scenarios 충족 | 1-10 |
| 테스트 커버리지 | 정상 + 보안 + 에러 경로 | 1-10 |

- 종합 7/10 이상 → pass
- security_tier: critical 기능은 보안 점수 7 미만 → 자동 fail

### Evaluator의 criteria_gaps

Evaluator가 기준 자체의 문제를 발견하면 피드백에 포함됩니다:

```json
"criteria_gaps": {
  "missing_criteria": ["concurrent login 세션 제한 기준 없음"],
  "ambiguous_criteria": ["'적절한 에러 메시지' → 포맷 명시 필요"]
}
```

→ 다음 iteration에서 기준 보완을 **먼저** 진행한 후 코드를 수정합니다.

---

## 6. Phase 5: 배포 (Deployment)

### 목표

검증 완료된 코드를 staging → production으로 안전하게 배포합니다.

### 실행 방법

```
deploy-operator agent로 staging 배포해줘.
```

### 배포 전 자동 검증

deploy-operator가 자동으로 확인합니다:

- [ ] phase-gate.json → verification 완료
- [ ] feature_list.json → 대상 feature 전체 passes: true
- [ ] security-auditor → checklist_compliance.failed == 0
- [ ] qa-reviewer → verdict != "fail"

**하나라도 미충족 시 배포 거부.**

### 배포 프로세스

```
이미지 빌드 → staging 배포 → 헬스체크 + 스모크 테스트 → (통과 시) prod 배포
                                   ↓ (실패 시)
                              자동 롤백 + 실패 원인 기록
```

---

## 7. 일상 워크플로우

### 새 기능을 추가할 때

```
로그인 시 OTP 인증 기능을 추가해줘.
```

→ harness가 자동으로 `/change-request`를 실행합니다:

1. 변경 영향 분석
2. SPEC.md, acceptance-criteria.json, feature_list.json 업데이트
3. Sprint Contract 생성
4. 사용자 승인 후 구현 시작

### 기존 기능을 변경할 때

```
결제 방식을 Stripe에서 Toss로 변경해줘.
```

→ `/change-request`가 자동 실행되며:

- 기존 기능의 acceptance criteria를 diff 기반으로 갱신
- 영향받는 Sprint Contract를 갱신 (agreed: false로 리셋)
- 변경 규모에 따라 phase 롤백 판단

### 세션 간 작업 이어가기

새 세션 시작 시 자동으로 이전 세션 상태가 로드됩니다:

```
=== Previous Session Handoff ===
Completed: F1: User Auth, F2: User Profile
In Progress: F3: Dashboard
Blockers: Stripe API key 미발급
Next Actions: F3 evaluator 피드백 반영
```

이전 작업을 이어가려면:

```
이전 세션에서 하던 작업을 이어서 해줘.
```

### 문서와 코드가 안 맞을 때

```
문서 동기화 점검해줘.
```

→ `/sync-docs`가 자동 실행됩니다:

```
=== Sync Report ===
SPEC.md:
  ⚠ F7 (WebSocket 알림) — 구현됨, SPEC에 미반영
acceptance-criteria.json:
  ⚠ F7 — criteria 없음
```

---

## 8. Skills 활용법

### `/change-request {설명}`

기능의 추가/변경/삭제 시 **산출물을 연쇄 업데이트**합니다.

```
/change-request 로그인 시 OTP 인증 추가
/change-request F3 기능 삭제
/change-request 결제 플로우를 Stripe에서 Toss로 변경
```

**자동 감지**: "~~ 추가해줘", "~~ 변경해줘", "~~ 삭제해줘" → 자동 실행

### `/implement [F{n}]`

Sprint Contract부터 구현, Evaluator 검증까지 단계별로 안내합니다.

```
/implement          # 다음 미완료 기능 자동 선택
/implement F4       # 특정 기능 지정
/implement --retry  # evaluator 피드백 반영 후 재구현
```

**자동 감지**: "구현해줘", "만들어줘", "코딩 시작" → 자동 실행

### `/progress`

진행 현황 대시보드를 표시하고 다음 작업을 제안합니다.

```
/progress          # 전체 현황
/progress features # 기능별 상세
/progress phase    # phase gate 상세
/progress history  # 변경 이력
```

**자동 감지**: "어디까지 했어", "현재 상태", "다음 할 일" → 자동 실행

### `/sync-docs`

구현과 문서 간 불일치(drift)를 탐지하고 동기화합니다.

```
/sync-docs              # 전체 동기화 검사
/sync-docs spec         # SPEC.md만 검사
/sync-docs architecture # ARCHITECTURE.md만 검사
/sync-docs criteria     # acceptance-criteria.json만 검사
```

**자동 감지**: "문서 동기화", "drift 확인", "산출물 점검" → 자동 실행

---

## 9. 커스터마이징

### 언어별 규칙 추가

```bash
cat > .claude/rules/python-backend.md << 'EOF'
---
paths:
  - "services/**/*.py"
---
# Python Rules
- Type hints 필수
- pytest 사용
- 가상환경: poetry
EOF
```

### Hook 추가

`.claude/settings.json`에 추가:

```json
{
  "PreToolUse": [{
    "matcher": "Bash",
    "hooks": [{ "type": "command", "command": ".claude/hooks/my-hook.sh", "timeout": 10 }]
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

### Evaluator 보정

Evaluator가 너무 관대하거나 엄격하면:

```bash
# evals/calibration/false-positives.json에 오판 기록 추가
[
  {
    "date": "2026-03-26",
    "feature": "F3",
    "issue": "evaluator가 통과시켰으나 실제로 XSS 취약점 존재",
    "lesson": "innerHTML 사용 시 반드시 sanitize 확인"
  }
]
```

---

## 10. 트러블슈팅

### "코드부터 작성하려고 해요"

CLAUDE.md의 워크플로우가 적용되지 않는 경우:

```
기능 변경 시 CLAUDE.md의 필수 절차를 따라줘.
먼저 /change-request로 산출물부터 업데이트해.
```

### "Phase가 안 넘어가요"

```
/progress phase
```

로 미충족 criteria를 확인하고 하나씩 해결하세요.

### "Evaluator가 계속 반려해요"

1. evaluator 피드백의 `issues`를 하나씩 확인
2. `criteria_gaps`가 있으면 기준 자체를 먼저 보완
3. 5회 이상 반려되면 Sprint Contract를 재검토:

```
Sprint Contract를 다시 검토해줘. 현실적으로 달성 가능한 기준인지 확인.
```

### "세션이 끊어져서 맥락을 잃었어요"

세션 시작 시 자동으로 이전 상태가 로드됩니다. 추가로:

```
progress/claude-progress.txt와 git log를 확인하고 이전 작업을 이어서 해줘.
```

### "어떤 agent를 써야 할지 모르겠어요"

자연어로 말하면 harness가 자동으로 적절한 agent/skill을 선택합니다:

| 이렇게 말하면 | 이렇게 동작합니다 |
|-------------|-----------------|
| "기능 추가해줘" | → `/change-request` |
| "구현해줘" | → `/implement` |
| "검증해줘" | → evaluator agent |
| "보안 점검해줘" | → security-auditor agent |
| "테스트 작성해줘" | → test-writer agent |
| "배포해줘" | → deploy-operator agent |
| "현재 상태 보여줘" | → `/progress` |

### "Hook이 동작하지 않아요"

```bash
# hook 실행 권한 확인
chmod +x .claude/hooks/*.sh

# hook 단독 실행 테스트 (session-context 예시)
CLAUDE_PROJECT_DIR=$(pwd) bash .claude/hooks/session-context.sh
```

### harness 업데이트

```bash
bash init.sh --update
```

- 에이전트, 훅, 스킬, 규칙 → 최신 버전으로 교체
- SPEC.md, feature_list.json, acceptance-criteria.json → 보존
- settings.json, CLAUDE.md → diff 확인 후 선택

---

## 빠른 참조 — 전체 개발 흐름

```
 Phase 1                Phase 2              Phase 3
 ┌──────────┐          ┌──────────┐         ┌──────────────────────┐
 │ 기획      │          │ 설계      │         │ 구현                  │
 │          │          │          │         │                      │
 │ "스펙    │──완료──▶│ "아키텍처│──완료──▶│ /implement            │
 │  작성해줘"│          │  설계해줘"│         │  ├─ 기준 검증          │
 │          │          │          │         │  ├─ Sprint Contract   │
 │ 산출물:  │          │ 산출물:  │         │  ├─ 코드 + 테스트      │◀─┐
 │ SPEC.md  │          │ ARCH.md  │         │  └─ evaluator 검증    │  │
 │ features │          │ SECURITY │         │                      │  │
 │ criteria │          │ ADRs     │         │  반려 시 → 피드백 반영 │──┘
 └──────────┘          └──────────┘         └──────────────────────┘
                                                      │
                                                    완료
                                                      ▼
 Phase 5                Phase 4
 ┌──────────┐          ┌──────────────────────┐
 │ 배포      │          │ 검증                  │
 │          │          │                      │
 │ deploy-  │◀──통과──│ evaluator (기능별)     │
 │ operator │          │ test-writer (E2E)     │
 │          │          │ security-auditor (보안)│
 │ staging  │          │ qa-reviewer (통합 QA) │
 │  → prod  │          │                      │
 └──────────┘          └──────────────────────┘
```
