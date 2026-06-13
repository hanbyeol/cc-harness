#!/usr/bin/env bats

# lib.sh tests — 공용 훅 헬퍼

PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
LIB="$PLUGIN_ROOT/hooks/lib.sh"

setup() {
  WORK=$(mktemp -d)
  mkdir -p "$WORK/progress"
}
teardown() { rm -rf "$WORK"; }

# --- cfg_get ---

@test "cfg_get returns value from harness-config" {
  echo '{"agent_comms":{"max_files_per_type":7}}' > "$WORK/progress/harness-config.json"
  run bash -c "source '$LIB'; cfg_get '$WORK/progress/harness-config.json' '.agent_comms.max_files_per_type' 10"
  [ "$status" -eq 0 ]
  [ "$output" = "7" ]
}

@test "cfg_get returns default when key missing" {
  echo '{}' > "$WORK/progress/harness-config.json"
  run bash -c "source '$LIB'; cfg_get '$WORK/progress/harness-config.json' '.agent_comms.max_files_per_type' 10"
  [ "$output" = "10" ]
}

@test "cfg_get returns default when file missing" {
  run bash -c "source '$LIB'; cfg_get '$WORK/progress/nonexistent.json' '.x' 42"
  [ "$output" = "42" ]
}

@test "cfg_get does not let false be overwritten by default" {
  echo '{"agent_comms":{"archive_enabled":false}}' > "$WORK/progress/harness-config.json"
  run bash -c "source '$LIB'; cfg_get '$WORK/progress/harness-config.json' '.agent_comms.archive_enabled' true"
  [ "$output" = "false" ]
}

# --- version_lt ---

@test "version_lt: 1.4.0 < 1.6.0 is true" {
  run bash -c "source '$LIB'; version_lt 1.4.0 1.6.0"
  [ "$status" -eq 0 ]
}

@test "version_lt: 1.6.0 < 1.6.0 is false" {
  run bash -c "source '$LIB'; version_lt 1.6.0 1.6.0"
  [ "$status" -ne 0 ]
}

@test "version_lt: 1.7.0 < 1.6.0 is false" {
  run bash -c "source '$LIB'; version_lt 1.7.0 1.6.0"
  [ "$status" -ne 0 ]
}

@test "version_lt: 1.5.0 < 1.10.0 is true (numeric not lexical)" {
  run bash -c "source '$LIB'; version_lt 1.5.0 1.10.0"
  [ "$status" -eq 0 ]
}

@test "version_lt: empty installed version < any (treated as oldest)" {
  run bash -c "source '$LIB'; version_lt '' 1.6.0"
  [ "$status" -eq 0 ]
}

# --- has_jq ---

@test "has_jq succeeds when jq present" {
  run bash -c "source '$LIB'; has_jq"
  [ "$status" -eq 0 ]
}
