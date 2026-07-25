---
name: implement
description: "기능을 구현할 때 사용. TRIGGER: 사용자가 '구현해줘', '코딩 시작', 'implement', '만들어줘', '개발해줘', 'Sprint Contract' 등 구현을 요청하면 이 스킬 실행. Sprint Contract 작성 → Plan 게이트(ExitPlanMode)로 사용자 승인 → 구현 순서로 진행한다."
---
# /implement — 기능 구현 가이드

다음 구현할 기능을 선택하고 **Sprint Contract → 구현 → Evaluator 검증**까지 단계별로 안내한다.

## 사용법
```
/implement          # 다음 미완료 기능 자동 선택
/implement F4       # 특정 기능 지정
/implement --retry  # evaluator 피드백 반영 후 재구현
```

## Process

### 1. 기능 선택
- 인자 없으면: feature_list.json에서 passes: false인 첫 번째 기능 선택
- `--retry`: 최신 evaluator-feedback에서 fail된 기능 선택
- 특정 ID: 해당 기능 선택

### 2. 사전 점검
- [ ] phase-gate.json → current_phase가 implementation인지 확인
- [ ] 해당 기능의 security_tier 확인
- [ ] docs/SECURITY-CHECKLIST.md에서 해당 기능의 보안 요건 로드
- [ ] 이전 evaluator 피드백이 있으면 표시

### 3. 기준 검증 및 보완
Sprint Contract 작성 **전에** 상위 산출물의 완전성을 점검:
- evals/acceptance-criteria.json에서 해당 기능의 기준 확인:
  - 정상 동작 기준이 **구체적이고 검증 가능한가?** (모호한 표현 → 구체화)
  - 에러/엣지 케이스 시나리오가 포함되어 있는가?
  - security_tier에 맞는 보안 기준이 있는가?
- **이전 evaluator 피드백**에 `criteria_gaps`가 있으면 반드시 먼저 반영
- 누락/모호한 기준 발견 시:
  1. evals/acceptance-criteria.json 보완 (기준 추가/구체화)
  2. docs/SPEC.md 보완 (요구사항 누락 시)
  3. docs/SECURITY-CHECKLIST.md 보완 (보안 요건 누락 시)
  4. 보완 내역을 사용자에게 요약 표시
- **기준 보완 없이는 Sprint Contract 작성으로 넘어가지 않는다**

### 4. Sprint Contract 작성/확인
- progress/contracts/에 해당 sprint contract가 없으면 작성:
  - acceptance_criteria (SPEC.md + acceptance-criteria.json 기반)
  - security_criteria (SECURITY-CHECKLIST.md + security_tier 기반)
  - error_scenarios (SPEC.md의 실패 시나리오 기반)
  - test_scenarios
  - implementation_steps — **체크포인트 태스크 목록**: 각 태스크는 작고(파일 1-3개 수준)
    **독립적으로 검증 가능**해야 한다 (해당 태스크의 테스트/실행으로 완료 확인 가능)
    ```json
    "implementation_steps": [
      {"step": "JWT 발급 로직 + 단위 테스트", "verify": "go test ./auth/ -run TestIssue", "done": false},
      {"step": "POST /login 핸들러 연결", "verify": "curl 스모크 + handler 테스트", "done": false}
    ]
    ```
- 이미 있으면 그대로 사용
  - 단, 기준이 보완되었으면 contract도 갱신
- 작성 후 `agreed: false` 상태로 저장 (아직 미승인)
  - 사용자 승인은 Step 5의 Plan 게이트에서 받는다

### 5. Plan 게이트 — 사용자 승인
Sprint Contract 작성 직후, 구현을 시작하기 **전에** Claude Code의 **Plan mode**로 진입하여 사용자 승인을 받는다.

- **ExitPlanMode tool**을 호출해 다음 내용을 자연어로 제시:
  1. 대상 기능 ID와 간단 설명
  2. Sprint Contract의 `acceptance_criteria` 요약
  3. `security_criteria` 요약 (security_tier 표시)
  4. `error_scenarios` 핵심 항목
  5. **구현 순서**: implementation_steps의 체크포인트 태스크 목록 — 태스크별 검증 방법 포함
  6. 예상 테스트 범위 (단위/통합/보안)
