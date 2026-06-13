# cc-harness 재귀적 자기개선 루프

## 문제 정의
cc-harness는 "소프트웨어를 일관된 품질로 개발하는 하네스"다. 그런데 하네스 자체도
소프트웨어다 — 따라서 **자기 자신을 자기 워크플로우로 개선**할 수 있어야 한다(dogfooding).
이번 세션의 v1.5.0→v1.6.0 작업이 이미 그 증거다: /change-request → Plan 게이트 → 구현 →
독립 evaluator → 코드리뷰 → finish-branch 흐름을 하네스 개선 자체에 적용했고, 코드리뷰가
evaluator 통과 코드에서도 High 5건을 더 잡았다.

목표: 이 일회성 흐름을 **반복 가능한 자기개선 루프**로 정착시키되, 재귀적 자기개선의
고유 위험 — 루프가 자기 검증 장치를 약화시키는 방향으로 "개선"하는 것 — 을 구조적으로 막는다.

## 결정 사항

### 1. 대상: cc-harness 자체 (dogfooding 정례 루프)
실사용 프로젝트가 아니라 하네스 repo 자체를 개선 대상으로 한다. 입력은 두 갈래:
- **backlog 소화**: session-handoff의 `follow_ups_backlog` 5건 (gate 캐시, tmpl 단일소스화,
  마이그레이션 version_lt, hooks 공용 lib.sh + bats helper, gate timeout)
- **자동 발견**: 하네스가 자신을 진단해 새 개선 항목을 생성

### 2. 자동 발견 메커니즘 (4개 진단 프로브)
각 프로브는 발견을 `progress/feature_list.json`의 후보로 환원한다:
- **self-review 프로브**: `/code-review high`를 하네스 diff(또는 전체)에 주기 실행 →
  confirmed findings를 개선 후보로
- **일관성 프로브**: 문서↔코드 drift (`/sync-docs`), 메타데이터 정합(skill 수, 버전),
  CLAUDE.md↔tmpl 동기화 — 이미 bats가 일부 검사
- **메트릭 프로브**: 테스트 수 추세, 커버리지, shellcheck 경고 수, 훅 실행 시간 —
  악화 방향이면 후보 생성
- **completeness critic**: "무엇이 빠졌나" — 미작성 ADR, 테스트 없는 훅 분기,
  문서화 안 된 설정

### 3. 불변식(INVARIANTS) 고정 — 자기약화 방지의 핵심
`docs/INVARIANTS.md`에 하네스의 **약화시킬 수 없는 성질**을 명문화한다. 예:
- evaluator는 독립적이다 (implementer가 passes를 set 못 함) — inline self-review로 대체 금지
- min-of-5 채점, security_tier critical 자동 fail 규칙
- pass_threshold·security_thresholds는 **낮출 수 없다** (높이는 건 허용)
- firewall의 파괴적 명령 deny 목록은 **축소 불가** (추가만)
- 테스트·기준은 add-only (완화/삭제는 사용자 승인)

루프(및 PreToolUse 훅 `invariant-guard.sh`)는 이 목록에 저촉되는 변경을 감지하면
**자동 차단하고 사람 승인을 요구**한다. 이것이 "불변식 고정 + 사람 승인" 안전장치다.

### 4. 루프 1회전 = 기존 워크플로우 1바퀴
새 워크플로우를 만들지 않는다 — **기존 게이트를 재사용**한다:
```
진단 프로브 → 후보 생성(feature_list) → 우선순위화 → /change-request → Plan 게이트(사람)
  → TDD 구현 → 독립 evaluator → /code-review → finish-branch → 메트릭 기록 → 다음 회전
```
재귀성은 "루프가 만든 개선이 다음 회전의 진단 품질을 높인다"는 데서 나온다
(예: completeness critic을 개선하면 다음 회전에서 더 많은 갭을 잡음).

### 5. 종료·페이싱
- 한 회전 = 1~2개 기능 (implementer 제약과 동일)
- backlog가 비고 자동 발견도 2회전 연속 새 항목 0이면 수렴 → 루프 종료
- 페이싱은 수동 트리거 기본 ("다음 회전 돌려") — 자율 주기(/loop)는 선택

## 검토한 대안

| 대안 | 기각 사유 |
|------|-----------|
| 실사용 프로젝트(pulse) 2-tier flywheel | 범위 과대 — 하네스 성숙이 선행되어야 함. 사용자가 cc-harness 자체로 한정 |
| backlog만 소화 (자동 발견 없음) | 유한·예측 가능하지만 재귀성이 없음 — 루프가 스스로 먹이를 못 찾음 |
| 사용 중 발견만 | 하네스를 안 쓰면 개선도 멈춤. 정례 진단이 더 능동적 |
| 독립 evaluator만으로 충분 (불변식 불필요) | 자기개선 루프는 evaluator 자체를 수정 대상으로 삼을 수 있음 — 메타 레벨 보호 필요 |
| 사람이 매 사이클 승인 | 안전하지만 자율 루프의 의미 상실. 불변식 저촉 시에만 승인으로 한정 |

## 제약·가정
- 새 게이트·에이전트를 만들지 않고 기존 것을 재사용 (altitude — 얕은 특수 케이스 금지)
- 진단 프로브는 가능한 기존 도구(`/code-review`, `/sync-docs`, bats, shellcheck)를 호출
- 불변식 가드는 결정론적 훅 — 프롬프트 규율이 아니라 PreToolUse에서 집행
- 자동 발견이 노이즈를 내면 루프가 망가짐 → 프로브는 confirmed/high-confidence만 후보화

## 보안 고려사항
- **security_tier: critical** — 불변식 가드(`invariant-guard.sh`)와 INVARIANTS.md 자체.
  이걸 우회·약화하는 변경은 firewall과 같은 등급으로 다룬다
- 자동 발견 프로브가 firewall/evaluator/임계값 파일을 수정 제안하면 자동으로 사람 승인 게이트
- 루프가 생성하는 커밋도 기존 pre-commit-gate(시크릿 스캔 등)를 그대로 통과해야 함

## 미해결 질문 (스펙 단계로)
1. invariant-guard.sh가 "임계값을 낮추는 변경"을 어떻게 탐지하나? (harness-config.json diff의
   수치 비교 + threshold/deny 목록 축소 감지 — 구현 난이도 확인 필요)
2. 메트릭 프로브의 추세 저장 위치·포맷 (`progress/metrics-history.json`?)
3. 자동 발견 후보의 중복 제거 — 이미 backlog/feature_list에 있는 항목 재생성 방지
4. completeness critic의 범위 — 너무 넓으면 노이즈, 좁으면 무용
5. 루프 1회전을 워크플로우로 묶을지 (/improve 스킬 신설) vs 수동 오케스트레이션
