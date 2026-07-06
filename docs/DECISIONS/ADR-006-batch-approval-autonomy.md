# ADR-006: 배치 승인 무인 자기개선 루프 (`/improve --auto`)

**Status**: Accepted (v1.21.0, sprint-25 / F39)

## Context

`/improve`(F14)는 자기개선 루프 1회전을 오케스트레이션하지만 **매 회전 사람이 후보 1개를 선택**해야 진행된다. 이는 harness/loop-engineering 캐논(Geoffrey Huntley의 ralph loop, Dex Horthy의 RPI)이 지적하는 지점과 어긋난다: **백프레셔(자동 게이트)가 충분하면 루프를 무인으로 돌리고 인간은 루프를 *관찰*하며, 실패를 하네스 개선으로 환류한다.** cc-harness는 이미 강한 백프레셔를 갖췄다 — invariant-guard(INV-1~11), bats 470+개, 독립 evaluator min-of-5, Stop 게이트. 즉 무인 루프의 전제 조건은 충족돼 있는데, 매 턴 사람 선택이 그 자율성을 막고 있었다.

동시에 무인 루프는 위험하다: 자동 루프가 **검증 장치 자체를 약화**시키는 방향으로 개선을 시도하면(임계값 하향, deny 목록 축소, evaluator 규칙 완화) 게이트가 스스로 무너진다. F12/INVARIANTS의 전체 위협 모델이 바로 "자동화된 `/improve` 루프가 게이트를 스스로 낮추는 것"이었다.

## Decision

`/improve --auto N` 모드를 추가한다. **배치 Plan 게이트 1회**로 범위를 승인받고 N회전을 무인 반복하되, 검증 게이트는 매 회전 무약화로 유지한다.

### 배치 승인 의미론 — 무엇을 대체하고, 무엇을 대체하지 않는가

**대체하는 것**: 개별 회전의 "후보 선택 + Plan 게이트" 사람 개입. 사용자는 배치 게이트에서 (a) 후보 필터, (b) N(기본 5, 최대 10), (c) 중단 조건을 한 번 승인하고, 그 범위 안에서 루프는 무인으로 돈다.

**대체하지 *않는* 것**(무인 모드가 우회하지 못하는 것):
- **검증 게이트 전부** — invariant-guard(편집 시점 차단), bats 전체(무회귀), 독립 evaluator(min-of-5, implementer는 passes 못 set), Stop 게이트. 매 회전 동일 강도.
- **critical 티어·검증 장치 대상 후보** — `harness-config.json`·`hooks/*firewall*.sh`·`invariant-guard.sh`·`INVARIANTS.md`·`hooks.json`·`agents/evaluator.md`·`feature_list.json` 및 `security_tier=critical` 후보는 **무인으로 절대 처리하지 않고** `progress/approval-queue.json`에 사람 승인 큐로 적립한다. 이것이 이 ADR의 안전 핵심이다: 무인 자율성은 **저위험 개선에만** 부여되고, 게이트·임계값·denylist를 건드리는 변경은 언제나 사람을 거친다.

### 중단 조건 (4종, 하나라도 충족 시 종료)
1. **evaluator fail 2회 연속** — 루프가 품질을 만들지 못하는 신호.
2. **invariant-guard 차단 발생** — 자동 루프가 검증 장치를 약화하려 시도한 신호(즉시 중단, 해당 후보 승인 큐로).
3. **신규 후보 0** — 수렴.
4. **N 회전 도달** — 배치 상한.
종료 시 사유·진행 요약을 세션 핸드오프에 기록해 다음 세션이 이어받게 한다.

### F35(INV-11) 선행 전제
무인 루프는 passes 전환이 기계 검증되는 F35(INV-11) **위에서만** 안전하다 — 무인 evaluator가 passes를 뒤집을 때 invariant-guard가 feedback 존재·min-of-5·critical 보안을 재검증하므로, 무인 루프가 근거 없이 통과 판정을 내리는 것이 결정론적으로 차단된다.

## Consequences

**긍정**: 사용자의 자율성 우선 선호와 정합. 저위험 백로그(문서 drift, 프로브 정밀화, 테스트 보강)를 무인으로 소화해 사람의 개입을 critical·검증장치 변경에 집중시킨다(Böckeler의 "입력을 가장 중요한 곳에 배분").

**부정/위험**: 배치 승인은 개별 검토보다 신뢰를 앞당긴다. 완화책 — critical/invariant 제외(위), 중단 조건 4종, 각 회전 git 커밋으로 롤백 용이, N 상한. 그럼에도 이는 **정책 신뢰의 이동**이므로 security_tier critical로 취급하고 security-auditor 검증을 거쳐 도입한다.

**대안 (기각)**: (a) 완전 무인(무제한 루프) — 폭주·게이트 침식 위험으로 기각. (b) 현행 유지(매 턴 사람) — 자율성 목표 미달. 배치 승인은 둘 사이의 균형: 범위는 사람이 정하고, 실행은 게이트가 지킨다.
