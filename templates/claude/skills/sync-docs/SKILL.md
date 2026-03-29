---
name: sync-docs
description: "문서와 코드 간 불일치 검사 및 동기화. TRIGGER: 사용자가 '문서 동기화', '문서 업데이트', 'sync docs', '코드랑 문서가 안 맞아', 'drift 확인', '산출물 점검' 등을 요청하면 이 스킬 실행."
---
# /sync-docs — 산출물 동기화 검사

구현 코드와 설계 문서 사이의 **불일치(drift)를 탐지**하고, 산출물을 현재 상태에 맞게 업데이트한다.

## 사용법
```
/sync-docs              # 전체 동기화 검사
/sync-docs spec         # SPEC.md만 검사
/sync-docs architecture # ARCHITECTURE.md만 검사
/sync-docs criteria     # acceptance-criteria.json만 검사
```

## Process

### 1. 현재 상태 수집
- git log로 최근 변경된 파일 목록 수집
- progress/feature_list.json에서 완료된 기능 목록
- progress/agent-comms/의 최근 output 파일들

### 2. Spec Drift 검사 — docs/SPEC.md
- **감지 방법**: feature_list.json의 passes: true 기능 vs SPEC.md 기능 섹션 교차 대조
- 구현된 기능이 SPEC.md에 미반영? → feature_list에 있고 코드에 존재하나 SPEC에 미언급
- SPEC.md에 있지만 구현되지 않은 기능? → SPEC에 정의되었으나 feature_list에 없거나 코드 흔적 없음
- 보안 요구사항이 실제 구현과 불일치? → SPEC 보안 섹션 vs SECURITY-CHECKLIST 대조
- 결과를 목록으로 출력

### 3. Architecture Drift 검사 — docs/ARCHITECTURE.md
- 새 서비스/컴포넌트가 추가됐으나 다이어그램 미반영?
- API 엔드포인트가 변경됐으나 API-DESIGN.md 미반영?
- 실제 사용 중인 기술 스택과 문서 불일치?

### 4. Criteria Drift 검사 — evals/acceptance-criteria.json
- 구현된 기능에 acceptance criteria가 없음?
- criteria가 있지만 해당 기능이 삭제됨?
- security_criteria가 실제 보안 구현과 불일치?

### 5. Feature List 정합성 — progress/feature_list.json
- **감지 방법**: feature ID로 코드 내 관련 파일 검색 (implementer-output.json의 files_changed 참조)
- 코드에 존재하지만 feature_list에 없는 기능? → git diff로 새 엔드포인트/컴포넌트 감지
- feature_list에 있지만 코드에 흔적이 없는 기능? → files_changed 기반 파일 존재 확인
- passes: true인데 테스트가 실패하는 기능? → make test 실행 결과 대조

### 6. Drift 리포트 출력
```
=== Sync Report ===

SPEC.md:
  ⚠ F7 (WebSocket 알림) — 구현됨, SPEC에 미반영
  ✓ F1-F6 — 동기화됨

ARCHITECTURE.md:
  ⚠ notification-service — 새 컴포넌트, 다이어그램에 없음
  ✓ 나머지 컴포넌트 — 동기화됨

acceptance-criteria.json:
  ⚠ F7 — criteria 없음
  ✓ F1-F6 — criteria 존재

Actions needed: 3 items
```

### 7. 자동 수정 제안
- 각 drift 항목에 대해 수정 방안 제시
- 사용자 승인 시 해당 산출물 업데이트
- git commit: `docs: sync documents with implementation`

## Constraints
- 코드 수정 금지 — 문서만 업데이트
- 자동 수정은 사용자 확인 후에만 적용
