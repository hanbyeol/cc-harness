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

## Generator-Evaluator Loop
- Implementer는 passes를 직접 true로 변경하지 않음
- Evaluator만 passes를 true로 변경할 수 있음

## 요청 → 행동 라우팅

| 사용자 의도 | 행동 |
|-------------|------|
| 기능 추가/변경/삭제 | → `/change-request` 실행 |
| 기능 구현 | → `/implement` 실행 |
| 긴급 버그 수정 (3파일 이하) | → `/hotfix` 실행 |
| 진행 상태 확인 | → `/progress` 실행 |
| 문서 동기화 | → `/sync-docs` 실행 |
| 스펙 작성 | → **spec-writer** agent |
| 아키텍처 설계 | → **architect** agent |
| 구현 결과 검증 | → **evaluator** agent |
| 보안 감사 | → **security-auditor** agent |
| 테스트 작성 | → **test-writer** agent |
| QA 검증 | → **qa-reviewer** agent |
| 배포 | → **deploy-operator** agent |

## Phase 기반 에이전트 가이드

| Phase | 주요 에이전트 | 전제 조건 |
|-------|--------------|-----------|
| specification | spec-writer | — |
| architecture | architect | spec 완료 |
| implementation | implementer | architecture 완료, Sprint Contract 합의 |
| verification | evaluator, test-writer, security-auditor, qa-reviewer | implementation 완료 |
| deployment | deploy-operator | verification 통과 |

## Skills
- `/change-request {설명}` — 기능 변경/추가/삭제 시 산출물 연쇄 업데이트
- `/implement [F{n}]` — Sprint Contract → 구현 → Evaluator 검증 가이드
- `/hotfix [설명]` — 긴급 버그 수정 경량 워크플로우 (3파일 이하, 비보안)
- `/progress` — 진행 현황 대시보드 + 다음 작업 제안
- `/sync-docs` — 구현과 문서 간 drift 탐지 및 동기화
