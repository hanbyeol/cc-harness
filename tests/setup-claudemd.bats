#!/usr/bin/env bats

# setup-claudemd.sh tests
# Verifies plugin-native loading: no agent/skill copying, idempotent CLAUDE.md,
# v1.4 copy migration, broken-marker safety

PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
HOOK="$PLUGIN_ROOT/hooks/setup-claudemd.sh"
SENTINEL="기준 역전파 원칙"

setup() {
  WORK=$(mktemp -d)
  cd "$WORK" && git init -q .
}

teardown() {
  rm -rf "$WORK"
}

run_setup() {
  CLAUDE_PROJECT_DIR="$WORK" bash "$HOOK"
}

@test "fresh project: creates CLAUDE.md with exactly one marker section" {
  run run_setup
  [ "$status" -eq 0 ]
  [ "$(grep -c 'cc-harness:begin' CLAUDE.md)" -eq 1 ]
  [ "$(grep -c "$SENTINEL" CLAUDE.md)" -eq 1 ]
}

@test "fresh project: copies rules but NOT agents/skills/hooks" {
  run run_setup
  [ -d .claude/rules ]
  [ ! -d .claude/agents ]
  [ ! -d .claude/skills ]
  [ ! -d .claude/hooks ]
}

@test "idempotent: running twice yields byte-identical CLAUDE.md" {
  run_setup >/dev/null 2>&1
  cp CLAUDE.md claudemd.run1
  run_setup >/dev/null 2>&1
  cmp -s CLAUDE.md claudemd.run1
}

@test "user CLAUDE.md: content preserved, one marker section appended" {
  printf '# myproj\n\nMy own rules here.\n' > CLAUDE.md
  run_setup >/dev/null 2>&1
  run_setup >/dev/null 2>&1
  grep -q 'My own rules here.' CLAUDE.md
  [ "$(grep -c 'cc-harness:begin' CLAUDE.md)" -eq 1 ]
}

@test "harness content already present without marker: skips insertion" {
  { echo "# proj"; echo; tail -n +2 "$PLUGIN_ROOT/CLAUDE.md"; } > CLAUDE.md
  BEFORE=$(cat CLAUDE.md)
  run_setup >/dev/null 2>&1
  [ "$BEFORE" = "$(cat CLAUDE.md)" ]
}

@test "duplicated harness content (body + marker section): deduped to single copy" {
  { echo "# proj"; echo; tail -n +2 "$PLUGIN_ROOT/CLAUDE.md"; echo
    echo "<!-- cc-harness:begin -->"; tail -n +2 "$PLUGIN_ROOT/CLAUDE.md"; echo
    echo "<!-- cc-harness:end -->"; } > CLAUDE.md
  run_setup >/dev/null 2>&1
  [ "$(grep -c 'cc-harness:begin' CLAUDE.md)" -eq 0 ]
  [ "$(grep -c "$SENTINEL" CLAUDE.md)" -eq 1 ]
}

@test "broken marker (begin without end): file untouched" {
  printf '# proj\n\n<!-- cc-harness:begin -->\nstuff\nuser tail\n' > CLAUDE.md
  BEFORE=$(cat CLAUDE.md)
  run_setup >/dev/null 2>&1
  [ "$BEFORE" = "$(cat CLAUDE.md)" ]
}

