#!/usr/bin/env bats

# pre-tool-firewall.sh tests (F28)
# 크로스도구 권한 계층: 읽기전용 도구는 permissionDecision:allow, 그 외는 fall-through.

HOOK="hooks/pre-tool-firewall.sh"

run_tool() {
  printf '%s' "$1" | bash "$HOOK"
}

# --- 읽기전용 빌트인 도구 → allow ---

@test "auto-allows WebFetch" {
  run run_tool '{"tool_name":"WebFetch","tool_input":{"url":"https://example.com"}}'
  [ "$status" -eq 0 ]
  [[ "$output" == *'"permissionDecision": "allow"'* ]]
}

@test "auto-allows WebSearch" {
  run run_tool '{"tool_name":"WebSearch","tool_input":{"query":"x"}}'
  [ "$status" -eq 0 ]
  [[ "$output" == *'"permissionDecision": "allow"'* ]]
}

@test "auto-allows NotebookRead" {
  run run_tool '{"tool_name":"NotebookRead"}'
  [ "$status" -eq 0 ]
  [[ "$output" == *'"permissionDecision": "allow"'* ]]
}

# --- MCP read-verb → allow ---

@test "auto-allows MCP get_ tool" {
  run run_tool '{"tool_name":"mcp__claude_ai_Gmail__get_thread"}'
  [[ "$output" == *'"permissionDecision": "allow"'* ]]
}

@test "auto-allows MCP list_ tool" {
  run run_tool '{"tool_name":"mcp__claude_ai_Google_Calendar__list_events"}'
  [[ "$output" == *'"permissionDecision": "allow"'* ]]
}

@test "auto-allows MCP search_ tool" {
  run run_tool '{"tool_name":"mcp__claude_ai_Gmail__search_threads"}'
  [[ "$output" == *'"permissionDecision": "allow"'* ]]
}

@test "auto-allows MCP read_ tool" {
  run run_tool '{"tool_name":"mcp__claude_ai_Google_Drive__read_file_content"}'
  [[ "$output" == *'"permissionDecision": "allow"'* ]]
}

@test "auto-allows MCP fetch_/view_ tool" {
  run run_tool '{"tool_name":"mcp__claude-in-chrome__get_page_text"}'
  [[ "$output" == *'"permissionDecision": "allow"'* ]]
}

# --- MCP write-verb → gate (no allow) ---

@test "does NOT auto-allow MCP create_ (write)" {
  run run_tool '{"tool_name":"mcp__claude_ai_Google_Calendar__create_event"}'
  [[ "$output" != *'"permissionDecision": "allow"'* ]]
}

@test "does NOT auto-allow MCP send_ (external)" {
  run run_tool '{"tool_name":"mcp__claude_ai_Gmail__send_message"}'
  [[ "$output" != *'"permissionDecision": "allow"'* ]]
}

@test "does NOT auto-allow MCP delete_ (destructive)" {
  run run_tool '{"tool_name":"mcp__claude_ai_Google_Calendar__delete_event"}'
  [[ "$output" != *'"permissionDecision": "allow"'* ]]
}

@test "does NOT auto-allow MCP update_/label_ (write)" {
  run run_tool '{"tool_name":"mcp__claude_ai_Gmail__label_message"}'
  [[ "$output" != *'"permissionDecision": "allow"'* ]]
}

@test "does NOT auto-allow MCP file_upload (upload)" {
  run run_tool '{"tool_name":"mcp__claude-in-chrome__file_upload"}'
  [[ "$output" != *'"permissionDecision": "allow"'* ]]
}

@test "does NOT auto-allow MCP computer (powerful control)" {
  run run_tool '{"tool_name":"mcp__claude-in-chrome__computer"}'
  [[ "$output" != *'"permissionDecision": "allow"'* ]]
}

# --- 미분류/미지 → 안전 기본값(gate) ---

@test "does NOT auto-allow unknown MCP verb (safe default)" {
  run run_tool '{"tool_name":"mcp__someserver__frobnicate_thing"}'
  [[ "$output" != *'"permissionDecision": "allow"'* ]]
}

@test "does NOT auto-allow malformed MCP name (no verb)" {
  run run_tool '{"tool_name":"mcp__weirdnodunder"}'
  [[ "$output" != *'"permissionDecision": "allow"'* ]]
}

@test "does NOT auto-allow NotebookEdit (write, out of allowlist)" {
  run run_tool '{"tool_name":"NotebookEdit"}'
  [[ "$output" != *'"permissionDecision": "allow"'* ]]
}

# --- 범위 제외: Edit/Write/Bash은 이 훅 소관 아님(다른 가드) → allow 미방출 ---

@test "does NOT auto-allow Edit (invariant-guard's domain)" {
  run run_tool '{"tool_name":"Edit"}'
  [[ "$output" != *'"permissionDecision": "allow"'* ]]
}

@test "does NOT auto-allow Bash (pre-bash-firewall's domain)" {
  run run_tool '{"tool_name":"Bash"}'
  [[ "$output" != *'"permissionDecision": "allow"'* ]]
}

# --- config 토글 ---

@test "auto_allow_tools=false disables allow (WebFetch no longer auto-allowed)" {
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/progress"
  printf '%s' '{"firewall":{"auto_allow_tools":false}}' > "$tmp/progress/harness-config.json"
  CLAUDE_PROJECT_DIR="$tmp" run run_tool '{"tool_name":"WebFetch"}'
  rm -rf "$tmp"
  [ "$status" -eq 0 ]
  [[ "$output" != *'"permissionDecision": "allow"'* ]]
}

# --- 에러/엣지: fail-safe (allow 미방출) ---

@test "no tool_name field → no allow" {
  run run_tool '{"tool_input":{}}'
  [ "$status" -eq 0 ]
  [[ "$output" != *'"permissionDecision": "allow"'* ]]
}

@test "empty tool_name → no allow" {
  run run_tool '{"tool_name":""}'
  [[ "$output" != *'"permissionDecision": "allow"'* ]]
}

@test "invalid JSON → no allow (graceful)" {
  run run_tool 'not json'
  [ "$status" -eq 0 ]
  [[ "$output" != *'"permissionDecision": "allow"'* ]]
}
