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
# F65: 읽기에도 흔히 쓰는 도구 — 이 이름 목록을 가진 arm만 탐지·복구 배선 시 건너뛴다.
# 편집 전용 도구(vim·ed·patch·dd·sponge…)와 컨트롤 플레인 arm은 이 목록을 갖지 않으므로
# 면제 대상이 아니다. 면제 판정과 패턴 정의가 같은 출처를 갖게 하려고 변수로 뽑았다.
READ_CAPABLE_ARM='(g?sed|g?awk|mawk)'
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
  # F65: `-i` 를 **결합 단축옵션까지** 넓힌다. `sed -ni`·`sed -ie`·`awk -iinplace` 는 실제로
  # 파일을 쓰는데 `-i` 리터럴로는 `-ni` 를 잡지 못한다. 그동안 에디터 이름 arm이 sed·awk를
  # 통째로 잡아 가려져 있었고, 그 arm을 탐지·복구로 대체하자 드러났다(behavioral 프로브가 검출).
  # 장옵션 과탐은 생기지 않는다 — 첫 `-` 뒤가 `[a-zA-Z]` 이어야 하므로 `--quiet`·`--posix`·
  # `--field-separator` 는 두 번째 `-` 에서 걸러진다(F63 2차 판정이 지적한 과탐의 원인 제거).
  '\b(g?sed|perl|g?awk|mawk)\b[^;|&]*(^| )-[a-zA-Z]*i[a-zA-Z]*[^;|&]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.(sh|json)|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md|\.claude/settings(\.local)?\.json)'
  '\b(g?sed|perl|g?awk|mawk)\b[^;|&]*--in-place[^;|&]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.(sh|json)|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md|\.claude/settings(\.local)?\.json)'
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
  # F65: 에디터 이름 arm을 **도구 성격으로** 가른다.
  #
  # (1) 편집 전용 도구 — 보호 경로에 이 이름들이 나오면 편집 의도로 보는 것이 타당하다.
  #     읽기 용도로 쓰지 않으므로 마찰이 되지 않으며, 탐지·복구가 배선돼도 건너뛰지 않는다.
  '\b(ed|ex|vi|vim|nano|emacs|dd|patch|sponge)\b[^;|&]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.sh|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md)'
  # (2) 읽기에도 흔히 쓰는 도구 — 이름만으로는 읽기와 쓰기를 가를 수 없다(그 판정이
  #     결정 불가능하다는 것이 F63의 결론이다). 쓰기 신호가 명령에 드러나는 경우는 위
  #     in-place·리다이렉트·복사 arm이 이미 잡으므로, 남는 것은 순수 읽기뿐이다.
  #     그래서 탐지·복구가 배선돼 있으면 이 arm만 건너뛴다 — 사용자가 보고한 마찰의 출처다.
  '\b(g?sed|g?awk|mawk)\b[^;|&]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.sh|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md)'
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
  '^ *(ed|ex|vi|vim|nano|emacs|dd|patch|sponge)\b[^;|&]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.sh|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md)'
  '>>? *[^ ]*(hooks/hooks\.json|\.claude/settings(\.local)?\.json)'
  '\b(cp|mv|install|rsync|ln|tee|sponge|truncate)\b[^;|&]*(hooks/hooks\.json|\.claude/settings(\.local)?\.json)'
  # === 탐지기 자신을 지키는 arm (F65 1차 판정) ===
  # 분류 축은 "되돌릴 수 있는가" 하나가 아니라 **"자기를 복구할 수 있는가"**까지다.
  # protected-integrity.sh 는 파괴되면 자기를 복구할 수 없고, 티켓 파일은 복구 대상 판단의
  # 근거이므로 둘 다 컨트롤 플레인이다. 어떤 도구로 건드리든 물어본다.
  # basename으로 앵커한다 — 경로 표기(`cd progress && … >> .guarded-edits`·`progress//…`)로
  # 빠져나가던 것을 2차 판정이 실증했다. F-1에서 feature_list.json 에 이미 적용한 방식이다.
  # 명령행에 경로가 아예 없는 형태(`python3 script.py`)는 여전히 열려 있다 — 예측의 원리적
  # 한계이며 INV-14에 적었다. 티켓 파일은 셸을 쥔 상대에게 위조 불가능하지 않다.
  '[^;|&]*(protected-integrity\.sh|\.guarded-edits|\.integrity-baseline)'
  # git 메타 조작 — 파일을 바꾸지 않고 **탐지를 실명시킨다**. 도구 이름이 확정적이고
  # 정상 개발에서 거의 쓰지 않으므로 게이트해도 마찰이 없다.
  'git\b[^;|&]*update-index[^;|&]*(--assume-unchanged|--skip-worktree|--no-assume-unchanged)'
  'git\b[^;|&]*\brm\b[^;|&]*--cached'
  # 컨트롤 플레인 전용 에디터 arm (F65). 위 데이터 플레인 arm은 탐지·복구가 배선되면
  # 건너뛰지만 이 줄은 절대 건너뛰지 않는다 — hooks.json·settings*.json 을 바꾸면 탐지 훅의
  # 배선 자체를 끌 수 있고, settings.json 은 gitignore라 HEAD 복구도 불가능하다.
  '\b(ed|ex|vi|vim|nano|emacs|g?sed|g?awk|mawk|sponge|dd|patch)\b[^;|&]*(hooks/hooks\.json|\.claude/settings(\.local)?\.json)'
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

