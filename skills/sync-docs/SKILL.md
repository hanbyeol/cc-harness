---
name: sync-docs
description: "문서와 코드 간 불일치 검사 및 동기화. TRIGGER: 사용자가 '문서 동기화', '문서 업데이트', 'sync docs', '코드랑 문서가 안 맞아', 'drift 확인', '산출물 점검' 등을 요청하면 이 스킬 실행."
---
# /sync-docs — 산출물 동기화 검사

구현 코드와 설계 문서 사이의 **불일치(drift)를 탐지**하고, 산출물을 현재 상태에 맞게 업데이트한다.

## 사용법
```
/sync-docs              # 전체 동기화 검사 (샘플링, 저비용)
/sync-docs spec         # SPEC.md만 검사
/sync-docs architecture # ARCHITECTURE.md만 검사
/sync-docs criteria     # acceptance-criteria.json만 검사
/sync-docs --deep       # 1M 컨텍스트 기반 전수 검사 (고비용, 월 1회 권장)
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

## Deep Audit 모드 — `/sync-docs --deep`

기본 모드는 git log·feature_list 기반 **샘플링**이라 cross-file 불일치를 놓칠 수 있다.
Deep 모드는 Opus 4.7의 **1M 컨텍스트 윈도우**(`claude-opus-4-7[1m]`)를 활용해 repo 전체를 단일 컨텍스트에 로드하고 전수 교차 검증을 수행한다.

### 실행 전제
- 모델: `claude-opus-4-7[1m]` (1M context) 사용 중인지 확인
  - 현재 세션 모델 ID가 `[1m]` suffix를 포함하지 않으면 사용자에게 전환 안내 후 중단
- 비용 경고: **일반 `/sync-docs` 대비 10~20배 토큰 소비**. 실행 전 사용자에게 명시적 동의 요청
- 권장 실행 빈도: **월 1회** 또는 **major milestone 직전**(릴리스/아키텍처 리팩터링 전)

### 1. 컨텍스트 로드 (단일 패스)
아래 파일을 모두 한 컨텍스트에 적재한다 (순서: 상위 산출물 → 하위 구현):
- docs/SPEC.md, docs/ARCHITECTURE.md, docs/API-DESIGN.md (존재 시)
- evals/acceptance-criteria.json
- progress/feature_list.json, progress/contracts/sprint-*.json
- 주요 소스 디렉토리 전체: `src/`, `lib/`, `app/`, `packages/*/src/` 등 (프로젝트 구조에 따라)
- 테스트 디렉토리: `tests/`, `__tests__/`, `*.test.*`
- 설정/스키마: `schema/`, `migrations/`, `*.config.*`

### 2. 전수 교차 검증 항목
샘플링 모드가 놓치는 영역에 집중:
- **Cross-file 불일치**: SPEC의 한 요구사항이 여러 모듈에 분산 구현되었을 때 일관성
- **순환 참조 / 암묵적 의존성**: 문서엔 없지만 코드상 존재하는 모듈 간 의존
- **Silent drift**: feature_list·git log엔 없지만 실제 코드에 존재하는 기능 (리팩터링 중 누락된 기록)
- **Contract violation**: Sprint Contract의 acceptance_criteria가 실제 테스트·구현에 반영됐는지 전수 대조
- **Security requirement 전파**: SPEC 보안 항목이 관련된 **모든** 엔드포인트·핸들러에 일관 적용됐는지
- **Error scenario coverage**: error_scenarios 대비 실제 에러 경로 구현 매핑
- **Dead code / orphan**: 어떤 feature에도 속하지 않는 코드 블록

### 3. Deep Report 출력 예시
```
=== Deep Sync Report (1M context, full-repo audit) ===
Model: claude-opus-4-7[1m]
Scope: 247 files, ~820K tokens loaded
Duration: 4m 12s

Cross-file Drift:
  ⚠ SPEC §3.2 "Rate limiting" — auth-service에는 구현, notification-service에는 누락
  ⚠ ARCHITECTURE "Event Bus" — 코드상 Redis Pub/Sub 사용, 문서는 Kafka로 기술

Implicit Dependencies:
  ⚠ billing-service → user-service.internal_api (문서 미기재 의존성)

Silent Drift:
  ⚠ src/webhooks/stripe.ts — feature_list·SPEC 어디에도 없음 (F?? 신규 등록 필요)

Contract Violations:
  ⚠ sprint-7 AC#3 "결제 실패 시 롤백" — 테스트 없음, 코드 경로 미확인

Security Propagation:
  ⚠ SPEC "모든 PII 접근은 audit log" — /api/admin/users 3개 핸들러 중 1개 누락

Actions needed: 7 items (3 critical, 4 warning)
```

### 4. 언제 쓸지 가이드
| 상황 | 기본 `/sync-docs` | `/sync-docs --deep` |
|------|-------------------|----------------------|
| 스프린트 종료 주간 점검 | O | — |
| 단일 기능 변경 후 확인 | O | — |
| 월간 정기 감사 | — | O |
| 릴리스 전 최종 점검 | — | O |
| 아키텍처 리팩터링 직전 | — | O |
| 오랜만에 본 레거시 모듈 | — | O |

### 5. 비용 절감 팁
- 실행 전 `rtk gain`으로 기준선 확인
- `.syncignore` 등으로 생성 파일(빌드 아티팩트, lock, dist/) 제외
- deep 실행 결과는 progress/agent-comms/에 저장해 재실행 없이 재참조

## Constraints
- 코드 수정 금지 — 문서만 업데이트
- 자동 수정은 사용자 확인 후에만 적용
- `--deep` 모드는 모델이 `[1m]` 컨텍스트 지원 시에만 실행. 미지원 시 사용자에게 전환 안내 후 중단
