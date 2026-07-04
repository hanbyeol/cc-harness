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

# === Layer 4: Allow tier — 읽기 전용/저위험 명령 자동 허용 (무프롬프트) ===
# 여기 도달 = deny(L1/2)·ask(L3)를 모두 통과. allowlist에 "명시적으로" 매칭될 때만
# permissionDecision:"allow" 를 방출한다. 조금이라도 불확실하면 fall-through(exit 0) →
# Claude Code 기본 권한 흐름(사용자 프롬프트) 유지. 위험 명령은 절대 여기서 allow되지 않는다.

# config 토글 (기본 on). deny/ask는 위에서 이미 실행됐으므로 여기서 꺼도 가드는 그대로다.
AUTO_ALLOW="true"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
HARNESS_CFG="$PROJECT_DIR/progress/harness-config.json"
if [[ -f "$HARNESS_CFG" ]] && jq -e '.firewall.auto_allow == false' "$HARNESS_CFG" &>/dev/null; then
  AUTO_ALLOW="false"
fi
[[ "$AUTO_ALLOW" == "true" ]] || exit 0

# command substitution/백틱/process substitution 은 내용이 allowlist로 검증되지 않으므로
# 자동 허용하지 않는다(예: git commit -m "$(...)", `code`).
if echo "$NORMALIZED_CMD" | grep -qE '\$\(|`|<\(|>\('; then
  exit 0
fi

# 안전한 폐기 리다이렉트(2>/dev/null, 2>&1, >&2, &>/dev/null)만 제거한 뒤,
# 파일로 향하는 리다이렉트(>, >>)가 남아 있으면 자동 허용하지 않는다(임의 경로 쓰기 방지).
STRIPPED=$(echo "$NORMALIZED_CMD" | sed -E 's#[0-9]?>>?[ ]?/dev/null##g; s#[0-9]?>&[0-9]##g; s#&>[ ]?/dev/null##g')
if echo "$STRIPPED" | grep -qE '>'; then
  exit 0
fi

# 하네스 검증 파일·민감 파일을 겨냥한 쓰기는 auto-allow에서 제외한다.
# invariant-guard는 Edit|Write|MultiEdit만 후킹하므로, Bash 경유(cp/mv/sed -i/tar)
# 덮어쓰기로 임계값·가드·테스트를 무프롬프트 훼손하는 경로를 여기서 막는다.
PROTECTED_RE='harness-config\.json|hooks/[A-Za-z0-9_.-]+\.sh|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md|\.(ssh|aws|gnupg)(/|$| )|(^| )/etc/|\.git/'

