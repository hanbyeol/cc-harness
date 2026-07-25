# Opus 4.8 → Opus 5 전환 — 하네스 정합화 + 행동 재튜닝

**일자**: 2026-07-25
**상태**: 설계 정제 완료 — `/change-request` 입력 대기
**범위 결정**: 전환 + 행동 재튜닝 (신기능 채택 — effort 티어링·512토큰 캐시·fast mode·Workflow 오케스트레이션 — 은 **이번 범위 밖**)

## 문제 정의

하네스가 Opus 4.8을 전제로 배선돼 있다. 두 종류의 부채가 있다.

1. **정합성 부채** — 모델 ID가 여러 곳에 하드코딩돼 있고, `scripts/probes/model-tiering.sh`가 frontmatter↔config drift를 기계 탐지하므로 한쪽만 바꾸면 프로브가 즉시 실패한다.
2. **보정 부채** — 하네스의 일부 지침은 *Opus 4.8의 약점을 보정하려고* 만든 것이다. Opus 5는 그 약점이 반대 방향으로 뒤집혔으므로, 남겨두면 역효과를 낸다.

핵심 사실: Opus 5는 Opus 4.8과 **같은 가격**($5/$25 per MTok), 같은 1M 컨텍스트, 같은 요청 표면(`budget_tokens`·샘플링 파라미터·prefill 모두 4.8에서 이미 제거됨)이다. 따라서 이 전환은 **모델 ID 스왑 + 프롬프트 재튜닝**이며, API 파괴적 변경 대응은 필요 없다.

## 이미 커버된 항목 — 변경 불필요

조사 결과 하네스는 4.8/Fable 5 세대의 프롬프트 보정을 **이미 흡수**해 놓았다. 마이그레이션 가이드의 권장 스니펫과 사실상 동형인 것들:

| Opus 5 권장 사항 | 하네스 현황 | 판정 |
|---|---|---|
| scope discipline / no-tidying | `agents/implementer.md:144-145` — "요청 범위만 구현", 불가능 시나리오 방어코드 금지, 검증은 시스템 경계에서만 | 이미 있음 |
| early stopping 방지 | `agents/implementer.md:142`, `agents/evaluator.md:150` — "마지막 출력이 계획/약속이면 즉시 실행" | 이미 있음 |
| 진행 주장의 근거 감사 | `agents/evaluator.md:60,126` — unverified 규칙(최대 6점) + evidence over claims | 이미 있음 |
| severity filter 제거 (커버리지 우선 보고) | `agents/security-auditor.md:17-20` — Reporting Policy | **security-auditor에만** 있음 |
| 중복 재검증 방지 | `agents/qa-reviewer.md:65,74` | 이미 있음 |

**"과잉 검증 지시를 삭제하라"는 항목은 하네스에 삭제 대상이 사실상 없다.** 가이드가 지목하는 것은 *모델의 자기검증 지시*("double-check your answer", "검증용 서브에이전트를 띄워라")인데, 하네스에는 그런 문구가 없다. 독립 evaluator 게이트와 F37 critical 2차 판정은 별도 컨텍스트에서 수행되는 **조직적 통제**이지 자기검증이 아니므로 삭제 대상이 아니며, min-of-5 임계값은 INVARIANTS상 하향 불가다.

## 결정 사항

### D1. 모델 정합화 — 모든 critical/standard Opus 역할을 `claude-opus-5`로

대상: `implementer` · `evaluator` · `security-auditor` · `architect` (현재 4개 모두 `claude-opus-4-8`).

동시에 갱신해야 정합성이 유지되는 지점:

| 위치 | 변경 |
|---|---|
| `agents/{implementer,evaluator,security-auditor,architect}.md` frontmatter | `model: claude-opus-5` |
| `config/models.json` `tiers` | `["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]` (4.8 제거) |
| `config/models.json` `assignments` 4건 | `model` 필드 + `rationale` 갱신 |
| `config/models.json` `pricing` | `claude-opus-5: {input:5, output:25}` 추가 |
| `README.md:102-103` | 산문 표기 "Opus 4.8" → "Opus 5" |

