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

# F59/F62: 산문이 제거되면 런타임 변화를 알아챌 계층이 사라진다 — 강등하지 않기로 한
# 결정(sprint-45.json Q3=B)을 잠근다. test-writer와 isolation이 **같은 줄에** 있어야 한다:
# 사본 파일들은 병렬 디스패치용 isolation 언급을 따로 갖고 있어서, 단순히 'isolation'만
# 찾으면 test-writer 지시가 사라져도 통과한다(느슨한 판정이 mutation에서 실제로 드러났다).
#
# F62에서 목록의 단일 출처를 계약(_caller_side_copies)으로 옮기고 세 방향으로 검사한다.
# 목록을 테스트에 다시 적으면 두 곳이 drift하며, 이 세션의 두 판정이 각각 미등록 사본을
# 하나씩 찾아낸 것이 그 결과였다(false-positives.json에 F52로 두 번 기록된 패턴).
CALLER_COPY_CONTRACT="progress/contracts/sprint-45.json"
CALLER_COPY_PATTERN='test-writer.*isolation.*worktree'
CALLER_COPY_MIN=4   # AC-3 하한 — 목록을 줄여 검사를 우회하는 경로를 막는다

_caller_copy_list() {   # 계약에서 목록을 읽는다. 부재/malformed면 호출부가 실패한다(ES-1)
  jq -r '._caller_side_copies.files[]?' "$PLUGIN_ROOT/$CALLER_COPY_CONTRACT" 2>/dev/null
}

@test "F62: caller-side copies listed in the contract all carry the instruction (forward)" {
  local listed; listed=$(_caller_copy_list)
  [ -n "$listed" ] || { echo "계약 $CALLER_COPY_CONTRACT 에서 사본 목록을 읽지 못했다"; return 1; }
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    grep -qE "$CALLER_COPY_PATTERN" "$PLUGIN_ROOT/$f" \
      || { echo "$f 의 test-writer isolation 지시가 사라졌다"; return 1; }
  done <<< "$listed"
}

@test "F62: the contract list and the repo scan must be the same set (reverse)" {
  # progress/ 제외: lessons.md는 경위 서술이고 agent-comms는 판정 아카이브라 지시가 아니다.
  #
  # **포함이 아니라 동등성을 요구한다.** found ⊆ listed 만 보면 목록이 스캔 범위 밖으로
  # 도망갈 수 있다 — 정방향은 어떤 경로든 grep하지만 역방향은 *.md/*.tmpl 에 progress/ 제외로
  # 한정되므로, 그 갭에 있는 파일(이 테스트 파일 자신, 판정 JSON 등 저장소에 9개)을 목록에
  # 넣으면 정방향을 통과하면서 역방향에는 보이지 않는다. 그 상태로 진짜 사본의 지시를 전부
  # 지우면 실제 사본 0개인데 세 단언이 모두 초록이 된다(evaluator가 4→0 붕괴로 재현).
  # 목록이 실제를 정확히 반영하도록 강제하면 그 경로가 닫힌다.
  local found listed
  found=$(cd "$PLUGIN_ROOT" && grep -rl "$CALLER_COPY_PATTERN" \
            --include='*.md' --include='*.tmpl' \
            --exclude-dir=progress --exclude-dir=.git . 2>/dev/null \
          | sed 's|^\./||' | sort -u)
  listed=$(_caller_copy_list | sort -u)
  if [ "$listed" != "$found" ]; then
    echo "계약 목록과 저장소 스캔이 불일치"
    echo "  목록에만: $(comm -23 <(echo "$listed") <(echo "$found") | tr '\n' ' ')"
    echo "  스캔에만: $(comm -13 <(echo "$listed") <(echo "$found") | tr '\n' ' ')"
    return 1
  fi
}

@test "F62: the contract list cannot be emptied or shrunk past its floor (anti-tautology)" {
  # 목록을 외부화하면 '목록을 줄여 검사를 우회'하는 경로가 새로 생긴다. F46이 대칭 파서에서
  # 막은 퇴화와 같은 형태이므로 하한을 둔다 — 목록이 비면 위 두 루프가 돌지 않고 통과한다.
  #
  # **고유 항목을 센다(sort -u).** 줄 수만 세면 같은 파일을 반복해 넣어 하한을 채우면서
  # 실제 커버리지를 1개로 줄일 수 있다 — 목록을 ["CLAUDE.md"] x4 로 만들고 나머지 세
  # 사본에서 지시를 지우면 정방향은 같은 파일을 네 번 검사해 통과하고, 역방향은 found가
  # {CLAUDE.md}로 함께 줄어 집합 포함이 성립해 통과한다. 세 단언이 전부 초록인 채 배포
  # 사본 4개 중 3개가 지시를 잃는다(evaluator가 M2'로 재현). 비교 투영이 결과를 좌우하는
  # 상태(여기서는 항목 identity)를 누락한 것으로, false-positives.json의 F52 패턴이다.
  local n; n=$(_caller_copy_list | sort -u | grep -c . || true)
  [ "$n" -ge "$CALLER_COPY_MIN" ] \
    || { echo "사본 목록의 고유 항목이 하한 아래다 ($n < $CALLER_COPY_MIN)"; return 1; }
}
