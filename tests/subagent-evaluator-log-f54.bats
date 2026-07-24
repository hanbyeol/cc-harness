#!/usr/bin/env bats

# subagent-evaluator-log.sh tests (F54)
# SubagentStop(^cc-harness:evaluator$) 훅: evaluator 실행을 evaluator-runs.jsonl에 append.
# 순수 기록 훅 — 어떤 입력에도 evaluator 흐름을 막지 않기 위해 항상 exit 0.

PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
HOOK="$PLUGIN_ROOT/hooks/subagent-evaluator-log.sh"
RUNS="progress/agent-comms/evaluator-runs.jsonl"

setup() {
  WORK=$(mktemp -d)
  cd "$WORK" && git init -q .
}

teardown() { rm -rf "$WORK"; }

run_hook() {
  # $1 = stdin JSON
  printf '%s' "$1" | CLAUDE_PROJECT_DIR="$WORK" bash "$HOOK"
}

@test "F54 hook: records an evaluator run with agent_id + epoch, exit 0" {
  run run_hook '{"agent_id":"ev-1","agent_transcript_path":"/t/x.jsonl","session_id":"s1","agent_type":"cc-harness:evaluator"}'
  [ "$status" -eq 0 ]
  [ -f "$RUNS" ]
  [ "$(jq -r '.agent_id' "$RUNS")" = "ev-1" ]
  # epoch는 정수이고 지금 시각 근처(±120s)여야 한다
  local now; now=$(date +%s)
  jq -e --argjson now "$now" '(.epoch|type=="number") and (.epoch >= $now-120) and (.epoch <= $now+120)' "$RUNS"
}

@test "F54 hook: appends (does not overwrite) across multiple runs" {
  run_hook '{"agent_id":"ev-1","agent_type":"cc-harness:evaluator"}'
  run_hook '{"agent_id":"ev-2","agent_type":"cc-harness:evaluator"}'
  [ "$(grep -c '' "$RUNS")" -eq 2 ]
  [ "$(jq -r '.agent_id' "$RUNS" | tail -1)" = "ev-2" ]
}

@test "F54 hook: non-evaluator agent_type is filtered (no record)" {
  run run_hook '{"agent_id":"im-1","agent_type":"cc-harness:implementer"}'
  [ "$status" -eq 0 ]
  # 레코드 파일이 아예 없거나, 있어도 라인이 0이어야 한다
  [ ! -f "$RUNS" ] || [ "$(grep -c '' "$RUNS" 2>/dev/null || echo 0)" -eq 0 ]
}

@test "F54 hook: records when agent_type absent (version tolerance)" {
  # SubagentStop 입력에 agent_type이 없을 수 있음 — matcher가 이미 필터하므로 기록한다
  run run_hook '{"agent_id":"ev-3","agent_transcript_path":"/t/y.jsonl","session_id":"s2"}'
  [ "$status" -eq 0 ]
  [ "$(jq -r '.agent_id' "$RUNS")" = "ev-3" ]
}

@test "F54 hook: transcript-absent input still records agent_id + epoch" {
  run run_hook '{"agent_id":"ev-4","agent_type":"cc-harness:evaluator"}'
  [ "$status" -eq 0 ]
  [ "$(jq -r '.agent_id' "$RUNS")" = "ev-4" ]
  [ "$(jq -r '.transcript_path' "$RUNS")" = "" ]
}

@test "F54 hook: malformed/empty input never blocks (exit 0)" {
  run run_hook 'not json at all'
  [ "$status" -eq 0 ]
  run run_hook ''
  [ "$status" -eq 0 ]
}

@test "F54 hook: written line is valid JSONL (jq -c parseable)" {
  run_hook '{"agent_id":"ev-5","agent_type":"cc-harness:evaluator"}'
  run jq -ce '.' "$RUNS"
  [ "$status" -eq 0 ]
}