프로브 영향 확인 (`scripts/probes/model-tiering.sh`):
- rule1 drift — frontmatter/config 동시 갱신으로 해소
- rule2 unregistered — `tiers`에 `claude-opus-5` 등재로 해소
- rule3 critical-on-lowest — opus-5 rank 1 / tlen 4 → 최저 아님, 통과
- rule4 gate-below-reference — evaluator·security-auditor rank == implementer rank → 역전 없음, 통과

비용 회귀 없음: Opus 5 단가가 4.8과 동일하므로 `scripts/cost-report.sh` 산출값이 바뀌지 않는다.

### D2. security-auditor를 Opus 5로 격상 (사용자 결정)

**우려는 제기했고 사용자가 격상을 선택했다.** Opus 5는 Fable 5와 마찬가지로 elevated cybersecurity safeguards를 탑재하며, 안전 분류기가 정상적인 방어 목적 감사도 `stop_reason: "refusal"`로 거절할 수 있다. Anthropic은 cyber 카테고리 refusal의 권장 폴백으로 **Opus 4.8**을 지정한다.

따라서 `agents/security-auditor.md:13-15`의 현재 근거 주석은 **사실과 어긋나게 된다** — "Fable 5는 refusal 위험이 있으니 Opus 4.8을 쓴다"는 문장이, refusal 위험을 동일하게 가진 Opus 5를 쓰면서 남아 있게 되기 때문이다. 이 주석은 반드시 재작성한다: Opus 5 채택 사실 + refusal 가능성 + 폴백 후보가 4.8이라는 점을 명시.

### D3. evaluator에 Reporting Policy 대칭 적용

`agents/evaluator.md:145`의 "사소한 스타일 이슈로 반려하지 않음"은 가이드가 경고하는 바로 그 패턴이다 — Opus 5는 이런 보수적 필터를 **문자 그대로** 따르며, 조사 강도는 그대로인데 자체 판단으로 기준 미달 finding을 보고하지 않아 측정 recall이 떨어진다.

`security-auditor`에는 이미 커버리지 우선 Reporting Policy가 있고 evaluator에는 없다 — **비대칭이다.** 하네스는 F45·F51·F52에서 반복적으로 대칭성을 기계 강제해 왔으므로, 같은 원칙을 적용한다: evaluator도 발견을 전부 `issues`에 올리고 severity·confidence를 표기하되, **점수 산정과 pass/fail 판정은 지금 규칙 그대로 유지**한다(min-of-5, 임계값 불변). 보고량이 늘 뿐 게이트는 변하지 않는다.

### D4. 병렬 위임에 상한 신설 (하한은 유지)

현재 `CLAUDE.md:54-55`는 위임의 **하한만** 규정한다 — "독립 태스크 2개 이상이면 병렬 디스패치", "verification 병렬(순차 금지)". 이는 서브에이전트를 꺼리던 4.8을 밀어주기 위한 보정이다. Opus 5는 반대로 과하게 위임하므로, 하한만 있고 상한이 없는 현 상태에서는 토큰·지연이 곱해진다.

F16·F18이 보장한 병렬화는 그대로 두고 상한만 추가:
- 직접 몇 번의 tool call로 끝낼 일은 위임하지 않는다
- 동시 스폰 수 상한
- **자기 작업 재확인 목적의 위임 금지** — 단, 워크플로우가 규정한 독립 evaluator 게이트·F37 2차 판정은 명시적 예외(이것은 자기검증이 아니라 조직적 통제다)

적용 대상: `CLAUDE.md`, `skills/implement/SKILL.md:81-97`, `skills/debug/SKILL.md:21-31`.

### D5. 메인 루프 커뮤니케이션 지침

Opus 5는 tool call 사이 narration과 최종 응답 길이가 늘고, 자기 정정을 길게 서술한다. 에이전트들은 JSON 산출 중심이라 영향이 제한적이지만 **메인 루프에는 해당 지침이 없다**. `CLAUDE.md`에 간결성 + 결과 우선(outcome-first) + 불필요한 자기 정정 억제 지침을 추가한다.

## 검토한 대안