# === Layer 3.5: 데이터 플레인 게이트 (F65) ===
#
# ## 왜 읽기 화이트리스트를 걷어냈는가
#
# 이전 설계(F63)는 "이 명령이 보호 파일을 쓸 것인가"를 명령 문자열로 예측했다. 그 질문은
# 결정 불가능하다 — 셸도, 셸이 부르는 sed·awk·perl·python도 튜링 완전하므로 실행하지 않고
# 효과를 아는 방법이 없다. 10회전 동안 매번 새 우회 표기가 나왔고(붙여쓴 optarg·중괄호 확장·
# 명령 치환·프로세스 치환·인용 제거 미수행·이름 변형·경로 표기), 예측이 불가능하니 알려진
# 형태를 나열하는 수밖에 없었다. 그 나열이 곧 커버리지 상한이 됐고, 동시에 읽기까지 잡아
# 사용자가 보고한 반복 승인 프롬프트를 만들었다.
#
# ## 대신 무엇을 하는가
#
# 되돌릴 수 있는 변경은 예측하지 않고 **사후에 탐지·복구**한다
# (hooks/protected-integrity.sh, PostToolUse:Bash). "파일이 바뀌었는가"는 도구와 무관하게
# 자명하게 결정되므로, 무엇으로 어떻게 바꿨든 잡힌다 — 한 번도 본 적 없는 방법이라도.
#
# 그래서 아래 ASK 패턴 중 **데이터 플레인** 계열은 탐지·복구가 배선돼 있을 때 발동시키지
# 않는다. 패턴 자체는 지우지 않는다(INV-5 add-only) — 배선이 사라지면 즉시 되살아나는 폴백이다.
#
# ## 무엇을 계속 예측으로 막는가 (경계)
#
#  - **컨트롤 플레인**: hooks/hooks.json · .claude/settings*.json
#    이 둘을 바꾸면 탐지 훅의 배선 자체를 끌 수 있고, settings.json은 gitignore라 복구도 안 된다.
#  - **되돌릴 수 없는 것**: rm -rf / · mkfs · 시크릿 외부 유출 (Layer 1·2 및 egress arm)
#    사후 복구가 성립하지 않으므로 예측이 유일한 수단이다. 이 계층은 이번 변경과 무관하다.
#
# 배선 확인이 실패하면(파일 없음·jq 없음) 게이트는 **켜진 상태로 남는다** — fail-safe다.

# 건너뛸 수 있는 것은 **에디터 이름 arm 뿐**이다.
#
# 왜 그 arm만인가: 나머지 arm은 전부 쓰기 신호가 명령에 드러난다 — in-place는 `-i`,
# 리다이렉트는 `>`, 복사 계열은 cp·mv·tee 라는 이름 자체가 쓰기다. 그래서 읽기를 잡지 않는다.
# 반면 에디터 이름 arm은 도구 이름만 보므로 `sed -n '1,20p' <보호경로>` 같은 순수 읽기까지
# 잡는다 — 사용자가 보고한 반복 승인 프롬프트의 실제 출처가 정확히 이 arm이다.
#
# 그리고 이 arm이 막으려던 것(에디터로 보호 파일을 바꾸는 것)은 되돌릴 수 있는 변경이므로
# 탐지·복구가 더 넓게 커버한다. 나머지 arm은 손대지 않는다 — 건너뛸 이유가 없다.

