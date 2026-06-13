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
