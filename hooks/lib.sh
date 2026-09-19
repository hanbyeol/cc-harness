#!/usr/bin/env bash
#
# lib.sh — cc-harness 훅 공용 헬퍼
#
# 사용: source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# 여러 훅이 반복하던 관용구(cd 가드, jq config 읽기, 버전 비교)를 한곳에 모은다.
#

# jq 사용 가능 여부
has_jq() { command -v jq &>/dev/null; }

# ---------------------------------------------------------------------------
# **탐지기 상태 파일 — 단일 출처(F78 SC-7, 2차 독립 판정 2026-09-14).**
#
# 이 넷은 "무엇이 심사를 통과했는가"와 "무엇으로 복구할 것인가"를 결정한다. 쓸 수 있는 상대는
# 심사 통과를 위조할 수 있고, 실제로 판정자가 그렇게 해서 `pass_threshold` 를 1 로 설치했다.
# 목록이 네 곳에 따로 열거돼 있었고 2차 회전이 **그 중 하나(`.guarded-blobs`)만 고쳐서**
# 같은 백도어가 `.guarded-restore` 로 옮겨갔다 — 그래서 목록을 여기 한 곳에 둔다.
# 세 층이 이것을 읽는다: invariant-guard(도구 쓰기 차단)·pre-bash-firewall(Bash 경로 판정)·
# protected-integrity(조회·GC). 원소를 더하면 세 층이 함께 따라와야 한다.
#
#   .guarded-edits    면제 원장(아직 소비되지 않은 티켓)
#   .guarded-restore  복구 대장(소비되며 승격된 복구 목표)
#   .guarded-blobs    내용 저장소(디렉터리 — 그 **안의 모든 파일**이 대상이다)
#   .integrity-baseline 세션 기준선
GUARDED_STATE_NAMES=(.guarded-edits .guarded-restore .guarded-blobs .integrity-baseline)

# **심사 통과분(blob)으로 되살려도 되는 파일 — 화이트리스트(F78 5차 회전, ADR-009).**
# 복구 목표 저장소는 셸을 쥔 상대가 위조할 수 있다(명령 문자열로 그 입구를 막는 일은 결정
# 불가다 — F63·INV-14, 1~4차 판정이 매번 다음 표기를 찾았다). 그래서 protected-integrity 는
# blob 을 설치하기 직전에 invariant-guard 로 **재심사**한다(SC-11). 그런데 재심사가 의미를
# 갖는 것은 invariant-guard 가 그 파일의 **보안 의미를 온전히** 검사할 때뿐이다:
#   - 들어가는 것: 임계값(INV-3)·passes 근거(INV-11)·계약 승인 전이(INV-11/12)·append-only
#     기록(INV-12). 규칙이 곧 그 파일의 보안 의미다.
#   - 들어가지 않는 것: 코드(`hooks/*.sh`·`tests/*.bats`)와 산문(`docs/INVARIANTS.md`·
#     `skills/*`·`agents/*`). 규칙이 개수 비교뿐이거나 없어서, 개수를 유지한 채 내용을 비튼
#     위조를 가려내지 못한다 — 4차 판정은 `hooks/lib.sh` 에 `has_jq(){ return 1; }` 를 설치했고,
#     같은 내용은 정상 Write 로도 통과한다(rc=0).
# **목록 밖은 HEAD 로 돌아간다(fail-closed).** 빠뜨린 파일의 대가는 편의 손실이지 보안 구멍이
# 아니다 — 그래서 열거가 허용되는 방향이다. 심사 통과분은 사라지지 않고 blob 저장소에 남으며
# 복구 보고가 그 위치를 알려 준다. 목록 자체는 테스트가 핀한다.
BLOB_RESTORABLE_GLOBS=(
  'progress/harness-config.json'
  'templates/progress/harness-config.json'
  'progress/feature_list.json'
  'progress/contracts/sprint-*.json'
  'progress/approval-queue.json'
)
is_blob_restorable() {  # $1 저장소 상대 경로
  local g
  for g in "${BLOB_RESTORABLE_GLOBS[@]}"; do
    # shellcheck disable=SC2053
    [[ "$1" == $g ]] && return 0
  done
  return 1
}

# 경로가 탐지기 상태 파일(또는 그 안의 파일)인가 — **철자가 아니라 성분으로** 본다.
# 파일 존재 여부와 무관하다: blob 이름은 내용 해시라 심는 행위가 언제나 신규 파일 생성이고,
# 존재 여부로 갈랐던 것이 2차 판정이 뚫은 구멍이다.
is_guarded_state_path() {  # $1 경로(절대·상대 무관)
  local p="$1" n
  for n in "${GUARDED_STATE_NAMES[@]}"; do
    case "$p" in
      "$n"|*/"$n") return 0 ;;          # 파일 자신
      "$n"/*|*/"$n"/*) return 0 ;;      # 디렉터리 안(.guarded-blobs/<sha>)
    esac
  done
  return 1
}

# 실체 경로로 같은 판정을 한다 — 심볼릭 링크 별칭(`ln -s .guarded-blobs progress/blobs`)과
# `..` 경유를 흡수한다. 대상이 **파일**일 수도 있으므로 부모만 풀지 않는다(2차 판정: 부모만
# 풀던 구현은 원장 두 개에 원리적으로 매치하지 못해 그 분기가 죽은 코드였다).
# 경로 구성요소 중 심볼릭 링크가 있는가 — **포크 없이** 판정한다(`[[ -L ]]` 는 셸 내장).
# 실체화는 비싸다(서브셸 + `cd` + `pwd -P`). 그 비용을 심볼릭 링크가 실제로 낀 경로에만 쓰기
# 위한 사전 검사다 — 이 하네스에는 경로 토큰 800개짜리 평범한 명령이 예산(1.5초) 안에 끝나야
# 한다는 제약이 이미 있고, 토큰마다 서브셸을 띄우면 그 제약이 깨진다.
__path_has_symlink_component() {  # $1 경로
  local p="$1" n=0
  [[ -L "$p" ]] && return 0
  while [[ "$p" == */* ]]; do
    p="${p%/*}"
    [[ -z "$p" ]] && break
    n=$((n + 1)); [[ $n -gt 40 ]] && return 1
    [[ -L "$p" ]] && return 0
  done
  return 1
}