# 배선 확인은 **실효성**을 본다 — 배선 문자열만 보면 훅이 파괴돼도(빈 파일·실행 불가)
# "배선됨"을 반환해 예측을 끈 채로 탐지도 없는 상태가 된다(F65 1차 판정 지적).
# 그래서 (1) 훅 파일이 실제로 존재하고 비어 있지 않으며 (2) 어느 설치 경로든 배선돼 있을 때만
# 참이다. 둘 중 하나라도 확인되지 않으면 게이트는 켜진 상태로 남는다(fail-safe).
# 배선 확인은 **실제로 실행되는 설치본**만 본다.
# 2차 판정: 이전 구현이 `$PWD/hooks/` 도 후보에 넣었는데 그건 소스 체크아웃이라 **모든 클론에
# 존재한다** — 설치도 배선도 안 된 저장소에서 예측을 끄는 fail-open이었다(이 저장소가 그 사례였다).
# 실행 경로는 둘뿐이다: 플러그인 설치(CLAUDE_PLUGIN_ROOT)와 init.sh 설치(.claude/hooks).
# 소스 체크아웃은 후보가 아니다. 확인되지 않으면 게이트는 켜진 채로 남는다(fail-safe).
integrity_wired() {
  command -v jq &>/dev/null || return 1
  local root f
  for root in "${CLAUDE_PLUGIN_ROOT:-}" "$PWD/.claude"; do
    [[ -n "$root" && -s "$root/hooks/protected-integrity.sh" ]] || continue
    for f in "$root/hooks/hooks.json" "$PWD/.claude/settings.json" "$PWD/settings.json"; do
      [[ -f "$f" ]] || continue
      jq -e --arg r "$root" '.hooks.PostToolUse[]? | select((.matcher? // "") | test("Bash"))
               | .hooks[]? | select(.command | contains("protected-integrity.sh"))' "$f" \
        &>/dev/null && return 0
    done
  done
  return 1
}

DATA_PLANE_DETECTED=1
integrity_wired && DATA_PLANE_DETECTED=0


