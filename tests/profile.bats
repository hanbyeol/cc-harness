#!/usr/bin/env bats

# profile.bats — 라이프사이클 프로파일 (F20)
# setup-claudemd가 harness-config의 profile에 따라 다른 워크플로우 섹션을 주입한다.

PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
HOOK="$PLUGIN_ROOT/hooks/setup-claudemd.sh"
SENTINEL_SDLC="기준 역전파 원칙"

setup() {
  WORK=$(mktemp -d)
  cd "$WORK" && git init -q .
  mkdir -p progress
}
teardown() { rm -rf "$WORK"; }

run_setup() { CLAUDE_PROJECT_DIR="$WORK" bash "$HOOK"; }

# --- 기본(sdlc) — 회귀 0 ---

@test "no profile → sdlc section injected (regression-free)" {
  run_setup >/dev/null 2>&1
  grep -qF "$SENTINEL_SDLC" CLAUDE.md
  grep -qF '<!-- cc-harness:begin -->' CLAUDE.md
}

@test "profile=sdlc → same as default sdlc section" {
  echo '{"profile":"sdlc"}' > progress/harness-config.json
  run_setup >/dev/null 2>&1
  grep -qF "$SENTINEL_SDLC" CLAUDE.md
}

# --- iac 프로파일 ---

@test "profile=iac → iac workflow section (plan/apply), no SDLC SPEC cascade" {
  echo '{"profile":"iac"}' > progress/harness-config.json
  run_setup >/dev/null 2>&1
  # iac 워크플로우 키워드 존재
  grep -qiE 'plan-review|terraform plan|plan→apply|plan → apply' CLAUDE.md
  # SDLC 전용 산출물 cascade(SPEC.md→ARCHITECTURE→acceptance) 워크플로우는 없음
  ! grep -qF "$SENTINEL_SDLC" CLAUDE.md
}

@test "profile=iac keeps the cc-harness markers" {
  echo '{"profile":"iac"}' > progress/harness-config.json
  run_setup >/dev/null 2>&1
  [ "$(grep -cF '<!-- cc-harness:begin -->' CLAUDE.md)" -eq 1 ]
  [ "$(grep -cF '<!-- cc-harness:end -->' CLAUDE.md)" -eq 1 ]
}

# --- graceful fallback ---

@test "unknown profile → falls back to sdlc" {
  echo '{"profile":"bogus"}' > progress/harness-config.json
  run_setup >/dev/null 2>&1
  grep -qF "$SENTINEL_SDLC" CLAUDE.md
}

@test "malformed harness-config JSON → sdlc fallback, no crash" {
  printf '{ not json ' > progress/harness-config.json
  run run_setup
  [ "$status" -eq 0 ]
  grep -qF "$SENTINEL_SDLC" CLAUDE.md
}

# --- 멀티 프로파일 (.profiles 배열) ---

@test "profiles=[iac,ops] → both sections injected (plan-review + rollout)" {
  echo '{"profiles":["iac","ops"]}' > progress/harness-config.json
  run_setup >/dev/null 2>&1
  grep -qiE 'plan-review|terraform plan' CLAUDE.md
  grep -qiE 'rollout|관측' CLAUDE.md
  ! grep -qF "$SENTINEL_SDLC" CLAUDE.md
  [ "$(grep -cF '<!-- cc-harness:begin -->' CLAUDE.md)" -eq 1 ]
  [ "$(grep -cF '<!-- cc-harness:end -->' CLAUDE.md)" -eq 1 ]
}

@test "profiles=[iac] (array of one) → iac only" {
  echo '{"profiles":["iac"]}' > progress/harness-config.json
  run_setup >/dev/null 2>&1
  grep -qiE 'plan-review' CLAUDE.md
  ! grep -qiE 'rollout' CLAUDE.md
}

@test ".profile=iac (singular, backward compat) still works" {
  echo '{"profile":"iac"}' > progress/harness-config.json
  run_setup >/dev/null 2>&1
  grep -qiE 'plan-review' CLAUDE.md
}

@test "profiles=[] → sdlc fallback" {
  echo '{"profiles":[]}' > progress/harness-config.json
  run_setup >/dev/null 2>&1
  grep -qF "$SENTINEL_SDLC" CLAUDE.md
}

@test "profiles=[bogus,iac] → iac only (skip unknown)" {
  echo '{"profiles":["bogus","iac"]}' > progress/harness-config.json
  run_setup >/dev/null 2>&1
  grep -qiE 'plan-review' CLAUDE.md
}

@test "profiles=[iac,iac] → deduped, single iac section" {
  echo '{"profiles":["iac","iac"]}' > progress/harness-config.json
  run_setup >/dev/null 2>&1
  [ "$(grep -c '/plan-review — terraform plan diff 리뷰 게이트' CLAUDE.md)" -le 1 ]
}

@test "multi-profile injection is idempotent (byte-identical on re-run)" {
  echo '{"profiles":["iac","ops"]}' > progress/harness-config.json
  run_setup >/dev/null 2>&1
  cp CLAUDE.md run1.txt
  run_setup >/dev/null 2>&1
  cmp -s CLAUDE.md run1.txt
}

# --- profiles/ 소스 파일 존재 ---

@test "profile=ops → ops workflow section (observe/diagnose/remediate/verify), no SDLC cascade" {
  echo '{"profile":"ops"}' > progress/harness-config.json
  run_setup >/dev/null 2>&1
  grep -qiE '관측|observe' CLAUDE.md
  grep -qiE '조치|remediat|rollout' CLAUDE.md
  ! grep -qF "$SENTINEL_SDLC" CLAUDE.md
}

@test "profiles/ops.md exists and describes the ops loop + reuse" {
  [ -f "$PLUGIN_ROOT/profiles/ops.md" ]
  grep -qiE '관측|진단|조치|검증' "$PLUGIN_ROOT/profiles/ops.md"
  # ops 게이트는 5차원 evaluator 대신 health+회귀
  grep -qiE 'health|회귀|desired state|readiness' "$PLUGIN_ROOT/profiles/ops.md"
  # 재사용 명시
  grep -qiE 'deploy-operator|/debug|k8s-infra' "$PLUGIN_ROOT/profiles/ops.md"
}

@test "profiles/iac.md exists and describes plan/apply lifecycle" {
  [ -f "$PLUGIN_ROOT/profiles/iac.md" ]
  grep -qiE 'plan|apply' "$PLUGIN_ROOT/profiles/iac.md"
  # iac 프로파일은 5차원 evaluator 대신 plan-review 검증을 쓴다
  grep -qiE 'plan-review|tflint|trivy|drift' "$PLUGIN_ROOT/profiles/iac.md"
}
