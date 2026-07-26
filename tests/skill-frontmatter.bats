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

@test "plugin.json hook count matches event-hook script count" {
  # lib.sh는 이벤트 훅이 아니라 source되는 공용 라이브러리이므로 제외한다
  ACTUAL=$(find "$PLUGIN_ROOT/hooks" -maxdepth 1 -name '*.sh' -not -name 'lib.sh' | wc -l | tr -d ' ')
  CLAIMED=$(jq -r '.description' "$PLUGIN_ROOT/.claude-plugin/plugin.json" | grep -oE '[0-9]+ hooks' | grep -oE '[0-9]+')
  [ "$ACTUAL" = "$CLAIMED" ] || { echo "hooks: actual=$ACTUAL claimed=$CLAIMED"; return 1; }
}

@test "every skill appears in CLAUDE.md and template routing" {
  # 목록을 하드코딩하지 않고 skills/에서 도출 — 새 스킬 추가 시 라우팅 누락을 자동 검출
  for d in "$PLUGIN_ROOT"/skills/*/; do
    skill=$(basename "$d")
    grep -q "/$skill" "$PLUGIN_ROOT/CLAUDE.md" || { echo "missing in CLAUDE.md: /$skill"; return 1; }
    grep -q "/$skill" "$PLUGIN_ROOT/templates/CLAUDE.md.tmpl" || { echo "missing in tmpl: /$skill"; return 1; }
    grep -q "/$skill" "$PLUGIN_ROOT/README.md" || { echo "missing in README: /$skill"; return 1; }
  done
}

@test "every agent has valid frontmatter with model field" {
  for f in "$PLUGIN_ROOT"/agents/*.md; do
    head -1 "$f" | grep -q '^---$' || { echo "no frontmatter: $(basename "$f")"; return 1; }
    grep -q '^model: claude-' "$f" || { echo "no model: $(basename "$f")"; return 1; }
  done
}

# F59: test-writer의 격리는 이중 보호다 — frontmatter 선언과 호출자 측 지시.
# 선언이 파일에서 사라지는 것은 정적으로 잡을 수 있는 유일한 축이므로 여기서 잠근다.
# 잡지 못하는 축은 "선언은 그대로인데 런타임이 무시하는" 변화이며, 그것이 산문을
# 남겨 둔 이유다(agents/test-writer.md 참조). 실측 확인: 2026-07-26, Claude Code
# 2.1.220 · 플러그인 v1.35.0 — 같은 블록의 disallowedTools·maxTurns는 무시됐고
# isolation만 적용됐다. 필드별 동작은 일반화할 수 없다.
@test "F59: test-writer declares isolation in frontmatter (half of the double guard)" {
  local f="$PLUGIN_ROOT/agents/test-writer.md"
  awk '/^---$/{c++; if(c==2) exit; next} c==1' "$f" | grep -qE '^isolation:[[:space:]]*"?worktree"?' \
    || { echo "test-writer frontmatter에 isolation: worktree 선언이 없다"; return 1; }
}

@test "F59: caller-side isolation instruction is kept (the other half)" {
  # 산문이 제거되면 런타임 변화를 알아챌 계층이 사라진다 — 강등하지 않기로 한 결정(Q3=B)을 잠근다.
  # test-writer와 isolation이 **같은 줄에** 있어야 한다: 두 파일 모두 병렬 디스패치용
  # isolation 언급을 따로 갖고 있어서, 단순히 'isolation'만 찾으면 test-writer 지시가
  # 사라져도 통과한다(느슨한 판정이 mutation에서 실제로 드러났다).
  # templates/CLAUDE.md.tmpl은 소비 프로젝트의 CLAUDE.md로 병합되는 스캐폴드다 — 다운스트림
  # 기준으로는 이쪽이 정본이므로 함께 잠근다. tmpl에 대한 기존 assertion은 줄 수·마커·스킬
  # 라우팅뿐이라 이 줄을 지워도 625건이 전량 통과했다(evaluator가 정적으로 증명).
  local f
  for f in CLAUDE.md skills/implement/SKILL.md templates/CLAUDE.md.tmpl; do
    grep -qE 'test-writer.*isolation.*worktree' "$PLUGIN_ROOT/$f" \
      || { echo "$f 의 test-writer isolation 지시가 사라졌다"; return 1; }
  done
}
