#!/usr/bin/env bats

# probes.bats — 자동 발견 프로브 (F13)
# 각 프로브는 개선 후보를 JSON 배열로 stdout 출력: [{name,description,security_tier,source}]

PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
PROBES="$PLUGIN_ROOT/scripts/probes"

setup() {
  WORK=$(mktemp -d)
  mkdir -p "$WORK/progress" "$WORK/.claude-plugin" "$WORK/skills" "$WORK/agents" "$WORK/hooks" "$WORK/tests" "$WORK/docs"
}
teardown() { rm -rf "$WORK"; }

# 정상(일치) 매니페스트/구조를 만든다
seed_consistent() {
  echo '{"version":"1.7.0","description":"x — 2 agents, 1 hooks, 1 skills, 0 rules"}' > "$WORK/.claude-plugin/plugin.json"
  echo '{"version":"1.7.0"}' > "$WORK/package.json"
  echo '{"plugins":[{"version":"1.7.0"}]}' > "$WORK/.claude-plugin/marketplace.json"
  printf 'a\n' > "$WORK/agents/a.md"; printf 'b\n' > "$WORK/agents/b.md"
  printf 'x\n' > "$WORK/hooks/h.sh"
  mkdir -p "$WORK/skills/foo"; printf -- '---\nname: foo\ndescription: "x. TRIGGER: y"\n---\n' > "$WORK/skills/foo/SKILL.md"
  printf '# proj\n/foo\n' > "$WORK/CLAUDE.md"
  printf '/foo\n' > "$WORK/README.md"
  mkdir -p "$WORK/templates"; printf '/foo\n' > "$WORK/templates/CLAUDE.md.tmpl"
  echo '{"features":[]}' > "$WORK/progress/feature_list.json"
}

# --- consistency probe ---

@test "consistency: clean repo yields no candidates" {
  seed_consistent
  run bash -c "cd '$WORK' && bash '$PROBES/consistency.sh'"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | jq 'length')" -eq 0 ]
}

@test "consistency: version mismatch yields a candidate" {
  seed_consistent
  echo '{"version":"9.9.9"}' > "$WORK/package.json"
  run bash -c "cd '$WORK' && bash '$PROBES/consistency.sh'"
  [ "$(echo "$output" | jq 'length')" -ge 1 ]
  echo "$output" | jq -e '.[] | select(.name | test("version"; "i"))'
}

@test "consistency: skill count claim mismatch yields a candidate" {
  seed_consistent
  # plugin.json claims 1 skills but add a second skill dir
  mkdir -p "$WORK/skills/bar"; printf -- '---\nname: bar\ndescription: "x. TRIGGER: z"\n---\n' > "$WORK/skills/bar/SKILL.md"
  printf '/foo\n/bar\n' > "$WORK/CLAUDE.md"
  printf '/foo\n/bar\n' > "$WORK/README.md"
  printf '/foo\n/bar\n' > "$WORK/templates/CLAUDE.md.tmpl"
  run bash -c "cd '$WORK' && bash '$PROBES/consistency.sh'"
  [ "$(echo "$output" | jq 'length')" -ge 1 ]
}

# --- metrics probe ---

@test "metrics: first run records baseline, no candidates" {
  seed_consistent
  printf '@test "a" { true; }\n' > "$WORK/tests/x.bats"
  run bash -c "cd '$WORK' && bash '$PROBES/metrics.sh' 2026-06-13T00:00:00Z"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | jq 'length')" -eq 0 ]
  [ -f "$WORK/progress/metrics-history.json" ]
}

@test "metrics: regression (fewer tests) yields a candidate" {
  seed_consistent
  printf '@test "a" { true; }\n@test "b" { true; }\n' > "$WORK/tests/x.bats"
  bash -c "cd '$WORK' && bash '$PROBES/metrics.sh' 2026-06-13T00:00:00Z" >/dev/null
  # 테스트 하나 제거 (악화)
  printf '@test "a" { true; }\n' > "$WORK/tests/x.bats"
  run bash -c "cd '$WORK' && bash '$PROBES/metrics.sh' 2026-06-13T01:00:00Z"
  [ "$(echo "$output" | jq 'length')" -ge 1 ]
  echo "$output" | jq -e '.[] | select(.name | test("test"; "i"))'
}

# --- completeness probe ---

@test "completeness: hook without test yields a candidate" {
  seed_consistent
  printf 'x\n' > "$WORK/hooks/orphan-hook.sh"   # 대응 테스트 없음
  run bash -c "cd '$WORK' && bash '$PROBES/completeness.sh'"
  [ "$(echo "$output" | jq 'length')" -ge 1 ]
  echo "$output" | jq -e '.[] | select(.description | test("orphan-hook"))'
}

@test "completeness: skill without TRIGGER yields a candidate" {
  seed_consistent
  mkdir -p "$WORK/skills/notrig"; printf -- '---\nname: notrig\ndescription: "no trigger phrase"\n---\n' > "$WORK/skills/notrig/SKILL.md"
  run bash -c "cd '$WORK' && bash '$PROBES/completeness.sh'"
  echo "$output" | jq -e '.[] | select(.description | test("notrig"))'
}

# --- self-review probe ---

@test "self-review: FIXME/TODO comment yields a candidate" {
  seed_consistent
  printf '#!/usr/bin/env bash\n# FIXME: handle edge case\necho hi\n' > "$WORK/hooks/h.sh"
  run bash -c "cd '$WORK' && bash '$PROBES/self-review.sh'"
  [ "$(echo "$output" | jq 'length')" -ge 1 ]
}

# --- run-all + dedup ---

@test "run-all: aggregates and assigns ids" {
  seed_consistent
  echo '{"version":"9.9.9"}' > "$WORK/package.json"   # consistency 후보 유발
  run bash -c "cd '$WORK' && bash '$PROBES/run-all.sh' 2026-06-13T00:00:00Z"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.[0].id'
}

@test "run-all: dedups candidates already in feature_list" {
  seed_consistent
  echo '{"version":"9.9.9"}' > "$WORK/package.json"
  # 같은 후보가 feature_list에 이미 있으면 제외
  CAND=$(cd "$WORK" && bash "$PROBES/consistency.sh" | jq -r '.[0].name')
  jq -n --arg n "$CAND" '{features:[{id:"F99",name:$n,description:$n}]}' > "$WORK/progress/feature_list.json"
  run bash -c "cd '$WORK' && bash '$PROBES/run-all.sh' 2026-06-13T00:00:00Z"
  # 그 후보는 빠져야 한다
  [ "$(echo "$output" | jq --arg n "$CAND" '[.[]|select(.name==$n)]|length')" -eq 0 ]
}
