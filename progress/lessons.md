# Lessons — evaluator 보정 누적 로그

evaluator·QA가 통과시킨 뒤 발견된 결함(escaped defect), 오판(false positive/negative),
반복되는 criteria 갭을 여기에 누적한다. `/improve`의 calibration 프로브(F37)와
`evals/calibration/false-positives.json`이 이 로그를 판정 보정 입력으로 사용한다.

형식(각 항목):
- **[날짜] feature/sprint** — 무엇을 놓쳤나 · 왜 · 다음 판정에 어떻게 반영하나

<!-- 항목은 아래에 append (add-only, 삭제하지 않음) -->

- **[2026-07-07] F48/sprint-34** — hooks/invariant-guard.sh의 apply_replace()(awk substring 재구성)가 macOS one-true-awk+UTF-8 로케일에서 멀티바이트가 앞선 위치의 치환을 오계산할 수 있음(구현 중 false-deny 1회 재현, Write 툴 우회로 착지). F48 스코프 밖·투명 공개라 통과는 정당하나, **잠재적으로 jq-존재 경로의 harness-config/firewall/bats 내용검사 Edit 재구성에 영향** 가능(false-allow 이론적 여지). 다음 판정 반영: 보호 파일의 Edit/MultiEdit 검증을 다루는 기능은 apply_replace 경유 여부를 확인하고, 최종 커밋 코드를 라이브 실행(hook 직접 구동)으로 재검증한다. 자기보호 장치 자체의 결함이므로 별도 /improve backlog 후보.

- **[2026-07-07] F49/sprint-35 (위 F48 우려 해소·근본원인 정정)** — 위 misdiagnosis('macOS awk+UTF-8 멀티바이트')를 evaluator 재현으로 정정: 진짜 원인은 `awk -v var=value`가 값을 **awk 문자열-리터럴 소스로 처리**하는 것(로케일/멀티바이트/OS 무관). 두 증상이 동일 근본원인에서 나옴 — (1) 백슬래시 이스케이프 소거(`printf 'A\\\nB'` 4바이트 → `-v` length 3, `ENVIRON[]` length 4), (2) one-true-awk의 '리터럴 개행 거부'(`awk: newline in string`)로 **멀티라인 old_string 전체 실패** → 함수 fallback이 원본 반환 → 약화검사 '변경 없음' 오판 = false-allow. 기존 라이브 self-protection 테스트가 이걸 못 잡은 이유: 전부 단일라인 old_string 또는 Write 경로라 escape/개행 경로를 안 탐. 수정=ENVIRON[] 경유(양 facet 모두 해소), 독립 재현으로 pre-fix false-allow / post-fix deny 실증. **판정 습관**: 근본원인 주장은 evaluator가 pre/post 코드 양쪽을 직접 실행(격리 source)해 mutation-proven RED→GREEN으로 재확인 — implementer의 진단 서술을 그대로 신뢰하지 않는다. **다음 회전 후보**: apply_replace의 라이브-훅 end-to-end false-allow 테스트(멀티라인/백슬래시 old_string으로 deny 제거 시 run_write 경유 deny) 추가 — 현재는 함수-단위 커버리지.

- **[2026-07-20] F52/sprint-38 (pass, 잔존 구멍 기록)** — 반복 패턴: **같은 불변식을 검사하는 추출기가 두 벌 존재하고 강도가 다르면, 약한 쪽이 실제 방어선이 되는 경로가 생긴다**. F52는 배선 대칭을 (1) CI 테스트 `.hooks|.[]|.[]|.hooks[]|.command`(구조 앵커)와 (2) 런타임 가드 `..|objects|.command`(비앵커) 두 벌로 검사한다. 저장소는 (1)이 지키지만 **설치된 프로젝트에는 CI가 없어 (2)가 유일한 층**이고, evaluator 직접 재현 결과 (2)는 matcher 무력화·hooks 키 구조 이동·미끼 문자열 3종을 모두 통과시켰다(exit 0) — F52가 닫으려던 '게이트가 조용히 실행되지 않는' 실패 클래스가 그 경로에 잔존. **판정 습관**: 방어가 CI+런타임 2층이면 각 층을 **독립적으로** mutation 테스트한다. 전체 스위트 green은 '약한 층이 무엇을 놓치는지'를 알려주지 않는다. **기준 습관**: 보호 대상이 '집합'인 SC는 집합 보존이 곧 실효성 보존인지 확인 — basename 부분집합 보존은 게이트 실행 도달성을 보장하지 않는다.

- **[2026-07-20] F52/sprint-38 2차 judge (fail — 위 항목 정정)** — 위 항목은 f3801d0 수정 후를 'pass, 잔존 구멍'으로 기록했으나 2차 독립 판정 결과 **verdict fail**(min-of-5=6, security 6 < critical 임계 7). 3종 우회는 실제로 닫혔음을 직접 재현 확인했으나, **같은 실패 클래스의 새 인스턴스**가 즉시 발견됨: command에 `true # ` 접두를 붙이면 훅은 아무것도 실행하지 않으면서 추출 튜플이 원본과 동일해 exit 0(변형 3개 전부 재현: `true # <cmd>`, `true#<cmd>`, `bash -c : # /x/invariant-guard.sh`). 근본 원인은 wired_set()의 awk `sub(/.*\//)`가 마지막 슬래시 이전을 통째로 버려, 슬래시를 포함한 임의 shell 코드를 접두로 허용한다는 점. **반복 패턴(핵심)**: *실증된 인스턴스를 하나씩 닫는 수정은 클래스를 닫지 못한다* — F52 수정도 테스트도 1차가 재현한 3개를 그대로 인코딩했다. **판정 습관**: (1) 안전장치 수정은 '인스턴스가 닫혔는가'가 아니라 '클래스가 닫혔는가'로 묻고, 같은 클래스 변형을 최소 3개 새로 만들어 재현한다. (2) 커밋이 문서에 **새 보증**을 선언하면(여기선 INVARIANTS.md '실행 도달성 보호') 그 보증의 반증 시도를 판정에 포함한다 — 코드보다 강한 문서는 그 자체가 결함이다. (3) 게이트를 **강화**하는 편집이 통과하는지도 확인한다(과잉 차단 발견: matcher를 `|NotebookEdit`로 넓히면 exit 2). **기준 습관**: critical 안전장치의 security_criteria는 인스턴스 열거식이 아니라 속성 기반으로 — '가드 통과 후의 설정으로 실제 디스패치했을 때 훅이 실행되는가'.

