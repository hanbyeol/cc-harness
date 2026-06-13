# cc-harness

## Priority
Correctness > Safety > Speed

## Workflow — 기능 추가/변경/삭제 시 필수 절차
사용자가 기능 추가, 변경, 삭제를 요청하면 아래 절차를 **반드시** 따른다. 코드부터 작성하지 않는다.

### Step 1. 변경 영향 분석
- 변경 유형 분류: `add` | `modify` | `remove`
- progress/feature_list.json에서 영향받는 기능 식별
- 아키텍처 변경 필요 여부 판단

### Step 2. 산출물 업데이트 (코드 작성 전)
- docs/SPEC.md — 요구사항 반영 (보안 요구사항, 에러 시나리오 포함)
- docs/ARCHITECTURE.md — 구조 변경 시만 (API, 컴포넌트, 위협 모델)
- evals/acceptance-criteria.json — 인수 조건 추가/수정
- progress/feature_list.json — 기능 항목 추가/수정 (passes: false)

### Step 3. Sprint Contract 작성
- progress/contracts/sprint-{n}.json 작성 (`agreed: false`로 초기화)
- acceptance_criteria + security_criteria + error_scenarios 포함

### Step 3.5. Plan 게이트 — 사용자 승인
- Claude Code의 **ExitPlanMode** tool로 계획(acceptance_criteria + security_criteria + 구현 순서)을 요약 제시
- **사용자 승인 시에만** Sprint Contract의 `agreed`를 `true`로 전환
- 거부/수정 요청 시: 피드백을 반영해 Step 3의 Sprint Contract 재작성 → Plan 재제시 루프
- 승인 없이는 Step 4로 진입하지 않는다

### Step 4. 구현
- Plan 게이트 승인 후 코드 작성 시작
- 구현 + 테스트 (보안 테스트, 에러 경로 테스트 포함)
- **구현 중 기준 갭 발견 시 즉시 상위 산출물 보완**
- git commit + progress 업데이트

### Step 5. 검증 요청
- evaluator에게 검증 요청
- evaluator만 passes → true 변경 가능

## 기준 역전파 원칙 (Criteria Backpropagation)
모든 단계에서 상위 산출물(SPEC, acceptance criteria)의 누락·모호·불일치를 발견하면 즉시 보완한다.
코드만 수정하고 기준 업데이트를 미루지 않는다.

## Security & Quality by Design
- 모든 단계에서 보안과 품질을 내재화
- Evaluator 종합 점수 = 5개 점수의 최솟값 (한 영역이라도 미달 시 전체 fail)
- security_tier: critical 기능은 보안 점수 7/10 미만 시 자동 fail
- **검증 티어링**: 검증 강도를 security_tier·변경 크기에 매칭 — low/문서는 경량(hotfix류, evaluator 생략 가능),
  standard는 evaluator, critical은 full evaluator+security-auditor. **경량 경로는 저위험에만 추가하며 critical 게이트·임계값은 절대 미하향**(invariant-guard가 하향 차단)

## Generator-Evaluator Loop
- Implementer는 passes를 직접 true로 변경하지 않음
- Evaluator만 passes를 true로 변경할 수 있음
- **Evidence over claims**: 구현·디버깅·검증 모두 실행 결과를 근거로 완료를 선언한다 —
  실행하지 않은 검증을 완료로 보고하지 않는다 (implementer `evidence`, evaluator `unverified` 규칙)

## 요청 → 행동 라우팅

