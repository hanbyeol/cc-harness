#!/usr/bin/env bash
#
# lib.sh — cc-harness 훅 공용 헬퍼
#
# 사용: source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# 여러 훅이 반복하던 관용구(cd 가드, jq config 읽기, 버전 비교)를 한곳에 모은다.
#

# jq 사용 가능 여부
has_jq() { command -v jq &>/dev/null; }

# 프로젝트 루트로 이동 (실패 시 호출자가 exit 0 하도록 비0 반환).
# 사용: harness_cd || exit 0
harness_cd() {
  cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}" 2>/dev/null || return 1
}

# config 값 읽기 — 키가 없거나 파일이 없으면 default 반환.
# jq의 `// default`는 false/null도 default로 덮으므로, 명시적 존재 확인으로 false를 보존한다.
# 사용: cfg_get <file> <jq_path> <default>
cfg_get() {
  local file="$1" path="$2" default="$3"
  [[ -f "$file" ]] || { printf '%s' "$default"; return 0; }
  has_jq || { printf '%s' "$default"; return 0; }
  # 키 존재 여부를 != null 로 확인 — jq -e의 false-는-exit-1 함정을 피해 false 값을 보존한다
  if jq -e "($path) != null" "$file" &>/dev/null; then
    jq -r "$path" "$file" 2>/dev/null
  else
    printf '%s' "$default"
  fi
}

# 시맨틱 버전 비교: a < b 이면 0(true), 아니면 1(false).
# 빈 문자열은 가장 오래된 버전으로 취급(어떤 버전보다 작음). 숫자 비교(1.10 > 1.9).
# 사용: version_lt "$installed" "$target" && echo "needs migration"
version_lt() {
  local a="$1" b="$2"
  [[ "$a" == "$b" ]] && return 1
  [[ -z "$a" ]] && return 0
  [[ -z "$b" ]] && return 1
  local IFS=.
  local -a av bv
  read -ra av <<<"$a"
  read -ra bv <<<"$b"
  local i max=${#av[@]}
  [[ ${#bv[@]} -gt $max ]] && max=${#bv[@]}
  for ((i = 0; i < max; i++)); do
    local ai=${av[i]:-0} bi=${bv[i]:-0}
    # 숫자만 비교 (suffix 등은 0으로)
    ai=${ai//[^0-9]/}; bi=${bi//[^0-9]/}
    ai=${ai:-0}; bi=${bi:-0}
    if ((10#$ai < 10#$bi)); then return 0; fi
    if ((10#$ai > 10#$bi)); then return 1; fi
  done
  return 1
}

# 세션 상태 자동 스냅샷을 progress/session-handoff.json에 기록.
# phase(phase-gate.json) + 미완료/완료 기능(feature_list.json) + 최근 커밋(git log)을
# 모아 jq로 안전하게 JSON을 구성한다. Stop 훅(session-handoff.sh)과 PreCompact 훅
# (pre-compact.sh)이 공유 — 스냅샷 로직 중복 구현을 방지한다.
# PID별 tmp를 써 동시 실행(Stop 훅 병렬) 레이스를 피한다.
# 호출 전 harness_cd로 프로젝트 루트에 있어야 한다. jq 부재 시 no-op(return 0)로 degrade.
# 성공/graceful-skip 시 0, 스냅샷 생성 실패 시 1.
# 사용: harness_write_handoff_snapshot
harness_write_handoff_snapshot() {
  has_jq || return 0

  local tmp="progress/session-handoff.json.tmp.$$"

  local phase="unknown" pending="[]" completed="[]"
  if [[ -f progress/phase-gate.json ]]; then
    phase=$(jq -r '.current_phase // "unknown"' progress/phase-gate.json 2>/dev/null || echo "unknown")
  fi
  if [[ -f progress/feature_list.json ]]; then
    pending=$(jq -c '[.features[] | select(.passes == false) | .id + ": " + .name]' progress/feature_list.json 2>/dev/null || echo "[]")
    completed=$(jq -c '[.features[] | select(.passes == true) | .id + ": " + .name]' progress/feature_list.json 2>/dev/null || echo "[]")
  fi

  # Recent commits this session (last 2 hours)
  local recent_commits="[]" commits_raw
  if commits_raw=$(git log --oneline --since="2 hours ago" 2>/dev/null | head -10); then
    if [[ -n "$commits_raw" ]]; then
      recent_commits=$(echo "$commits_raw" | jq -Rs 'split("\n") | map(select(length > 0))' 2>/dev/null || echo "[]")
    fi
  fi

  local timestamp
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  # Build handoff JSON safely using jq instead of heredoc interpolation, then
  # validate the tmp before publishing (atomic mv). Clean up tmp on any failure.
  if jq -n \
      --arg ts "$timestamp" \
      --arg phase "$phase" \
      --argjson completed "$completed" \
      --argjson pending "$pending" \
      --argjson recent_commits "$recent_commits" \
      '{
        timestamp: $ts,
        phase: $phase,
        completed: $completed,
        pending: $pending,
        recent_commits: $recent_commits,
        in_progress: null,
        blockers: [],
        next_actions: [],
        key_decisions: []
      }' > "$tmp" 2>/dev/null && jq '.' "$tmp" &>/dev/null; then
    mv "$tmp" progress/session-handoff.json
    return 0
  fi
  rm -f "$tmp"
  return 1
}

# progress/session-handoff-draft.json(에이전트 기록분)을 session-handoff.json에
# recursive deep merge한 뒤 draft를 제거한다. draft 소비는 세션 종료(Stop) 시맨틱이므로
# session-handoff.sh 전용이다 — PreCompact는 이 함수를 호출하지 않는다(draft 보존).
# draft 없음/jq 부재 시 no-op. 호출 전 harness_cd로 프로젝트 루트에 있어야 한다.
# 사용: harness_merge_handoff_draft
harness_merge_handoff_draft() {
  [[ -f progress/session-handoff-draft.json ]] || return 0
  has_jq || return 0
  local tmp="progress/session-handoff.json.tmp.$$"
  if jq -s '
    def deep_merge(a; b):
      a as $a | b as $b |
      if ($a | type) == "object" and ($b | type) == "object" then
        ($a | keys) as $ak | ($b | keys) as $bk |
        ([$ak[], $bk[]] | unique) | reduce .[] as $k (
          {};
          if ($a | has($k)) and ($b | has($k)) then
            . + { ($k): deep_merge($a[$k]; $b[$k]) }
          elif ($b | has($k)) then
            . + { ($k): $b[$k] }
          else
            . + { ($k): $a[$k] }
          end
        )
      elif ($b | type) == "null" then $a
      else $b end;
    deep_merge(.[0]; .[1])
  ' progress/session-handoff.json progress/session-handoff-draft.json > "$tmp" 2>/dev/null; then
    mv "$tmp" progress/session-handoff.json
    rm -f progress/session-handoff-draft.json
  else
    rm -f "$tmp"
  fi
}
