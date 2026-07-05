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

@test "completeness: missing runtime state file yields a candidate (F36)" {
  seed_consistent   # progress/feature_list.json 존재, harness-config 등은 없음
  run bash -c "cd '$WORK' && bash '$PROBES/completeness.sh'"
  echo "$output" | jq -e '.[] | select(.description | test("harness-config.json"))'
}

@test "completeness: no runtime candidate when all present (F36 no false-positive)" {
  seed_consistent
  echo '{"scoring":{"pass_threshold":7}}' > "$WORK/progress/harness-config.json"
  echo '{"current_phase":"specification"}' > "$WORK/progress/phase-gate.json"
  mkdir -p "$WORK/evals"; echo '{"criteria":[]}' > "$WORK/evals/acceptance-criteria.json"
  run bash -c "cd '$WORK' && bash '$PROBES/completeness.sh'"
  [ "$(echo "$output" | jq '[.[] | select(.description | test("runtime state missing"))] | length')" -eq 0 ]
}

@test "completeness: no runtime check when not a harness project (F36 scope guard)" {
  # feature_list.json 부재 → runtime 검사 미발동(플러그인만 얹은 무관 프로젝트)
  rm -rf "${WORK:?}"; mkdir -p "$WORK/hooks" "$WORK/skills"
  run bash -c "cd '$WORK' && bash '$PROBES/completeness.sh'"
  [ "$(echo "$output" | jq '[.[] | select(.description | test("runtime state missing"))] | length')" -eq 0 ]
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

# --- model-tiering probe (F23) ---

# 현재 할당과 정합하는 config + agents를 만든다 (역전/ drift 없음)
seed_models() {
  mkdir -p "$WORK/config" "$WORK/agents"
  cat > "$WORK/config/models.json" <<'JSON'
{
  "tiers": ["claude-fable-5","claude-opus-4-8","claude-sonnet-4-6","claude-haiku-4-5"],
  "assignments": {
    "implementer":      {"model":"claude-opus-4-8","criticality":"critical"},
    "evaluator":        {"model":"claude-opus-4-8","criticality":"critical"},
    "security-auditor": {"model":"claude-opus-4-8","criticality":"critical"},
    "qa-reviewer":      {"model":"claude-haiku-4-5","criticality":"low"}
  },
  "rules": {"verification_gates":["evaluator","security-auditor"],"gate_reference_role":"implementer"}
}
JSON
  agent() { printf -- '---\nname: %s\ndescription: "x"\nmodel: %s\n---\n' "$1" "$2" > "$WORK/agents/$1.md"; }
  agent implementer claude-opus-4-8
  agent evaluator claude-opus-4-8
  agent security-auditor claude-opus-4-8
  agent qa-reviewer claude-haiku-4-5
}

@test "model-tiering: consistent assignment yields no candidates" {
  seed_models
  run bash -c "cd '$WORK' && bash '$PROBES/model-tiering.sh'"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | jq 'length')" -eq 0 ]
}

@test "model-tiering: gate below implementer yields inversion candidate" {
  seed_models
  # evaluator를 최저 티어로 — 검증 게이트가 implementer(opus)보다 저티어
  printf -- '---\nname: evaluator\ndescription: "x"\nmodel: claude-haiku-4-5\n---\n' > "$WORK/agents/evaluator.md"
  jq '.assignments.evaluator.model="claude-haiku-4-5"' "$WORK/config/models.json" > "$WORK/config/m.json" && mv "$WORK/config/m.json" "$WORK/config/models.json"
  run bash -c "cd '$WORK' && bash '$PROBES/model-tiering.sh'"
  [ "$(echo "$output" | jq 'length')" -ge 1 ]
  echo "$output" | jq -e '.[] | select(.name | test("inversion|역전|gate"; "i"))'
}

@test "model-tiering: critical role on lowest tier yields candidate" {
  seed_models
  # implementer(critical)를 최저 티어로
  printf -- '---\nname: implementer\ndescription: "x"\nmodel: claude-haiku-4-5\n---\n' > "$WORK/agents/implementer.md"
  jq '.assignments.implementer.model="claude-haiku-4-5"' "$WORK/config/models.json" > "$WORK/config/m.json" && mv "$WORK/config/m.json" "$WORK/config/models.json"
  run bash -c "cd '$WORK' && bash '$PROBES/model-tiering.sh'"
  [ "$(echo "$output" | jq 'length')" -ge 1 ]
}

