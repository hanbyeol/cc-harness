# ADR-008: CLAUDE.md 라우팅 표를 스킬 TRIGGER와의 중복에도 불구하고 유지

**Status**: Accepted (sprint-44 / F58)

## Context

Anthropic 컨텍스트 엔지니어링 블로그(2026-07-24)는 상시 로드 컨텍스트에서 중복을 제거하라고 권고한다. 이 기준으로 하네스를 실측하니 정확히 걸리는 지점이 하나 나왔다.

`CLAUDE.md`의 "요청 → 행동 라우팅" 표는 11행이고, TRIGGER 문구를 가진 스킬도 11개다. **1:1 중복**이다. 스킬 `description`의 TRIGGER가 이미 자동 라우팅을 수행하는데, 상시 로드되는 `CLAUDE.md`가 같은 매핑을 한 번 더 적는다. 표를 지우면 상시 컨텍스트에서 약 8줄이 빠진다.

F56(sprint-42)에서 실제로 지워 봤고, 구현 자체는 동작했다(`CLAUDE.md` 65→57줄). 롤백한 이유는 구현 실패가 아니라 **하네스가 F29에서 이미 반대 결정을 내려 검증 장치로 고정해 두었기** 때문이다.

F58에서 착수 전 전수 조사(AC-1)를 수행하니 강제 지점이 F56이 파악한 3개가 아니라 **7개**였다:

| 지점 | 강제 내용 |
|---|---|
| `tests/efficiency.bats` — F29 "diet keeps all 11 skills routed (repo & tmpl)" | 11개 스킬 전부, repo와 템플릿 양쪽 |
| `tests/efficiency.bats` — F29 "diet preserves SENTINEL + tiering + plan-review" | 센티넬·티어링·plan-review |
| `tests/efficiency.bats` — F19 "CLAUDE.md carries the tier->verification mapping" | 검증 티어 매핑 |
| `tests/skill-frontmatter.bats` — "every skill appears in CLAUDE.md and template routing" | 스킬↔라우팅 대칭 |
| `scripts/probes/consistency.sh:41` | `CLAUDE.md`·`templates/CLAUDE.md.tmpl`·`README.md` **3곳 전부** |
| `tests/probes.bats` — consistency 후보 반환 테스트 | 위 프로브의 회귀 잠금 |
| `tests/profile.bats:39` | iac 프로파일 `CLAUDE.md`에 plan-review |

## Decision

**라우팅 표를 유지한다.** 측정된 11:11 중복은 제거 대상이 아니라 **알려진 트레이드오프**로 문서화한다.

## Rationale

얻는 것은 상시 컨텍스트 8줄이고, 잃는 것은 **TRIGGER만으로 라우팅이 실제로 도달하는가에 대한 보장**이다. 이 교환이 성립하지 않는다.

1. **중복 제거의 근거는 정적 대조뿐이다.** 계약의 SC-2가 요구한 "제거 행별 TRIGGER 키워드 1:1 대조표"는 텍스트가 서로를 커버한다는 것만 보인다. TRIGGER가 실제 사용자 발화를 스킬로 라우팅하는지는 **측정한 적이 없다**. 커버되지 않는 행을 지우면 요청이 스킬에 도달하지 못하고 워크플로우 자체가 우회된다 — 예를 들어 기능 변경이 `/change-request`를 거치지 않게 되며, 이는 게이트 우회와 같은 결과다.

2. **F57에서 세운 원칙의 반대 방향이다.** F57은 `effort` frontmatter의 적용 여부를 규명하지 못했다는 이유로 선언하지 않았다 — "적용되지 않을 수 있는 선언은 거짓 보증"이기 때문이다. 여기서 미검증 상태로 기존 보장을 **제거**하는 것은 같은 불확실성을 반대 방향으로 처리하는 것이다. 불확실할 때 보수적인 쪽은 유지다.

3. **해체 비용이 절감을 넘어선다.** 7개 지점을 일관되게 바꿔야 하고 그중 3개는 `tests/*.bats`(invariant-guard 보호 대상), 1개는 설치되는 모든 프로젝트에 영향을 주는 템플릿이다. 8줄을 위해 검증 장치 7개를 해체하는 것은 비율이 맞지 않는다.

4. **F29의 원래 이유가 여전히 유효하다.** F29는 "다이어트 중 라우팅 유실 방지"로 이 불변식을 세웠다. F56에서 실제로 다이어트 도중 라우팅이 지워졌고 테스트가 잡아냈다 — 불변식이 설계된 대로 작동한 사례다.

## Alternatives considered

- **(B) 불변식 폐기 후 전 계층 일관 갱신** — 블로그 기준과 실측 중복이 근거. 기각: 위 1~3. 템플릿 변경이 설치된 모든 프로젝트에 전파되는 점도 부담이다.
- **(C) 하네스 자신의 `CLAUDE.md`만 축소, 템플릿·README 유지** — F56이 시도한 경로. 기각: F29 테스트가 `(repo & tmpl)` 양쪽을 강제하고 `consistency.sh`가 3곳을 요구하므로 결국 테스트 수정을 수반한다. "부분"이 실제로는 부분이 아니다.
- **TRIGGER 라우팅 실측 후 재판단** — 기각하지 않고 **보류**한다. 라우팅 도달률을 측정할 방법이 생기면 이 ADR을 재검토할 근거가 된다. 그때까지는 유지가 기본값이다.

## Consequences

- 상시 컨텍스트에 약 8줄의 중복이 남는다. 이것은 인지된 비용이며 결함이 아니다.
- 프로브나 후속 진단이 같은 중복을 다시 후보로 올릴 수 있다. **이 ADR이 그 판단 근거다** — 재논의하려면 "TRIGGER 라우팅이 실제로 도달한다"는 측정을 새로 가져와야 한다.
- F58의 나머지 축(스킬 점진적 공개)은 이 결정과 독립적으로 진행했다.
