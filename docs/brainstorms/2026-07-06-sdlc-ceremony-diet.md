# cc-harness SDLC 의례(ceremony) 다이어트

## 문제 정의
cc-harness는 정밀해지고 견고해졌지만(F1~F47), 그 대가로 느려지고 토큰 소모가 커졌다는
진단이 나왔다. 데이터로 확인된 두 가지 축:

1. **크기 무관 균일한 풀 사이클**: 1줄 정규식 수정이든 신규 기능이든 `/change-request`를
   거치면 항상 SPEC/feature_list/Sprint Contract 갱신 → Plan 게이트 → implement →
   evaluator(5차원, critical이면 +security-auditor) 동일 경로를 탄다. `/hotfix`라는
   경량 경로가 이미 존재하지만, 크기 판단은 사용자(또는 /improve)의 재량에 맡겨져 있어
   실제로는 거의 항상 무거운 경로로 흘러간다.
2. **기능당 절차 오버헤드**: 47개 기능 → 182개 커밋(평균 3.9개/기능). 기능마다
   `feat` 커밋 + `chore: record evaluator pass` 커밋 + 거의 매번 버전 bump가 따라붙는다.
   최근 F38~F47은 프로브가 프로브를, evaluator가 evaluator를 진단하는 자기참조 체인
   (F43→F44→F45→F46→F47이 서로의 갭을 계속 발견)으로 흘러 수확체감 국면에 들어갔다.

이번 회전에서 다룬 범위: **일반 SDLC 전체**(하네스 자기개선 `/improve`뿐 아니라
`/change-request`·`/implement`를 타는 모든 실사용 기능 개발 포함). 두 축(균일한 풀
사이클, 절차 오버헤드) 모두 비슷하게 문제로 지목되었다.

## 결정 사항

### 1. 사전 티어 게이트 — `/change-request` Step 1에 자동 분류 추가
`/change-request`의 Step 1(변경 영향 분석)에 `/hotfix`의 기존 적용 조건을 그대로
재사용하는 분류 스텝을 삽입한다:
- **조건 충족**(≤3파일 · 버그수정/사소한 개선 · `security_tier: critical`의 보안 관련
  변경 아님) → `/hotfix`로 자동 전환. evaluator 생략, 기존 hotfix 안전장치
  (범위 확대 시 `/implement` 전환, 연속 3회 남용 경고) 그대로 적용.
- **조건 미충족**(신규 기능 · 아키텍처 변경 · critical 보안 로직) → 기존 풀 경로 유지,
  변경 없음.

`/improve` §4(처리 단계)도 후보를 `/change-request`에 넘기기 전에 동일 분류를 적용해,
자기개선 루프의 소규모 후보(예: word-boundary 정밀화류)도 같은 혜택을 받는다.

**critical tier는 이 분류와 무관하게 항상 풀 사이클(evaluator+security-auditor)을
탄다** — 이번 회전의 비타협 선.

### 2. 커밋/버전 배치화 — `/improve --auto N` 배치에 한정
범위를 좁게 잡는다: **`/improve --auto N` 무인 배치 모드에서만** 적용.
- 배치 내 각 회전은 독립 evaluator 게이트(min-of-5, 무약화)를 그대로 통과해야 한다 —
  게이트 강도는 손대지 않는다.
- 달라지는 것은 **기록 방식**뿐: 회전마다 별도 `chore: record evaluator pass` 커밋과
  버전 bump를 만드는 대신, 각 회전의 evaluator 판정을 배치 내 임시 기록(예:
  `progress/agent-comms/`)으로만 남기고, `feat` 커밋에는 판정 요약을 트레일러로 남긴다.
  버전 bump와 통합 판정 기록 커밋은 **N회전(또는 중단 조건 도달) 종료 시 1회**만 수행한다.
- 수동 `/improve`(1회전, 사람이 매번 후보 선택) · 일반 `/change-request`→`/implement`
  워크플로우는 **변경하지 않는다** — 현재도 사용자 페이싱이라 매 회전 커밋이 과도한
  의례로 보이지 않고, 배치화 대상이 아니다고 판단.

