# ADR-007: security-auditor 모델 정책 — Opus 5 격상과 refusal 관측

**Status**: Accepted (sprint-41 / F55)

## Context

`security-auditor`는 `security_tier: critical` 기능의 보안 게이트다. 이 에이전트가 조용히 실패하면 보안 검증이 통과한 것처럼 보인다.

이전까지 이 에이전트의 모델 선택 근거는 다음과 같았다:

> Fable 5는 보안 분석 콘텐츠에 안전 분류기(cyber classifier)가 작동하여 정상적인 방어 목적 감사도 refusal될 수 있다 — 보안 감사 워크로드에는 Opus 계열이 적합하다.

F55(Opus 4.8 → Opus 5 전환)에서 이 근거가 **더 이상 성립하지 않는다**는 사실이 드러났다. Opus 5는 Fable 5와 마찬가지로 강화된 사이버보안 안전장치를 탑재하며, 안전 분류기가 요청을 거절하면 오류가 아니라 정상 HTTP 200에 `stop_reason: "refusal"`로 응답한다. Anthropic은 cyber 카테고리 refusal의 **권장 폴백으로 Opus 4.8을 지정**한다 — 즉 Opus 4.8은 우연히 안전한 선택이 아니라 이 실패 모드의 공식 대피 경로다.

문제의 핵심은 refusal 자체가 아니라 **관측 불가능성**이다.

- 서브에이전트 계층에서는 `fallbacks` 파라미터나 클라이언트 미들웨어로 refusal 폴백을 선언할 수단이 없다.
- refusal된 서브에이전트는 빈/부실한 산출을 남길 수 있고, 그 상태는 **"감사를 수행했고 이슈가 없었다"와 겉보기가 같다**.
- 따라서 critical 보안 게이트가 조용히 무력화되는 경로가 생긴다.

## Decision

**security-auditor를 `claude-opus-5`로 격상한다** (2026-07-25 사용자 결정). refusal 위험을 인지한 상태에서 최신 추론 능력(버그 탐지 정밀도·재현율)을 우선했다.

위험은 **제거하지 않고 관측 가능하게 만든다**:

1. **`scripts/probes/audit-integrity.sh` 신설** — security-auditor 산출을 "검사 수행 흔적"으로 판정한다.
   - 정상 통과: `checklist_compliance.total_items > 0` 또는 `scan_tools`가 비어있지 않음 → findings가 0건이어도 후보 아님
   - 빈 산출: 검사 흔적이 전혀 없음 → 후보로 표면화 (`security_tier: critical`)
   - refusal: `summary`/`error`/`note`에 거절 마커 → 후보로 표면화
   - 산출 파일이 아예 없으면 "아직 감사 미실행"인 정상 상태로 보고 후보를 내지 않는다(오탐 방지)
2. **폴백 경로 문서화** — 감사가 반복적으로 refusal되면 이 에이전트만 `claude-opus-4-8`로 되돌린다. `config/models.json`의 `pricing`에 Opus 4.8 단가를 존치해 이 경로를 즉시 쓸 수 있게 둔다(F55 Q4).
3. **낡은 근거 제거** — `agents/security-auditor.md`와 `README.md`의 "cyber-refusal이 없는 Opus를 고수한다"는 문장을 삭제하고, refusal 가능성과 폴백 후보를 명시한다.

### 검토한 대안

| 대안 | 기각 사유 |
|---|---|
| **(A) Opus 4.8 고정** | Anthropic 권장 폴백과 일치해 가장 안전하지만, critical 판정 역할만 구세대에 묶여 최신 추론 능력을 포기한다. 사용자가 격상을 선택 |
| **(B) refusal 자동 폴백 배선** | 서브에이전트 계층에 `fallbacks`/미들웨어를 선언할 수단이 없다. 하네스가 산출을 사후 판별해 재디스패치하는 방식은 가능하나 구현·테스트 부담이 F55 범위를 넘는다 |
| **(C) SubagentStop 훅으로 실시간 캡처** | F54가 evaluator에 배선한 패턴을 확장하면 실시간에 가깝지만, `hooks.json`·`settings.json` 배선 대칭(INV-13/F52) 작업을 반복해야 해 standard 티어 스프린트의 범위를 초과한다. 별도 기능으로 분리 |
| **(D) 프롬프트 명문화만** | "감사 산출이 비었으면 통과로 해석하지 말라"는 지침은 비용이 0이지만 기계 검증이 아니라 모델 준수에 의존한다. 프로브와 병행할 수는 있으나 단독 방어선으로는 부족 |

## Consequences

**긍정**:
- critical 판정 역할(implementer·evaluator·security-auditor·architect)이 모두 Opus 5로 통일 — 모델 티어 래티스가 단순해지고 게이트가 구현보다 저티어가 되는 역전 위험이 없다.
- 보안 감사의 버그 탐지 정밀도·재현율이 함께 개선된다.
- 이전에는 **아예 관측되지 않던** 실패 모드(빈 산출 = 통과처럼 보임)가 프로브 후보로 표면화된다. 격상 여부와 무관하게 이 관측 장치 자체가 순이득이다.

**트레이드오프 / 수용된 위험**:
- refusal 가능성이 실재한다. 감사가 거절되면 그 회차의 보안 검증은 수행되지 않는다.
- 탐지는 **사후**다 — 프로브는 산출이 기록된 뒤에 판정하므로, refusal을 실시간으로 막지 못하고 게이트 통과 이후 진단 단계에서 잡는다.
- 거절 마커 검사는 `summary`/`error`/`note` 자유 텍스트로 한정한다. `findings` 본문까지 훑으면 "refusal handling missing" 같은 정상 finding에 오탐하기 때문이다. 대신 마커 문구를 바꾼 refusal은 놓칠 수 있으며, 그 경우 "검사 흔적 없음" 조건이 2차 방어선이 된다.

**근본 한계 (정직한 명문화)**:
하네스는 refusal을 **방지할 수 없다**. 모델 제공자 측 안전 분류기의 동작이며 서브에이전트 계층에 폴백 선언 수단이 없다. 이 결정의 목표는 refusal 제거가 아니라 **빈 산출이 정상 통과로 오인되지 않게 하는 것**이다. 이 한계를 과대주장하지 않는다(F38에서 정정한 교훈과 동일한 원칙).

**집행**: `tests/probes.bats`의 `audit-integrity` 9개 테스트가 (a) 산출 부재 → 후보 없음, (b) 검사 흔적 있고 findings 0건 → 후보 없음(오탐 방지), (c) 검사 흔적 없음 → 후보, (d) refusal 마커 → 후보, (e) findings 안의 "refusal" 단어 → 후보 없음, (f) malformed → graceful degrade, (g) 후보의 `security_tier`가 critical, (h) 타임스탬프 파일명 인식, (i) `run-all.sh` 편입을 고정한다. 모델 할당의 frontmatter↔config 정합은 `scripts/probes/model-tiering.sh`가 계속 강제한다.