@test "model-tiering: frontmatter-config drift yields candidate" {
  seed_models
  # frontmatter만 바꿔 config와 불일치
  printf -- '---\nname: qa-reviewer\ndescription: "x"\nmodel: claude-sonnet-4-6\n---\n' > "$WORK/agents/qa-reviewer.md"
  run bash -c "cd '$WORK' && bash '$PROBES/model-tiering.sh'"
  [ "$(echo "$output" | jq 'length')" -ge 1 ]
  echo "$output" | jq -e '.[] | select(.name | test("drift"; "i"))'
}

@test "model-tiering: unregistered model id yields candidate" {
  seed_models
  printf -- '---\nname: qa-reviewer\ndescription: "x"\nmodel: claude-bogus-9\n---\n' > "$WORK/agents/qa-reviewer.md"
  jq '.assignments."qa-reviewer".model="claude-bogus-9"' "$WORK/config/models.json" > "$WORK/config/m.json" && mv "$WORK/config/m.json" "$WORK/config/models.json"
  run bash -c "cd '$WORK' && bash '$PROBES/model-tiering.sh'"
  [ "$(echo "$output" | jq 'length')" -ge 1 ]
  echo "$output" | jq -e '.[] | select(.name | test("unregistered|미등록"; "i"))'
}

@test "model-tiering: missing config degrades gracefully" {
  mkdir -p "$WORK/agents"
  printf -- '---\nname: implementer\nmodel: claude-opus-4-8\n---\n' > "$WORK/agents/implementer.md"
  run bash -c "cd '$WORK' && bash '$PROBES/model-tiering.sh'"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | jq 'length')" -eq 0 ]
}

@test "model-tiering: malformed config degrades gracefully" {
  seed_models
  printf 'not json {{{' > "$WORK/config/models.json"
  run bash -c "cd '$WORK' && bash '$PROBES/model-tiering.sh'"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | jq 'length')" -eq 0 ]
}

@test "run-all: includes model-tiering source" {
  seed_consistent
  seed_models
  # evaluator 역전으로 model-tiering 후보 1건 유발
  printf -- '---\nname: evaluator\ndescription: "x"\nmodel: claude-haiku-4-5\n---\n' > "$WORK/agents/evaluator.md"
  jq '.assignments.evaluator.model="claude-haiku-4-5"' "$WORK/config/models.json" > "$WORK/config/m.json" && mv "$WORK/config/m.json" "$WORK/config/models.json"
  run bash -c "cd '$WORK' && bash '$PROBES/run-all.sh' 2026-06-13T00:00:00Z"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.[] | select(.source=="model-tiering")'
}

@test "model-tiering: single-tier lattice disables inversion rules (no false positive)" {
  seed_models
  # tiers를 단일 모델로 축소 — 역전 규칙(critical-on-lowest, gate-below-ref)이 무력화돼야
  jq '.tiers=["claude-opus-4-8"]' "$WORK/config/models.json" > "$WORK/config/m.json" && mv "$WORK/config/m.json" "$WORK/config/models.json"
  # 모든 agent를 그 단일 모델로
  for r in implementer evaluator security-auditor qa-reviewer; do
    printf -- '---\nname: %s\ndescription: "x"\nmodel: claude-opus-4-8\n---\n' "$r" > "$WORK/agents/$r.md"
    jq --arg r "$r" '.assignments[$r].model="claude-opus-4-8"' "$WORK/config/models.json" > "$WORK/config/m.json" && mv "$WORK/config/m.json" "$WORK/config/models.json"
  done
  run bash -c "cd '$WORK' && bash '$PROBES/model-tiering.sh'"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | jq 'length')" -eq 0 ]
}

@test "model-tiering: reverse drift — config role without agent file" {
  seed_models
  # config에 agent 파일 없는 역할 추가
  jq '.assignments["ghost"]={"model":"claude-sonnet-4-6","criticality":"standard"}' "$WORK/config/models.json" > "$WORK/config/m.json" && mv "$WORK/config/m.json" "$WORK/config/models.json"
  run bash -c "cd '$WORK' && bash '$PROBES/model-tiering.sh'"
  [ "$(echo "$output" | jq 'length')" -ge 1 ]
  echo "$output" | jq -e '.[] | select(.name | test("agent 파일 없음|missing agent"; "i"))'
}

@test "model-tiering: missing gate_reference_role disables rule4 (flagged, not silent)" {
  seed_models
  # implementer(gate_reference_role) agent 파일 제거 — config에는 유지
  rm -f "$WORK/agents/implementer.md"
  run bash -c "cd '$WORK' && bash '$PROBES/model-tiering.sh'"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.[] | select(.name | test("gate enforcement weakened"; "i"))'
}

