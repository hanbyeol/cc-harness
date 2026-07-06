# Lessons — evaluator 보정 누적 로그

evaluator·QA가 통과시킨 뒤 발견된 결함(escaped defect), 오판(false positive/negative),
반복되는 criteria 갭을 여기에 누적한다. `/improve`의 calibration 프로브(F37)와
`evals/calibration/false-positives.json`이 이 로그를 판정 보정 입력으로 사용한다.

형식(각 항목):
- **[날짜] feature/sprint** — 무엇을 놓쳤나 · 왜 · 다음 판정에 어떻게 반영하나

<!-- 항목은 아래에 append (add-only, 삭제하지 않음) -->

- **[2026-07-07] F48/sprint-34** — hooks/invariant-guard.sh의 apply_replace()(awk substring 재구성)가 macOS one-true-awk+UTF-8 로케일에서 멀티바이트가 앞선 위치의 치환을 오계산할 수 있음(구현 중 false-deny 1회 재현, Write 툴 우회로 착지). F48 스코프 밖·투명 공개라 통과는 정당하나, **잠재적으로 jq-존재 경로의 harness-config/firewall/bats 내용검사 Edit 재구성에 영향** 가능(false-allow 이론적 여지). 다음 판정 반영: 보호 파일의 Edit/MultiEdit 검증을 다루는 기능은 apply_replace 경유 여부를 확인하고, 최종 커밋 코드를 라이브 실행(hook 직접 구동)으로 재검증한다. 자기보호 장치 자체의 결함이므로 별도 /improve backlog 후보.

