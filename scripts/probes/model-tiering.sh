#!/usr/bin/env bash
#
# model-tiering.sh — 모델 티어링 프로브 (F23)
# config/models.json(tiers 래티스 + assignments)을 단일 출처로 agents/*.md frontmatter의
# model과 대조해 능력·비용 역전/ drift/ 미등록을 정적 탐지.
# 후보를 JSON 배열로 출력: [{name,description,security_tier,source:"model-tiering"}]
# 읽기 전용 — 파일을 수정하지 않는다. jq/config 부재·malformed 시 graceful degrade([]).
#
set -euo pipefail
command -v jq &>/dev/null || { echo "[]"; exit 0; }

CONFIG="config/models.json"
[[ -f "$CONFIG" ]] || { echo "[]"; exit 0; }
# malformed JSON → 빈 배열 (진단을 망가뜨리지 않음)
CFG=$(jq -c . "$CONFIG" 2>/dev/null) || { echo "[]"; exit 0; }
[[ -n "$CFG" ]] || { echo "[]"; exit 0; }
[[ -d agents ]] || { echo "[]"; exit 0; }

# 1. agents/*.md frontmatter → {role: model} 맵 구성 (frontmatter는 JSON이 아니므로 셸 파싱)
FM="{}"
for f in agents/*.md; do
  [[ -f "$f" ]] || continue
  # key 접두사 제거 → 후행 인라인 주석(# ...) 제거 → 따옴표/공백 정리
  name=$(awk '/^name:/{sub(/^name:[[:space:]]*/,""); sub(/[[:space:]]*#.*/,""); gsub(/["[:space:]]/,""); print; exit}' "$f")
  model=$(awk '/^model:/{sub(/^model:[[:space:]]*/,""); sub(/[[:space:]]*#.*/,""); gsub(/["[:space:]]/,""); print; exit}' "$f")
  [[ -n "$name" && -n "$model" ]] || continue
  FM=$(jq -c --arg n "$name" --arg m "$model" '.[$n]=$m' <<<"$FM")
done

# 2. 규칙 평가 (drift / unregistered / critical-on-lowest / gate-below-reference)는 jq에서 일괄 처리
#    티어 순위: tiers 배열 인덱스가 작을수록 상위(고능력). gate rank > ref rank ⇒ 게이트가 저티어.
#
#    effort 규칙(F57, 6~8)은 model 규칙과 방향이 반대다 — effort_levels는 인덱스가 **클수록**
#    강하다(low < medium < high < xhigh < max). effort는 frontmatter에서 검사하지 않는다:
#    플러그인 서브에이전트에서 적용되는지 규명하지 못해(F57 AC-0) frontmatter에 선언하지 않기로
#    했고, config/models.json이 단일 출처이므로 config 내부 정합성만 본다.
jq -n -c --argjson cfg "$CFG" --argjson fm "$FM" '
  ($cfg.tiers // [])                            as $tiers
  | ($tiers | length)                           as $tlen
  | ($cfg.assignments // {})                    as $asg
  | ($cfg.rules.verification_gates // [])       as $gates
  | ($cfg.rules.gate_reference_role // "implementer") as $refrole
  | ($fm[$refrole] // null)                     as $refmodel
  | (if $refmodel == null then null else ($tiers | index($refmodel)) end) as $refrank
  | ($cfg.rules.effort_levels // [])            as $elevels
  | ($cfg.rules.effort_unsupported_models // []) as $eunsup
  | ($asg[$refrole].effort // null)             as $refeffort
  | (if $refeffort == null then null else ($elevels | index($refeffort)) end) as $referank
  | ($asg | to_entries)                         as $A
  | ($fm | to_entries | map(select(.value != "" and .value != null))) as $E
  | (
      # (1) drift: frontmatter ↔ config 불일치 / config 미등록 역할
      [ $E[] | .key as $role | .value as $model | ($asg[$role] // null) as $a
        | if $a == null
            then {name:"model drift: \($role) (config 미등록)",
                  description:"agents/\($role).md=\($model) — config/models.json assignments에 없음. 단일 출처에 등록 필요",
                  security_tier:"low", source:"model-tiering"}
          elif ($a.model != $model)
            then {name:"model drift: \($role)",
                  description:"frontmatter=\($model) vs config=\($a.model) — 단일 출처 불일치. 둘을 정렬",
                  security_tier:"low", source:"model-tiering"}
          else empty end ]
    + # (2) unregistered: tiers 래티스에 없는 모델 ID
      [ $E[] | .key as $role | .value as $model
        | if ($tiers | index($model)) == null
            then {name:"unregistered model: \($role)",
                  description:"\($model)이 config tiers 래티스에 없음 — 미등록/오타 가능. tiers에 추가하거나 모델 교정",
                  security_tier:"low", source:"model-tiering"}
          else empty end ]
    + # (3) critical 역할이 최저 티어
      [ $E[] | .key as $role | .value as $model
        | ($asg[$role].criticality // "standard") as $crit
        | ($tiers | index($model)) as $r
        | if ($crit == "critical" and $r != null and $tlen > 1 and $r == ($tlen - 1))
            then {name:"tier inversion: critical \($role) on lowest tier",
                  description:"\($role)(criticality=critical)이 최저 티어 \($model) 사용 — 격상 검토",
                  security_tier:"standard", source:"model-tiering"}
          else empty end ]
    + # (4) 검증 게이트가 기준 역할(implementer)보다 저티어
      [ $E[] | .key as $role | .value as $model
        | ($tiers | index($model)) as $r
        | if (($gates | index($role)) != null and $r != null and $refrank != null and $r > $refrank)
            then {name:"tier inversion: gate \($role) below \($refrole)",
                  description:"검증 게이트 \($role)=\($model)가 \($refrole)=\($refmodel)보다 저티어 — 게이트는 구현 동급 이상이어야 함",
                  security_tier:"standard", source:"model-tiering"}
          else empty end ]
    + # (5) 역방향 drift: config에 할당이 있으나 agent 파일이 없는 역할
      #     특히 gate_reference_role 부재는 rule4(게이트 역전)를 조용히 무력화 → 무결성 손상
      [ ($asg | keys[]) as $role
        | if ($fm[$role] // null) == null
            then ( if ($role == $refrole and ($gates | length) > 0)
                     then {name:"gate enforcement weakened: \($refrole) (agent 파일 없음)",
                           description:"gate_reference_role \($refrole)의 agents/\($refrole).md가 없어 게이트 역전(rule4) 검사가 조용히 무력화됨 — 검증 무결성 손상. config 또는 agent 복구 필요",
                           security_tier:"standard", source:"model-tiering"}
                   elif (($gates | index($role)) != null)
                     then {name:"verification gate missing agent: \($role)",
                           description:"검증 게이트 \($role)가 config에 있으나 agents/\($role).md 없음 — 게이트 미집행",
                           security_tier:"standard", source:"model-tiering"}
                   else {name:"model drift: \($role) (agent 파일 없음)",
                         description:"config/models.json에 \($role) 할당이 있으나 agents/\($role).md 없음 — stale 항목 또는 누락 agent",
                         security_tier:"low", source:"model-tiering"} end )
          else empty end ]
    + # (6) effort 미등록 값: rules.effort_levels 허용 집합 밖
      [ $A[] | .key as $role | (.value.effort // null) as $eff
        | if ($eff != null and ($elevels | length) > 0 and ($elevels | index($eff)) == null)
            then {name:"unregistered effort: \($role)",
                  description:"config assignments의 \($role).effort=\($eff)가 rules.effort_levels 허용 집합에 없음 — 오타이거나 미등록 값. 허용값으로 교정하거나 집합에 추가",
                  security_tier:"low", source:"model-tiering"}
          else empty end ]
    + # (7) effort 미지원 모델에 effort 지정 — 무시되므로 거짓 보증이 된다
      [ $A[] | .key as $role | (.value.effort // null) as $eff | (.value.model // "") as $m
        | if ($eff != null and (($eunsup | index($m)) != null))
            then {name:"effort on unsupported model: \($role)",
                  description:"\($role)의 모델 \($m)은 effort 파라미터를 지원하지 않는데 effort=\($eff)가 지정됨 — 적용되지 않으므로 강도가 걸려 있다는 거짓 보증이 된다. 지정을 제거하고 세션 상속에 맡길 것",
                  security_tier:"low", source:"model-tiering"}
          else empty end ]
    + # (8) 게이트 역할의 effort가 기준 역할보다 낮음 — model 축 rule4의 effort 대칭.
      #     effort_levels는 인덱스가 클수록 강하므로 gate rank < ref rank 이면 역전이다.
      [ $A[] | .key as $role | (.value.effort // null) as $eff
        | (if $eff == null then null else ($elevels | index($eff)) end) as $er
        | if (($gates | index($role)) != null and $er != null and $referank != null and $er < $referank)
            then {name:"effort inversion: gate \($role) below \($refrole)",
                  description:"검증 게이트 \($role)의 effort=\($eff)가 \($refrole)=\($refeffort)보다 낮음 — 게이트가 구현보다 얕게 추론하면 판정이 구현을 따라가지 못한다. 구현 동급 이상으로 올릴 것",
                  security_tier:"standard", source:"model-tiering"}
          else empty end ]
  )'
