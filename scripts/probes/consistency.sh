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

# 4. README 산문 숫자 주장 vs 실측 (F40-1) — 손으로 쓴 숫자는 조용히 부패하므로 실측과 대조.
#    각 컴포넌트의 모든 숫자 언급("N hooks", "hooks (N)")을 순회해 실측과 다른 것만 보고.
#    표기가 다양하므로 명시 패턴만 검사하고 미매칭은 침묵(과잉 보고 방지, F40 error_scenario).
if [[ -f README.md ]]; then
  T_ACT=$(grep -rhcE '^@test ' tests/*.bats 2>/dev/null | paste -sd+ - 2>/dev/null | bc 2>/dev/null || echo 0)
  # 컴포넌트별: "N <word>" 와 "<word> (N)" / "<Word> (N개" 형태 모두 순회.
  # while이 EOF read로 1을 반환하면 set -e가 스크립트를 죽이므로 함수 끝에 return 0 필수.
  check_readme_num() {
    local word="$1" actual="$2" n
    while read -r n; do
      [[ -n "$n" && "$n" != "$actual" ]] && add "README ${word} count stale (${n} vs ${actual})" "README가 ${word} ${n}을 주장하나 실측은 ${actual} — 산문 숫자 부패, 정정 필요" "low"
    done < <(grep -oiE "[0-9]+ ${word}|${word} \([0-9]+" README.md 2>/dev/null | grep -oE '[0-9]+')
    return 0
  }
  check_readme_num agents "$A_ACT"
  check_readme_num hooks  "$H_ACT"
  check_readme_num skills "$S_ACT"
  # 테스트 수: "테스트 N개," 또는 "테스트 N개)" — 뒤에 쉼표/괄호가 오는 경우만(테스트 수 주장).
  # "테스트 5개 점수"(min-of-5 5차원) 같은 다른 맥락은 제외해 오탐 방지(F40 error_scenario).
  while read -r n; do
    [[ -n "$n" && "$n" != "$T_ACT" ]] && add "README test count stale (${n} vs ${T_ACT})" "README '테스트 ${n}개'가 실측 @test ${T_ACT}과 불일치 — 정정 필요" "low"
  done < <(grep -oE '테스트 [0-9]+개[,)]' README.md 2>/dev/null | grep -oE '[0-9]+')
  # min-of-5 설명문 무결성: "테스트 5개 점수"의 '5'는 5차원 불변(측정값 아님). 위 검사는
  # [,)] suffix로 이 문장을 의도적으로 제외하므로(F40 오탐 회피), 이 문장이 "545개 점수" 등으로
  # 손상돼도 아무도 못 잡는다 — F52 구현 중 sed가 실제로 이 손상을 냈고 프로브가 놓친 사각지대.
  # min-of-5 문장이 존재할 때만(‘테스트 N개 점수’ 형태) 그 N이 5인지 검사한다 — 최소 README를
  # 쓰는 fixture는 이 문장이 없어 무관(F52 3차 evaluator).
  if grep -qE '테스트 [0-9]+개 점수' README.md; then
    grep -qF '테스트 5개 점수' README.md \
      || add "README min-of-5 문장 손상" "README의 min-of-5 설명 '테스트 5개 점수'의 숫자가 5가 아님 — 5차원 불변 문구 훼손(sed 등 앵커 없는 치환 의심)" "low"
  fi
fi

# 5. feature_list 의존성 정합 (F40-2): passes 모순 + 순환 의존 + 미존재 id 참조.
if [[ -f progress/feature_list.json ]]; then
  # (a) passes 모순: passes:true인데 passes:false 기능에 의존
  while IFS= read -r line; do
    [[ -n "$line" ]] && add "dependency-passes inconsistency" "$line — passed 기능이 미통과 기능에 의존(모순). 의존 기능 판정 또는 의존성 정정 필요" "low"
  done < <(jq -r '
    (.features // []) as $all
    | $all[] | select(.passes == true) as $f
    | ($f.dependencies // [])[] as $dep
    | ($all[] | select(.id == $dep) | select((.passes // false) != true))
    | "\($f.id) (passed) → \($dep) (not passed)"
  ' progress/feature_list.json 2>/dev/null || true)
  # (b) 순환 의존: 자기참조(A→A) 또는 직접 상호참조(A→B & B→A)
  while IFS= read -r line; do
    [[ -n "$line" ]] && add "dependency cycle" "$line — 순환 의존은 구현 순서를 정할 수 없음. 의존성 그래프 정정 필요" "low"
  done < <(jq -r '
    (.features // []) as $all
    | ($all | map({key: .id, value: (.dependencies // [])}) | from_entries) as $deps
    | $all[] | .id as $a | (.dependencies // [])[] as $b
    | select(($b == $a) or ((($deps[$b] // []) | index($a)) != null))
    | if $b == $a then "\($a) → 자기 자신(self-cycle)" else "\($a) ↔ \($b) (상호 순환)" end
  ' progress/feature_list.json 2>/dev/null | sort -u || true)
  # (c) 미존재 id 참조: 의존 대상이 feature 목록에 없음(데이터 부패 신호)
  while IFS= read -r line; do
    [[ -n "$line" ]] && add "dependency references unknown id" "$line — 존재하지 않는 feature id에 의존(데이터 부패). id 오타 또는 삭제된 기능 참조 확인" "low"
  done < <(jq -r '
    (.features // []) as $all
    | ($all | map(.id)) as $ids
    | $all[] | .id as $fid | (.dependencies // [])[] as $dep
    | select(($ids | index($dep)) == null)
    | "\($fid) → \($dep) (미존재 id)"
  ' progress/feature_list.json 2>/dev/null || true)
fi

echo "$CANDS"