@test "model-tiering: verification gate missing agent file is flagged" {
  seed_models
  rm -f "$WORK/agents/security-auditor.md"
  run bash -c "cd '$WORK' && bash '$PROBES/model-tiering.sh'"
  echo "$output" | jq -e '.[] | select(.name | test("verification gate missing agent"; "i"))'
}

@test "model-tiering: inline comment on model field is stripped (no false unregistered)" {
  seed_models
  # 정합 모델 + 인라인 주석 — 파싱이 주석을 떼어내야 오탐 없음
  printf -- '---\nname: qa-reviewer\ndescription: "x"\nmodel: claude-haiku-4-5  # cheapest\n---\n' > "$WORK/agents/qa-reviewer.md"
  run bash -c "cd '$WORK' && bash '$PROBES/model-tiering.sh'"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | jq '[.[]|select(.name|test("unregistered|미등록";"i"))]|length')" -eq 0 ]
}

# --- evidence probe (F25) ---

# 최신 evaluator-feedback 레코드를 만든다 (archive/ 제외, lexical 정렬)
seed_feedback() {
  mkdir -p "$WORK/progress/agent-comms"
}
fb() { # fb <timestamp> <json-content>
  printf '%s' "$2" > "$WORK/progress/agent-comms/evaluator-feedback-$1.json"
}

@test "evidence: latest pass with evidence yields no candidate" {
  seed_feedback
  fb 2026-01-01T00-00-00 '{"verdict":"pass"}'
  fb 2026-02-01T00-00-00 '{"verdict":"pass","evidence":{"bats":{"command":"bats","result":"ok"}}}'
  run bash -c "cd '$WORK' && bash '$PROBES/evidence.sh'"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | jq 'length')" -eq 0 ]
}

@test "evidence: latest pass missing evidence yields a candidate" {
  seed_feedback
  fb 2026-01-01T00-00-00 '{"verdict":"pass","evidence":{"x":1}}'
  fb 2026-03-01T00-00-00 '{"verdict":"pass"}'
  run bash -c "cd '$WORK' && bash '$PROBES/evidence.sh'"
  [ "$(echo "$output" | jq 'length')" -ge 1 ]
  echo "$output" | jq -e '.[] | select(.source=="evidence")'
}

@test "evidence: latest pass with empty evidence object yields a candidate" {
  seed_feedback
  fb 2026-03-01T00-00-00 '{"verdict":"pass","evidence":{}}'
  run bash -c "cd '$WORK' && bash '$PROBES/evidence.sh'"
  [ "$(echo "$output" | jq 'length')" -ge 1 ]
}

@test "evidence: latest fail without evidence yields no candidate" {
  seed_feedback
  fb 2026-03-01T00-00-00 '{"verdict":"fail"}'
  run bash -c "cd '$WORK' && bash '$PROBES/evidence.sh'"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | jq 'length')" -eq 0 ]
}

@test "evidence: newer evidenced pass masks older evidence-less pass" {
  seed_feedback
  fb 2026-01-01T00-00-00 '{"verdict":"pass"}'
  fb 2026-09-01T00-00-00 '{"verdict":"pass","evidence":{"bats":{"result":"257 ok"}}}'
  run bash -c "cd '$WORK' && bash '$PROBES/evidence.sh'"
  [ "$(echo "$output" | jq 'length')" -eq 0 ]
}

@test "evidence: no agent-comms degrades gracefully" {
  run bash -c "cd '$WORK' && bash '$PROBES/evidence.sh'"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | jq 'length')" -eq 0 ]
}

@test "evidence: malformed latest record degrades gracefully" {
  seed_feedback
  fb 2026-09-01T00-00-00 'not json {{{'
  run bash -c "cd '$WORK' && bash '$PROBES/evidence.sh'"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | jq 'length')" -eq 0 ]
}

@test "evidence: archive/ records are excluded" {
  seed_feedback
  mkdir -p "$WORK/progress/agent-comms/archive"
  printf '%s' '{"verdict":"pass"}' > "$WORK/progress/agent-comms/archive/evaluator-feedback-2030-01-01T00-00-00.json"
  fb 2026-02-01T00-00-00 '{"verdict":"pass","evidence":{"x":{"command":"y"}}}'
  run bash -c "cd '$WORK' && bash '$PROBES/evidence.sh'"
  [ "$(echo "$output" | jq 'length')" -eq 0 ]
}

@test "run-all: includes evidence source" {
  seed_consistent
  seed_feedback
  fb 2026-09-01T00-00-00 '{"verdict":"pass"}'
  run bash -c "cd '$WORK' && bash '$PROBES/run-all.sh' 2026-09-01T00:00:00Z"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.[] | select(.source=="evidence")'
}
