#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)
if ! command -v jq &>/dev/null; then
  # jq 없이는 명령을 파싱할 수 없다 — 조용한 fail-open 대신 경고를 남긴다
  echo "cc-harness firewall: jq not found — firewall inactive" >&2
  exit 0
fi
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")
[[ -z "$CMD" ]] && exit 0

# Normalize all whitespace (tabs, newlines, multiple spaces) to single space
NORMALIZED_CMD=$(echo "$CMD" | tr -s '[:space:]' ' ' | sed 's/^ //;s/ $//')

deny() {
  echo "BLOCKED: $1" >&2
  echo "  Pattern: $2" >&2
  echo "  Command: ${CMD:0:120}" >&2
  exit 2
}

# 패턴 배열을 단일 alternation으로 결합 — 비매치(대부분의 명령)는 tier당 grep 1회로 끝난다
join_patterns() {
  local out=""
  for p in "$@"; do out+="(${p})|"; done
  echo "${out%|}"
}

# === Layer 1: Destructive command blocklist (anchored patterns) ===
# 의도: 복구 불가능한 파괴만 차단. 사용자 영역 하위 경로 삭제(rm -rf /tmp/build 등)는 허용.
# 시스템 최상위 디렉토리는 통째 삭제만 차단 — 그 내부 개별 파일 삭제는 비root 권한으로
# 대부분 실패하고, sudo rm은 Layer 2가 차단한다.
# shellcheck disable=SC2016  # 패턴은 regex 리터럴 — 변수 확장 의도 아님
BLOCKED=(
  # rm targeting root / root-variants / home / $HOME / top-level system dirs (as a whole argument)
  '\brm [^;|&]*( /+| /\*| /\.| ~| ~/| ~/\*| \$HOME/?| "\$HOME"/?| \$\{HOME\}/?| /(etc|usr|bin|sbin|lib|lib64|boot|dev|sys|proc|opt|srv|home|root|tmp|var|System|Library|Applications)/?)( |$|[;&|])'
  # git push --force (단, --force-with-lease는 허용)
  'git push[^;|&]*--force([^-]|$)'
  'kubectl delete namespace'
  'kubectl delete -A'
  'kubectl delete[^;|&]*--all-namespaces'
  '\bDROP TABLE\b'
  '\bDROP DATABASE\b'
  '\bTRUNCATE TABLE\b'
  '> */dev/sd'
  '\bmkfs(\.|\b)'
  ':\(\) *\{ *:\|:& *\} *;:'
  'chmod [^;|&]*777 /( |$|[;&|])'
  'chmod [^;|&]*777 /(etc|usr|var|bin|sbin|lib)'
)

if echo "$NORMALIZED_CMD" | grep -qiE "$(join_patterns "${BLOCKED[@]}")"; then
  for p in "${BLOCKED[@]}"; do
    echo "$NORMALIZED_CMD" | grep -qiE "$p" && deny "위험 명령어 감지" "$p"
  done
fi

# === Layer 2: Shell metacharacter / indirection detection ===
# Layer 1 우회 시도 차단. 일반적인 셸 기능(백틱, kubectl exec 등)은 위험 명령을
# 포함할 때만 차단한다. pipe-to-shell은 중간 파이프(base64 -d 등)를 끼워도 잡는다.
# shellcheck disable=SC2016  # 패턴은 regex 리터럴 — 변수 확장 의도 아님
INDIRECT_PATTERNS=(
  '^eval\b'                          # eval "rm -rf /" (command-initial)
  '[;&|] *eval\b'                    # ...; eval / && eval / || eval / | eval
  '^exec '                           # exec rm ... (command-initial only — kubectl exec는 허용)
  '[;&|] *exec '                     # ...; exec rm ...
  '\$\([^)]*\b(rm|chmod|chown|mkfs|eval)\b'      # $(... rm ...) — command substitution with dangerous cmd
  '\$\([^)]*\bkubectl +delete'
  '`[^`]*\b(rm|chmod|chown|mkfs|eval)\b[^`]*`'   # backtick containing dangerous cmd only
  '`[^`]*kubectl +delete[^`]*`'
  '\b(curl|wget)\b[^;&]*\| *(ba|z)?sh\b'         # pipe-to-shell (중간 파이프 경유 포함)
  '\b(curl|wget)\b[^;&]*\| *source\b'
  '\bdd\b[^;|&]*\bof=/dev/'          # dd writing to a device (reading from /dev is fine)
  '\bsudo +rm\b'
  '\bsudo +chmod\b'
  '\bsudo +chown\b'
  ': *> */(etc|var|usr|boot)/'       # truncate system files
)

