# ADR-003: superpowers 방법론 선택적 채택 (v1.6.0)

## Status
Accepted — 2026-06-12

## Context
superpowers(obra, v5.1.0, ★226k)는 14개 composable skill로 구성된 에이전트 개발 방법론
라이브러리다. cc-harness와 지향점이 다르다:
- **superpowers** = 프로세스 방법론 ("어떻게 일할 것인가") — TDD, 디버깅, 브레인스토밍 등
  작업 방식의 깊이가 강점. 강제는 대부분 프롬프트 규율.
- **cc-harness** = 구조와 강제 ("무엇을 강제하고 추적할 것인가") — 정량 게이트, 보안 내재화,
  세션 간 상태, 결정론적 훅이 강점. 프로세스 방법론의 깊이는 약점이었다.

두 접근은 상호 배타가 아니라 보완 관계다.

## Decision — 채택 (5건)
| superpowers | cc-harness 반영 |
|---|---|
| brainstorming | `/brainstorm` 스킬 — 소크라테스식 설계 정제(Phase 0.5), docs/brainstorms/ 산출 → spec-writer 브리프 연결 |
| test-driven-development | implementer에 RED-GREEN-REFACTOR 내장 + 테스트 안티패턴 금지 목록. hotfix는 재현 테스트 먼저 |
| systematic-debugging | `/debug` 스킬 — 재현 고정 → 근본원인 추적 → 최소 수정 → 회귀 테스트. 증상 패치 금지 |
| writing-plans + verification-before-completion | Sprint Contract에 `implementation_steps`(검증 가능한 체크포인트 태스크), implementer output에 `evidence` 의무 |
| finishing-a-development-branch | `/finish-branch` 스킬 — 테스트 게이트 → drift 확인 → PR/머지/보류 옵션 |

## Decision — 의도적 미채택 (3건)
1. **inline self-review** (superpowers v5.0.6이 subagent 리뷰 루프를 속도 때문에 자가 리뷰로
   대체) — 채택하지 않는다. Generator-Evaluator **독립 검증**이 cc-harness의 핵심 불변식이다.
   자기 작업의 평가자는 자기 가정도 공유한다 — 속도는 verification phase 병렬화로 회수한다.
2. **writing-skills 메타스킬** — Claude Code의 기본 스킬 생성 지원 + README의 Improvement
   Loop로 충분. 스킬 수 증가는 라우팅 정확도 비용이 있다.
3. **using-superpowers 메타스킬** (스킬 시스템 활성화 스킬) — CLAUDE.md의 "요청 → 행동
   라우팅" 테이블이 동일 역할을 항상-로드 방식으로 수행한다.

## Consequences
- 스킬 5 → 8개. 라우팅 테이블이 의도 분기를 흡수: 원인 명확(/hotfix) vs 불명(/debug),
  요구사항 확정(/change-request) vs 미확정(/brainstorm)
- implementer의 TDD 의무화로 구현 턴이 길어질 수 있으나, evaluator 반려 루프 감소로 상쇄 기대
- "evidence over claims"가 implementer(evidence 필드)와 evaluator(unverified 규칙) 양쪽에서
  대칭으로 강제됨
