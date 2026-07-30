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

@test "F39: INV-12 and SKILL exclude tests/*.bats from unattended runs (security-auditor gap)" {
  # is_protected(F41)가 보호하는 tests/*.bats가 무인 제외 목록에도 있어야 대칭 —
  # count 검사로 못 잡는 @test 본문 skip 주입 약화를 무인 루프가 하지 못하게.
  grep -q 'tests/\*.bats' "$INV"
  grep -q 'tests/\*.bats' "$SKILL"
}

@test "F39: approval-queue.json is valid JSON with a queued array" {
  command -v jq >/dev/null || skip "jq not installed"
  jq -e '.queued | type == "array"' "$QUEUE"
}

# === F68: 승인 배치화를 전 워크플로우로 ===
# /improve 에만 있던 --auto 를 implement·change-request 로 확대하고, 대상이 배치 게이트에서
# 명시 승인된 경우 critical 도 무인 진행할 수 있게 한다. 게이트는 매 회전 무약화.

IMPL_SKILL="$PLUGIN_ROOT/skills/implement/SKILL.md"
CR_SKILL="$PLUGIN_ROOT/skills/change-request/SKILL.md"

@test "F68: implement SKILL documents --auto N batch mode" {
  grep -qE '\-\-auto N?' "$IMPL_SKILL"
  grep -q '무인' "$IMPL_SKILL"
  # 배치 게이트가 받는 3항목: 범위·N·중단조건
  grep -qE '범위' "$IMPL_SKILL"
  grep -qE '중단 ?조건' "$IMPL_SKILL"
}

@test "F68: implement SKILL defines the on-fail policy with two values" {
  grep -q 'revert-and-continue' "$IMPL_SKILL"
  grep -q 'queue-and-stop' "$IMPL_SKILL"
}

@test "F68: change-request SKILL documents --auto batch mode" {
  grep -qE '\-\-auto' "$CR_SKILL"
  grep -q '무인' "$CR_SKILL"
}

@test "F68: implement SKILL states gates stay un-weakened in batch mode" {
  # 배치화는 승인 지점의 이동이지 검증 완화가 아니다
  grep -qE '무약화|약화하지 않|완화가 아니' "$IMPL_SKILL"
  grep -q 'evaluator' "$IMPL_SKILL"
}

@test "F68: the evaluator dispatch protocol is documented with its 4 clauses" {
  # 이번 세션 실측: 프롬프트를 열어 두면 evaluator 1회가 133k 토큰·41분이 된다.
  grep -qE '탐색' "$IMPL_SKILL"          # (a) 대상·명령·기대값 명시로 탐색 제거
  grep -qE '재현 ?스크립트' "$IMPL_SKILL" # (b) 재현 스크립트 선제공
  grep -qE '3개 ?이하|세 개 이하' "$IMPL_SKILL"  # (c) 확인 항목 상한
  grep -qE '완성 후 1회|1회만' "$IMPL_SKILL"     # (d) 중간 판정 금지
}

@test "F68: INV-12 distinguishes auto-selected candidates from an approved scope" {
  # /improve --auto 는 후보를 자동 선정하므로 critical 무인 금지(현행 유지).
  # /implement --auto 는 대상이 명시 승인되므로 그 범위 안에서만 무인 허용.
  grep -q 'INV-12' "$INV"
  grep -qE '자동 선정|자동선정' "$INV"
  grep -qE '명시 ?승인|승인된 범위' "$INV"
}

@test "F68: INV-12 keeps the unattended prohibition for auto-selected critical work" {
  # 확대가 전면 개방으로 읽히면 안 된다 — 후보 자동 선정 경로의 금지는 남아야 한다.
  grep -qE '무인으로 절대 처리하지 않|무인 금지' "$INV"
  grep -q 'approval-queue' "$INV"
}

@test "F68: ADR-006 records the scope extension and its condition" {
  grep -qE 'F68|배치 게이트에서 명시' "$ADR"
}

@test "F68: the batch approval record cannot be rewritten by the unattended loop" {
  # SC-4: 루프가 승인 범위를 스스로 넓히면 승인의 의미가 사라진다.
  local guard="$PLUGIN_ROOT/hooks/invariant-guard.sh"
  grep -qE 'approval-queue' "$guard"
}
