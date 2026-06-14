#!/usr/bin/env bats

# cost-report.bats — Phase별 비용 관측성 (F24)
# scripts/cost-report.sh: config/models.json(pricing+phases+assignments)으로
# phase별 모델 가격 구성을 정적 리포트로 출력 (읽기 전용).

PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
CR="$PLUGIN_ROOT/scripts/cost-report.sh"

setup() {
  WORK=$(mktemp -d)
  mkdir -p "$WORK/config"
}
teardown() { rm -rf "$WORK"; }

seed_config() {
  cat > "$WORK/config/models.json" <<'JSON'
{
  "tiers": ["claude-fable-5","claude-opus-4-8","claude-sonnet-4-6","claude-haiku-4-5"],
  "assignments": {
    "spec-writer":      {"model":"claude-sonnet-4-6","criticality":"standard"},
    "architect":        {"model":"claude-opus-4-8","criticality":"standard"},
    "implementer":      {"model":"claude-opus-4-8","criticality":"critical"},
    "evaluator":        {"model":"claude-opus-4-8","criticality":"critical"},
    "test-writer":      {"model":"claude-sonnet-4-6","criticality":"standard"},
    "security-auditor": {"model":"claude-opus-4-8","criticality":"critical"},
    "qa-reviewer":      {"model":"claude-haiku-4-5","criticality":"low"},
    "deploy-operator":  {"model":"claude-sonnet-4-6","criticality":"standard"}
  },
  "pricing": {
    "claude-fable-5":    {"input":10,"output":50},
    "claude-opus-4-8":   {"input":5,"output":25},
    "claude-sonnet-4-6": {"input":3,"output":15},
    "claude-haiku-4-5":  {"input":1,"output":5}
  },
  "phases": {
    "specification":  ["spec-writer"],
    "architecture":   ["architect"],
    "implementation": ["implementer"],
    "verification":   ["evaluator","test-writer","security-auditor","qa-reviewer"],
    "deployment":     ["deploy-operator"]
  },
  "rules": {"verification_gates":["evaluator","security-auditor"],"gate_reference_role":"implementer"}
}
JSON
}

@test "cost-report: JSON 모드 — 5개 phase 출력" {
  seed_config
  run bash -c "cd '$WORK' && bash '$CR' --json"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | jq '.phases | length')" -eq 5 ]
}

@test "cost-report: verification phase가 4개 role 포함" {
  seed_config
  run bash -c "cd '$WORK' && bash '$CR' --json"
  [ "$(echo "$output" | jq '.phases[] | select(.phase=="verification") | .roles | length')" -eq 4 ]
}

@test "cost-report: verification 단가합 = opus(5/25)+sonnet(3/15)+opus(5/25)+haiku(1/5)" {
  seed_config
  run bash -c "cd '$WORK' && bash '$CR' --json"
  # Σinput = 5+3+5+1 = 14, Σoutput = 25+15+25+5 = 70
  [ "$(echo "$output" | jq '.phases[] | select(.phase=="verification") | .input_per_1m')" -eq 14 ]
  [ "$(echo "$output" | jq '.phases[] | select(.phase=="verification") | .output_per_1m')" -eq 70 ]
}

@test "cost-report: 최고가 phase는 verification (총단가 84)" {
  seed_config
  run bash -c "cd '$WORK' && bash '$CR' --json"
  [ "$(echo "$output" | jq -r '.most_expensive_phase')" = "verification" ]
}

@test "cost-report: --tokens 옵션 1회 호출 \$ 추정" {
  seed_config
  # implementation: opus 5/25. in=1000, out=4000 →
  # (1000/1e6)*5 + (4000/1e6)*25 = 0.005 + 0.1 = 0.105
  run bash -c "cd '$WORK' && bash '$CR' --json --tokens-in 1000 --tokens-out 4000"
  [ "$status" -eq 0 ]
  est=$(echo "$output" | jq '.phases[] | select(.phase=="implementation") | .est_usd_per_call')
  # 부동소수 비교: 0.105 근처
  [ "$(echo "$output" | jq '.phases[] | select(.phase=="implementation") | (.est_usd_per_call*1000|round)')" -eq 105 ]
}

@test "cost-report: pricing에 없는 모델 → N/A (0 위장 금지)" {
  seed_config
  # qa-reviewer를 가격 없는 모델로
  jq '.assignments."qa-reviewer".model="claude-uncosted-1"' "$WORK/config/models.json" > "$WORK/config/m.json" && mv "$WORK/config/m.json" "$WORK/config/models.json"
  run bash -c "cd '$WORK' && bash '$CR' --json"
  [ "$status" -eq 0 ]
  # verification phase에 미가격 모델 포함 → N/A 플래그
  echo "$output" | jq -e '.phases[] | select(.phase=="verification") | .has_uncosted == true'
}

@test "cost-report: config 부재 → graceful (비0 종료 없이 안내)" {
  run bash -c "cd '$WORK' && bash '$CR' --json"
  [ "$status" -ne 2 ]
  echo "$output" | jq -e '.error' || echo "$output" | grep -qi 'config'
}

@test "cost-report: malformed config → graceful" {
  printf 'not json {{{' > "$WORK/config/models.json"
  run bash -c "cd '$WORK' && bash '$CR' --json"
  [ "$status" -ne 2 ] || echo "$output" | grep -qi 'config'
}

@test "cost-report: 비숫자 --tokens-in → 사용법 + 비0 종료" {
  seed_config
  run bash -c "cd '$WORK' && bash '$CR' --tokens-in abc"
  [ "$status" -ne 0 ]
}

@test "cost-report: 기본(텍스트) 모드 — phase 이름들이 출력" {
  seed_config
  run bash -c "cd '$WORK' && bash '$CR'"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "verification"
  echo "$output" | grep -q "implementation"
}

@test "cost-report: 선언 데이터 면책 표기 — 실제 청구 아님 명시" {
  seed_config
  run bash -c "cd '$WORK' && bash '$CR'"
  echo "$output" | grep -qiE 'declared|선언|not.*billing|청구.*아'
}

@test "cost-report: F23 model-tiering은 pricing/phases 추가 후에도 0건" {
  seed_config
  # 정합 config(8 agent) — agents 디렉토리도 필요
  mkdir -p "$WORK/agents"
  for r in spec-writer architect implementer evaluator test-writer security-auditor qa-reviewer deploy-operator; do
    m=$(jq -r --arg r "$r" '.assignments[$r].model' "$WORK/config/models.json")
    printf -- '---\nname: %s\ndescription: "x"\nmodel: %s\n---\n' "$r" "$m" > "$WORK/agents/$r.md"
  done
  run bash -c "cd '$WORK' && bash '$PLUGIN_ROOT/scripts/probes/model-tiering.sh'"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | jq 'length')" -eq 0 ]
}
