#!/usr/bin/env bash
#
# pre-tool-firewall.sh — PreToolUse 크로스도구 권한 계층 (F28)
#
# Bash 외 도구(WebFetch·WebSearch·NotebookRead·MCP)에 대한 자율성 정책.
# 읽기전용 도구면 permissionDecision:"allow"를 방출해 무프롬프트 진행하고,
# 그 외(MCP write·업로드·미분류)는 판정 없이 exit 0 → Claude Code 기본 프롬프트로 넘긴다.
#
# 설계: Bash(pre-bash-firewall)는 인자로 위험을 판별할 수 있어 default-allow지만,
# 도구(특히 MCP)는 한 번의 호출이 곧 액션(메일 전송·이벤트 삭제·업로드)이라 인자 판별이
# 불가하다. 따라서 여기선 **화이트리스트** 모델 — read-only에 명시적으로 매칭될 때만 allow,
# 미분류/미지 verb는 오허용이 아니라 프롬프트(자율성 확장이 새 구멍을 열지 않게 함).
# Edit|Write|MultiEdit은 invariant-guard, Bash는 pre-bash-firewall 관할이라 여기서 다루지 않는다.
set -euo pipefail

INPUT=$(cat)
if ! command -v jq &>/dev/null; then
  # jq 없이는 tool_name 파싱 불가 — fail-safe로 allow 미방출(네이티브 흐름 유지)
  echo "cc-harness tool-firewall: jq not found — inactive" >&2
  exit 0
fi

TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")
[[ -z "$TOOL" ]] && exit 0

# config 토글 (기본 on). off면 allow 미방출 → 전부 네이티브 프롬프트로 안전하게 degrade.
AUTO_ALLOW="true"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
HARNESS_CFG="$PROJECT_DIR/progress/harness-config.json"
if [[ -f "$HARNESS_CFG" ]] && jq -e '.firewall.auto_allow_tools == false' "$HARNESS_CFG" &>/dev/null; then
  AUTO_ALLOW="false"
fi
[[ "$AUTO_ALLOW" == "true" ]] || exit 0

emit_allow() {
  jq -n --arg reason "$1" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: $reason}}'
  exit 0
}

# 읽기전용 빌트인 도구 — 인자와 무관하게 안전.
# hooks.json matcher(WebFetch|WebSearch|NotebookRead|mcp__.*)와 정확히 동기화한다.
# Read/Grep/Glob/TodoWrite는 Claude Code 네이티브 자동허용이라 matcher에서 제외(핫패스 회피).
case "$TOOL" in
  WebFetch|WebSearch|NotebookRead)
    emit_allow "읽기전용 도구($TOOL) — cc-harness가 자동 허용했습니다."
    ;;
esac

# MCP 도구: mcp__server__verb_noun 의 leaf(도구명) 첫 토큰(verb)을 화이트리스트와 대조.
# read-verb 목록에 명시적으로 있을 때만 allow — 그 외(create/update/delete/send/upload 등
# write-verb, 미지 verb)는 fall-through(프롬프트). 화이트리스트라 목록 누락은 오허용이 아니라 프롬프트.
if [[ "$TOOL" == mcp__* ]]; then
  leaf="${TOOL##*__}"
  verb="${leaf%%_*}"
  case "$verb" in
    get|list|search|read|fetch|view|describe|query|find|show|inspect|count|download|suggest|resolve|preview|check|status|explain)
      emit_allow "MCP 읽기전용 도구(${verb}_) — cc-harness가 자동 허용했습니다."
      ;;
    *)
      exit 0
      ;;
  esac
fi

# 그 외 도구(NotebookEdit·file_upload·upload_image 등) — 판정 없이 네이티브 프롬프트로.
exit 0
