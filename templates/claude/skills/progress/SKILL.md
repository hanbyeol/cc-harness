---
name: progress
description: "프로젝트 진행 상태 확인. TRIGGER: 사용자가 '진행 현황', '진행 상태', '어디까지 했어', '현재 상태', '뭐 해야 돼', 'progress', 'status', '다음 할 일' 등을 물으면 이 스킬 실행."
---
# /progress — 진행 현황 대시보드

현재 프로젝트의 **SDLC 진행 상태를 종합적으로 표시**하고, 다음 수행할 작업을 제안한다.

## 사용법
```
/progress          # 전체 현황
/progress features # 기능별 상세
/progress phase    # phase gate 상세
/progress history  # 변경 이력
```

## Process

### 1. Phase Gate 현황
progress/phase-gate.json을 읽어 아래 형태로 표시:
```
Phase Gate Status:
  ✅ specification    (4/4 criteria)
  ✅ architecture     (6/6 criteria)
  🔄 implementation   (2/4 criteria) — iteration 2/5
  ⬚ verification     (0/4 criteria)
  ⬚ deployment       (0/2 criteria)
  ⬚ observability    (0/3 criteria)
```

### 2. Feature 진행률
progress/feature_list.json을 읽어:
```
Features: 5/8 passed (62%)
  ✅ F1: User Auth          [critical] — passed (iteration 2)
  ✅ F2: User Profile        [standard] — passed
  ✅ F3: Dashboard           [standard] — passed
  🔄 F4: Payment Integration [critical] — in progress (evaluator score: 5/10)
  ⬚ F5: Notification        [standard] — not started
  ...
```

### 3. 최근 Evaluator 피드백
progress/agent-comms/evaluator-feedback-*.json에서 최신 3건:
```
Recent Evaluator Feedback:
  [2026-03-25] F4 — score 5/10 (fail)
    - [security] API key 하드코딩
    - [error] 결제 실패 시 500 반환
  [2026-03-24] F3 — score 8/10 (pass)
```

### 4. 변경 요청 이력
progress/agent-comms/change-request-*.json에서:
```
Change Requests:
  [2026-03-25] modify — "결제를 Stripe에서 Toss로 변경" (F4 영향)
  [2026-03-23] add — "WebSocket 알림 기능 추가" (F7 신규)
```

### 5. 다음 작업 제안
현재 상태 기반으로 자동 제안:
```
Suggested Next Actions:
  1. F4 evaluator 피드백 반영 (보안 이슈 2건)
  2. F5 Sprint Contract 작성 후 구현 시작
  3. /sync-docs 실행 권장 (마지막 동기화: 2일 전)
```

## Constraints
- 읽기 전용 — 파일 수정 없음
- progress/ 디렉토리의 파일만 참조
