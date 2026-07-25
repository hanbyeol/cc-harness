#!/usr/bin/env bash
#
# calibration.sh — evaluator 판정 보정 프로브 (F37)
#
# 단일 judge 1회 호출에 게이트 신뢰도가 걸려 있으므로, 최신 evaluator 판정을 감사해
# judge 자체의 산술·일관성 결함(a~d)과 golden-set 대비 점수 분포 이탈(e)을 후보로 보고한다.
# 최신 1건만 본다 — evidence.sh와 동일하게 historical 노이즈를 피한다(0건 != 건강).
# 읽기 전용, jq/파일 부재·malformed graceful degrade.
#
set -euo pipefail
command -v jq &>/dev/null || { echo "[]"; exit 0; }

COMMS="progress/agent-comms"
CFG="progress/harness-config.json"
GOLDEN="evals/calibration/golden-set.json"
PASS_T=7
[[ -f "$CFG" ]] && PASS_T=$(jq -r '.scoring.pass_threshold // 7' "$CFG" 2>/dev/null || echo 7)

CANDS="[]"
add() { CANDS=$(jq -c --arg n "$1" --arg d "$2" --arg t "${3:-standard}" \
  '. + [{name:$n, description:$d, security_tier:$t, source:"calibration"}]' <<<"$CANDS"); }

# 피드백 디렉토리 부재 → 빈 배열(evidence.sh 패턴, exit 0). set -e/pipefail에서 파일 0건 시
# ls 실패가 전파돼 프로브가 중단되지 않도록 디렉토리 가드 + 파이프 뒤 `|| true`.
[[ -d "$COMMS" ]] || { echo "[]"; exit 0; }

# 최신(비archive) 판정 레코드
LATEST=$(ls -1 "$COMMS"/evaluator-feedback-*.json 2>/dev/null | sort -r | head -1 || true)
[[ -z "$LATEST" || ! -f "$LATEST" ]] && { echo "[]"; exit 0; }
jq -e '.' "$LATEST" &>/dev/null || { echo "[]"; exit 0; }  # malformed → 조용히 skip

FEAT=$(jq -r '.features_evaluated // [] | join(",")' "$LATEST" 2>/dev/null || echo "?")
VERDICT=$(jq -r '.verdict // "unknown"' "$LATEST" 2>/dev/null || echo "unknown")
SCORE=$(jq -r '.score // "null"' "$LATEST" 2>/dev/null || echo "null")
# 5차원 min (숫자가 아닌/누락 차원은 제외 후 5개 미만이면 null)
MIN=$(jq -r '[.scores.functionality, .scores.code_quality, .scores.security, .scores.error_handling, .scores.test_coverage] | map(select(type=="number")) | if length==5 then min else null end' "$LATEST" 2>/dev/null || echo "null")

# (a) 산술 정합: recorded score != min-of-5 (INV-2를 어긴 판정 기록)
if [[ "$SCORE" != "null" && "$MIN" != "null" && "$SCORE" != "$MIN" ]]; then
  add "evaluator score mismatch ($FEAT)" "최신 판정 score=$SCORE 이지만 min-of-5=$MIN — 종합점수가 최솟값과 불일치(INV-2 산술 오류). $LATEST 재검토 필요" "standard"
fi

# (b) 5차원 불완전한데 판정을 내림 (min 재검증 불가)
if [[ "$MIN" == "null" ]]; then
  add "evaluator scores incomplete ($FEAT)" "최신 판정의 5차원 점수가 불완전/비수치 — min-of-5 재검증 불가. $LATEST" "standard"
fi

# (c) verdict/score 모순: pass인데 min-of-5 < pass_threshold
if [[ "$VERDICT" == pass* && "$MIN" != "null" ]] && awk -v m="$MIN" -v t="$PASS_T" 'BEGIN{exit !(m+0 < t+0)}'; then
  add "evaluator verdict/score contradiction ($FEAT)" "verdict=pass 이지만 min-of-5=$MIN < pass_threshold=$PASS_T — 통과 요건 미달 판정. $LATEST" "critical"
