#!/usr/bin/env bats

# skill-frontmatter tests
# Verifies every skill has valid frontmatter and metadata counts match reality

PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"

@test "every skill directory contains SKILL.md" {
  for d in "$PLUGIN_ROOT"/skills/*/; do
    [ -f "$d/SKILL.md" ] || { echo "missing: $d/SKILL.md"; return 1; }
  done
}

@test "every SKILL.md has frontmatter with name matching its directory" {
  for d in "$PLUGIN_ROOT"/skills/*/; do
    DIR_NAME=$(basename "$d")
    head -1 "$d/SKILL.md" | grep -q '^---$' || { echo "no frontmatter: $DIR_NAME"; return 1; }
    NAME=$(awk '/^name:/{print $2; exit}' "$d/SKILL.md")
    [ "$NAME" = "$DIR_NAME" ] || { echo "name mismatch: dir=$DIR_NAME name=$NAME"; return 1; }
  done
}

@test "every SKILL.md description contains TRIGGER phrase for auto-routing" {
  for d in "$PLUGIN_ROOT"/skills/*/; do
    grep -q 'TRIGGER' "$d/SKILL.md" || { echo "no TRIGGER in description: $(basename "$d")"; return 1; }
  done
}

@test "plugin.json skill count matches skills/ directory count" {
  ACTUAL=$(find "$PLUGIN_ROOT/skills" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
  CLAIMED=$(jq -r '.description' "$PLUGIN_ROOT/.claude-plugin/plugin.json" | grep -oE '[0-9]+ skills' | grep -oE '[0-9]+')
  [ "$ACTUAL" = "$CLAIMED" ] || { echo "skills: actual=$ACTUAL claimed=$CLAIMED"; return 1; }
}

@test "plugin.json agent count matches agents/ file count" {
  ACTUAL=$(find "$PLUGIN_ROOT/agents" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')
  CLAIMED=$(jq -r '.description' "$PLUGIN_ROOT/.claude-plugin/plugin.json" | grep -oE '[0-9]+ agents' | grep -oE '[0-9]+')
  [ "$ACTUAL" = "$CLAIMED" ] || { echo "agents: actual=$ACTUAL claimed=$CLAIMED"; return 1; }
}

@test "plugin.json hook count matches hooks/ script count" {
  ACTUAL=$(find "$PLUGIN_ROOT/hooks" -maxdepth 1 -name '*.sh' | wc -l | tr -d ' ')
  CLAIMED=$(jq -r '.description' "$PLUGIN_ROOT/.claude-plugin/plugin.json" | grep -oE '[0-9]+ hooks' | grep -oE '[0-9]+')
  [ "$ACTUAL" = "$CLAIMED" ] || { echo "hooks: actual=$ACTUAL claimed=$CLAIMED"; return 1; }
}

@test "every routed skill appears in CLAUDE.md routing table" {
  for skill in brainstorm change-request implement hotfix debug finish-branch progress sync-docs; do
    grep -q "/$skill" "$PLUGIN_ROOT/CLAUDE.md" || { echo "missing in CLAUDE.md: /$skill"; return 1; }
    grep -q "/$skill" "$PLUGIN_ROOT/templates/CLAUDE.md.tmpl" || { echo "missing in tmpl: /$skill"; return 1; }
  done
}

@test "every agent has valid frontmatter with model field" {
  for f in "$PLUGIN_ROOT"/agents/*.md; do
    head -1 "$f" | grep -q '^---$' || { echo "no frontmatter: $(basename "$f")"; return 1; }
    grep -q '^model: claude-' "$f" || { echo "no model: $(basename "$f")"; return 1; }
  done
}