if echo "$NORMALIZED_CMD" | grep -qiE "$(join_patterns "${INDIRECT_PATTERNS[@]}")"; then
  for p in "${INDIRECT_PATTERNS[@]}"; do
    echo "$NORMALIZED_CMD" | grep -qiE "$p" && deny "간접 실행 패턴 감지" "$p"
  done
fi

# === Layer 3: Ask tier — 파괴적이지만 정상 워크플로우에서 쓰일 수 있는 명령 ===
# deny 대신 사용자 확인(permissionDecision: ask)으로 강등.
ASK_PATTERNS=(
  'git reset[^;|&]*--hard'
  'git clean[^;|&]* -[a-zA-Z]*f'
  'git checkout[^;|&]* --force'
  # IaC (iac 프로파일) — 복구 불가·리뷰 우회·state 수술. 환경(prod) 강제는 /plan-review·Plan 게이트가 담당.
  'terraform[^;|&]* destroy'
  'terraform[^;|&]* apply[^;|&]* -auto-approve'
  'terraform[^;|&]* state +(rm|push)'
  'terraform[^;|&]* import'
  'terraform[^;|&]* taint'
  # k8s 운영 (ops 프로파일) — 라이브 파괴/중단. namespace/-A 통째 삭제는 위 BLOCKED가 선처리(deny).
  # 환경(prod) 강제는 /rollout·Plan 게이트가 담당.
  'kubectl[^;|&]* delete '
  'kubectl[^;|&]* scale[^;|&]*--replicas[= ]?0'
  'helm[^;|&]* (uninstall|delete)'
  'kubectl[^;|&]* rollout undo'
  'kubectl[^;|&]* drain'
  # 하네스 검증 파일 훼손 (invariant-guard는 Edit|Write만 후킹 → Bash cp/mv/sed -i/리다이렉트 우회 차단)
  '>>? *[^ ]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.sh|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md)'
  '\b(cp|mv|install|rsync|ln|tee|truncate)\b[^;|&]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.sh|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md)'
  '\b(sed|perl)\b[^;|&]*-i[^;|&]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.sh|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md)'
  '\bof= *[^ ]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.sh|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md)'
  # 민감 파일(비밀키·크리덴셜) 이동/복사/덮어쓰기
  '\b(cp|mv|rsync|install|tee|scp)\b[^;|&]*(\.ssh/|\.aws/|\.gnupg/)'
  '>>? *[^ ]*(\.ssh/|\.aws/|\.gnupg/)'
  # git 실행 훅 경로 변경 — 이후 임의 git 명령이 임의 스크립트 실행(에스컬레이션)
  'git config[^;|&]*core\.hooksPath'
)

if echo "$NORMALIZED_CMD" | grep -qiE "$(join_patterns "${ASK_PATTERNS[@]}")"; then
  for p in "${ASK_PATTERNS[@]}"; do
    if echo "$NORMALIZED_CMD" | grep -qiE "$p"; then
      jq -n --arg reason "uncommitted 변경을 잃을 수 있는 명령입니다 (pattern: $p). 실행 전 확인이 필요합니다." \
        '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: $reason}}'
      exit 0
    fi
  done
fi

# === Layer 4: Allow tier — 기본 허용(default-allow) ===
# 여기 도달 = deny(L1/2)·ask(L3)를 모두 통과. 모델: "위험 명령 제외하고는 다 통과".
# 파괴·비가역·권한상승·하네스 검증파일 훼손·비밀키 이동은 위 Layer가 이미 deny/ask로 걸렀고,
# 그 외 모든 일반 개발 명령은 여기서 permissionDecision:"allow"를 방출한다(무프롬프트).
# deny/ask 뒤에 위치하므로(INV-9) 위험 명령이 allow로 새지 않는다.

# config 토글 (기본 on). off면 allow를 방출하지 않고 Claude Code 기본 프롬프트로 넘어간다.
# deny/ask는 이 값과 무관하게 위에서 항상 실행됐다.
AUTO_ALLOW="true"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
HARNESS_CFG="$PROJECT_DIR/progress/harness-config.json"
if [[ -f "$HARNESS_CFG" ]] && jq -e '.firewall.auto_allow == false' "$HARNESS_CFG" &>/dev/null; then
  AUTO_ALLOW="false"
fi
[[ "$AUTO_ALLOW" == "true" ]] || exit 0

# deny(L1/2)·ask(L3)를 통과한 명령은 위험 정의에 해당하지 않으므로 자동 허용한다.
# command substitution/리다이렉트 안의 위험 명령은 Layer 2가, 시스템 파일 truncate는
# Layer 1/2가, 하네스 검증파일·비밀키 쓰기는 Layer 3(ask)이 이미 선처리했다.
jq -n --arg reason "위험 명령(deny/ask)에 해당하지 않는 명령 — cc-harness firewall이 자동 허용했습니다." \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: $reason}}'
exit 0

exit 0
