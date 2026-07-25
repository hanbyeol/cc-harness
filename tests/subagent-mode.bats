#!/usr/bin/env bats

# subagent-mode.bats — 서브에이전트 구동 병렬 구현 (F16)
# 프롬프트/방법론 변경이므로 키워드·구조 정합으로 검증한다.

PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
# F58: 검사 범위를 SKILL.md 단일 파일에서 implement 스킬 디렉터리 전체로 확장한다.
# 점진적 공개(본체 + 하위 파일)를 허용하되 불변식은 그대로다 — "이 내용이 implement
# 스킬 어딘가에 존재한다". 범위 확장이지 불변식 부정이 아니며, 내용을 삭제하면 여전히
# 실패한다(mutation으로 확인). 검사를 없애는 것과 검사가 볼 수 있는 곳을 넓히는 것은 다르다.
IMPL_SKILL_DIR="$PLUGIN_ROOT/skills/implement"
IMPLEMENTER="$PLUGIN_ROOT/agents/implementer.md"

# --- /implement 스킬: 서브에이전트 구동 모드 ---

@test "implement skill describes subagent-driven mode" {
  grep -rq '서브에이전트' "$IMPL_SKILL_DIR"
}

@test "implement skill mandates worktree isolation for parallel tasks" {
  grep -rqiE 'isolation.*worktree|worktree.*격리|isolation: *"?worktree' "$IMPL_SKILL_DIR"
}

@test "implement skill states independence judgment (same-file/dependency = serial)" {
  grep -rq '독립성' "$IMPL_SKILL_DIR"
  grep -rqE '같은 파일|동일 파일' "$IMPL_SKILL_DIR"
}

@test "implement skill defines a merge protocol" {
  grep -rq '병합' "$IMPL_SKILL_DIR"
  grep -rqE '충돌 확인|충돌 점검' "$IMPL_SKILL_DIR"
}

@test "implement skill specifies token curation (task-only context, no full contract)" {
  grep -rqE 'task별 컨텍스트|태스크별 컨텍스트|task의.*만 전달|최소 컨텍스트' "$IMPL_SKILL_DIR"
}

@test "implement skill provides a serial fallback" {
  grep -rq '폴백' "$IMPL_SKILL_DIR"
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
  grep -rqE '독립 evaluator|독립.*evaluator만|evaluator만 판정|병합 후.*evaluator' "$IMPL_SKILL_DIR"
  grep -qE '독립 evaluator|evaluator만|passes 판정은 이 에이전트만|evaluator가 판정' "$IMPLEMENTER"
}
