# cc-harness

## Priority
Correctness > Safety > Speed

## Workflow — 기능 추가/변경/삭제
코드부터 쓰지 않는다. **`/change-request`**(영향분석 → SPEC/feature_list/Sprint Contract 갱신, passes:false)
→ **Plan 게이트**(ExitPlanMode 승인 시에만 contract `agreed:true` — 승인 없이 구현 금지)
→ **`/implement`**(TDD + evidence) → **독립 evaluator**(passes 판정). 각 단계의 상세 절차는 해당 스킬이 정의한다.

## 원칙
- **Generator-Evaluator**: implementer는 passes를 못 바꾼다 — 독립 evaluator만 `true`로. inline self-review로 대체 금지.
- **Evidence over claims**: 구현·디버깅·검증 모두 실행 결과를 근거로 완료를 선언 — 실행하지 않은 검증을 완료로 보고하지 않는다.
- **min-of-5**: 종합 점수 = 5차원(기능·품질·보안·에러·테스트)의 **최솟값**. security_tier critical은 보안 7/10 미만 시 자동 fail. 임계값은 `progress/harness-config.json` — **하향 불가**(invariant-guard가 차단).
- **검증 티어링**: 검증 강도를 security_tier·변경 크기에 매칭 — low/문서는 경량(evaluator 생략 가능), standard는 evaluator, critical은 evaluator+security-auditor. **경량은 저위험에만, critical 게이트·임계값은 절대 미하향.**
- **서브에이전트 제약**: 서브에이전트는 사용자에게 질문(AskUserQuestion)할 수 없다 — 필요한 입력은 메인 루프가 디스패치 전 수집해 프롬프트로 전달한다.

## 기준 역전파 원칙 (Criteria Backpropagation)
모든 단계에서 상위 산출물(SPEC·acceptance criteria)의 누락·모호·불일치를 발견하면 **즉시 보완**한다. 코드만 고치고 기준 갱신을 미루지 않는다.

## 요청 → 행동 라우팅

| 사용자 의도 | 행동 |
|-------------|------|
| 설계 탐색/아이디어 정리 (요구사항 미확정) | → `/brainstorm` |
| 기능 추가/변경/삭제 | → `/change-request` (모호하면 `/brainstorm` 먼저) |
| 기능 구현 | → `/implement` |
| 긴급 버그 수정 (원인 명확, 3파일 이하) | → `/hotfix` |
| 원인 불명 버그/이상 동작 | → `/debug` |
| 브랜치 마무리/PR/머지 준비 | → `/finish-branch` |
| 하네스 자기개선/진단 | → `/improve` |
| 인프라 plan 검토/apply 전 (iac 프로파일) | → `/plan-review` |
| 라이브 변경/롤아웃/스케일 (ops 프로파일) | → `/rollout` |
| 진행 상태 확인 | → `/progress` |
| 문서 동기화 | → `/sync-docs` |
| 스펙 작성 | 메인 루프가 AskUserQuestion 인터뷰 후 **spec-writer** |
| 아키텍처 설계 | **architect** |
| 구현 결과 검증 | **evaluator** |
| 보안 감사 | **security-auditor** |
| 테스트 작성 | **test-writer** |
| QA 검증 | **qa-reviewer** |
| 배포 | **deploy-operator** |

## Phase · 병렬 실행

| Phase | 주요 에이전트 | 전제 |
|-------|--------------|------|
| specification | spec-writer | 메인 루프 인터뷰 완료 |
| architecture | architect | spec 완료 |
| implementation | implementer | architecture 완료 + Sprint Contract 합의 |
| verification | evaluator·test-writer·security-auditor·qa-reviewer | implementation 완료 |
| deployment | deploy-operator | verification 통과 |

- **verification 병렬**: evaluator(게이트) 통과 후 test-writer·security-auditor·qa-reviewer는 독립적이므로 한 메시지에서 병렬 실행한다(순차 금지). test-writer는 파일을 생성하므로 `isolation:"worktree"`로 디스패치.
- **구현 병렬**: 독립(같은 파일 미수정·상호 의존 없음) implementation_steps가 2개 이상이면 각각 `isolation:"worktree"` implementer로 병렬 디스패치 → 병합(요약→충돌 확인→전체 테스트) → **독립 evaluator로 1회 판정**(자식은 passes를 set하지 않음). 단일/의존 태스크는 직렬.

## Session Handoff
작업 중 **중요 결정·블로커·다음 작업**은 `progress/session-handoff-draft.json`에 기록 → Stop 훅(session-handoff.sh)이 자동 상태와 병합해 다음 세션에 주입한다.