@test "v1.4 migration: identical agent/skill copies removed" {
  mkdir -p .claude/agents .claude/skills
  cp "$PLUGIN_ROOT"/agents/*.md .claude/agents/
  cp -r "$PLUGIN_ROOT"/skills/* .claude/skills/
  run_setup >/dev/null 2>&1
  [ ! -d .claude/agents ]
  [ ! -d .claude/skills ]
}

@test "v1.4 migration: customized copies preserved with notice" {
  mkdir -p .claude/agents
  cp "$PLUGIN_ROOT"/agents/architect.md .claude/agents/
  echo "# my customization" >> .claude/agents/architect.md
  run run_setup
  [ "$status" -eq 0 ]
  [ -f .claude/agents/architect.md ]
  [[ "$output" == *"커스터마이징"* ]]
}

@test "v1.4 migration: matching settings.json hooks removed with scripts" {
  mkdir -p .claude/hooks
  for f in "$PLUGIN_ROOT"/hooks/*.sh; do
    b=$(basename "$f")
    [ "$b" = "setup-claudemd.sh" ] && continue
    cp "$f" ".claude/hooks/$b"
  done
  cp "$PLUGIN_ROOT/settings.json" .claude/settings.json
  run_setup >/dev/null 2>&1
  [ ! -d .claude/hooks ]
  [ "$(jq 'has("hooks")' .claude/settings.json)" = "false" ]
}

@test "v1.4 migration: modified settings.json hooks left untouched" {
  mkdir -p .claude/hooks
  cp "$PLUGIN_ROOT/hooks/pre-bash-firewall.sh" .claude/hooks/
  jq '.hooks.PreToolUse[0].matcher = "Bash|Glob"' "$PLUGIN_ROOT/settings.json" > .claude/settings.json
  run_setup >/dev/null 2>&1
  [ -f .claude/hooks/pre-bash-firewall.sh ]
  [ "$(jq 'has("hooks")' .claude/settings.json)" = "true" ]
}

# --- Versioned upgrade process ---

PLUGIN_VERSION_NOW() {
  jq -r '.version' "$PLUGIN_ROOT/.claude-plugin/plugin.json"
}

@test "upgrade: records installed plugin version in state file" {
  run_setup >/dev/null 2>&1
  [ "$(cat .claude/.cc-harness-installed)" = "$(PLUGIN_VERSION_NOW)" ]
}

@test "upgrade: same version skips migration (stale copies untouched)" {
  run_setup >/dev/null 2>&1
  mkdir -p .claude/agents
  cp "$PLUGIN_ROOT"/agents/architect.md .claude/agents/
  run_setup >/dev/null 2>&1
  [ -f .claude/agents/architect.md ]
}

@test "upgrade: version change triggers migration of identical copies" {
  run_setup >/dev/null 2>&1
  mkdir -p .claude/agents
  cp "$PLUGIN_ROOT"/agents/architect.md .claude/agents/
  echo "0.0.1" > .claude/.cc-harness-installed
  run_setup >/dev/null 2>&1
  [ ! -d .claude/agents ]
}

@test "upgrade: pristine rule refreshed to new plugin version" {
  run_setup >/dev/null 2>&1
  # 이전 plugin 버전이 배포했던 rule을 시뮬레이션: 내용과 manifest 해시가 일치(pristine)
  echo "# old shipped rule content" > .claude/rules/general.md
  OLD_HASH=$(shasum -a 256 .claude/rules/general.md | awk '{print $1}')
  grep -v '^general.md ' .claude/.cc-harness-rules.sha256 > m.tmp && mv m.tmp .claude/.cc-harness-rules.sha256
  echo "general.md $OLD_HASH" >> .claude/.cc-harness-rules.sha256
  echo "0.0.1" > .claude/.cc-harness-installed
  run run_setup
  [ "$status" -eq 0 ]
  cmp -s .claude/rules/general.md "$PLUGIN_ROOT/rules/general.md"
  [[ "$output" == *"rules 갱신"* ]]
}

@test "upgrade: user-modified rule preserved" {
  run_setup >/dev/null 2>&1
  echo "- my custom rule" >> .claude/rules/general.md
  echo "0.0.1" > .claude/.cc-harness-installed
  run run_setup
  [ "$status" -eq 0 ]
  grep -q 'my custom rule' .claude/rules/general.md
  [[ "$output" == *"보존"* ]]
}

@test "upgrade: pre-1.5 install (empty marker file) upgrades cleanly" {
  mkdir -p .claude
  : > .claude/.cc-harness-installed
  mkdir -p .claude/agents
  cp "$PLUGIN_ROOT"/agents/evaluator.md .claude/agents/
  run run_setup
  [ "$status" -eq 0 ]
  [ ! -d .claude/agents ]
  [ "$(cat .claude/.cc-harness-installed)" = "$(PLUGIN_VERSION_NOW)" ]
  [[ "$output" == *"업그레이드를 적용했습니다"* ]]
}

@test "upgrade: notice shows old and new version" {
  run_setup >/dev/null 2>&1
  echo "1.4.0" > .claude/.cc-harness-installed
  run run_setup
  [[ "$output" == *"1.4.0 → $(PLUGIN_VERSION_NOW) 업그레이드"* ]]
}
