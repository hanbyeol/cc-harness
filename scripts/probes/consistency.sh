#!/usr/bin/env bash
#
# consistency.sh — 일관성 프로브 (F13)
# 매니페스트 버전 일치, plugin.json 구성요소 claim vs 실제 수, skill 라우팅 동기화를 검사.
# 불일치마다 개선 후보를 JSON 배열로 출력: [{name,description,security_tier,source}]
#
set -euo pipefail
command -v jq &>/dev/null || { echo "[]"; exit 0; }

CANDS="[]"
add() { CANDS=$(jq -c --arg n "$1" --arg d "$2" --arg t "${3:-standard}" \
  '. + [{name:$n, description:$d, security_tier:$t, source:"consistency"}]' <<<"$CANDS"); }

# 1. 매니페스트 버전 3종 일치
PKG=$(jq -r '.version // empty' package.json 2>/dev/null || echo "")
PLG=$(jq -r '.version // empty' .claude-plugin/plugin.json 2>/dev/null || echo "")
MKT=$(jq -r '.plugins[0].version // empty' .claude-plugin/marketplace.json 2>/dev/null || echo "")
if [[ -n "$PKG$PLG$MKT" ]] && { [[ "$PKG" != "$PLG" ]] || [[ "$PKG" != "$MKT" ]]; }; then
  add "version mismatch across manifests" "package=$PKG plugin=$PLG marketplace=$MKT — 버전 3종을 일치시켜야 함" "standard"
fi

# 2. plugin.json claim vs 실제 디렉토리/파일 수
DESC=$(jq -r '.description // ""' .claude-plugin/plugin.json 2>/dev/null || echo "")
claim() { grep -oE "[0-9]+ $1" <<<"$DESC" | grep -oE '[0-9]+' | head -1; }
A_ACT=$(find agents -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
H_ACT=$(find hooks -maxdepth 1 -name '*.sh' -not -name 'lib.sh' 2>/dev/null | wc -l | tr -d ' ')
S_ACT=$(find skills -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
for pair in "agents:$A_ACT" "hooks:$H_ACT" "skills:$S_ACT"; do
  key=${pair%%:*}; act=${pair##*:}
  cl=$(claim "$key")
  if [[ -n "$cl" && "$cl" != "$act" ]]; then
    add "${key} count claim mismatch" "plugin.json claims ${cl} ${key} but actual is ${act} — 갱신 필요" "low"
  fi
done

# 3. 모든 skill이 CLAUDE.md·tmpl·README 라우팅에 존재
if [[ -d skills ]]; then
  for d in skills/*/; do
    [[ -d "$d" ]] || continue
    s=$(basename "$d")
    for f in CLAUDE.md templates/CLAUDE.md.tmpl README.md; do
      [[ -f "$f" ]] || continue
      grep -q "/$s" "$f" 2>/dev/null || add "skill /$s missing in $(basename "$f") routing" "/$s 가 $f 라우팅에 없음 — 자동 라우팅 누락" "low"
    done
  done
fi

echo "$CANDS"
