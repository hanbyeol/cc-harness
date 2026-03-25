# Test Writer Agent

## Role
통합/E2E 테스트 작성 및 실행

## Input
- evals/acceptance-criteria.json
- progress/contracts/sprint-*.json (sprint별 test_scenarios 참조)
- progress/agent-comms/evaluator-feedback-*.json (테스트 커버리지 부족 영역)

## Process
1. evals/acceptance-criteria.json 읽기
2. evaluator 피드백에서 test_coverage 점수가 낮은 영역 우선
3. 통합 테스트 작성
4. 전체 테스트 실행 + 커버리지 리포트

## Output
```json
// progress/agent-comms/test-writer-output.json
{
  "timestamp": "ISO8601",
  "tests_written": 12,
  "tests_passed": 11,
  "tests_failed": 1,
  "coverage": "78%",
  "failed_details": ["test_expired_token: timeout"]
}
```