# 심볼릭 링크 체인을 한 단계씩 따라가 실체 경로를 낸다. `readlink -f` 는 macOS 기본 환경에
# 없으므로 `readlink` 한 단계 + `pwd -P` 를 상한 둔 루프로 푼다(invariant-guard 의 canon_file
# 과 같은 규약). **대상이 파일이어도 따라간다** — 3차 독립 판정이 실측한 결함이 정확히 그것이다:
# 부모만 풀고 대상 자신은 디렉터리일 때만 풀어서, 대상이 파일인 두 원장에는 원리적으로 닿지
# 않았고 파일 심볼릭 링크 별칭 8형이 전부 allow 였다. 링크가 매달려 있어도(대상 파일이 아직
# 없어도) 읽는다 — 아직 없는 대장을 심는 것이 곧 위조이므로 그때가 가장 중요한 순간이다.
__resolve_symlink_path() {  # $1 경로 → 실체 경로(stdout)
  local p="$1" n=0 t parent base
  while [[ -L "$p" && $n -lt 20 ]]; do
    t=$(readlink "$p" 2>/dev/null) || break
    [[ -z "$t" ]] && break
    case "$t" in
      /*) p="$t" ;;
      *)  case "$p" in */*) p="${p%/*}/$t" ;; *) p="$t" ;; esac ;;
    esac
    n=$((n + 1))
  done
  case "$p" in */*) parent="${p%/*}"; base="${p##*/}" ;; *) parent="."; base="$p" ;; esac
  if [[ -d "$parent" ]]; then
    parent=$( cd "$parent" 2>/dev/null && pwd -P 2>/dev/null ) || parent=""
  else
    parent=""
  fi
  if [[ -n "$parent" ]]; then printf '%s/%s' "$parent" "$base"; else printf '%s' "$p"; fi
}

is_guarded_state_physical() {  # $1 경로
  local p="$1" parent base phys
  # (1) 철자 판정 — 포크가 없다. 토큰이 아무리 많아도 비용이 들지 않는다.
  is_guarded_state_path "$p" && return 0
  # (2) 실체 판정 — 심볼릭 링크나 `..` 가 실제로 낀 경로에만 쓴다. 그 둘이 없으면 실체화해도
  #     철자와 같은 결론이 나오므로 포크를 쓸 이유가 없다.
  __path_has_symlink_component "$p" || [[ "$p" == *..* ]] || return 1
  phys=$(__resolve_symlink_path "$p")
  is_guarded_state_path "$phys" && return 0
  case "$p" in */*) parent="${p%/*}"; base="${p##*/}" ;; *) parent="."; base="$p" ;; esac
  if [[ -d "$parent" ]]; then
    phys=$( cd "$parent" 2>/dev/null && pwd -P 2>/dev/null ) || return 1
    is_guarded_state_path "$phys/$base" && return 0
  fi
  if [[ -d "$p" ]]; then
    phys=$( cd "$p" 2>/dev/null && pwd -P 2>/dev/null ) || return 1
    is_guarded_state_path "$phys" && return 0
  fi
  return 1
}

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

  # 기존 핸드오프의 에이전트 기록분을 캐리오버하기 위해 읽어둔다(F56).
  # 이 스냅샷은 아래에서 JSON을 새로 만들어 파일을 통째로 덮어쓰므로, 보존하지 않으면
  # draft 병합으로 들어온 필드가 draft 없는 다음 Stop에서 전부 사라진다 —
  # follow_ups_backlog는 스냅샷이 만들지도 않아 키째 유실되고, blockers/key_decisions/
  # next_actions/in_progress는 아래의 빈 초기값으로 덮어써진다.
  local prev='{}'
  if [[ -f progress/session-handoff.json ]]; then
    prev=$(jq -c '.' progress/session-handoff.json 2>/dev/null || echo '{}')
    [[ -n "$prev" ]] || prev='{}'
  fi

  # Build handoff JSON safely using jq instead of heredoc interpolation, then
  # validate the tmp before publishing (atomic mv). Clean up tmp on any failure.
  if jq -n \
      --arg ts "$timestamp" \
      --arg phase "$phase" \
      --argjson completed "$completed" \
      --argjson pending "$pending" \
      --argjson recent_commits "$recent_commits" \
      --argjson prev "$prev" \
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
      }
      # 자동 필드(timestamp·phase·completed·pending·recent_commits)는 항상 새 값이 이기고,
      # 에이전트 기록 필드는 기존 값이 비어있지 않을 때만 보존한다.
      + ( ["in_progress", "blockers", "next_actions", "key_decisions", "follow_ups_backlog"]
          | reduce .[] as $k ({};
              ($prev[$k]) as $v
              | if ($v == null or $v == "" or $v == [] or $v == {})
                  then .
                  else . + { ($k): $v } end) )
      ' > "$tmp" 2>/dev/null && jq '.' "$tmp" &>/dev/null; then
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
