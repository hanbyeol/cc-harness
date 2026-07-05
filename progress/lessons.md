# Lessons — evaluator 보정 누적 로그

evaluator·QA가 통과시킨 뒤 발견된 결함(escaped defect), 오판(false positive/negative),
반복되는 criteria 갭을 여기에 누적한다. `/improve`의 calibration 프로브(F37)와
`evals/calibration/false-positives.json`이 이 로그를 판정 보정 입력으로 사용한다.

형식(각 항목):
- **[날짜] feature/sprint** — 무엇을 놓쳤나 · 왜 · 다음 판정에 어떻게 반영하나

<!-- 항목은 아래에 append (add-only, 삭제하지 않음) -->