| 대안 | 내용 | 기각 사유 |
|---|---|---|
| 최소 전환만 | 모델 ID·pricing·프로브·픽스처만 정합화, 프롬프트 불변 | 4.8용 보정 지침(위임 장려·보수적 보고)이 그대로 남아 과잉위임·recall 저하가 발생. 사용자가 "행동 재튜닝 포함"으로 결정 |
| 전환 + 재튜닝 + 신기능 | effort 티어링, 512토큰 캐시 최소치, fast mode, Workflow 오케스트레이션 | 범위가 크고 하네스 구조 변경을 수반. 별도 사이클로 분리 |
| security-auditor를 4.8에 고정 | cyber refusal 회피, Anthropic 권장 폴백과 일치 | 사용자가 critical 역할 모델 통일을 우선해 격상 선택 |
| 위임 하한도 완화 | "2개 이상이면 병렬"·"순차 금지"를 권고로 강등 | F16·F18이 의도한 병렬화 보장이 약해짐 |

## 제약·가정

- **가정(미검증)**: Claude Code의 agent frontmatter `model:` 필드가 `claude-opus-5`를 그대로 수용한다. 현재 하네스가 full model ID(`claude-opus-4-8`)를 쓰고 동작 중이므로 동일 패턴으로 본다.
- 임계값·게이트 구조는 불변. `progress/harness-config.json`은 이번 변경 대상이 아니다(invariant-guard가 하향을 차단).
- 하네스 보호 파일 편집 시 Bash 리다이렉트가 아닌 Edit/Write 사용 (`.claude/rules/general.md`).
- 예상 `security_tier`: **standard** — 게이트 구조·임계값을 바꾸지 않고, 판정 행동에 영향을 주는 프롬프트와 설정만 변경한다.

## 보안 고려사항

- **security-auditor refusal이 조용한 실패가 될 수 있다.** 서브에이전트가 refusal을 받으면 빈/부실한 산출을 낼 수 있고, 현재 하네스에는 이를 탐지하는 장치가 없다. critical 게이트가 무력화되는 경로다. → 미해결 질문 Q1.
- evaluator Reporting Policy 변경은 **보고량만** 늘린다. 점수 산정·pass 판정 규칙은 손대지 않으므로 게이트 약화가 아니다.
- 위임 상한의 evaluator 예외 문구를 빠뜨리면 "검증용 위임 금지"가 독립 evaluator 게이트(INV-1) 자체를 억제하도록 오독될 수 있다. 예외를 명시적으로 쓴다.

## 미해결 질문

- **Q1** — security-auditor의 refusal을 어떻게 관측하는가? 산출 JSON 부재/공백을 프로브나 훅에서 잡을지, 잡는다면 어느 계층인지. 이번 스프린트에 포함할지 후속으로 뺄지 판단 필요.
- **Q2** — `tests/probes.bats`·`tests/cost-report.bats`의 하드코딩 모델 ID(일부는 이미 스테일: `claude-sonnet-4-6`)를 갱신할지. 이들은 격리 픽스처로 프로브 *로직*만 검증하므로 실제 모델 ID가 유효할 필요는 없다 — 갱신은 정합성 목적의 선택 사항.
- **Q3** — `claude-opus-5[1m]` 같은 컨텍스트 변종 ID를 frontmatter에서 써야 하는지. Opus 5는 1M이 기본값이자 최대값이므로 접미사 없이 충분할 가능성이 높으나 미검증. 검증 전에는 접미사 없는 ID를 쓴다.
- **Q4** — `claude-opus-4-8`을 `pricing`에 남길지. `tiers`에서 빠져도 프로브 rule2는 frontmatter 기준이라 무해하지만, 폴백 후보로 남길 근거는 있다.

## 다음 단계

`/change-request` — 이 문서를 입력으로 SPEC·feature_list·Sprint Contract를 갱신한다. D1(모델 정합화)과 D2~D5(행동 재튜닝)를 한 기능의 implementation_steps로 분리하되, 중간 상태에서 "Opus 5 + 4.8용 보정"이 공존하지 않도록 **같은 스프린트에서 완결**한다.
