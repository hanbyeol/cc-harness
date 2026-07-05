---
name: improve
description: "하네스 자기개선 루프 1회전. TRIGGER: 사용자가 '자기개선', '하네스 개선', '다음 개선', '진단 돌려', 'improve', '스스로 개선' 등 하네스(또는 프로젝트) 자신의 품질을 진단·개선하려 하면 이 스킬 실행. 새 게이트를 만들지 않고 기존 워크플로우(change-request→Plan→evaluator→finish-branch)를 오케스트레이션한다."
---
# /improve — 재귀적 자기개선 루프 (1회전)

하네스가 자신을 진단해 개선 후보를 생성하고, **기존 게이트로** 1개 개선을 끝까지 처리한다.
새 워크플로우를 만들지 않는다 — 이미 검증된 절차를 엮을 뿐이다.

## 사용법
```
/improve              # 진단 → 후보 제시 → 1회전 처리
/improve --diagnose   # 진단만 (후보 목록 출력, 처리 안 함)
```

## Process

### 1. 진단 — 자동 발견 프로브
`scripts/probes/run-all.sh {ISO-timestamp}` 실행. 8개 프로브가 후보를 생성한다:
- **consistency**: 매니페스트 버전·구성요소 수·스킬 라우팅 불일치
- **metrics**: 테스트 수 감소·shellcheck 경고 증가 (progress/metrics-history.json 추세)
- **completeness**: 테스트 없는 훅, TRIGGER 없는 스킬, 참조되나 없는 파일
- **self-review**: FIXME/TODO 주석, shellcheck 경고
- **model-tiering**: agent↔model 난이도 역전 (config/models.json)
- **evidence**: evidence 없이 완료 선언한 산출물 (evidence over claims 집행)
- **behavioral**: 위험 명령/도구 코퍼스를 실제 firewall 훅에 주입해 allow 누출을 검사 —
  정적 프로브가 못 보는 **행위 결함**을 잡는다("0건 = 확인함"이 되게)
- **calibration**: 최신 evaluator 판정을 감사 — score≠min-of-5(산술 오류)·verdict/score 모순·
  evidence 없는 pass, 그리고 golden-set의 동일 tier 과거 pass 분포를 벗어난 점수(grade drift)를
  후보로. 단일 judge의 자기 결함을 잡는다(판정 코퍼스 evals/calibration/golden-set.json 소비, F37)

run-all은 이미 feature_list/backlog에 있는 항목을 **중복 제거**하고 임시 id(C1,C2…)를 붙인다.
- **정적 프로브의 한계**: consistency·completeness·self-review 등은 grep/jq 신호만 본다 — 훅 행위
  결함은 behavioral 프로브가, 논리 결함은 `/code-review high`가 보강한다(전체 리뷰는 별도).

### 2. 후보 우선순위화 + 제시
- security_tier(critical>standard>low)와 심각도로 정렬
- 사용자에게 후보 목록을 제시하고 **이번 회전에 처리할 1개**를 선택받는다
  (서브에이전트는 사용자에게 질문할 수 없으므로 선택은 메인 루프가 수집)
- 후보 0건이면 수렴 판정(아래)으로

### 3. 불변식 가드 체크 (자동 진행 금지 경계)
선택된 후보가 다음 파일을 건드리면 **자동 진행하지 않고 명시적 사람 승인을 요구**한다:
- `progress/harness-config.json`(임계값), `hooks/pre-bash-firewall.sh`(deny 목록),
  `agents/evaluator.md`, `docs/INVARIANTS.md`, `hooks/invariant-guard.sh`
- 이들은 검증 장치다 — 약화 방향 변경은 INVARIANTS.md 위반이며 F12 가드가 편집 시점에도 차단한다
- 강화(임계값 상향·deny 추가·테스트 추가)는 정상 진행 가능하나, 변경 의도를 사용자에게 명확히 고지

### 4. 처리 — 기존 게이트 재사용
선택된 후보를 다음 순서로 끝까지 처리한다 (각 단계는 해당 스킬/에이전트의 기존 절차):
1. `/change-request {후보 설명}` — 산출물(feature_list, Sprint Contract) 갱신
2. **Plan 게이트** — ExitPlanMode로 사용자 승인 (승인 없이 구현 안 함)
3. `/implement` — TDD(RED-GREEN-REFACTOR) 구현 + evidence
4. **독립 evaluator** — 5차원 채점, min-of-5 (implementer가 통과 판정 못 함)
5. `/code-review high` — evaluator가 못 본 결함 보강
6. `/finish-branch` — 테스트 게이트 → 머지 (머지 verified 후에만 브랜치 삭제)

### 5. 회전 결과 기록 + 수렴 판정
- `scripts/probes/metrics.sh {timestamp}`로 이번 회전 후 메트릭 기록 (다음 회전 추세 비교용)
- **수렴**: backlog가 비고 자동 발견이 **2회전 연속 신규 후보 0건**이면 "루프 수렴" 안내 후 종료
- 그 외: 다음 회전을 이어갈지 사용자에게 확인

## 재귀성
루프가 만든 개선이 **다음 회전의 진단 품질을 높인다** — 예: completeness 프로브를 개선하면
다음 회전에서 더 많은 갭을 발견한다. 프로브 자체도 /improve의 개선 대상이 될 수 있다
(단, evaluator·firewall·임계값을 약화하는 방향은 불변식 가드가 막는다).

## Constraints
- 한 회전에 1개 개선만 (집중도 — implementer 제약과 동일)
- 새 게이트·새 평가 기준을 만들지 않는다 — 기존 워크플로우 오케스트레이션만
- 불변식(검증 장치 약화)에 저촉되는 후보는 자동 진행 금지 — 사람 승인 필수
- 프로브는 읽기 전용(metrics-history append 외 파일 수정 없음), firewall 정책 우회 금지
- 후보가 노이즈면 처리하지 말고 skip — 무리하게 개선 항목을 만들지 않는다
