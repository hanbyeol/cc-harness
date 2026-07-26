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

# F38: 결정 분포 관측(로깅만 — 판정 로직·순서 무변경). 명령 원문은 기록하지 않고(SC2)
# 결정 종류만 progress/.firewall-stats에 append. 실패는 무시(로깅이 방화벽을 깨지 않음).
log_decision() {
  local sf pd
  pd="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
  sf="$pd/progress/.firewall-stats"
  [[ -d "$pd/progress" ]] && printf '%s\n' "$1" >> "$sf" 2>/dev/null || true
}

deny() {
  log_decision deny
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
#
# 이름 기반 에디터 목록 — 도구 이름만으로 판정하므로 각 도구의 쓰기 문법을 몰라도 안전하다.
# Layer 3.5의 읽기 화이트리스트가 **면제할 수 있는 유일한 패턴 계열**이며, 아래 두 자리에서만
# 쓰인다. 변수로 뽑아 둔 이유는 면제 대상 식별과 패턴 정의가 같은 출처를 갖게 하기 위해서다 —
# 목록이 바뀌면 면제 판정도 함께 바뀐다(어긋나면 면제가 멈춰 읽기가 ask가 될 뿐, 보호는 유지).
EDITOR_NAME_ARM='(ed|ex|vi|vim|nano|emacs|g?sed|g?awk|mawk|sponge|dd|patch)'
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
  '\b(cp|mv|install|rsync|ln|tee|sponge|truncate)\b[^;|&]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.sh|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md)'
  # in-place 쓰기. -i 뒤에 단어경계를 두지 않는다 — sed -ie·sed -ni·awk -iinplace 처럼
  # 결합 단축옵션이 실제로 파일을 쓴다(실측: echo AAA > t1; sed -ie s/AAA/BBB/ t1 → BBB).
  # `-[a-zA-Z]*i` 로 넓히지 않는다 — 하이픈 뒤 i를 포함한 장옵션(--quiet·--posix·
  # --field-separator=·--lint)까지 in-place로 오인해 새 과탐을 만든다(F63 2차 판정).
  # `-i` 는 --in-place 도 부분 매치하므로 별도 대안이 필요 없다.
  '\b(g?sed|perl|g?awk|mawk)\b[^;|&]*-i[^;|&]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.(sh|json)|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md|\.claude/settings(\.local)?\.json)'
  # sed의 w 명령/s///w 플래그 — 플래그도 리다이렉트도 없이 임의 파일에 쓴다.
  # 실측: sed -n 'w victim' src → victim에 src 내용 · sed 's/x/PWN/w victim2' → victim2=PWN.
  # F63 이전에는 에디터 이름 목록이 sed를 통째로 잡아 가려져 있었다.
  '\bg?sed\b[^;|&]*\bw\b *[^;|&]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.(sh|json)|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md|\.claude/settings(\.local)?\.json)'
  '\bof= *[^ ]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.sh|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md)'
  # 민감 파일(비밀키·크리덴셜) 이동/복사/덮어쓰기
  '\b(cp|mv|rsync|install|tee|scp)\b[^;|&]*(\.ssh/|\.aws/|\.gnupg/)'
  '>>? *[^ ]*(\.ssh/|\.aws/|\.gnupg/)'
  # git 실행 훅 경로 변경 — 이후 임의 git 명령이 임의 스크립트 실행(에스컬레이션)
  'git config[^;|&]*core\.hooksPath'
  # S-1(F32): 메커니즘 무관 보호경로 게이팅 — 인터프리터·에디터·git -c·GIT_CONFIG 우회 차단.
  # 보호경로 토큰이 있을 때만 발동한다(정상 개발 python3 script.py·vim foo.py는 미발동).
  #
  # F63: sed·awk는 아래 에디터 목록에 **그대로 둔다**(이름 기반 = 쓰기 문법을 몰라도 안전).
  # 읽기 마찰은 Layer 3.5의 화이트리스트가 해소한다 — 방향이 반대인 이유는 그쪽 주석 참조.
  #
  # 처음에는 sed·awk를 여기서 빼고 in-place 플래그로만 판정했는데, 두 차례 판정이 각각
  # 여섯 형태씩 열린 것을 실증했다(결합 단축옵션 -ie·-ni·-iinplace / GNU 인자 순열
  # `sed 's/a/b/' <파일> -i` / sed w의 공백·주소 변형 `w<파일>`·`1w <파일>` /
  # awk 변수 경유 `-v f=<파일> '{print > f}'`·`BEGIN{f="<파일>"; print > f}`).
  # 쓰기 문법을 열거하는 블랙리스트는 **전수를 알아야** 안전한데 수렴하지 않았다.
  #
  # 인터프리터(바로 아래)도 그대로다 — python·node·perl은 읽기/쓰기를 구문으로 구분할 수 없다.
  '\b(python3?|node|nodejs|ruby|perl|php|lua)\b[^;|&]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.(sh|json)|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md|\.claude/settings(\.local)?\.json)'
  '\b(ed|ex|vi|vim|nano|emacs|g?sed|g?awk|mawk|sponge|dd|patch)\b[^;|&]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.(sh|json)|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md|\.claude/settings(\.local)?\.json)'
  # 위 패턴의 `[^;|&]*` 스팬은 **인용부호 안의 `;`에서도 끊긴다** — `sed -n 'p;w <보호경로>' src`
  # 가 그래서 allow였다(4차 판정 별건, F63 이전부터 존재). 명령이 그 도구로 **시작할 때만**
  # 세미콜론을 넘어 보는 변형을 하나 더 둔다. 시작 앵커가 있으므로 `echo hi; cat <보호경로>`
  # 같은 정상 명령은 걸리지 않는다. 패턴 문자열은 리터럴로 둔다 — invariant-guard의
  # count_array가 작은따옴표로 시작하는 줄만 세므로, 변수 보간을 쓰면 가드의 계수에서 빠진다.
  '^ *(ed|ex|vi|vim|nano|emacs|g?sed|g?awk|mawk|sponge|dd|patch)\b[^|&]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.(sh|json)|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md|\.claude/settings(\.local)?\.json|feature_list\.json)'
  '>>? *[^ ]*(hooks/hooks\.json|\.claude/settings(\.local)?\.json)'
  '\b(cp|mv|install|rsync|ln|tee|sponge|truncate)\b[^;|&]*(hooks/hooks\.json|\.claude/settings(\.local)?\.json)'
  'git\b[^;|&]*-c[^;|&]*core\.hooksPath'
  'GIT_CONFIG_(COUNT|KEY|VALUE|GLOBAL|SYSTEM)'
  # S-2(F33): 시크릿 네트워크 유출(egress) — 민감 파일이 네트워크로 나갈 때 ask(무인 exfil 차단).
  # (네트워크 전송기 + 민감 파일 참조) 결합 시에만 발동 — 정상 curl GET·비민감 데이터는 무손상.
  '\b(curl|wget|nc|ncat|socat)\b[^;|&]*(\.ssh/|\.aws/|\.gnupg/|\.netrc|id_rsa|id_ed25519|id_dsa|id_ecdsa)'
  '\b(curl|wget)\b[^;|&]*( -d ?@| --data[a-z-]*[= ]?@?| -F [^;|&]*@| -T | --upload-file )[^;|&]*(credentials|secret|\.env|\.pem|\.key|token)'
  '(\.ssh/|\.aws/|\.gnupg/|\.netrc|id_rsa|id_ed25519|credentials)[^;|&]*\| *[^;|&]*\b(nc|ncat|socat|curl|wget)\b'
  '\b(scp|sftp|rsync)\b[^;|&]*(\.ssh/|\.aws/|\.gnupg/|\.netrc|id_rsa|id_ed25519|credentials|\.pem)[^;|&]*(@|:)'
  # F35(INV-11): passes 전환 근거 검증(invariant-guard는 Edit|Write만 후킹)의 Bash 우회 차단 —
  # feature_list.json을 셸로 직접 쓰는 경로(리다이렉트·복사·in-place·인터프리터·에디터·dd) 게이팅.
  # 읽기(jq/grep/cat 조회)는 미발동 — 쓰기 메커니즘 토큰과 결합할 때만 ask.
  # basename 앵커(harness-config 패턴과 동일 방식) — progress// · cd progress 등 경로정규화 우회 차단 (F-1).
  '>>? *[^ ]*feature_list\.json'
  '\b(cp|mv|install|rsync|ln|tee|sponge|truncate)\b[^;|&]*feature_list\.json'
  '\b(sed|perl|awk)\b[^;|&]*-i[^;|&]*feature_list\.json'
  '\bsed\b[^;|&]*\bw\b *[^;|&]*feature_list\.json'
  '\bof= *[^ ]*feature_list\.json'
  '\b(python3?|node|nodejs|ruby|perl|php|lua)\b[^;|&]*feature_list\.json'
  '\b(ed|ex|vi|vim|nano|emacs|g?sed|g?awk|mawk|sponge|dd|patch)\b[^;|&]*feature_list\.json'
)

