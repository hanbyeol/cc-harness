---
name: change-request
description: "기능을 추가, 변경, 삭제할 때 사용. TRIGGER: 사용자가 '기능 추가해줘', '~~ 변경해줘', '~~ 삭제해줘', '새 기능', 'add feature', 'modify feature', 'remove feature' 등 기능 변경을 요청하면 반드시 이 스킬을 먼저 실행. 코드부터 작성하지 않고 산출물(SPEC, criteria, feature_list)을 먼저 업데이트한다."
---
# /change-request — 변경 요청 처리

사용자의 변경 요청을 받아 **영향받는 모든 산출물을 연쇄적으로 업데이트**하고,
구현까지의 절차를 관리한다.

## 사용법
```
/change-request 로그인 시 OTP 인증 추가
/change-request F3 기능 삭제
/change-request 결제 플로우를 Stripe에서 Toss로 변경
```

## Process

### 1. 변경 영향 분석
- 변경 요청의 유형 분류: `add` (신규 기능) | `modify` (기존 변경) | `remove` (기능 삭제)
- 영향받는 기능 식별 (feature_list.json에서 관련 feature ID)
- **의존성 분석**: feature_list.json의 `dependencies` 필드로 연쇄 영향 파악
  - 변경 대상 기능에 의존하는 다른 기능 식별 → passes 리셋 대상에 포함
  - 순환 의존 여부 확인
- 영향받는 산출물 목록 도출

### 2. 스펙 업데이트 — docs/SPEC.md
- 변경 사항을 SPEC.md에 반영
- **보안 요구사항** 변경 여부 확인 (security_tier 재평가)
- **품질 속성** 변경 여부 확인
- 변경 이력 섹션에 기록: `[날짜] 변경 내용 — 사유`

### 3. 아키텍처 영향 평가 — docs/ARCHITECTURE.md
- 아키텍처 변경이 필요한지 판단:
  - 새 컴포넌트/서비스 추가?
  - API 엔드포인트 변경?
  - 데이터 모델 변경?
  - 보안 플로우 변경?
- 변경 필요 시 ARCHITECTURE.md 업데이트 + ADR 작성
- **위협 모델 재평가**: 새로운 위협 시나리오 발생 여부
- docs/SECURITY-CHECKLIST.md 업데이트 (해당 시)

### 4. 인수 조건 업데이트 — evals/acceptance-criteria.json
- **modify**: 기존 기준을 삭제하지 않고 diff 기반으로 갱신
  - 변경된 항목: 기존 값 → 새 값으로 수정 (변경 이유 주석)
  - 추가된 항목: 새 기준 추가 (보안/에러 시나리오 포함)
  - 삭제된 항목: 해당 기능 제거 시에만 기준 삭제
- **add**: 새 기능의 acceptance/security/error 기준 신규 작성
- **remove**: 해당 기능의 기준을 삭제하되 change log에 이력 보존
- 각 기준은 **구체적이고 검증 가능**해야 함 (모호한 표현 금지)
  - ❌ "적절한 에러 처리" → ✅ "유효하지 않은 이메일 → 400 + validation_error 코드"

### 5. Feature List 업데이트 — progress/feature_list.json
- `add`: 새 feature 항목 추가 (passes: false, security_tier 태깅)
- `modify`: 기존 feature의 description 수정, passes → false로 리셋
- `remove`: 해당 feature 항목 삭제 또는 status: "removed"로 변경

### 6. Sprint Contract 갱신 — progress/contracts/
- `add`: 새 sprint contract 작성
- `modify`: **기존 contract가 있으면 갱신** (agreed → false로 리셋, 재합의 필요)
  - 변경된 acceptance_criteria/security_criteria/error_scenarios 반영
  - 기존 contract와의 차이점을 사용자에게 표시
- `remove`: 해당 contract 삭제 또는 status: "cancelled"로 변경
- acceptance_criteria + security_criteria + error_scenarios 포함

### 7. Phase Gate 상태 조정 — progress/phase-gate.json
- 변경 규모에 따라 판단:
  - **소규모** (기존 기능 내 수정): implementation phase 유지, 해당 feature만 재구현
  - **중규모** (새 기능 추가): implementation phase 유지, 새 feature 추가
  - **대규모** (아키텍처 변경): architecture phase로 롤백, 관련 criteria 리셋

### 8. Change Log 기록
아래 파일에 변경 이력 기록:
```json
// progress/agent-comms/change-request-{timestamp}.json
{
  "timestamp": "ISO8601",
  "type": "add|modify|remove",
  "description": "로그인 시 OTP 인증 추가",
  "affected_features": ["F1"],
  "impact": {
    "spec_updated": true,
    "architecture_updated": false,
    "acceptance_criteria_updated": true,
    "security_checklist_updated": true,
    "phase_rollback": false
  },
  "new_sprint_contract": "progress/contracts/sprint-3.json",
  "rollback_to_phase": null
}
```

### 9. 사용자 확인
- 모든 변경 사항 요약 출력
- 사용자 승인 후 파일 저장
- git commit: `chore: change request — {설명}`

## Constraints
- 변경 요청 처리 중 코드 수정 금지 — 산출물 업데이트만
- 사용자 승인 없이 phase 롤백 금지
- 변경 이력은 반드시 기록 (추적 가능성)
