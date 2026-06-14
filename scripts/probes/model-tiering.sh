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
  name=$(awk -F':' '/^name:/{sub(/^[^:]*:/,"",$0); gsub(/[" ]/,"",$0); print; exit}' "$f")
  model=$(awk -F':' '/^model:/{sub(/^[^:]*:/,"",$0); gsub(/[" ]/,"",$0); print; exit}' "$f")
  [[ -n "$name" && -n "$model" ]] || continue
  FM=$(jq -c --arg n "$name" --arg m "$model" '.[$n]=$m' <<<"$FM")
done

# 2. 규칙 평가 (drift / unregistered / critical-on-lowest / gate-below-reference)는 jq에서 일괄 처리
#    티어 순위: tiers 배열 인덱스가 작을수록 상위(고능력). gate rank > ref rank ⇒ 게이트가 저티어.
jq -n -c --argjson cfg "$CFG" --argjson fm "$FM" '
  ($cfg.tiers // [])                            as $tiers
  | ($tiers | length)                           as $tlen
  | ($cfg.assignments // {})                    as $asg
  | ($cfg.rules.verification_gates // [])       as $gates
  | ($cfg.rules.gate_reference_role // "implementer") as $refrole
  | ($fm[$refrole] // null)                     as $refmodel
  | (if $refmodel == null then null else ($tiers | index($refmodel)) end) as $refrank
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
  )'
