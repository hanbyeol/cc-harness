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

# 작은따옴표 **안**의 명령 구분자를 중화한다. 아래 패턴들의 `[^;|&]*` 스팬은 "여기서 다른
# 명령이 시작된다"를 뜻하는데, 셸은 인용부호 안의 `;`를 구분자로 보지 않는다. 이 불일치 때문에
# `sed -n 'p;w <보호경로>' src` 가 allow였다(5차 판정 확인 — main에서도 그랬고 실제로 덮어쓴다).
# 패턴을 늘리는 대신 **정규화에서 고친다** — cp·mv·tee·인터프리터·egress 등 `[^;|&]`를 쓰는
# 모든 arm이 한 번에 정합해지고, 인용부호 밖의 진짜 구분자는 그대로 남아 과탐이 생기지 않는다.
# 따옴표 상태는 **양쪽 종류를 함께** 추적해야 한다 — 6차 판정: 큰따옴표 안의 어포스트로피
# (`echo "it's done"; python3 build.py; ls <보호경로>`)가 작은따옴표 상태를 뒤집어 그 뒤 모든
# 구분자를 중화했고, 정상 명령이 ask가 되는 과탐을 만들었다. 셸에서는 `"` 안의 `'`가 리터럴이고
# `'` 안의 `"`도 리터럴이므로, 각 상태는 다른 쪽이 열려 있지 않을 때만 토글된다.
#
# **중화 전 원본을 따로 남긴다.** 중화는 ASK 패턴의 스팬을 셸 의미에 맞추려는 것이지 명령을
# 다시 쓰는 것이 아니다. Layer 3.5의 읽기 화이트리스트는 원본으로 판정해야 한다 — 중화본으로
# 보면 인용부호 안의 `|`가 공백이 되어, awk 프로그램의 `"cmd" | getline`(셸 실행)이 파이프 없는
# 무해한 프로그램처럼 보인다. 두 계층이 서로의 판단 근거를 지우는 상호작용이며 실측으로 확인했다.
RAW_CMD="$NORMALIZED_CMD"
NORMALIZED_CMD=$(printf '%s' "$NORMALIZED_CMD" | awk '
  { out=""; inS=0; inD=0
    for (i=1; i<=length($0); i++) { c=substr($0,i,1)
      if (c=="\047" && !inD) { inS=!inS; out=out c; continue }
      if (c=="\042" && !inS) { inD=!inD; out=out c; continue }
      if ((inS || inD) && (c==";" || c=="|" || c=="&")) { out=out " " } else { out=out c }
    }
    print out }')

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
  # 인용부호 안의 `;`가 위 스팬을 끊던 구멍은 **정규화 단계에서** 닫았다(파일 상단 참조) —
  # cp·mv·tee·인터프리터·egress 등 `[^;|&]`를 쓰는 모든 arm이 함께 정합해진다.
  # 5차에서는 여기에 세미콜론을 넘어 보는 시작 앵커 변형을 뒀었는데, 그것이
  # `sed -n '1,20p' README.md; grep -n foo <보호경로>` 같은 **정상 복합 명령을 새로 잡는 과탐**을
  # 만들었다(F63이 없애려던 마찰 계열). 정규화가 원인을 제거했으므로 이 자리는 시작 앵커를 붙인
  # 위 패턴의 부분집합으로 좁혀 둔다 — 단독으로 발동하지 않는다.
  # 줄을 지우지 않는 이유: invariant-guard의 INV-5(add-only)가 패턴 수 감소를 차단하며,
  # 가드를 우회하지 않는다. count_array가 작은따옴표로 시작하는 줄만 세므로 리터럴로 유지한다.
  # 경로 목록에서 feature_list.json을 뺀다 — 면제 판정이 "패턴 문자열에 feature_list가 없을 것"을
  # 조건으로 쓰므로(아래 ASK 디스패치), 여기 남겨 두면 보호 파일 **읽기**까지 면제에서 빠져
  # 사용자가 보고한 마찰이 그대로 돌아온다. feature_list 자체의 게이트는 전용 패턴이 담당한다.
  '^ *(ed|ex|vi|vim|nano|emacs|g?sed|g?awk|mawk|sponge|dd|patch)\b[^;|&]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.(sh|json)|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md|\.claude/settings(\.local)?\.json)'
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
# 허용 조건(전부 만족해야 한다). **대상은 sed뿐이다** — awk는 7차에 제외했다(아래 참조):
#   - 인용부호 밖 문자가 전부 안전 집합 안에 있다(셸 전개·치환·확장이 구조적으로 불가능)
#   - 명령 전체가 아래 세 sed 형태 중 하나와 일치한다(끝의 $ 앵커)
#   - 끝 슬롯은 하이픈으로 시작하지 않는다 — 그 자리를 '파일'이라 부르므로 옵션이 들어오면 안 된다
#
# 이 목록이 곧 보증의 전부다. 여기 적히지 않은 것은 보증하지 않는다 — 5차·8차 판정이 모두
# "주석이 코드보다 강하고 그 초과분에 구멍이 있다"를 지적했으므로, 서술을 코드에 맞춰 좁힌다.
SAFE_READ=0
# 선행 가드 — 셸 문맥에 다른 명령이 섞일 여지가 있으면 화이트리스트를 아예 건너뛴다.
#
# **배제 문자를 열거하지 않는다.** 4차에서 `$(`·`${`·백틱을 열거했더니 5차 판정이 중괄호 없는
# `$IFS` + 프로세스 치환으로 빠져나갔다 — `awk '{print}' <(patch$IFS./hooks/lib.sh$IFS./p.diff)`
# 가 실제로 보호 파일을 덮어썼다. 이 계약이 "쓰기 문법 열거는 수렴하지 않는다"며 방향을 뒤집어
# 놓고 정작 새 가드를 다시 열거로 만든 것이 원인이다.
#
# 대신 **허용 문자를 긍정 열거한다**: 작은따옴표 구간은 셸이 전개하지 않으므로(리터럴 인자)
# 통째로 제거하고, 남은 부분이 안전 문자 집합에 들어가는지 본다. 여기 없는 문자가 하나라도
# 있으면 화이트리스트를 건너뛴다 — 새 전개 문법이 생겨도 문자가 집합 밖이면 자동으로 막히고,
# 안전한 형태를 빠뜨리면 ask로 남을 뿐이다(틀리는 방향이 안전하다).
#
# **집합은 "셸이 특별하게 다루지 않는 문자"로만 구성한다.** 6차 판정: 5차의 집합에 남겨 둔
# `{`·`}`·`,` 와 `*`·`[`·`]` 는 **한 단어를 여러 단어로 만드는** 확장이다. 형태 앵커는
# "한 토큰 = 한 인자"를 암묵 전제하는데, 중괄호 확장은 그 전제를 사후에 깬다 —
# `awk {-F,-f}/tmp/evil.awk <보호경로>` 는 앵커에는 인자 두 개로 보이지만 셸이 세 개로 펼쳐
# `-f`(프로그램 파일)를 awk에 넘긴다. 3차에서 닫은 `awk -f` 우회가 그렇게 부활했고,
# 하이픈 배제는 **리터럴 첫 글자**에만 걸리므로 확장으로 만들어진 단어를 막지 못했다.
#
# 그래서 집합을 영숫자와 경로 문자(`_`·`.`·`/`·`-`)와 공백으로 줄인다. 전개·확장·치환에
# 쓰이는 문자가 하나도 남지 않으므로, "전개 후 단어 수가 보존된다"가 문자 수준에서 보장된다.
# 인용 없는 awk 프로그램(`/warn/{print}`)은 이제 ask다 — 마찰이지 보호 상실이 아니며,
# 실제 사용에서 sed/awk 프로그램은 거의 항상 인용된다(사용자가 보고한 형태도 전부 인용형).
#
# `:` 만 예외로 남긴다(`awk -F: '{print}'`). `:`가 전개에 관여하는 구문은 `${var:-…}`(중괄호 필요)와
# 대입 안의 틸데 전개(`~` 필요)뿐이고 둘 다 이 집합 밖 문자를 요구하므로, `:` 단독은 불활성이다.
# 판단 근거를 적어 두는 이유: 이 집합에 문자를 더할 때마다 같은 수준의 논증을 요구하기 위해서다.
UNQUOTED_PART=$(printf '%s' "$RAW_CMD" | sed "s/'[^']*'//g")
if printf '%s' "$UNQUOTED_PART" | grep -qE '^[A-Za-z0-9_.:/ -]*$'; then
  # === sed 읽기 판정 — **토큰 단위** ===
  #
  # 정규식으로 명령 문자열 전체를 훑는 방식을 버린다. 8차와 9차가 같은 축의 **인접 슬롯**을
  # 각각 뚫었기 때문이다: 8차는 끝(파일) 슬롯에 붙여쓴 optarg `-ew<경로>`, 9차는 스크립트
  # 슬롯 — `'?` 가 인용을 선택으로 두고 스크립트 클래스가 공백을 배제하지 않아, 인용 없는
  # 스크립트가 셸에서 여러 단어로 쪼개지고 GNU sed가 그 여분을 옵션으로 파싱했다.
  #   sed -n /a -ewharness-config.json /p README.md   → 대상 파일 덮어씀
  #   sed -n /a -f prog.sed /p hooks/lib.sh           → 임의 sed 프로그램 = 임의 명령 실행
  # 슬롯을 하나씩 막는 방식은 수렴하지 않는다. 정규식이 문자열 전체를 훑으면 **슬롯 경계가
  # 흐려지고**, 한 슬롯을 좁혀도 옆 슬롯이 같은 역할을 대신 받는다.
  #
  # 그래서 **"한 슬롯 = 한 셸 인자"를 구조적으로 강제한다.** 선행 가드가 셸 전개를 전부
  # 배제했으므로 단어 분리는 공백뿐이고 작은따옴표 구간만 원자적이다 — 즉 훅이 셸과 동일하게
  # 토큰화할 수 있다. 토큰을 하나씩 분류하고, 분류되지 않는 토큰이 하나라도 있으면 거부한다.
  # 이렇게 하면 새 옵션·새 붙여쓰기 형태가 나와도 '알려진 안전 옵션'이 아닌 이상 자동으로 막힌다.
  tokenize_cmd() {
    printf '%s' "$1" | awk '
      { tok=""; inq=0
        for (i=1;i<=length($0);i++) { c=substr($0,i,1)
          if (c=="\047") { inq=!inq; tok=tok c; continue }
          if (c==" " && !inq) { if (tok!="") { print tok; tok="" }; continue }
          tok=tok c
        }
        if (tok!="") print tok }'
  }

  SED_TOKS=()
  while IFS= read -r _t; do SED_TOKS+=("$_t"); done < <(tokenize_cmd "$RAW_CMD")

  if [ "${#SED_TOKS[@]}" -ge 3 ] && [ "${SED_TOKS[0]}" = "sed" ]; then
    _ok=1; _quiet=0; _nscript=0; _nfile=0; _script=""; _script_at=-1; _file_at=-1
    _i=1
    while [ "$_i" -lt "${#SED_TOKS[@]}" ]; do
      _t="${SED_TOKS[$_i]}"
      case "$_t" in
        -n|--quiet|--silent)                      _quiet=1 ;;
        --posix|--regexp-extended|-E|-r|-s|-z)    : ;;
        # 그 밖의 하이픈 토큰은 전부 거부한다 — 붙여쓴 optarg(-ew…·-f…)와 미지의 옵션을
        # 열거 없이 배제하는 자리다. 안전 옵션은 위에 **완전일치**로만 적는다.
        -*)                                       _ok=0 ;;
        # 인용된 스크립트 — 인용은 **필수**다(9차: `'?` 가 선택이면 인용 없는 스크립트가
        # 셸에서 쪼개져 여분 단어가 옵션이 된다).
        \'*\')                                    _nscript=$((_nscript+1)); _script="$_t"; _script_at=$_i ;;
        *)                                        _nfile=$((_nfile+1)); _file_at=$_i ;;
      esac
      _i=$((_i+1))
    done

    # 슬롯 수와 순서를 강제한다: 스크립트 정확히 1개, 파일 정확히 1개, 스크립트가 파일보다 앞.
    if [ "$_ok" -eq 1 ] && [ "$_nscript" -eq 1 ] && [ "$_nfile" -eq 1 ] && [ "$_script_at" -lt "$_file_at" ]; then
      _body="${_script#\'}"; _body="${_body%\'}"
      # 스크립트 문법 — 출력 전용이 확실한 세 형태. 공백을 포함할 수 없다(아래 클래스에 없음).
      #   -n 필요: 주소+p (1,20p · 5p · $p) · /re/p
      #   -n 불필요: s/x/y/<플래그>  — 플래그 집합에 w(파일 쓰기)와 e(셸 실행)는 없다
      if { [ "$_quiet" -eq 1 ] && printf '%s' "$_body" | grep -qE '^[0-9,$]+p$'; } \
         || { [ "$_quiet" -eq 1 ] && printf '%s' "$_body" | grep -qE '^/[^/]*/p$'; } \
         || printf '%s' "$_body" | grep -qE '^s/[^/]*/[^/]*/[gpIi0-9]*$' ; then
        SAFE_READ=1
      fi
    fi
  fi

  # === awk는 화이트리스트에 넣지 않는다 (사용자 결정, 7차) ===
  #
  # sed와 awk는 겉보기에 대칭이지만 정적 판정 가능성이 다르다. sed는 앵커가 **인용 스크립트
  # 슬롯의** 문법을 좁게 묶는다 — 주소+`p`, `/re/p`, `s/x/y/<검증된 플래그>` 세 형태뿐이라
  # 그 슬롯에 올 수 있는 것이 사실상 열거돼 있다. (8차 판정 정정: 이 보증은 **인용 스크립트
  # 슬롯에만** 참이다. `-e` 라는 두 번째 스크립트 슬롯은 그 제약 밖에 있었고 실제로 그리로
  # 뚫렸다 — 그래서 위에서 `-e` 를 SED_SAFEOPT에서 빼고 끝 슬롯의 하이픈을 배제했다.)
  # 반면 awk의 프로그램 자리는 **완전한 프로그래밍
  # 언어**이고, 앵커는 그것이 인용돼 있다는 것 외에 아무것도 제약하지 못한다.
  #
  # 실제로 이 슬롯은 판정 회전마다 새로운 방식으로 뚫렸다 — `-f`(프로그램을 파일에서 읽기),
  # `-v`(변수 경유 리다이렉트), `print >`, `system()`, gawk `@include`, 중괄호 확장으로 만든
  # `-f`, 그리고 `"cmd" | getline`(셸 실행). 일곱 가지가 전부 다른 메커니즘이다.
  # 부정 조건을 더할 때마다 다음 회전에 새 축이 나왔고, 그 축들은 열거로 수렴하지 않았다.
  #
  # 그래서 awk 읽기는 ask로 남긴다. 잃는 것은 마찰 해소의 일부이고 얻는 것은 이 슬롯이
  # 만들어 온 실패 클래스 전체의 제거다. awk로 보호 파일을 읽어야 하면 `grep`·`cat`·`head`·
  # `jq`(전부 auto-allow)를 쓰면 된다 — 대체 수단이 있다는 점이 이 절충을 값싸게 만든다.
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
      # feature_list arm은 면제하지 않는다(6차 판정 병행 권고). INV-11의 Bash 우회 게이트이므로
      # 여기까지 면제하면 SC-3의 손실 상한 서술이 코드로 거짓이 된다. feature_list.json을
      # sed로 읽는 것은 ask로 남지만 — 그것이 이 게이트가 지키는 값어치에 비해 싼 마찰이다.
      if [ "$SAFE_READ" -eq 1 ] && [[ "$p" == *"$EDITOR_NAME_ARM"* && "$p" != *feature_list* ]]; then
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
