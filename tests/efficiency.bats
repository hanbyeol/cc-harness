#!/usr/bin/env bats

# efficiency.bats — 프로세스 효율 P2/P3/P4 (F17/F18/F19)
# 프롬프트/방법론 변경이므로 줄 수·키워드·약화 방지 검증.

PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
SYNC="$PLUGIN_ROOT/skills/sync-docs/SKILL.md"
DEBUG="$PLUGIN_ROOT/skills/debug/SKILL.md"
IMPL="$PLUGIN_ROOT/skills/implement/SKILL.md"
CLAUDEMD="$PLUGIN_ROOT/CLAUDE.md"

# --- F17: 토큰 다이어트 ---

@test "F17: sync-docs compressed below 127 lines" {
  [ "$(wc -l < "$SYNC")" -lt 127 ]
}

@test "F17: sync-docs keeps non-obvious guidance (TRIGGER, --deep, drift)" {
  grep -q 'TRIGGER' "$SYNC"
  grep -q -- '--deep' "$SYNC"
  grep -qiE 'drift|불일치' "$SYNC"
}

@test "F17: sync-docs keeps the 1M-context cost guard for --deep" {
  grep -qE '1M|컨텍스트|비용' "$SYNC"
}

# --- F18: /debug 독립 실패 병렬 ---

@test "F18: debug gains independent-failure parallel mode" {
  grep -q '병렬' "$DEBUG"
  grep -q '독립' "$DEBUG"
}

@test "F18: debug parallel uses worktree isolation + merge protocol" {
  grep -qiE 'worktree' "$DEBUG"
  grep -q '병합' "$DEBUG"
}

@test "F18: debug keeps serial fallback for related/exploratory failures" {
  grep -q '폴백' "$DEBUG"
}

@test "F18: debug keeps the 4-phase root-cause structure" {
  grep -qE '재현' "$DEBUG"
  grep -qE '근본 원인|근본원인' "$DEBUG"
  grep -qE '회귀' "$DEBUG"
}

# --- F19: 검증 티어링 (약화 없음) ---

@test "F19: verification tiering documented (critical / 경량 / per-checkpoint)" {
  grep -q 'critical' "$IMPL"
  grep -qE '경량' "$IMPL"
  grep -qiE 'per-checkpoint|체크포인트' "$IMPL"
}

@test "F19: critical tier is never down-graded to lightweight" {
  grep -qE 'critical.*경량.*금지|critical.*절대.*경량|critical은 .*full|critical.*생략.*금지|critical.*evaluator.*유지' "$IMPL"
}

@test "F19: does NOT introduce threshold lowering or evaluator weakening" {
  # 임계값 하향·evaluator 생략 일반화 같은 약화 문구가 추가되지 않았는지
  ! grep -qE 'pass_threshold를 (낮|하향)|critical.*evaluator.*생략|모든 변경.*evaluator 생략' "$IMPL"
}

@test "F19: CLAUDE.md carries the tier->verification mapping" {
  grep -qiE '검증 (강도|티어)|security_tier.*검증|tier.*verification' "$CLAUDEMD"
}