# === Layer 3.4: 순수 읽기 면제 ===
#
# ## 무엇을 고치는가
#
# 위 arm들은 대부분 **도구 이름 + 보호 경로**로 판정한다. 그래서 파일을 읽기만 하는 명령까지
# ask가 됐다 — `sed -n '1,60p' hooks/x.sh` · `cat progress/.guarded-edits` ·
# `awk 'NR>1 {print $0}' hooks/x.sh` 같은 것들이다. 최근 2주 트랜스크립트에서 ask 246건을
# 뽑아 보니 상위 세 패턴(81·30·23건)의 대부분이 이 계열이었다. 읽는 행위는 그 파일을
# 훼손할 수 없으므로 이 마찰에는 대응하는 보호 가치가 없다.
#
# ## 왜 이 방향은 F63처럼 발산하지 않는가
#
# F63은 "이 명령이 쓸 것인가"를 **블랙리스트**로 판정하려다 실패했다(10회전, 매번 새 우회 표기).
# 여기는 반대 방향의 **화이트리스트**다 — 아래 형태에 들어맞지 않으면 면제되지 않고 기존 판정이
# 그대로 간다. 새 우회 표기는 화이트리스트에 없으므로 자동으로 ask다. 커버리지 상한이
# 마찰 쪽에 생길 뿐 보호 쪽에 생기지 않는다는 것이 두 방향의 결정적 차이다.
#
# ## 도구별 근거 (왜 이것들은 쓸 수 없는가)
#
#  - 순수 리더(cat·grep·jq·wc·ls·diff…): 파일을 쓰는 문법 자체가 없다. 리다이렉트가 붙으면
#    그때만 쓰기가 되므로 `>`가 남아 있으면 면제하지 않는다(`>/dev/null`·`2>&1`은 먼저 제거).
#  - sed: 파일을 쓰는 경로는 `-i`와 `w` 명령/`s///w` 플래그뿐이다. **스크립트 안에 `w`가 없고**
#    `-i`가 없으면 sed는 파일을 만들 수 없다. 경로에 든 w는 무관하므로 스크립트만 본다.
#  - awk: 쓰기 채널은 출력 리다이렉트(`print > expr`)·파이프(`print | "cmd"`)·`system()`·
#    `"cmd" | getline` 넷뿐이다. 파이프는 세그먼트 분리에서 이미 걸리고, `system(`·`getline`은
#    직접 배제하며, 리다이렉트는 **첫 print 이후에 `>`가 있는가**로 판정한다. 그래야
#    `awk 'NR>190'` 같은 비교 연산자는 통과하고 `awk '{print > "f"}'` 는 막힌다.
#    `-v` 로 경로를 변수에 담아도 그 쓰기는 결국 print 뒤의 `>` 를 지나야 한다.
#  - find/sort: 각각 `-exec`·`-delete`·`-fprint` 와 `-o` 가 유일한 쓰기 경로다.
#  - 인터프리터(python·node·perl…)·에디터·cp·mv·tee 계열은 **넣지 않는다** — 읽기와 쓰기를
#    구문으로 가를 수 없거나(전자) 이름 자체가 쓰기다(후자).
#
# 시크릿 경로·명령 치환·프로세스 치환이 보이면 형태와 무관하게 면제하지 않는다.
pure_read_only() {
  local cmd="$1" seg tok rest script after
  [[ "$cmd" == *'`'* || "$cmd" == *'$('* || "$cmd" == *'<('* ]] && return 1
  case "$cmd" in
    *.ssh/* | *.aws/* | *.gnupg/* | *.netrc* | *id_rsa* | *id_ed25519* | *id_dsa* | *id_ecdsa* | *credentials*) return 1 ;;
  esac
  # /dev/null 리다이렉트와 fd 병합은 파일을 만들지 않는다 — 판정 전에 지운다.
  cmd=$(printf '%s' "$cmd" | sed -E 's@[0-9]*&?>>? *(/dev/null|/dev/stderr)@@g; s/[0-9]*>&[0-9]//g')
  # 세그먼트 분리는 **인용부호를 인식한다.** 단순 tr 분리는 `awk 'NR>1 && /x/ {print}'` 처럼
  # 스크립트 안에 구분자가 든 정상 읽기를 조각내 첫 토큰 검사에서 떨어뜨렸다(과분리 → 과탐).
  # 인용부호 **밖**의 `;`·`|`·`&`만 경계로 삼고 안쪽은 원본 그대로 남긴다 — awk의
  # `print | "cmd"`(셸 실행)를 아래에서 스크립트 원문으로 판정해야 하기 때문이다.
  local seg_list
  IFS=$'\n' read -r -d '' -a seg_list < <(printf '%s' "$cmd" | awk '
    { out=""; inS=0; inD=0
      for (i=1; i<=length($0); i++) { c=substr($0,i,1)
        if (c=="\047" && !inD) { inS=!inS; out=out c; continue }
        if (c=="\042" && !inS) { inD=!inD; out=out c; continue }
        if (!inS && !inD && (c==";" || c=="|" || c=="&")) { out=out "\n" } else { out=out c }
      }
      print out }'; printf '\0')
  for seg in "${seg_list[@]}"; do
    # 변수 대입·셸 키워드는 명령이 아니다 — 벗겨 내고 그 뒤를 본다(본체는 다음 세그먼트로 온다).
    while :; do
      IFS=' ' read -r tok rest <<<"$seg"
      case "$tok" in
        '') break ;;
        [A-Za-z_]*=* | for | while | until | do | done | if | then | elif | else | fi | case | esac | in | : | time) seg="$rest" ;;
        *) break ;;
      esac
    done
    [[ -z "${tok// /}" ]] && continue
    [[ "$tok" == "rtk" ]] && IFS=' ' read -r tok rest <<<"$rest"
    case "$tok" in
      cat | head | tail | nl | wc | ls | stat | file | basename | dirname | realpath | readlink | shasum | sha1sum | sha256sum | md5 | md5sum | cmp | diff | grep | egrep | fgrep | rg | jq | cut | uniq | tr | column | rev | od | xxd | strings | which | type | command | date | env | test | echo | printf | pwd | true | false | cd | shellcheck | bats)
        [[ "$seg" == *'>'* ]] && return 1
        ;;
      sort)
        [[ "$seg" == *'>'* || "$seg" == *' -o'* || "$seg" == *'--output'* ]] && return 1
        ;;
      find)
        [[ "$seg" == *'>'* || "$seg" == *-exec* || "$seg" == *-delete* || "$seg" == *-ok* || "$seg" == *-fprint* || "$seg" == *-fls* ]] && return 1
        ;;
      sed | gsed)
        [[ "$seg" == *'>'* ]] && return 1
        [[ "$seg" =~ (^|[[:space:]])-[a-zA-Z]*i ]] && return 1
        script=""
        if [[ "$seg" =~ \'([^\']*)\' ]]; then
          script="${BASH_REMATCH[1]}"
        elif [[ "$seg" =~ \"([^\"]*)\" ]]; then
          script="${BASH_REMATCH[1]}"
        elif [[ "$seg" =~ -n[[:space:]]+([^[:space:]]+) ]]; then
          script="${BASH_REMATCH[1]}"
        else
          return 1
        fi
        [[ "$script" == *w* ]] && return 1
        ;;
      awk | gawk | mawk)
        [[ "$seg" == *' -f '* ]] && return 1
        [[ "$seg" =~ (^|[[:space:]])-[a-zA-Z]*i ]] && return 1
        # 판정은 **스크립트 원문**으로 한다 — 비교 연산자 `NR>190` 과 출력 리다이렉트
        # `print > "f"` 는 둘 다 `>` 지만, 후자는 반드시 print/printf 뒤에 온다.
        script=""
        if [[ "$seg" =~ \'([^\']*)\' ]]; then
          script="${BASH_REMATCH[1]}"
        elif [[ "$seg" =~ \"([^\"]*)\" ]]; then
          script="${BASH_REMATCH[1]}"
        else
          script="$seg"
        fi
        [[ "$script" == *'system('* || "$script" == *getline* ]] && return 1
        if [[ "$script" == *print* ]]; then
          after="${script#*print}"
          [[ "$after" == *'>'* || "$after" == *'|'* ]] && return 1
        fi
        # 스크립트 밖에 남은 `>` 는 셸 리다이렉트다.
        [[ "${seg/"$script"/}" == *'>'* ]] && return 1
        ;;
      *) return 1 ;;
    esac
  done
  return 0
}

PURE_READ=0
pure_read_only "$CMD" && PURE_READ=1

if [ "$PURE_READ" -eq 0 ] && echo "$NORMALIZED_CMD" | grep -qiE "$(join_patterns "${ASK_PATTERNS[@]}")"; then
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
      # 탐지·복구가 배선돼 있으면 **에디터 이름 arm만** 건너뛴다.
      # 판정은 패턴 문자열의 부분일치로 한다 — 패턴은 정규식이므로 정규식으로 다시 매칭하면
      # 백슬래시 때문에 빗나간다(첫 구현에서 실제로 그렇게 무력화됐다).
      # 컨트롤 플레인을 덮는 arm은 제외한다: hooks/hooks.json 과 settings*.json 은 이 훅의
      # 배선 자체를 끌 수 있어 사후 복구가 성립하지 않는다.
      # 건너뛰는 것은 **읽기에도 쓰는 도구 arm 하나뿐**이다. 판정은 패턴 문자열의 부분일치로
      # 한다 — 패턴 자체가 정규식이므로 정규식으로 다시 매칭하면 백슬래시 때문에 빗나간다.
      # READ_CAPABLE_ARM 이 그 arm에만 있고 컨트롤 플레인 arm에는 없으므로, 이 조건은
      # 데이터 플레인 읽기만 통과시킨다.
      if [ "$DATA_PLANE_DETECTED" -eq 0 ] \
         && [[ "$p" == *"$READ_CAPABLE_ARM"* ]] \
         && [[ "$p" != *'hooks\.json'* && "$p" != *'settings'* && "$p" != *'-i'* ]]; then
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
