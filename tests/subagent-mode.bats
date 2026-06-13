#!/usr/bin/env bats

# subagent-mode.bats — 서브에이전트 구동 병렬 구현 (F16)
# 프롬프트/방법론 변경이므로 키워드·구조 정합으로 검증한다.

PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
IMPL_SKILL="$PLUGIN_ROOT/skills/implement/SKILL.md"
IMPLEMENTER="$PLUGIN_ROOT/agents/implementer.md"

# --- /implement 스킬: 서브에이전트 구동 모드 ---

@test "implement skill describes subagent-driven mode" {
  grep -q '서브에이전트' "$IMPL_SKILL"
}

@test "implement skill mandates worktree isolation for parallel tasks" {
  grep -qiE 'isolation.*worktree|worktree.*격리|isolation: *"?worktree' "$IMPL_SKILL"
}

@test "implement skill states independence judgment (same-file/dependency = serial)" {
  grep -q '독립성' "$IMPL_SKILL"
  grep -qE '같은 파일|동일 파일' "$IMPL_SKILL"
}

@test "implement skill defines a merge protocol" {
  grep -q '병합' "$IMPL_SKILL"
  grep -qE '충돌 확인|충돌 점검' "$IMPL_SKILL"
}

@test "implement skill specifies token curation (task-only context, no full contract)" {
  grep -qE 'task별 컨텍스트|태스크별 컨텍스트|task의.*만 전달|최소 컨텍스트' "$IMPL_SKILL"
}

@test "implement skill provides a serial fallback" {
  grep -q '폴백' "$IMPL_SKILL"
}

# --- implementer agent: 부모/자식 역할 + INV-1 ---

@test "implementer defines parent/child roles" {
  grep -q '부모' "$IMPLEMENTER"
  grep -q '자식' "$IMPLEMENTER"
}

@test "implementer keeps INV-1: subagents do not set passes" {
  grep -qE 'passes를 .*set하지 않|passes를 직접 true로 변경 금지|passes를 .*변경하지 않' "$IMPLEMENTER"
}

# --- 독립 evaluator 유지(약화 아님)가 양쪽에 ---

@test "independent evaluator preserved in both implement skill and implementer" {
  grep -qE '독립 evaluator|독립.*evaluator만|evaluator만 판정|병합 후.*evaluator' "$IMPL_SKILL"
  grep -qE '독립 evaluator|evaluator만|passes 판정은 이 에이전트만|evaluator가 판정' "$IMPLEMENTER"
}
