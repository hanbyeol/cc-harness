#!/usr/bin/env bats

# deploy-gate.bats — F31 deploy-operator 공급망 게이트 배선 + guide↔agent drift 방지

PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
DEPLOY="$PLUGIN_ROOT/agents/deploy-operator.md"
GUIDE="$PLUGIN_ROOT/templates/docs/HARNESS-GUIDE.md"
AUDITOR="$PLUGIN_ROOT/agents/security-auditor.md"

@test "F31: deploy-operator gates on supply_chain.vulnerable_deps == 0" {
  grep -qE 'supply_chain\.vulnerable_deps == 0' "$DEPLOY"
}

@test "F31: HARNESS-GUIDE promises the same supply_chain deploy gate (no drift)" {
  grep -qE 'supply_chain\.vulnerable_deps == 0' "$GUIDE"
}

@test "F31: security-auditor produces the supply_chain.vulnerable_deps field (source)" {
  grep -qE 'vulnerable_deps' "$AUDITOR"
}

@test "F31: existing deploy gates remain (checklist / passes / qa)" {
  grep -qE 'checklist_compliance\.failed == 0' "$DEPLOY"
  grep -qE 'passes.*true' "$DEPLOY"
  grep -qF 'verdict != "fail"' "$DEPLOY"
}

@test "F31: deploy-operator output records the supply_chain pre-check" {
  grep -qE '"supply_chain"' "$DEPLOY"
}

@test "F31: reject-on-any-unmet principle intact" {
  grep -qF '하나라도 미충족 시 배포 거부' "$DEPLOY"
}

@test "F31: supply_chain gate is fail-safe (missing field is not treated as pass)" {
  grep -qE '부재.*미충족|미충족.*처리|fail-safe' "$DEPLOY"
}