# === Layer 3.5: 읽기 화이트리스트 (F63) — ASK 검사보다 먼저 ===
#
# 보호 경로의 sed/awk는 위 ASK 목록이 이름으로 전부 잡는다(보호 완전). 그 대가로 순수
# 읽기까지 프롬프트가 떠서, 같은 파일을 grep·cat으로 읽으면 allow인데 sed -n으로 읽으면
# ask인 비일관이 생겼다 — 사용자가 겪던 반복 승인의 실제 원인이다.
#
# **방향을 뒤집어 읽기 쪽을 열거한다.** 쓰기 문법을 열거하는 블랙리스트는 전수를 알아야
# 안전한데, 두 차례 판정이 각각 여섯 형태를 새로 찾아내며 수렴하지 않음을 보였다
# (in-place 결합 단축옵션·GNU 인자 순열·sed w의 공백/주소 변형·awk 변수 경유 리다이렉트).
# 반대로 여기서 빠뜨린 읽기 형태는 ask로 남을 뿐 보호를 잃지 않는다 — 틀리는 방향이 안전하다.
#
# 허용 조건(전부 만족해야 한다):
#   - 명령이 sed 또는 awk 하나로만 구성된다(파이프·연쇄·리다이렉트 없음 — 위 [^;|&] 계열과 동일 취지)
#   - sed: 아래 세 형태 중 하나와 **전체가** 일치한다(끝의 $ 앵커 — 뒤에 인자가 붙으면 불일치)
#   - awk: 인라인 프로그램에 쓰기 수단(-i·-v·print>·system)이 하나도 없다
SAFE_READ=0
# 선행 가드 — 셸 문맥에 다른 명령이 섞일 여지가 있으면 화이트리스트를 아예 건너뛴다.
# 4차 판정: 형태 앵커는 sed/awk의 **인자 형태**만 검사하고 그 인자가 놓인 셸 문맥은 보지
# 않는다. 파일 슬롯 `[^ ']+$` 는 공백만 없으면 무엇이든 받으므로 `${IFS}` 로 공백을 대신하면
# 명령 치환이 통째로 파일 인자 자리에 들어간다 — `awk '{print}' $(cp${IFS}/tmp/x${IFS}<보호경로>)`
# 가 실제로 보호 파일을 덮어썼다. 치환·전개 문자를 여기서 배제한다.
if [[ "$NORMALIZED_CMD" != *'>'* && "$NORMALIZED_CMD" != *'|'* && "$NORMALIZED_CMD" != *';'* \
   && "$NORMALIZED_CMD" != *'&'* && "$NORMALIZED_CMD" != *'$('* && "$NORMALIZED_CMD" != *'${'* \
   && "$NORMALIZED_CMD" != *'`'* ]]; then
  # sed: 출력 전용이 확실한 세 형태만 긍정 열거한다.
  #   sed -n '1,20p' <file>  ·  sed -n 5p <file>  ·  sed -n '/re/p' <file>  ·  sed 's/a/b/' <file>
  # w를 부정 조건으로 쓰지 않는다 — `\bw` 는 /word/의 w를 잡고(과탐) `1w file`은 놓친다
  # (보호 상실). 양방향으로 틀리는 부정 조건 대신 형태 전체를 앵커로 고정한다: 치환 형태의
  # 플래그 문자 집합에 w가 없으므로 `s/x/y/w <file>` 은 일치하지 않고, 끝의 `$` 때문에
  # `sed 's/a/b/' <file> -i` 같은 인자 순열도 일치하지 않는다.
  # 여기 없는 읽기 형태(예: `sed -n '$=' <file>`)는 ask로 남는다 — 마찰이지 보호 상실이
  # 아니며, 그것이 이 방향을 택한 이유다.
  # 치환 플래그 집합에서 **e를 뺐다** — GNU sed의 s///e는 패턴 공간을 셸로 실행한다.
  # 3차 판정이 실증: `sed 's/.*/rm -rf ~/e' <보호경로>` 는 DENY 패턴이 문자열 안의
  # payload를 보지 못해 화이트리스트를 타고 allow가 됐다. 읽기 형태 하나를 잘못 넣으면
  # ask→allow 한 단계가 아니라 임의 명령 실행이 된다.
  SED_QUIET='(-n|--quiet|--silent)'
  SED_SAFEOPT='(--posix|--regexp-extended|-[Eersz]+)'
  if echo "$NORMALIZED_CMD" | grep -qE "^ *sed +($SED_SAFEOPT +)*$SED_QUIET +($SED_SAFEOPT +)*'?[0-9,\$]+p'? +[^ ']+$" \
     || echo "$NORMALIZED_CMD" | grep -qE "^ *sed +($SED_SAFEOPT +)*$SED_QUIET +($SED_SAFEOPT +)*'?/[^/']*/p'? +[^ ']+$" \
     || echo "$NORMALIZED_CMD" | grep -qE "^ *sed +($SED_SAFEOPT +)*'?s/[^/']*/[^/']*/[gpIi0-9]*'? +[^ ']+$" ; then
    SAFE_READ=1
  fi
  # awk: sed와 같은 방식으로 형태 전체를 앵커한다 — 허용 옵션은 -F(필드 구분자)뿐이고
  # 프로그램은 인용부호 안에, 그 뒤에 파일 인자 하나로 끝나야 한다.
  #   awk 'NR<10' <file>  ·  awk '{print $1}' <file>  ·  awk -F: '{print}' <file>
  # 3차 판정이 실증: 부정 조건만 쓰면 **프로그램이 파일에 있는 형태를 볼 수 없다.**
  # `awk -f prog.awk <보호경로>` 는 -i·-v·print>·system 이 명령행에 하나도 없으므로
  # 부정 조건을 전부 통과했고, 실제로 보호 파일을 덮어썼다(main에서는 ask였던 회귀).
  # 앵커는 이것을 열거 없이 배제한다 — -f·--file=·--include= 는 인용된 프로그램 자리에
  # 오지 못한다. 부정 조건은 앵커 안에서 여전히 필요하다: `awk '{print > "<P>"}' src` 는
  # 앵커에 맞지만 쓰기다.
  # 프로그램 자리는 인용되어 있거나(`'…'`), 인용 없이 오되 **하이픈으로 시작하지 않아야**
  # 한다. 인용 없는 형태(`awk /warn/{print} <file>`·`awk {print $1} <file>`)는 셸에서
  # 정상 동작하는 읽기이므로 받아야 하고, 하이픈 배제가 -f·-E·--file= 을 프로그램 자리에
  # 오지 못하게 막는다 — 열거가 아니라 위치로 배제하는 것이 요점이다.
  AWK_FORM="^ *(g?awk|mawk) +(-F ?[^ ']+ +)*('[^']*'|[^-' ][^ ']*) +[^ ']+$"
  if echo "$NORMALIZED_CMD" | grep -qE "$AWK_FORM" \
     && ! echo "$NORMALIZED_CMD" | grep -qE '(^| )-[a-zA-Z]*i|--in-place|(^| )-v|--assign' \
     && ! echo "$NORMALIZED_CMD" | grep -qE '\b(print|printf)[^;}]*>' \
     && ! echo "$NORMALIZED_CMD" | grep -qE '\bsystem *\(' ; then
    SAFE_READ=1
  fi
