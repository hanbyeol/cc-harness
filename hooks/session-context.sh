#!/usr/bin/env bash
set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}" 2>/dev/null || exit 0

# Ensure required directories exist
mkdir -p progress/agent-comms progress/contracts 2>/dev/null || true

BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
LAST=$(git log --oneline -1 2>/dev/null || echo "none")
PHASE="init"
PENDING="?"
TOTAL="?"
PASSED="0"
ITERATION="0"

if command -v jq &>/dev/null; then
  if [[ -f progress/phase-gate.json ]]; then
    PHASE=$(jq -r '.current_phase // "unknown"' progress/phase-gate.json 2>/dev/null || echo "init")
    ITERATION=$(jq -r '.phases[.current_phase].current_iteration // 0' progress/phase-gate.json 2>/dev/null || echo "0")
  fi
  if [[ -f progress/feature_list.json ]]; then
    PENDING=$(jq '[.features[] | select(.passes == false)] | length' progress/feature_list.json 2>/dev/null || echo "?")
    TOTAL=$(jq '[.features[]] | length' progress/feature_list.json 2>/dev/null || echo "?")
    PASSED=$(jq '[.features[] | select(.passes == true)] | length' progress/feature_list.json 2>/dev/null || echo "0")
  fi
fi

cat <<CTX
=== Session Context ===
Branch: $BRANCH | Phase: $PHASE (iteration $ITERATION) | Features: $PASSED/$TOTAL passed
Last: $LAST
CTX

# Session handoff from previous session
if [[ -f progress/session-handoff.json ]]; then
  echo ""
  echo "=== Previous Session Handoff ==="
  jq -r '
    "Completed: " + ([.completed[]?] | join(", ")),
    "In Progress: " + (.in_progress // "none"),
    "Blockers: " + ([.blockers[]?] | join(", ")),
    "Next Actions: " + ([.next_actions[]?] | join(", ")),
    "Key Decisions: " + ([.key_decisions[]?] | join(", "))
  ' progress/session-handoff.json 2>/dev/null || true
fi

# Latest evaluator feedback
LATEST_FEEDBACK=""
if [[ -d progress/agent-comms ]]; then
  LATEST_FEEDBACK=$(find progress/agent-comms -maxdepth 1 -name "evaluator-feedback-*.json" -print 2>/dev/null | sort -r | head -1 || true)
fi
if [[ -n "$LATEST_FEEDBACK" ]]; then
  echo ""
  echo "=== Latest Evaluator Feedback ==="
  jq -r '"Score: \(.score)/10", "Verdict: \(.verdict)", "Issues: " + ([.issues[]?] | join("; "))' "$LATEST_FEEDBACK" 2>/dev/null || true
fi

# Phase-based next action suggestion
echo ""
echo "=== Suggested Next Action ==="
case "$PHASE" in
  init|unknown)
    echo "Phase 1 시작: spec-writer agent로 SPEC.md 작성"
    echo "  → \"SPEC.md를 작성해줘. 상세 인터뷰부터 시작해.\""
    ;;
  specification)
    echo "Phase 1 진행 중: spec-writer agent로 스펙 완성"
    echo "  → 스펙 완료 시 architect agent로 Phase 2 진입"
    ;;
  architecture)
    echo "Phase 2 진행 중: architect agent로 아키텍처 설계"
    echo "  → 설계 완료 시 /implement로 Phase 3 시작"
    ;;
  implementation)
    if [[ -n "$LATEST_FEEDBACK" ]]; then
      VERDICT=$(jq -r '.verdict // "unknown"' "$LATEST_FEEDBACK" 2>/dev/null || echo "unknown")
      if [[ "$VERDICT" == "fail" ]]; then
        FAIL_FEATURES=$(jq -r '[.features_evaluated[]?] | join(", ")' "$LATEST_FEEDBACK" 2>/dev/null || echo "?")
        echo "Evaluator 반려됨 ($FAIL_FEATURES) — 피드백 반영 후 재구현 필요"
        echo "  → /implement --retry"
      else
        echo "다음 미완료 기능 구현: /implement"
      fi
    else
      echo "구현 시작: /implement"
    fi
    if [[ "$PENDING" != "?" ]] && [[ "$PENDING" -gt 0 ]]; then
      echo "  → 미완료 기능: ${PENDING}개"
    fi
    ;;
  verification)
    echo "Phase 4: 검증 에이전트 실행"
    echo "  → evaluator agent로 기능 검증"
    echo "  → security-auditor agent로 보안 감사"
    echo "  → qa-reviewer agent로 통합 QA"
    ;;
  deployment)
    echo "Phase 5: deploy-operator agent로 배포"
    ;;
  observability)
    echo "Phase 6: 메트릭, 로깅, 알럿 설정"
    echo "  → metrics instrumentation + structured logging + alerts 구성"
    ;;
  *)
    echo "⚠ 알 수 없는 phase: $PHASE"
    echo "/progress로 현재 상태를 확인하세요."
    ;;
esac

echo ""
echo "→ /progress 로 전체 현황 확인 | CLAUDE.md의 '요청 → 행동 라우팅' 참조"
