---
name: hotfix
description: "긴급 버그 수정용 경량 워크플로우. TRIGGER: 사용자가 '핫픽스', 'hotfix', '긴급 수정', '빠르게 고쳐', '1줄 수정', 'quick fix' 등 소규모 긴급 수정을 요청하면 이 스킬 실행. 전체 SDLC 대신 경량 프로세스를 사용한다."
---
# /hotfix — 경량 긴급 수정 워크플로우

전체 SDLC 워크플로우(SPEC → Architecture → Sprint Contract → Evaluator) 대신,
소규모 긴급 수정에 적합한 경량 프로세스를 실행한다.

## 사용법
```
/hotfix                     # 수정 사항 설명 후 바로 진행
/hotfix F3: 로그인 500 에러  # 특정 기능 + 설명 지정
```

## 적용 조건
이 워크플로우는 다음 조건을 **모두** 만족할 때만 사용:
- 변경 범위가 **3개 파일 이하**
- 새로운 기능 추가가 아닌 **버그 수정** 또는 **사소한 개선**
- `security_tier: critical` 기능의 **보안 관련 변경이 아님**

**부적합한 경우** → 자동으로 `/implement`로 전환:
- 새 기능 추가
- 아키텍처 변경 수반
- security_tier: critical 기능의 보안 로직 수정
- 4개 이상 파일 변경 예상

## Process

### 1. 범위 확인
- 수정 대상 파일 식별 (3개 이하 확인)
- feature_list.json에서 관련 기능의 security_tier 확인
- **security_tier: critical의 보안 관련 변경이면 → `/implement`로 전환**

### 2. 경량 Sprint Contract (인라인)
별도 파일 생성 없이, 다음을 사용자에게 요약 표시:
```
=== Hotfix Contract ===
대상: {기능 ID}: {설명}
수정 내용: {1-2줄 요약}
영향 파일: {파일 목록}
테스트: {검증 방법}
```

### 3. 수정 실행
- 버그 수정 코드 작성
- 관련 테스트 수정/추가 (수정 범위에 해당하는 테스트만)
- 린트 통과 확인

### 4. 검증 (경량)
- 수정 관련 테스트 실행 (전체 테스트 불필요 — 변경 범위 테스트만)
- pre-commit-gate.sh가 Stop 훅으로 나머지 검증 수행

### 5. 완료
- git commit (커밋 메시지에 `hotfix:` 접두사)
- progress/claude-progress.txt 업데이트
- **evaluator 실행 불필요** — pre-commit-gate 통과로 충분

### 6. 사후 추적
feature_list.json의 해당 기능이 이미 `passes: true`이면 상태 유지.
`passes: false`이면 hotfix만으로 true 전환하지 않음 — 전체 `/implement` 필요.

## 건너뛰는 것
- SPEC.md 업데이트
- ARCHITECTURE.md 업데이트
- acceptance-criteria.json 업데이트
- Sprint Contract 파일 생성
- Evaluator 검증

## Constraints
- Hotfix는 기존 기능의 동작을 **수정**하는 것이지 **추가**하는 것이 아님
- security_tier: critical 기능의 보안 로직은 반드시 `/implement` 사용
- 수정 중 범위가 3파일 초과로 확대되면 즉시 `/implement`로 전환
- Hotfix 남용 방지: 연속 3회 이상 hotfix 시 "전체 워크플로우 권장" 안내 표시