fi

if echo "$NORMALIZED_CMD" | grep -qiE "$(join_patterns "${ASK_PATTERNS[@]}")"; then
  for p in "${ASK_PATTERNS[@]}"; do
    if echo "$NORMALIZED_CMD" | grep -qiE "$p"; then
      # 화이트리스트가 **면제할 수 있는 패턴은 이름 기반 에디터 목록뿐이다.**
      # 4차 판정 이전에는 SAFE_READ=1이 ASK 배열 전체를 건너뛰었고, 그 때문에 화이트리스트의
      # 결함 하나가 sed/awk 마찰을 넘어 egress 티어(`$(curl -T ~/.ssh/id_rsa …)`)와
      # INV-11 Bash 우회 게이트(`$(cp /tmp/x progress/feature_list.json)`)까지 열었다.
      # 3차에서 내가 'ASK 앞에 두었으니 최악도 ask→allow 한 단계'라고 주장한 손실 상한은
      # **면제 범위를 국소화해야 비로소 참이 된다.** 이제 다른 패턴이 하나라도 걸리면 ask다.
      if [ "$SAFE_READ" -eq 1 ] && [[ "$p" == *"$EDITOR_NAME_ARM"* ]]; then
        continue
      fi
      log_decision ask
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
log_decision allow
jq -n --arg reason "위험 명령(deny/ask)에 해당하지 않는 명령 — cc-harness firewall이 자동 허용했습니다." \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: $reason}}'
exit 0

exit 0