## 검토한 대안

| 대안 | 채택 여부 | 사유 |
|------|-----------|------|
| A. 사전 티어 게이트 + 커밋 배치화 | **채택** | 기존 게이트(`/hotfix` 안전장치, evaluator 불변식) 재사용만으로 두 통증 지점을 직접 겨냥. 신규 위험 표면 없음 |
| B. 컨텍스트 다이어트(CLAUDE.md 슬리밍, 에이전트 홉 fork 통합) | 다음 회전으로 연기 | 구조적으로 유효하지만 설계 표면이 넓고(에이전트 오케스트레이션 변경) 간접 효과 — 이번엔 A로 즉시 착수, B는 backlog |
| 버전 bump을 전체 워크플로우에서 릴리스 시점으로 일반화 | 기각(이번 회전) | 폭넓지만 "무엇이 릴리스 시점인가"를 판단하는 사용자 로직이 추가로 필요 — `--auto N` 배치처럼 경계가 명확한 곳부터 좁게 시작 |
| 모든 기능을 동일 무게로 유지(현행 유지) | 기각 | 사용자가 명시적으로 느림·토큰 과다를 문제로 지목, 데이터로도 확인됨 |

## 제약·가정
- 새 게이트·새 평가 기준을 만들지 않는다 — `/hotfix`의 기존 조건과 evaluator 불변식을
  그대로 재사용
- `security_tier: critical`은 분류 결과와 무관하게 항상 풀 사이클(evaluator+
  security-auditor) — 절대 예외 없음
- 커밋 배치화는 `/improve --auto N`에만 국한 — 수동 워크플로우의 절차·감사 추적은
  현행 유지
- 변경 대상 파일(`skills/change-request/SKILL.md`, `skills/improve/SKILL.md`)은
  invariant-guard 보호 목록(`harness-config.json`·`hooks/*.sh`·`agents/evaluator.md`·
  `INVARIANTS.md`·`hooks.json`·`.claude/settings*.json`·`feature_list.json`·
  `tests/*.bats`)에 포함되지 않음 — 일반 `/change-request` 경로로 진행 가능

## 보안 고려사항
- security_tier: standard — 프로세스 오케스트레이션 변경이며 evaluator·firewall·
  임계값 자체는 건드리지 않음
- 오분류 위험: hotfix 조건 판단이 잘못되면 실제로는 크거나 위험한 변경이 경량 경로로
  샐 수 있음 → 완화책은 `/hotfix`에 이미 있는 안전장치(범위 확대 감지 시 자동
  `/implement` 전환, 연속 남용 경고)를 그대로 재사용하는 것으로 충분하다고 판단
- 배치화된 evaluator 판정 기록도 최종적으로는 커밋 이력에 남아야 함(감사 추적 보존) —
  "회전마다 커밋" → "배치 종료 시 요약 커밋"으로 형태만 바뀌고 판정 자체의 기록은
  누락되지 않아야 함 (스펙 단계에서 구체화)

## 미해결 질문 (스펙 단계로)
1. `/change-request` Step 1의 자동 분류 로직을 어떤 형태로 구현할지(체크리스트 프롬프트
   vs 스크립트화) — `/hotfix`의 "적용 조건"·"부적합한 경우" 문구를 그대로 인용/참조할지,
   중복 없이 링크만 걸지
2. `--auto N` 배치 중단(중단 조건 4종 중 하나 도달)이 N 미도달로 조기 종료될 때도
   "배치 종료 1회 커밋" 규칙을 그대로 적용할지(부분 배치도 요약 커밋 1회로 처리)
3. 배치 요약 커밋 메시지 포맷 — 배치 내 N개 기능의 evaluator 판정을 어떻게 압축
   표기할지(예: `F48-F52 evaluator pass batch (min-of-5: 8,7,8,9,7)`)
4. Alternative B(컨텍스트 다이어트)의 스코프 확정은 다음 `/improve` 회전으로 이월
