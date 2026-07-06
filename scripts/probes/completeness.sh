#!/usr/bin/env bash
#
# completeness.sh — 완전성 critic 프로브 (F13)
# "무엇이 빠졌나": 테스트 없는 이벤트 훅, TRIGGER 없는 skill, 참조되나 없는 파일.
# 각 갭을 개선 후보로 출력.
#
set -euo pipefail
command -v jq &>/dev/null || { echo "[]"; exit 0; }

CANDS="[]"
add() { CANDS=$(jq -c --arg n "$1" --arg d "$2" --arg t "${3:-low}" \
  '. + [{name:$n, description:$d, security_tier:$t, source:"completeness"}]' <<<"$CANDS"); }

# 1. 이벤트 훅(lib/setup 제외) 중 대응 테스트 없는 것
if [[ -d hooks ]]; then
  for h in hooks/*.sh; do
    [[ -f "$h" ]] || continue
    b=$(basename "$h" .sh)
    [[ "$b" == "lib" || "$b" == "setup-claudemd" ]] && continue
    if ! find tests -name "*${b}*" -type f 2>/dev/null | grep -q .; then
      add "hook '$b' has no test" "이벤트 훅 hooks/${b}.sh 에 대응하는 tests/ 파일이 없음 — 회귀 위험" "standard"
    fi
  done
fi

# 2. TRIGGER 없는 skill (자동 라우팅 불가)
if [[ -d skills ]]; then
  for d in skills/*/; do
    [[ -f "$d/SKILL.md" ]] || continue
    s=$(basename "$d")
    grep -q 'TRIGGER' "$d/SKILL.md" 2>/dev/null || add "skill '$s' missing TRIGGER" "skills/$s/SKILL.md description에 TRIGGER 문구 없음 — 자동 라우팅 누락" "low"
  done
fi

# 3. INVARIANTS.md / ADR이 참조하는 hooks 파일이 실제 존재하는지
if [[ -f docs/INVARIANTS.md ]]; then
  while IFS= read -r ref; do
    [[ -f "$ref" ]] || add "referenced file missing: $ref" "docs/INVARIANTS.md가 $ref 를 참조하나 파일이 없음" "standard"
  done < <(grep -oE 'hooks/[a-zA-Z0-9_-]+\.sh' docs/INVARIANTS.md 2>/dev/null | sort -u)
fi

# 4. runtime 상태 파일 부재 (F36) — SDLC 하네스 프로젝트(progress/feature_list.json 존재)인데
#    동반 runtime 파일이 없으면 INV-3 임계값 가드·firewall 토글·evaluator 보정이 비활성이 된다.
#    feature_list.json이 있을 때만 검사한다(플러그인만 얹은 무관 프로젝트 오탐 방지).
if [[ -f progress/feature_list.json ]]; then
  for rf in progress/harness-config.json progress/phase-gate.json evals/acceptance-criteria.json; do
    [[ -f "$rf" ]] || add "runtime state missing: $rf" "SDLC 하네스 프로젝트인데 $rf 가 없음 — INV-3 임계값 가드/firewall 토글/evaluator 보정이 비활성. 부트스트래퍼(init.sh)나 템플릿에서 실체화 필요" "standard"
  done
fi

# 5. evaluator 후속 작업 자동 편입 (F43) — 정적 프로브가 못 보는 '판정 기록의 미해결 후속'을
#    진단에 올린다. 최신(비archive) evaluator-feedback 1건의 criteria_gaps.action_required에서
#    상투구(none/없음 등)를 제거한 뒤 실질 후속이 남으면 후보로. 최신 1건만(evidence/calibration 패턴).
COMMS="progress/agent-comms"
if [[ -d "$COMMS" ]]; then
  LATEST_FB=$(ls -1 "$COMMS"/evaluator-feedback-*.json 2>/dev/null | sort -r | head -1 || true)
  if [[ -n "$LATEST_FB" && -f "$LATEST_FB" ]] && jq -e '.' "$LATEST_FB" &>/dev/null; then
    AR=$(jq -r '.criteria_gaps.action_required // ""' "$LATEST_FB" 2>/dev/null || echo "")
    # 상투구 제거 후 실질 후속(alnum·한글)이 남으면 후보. 'none for pass'·'없음'류는 skip.
    # 단어 경계 기반(F44): 비 alnum·한글을 구분자로 단어 분리 후, 상투구 단어와 '정확히
    # 일치'하는 것만 제거한다 — sed 부분매칭('password'의 'pass')이 아니라 단어 단위 정밀 매칭.
    STRIPPED=$(printf '%s' "$AR" | tr '[:upper:]' '[:lower:]' \
      | tr -c '[:alnum:]가-힣' '\n' \
      | grep -vxE 'none|없음|n|a|blocking|for|pass' \
      | tr -d '[:space:]' || true)
    if [[ -n "$AR" && -n "$STRIPPED" ]]; then
      add "evaluator follow-up: $(basename "$LATEST_FB")" "최신 판정이 남긴 미해결 후속(action_required): $AR — 백로그로 편입해 다음 회전에서 처리" "low"
    fi
  fi
fi

echo "$CANDS"
