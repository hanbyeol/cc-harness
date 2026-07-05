#!/usr/bin/env bats

# pre-commit-gate.sh — 캐시 동작 검증 (전체 게이트가 아니라 skip 로직에 집중)

PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
HOOK="$PLUGIN_ROOT/hooks/pre-commit-gate.sh"

setup() {
  WORK=$(mktemp -d)
  cd "$WORK" && git init -q .
  git config user.email t@t.t && git config user.name t
  echo "initial" > base.txt && git add -A && git commit -qm init
  # 변경 발생 (tree dirty)
  echo "change" >> base.txt
}
teardown() { rm -rf "$WORK"; }

run_gate() { CLAUDE_PROJECT_DIR="$WORK" bash "$HOOK"; }

@test "first run passes and writes gate cache" {
  run bash -c "echo '{}' | CLAUDE_PROJECT_DIR='$WORK' bash '$HOOK'"
  [ "$status" -eq 0 ]
  [ -f "$WORK/progress/.gate-cache" ]
}

@test "second run with identical tree hits cache (early exit, no coverage write)" {
  echo '{}' | run_gate
  rm -f "$WORK/progress/coverage-report.json"
  echo '{}' | run_gate
  # 캐시 히트 시 게이트 본문(coverage 등)을 실행하지 않으므로 파일이 재생성되지 않는다
  [ ! -f "$WORK/progress/coverage-report.json" ]
}

@test "cache invalidated when tree changes" {
  echo '{}' | run_gate
  FIRST_SHA=$(head -1 "$WORK/progress/.gate-cache")
  echo "more change" >> base.txt
  echo '{}' | run_gate
  NEW_SHA=$(head -1 "$WORK/progress/.gate-cache")
  [ "$FIRST_SHA" != "$NEW_SHA" ]
}

@test "stop_hook_active short-circuits" {
  run bash -c "echo '{\"stop_hook_active\":true}' | CLAUDE_PROJECT_DIR='$WORK' bash '$HOOK'"
  [ "$status" -eq 0 ]
}

@test "clean tree exits without creating cache" {
  git add -A && git commit -qm "commit change"
  run bash -c "echo '{}' | CLAUDE_PROJECT_DIR='$WORK' bash '$HOOK'"
  [ "$status" -eq 0 ]
}

@test "F38: a blocked gate appends 'block' to .gate-stats (observability)" {
  # 시크릿 유입으로 게이트 차단 유발 → 차단 카운터 기록 확인
  printf 'const k = "AKIAIOSFODNN7EXAMPLE1"\n' > leak.go
  git add -A
  run bash -c "echo '{}' | CLAUDE_PROJECT_DIR='$WORK' bash '$HOOK'"
  [ "$status" -eq 2 ]
  [ "$(grep -cx block "$WORK/progress/.gate-stats")" -ge 1 ]
}