fi

# (d) evidence 없는 pass (evidence.sh와 상보 — calibration 관점 재확인)
# evidence 또는 grounded_evidence 중 하나라도 non-empty면 근거 있음(F47 — 필드명 변형 폴백).
HAS_EV=$(jq -r '((.evidence | type=="object" and length>0) or (.grounded_evidence | type=="object" and length>0))' "$LATEST" 2>/dev/null || echo "false")
if [[ "$VERDICT" == pass* && "$HAS_EV" != "true" ]]; then
  add "evaluator pass without evidence ($FEAT)" "verdict=pass인데 evidence 객체가 비어있음 — evidence over claims 위반. $LATEST" "standard"
fi

# (e) golden-set 희소 점수 탐지 (F37-2c, 기법은 F61에서 교체) — 최신이 pass일 때만,
# 동일 tier의 과거 pass 판정과 대조해 어떤 차원의 점수가 baseline에서 이례적으로 드물면 후보.
# baseline N≥5 게이트(표본 부족 시 skip — 분포 무의미). fail 판정은 정당히 낮을 수 있어 제외.
#
# 왜 [min,max]가 아닌가(F61): 점수는 7~9 정수 소척도이고 pass 판정은 정의상 pass_threshold
# 이상이다. 표본이 조금만 쌓이면 [min,max]가 척도 전체로 수렴해 어떤 판정도 이탈로 잡히지
# 않는다 — 실제로 코퍼스를 17건으로 갱신하자 standard pass 범위가 [7,9]가 되어 검사가 무력화됐다.
# 사분위수도 관측값이 3개뿐이라 값 사이를 구분하지 못한다. 반면 출현 빈도는 같은 "7"이어도
# 전례 없는 7(critical functionality, 28건 중 0건)과 일상적인 7(critical test_coverage, 32%)을
# 구분한다. 임계 5%는 실측으로 정했다 — 정당한 판정(6% 이상 출현)은 통과시키고 유일 사례는 잡는다.
RARE_PCT=5
if [[ "$VERDICT" == pass* && "$MIN" != "null" && -f "$GOLDEN" ]] && jq -e '.records' "$GOLDEN" &>/dev/null; then
  TIER=$(jq -r '.security_tier // "unknown"' "$LATEST" 2>/dev/null || echo "unknown")
  DRIFT=$(jq -r --arg tier "$TIER" --arg fk "$FEAT" --argjson rare "$RARE_PCT" --slurpfile latest "$LATEST" '
    ($latest[0].scores) as $ls
    | [.records[] | select((.tier == $tier) and ((.verdict // "") | test("pass"))
        and (((.features // []) | join(",")) != $fk))] as $base
    | if ($base | length) < 5 then empty
      else
        (["functionality","code_quality","security","error_handling","test_coverage"]
         | map(. as $d
             | ($base | map(.scores[$d]) | map(select(type=="number"))) as $vals
             | if ($vals | length) < 5 then empty
               else ($ls[$d]) as $v
                 | if ($v | type) != "number" then empty
                   else ($vals | map(select(. == $v)) | length) as $cnt
                     | (($cnt * 100) / ($vals | length)) as $pct
                     | if $pct < $rare
                       then "\($d):\($v)(baseline \($cnt)/\($vals|length)회)"
                       else empty end
                   end
               end)
         | if length > 0 then join("; ") else empty end)
      end' "$GOLDEN" 2>/dev/null || echo "")
  if [[ -n "$DRIFT" ]]; then
    add "evaluator score distribution drift ($FEAT)" "최신 pass 판정에 동일 tier($TIER) 과거 pass baseline에서 ${RARE_PCT}% 미만으로만 나타나는 점수가 있음: $DRIFT — grade drift 가능성, $LATEST 재검토(golden-set 대조). 후보는 재검토 신호이지 판정이 틀렸다는 뜻이 아니다" "standard"
  fi
fi

echo "$CANDS"
