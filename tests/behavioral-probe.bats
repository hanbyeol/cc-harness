#!/usr/bin/env bats

# behavioral-probe.bats — F30 행위(behavioral) 자기진단 프로브
# 정상 훅 clean / leaky firewall 검출 / read-only / run-all 통합을 고정한다.

PROBE="scripts/probes/behavioral.sh"

# 항상 allow를 방출하는 leaky 훅을 임시 생성
mk_leaky() {
  local f
  f="$(mktemp)"
  printf '%s\n' '#!/usr/bin/env bash' \
    "jq -n '{hookSpecificOutput:{hookEventName:\"PreToolUse\",permissionDecision:\"allow\"}}'" > "$f"
  echo "$f"
}

@test "F30: probe outputs a valid JSON array" {
  run bash "$PROBE"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e 'type == "array"'
}

@test "F30: clean on current firewalls — no leak candidate (noise 0)" {
  run bash "$PROBE"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | jq 'length')" -eq 0 ]
}

@test "F30: detects a leaky bash firewall (allow-everything)" {
  leak="$(mk_leaky)"
  PROBE_BASH_FIREWALL="$leak" run bash "$PROBE"
  rm -f "$leak"
  [ "$(echo "$output" | jq 'length')" -ge 1 ]
  echo "$output" | jq -e 'any(.[]; .source == "behavioral" and .security_tier == "critical")'
}

@test "F30: detects a leaky tool firewall" {
  leak="$(mk_leaky)"
  PROBE_TOOL_FIREWALL="$leak" run bash "$PROBE"
  rm -f "$leak"
  [ "$(echo "$output" | jq 'length')" -ge 1 ]
  echo "$output" | jq -e 'any(.[]; .name | test("tool"))'
}

@test "F30: leak candidate names the offending danger command" {
  leak="$(mk_leaky)"
  PROBE_BASH_FIREWALL="$leak" run bash "$PROBE"
  rm -f "$leak"
  echo "$output" | jq -e 'any(.[]; .description | test("rm -rf /"))'
}

@test "F30: corpus excludes policy-allowed commands (find -delete is NOT a leak)" {
  # ADR-004 default-allow: 상대경로 삭제는 정책상 허용 → 코퍼스에 없어야 오탐이 안 난다
  ! grep -qE "find \. -delete|find \. -exec" "$PROBE"
}

@test "F30: run-all wires in the behavioral probe" {
  grep -qE 'behavioral' scripts/probes/run-all.sh
}

@test "F30: probe is read-only (git working tree unchanged)" {
  before="$(git status --porcelain 2>/dev/null | sort)"
  bash "$PROBE" >/dev/null 2>&1 || true
  after="$(git status --porcelain 2>/dev/null | sort)"
  [ "$before" = "$after" ]
}

@test "F30: missing bash firewall → graceful array, no crash" {
  PROBE_BASH_FIREWALL="/nonexistent/fw.sh" run bash "$PROBE"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e 'type == "array"'
}

@test "F30: both firewalls missing → [] exit 0 (no false leak)" {
  PROBE_BASH_FIREWALL="/no/a.sh" PROBE_TOOL_FIREWALL="/no/b.sh" run bash "$PROBE"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | jq 'length')" -eq 0 ]
}
