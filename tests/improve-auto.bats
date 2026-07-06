#!/usr/bin/env bats

# F39: /improve --auto (batch-approval unattended loop) — structure & safety invariants.
# Docs/skill feature: assert the safety-critical clauses are present and the artifacts exist.

PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
SKILL="$PLUGIN_ROOT/skills/improve/SKILL.md"
ADR="$PLUGIN_ROOT/docs/DECISIONS/ADR-006-batch-approval-autonomy.md"
INV="$PLUGIN_ROOT/docs/INVARIANTS.md"
QUEUE="$PLUGIN_ROOT/progress/approval-queue.json"

@test "F39: improve SKILL documents the --auto N mode" {
  grep -qE '\-\-auto N' "$SKILL"
  grep -q '무인' "$SKILL"
}

@test "F39: improve SKILL states gates are un-weakened in auto mode" {
  # 무인 모드가 우회하는 것은 후보 선택뿐 — 게이트는 무약화
  grep -q '무약화' "$SKILL"
  grep -qE 'invariant-guard|evaluator|Stop 게이트' "$SKILL"
}

@test "F39: improve SKILL isolates critical/invariant candidates to approval-queue" {
  grep -q 'approval-queue.json' "$SKILL"
  grep -qE 'critical .*무인.*(제외|않는다|불가)|무인.*critical' "$SKILL"
}

@test "F39: improve SKILL defines the 4 stop conditions" {
  grep -qE '중단 조건' "$SKILL"
  grep -q 'evaluator fail' "$SKILL"
  grep -q 'invariant-guard 차단' "$SKILL"
}

@test "F39: ADR-006 exists and is Accepted" {
  [ -f "$ADR" ]
  grep -qE '^\*\*Status\*\*: Accepted' "$ADR"
  grep -q 'F35' "$ADR"   # INV-11 선행 전제 명문화
}

@test "F39: INVARIANTS declares INV-12 (no unattended execution for critical/guard)" {
  grep -qE 'INV-12' "$INV"
  grep -q '무인 실행 불가' "$INV"
  # 검증 장치 목록에 핵심 파일이 명시돼야 함
  grep -q 'invariant-guard.sh' "$INV"
}

@test "F39: approval-queue.json is valid JSON with a queued array" {
  command -v jq >/dev/null || skip "jq not installed"
  jq -e '.queued | type == "array"' "$QUEUE"
}