# 파이프라인/체인을 세그먼트로 분리 — 모든 세그먼트가 allowlist에 있어야 허용.
ALL_SAFE=1
SEGMENTS=$(echo "$STRIPPED" | tr ';|&' '\n\n\n')
while IFS= read -r seg; do
  # 앞뒤 공백 + 선행 환경변수 할당(FOO=bar) 제거
  seg=$(echo "$seg" | sed -E 's/^ +//; s/ +$//; s/^([A-Za-z_][A-Za-z0-9_]*=[^ ]* +)+//')
  [[ -z "$seg" ]] && continue
  cmd=${seg%% *}
  # 경로 지정 명령(./x, /usr/bin/x)은 자동 허용 대상에서 제외 — 동명 바이너리 치환 방지
  if [[ "$cmd" == */* ]]; then ALL_SAFE=0; break; fi
  # 서브커맨드(두 번째 토큰) — 서브커맨드 인지 검사에 재사용
  sub=$(echo "$seg" | awk '{print $2}')
  case "$cmd" in
    # 순수 읽기 전용/조회 — 인자와 무관하게 안전
    ls|cat|head|tail|wc|grep|egrep|fgrep|rg|ag|tree|file|stat|du|df|pwd|echo|printf|cut|sort|uniq|nl|column|fold|comm|paste|diff|cmp|jq|yq|date|cal|env|printenv|whoami|id|hostname|uname|uptime|which|type|basename|dirname|realpath|readlink|xxd|od|hexdump|strings|cksum|md5|md5sum|sha1sum|shasum|sha256sum|seq|true|false|test|bats|gofmt|tr|less|more|tac|rev|expand|unexpand|look|tabs|nproc|arch|getconf|locale|tty|groups|sw_vers|ps|free|vmstat|iostat|lsof|netstat|ss|ping|ping6|dig|nslookup|host|whois)
      ;;
    # 파일 쓰기 가능 — 하네스 검증 파일·민감 경로를 겨냥하면 제외(프롬프트)
    mkdir|touch|cp|mv|tar|ln|install|rsync|split)
      if echo "$seg" | grep -qE "$PROTECTED_RE"; then ALL_SAFE=0; fi
      ;;
    # 텍스트 처리 — awk system() 코드실행, sed s///e 실행 플래그, 보호 경로 in-place 편집 시 제외
    awk|sed)
      if echo "$seg" | grep -qE 'system\(|s/[^/]*/[^/]*/[a-z]*e'; then ALL_SAFE=0
      elif echo "$seg" | grep -qE "$PROTECTED_RE"; then ALL_SAFE=0; fi
      ;;
    # 탐색 find — 파괴/명령실행 액션 플래그가 있으면 제외(순수 탐색만 허용)
    find)
      if echo "$seg" | grep -qE ' -(delete|exec|execdir|ok|okdir|fprint|fprintf|fprint0|fls)( |$)'; then ALL_SAFE=0; fi
      ;;
    # 네트워크 조회 — 변형(POST/PUT/DELETE/PATCH)·데이터 전송 플래그가 있으면 제외
    curl|wget)
      if echo "$seg" | grep -qiE ' -X[= ]*(POST|PUT|DELETE|PATCH)| --request[= ]*(POST|PUT|DELETE|PATCH)| -(d|F|T)( |$)| --(data|data-binary|data-raw|form|upload-file)( |=)'; then ALL_SAFE=0; fi
      ;;
    go)
      case "$sub" in
        build|test|vet|run|mod|list|doc|version|env|fmt|tool|work) ;;
        *) ALL_SAFE=0 ;;
      esac
      ;;
    # 프로젝트 빌드/테스트 러너 — 개발 이너루프
    make|gmake|mvn|gradle)
      ;;
    cargo)
      case "$sub" in
        build|b|test|t|check|c|clippy|fmt|doc|d|tree|metadata|version|--version|bench|nextest) ;;
        *) ALL_SAFE=0 ;;
      esac
      ;;
    npm|pnpm|yarn)
      # exec 제외(임의 패키지 코드 실행), install 미포함(postinstall 위험)
      case "$sub" in
        test|run|ls|list|view|audit|why|outdated) ;;
        *) ALL_SAFE=0 ;;
      esac
      ;;
    pip|pip3)
      case "$sub" in
        list|show|freeze|check|config|--version|-V) ;;
        *) ALL_SAFE=0 ;;
      esac
      ;;
    # 컨테이너/오케스트레이션 — 읽기 전용 조회 서브커맨드만 (변형은 fall-through, 파괴는 L3 ask)
    docker|podman)
      case "$sub" in
        ps|logs|images|image|inspect|version|info|top|stats|port|history|diff|events|context|system) ;;
        *) ALL_SAFE=0 ;;
      esac
      ;;
    kubectl|k)
      case "$sub" in
        get|describe|logs|top|explain|api-resources|api-versions|version|cluster-info|events|wait) ;;
        *) ALL_SAFE=0 ;;
      esac
      ;;
    helm)
      case "$sub" in
        list|ls|status|get|history|version|show|search|template|env|repo) ;;
        *) ALL_SAFE=0 ;;
      esac
      ;;
    brew)
      case "$sub" in
        list|info|search|outdated|deps|home|config|leaves|uses|desc|--version|tap-info) ;;
        *) ALL_SAFE=0 ;;
      esac
      ;;
    git)
      # push·reset·clean·rebase·merge·checkout·restore 등 상태 위험 서브커맨드는 제외(fall-through).
      case "$sub" in
        status|log|diff|show|rev-parse|rev-list|remote|blame|describe|ls-files|ls-tree|show-ref|reflog|cat-file|grep|shortlog|for-each-ref|symbolic-ref|var|count-objects|verify-commit|whatchanged|fetch|add|commit|mv)
          ;;
        config)
          # 읽기 형태(--get/--list/-l 등)만 허용 — 쓰기(git config k v, --add/--unset)는 제외
          if echo "$seg" | grep -qE ' --(get|get-all|get-regexp|list|get-urlmatch)( |$)| -l( |$)'; then :; else ALL_SAFE=0; fi
          ;;
        stash)
          # drop/clear는 비가역 파기 — 제외. push/list/show/save/apply/pop만 허용
          if echo "$seg" | grep -qE ' (drop|clear)( |$)'; then ALL_SAFE=0; fi
          ;;
        switch)
          # 변경 폐기(--discard-changes/-f/-C) 플래그가 있으면 제외
          if echo "$seg" | grep -qE ' -(f|C)( |$)| --(discard-changes|force)( |$)'; then ALL_SAFE=0; fi
          ;;
        branch|tag)
          # 목록/생성만 허용 — 삭제·이동·강제 플래그가 있으면 제외
          if echo "$seg" | grep -qE ' -(d|D|m|M|f)( |$)| --(delete|move|force)( |$)'; then ALL_SAFE=0; fi
          ;;
        *) ALL_SAFE=0 ;;
      esac
      ;;
    *) ALL_SAFE=0 ;;
  esac
  [[ $ALL_SAFE -eq 0 ]] && break
done <<< "$SEGMENTS"

if [[ $ALL_SAFE -eq 1 ]]; then
  jq -n --arg reason "읽기 전용/저위험 명령 — cc-harness firewall이 자동 허용했습니다." \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: $reason}}'
  exit 0
fi

exit 0