- 사용자 응답 분기:
  - **승인(approve)**: Sprint Contract의 `agreed`를 `true`로 갱신 후 Step 6(구현 실행)으로 진행
  - **거부/수정 요청**: 사용자 피드백을 반영해 다음 중 필요한 것을 갱신하고 **다시 Step 4로 루프**
    - Sprint Contract (가장 흔함)
    - evals/acceptance-criteria.json (기준 자체가 부족할 때)
    - docs/SPEC.md (요구사항 자체가 부족할 때)
    - 재작성 후 Plan 게이트 재진입 → 사용자 재승인
- **사용자 승인 없이 `agreed: true`로 변경하거나 구현을 시작하지 않는다.**

### 6. 구현 실행 — 직렬 또는 서브에이전트 구동(병렬) 모드

먼저 implementation_steps의 **독립성을 판정**해 모드를 고른다:
- **독립 판정**: 두 태스크가 (a)같은 파일을 수정하거나 (b)서로의 출력을 입력으로 받으면 **의존** → 직렬.
  그 외는 **독립** → 병렬 후보.
- 독립 태스크가 **2개 이상**이고 git worktree가 가능하면 → **서브에이전트 구동 모드**.
  단일 태스크·의존성 있음·worktree 미지원이면 → **직렬 모드(폴백)**. (소규모 변경에 오버헤드 강요 금지)
- **위임 상한**: 위 하한을 만족해도 아래는 위임하지 않는다 — (a)직접 소수의 tool call로 끝낼 태스크,
  (b)한 태스크를 잘게 쪼갠 병렬(병렬은 독립 트랙용이지 한 작업을 나누는 용도가 아니다),
  (c)자기 작업을 재확인할 목적의 위임. 동시 스폰 수는 필요한 최소로 유지한다.
  - **(c)의 예외**: Step 8의 **독립 evaluator 판정**과 **F37 critical 2차 판정**은 모델의 자기검증이
    아니라 조직적 통제(INV-1)이므로 반드시 수행한다 — 위임 상한을 게이트 생략의 근거로 오독하지 않는다.

#### 6a. 직렬 모드 (기본 폴백)
implementer agent 프로세스를 한 컨텍스트에서 따른다:
1. 해당 디렉토리의 CLAUDE.md 읽기
2. implementation_steps 단위로 **TDD 사이클(RED-GREEN-REFACTOR)** — 태스크 완료마다 verify 실행 + `done:true`
3. **구현 중 기준 갭 발견 시 즉시 보완** (acceptance-criteria.json + Sprint Contract 동시 갱신)
4. 보안 self-check → 린트 + 테스트 → implementer-output.json의 `evidence` 기록

#### 6b. 서브에이전트 구동 모드 (독립 태스크 병렬)
부모(메인 루프)가 오케스트레이션하고, 독립 태스크를 격리 서브에이전트로 병렬 디스패치한다:
1. **컨텍스트 큐레이션**: 부모가 Sprint Contract를 **1회만** 읽고, 각 서브에이전트에는 **그 task의
   step+verify+관련 criteria만** 전달한다. **전체 contract·세션 이력을 상속시키지 않는다** —
   각 자식은 자기 task만 아는 최소 컨텍스트(~task별 컨텍스트)로 동작해 부모 컨텍스트와 토큰을 보존한다.
2. **병렬 디스패치**: 독립 태스크들을 **한 메시지에서 동시에** `isolation: "worktree"` implementer
   서브에이전트로 디스패치(파일 충돌 방지). 각 자식은 자기 task를 TDD로 구현 + per-task evidence 반환.
