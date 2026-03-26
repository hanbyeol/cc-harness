---
name: implement
description: 다음 기능의 구현을 Sprint Contract부터 evaluator 검증까지 안내
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
- 이미 있고 agreed: true이면 그대로 사용
  - 단, 기준이 보완되었으면 contract도 갱신 후 재합의
- 사용자에게 contract 확인 요청 → agreed: true로 업데이트

### 5. 구현 실행
implementer agent의 프로세스를 따라 구현:
1. 해당 디렉토리의 CLAUDE.md 읽기
2. 기능 구현 + 테스트 작성 (security_criteria, error_scenarios 포함)
3. **구현 중 기준 갭 발견 시 즉시 보완** (evals/acceptance-criteria.json + Sprint Contract 동시 갱신)
4. 보안 self-check 실행
5. 린트 + 테스트 실행

### 6. 구현 완료 처리
- progress/agent-comms/implementer-output.json 작성 (criteria_backfill 포함)
- git commit
- progress/claude-progress.txt 업데이트

### 7. Evaluator 실행 안내
```
구현 완료! 다음 단계:
  evaluator agent로 검증을 실행하세요.

  프롬프트 예시:
  "evaluator agent로 F4 구현 결과를 검증해줘.
   Sprint Contract: progress/contracts/sprint-4.json"
```

## Constraints
- Sprint Contract 미합의 시 구현 진행 금지
- security_tier: critical 기능은 보안 테스트 없이 완료 불가