| 사용자 의도 | 행동 |
|-------------|------|
| 설계 탐색/아이디어 정리 (요구사항 미확정) | → `/brainstorm` 실행 |
| 기능 추가/변경/삭제 | → `/change-request` 실행 (요구사항이 모호하면 `/brainstorm` 먼저) |
| 기능 구현 | → `/implement` 실행 |
| 긴급 버그 수정 (원인 명확, 3파일 이하) | → `/hotfix` 실행 |
| 원인 불명 버그/이상 동작 | → `/debug` 실행 |
| 브랜치 마무리/PR/머지 준비 | → `/finish-branch` 실행 |
| 하네스 자기개선/진단 | → `/improve` 실행 |
| 인프라 plan 검토/apply 전 (iac 프로파일) | → `/plan-review` 실행 |
| 진행 상태 확인 | → `/progress` 실행 |
| 문서 동기화 | → `/sync-docs` 실행 |
| 스펙 작성 | → 메인 루프가 AskUserQuestion으로 인터뷰 후 **spec-writer** agent에 브리프 전달 |
| 아키텍처 설계 | → **architect** agent |
| 구현 결과 검증 | → **evaluator** agent |
| 보안 감사 | → **security-auditor** agent |
| 테스트 작성 | → **test-writer** agent |
| QA 검증 | → **qa-reviewer** agent |
| 배포 | → **deploy-operator** agent |

## Phase 기반 에이전트 가이드

| Phase | 주요 에이전트 | 전제 조건 |
|-------|--------------|-----------|
| specification | spec-writer | 메인 루프 인터뷰 완료 |
| architecture | architect | spec 완료 |
| implementation | implementer | architecture 완료, Sprint Contract 합의 |
| verification | evaluator, test-writer, security-auditor, qa-reviewer | implementation 완료 |
| deployment | deploy-operator | verification 통과 |

**verification 병렬 실행**: evaluator(게이트) 통과 후 test-writer·security-auditor·qa-reviewer는 서로 독립적이므로 **한 메시지에서 동시(병렬) 실행**한다 — 순차 실행하지 않는다.
단, test-writer는 테스트 파일을 생성하므로 **`isolation: "worktree"`로 디스패치**해 다른 에이전트와의 파일 충돌을 방지한다.

**구현 병렬 실행(서브에이전트 구동)**: Sprint Contract의 implementation_steps 중 **독립**(같은 파일 미수정·상호 의존 없음) 태스크가 2개 이상이면 각각 `isolation: "worktree"` implementer 서브에이전트로 병렬 디스패치한다. 부모는 contract를 1회 읽고 각 자식에 **task별 최소 컨텍스트만** 전달(토큰 보존), 결과를 병합(요약 검토→충돌 확인→전체 테스트)한 뒤 **독립 evaluator로 1회 판정**한다(서브에이전트는 passes를 set하지 않음). 단일/의존 태스크는 직렬 폴백.

**서브에이전트 공통 제약**: 서브에이전트는 사용자에게 질문(AskUserQuestion)할 수 없다.
사용자 입력이 필요한 결정은 메인 루프가 디스패치 전에 수집해 프롬프트로 전달한다.

## Session Handoff
작업 중 **중요 결정·블로커·다음 작업**이 생기면 `progress/session-handoff-draft.json`에 기록한다:

```json
{ "in_progress": "F3 구현 중 — handler까지 완료", "blockers": ["Stripe API key 미발급"], "next_actions": ["F3 테스트 작성"], "key_decisions": ["세션 저장소는 Redis로 결정"] }
```

세션 종료 시 Stop 훅(session-handoff.sh)이 자동 상태와 병합해 다음 세션에 주입한다.

## Skills
- `/brainstorm [주제]` — 코드/스펙 전 소크라테스식 설계 정제 (Phase 0.5)
- `/change-request {설명}` — 기능 변경/추가/삭제 시 산출물 연쇄 업데이트
- `/implement [F{n}]` — Sprint Contract → 구현 → Evaluator 검증 가이드
- `/hotfix [설명]` — 긴급 버그 수정 경량 워크플로우 (3파일 이하, 비보안, 재현 테스트 먼저)
- `/debug [증상]` — 원인 불명 버그의 4단계 근본원인 디버깅
- `/finish-branch` — 브랜치 마무리: 테스트 → drift 확인 → PR/머지/보류
- `/improve` — 자기개선 루프 1회전: 진단 프로브 → 후보 → 기존 게이트 오케스트레이션
- `/plan-review` — (iac 프로파일) terraform plan diff 리뷰 게이트 — 정책·smoke·drift 검증
- `/progress` — 진행 현황 대시보드 + 다음 작업 제안
- `/sync-docs` — 구현과 문서 간 drift 탐지 및 동기화