3. **병합 프로토콜** — evaluator로 넘기기 전에:
   - (1) **각 서브에이전트 요약 검토** — 무엇을 바꿨는지 파악
   - (2) **충돌 확인** — 두 자식이 같은 파일을 편집했는지 점검(독립성 오판 감지). 충돌 시 직렬 재실행
   - (3) **전체 테스트 실행** — 통합 후 회귀 없음 확인. 실패 시 evaluator로 넘기지 않고 `/debug` 안내
4. 병합 결과를 implementer-output.json의 `evidence`에 취합

> **독립 evaluator 유지**: 두 모드 모두 **병합 후 독립 evaluator가 1회 판정**한다.
> 서브에이전트(부모·자식)는 passes를 set하지 않는다(INV-1). per-task evidence는 evaluator를
> 대체하지 않고 **보완**할 뿐이다 — superpowers의 inline self-review로 검증을 대체하지 않는다(ADR-003).

### 7. 구현 완료 처리
- progress/agent-comms/implementer-output.json 작성 (criteria_backfill 포함)
- git commit
- progress/claude-progress.txt 업데이트
- 미완료 작업·블로커·핵심 결정이 있으면 progress/session-handoff-draft.json에 기록
  (Stop 훅이 자동 상태와 병합해 다음 세션에 주입)

### 8. 검증 디스패치 — 강도를 변경에 맞춘다 (티어링)

검증 강도는 **security_tier·변경 크기**에 매칭한다. 단, **하향이 아니라 저위험에 경량 경로를
추가**하는 것이다 — critical 게이트는 절대 경량화하지 않는다:

| 변경 | 검증 강도 |
|------|-----------|
| **low·문서·1-3파일 비보안** | 경량 — `/hotfix`류(재현 테스트 + 변경 범위 테스트 + pre-commit-gate). evaluator 생략 가능 |
| **standard** | 독립 **evaluator** (아래 1) |
| **critical** | full evaluator + **security-auditor** + qa-reviewer (현행) — **절대 경량화 금지** |

**per-checkpoint 검증**: 기능 끝에 한 번만 검증하지 말고, implementation_steps의 `verify`를
**체크포인트(태스크)마다** 실행해 문제를 조기에 잡는다(재시도 비용↓). 최종 게이트(evaluator)는
그대로 1회 — per-checkpoint는 evaluator를 **보완**할 뿐 대체하지 않는다(INV-1).

> 임계값(pass_threshold·security_thresholds)은 바꾸지 않는다 — 티어링은 *어떤 에이전트를
> 부르는가*의 문제이지 *통과 기준을 낮추는* 것이 아니다. critical 기능의 보안 게이트는 불변.

구현 완료 후 verification phase 에이전트를 실행한다(standard 이상):

1. **evaluator** (게이트, 우선 실행): Sprint Contract 기준 검증 — passes 판정은 evaluator만 가능
   ```
   "evaluator agent로 F4 구현 결과를 검증해줘.
    Sprint Contract: progress/contracts/sprint-4.json"
   ```
2. evaluator 통과 후 나머지 검증은 **한 메시지에서 동시(병렬) 실행**:
   - **test-writer** (통합/E2E 테스트) + **security-auditor** (보안 감사) + **qa-reviewer** (크로스 기능 QA)
   - 서로 독립적이므로 순차 실행하지 않는다 — Agent tool 호출 3개를 같은 메시지에 담아 디스패치
   - test-writer는 테스트 파일을 생성하므로 **`isolation: "worktree"`로 디스패치** —
     다른 검증 에이전트와의 파일 충돌을 방지하고, 완료 후 변경분을 메인 워크트리로 가져온다
3. 결과는 progress/agent-comms/에 수집 — fail이 있으면 `--retry`로 implementer 루프 재진입

## Constraints
- Sprint Contract는 구현 전에 작성 — **Plan 게이트에서 사용자 승인(ExitPlanMode)을 받은 뒤에만 `agreed: true`로 전환**
- 사용자 승인 없이 구현을 시작하지 않는다 (거부 시 Sprint Contract 재작성 루프)
- security_tier: critical 기능은 보안 테스트 없이 완료 불가
