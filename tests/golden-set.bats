#!/usr/bin/env bats

# golden-set.bats — scripts/build-golden-set.sh (F61)
#
# 이 스크립트는 evaluator 보정 코퍼스를 재생성한다. 코퍼스는 calibration 프로브가
# 판정 점수를 대조하는 baseline이므로, 잘못 생성되면 드리프트 탐지가 조용히 꺼진다.
# F61 evaluator 판정이 "실질 산출물인데 자동 테스트가 0건"이라고 지적해 추가했다.

PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
BUILD="$PLUGIN_ROOT/scripts/build-golden-set.sh"

setup() {
  WORK=$(mktemp -d)
  mkdir -p "$WORK/progress/agent-comms/archive" "$WORK/evals/calibration" "$WORK/scripts"
  cp "$BUILD" "$WORK/scripts/"
}

teardown() {
  rm -rf "$WORK"
}

# 판정 파일 하나를 만든다: fb <dir> <name> <tier> <verdict> <functionality>
fb() {
  cat > "$WORK/progress/agent-comms/$1/evaluator-feedback-$2.json" <<EOF
{"features_evaluated":["$2"],"security_tier":"$3","verdict":"$4","score":$5,
 "scores":{"functionality":$5,"code_quality":8,"security":8,"error_handling":8,"test_coverage":8},
 "evidence":{"cmd":"secret-looking-value"}}
EOF
}

run_build() { (cd "$WORK" && bash scripts/build-golden-set.sh "$@"); }

@test "build-golden-set: collects both current and archive feedback" {
  fb . 2026-01-01T00-00-00 standard pass 9
  fb archive 2026-01-02T00-00-00 critical pass 8
  run run_build
  [ "$status" -eq 0 ]
  [ "$(jq '.records | length' "$WORK/evals/calibration/golden-set.json")" -eq 2 ]
}

@test "build-golden-set: output is deterministic across runs" {
  fb . 2026-01-01T00-00-00 standard pass 9
  fb archive 2026-01-02T00-00-00 critical pass 8
  run_build
  cp "$WORK/evals/calibration/golden-set.json" "$WORK/first.json"
  run_build
  run cmp -s "$WORK/first.json" "$WORK/evals/calibration/golden-set.json"
  [ "$status" -eq 0 ]
}

@test "build-golden-set: evidence content never reaches the corpus (SC-3)" {
  fb . 2026-01-01T00-00-00 standard pass 9
  run_build
  # 원본 evidence에는 문자열이 있지만 코퍼스에는 불리언만 남아야 한다
  run grep -q "secret-looking-value" "$WORK/evals/calibration/golden-set.json"
  [ "$status" -ne 0 ]
  [ "$(jq -r '.records[0].has_evidence' "$WORK/evals/calibration/golden-set.json")" = "true" ]
  [ "$(jq '[.records[] | select(has("evidence"))] | length' "$WORK/evals/calibration/golden-set.json")" -eq 0 ]
}

@test "build-golden-set: records with non-numeric scores are skipped, not silently dropped" {
  fb . 2026-01-01T00-00-00 standard pass 9
  cat > "$WORK/progress/agent-comms/evaluator-feedback-2026-01-03T00-00-00.json" <<'EOF'
{"features_evaluated":["BAD"],"security_tier":"standard","verdict":"pass","scores":{"functionality":"n/a"}}
EOF
  run run_build
  [ "$status" -eq 0 ]
  [ "$(jq '.records | length' "$WORK/evals/calibration/golden-set.json")" -eq 1 ]
  # 건너뛴 사실이 보고되어야 한다 (ES-1)
  [[ "$output" == *"1건 skip"* ]]
}

@test "build-golden-set: refuses to shrink an existing corpus (archive-absent guard)" {
  fb . 2026-01-01T00-00-00 standard pass 9
  fb archive 2026-01-02T00-00-00 critical pass 8
  fb archive 2026-01-04T00-00-00 critical pass 9
  run_build
  [ "$(jq '.records | length' "$WORK/evals/calibration/golden-set.json")" -eq 3 ]
  # archive가 사라진 환경(clean clone)을 재현 — 코퍼스를 덮어쓰면 안 된다
  rm -rf "$WORK/progress/agent-comms/archive"
  run run_build
  [ "$status" -ne 0 ]
  [[ "$output" == *"중단"* ]]
  # 기존 코퍼스가 보존되어야 한다
  [ "$(jq '.records | length' "$WORK/evals/calibration/golden-set.json")" -eq 3 ]
}

@test "build-golden-set: shrink is allowed with an explicit override" {
  fb . 2026-01-01T00-00-00 standard pass 9
  fb archive 2026-01-02T00-00-00 critical pass 8
  run_build
  rm -rf "$WORK/progress/agent-comms/archive"
  run bash -c "cd '$WORK' && GOLDEN_SET_ALLOW_SHRINK=1 bash scripts/build-golden-set.sh"
  [ "$status" -eq 0 ]
  [ "$(jq '.records | length' "$WORK/evals/calibration/golden-set.json")" -eq 1 ]
}
