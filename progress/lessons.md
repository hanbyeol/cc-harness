# Lessons — evaluator 보정 누적 로그

evaluator·QA가 통과시킨 뒤 발견된 결함(escaped defect), 오판(false positive/negative),
반복되는 criteria 갭을 여기에 누적한다. `/improve`의 calibration 프로브(F37)와
`evals/calibration/false-positives.json`이 이 로그를 판정 보정 입력으로 사용한다.

형식(각 항목):
- **[날짜] feature/sprint** — 무엇을 놓쳤나 · 왜 · 다음 판정에 어떻게 반영하나

<!-- 항목은 아래에 append (add-only, 삭제하지 않음) -->

- **[2026-07-07] F48/sprint-34** — hooks/invariant-guard.sh의 apply_replace()(awk substring 재구성)가 macOS one-true-awk+UTF-8 로케일에서 멀티바이트가 앞선 위치의 치환을 오계산할 수 있음(구현 중 false-deny 1회 재현, Write 툴 우회로 착지). F48 스코프 밖·투명 공개라 통과는 정당하나, **잠재적으로 jq-존재 경로의 harness-config/firewall/bats 내용검사 Edit 재구성에 영향** 가능(false-allow 이론적 여지). 다음 판정 반영: 보호 파일의 Edit/MultiEdit 검증을 다루는 기능은 apply_replace 경유 여부를 확인하고, 최종 커밋 코드를 라이브 실행(hook 직접 구동)으로 재검증한다. 자기보호 장치 자체의 결함이므로 별도 /improve backlog 후보.

- **[2026-07-07] F49/sprint-35 (위 F48 우려 해소·근본원인 정정)** — 위 misdiagnosis('macOS awk+UTF-8 멀티바이트')를 evaluator 재현으로 정정: 진짜 원인은 `awk -v var=value`가 값을 **awk 문자열-리터럴 소스로 처리**하는 것(로케일/멀티바이트/OS 무관). 두 증상이 동일 근본원인에서 나옴 — (1) 백슬래시 이스케이프 소거(`printf 'A\\\nB'` 4바이트 → `-v` length 3, `ENVIRON[]` length 4), (2) one-true-awk의 '리터럴 개행 거부'(`awk: newline in string`)로 **멀티라인 old_string 전체 실패** → 함수 fallback이 원본 반환 → 약화검사 '변경 없음' 오판 = false-allow. 기존 라이브 self-protection 테스트가 이걸 못 잡은 이유: 전부 단일라인 old_string 또는 Write 경로라 escape/개행 경로를 안 탐. 수정=ENVIRON[] 경유(양 facet 모두 해소), 독립 재현으로 pre-fix false-allow / post-fix deny 실증. **판정 습관**: 근본원인 주장은 evaluator가 pre/post 코드 양쪽을 직접 실행(격리 source)해 mutation-proven RED→GREEN으로 재확인 — implementer의 진단 서술을 그대로 신뢰하지 않는다. **다음 회전 후보**: apply_replace의 라이브-훅 end-to-end false-allow 테스트(멀티라인/백슬래시 old_string으로 deny 제거 시 run_write 경유 deny) 추가 — 현재는 함수-단위 커버리지.

