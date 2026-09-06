#!/usr/bin/env bash
set -euo pipefail
# 이 훅의 5초 타임아웃 대비 전체 경과 시간을 재는 기준점 — scan_control_plane_delete() 의
# 세그먼트 순회 예산(아래)이 **이 함수가 불리는 시점부터**가 아니라 **훅이 시작된 시점**
# 부터 재야 한다(F65 17차 독립 판정 재작업 중 자체 발견, 판정 대상 아님): 이 위 정규화
# 단계(NORMALIZED_CMD 구성)만으로도 매우 큰 입력에서는 몇 초가 걸릴 수 있어, 함수
# 진입 시점부터 재면 이미 예산의 상당 부분이 조용히 소모된 뒤일 수 있다.
__HOOK_START_NS=$(date +%s%N)
INPUT=$(cat)
if ! command -v jq &>/dev/null; then
  # jq 없이는 명령을 파싱할 수 없다 — 조용한 fail-open 대신 경고를 남긴다
  echo "cc-harness firewall: jq not found — firewall inactive" >&2
  exit 0
fi
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")
[[ -z "$CMD" ]] && exit 0

# **전체 명령 길이에 진입점 상한을 둔다(F65 17차 독립 판정 재작업 중 자체 발견, 판정 대상
# 아님)**: scan_control_plane_delete() 의 세그먼트 순회 예산(아래)만으로는 부족하다는 것을
# 재작업 도중 실측으로 확인했다 — 아래의 `NORMALIZED_CMD` 정규화(awk, 문자 단위 루프)와
# 훨씬 뒤의 Layer 3(ASK_PATTERNS) 정규식 검사 둘 다 그 자체로 큰 입력에서 수 초가 걸릴 수
# 있어, scan_control_plane_delete() 안의 시간 예산이 트립되기도 전에, 또는 트립된 뒤에도
# 그 바깥의 다른 단계에서 시간이 계속 쌓여 5초 타임아웃에 다가간다(실측: 14만자 입력이
# 삭제 동사 없이도 4.7~9.3초). 모든 단계를 각각 고치는 대신 — 이 파일이 반복 겪어 온
# "국소 상한을 계속 늘려가도 다음 층에서 또 새는" 패턴을 반복하지 않기 위해 — 진입점에서
# **원문 명령 길이 자체**를 본다. 넘으면 정밀 분석을 시도하지 않고 곧장 확인을 요청한다
# — 이 파일 전체의 원칙("모르면 allow 가 아니라 ask")을 훅의 문턱 자체에 적용한 것이다.
#
# **바이트 수로 재야 한다(18차 독립 판정이 반려한 결함) — 문자 수(`${#CMD}`)가 아니다.**
# 이 상한이 막으려는 모든 비용(awk 정규화·Layer 3 정규식·세그먼트 스캔)은 **바이트** 에
# 비례하는데, `${#CMD}` 는 UTF-8 로케일에서 **문자** 를 센다. 그래서 4바이트 문자(이모지
# 등) 32768개로 채운 명령은 `${#CMD}` 로는 상한 아래(32768)지만 실제로는 13만 바이트라
# 처리 시간이 그대로 새서(실측: 이 기기 기준 부하에 따라 idle 3.9초~부하 24에서 55.7초)
# 5초 타임아웃을 넘긴다 — 상한 자체가 우회 가능했다. `wc -c` 는 로케일과 무관하게 항상
# 바이트를 센다(`wc -m` 과 달리) — 그래서 이걸로 바꾼다. 외부 프로세스 포크가 하나
# 늘지만(측정: 정상 크기 입력에서 무시할 만한 수 ms), 이 파일 전체가 "모르면 ask" 원칙을
# 지키려고 매번 치르는 비용과 같은 종류다.
# `wc` 가 없거나 실패하면(극히 드물지만 이 파일의 다른 필수 도구 jq 처럼 배포 환경에
# 따라 없을 수 있다) `set -e` 아래에서 파이프라인 실패가 스크립트를 곧장 죽여 JSON을
# 한 글자도 못 내놓는다 — jq 부재 시엔 경고 후 exit 0(방화벽 비활성)로 명시적으로
# 처리하는데 여기만 조용히 죽어 fail-open 처럼 보일 위험이 있다(19차 독립 판정 지적).
# `|| echo` 로 실패를 흡수하고, 빈 결과는 숫자가 아니어서 아래 `-gt` 비교 자체가 죽을
# 수 있으므로 먼저 빈 값 자체를 안전한 쪽(ask)으로 떨어뜨린다.
CMD_BYTES=$(printf '%s' "$CMD" | wc -c 2>/dev/null || echo "")
if [[ -z "$CMD_BYTES" ]]; then
  jq -n --arg reason "명령 길이를 측정하지 못해(wc 실행 실패) 정밀 분석 없이 확인을 요청합니다." \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: $reason}}'
  exit 0
fi
if [[ $CMD_BYTES -gt 32768 ]]; then
  jq -n --arg reason "명령이 비정상적으로 길어(${CMD_BYTES}바이트) 정밀 분석 없이 확인을 요청합니다 — 이 길이의 Bash 명령은 정상 사용에서 나타나지 않습니다." \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: $reason}}'
  exit 0
fi

# 개행은 모든 공백류와 함께 **공백으로 접는다.** 그러면 아래 패턴들의 `[^;|&]*` 스팬이 명령
# 경계를 넘어 이어지므로, 무관한 두 명령이 한 스팬으로 묶이는 과탐이 남는다(알려진 갭).
#
# **왜 개행을 구분자로 바꾸지 않는가 (F67 1차 판정)**: 실제로 한 번 바꿨다가 되돌렸다.
# 셸에서 개행이 구분자가 **아닌** 자리는 인용부호 안과 줄 이음만이 아니다 — heredoc 본문,
# `|`·`&&`·`||` 뒤의 줄바꿈, `(`·`{` 블록과 `for`·`if` 절 사이가 모두 그렇다. 앞의 둘만
# 열거했더니 셋째에서 **컨트롤 플레인이 열렸다**: `python3 - <<'EOF'` 본문에서 heredoc의
# 개행이 `;` 가 되어 스팬이 끊기고, 도구 이름과 `.claude/settings.json` 이 서로 다른 스팬에
# 놓여 판정이 ask에서 allow로 뒤집혔다(격리 랩에서 파일 교체까지 실증). 그 경로는 gitignore
# 대상이라 PROTECTED_GLOBS에도 없어 사후 복구가 없는 자리다 — 예측이 유일한 수단인 곳에
# 구멍을 낸 것이다.
#
# 전수를 맞추려면 셸 파서가 필요하고, 부분 구현은 매번 이런 구멍을 만든다(F63이 10회전 겪은
# 열거 실패와 같은 계열이다). 그래서 개행 오인식은 **알려진 갭으로 남기고** 정규화를 되돌렸다.
# 스팬이 길게 유지되는 방향이므로 보호는 약해지지 않는다 — 남는 것은 과탐뿐이다.
#
# 개행 전달에 \034(FS 제어문자)를 쓰는 이유: awk의 `RS` 는 POSIX에서 단일 문자만 보장되므로
# 개행을 그대로 넘기면 레코드가 줄 단위로 쪼개져 인용부호 상태 추적이 줄을 넘지 못한다.
# 명령 문자열에 이 제어문자가 들어올 일은 없다.
#
# 같은 순회에서 작은따옴표 **안**의 명령 구분자를 중화한다. 아래 패턴들의 `[^;|&]*` 스팬은 "여기서 다른
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
NORMALIZED_CMD=$(printf '%s' "$CMD" | tr '\n' '\034' | awk '
  { out=""; inS=0; inD=0; prev=""
    for (i=1; i<=length($0); i++) { c=substr($0,i,1)
      if (c=="\047" && !inD) { inS=!inS; out=out c; prev=c; continue }
      if (c=="\042" && !inS) { inD=!inD; out=out c; prev=c; continue }
      # 개행은 **항상 공백으로 접는다**(main 이래의 동작). F67이 이 자리에서 개행을 명령
      # 구분자 `;` 로 바꿨다가 되돌렸다 — 아래 "왜 되돌렸나" 참조.
      if (c=="\034") { out=out " "; prev=c; continue }
      if ((inS || inD) && (c==";" || c=="|" || c=="&")) { out=out " " } else { out=out c }
      prev=c
    }
    print out }' | tr -s '[:space:]' ' ' | sed 's/^ //;s/ $//')

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
  # F74(2026-08-10, 사용자 override): 원래 'git push[^;|&]*--force([^-]|$)' — 원격 브랜치를
  # 강제로 덮어쓰는 push를 이 하네스의 최고 위험 등급(rm -rf /·DROP DATABASE·포크폭탄과 동급,
  # Layer 1 BLOCKED)으로 잡던 패턴이었다. 사용자가 3라운드 고지(대상 확인 → F71/F73급 경계
  # 축소 고지 → 이 줄이 ASK가 아니라 BLOCKED임을 정정 고지 후 deny→allow 재확인) 끝에 명시
  # 수용해 제거를 요청했다. 아래는 실제 명령과 결코 매치하지 않는 tombstone이다 — INV-5는
  # BLOCKED 배열의 **라인 수**만 검사하므로(텍스트 보존 아님, F73에서 확인) 라인을 지우지
  # 않고 텍스트만 교체해 add-only를 지키면서 매치를 무력화한다. 이 라인은 더 이상 실질적
  # 방어를 하지 않는다 — F71/F73과 달리 이 명령엔 사후 탐지·복구(protected-integrity.sh)도
  # 없다(git ref 재작성은 그 모델 밖). 남는 완충은 git reflog뿐(GC·시간에 취약). 되돌리려면
  # 이 줄을 원래 패턴으로 되돌리면 된다. docs/INVARIANTS.md INV-15, docs/DECISIONS/ADR-004
  # Amendment 7, progress/contracts/sprint-60.json 참조.
  '\bF74_TOMBSTONE_PUSH_FORCE_NEVER_MATCH\b'
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
# F67: 인터프리터도 **도구 이름만으로** 판정하는 arm이다 — 위 에디터 이름 arm과 성질이 같아
# 순수 읽기까지 잡는다. Layer 3.4(pure_read_only)에는 넣을 수 없다: `-c` 뒤가 임의 프로그램이라
# 읽기·쓰기를 가르려면 대상 언어의 파서가 필요하다(아래 도구별 근거 주석이 그렇게 적어 두었다).
# 그래서 에디터 arm과 같은 방식으로 처리한다 — 탐지·복구가 배선돼 있으면 면제한다.
INTERPRETER_ARM='(python3?|node|nodejs|ruby|perl|php|lua)'
# 면제 대상 arm의 판별 토큰 — **단일 출처**(F67 SC-2). 부분일치 조건을 판정부에만 두면 패턴
# 문자열을 고칠 때 면제 범위가 조용히 바뀐다. 여기 없는 토큰을 가진 arm은 면제되지 않는다.
#
# 넣는 기준은 하나다: **그 arm이 읽기를 잡는가.** 쓰기 신호가 명령에 드러나는 arm
# (리다이렉트 `>` · cp/mv/tee/install/rsync 이름 · in-place `-i` · `dd of=` · `sed w`)은
# 읽기를 잡지 않으므로 면제해도 마찰이 줄지 않고 손실 상한만 늘어난다 — 넣지 않는다.
#
# **인터프리터 arm은 면제하지 않았다 (2026-08-02, F67 철회) — 이후 F71에서 사용자 override로
# 다시 면제 대상에 편입됐다 (2026-08-08).** 철회 경위: 여섯 회전에 걸쳐 이 면제의 손실 상한을
# 경로로 구속하려 했고 매번 한 층 아래에서 같은 결함이 나왔다 — 명령 문자열로 실제 대상을
# 확정하는 것은 결정 불가능하기 때문이다(F63의 결론). 마지막 상태에서는 상한에 **복구 불가능한
# 설치본 훅**(`cd .claude && python3 -c "open('hooks/lib.sh','w')"`)까지 들어왔고, 그 대가로 사는
# 것은 인터프리터 읽기 프롬프트 하나였다. 교환이 성립하지 않아 철회했다.
# `sed`/`awk` 는 다르다: `-i`·`w`·리다이렉트 부재로 **읽기가 확정**되고 그 판정이 구문으로
# 결정 가능하다(F65). 판정 근거는 도구 이름이 아니라 확정 가능성이다. 인터프리터는 `-c` 뒤가
# 임의 프로그램이라 이 확정이 여전히 불가능하다 — F71이 바꾼 것은 이 확정 가능성이 아니라,
# **사용자가 그 결정 불가능성을 명시적으로 수용하기로 한 것**이다.
# F71 override (2026-08-08, 사용자 지시): 철회 이력과 위 cd 우회 사례, 그리고 이번 재도입이
# 추가로 여는 것(git 미추적 신규 파일 생성 — 사전 예측도 사후 탐지도 없음, 접미사/대소문자
# 변형, 데이터 플레인 순수 읽기 포함 전면 허용)을 구현 전 사용자에게 두 차례 고지했고, 두 차례
# 모두 "안전장치 없는 전면 면제"를 선택했다(경로 제한·cd/chdir 가드 부활 모두 거부). 되돌리려면
# 아래에서 INTERPRETER_ARM을 다시 빼면 된다 — docs/INVARIANTS.md INV-14, docs/DECISIONS/ADR-004
# Amendment 5, progress/contracts/sprint-57.json(F71) 참조.
EXEMPTABLE_ARM_TOKENS=(
  "$READ_CAPABLE_ARM"
  "$INTERPRETER_ARM"
)

# 이 arm을 탐지·복구에 넘길 수 있는가. 판정은 **패턴 문자열의 부분일치**로 한다 — 패턴 자체가
# 정규식이므로 정규식으로 다시 매칭하면 백슬래시 때문에 빗나간다(첫 구현에서 실제로 그렇게
# 무력화됐다).
arm_is_exemptable() {
  local p="$1" tok
  # 토큰이 일치해도 아래는 절대 면제하지 않는다 — 사후 복구가 성립하지 않는 자리다.
  #  - hooks.json·settings*.json: 이 훅의 배선 자체를 끄고, settings는 gitignore라 HEAD 복구 불가
  #  - 탐지기 자신과 티켓 원장: 파괴되면 자기를 복구할 수 없다(F65 SC-6)
  # F73(2026-08-08, 사용자 override): in-place(`-i`) 하드 제외를 지웠다 — "쓰기 신호가 드러나는
  # arm은 면제하지 않는다"는 원칙을 sed/awk in-place 쓰기에 한해 뒤집는 결정이다(F71과 같은
  # 무게). 안전한 이유는 `-i`/`--in-place` 리터럴을 포함하는 arm 중 실제로 면제되는 것이
  # 도구 목록이 `READ_CAPABLE_ARM`(`(g?sed|g?awk|mawk)`)과 정확히 같은 arm뿐이라는 데 있다 —
  # 그 arm들은 사용자가 승인한 데이터 플레인(harness-config.json 등)·contracts/*.json·
  # feature_list.json만 대상으로 한다. 나머지 `-i`/`--in-place` 보유 arm(원래 sed/awk/perl이
  # 섞여 있던 arm에서 perl만 남긴 것들, 그리고 `hooks/*.json`(hooks.json 제외분) 커버리지
  # 손실을 되돌리려 F37 2차 후속으로 perl을 다시 sed/awk와 섞어 넣은 arm — 개수는 고정값이
  # 아니므로 여기 세지 않는다)은 도구 목록에 `perl`이 항상 끼어 있어 `READ_CAPABLE_ARM`을
  # 연속 부분문자열로 포함하지 않는다 — 그래서 아래 토큰 매치가 여전히 실패해 면제되지 않는다
  # (perl·`hooks/*.json` 대상 sed/awk in-place 계속 ask, 실측 확인됨). `protected-integrity`
  # 등 `-i`를 우연히 포함하는 다른 패턴은 아래 별도 하드 제외가 이미 막는다.
  [[ "$p" == *'hooks\.json'* || "$p" == *'settings'* ]] && return 1
  [[ "$p" == *'protected-integrity'* || "$p" == *'guarded-edits'* || "$p" == *'integrity-baseline'* ]] && return 1
  # F68: 무인 중단 기록도 탐지기의 판단 근거와 같은 성격이다 — 지워지면 "멈췄다"는 사실이
  # 사라진다. 인터프리터로 읽는 마찰보다 기록이 남는 쪽이 값어치가 크므로 면제하지 않는다.
  [[ "$p" == *'approval-queue'* ]] && return 1
  # F67 2차 판정: 면제가 성립하는 조건은 "읽기를 잡는 arm인가" 하나가 아니라
  # **"그 arm이 덮는 모든 경로를 사후 탐지가 담당하는가"**까지다. 아래 둘은 탐지 집합 밖이다.
  #  - `.claude/**/hooks/*.sh`: init.sh 배선(`settings.json`)이 실제로 실행하는 설치본인데
  #    `.claude/`는 gitignore 대상이라 HEAD 복구가 원리적으로 불가능하다.
  #  - `templates/**/{harness-config,feature_list}.json`: 신규 프로젝트가 상속하는 seed 다.
  #    5차 판정 뒤 `templates/progress/*.json`을 PROTECTED_GLOBS·is_protected에 편입해 **복구는
  #    가능해졌지만**, seed 는 새 프로젝트 전부에 퍼지므로 예측도 함께 남긴다(다중 방어).
  # 아래 두 arm(경로 앵커)이 그 클래스의 예측을 되살리고, 이 줄이 그 arm을 면제에서 뺀다.
  [[ "$p" == *'\.claude/'* || "$p" == *'templates/'* ]] && return 1
  for tok in "${EXEMPTABLE_ARM_TOKENS[@]}"; do
    [[ "$p" == *"$tok"* ]] && return 0
  done
  return 1
}

# === [은퇴] 면제가 성립하는 경로 (F67 2~6차 판정) ===
# **이 함수는 더 이상 호출되지 않는다** (2026-08-02 사용자 결정). 아래 판정부는 경로를 보지 않고
# 다섯 도구(python·node·ruby·sed·awk 계열)를 무조건 면제한다. 여섯 회전 동안 이 함수를 고쳐
# 경로를 구속하려 했고 매번 한 층 아래에서 같은 결함이 나왔다 — 경로 열거 → 대소문자·HEAD 추적 →
# `cd` 형태 → 정규식 우측 앵커 → 문자 클래스 경계 + `cd` 열거. 명령 문자열로 실제 대상을 확정하는
# 것은 F63이 열 회전에 걸쳐 확인한 결정 불가능 축이고, 부분 구현은 닫힌 것으로 오인하게 만든다.
# 코드를 지우지 않는 이유는 INV-5(패턴 총수 add-only)가 따옴표로 시작하는 줄의 감소를 차단하기
# 때문이다 — 삭제하려면 사용자가 직접 편집·승인해야 한다. 되살리려면 판정부에
# `&& exempt_paths_are_detected "$NORMALIZED_CMD"` 를 다시 붙이면 되지만, 그 전에 위 여섯 회전의
# 기록(progress/lessons.md)을 읽을 것.
#
# --- 아래는 은퇴 시점의 원래 설명 ---
# arm이 읽기를 잡는다는 것만으로는 면제 근거가 되지 않는다 — 면제는 예측을 끄는 것이고,
# 예측을 끌 수 있는 유일한 근거는 **그 파일을 사후 탐지·복구가 담당한다**는 사실이기 때문이다.
# arm의 경로 대안은 무앵커라 저장소 사본 말고도 복구 집합 밖 파일을 함께 잡는다:
#   `.claude/hooks/lib.sh`(init.sh 설치본 — gitignore라 HEAD 복구 불가) ·
#   `dist/hooks/app.sh`(저장소의 훅이 아예 아닌 남의 파일) ·
#   `hooks/newfile.sh`(글롭에는 맞지만 HEAD에 없어 되돌릴 내용이 없다).
# 2차 판정이 `hooks/lib.sh`에서 실증한 것이 이 클래스이며, 그때의 교정(탐지 목록 확대)은
# **열거된 여덟 개만** 덮었다. 여기서는 방향을 뒤집는다 — 경로를 열거해 막는 대신
# **탐지 집합에 있는 경로만 면제한다.** 손실 상한이 내 상상력이 아니라 탐지 집합에서 나온다.
#
# 아래 목록은 protected-integrity.sh의 PROTECTED_GLOBS 부분집합이어야 하며,
# tests/pre-bash-firewall.bats가 두 파일을 파싱해 기계 대조한다(F45 양방향 대조 패턴).
DETECTED_LOCATIONS=(
  'progress/harness-config.json'
  'progress/feature_list.json'
  'docs/INVARIANTS.md'
  'hooks/*.sh'
  'tests/*.bats'
  'templates/progress/*.json'
)
exempt_paths_are_detected() {
  local tok stripped dir g hit root lower seen=0
  # 복구 집합은 글롭만으로 정해지지 않는다 — 탐지기는 `git ls-tree HEAD` 를 열거하므로
  # **HEAD 에 없는 파일은 글롭에 맞아도 되돌릴 것이 없다**(3차 판정 실측: `hooks/newfile.sh` 가
  # allow 인데 PostToolUse 가 보고도 복구도 하지 않았다). 그래서 소속과 추적을 함께 본다.
  root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
  # 이 대조는 **표기가 저장소 루트 기준으로 해석된다**는 전제 위에 있다. 명령이 작업 디렉터리를
  # 옮기면 그 전제가 깨진다 — `cd .claude && python3 -c "open('hooks/lib.sh','w')"` 는 표기가
  # 탐지 대상인데 실제로 열리는 것은 설치본이다(4차 판정). 전제가 성립하지 않으면 대조 결과도
  # 근거가 되지 못하므로 면제하지 않는다. **우회 형태를 열거하는 것이 아니라 전제의 파기를
  # 탐지하는 것**이며, 그래서 `cd` 의 표기 변형을 쫓아다닐 필요가 없다.
  [[ "$1" =~ (^|[;\&\|\(]|[[:space:]])cd[[:space:]] ]] && return 1
  [[ "$1" == *chdir* ]] && return 1
  while IFS= read -r tok; do
    [[ -n "$tok" ]] || continue
    # **경로 토큰 전체**를 받아 심사한다. 이전에는 보호 파일명 계열로 끝나는 부분만 뽑았는데,
    # 정규식에 우측 앵커가 없어 명령에 적힌 더 긴 경로가 탐지 대상으로 **잘렸다** —
    # `progress/feature_list.json.bak` 이 `progress/feature_list.json` 으로 뽑혀 면제됐다
    # (5차 판정 실증: `.bak`·`.orig`·`.jsonx` 5형태가 main-ask → allow). 토큰을 통째로 보면
    # 아래 글롭 대조가 정확히 그 차이를 잡는다.
    lower=$(printf '%s' "$tok" | tr '[:upper:]' '[:lower:]')
    case "$lower" in
      *harness-config.json* | *feature_list.json* | *invariants.md* | *hooks/*.sh* | *tests/*.bats*) ;;
      *) continue ;;   # 보호 파일과 무관한 토큰(`python3`·`-c`·`README.md`)은 심사 대상이 아니다
    esac
    seen=1
    stripped="${tok#./}"
    while [[ "$stripped" == *//* ]]; do stripped="${stripped//\/\///}"; done
    # 상위 참조가 있으면 어디로든 갈 수 있다 — 정규화 없이 "탐지 대상"이라 단정하지 않는다.
    # (`hooks/../.claude/hooks/lib.sh` 는 글롭으로는 `hooks/*.sh` 에 걸리지만 설치본을 가리킨다.)
    [[ "$stripped" == *..* ]] && return 1
    dir="${stripped%/*}"
    [[ "$dir" == "$stripped" ]] && dir=""   # 디렉터리 없는 표기는 어느 위치인지 확정할 수 없다
    hit=0
    for g in "${DETECTED_LOCATIONS[@]}"; do
      # 디렉터리가 **정확히** 같아야 한다. bash 의 `==` 글롭에서 `*` 는 `/` 를 넘으므로
      # `hooks/*.sh` 가 `hooks/sub/x.sh` 까지 잡는데, 그것은 HEAD 에 없어 복구 대상이 아니다.
      [[ "${g%/*}" == "$dir" ]] || continue
      # shellcheck disable=SC2053
      [[ "$stripped" == $g ]] && { hit=1; break; }
    done
    [[ "$hit" -eq 1 ]] || return 1
    # 글롭에 맞아도 HEAD 에 없으면 복구 대상이 아니다. git 이 없거나 조회가 실패하면
    # "탐지된다"고 단정할 근거가 없으므로 면제하지 않는다(fail-closed).
    git -C "$root" cat-file -e "HEAD:$stripped" 2>/dev/null || return 1
  done < <(printf '%s\n' "$1" | grep -oE \
    '[A-Za-z0-9_./-]+' \
    2>/dev/null)
  # 보호 파일처럼 보이는 토큰이 하나도 없는데 여기까지 왔다면 추출과 arm 매칭이 어긋난 것이다 —
  # arm 은 `grep -qiE` 로 잡았는데 추출이 못 뽑는 상태이며, 그대로 두면 **공허한 참**이 되어
  # 면제가 무조건 성립한다(3차 판정 실측: 대소문자 변형 8형태가 main-ask → allow).
  # 대소문자는 위 `tr` 로 맞췄고, 그래도 어긋나는 미지의 표기가 있으면 면제하지 않는다.
  [[ "$seen" -eq 1 ]] || return 1
  return 0
}
ASK_PATTERNS=(
  # F74(2026-08-10, 사용자 override): 아래 3줄은 각각 원래 'git reset[^;|&]*--hard' ·
  # 'git clean[^;|&]* -[a-zA-Z]*f' · 'git checkout[^;|&]* --force' 였다 — uncommitted
  # 변경/미추적 파일을 파괴하는 세 서브커맨드를 ASK로 잡던 패턴들이다. 위 BLOCKED 배열의
  # F74_TOMBSTONE_PUSH_FORCE 줄(push --force)과 같은 사용자 override로 제거됐다(같은
  # 3라운드 고지, 같은 근거·같은 tombstone 기법 — 상세 주석은 그 줄 참조, 중복 서술하지
  # 않는다. 정확한 줄 번호는 위 주석이 늘어나면 드리프트하므로 여기 박아두지 않는다).
  # 이 3개도 push --force와
  # 마찬가지로 사후 탐지·복구가 없다 — reset --hard가 궤도 밖으로 보낸 커밋은 git reflog로
  # 일부 복구 가능하지만, clean -f가 지우는 미추적 파일과 checkout --force가 덮어쓰는
  # 미커밋 수정은 git 오브젝트가 애초에 없어 그조차 없다.
  '\bF74_TOMBSTONE_RESET_HARD_NEVER_MATCH\b'
  '\bF74_TOMBSTONE_CLEAN_F_NEVER_MATCH\b'
  '\bF74_TOMBSTONE_CHECKOUT_FORCE_NEVER_MATCH\b'
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
  # F73(2026-08-08, 사용자 override): 이 둘은 원래 `(g?sed|perl|g?awk|mawk)`였다 — sed/awk를
  # 아래 새 전용 arm으로 옮기고 여기는 `perl`만 남긴다. **텍스트를 바꾸지 않고 새 arm을 옆에
  # 추가하는 것만으로는 부족하다**: 판정 루프(`:880` 부근)는 매칭되는 patterns 를 배열 순서대로
  # 전부 순회하며, 그중 **어느 하나라도** 비면제면 그 자리에서 즉시 ask+exit한다(F71/INTERPRETER_ARM
  # 때와 달리, sed 를 포함하는 옛 arm이 같은 명령에 별도로 매치해 새 arm의 exemption을 무의미하게
  # 만든다 — 실측: 새 arm만 추가했더니 옛 arm이 먼저/추가로 매치해 ask가 유지됐다). `perl`만
  # 남기면 이 arm이 `sed -i ...`류 명령에 더 이상 매치하지 않아 충돌이 사라진다. INV-5는 배열별
  # **라인 수** 감소만 차단하므로(`hooks/invariant-guard.sh:767-782`, 텍스트 보존이 아니라 카운트
  # 검사) 기존 라인의 텍스트를 좁히는 것 자체는 막히지 않는다 — net 으로는 6줄이 추가돼 총수도
  # 늘어난다. perl in-place 방어는 이 두 줄에 그대로 남아 무손실이다.
  '\bperl\b[^;|&]*(^| )-[a-zA-Z]*i[a-zA-Z]*[^;|&]*(harness-config\.json|hooks(/\.?)+[A-Za-z0-9_.-]+\.(sh|json)|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md|\.claude(/\.?)+settings(\.local)?\.json)'
  '\bperl\b[^;|&]*--in-place[^;|&]*(harness-config\.json|hooks(/\.?)+[A-Za-z0-9_.-]+\.(sh|json)|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md|\.claude(/\.?)+settings(\.local)?\.json)'
  # F73: sed/awk **전용** in-place arm — 데이터 플레인에만(컨트롤 플레인 `.claude/settings*.json`·
  # `hooks/hooks.json` 제외, hooks는 `.sh`만). 도구 목록이 `READ_CAPABLE_ARM`과 정확히 같은 리터럴이라
  # `arm_is_exemptable()`의 토큰 매치를 통과해 allow가 된다.
  '\b(g?sed|g?awk|mawk)\b[^;|&]*(^| )-[a-zA-Z]*i[a-zA-Z]*[^;|&]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.sh|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md)'
  '\b(g?sed|g?awk|mawk)\b[^;|&]*--in-place[^;|&]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.sh|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md)'
  # **F37 2차 판정 반려 대응(2026-08-09)**: `.sh`만 남기며 위 두 줄의 원래 타겟이던
  # `hooks/*.(sh|json)`에서 `.json`이 통째로 빠졌다 — `hooks/hooks.json`(컨트롤 플레인)을
  # 빼려던 것이지만 grep -E(POSIX ERE)는 부정 전방탐색이 없어 "hooks.json만 제외"를 정규식
  # 하나로 표현할 수 없었고, `.json` 전체를 뺀 결과 `hooks/hooks.json` **아닌** 다른 JSON
  # 파일(가상의 `hooks/other.json` 등)이 **면제가 아니라 무매치**로 통째로 빠졌다 —
  # `PROTECTED_GLOBS`에도 없어 사후 탐지도 없고, 미배선 fail-safe도 비껴간다(실측 확인).
  # 위 두 exemptable arm과 짝을 이루는 **비면제** arm을 여기 더한다 — 도구 목록에 `perl`을
  # 섞어(`READ_CAPABLE_ARM` 리터럴 불일치로 영구 비면제, :339 주석과 같은 장치) `hooks/*.json`
  # 전체(즉 사실상 `hooks.json`)를 예전처럼 항상 ask로 되돌린다. `.sh`는 위에서 이미 다루므로
  # 여기 넣지 않는다 — 중복 매치는 무해하지만 의도를 흐린다.
  '\b(g?sed|perl|g?awk|mawk)\b[^;|&]*(^| )-[a-zA-Z]*i[a-zA-Z]*[^;|&]*hooks(/\.?)+[A-Za-z0-9_.-]+\.json'
  '\b(g?sed|perl|g?awk|mawk)\b[^;|&]*--in-place[^;|&]*hooks(/\.?)+[A-Za-z0-9_.-]+\.json'
  # sed의 w 명령/s///w 플래그 — 플래그도 리다이렉트도 없이 임의 파일에 쓴다.
  # 실측: sed -n 'w victim' src → victim에 src 내용 · sed 's/x/PWN/w victim2' → victim2=PWN.
  # F63 이전에는 에디터 이름 목록이 sed를 통째로 잡아 가려져 있었다.
  '\bg?sed\b[^;|&]*\bw\b *[^;|&]*(harness-config\.json|hooks(/\.?)+[A-Za-z0-9_.-]+\.(sh|json)|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md|\.claude(/\.?)+settings(\.local)?\.json)'
  '\bof= *[^ ]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.sh|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md)'
  # === 계약 파일 (F68 8차 판정 후속) ===
  # `progress/contracts/sprint-*.json` 은 `is_protected()`·`PROTECTED_GLOBS` 에 둘 다 있는데
  # **예측 계층에는 어느 arm에도 없었다.** 그래서 `cp`·리다이렉트·`dd of=`·에디터로 승인 범위
  # (`_batch_approval`·`agreed`)를 바꾸는 것이 무프롬프트였다. 탐지가 되돌리는 것은 실측으로
  # 확인했지만(격리 랩: `_batch_approval` 주입 → PostToolUse → 원상복구), INV-14 가 인정하는
  # "한 Bash 호출 안에서 변조와 소비가 함께 일어나는 창"이 그대로 남는다. 승인 범위는 그 창에서
  # 소비되는 값이므로 두 계층의 대상 집합을 맞춘다 — 예측이 먼저 묻고, 탐지가 나머지를 되돌린다.
  '>>? *[^ ]*contracts/[A-Za-z0-9_.-]+\.json'
  '\b(cp|mv|install|rsync|ln|tee|sponge|truncate)\b[^;|&]*contracts/[A-Za-z0-9_.-]+\.json'
  '\bof= *[^ ]*contracts/[A-Za-z0-9_.-]+\.json'
  '\b(ed|ex|vi|vim|nano|emacs|dd|patch|sponge)\b[^;|&]*contracts/[A-Za-z0-9_.-]+\.json'
  # 위 넷은 셸 모양의 쓰기만 잡는다 — 인터프리터와 sed in-place/`w` 는 별도 arm 이 필요하다
  # (F68 9차 판정 부수 관찰: `python3 -c "open('<계약>','w')"` 과 `sed -i` 가 allow 였다).
  '\b(python3?|node|nodejs|ruby|perl|php|lua)\b[^;|&]*contracts/[A-Za-z0-9_.-]+\.json'
  # F73: perl만 남긴다(위 :339 주석과 같은 이유 — 옛 arm이 sed 를 계속 잡으면 새 arm의
  # exemption이 무효화된다). sed/awk in-place 방어는 아래 새 전용 arm으로 옮긴다.
  '\bperl\b[^;|&]*(^| )-[a-zA-Z]*i[a-zA-Z]*[^;|&]*contracts/[A-Za-z0-9_.-]+\.json'
  '\bperl\b[^;|&]*--in-place[^;|&]*contracts/[A-Za-z0-9_.-]+\.json'
  # F73: sed/awk 전용(perl 제외) in-place arm — 위와 같은 이유로 add-only.
  '\b(g?sed|g?awk|mawk)\b[^;|&]*(^| )-[a-zA-Z]*i[a-zA-Z]*[^;|&]*contracts/[A-Za-z0-9_.-]+\.json'
  '\b(g?sed|g?awk|mawk)\b[^;|&]*--in-place[^;|&]*contracts/[A-Za-z0-9_.-]+\.json'
  '\bg?sed\b[^;|&]*\bw\b *[^;|&]*contracts/[A-Za-z0-9_.-]+\.json'
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
  # F67: 인터프리터 arm을 **평면별로 쪼갠다.** 한 arm에 두 평면을 담으면 면제 판정이
  # `settings` 부분일치로 그 arm을 통째 배제하므로, 데이터 플레인 인터프리터 읽기까지 ask로
  # 남는다(1차 판정이 찾은 갭 — 면제가 feature_list.json 하나에만 닿고 있었다).
  # 두 arm의 합집합은 종전과 같다: `hooks/` 아래 json 은 훅 배선 파일이므로 컨트롤 플레인이
  # 전부 받는다(현재 hooks.json 하나이며, 새 json이 생겨도 배선 계열로 보는 것이 맞다).
  '\b(python3?|node|nodejs|ruby|perl|php|lua)\b[^;|&]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.sh|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md)'
  '\b(python3?|node|nodejs|ruby|perl|php|lua)\b[^;|&]*(hooks(/\.?)+[A-Za-z0-9_.-]+\.json|\.claude(/\.?)+settings(\.local)?\.json)'
  # === 복구가 원리적으로 불가능한 두 위치 (F67 2차 판정) ===
  # 일반 규칙은 exempt_paths_are_detected() 다 — 탐지 집합에 있는 경로만 면제한다. 아래 두 arm은
  # 그 규칙이 이미 덮는 자리를 **이름으로 한 번 더 못박은** 것이며, 두 위치가 다른 경로와 성질이
  # 다르기 때문에 남긴다. `.claude/**/hooks/*.sh` 는 init.sh 배선(`settings.json`)이 실제로 실행하는
  # 설치본인데 `.claude/` 가 gitignore라 **HEAD 복구가 원리적으로 없다.**
  # `templates/**/{harness-config,feature_list}.json` 은 5차 판정 뒤 탐지 대상이 되어 복구는
  # 가능해졌지만, 신규 프로젝트 **전부**가 상속하는 seed 라 예측도 함께 남긴다.
  # 탐지 목록을 나중에 잘못 넓혀도 이 둘은 예측에 남는다. (INV-5 add-only라 삭제도 차단된다.)
  # 도구 앵커를 유지하는 이유는 main과의 판정 동일성(AC-6)이다 — 앵커 없는 경로 arm은
  # `git diff <설치본>` 처럼 main이 allow하던 명령까지 새로 ask로 만든다.
  '\b(python3?|node|nodejs|ruby|perl|php|lua|g?sed|g?awk|mawk)\b[^;|&]*\.claude/[A-Za-z0-9_./-]*hooks/[A-Za-z0-9_.-]+\.sh'
  '\b(python3?|node|nodejs|ruby|perl|php|lua|g?sed|g?awk|mawk)\b[^;|&]*templates/[A-Za-z0-9_./-]*(harness-config|feature_list)\.json'
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
  '>>? *[^ ]*(hooks(/\.?)+hooks\.json|\.claude(/\.?)+settings(\.local)?\.json)'
  '\b(cp|mv|install|rsync|ln|tee|sponge|truncate)\b[^;|&]*(hooks(/\.?)+hooks\.json|\.claude(/\.?)+settings(\.local)?\.json)'
  # === 순수 삭제로 컨트롤 플레인을 비우는 경로 (F65 AC-11 / SC-9) ===
  #
  # 위 두 arm 을 포함해 컨트롤 플레인 arm 은 전부 **덮어쓰기**만 잡고 있었다 — 에디터 이름·
  # cp/mv 계열·리다이렉트는 모두 "쓴다"는 신호를 명령에 드러내기 때문이다. 그런데 배선을
  # 무력화하는 더 짧은 길은 덮어쓰는 것이 아니라 **지우는 것**이고, `rm` 은 어느 arm 에도 없었다.
  #
  # 왜 삭제가 별도로 값을 하는가 (격리 랩 실측, 2026-08-03):
  #   - `.claude/settings.json` 이 **있는 채로** 배선을 뺀 Write → invariant-guard exit 2 (deny)
  #   - `rm` 뒤에 같은 Write                                   → invariant-guard exit 0 (통과)
  # 이 파일은 gitignore 대상이라 HEAD 기준선이 없다. 그래서 삭제가 배선 비교의 OLD 집합을
  # 없애고, 그 순간 재생성 Write 는 "무엇을 약화시켰는지" 대조할 상대를 잃는다. 즉 삭제는
  # 체인에서 **유일하게 값을 하는 단계**이며, 그것이 방화벽에서 allow 였다.
  # (`hooks/hooks.json` 은 git 추적이라 같은 체인이 이미 exit 2 로 막힌다 — 아래 arm 은 그쪽에는
  #  다중 방어이고, `settings.json` 쪽에는 유일한 예측 통제다.)
  #
  # **아래 arm 들은 표기 변형에 뚫린다 — 그것을 12차 판정이 실측했다.**
  # 이전 버전의 이 주석은 "삭제는 표기 변형의 여지가 거의 없어 열거가 수렴한다"고 적었고,
  # 판정자가 `rm -rf .claude/*`·`rm --recursive .claude`·`rm -rf '.claude'` 로 그 문장을 반증했다.
  # 실제 판정은 아래 리터럴 arm 이 아니라 **Layer 3.3 의 경로 토큰 대조**가 담당한다. 이 arm 들은
  # 지우지 않고 남긴다(INV-5 add-only) — 같은 대상을 다른 축(문자열)으로 한 번 더 덮는 다중 방어다.
  # 경로 토큰이 있을 때만 발동하므로 `rm -rf node_modules` 는 그대로 allow 다.
  '\b(rm|unlink|shred)\b[^;|&]*(hooks(/\.?)+hooks\.json|\.claude(/\.?)+settings(\.local)?\.json)'
  # `git rm <경로>` 는 위 arm 의 `\brm\b` 가 이미 잡는다(`--cached` 는 별도 arm 이 담당).
  # `find` 는 경로가 `-name <basename>` 으로 들어와 위 arm 의 디렉터리 앵커에 걸리지 않는다.
  # 술어 순서는 자유이므로 양방향으로 둔다.
  '\bfind\b[^;|&]*(hooks\.json|settings(\.local)?\.json)[^;|&]*(-delete|-exec[a-z]* +rm)'
  '\bfind\b[^;|&]*(-delete|-exec[a-z]* +rm)[^;|&]*(hooks\.json|settings(\.local)?\.json)'
  # 파일 하나만 앵커하면 `rm -rf .claude` 한 줄로 그대로 빠져나간다 — 같은 동사·같은 대상이므로
  # 함께 닫는다. 부분 닫기는 닫힌 것으로 오인하게 만들어 오히려 나쁘다는 것이 F63·F67 의 교훈이다.
  #
  # 대상은 **컨트롤 플레인을 담는 디렉터리**로 한정한다. 열거가 아니라 세 가지 구조적 위치다:
  #   - `.claude`            — 컨트롤 플레인 루트(설치본 훅·settings 가 여기 있다)
  #   - `.claude/plugins[/<플러그인>]` — 플러그인 설치 루트. 여기를 지우면 `hooks/hooks.json` 이 함께 간다
  #   - `…/hooks`            — 배선 파일과 훅 스크립트가 함께 있는 디렉터리
  # 앵커는 **토큰이 그 위치에서 끝날 때**다 — `.claude/worktrees/…` 처럼 다른 하위 경로가 이어지면
  # 발동하지 않는다. 그래야 워크트리·캐시 정리 같은 일상 삭제에 마찰이 생기지 않는다
  # (이 저장소에서 워크트리 정리는 bash `rm` 으로 하지 않는다 — 확인함).
  #
  # 12차 판정 수정: 마지막 대안이 `hooks` 라 **이름이 hooks 인 모든 디렉터리**에 걸렸다 —
  # `rm -rf src/hooks`·`rm -rf web/src/hooks` 가 ask 였다. cc-harness 는 다른 저장소에 설치되는
  # 플러그인이고 React/Vue 계열에서 `src/hooks` 는 흔한 이름이라 실사용 마찰이 된다. 그래서
  # 이 arm 의 디렉터리 대안을 `.claude` 하위로 좁히고(`\.claude/**/hooks`), 프로젝트 루트·설치
  # 루트의 `hooks/` 는 Layer 3.3 이 **이름이 아니라 실체**(그 디렉터리가 hooks.json 을 담는가)로 잡는다.
  # 좁아진 것은 컨트롤 플레인이 아닌 자리뿐이고, 컨트롤 플레인 자리는 두 축 모두가 덮는다.
  '\brm\b[^;|&]*(^| )-[a-zA-Z]*[rR][^;|&]*(^| )[^ ;|&]*(\.claude/plugins(/[A-Za-z0-9_.-]+)?|\.claude(/[A-Za-z0-9_./-]*hooks)?)/?( |$)'
  # === 탐지기 자신을 지키는 arm (F65 1차 판정) ===
  # 분류 축은 "되돌릴 수 있는가" 하나가 아니라 **"자기를 복구할 수 있는가"**까지다.
  # protected-integrity.sh 는 파괴되면 자기를 복구할 수 없고, 티켓 파일은 복구 대상 판단의
  # 근거이므로 둘 다 컨트롤 플레인이다. 어떤 도구로 건드리든 물어본다.
  # basename으로 앵커한다 — 경로 표기(`cd progress && … >> .guarded-edits`·`progress//…`)로
  # 빠져나가던 것을 2차 판정이 실증했다. F-1에서 feature_list.json 에 이미 적용한 방식이다.
  # 명령행에 경로가 아예 없는 형태(`python3 script.py`)는 여전히 열려 있다 — 예측의 원리적
  # 한계이며 INV-14에 적었다. 티켓 파일은 셸을 쥔 상대에게 위조 불가능하지 않다.
  #
  # `evaluator-runs.jsonl`도 같은 arm에 넣는다(F65 4차 판정, step 12). 이 파일은
  # `progress/agent-comms/`에 있어 `is_protected()`(Edit/Write 경유)에는 이미 등록돼 있지만,
  # gitignore 대상이라 protected-integrity.sh(PostToolUse:Bash, HEAD 기준 사후 복구)의
  # 관할 밖이다 — INV-14/INV-15가 이미 명문화한 "gitignore 대상은 사후 복구가 성립하지 않고
  # 예측이 유일한 통제"인 정확히 그 클래스다. INV-11이 이 파일을 근거로 "evaluator가 실제로
  # 실행됐는가"를 판정하므로, Bash로 자유롭게 조작 가능하면 evaluator 실행 없이 로그를
  # 위조해 passes:true를 정당화할 수 있다(실측: Bash 직접 덮어쓰기·삭제가 allow였다).
  '[^;|&]*(protected-integrity\.sh|\.guarded-edits|\.integrity-baseline|evaluator-runs\.jsonl)'
  # git 메타 조작 — 파일을 바꾸지 않고 **탐지를 실명시킨다**. 도구 이름이 확정적이고
  # 정상 개발에서 거의 쓰지 않으므로 게이트해도 마찰이 없다.
  'git\b[^;|&]*update-index[^;|&]*(--assume-unchanged|--skip-worktree|--no-assume-unchanged)'
  'git\b[^;|&]*\brm\b[^;|&]*--cached'
  # 컨트롤 플레인 전용 에디터 arm (F65). 위 데이터 플레인 arm은 탐지·복구가 배선되면
  # 건너뛰지만 이 줄은 절대 건너뛰지 않는다 — hooks.json·settings*.json 을 바꾸면 탐지 훅의
  # 배선 자체를 끌 수 있고, settings.json 은 gitignore라 HEAD 복구도 불가능하다.
  '\b(ed|ex|vi|vim|nano|emacs|g?sed|g?awk|mawk|sponge|dd|patch)\b[^;|&]*(hooks(/\.?)+hooks\.json|\.claude(/\.?)+settings(\.local)?\.json)'
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
  # F73: perl만 남긴다(:339 주석과 같은 이유).
  '\bperl\b[^;|&]*-i[^;|&]*feature_list\.json'
  # F73: sed/awk 전용 in-place arm. 리터럴 `-i`는 `--in-place`도 부분문자열로 포함하므로
  # 별도 긴 옵션 arm이 필요 없다.
  '\b(g?sed|g?awk|mawk)\b[^;|&]*-i[^;|&]*feature_list\.json'
  '\bsed\b[^;|&]*\bw\b *[^;|&]*feature_list\.json'
  '\bof= *[^ ]*feature_list\.json'
  '\b(python3?|node|nodejs|ruby|perl|php|lua)\b[^;|&]*feature_list\.json'
  # F73: sed/g?awk/mawk을 위 이름 목록에서 뺀다 — 이름만으로 판정하는 이 arm은 :339와 같은
  # 이유로 in-place exemption과 충돌한다(sed 이름만으로 매치해 -i 유무와 무관하게 ask).
  # vim 등 나머지 에디터는 이름 자체로 쓰기 문법을 모르므로 계속 여기서 ask.
  # **범위 정정(F37 1차 판정 실측 지적)**: 순수 읽기(PURE_READ, Layer 3.4)만 영향받는 게
  # 아니다 — 이 arm이 이름만으로 sed/awk/mawk를 전부 잡던 것을 걷어내면서, in-place가 아닌
  # 형태(`awk -f prog.awk`·`sed -f script.sed`·`gawk -v out=… '{print>out}'` 등 파일/변수
  # 경유 쓰기)도 함께 ask→allow로 열렸다 — PURE_READ 판정과 무관하게 넓어진 것이라 앞선 서술은
  # 틀렸다. 이것을 새 위험군으로 보지 않는 근거: F71이 이미 이 파일에 `python3 -c
  # "open(...,'w')"` 류 무프롬프트 임의 쓰기를 허용하고 있고(INV-14가 그 경계를 명문화) 이
  # 형태들은 그 기존 경계 안의 다른 경로일 뿐이다 — 다만 이 클래스는 테스트로 고정돼 있지
  # 않다(후속 필요).
  '\b(ed|ex|vi|vim|nano|emacs|sponge|dd|patch)\b[^;|&]*feature_list\.json'
  # F73: 위에서 뺀 sed/awk/mawk의 이름 기반 자리 — 일반 데이터 플레인 arm(harness-config.json 등)의
  # 대응 arm과 동일하게 exemptable(도구 목록이 READ_CAPABLE_ARM과 같은 리터럴).
  '\b(g?sed|g?awk|mawk)\b[^;|&]*feature_list\.json'
  # F68(INV-12): 무인 중단 기록. invariant-guard는 Edit|Write만 후킹하므로 리다이렉트·복사·
  # 인터프리터·에디터로 큐를 비우는 bash 경로가 그대로 열려 있었다(1차 판정 실증).
  # 적립은 Edit|Write 경로에서 append-only 검사를 통과하면 되고, 여기서 막는 것은 셸로
  # 직접 덮어쓰는 형태다 — 그것이 중단 증거를 지우는 유일한 우회였다.
  '>>? *[^ ]*approval-queue\.json'
  '\b(cp|mv|install|rsync|ln|tee|sponge|truncate)\b[^;|&]*approval-queue\.json'
  '\b(python3?|node|nodejs|ruby|perl|php|lua)\b[^;|&]*approval-queue\.json'
  '\b(ed|ex|vi|vim|nano|emacs|g?sed|g?awk|mawk|sponge|dd|patch)\b[^;|&]*approval-queue\.json'
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
        # `env`·`command` 는 **접두 명령**이다 — 인자를 그대로 exec 한다. 이름만으로 읽기라
        # 판정하면 접두 한 단어로 ASK 계층 전체가 무력화된다(F67 F37 2차 판정 실측:
        # `env cp /tmp/x progress/feature_list.json`(INV-11 게이트) · `env python3 -c
        # "open('hooks/hooks.json','w')"`(이 방화벽의 배선) · `env git reset --hard` 가 전부
        # allow 였고, 접두를 떼면 셋 다 ask 다). `time` 과 같은 계열이므로 같은 자리에서
        # 벗겨 내고 **그 뒤**를 판정한다 — `env -i cp …` 처럼 옵션이 붙으면 아래 `*)` 로
        # 떨어져 읽기 확정에 실패하므로 ask 가 된다(보수적 방향).
        # 예외 하나: `command -v/-V` 는 실행하지 않고 경로만 출력하므로 그대로 읽기다.
        env | command)
          # `command -v/-V` 는 실행하지 않고 경로만 출력한다 — `true` 로 바꿔 읽기로 흘려보내되
          # **나머지 인자는 유지**해 리다이렉트 검사(`$seg` 안의 `>`)가 그대로 작동하게 한다.
          if [[ "$tok" == "command" && "$rest" =~ ^-[vV]([[:space:]]|$) ]]; then seg="true $rest"; continue; fi
          seg="$rest" ;;
        *) break ;;
      esac
    done
    [[ -z "${tok// /}" ]] && continue
    [[ "$tok" == "rtk" ]] && IFS=' ' read -r tok rest <<<"$rest"
    case "$tok" in
      # `env`·`command` 는 여기 없다 — 인자를 exec 하는 접두 명령이라 위 벗겨내기 분기가 담당한다.
      # 이 목록에 접두 명령이 들어오면 단어 하나로 ASK 계층 전체가 꺼진다(F67 F37 2차 판정 실측).
      # `tests/pre-bash-firewall.bats` 가 목록 자체를 검사해 재유입을 막는다.
      cat | head | tail | nl | wc | ls | stat | file | basename | dirname | realpath | readlink | shasum | sha1sum | sha256sum | md5 | md5sum | cmp | diff | grep | egrep | fgrep | rg | jq | cut | uniq | tr | column | rev | od | xxd | strings | which | type | date | test | echo | printf | pwd | true | false | cd | shellcheck | bats)
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
        # `-i`·결합 단축옵션(-ie·-ni)과 **장옵션 `--in-place`** 를 모두 배제한다. 단축옵션
        # 정규식은 `-` 다음에 바로 글자를 요구하므로 `--in-place` 를 놓친다(회귀 테스트가 검출).
        [[ "$seg" =~ (^|[[:space:]])-[a-zA-Z]*i ]] && return 1
        [[ "$seg" == *'--in-place'* ]] && return 1
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
        [[ "$seg" == *'--in-place'* ]] && return 1
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

# === Layer 3.3: 컨트롤 플레인 삭제 — 문자열 앵커가 아니라 경로 토큰으로 판정 (F65 AC-11/SC-9) ===
#
# 판정 순서: Layer 3.4(순수 읽기 면제)를 먼저 계산하고 → **이 게이트** → 그다음 ASK arm 루프.
# 순수 읽기로 확정된 명령(`grep rm <경로>` 처럼 동사가 인자로만 등장하는 것)은 여기서도 건너뛴다 —
# 화이트리스트가 첫 토큰이 리더임을 확인했으므로 그 명령은 지울 수 없다. ASK 루프보다 앞에 두는
# 이유는 이 판정이 arm 면제(Layer 3.5)와 무관하게 성립해야 하기 때문이다.
#
# ## 왜 이 자리를 정규식으로 두지 않는가
#
# 위 ASK 배열의 삭제 arm 들은 명령 **문자열**에서 `.claude`·`hooks/hooks.json` 같은 리터럴을
# 찾는다. 12차 판정이 그 방식의 반례를 실측했다 — 같은 대상에 도달하는 다른 표기가 전부 allow 였다:
#   `rm -rf .claude/*`(glob 이 토큰 종료 앵커를 깬다) · `rm --recursive .claude`(플래그 매처가
#   단문자만 본다) · `rm -rf '.claude'`(따옴표가 앵커를 깬다) · `rm -rf .claude;`(구분자).
# 표기를 하나 더 열거해 닫으면 다음 표기가 남는다 — F63 이 열 회전에 걸쳐 확인한 실패 형태다.
#
# 그래서 판정 축을 바꾼다: **명령에서 삭제 동사의 피연산자 토큰을 뽑아 정규화한 뒤 위치와 대조**한다.
# 따옴표 제거·`./` 정규화·`//` 접기·후행 `/` 절단·후행 글로브 절단을 거치고 나면 위 네 표기가
# 같은 토큰(`.claude`)으로 수렴한다. 플래그는 매칭 대상이 아니므로 `-rf` 든 `--recursive` 든
# 상관이 없다 — 12차 판정이 지적한 플래그 매처 자체가 사라진다.
#
# ## 무엇이 닫히지 않는가 (측정한 것만 적는다)
#
#  - `cd .claude && rm settings.json` — 경로 토큰이 명령에서 사라진다. 방화벽은 CMD 문자열만
#    보고 cwd 를 추적하지 않으므로 **문자열 예측으로는 닫을 수 없다.** 판정자도 같은 결론이었다.
#    잔여 위험으로 계약(`_residual_risk_AC11`)에 명시했다.
#  - `xargs rm < list.txt` 처럼 경로가 명령문에 없는 간접 삭제, `$(...)`·백틱으로 만들어 낸 경로.
#  - 여기 적힌 동사(`rm`·`rmdir`·`unlink`·`shred`·`mv`·`find -delete`) 밖의 삭제 수단.
# 이번 변경이 확인한 것은 **위 배터리(tests/pre-bash-firewall.bats 의 표기 변형 배터리)가
# 통과한다**는 것뿐이다. 열거가 수렴했다는 주장은 하지 않는다 — 12차 판정이 정확히 그 주장을
# 반증했고, 같은 문장을 다시 쓰는 것이 F63·F67 에서 반복된 실패다.

# 토큰 하나를 셸이 보는 형태에 가깝게 정규화한다. 결과는 NORM_TOK — 토큰마다 서브셸을 띄우지 않는다.
NORM_TOK=""
normalize_path_token() {
  local t="$1" sl='/' dsl='//' dot='/./'
  # **ANSI-C/로케일 인용(`$'...'`/`$"..."`)은 여기서 디코딩하지 않는다 — 9차 판정 반려로
  # 되돌린 설계다.** 8차 판정 대응으로 한 번 시도했었다: `printf %b` 로 "bash 자신의
  # 이스케이프 표를 빌린다"고 적었는데, 그 전제가 틀렸다 — `%b` 의 표는 `$'...'` 의 표와
  # 다르고, bash 버전마다도 다르며, **이 훅을 실행하는 셸의 표와도 다르다**(9차 판정이 이
  # 세션의 실행 셸이 zsh 임을 `ps -p $$ -o comm=` 로 직접 확인했다). 그 불일치가 세 갈래
  # 반례를 냈다: `\c`(zsh 는 리터럴로 두는데 `%b` 는 출력을 끊는다) · `\u`/`\U`(bash 3.2 의
  # `%b` 가 지원하지 않는다) · 빈 콘텐츠(`printf -v v '%b' ""` 가 bash 3.2 에서 변수를 아예
  # 만들지 않아 `set -u` 로 훅 전체가 죽는다 — ASK_PATTERNS 전체가 판정 없이 사라졌다).
  # 재구현을 시도할 때마다 표가 하나씩 어긋난다는 것이 정확히 F63/F65 가 반복 확인한
  # "명령 문자열로 실제 값을 확정하는 것은 결정 불가능하다"의 또 다른 얼굴이다.
  # 그래서 여기서 펴려 하지 않는다 — `\$'`/`\$"` 존재 자체를 삭제 문맥에서 fail-closed
  # 신호로 쓴다(scan_control_plane_delete() 참조, 세그먼트에 이 토큰이 하나라도 있으면
  # 펴 보지 않고 바로 ask). 이 함수는 일반 따옴표만 제거한다 — `$'...'` 를 거치지 않은
  # 나머지 정규화(`.//`·`../`·후행 `/`)는 그대로 유지된다.
  t=${t//\'/}; t=${t//\"/}; t=${t//\\/}          # 따옴표·백슬래시 제거 (`'.claude'`·`\rm`)
  while [[ "$t" == *"$dsl"* ]]; do t=${t//"$dsl"/"$sl"}; done
  while [[ "$t" == *"$dot"* ]]; do t=${t//"$dot"/"$sl"}; done
  # 내부 `..` 세그먼트를 접는다(F65 8차 판정 반려) — 2차 판정부터 열려 있던 축이다. `a/../`
  # 는 a로 들어갔다 나오는 것과 같아 통째로 지워진다. 앞쪽에 남는 `../`(상위로 나가는 참조,
  # `../.claude`)는 접지 않는다 — 그 위가 무엇인지 문자열만으로 알 수 없다. 캡처는 세그먼트
  # 이름만 받는다(`([^/]+)/\.\./ `) — 전체 매치를 `../`와 문자열 비교하면 `../../` 처럼 세그먼트
  # 자체가 `..`로 시작하는 경우를 놓친다(자체 발견: 최초 버전이 정확히 이 형태로 뚫렸다).
  local __dd_seg __dd_whole
  while [[ "$t" =~ ([^/]+)/\.\./ ]]; do
    __dd_seg="${BASH_REMATCH[1]}"
    [[ "$__dd_seg" == ".." ]] && break
    # 치환 패턴은 **별도 변수에 먼저 담는다**(F65 8차 판정 재작업 중 자체 발견 — 판정 대상은
    # 아니었다). `t="${t/"$seg/../"/}"` 처럼 따옴표 안에서 변수와 리터럴을 바로 이어 쓰면
    # bash 3.2(이 훅이 실제로 실행되는 macOS 기본 셸)에서 패턴이 깨져 아무것도 지우지 못한다
    # (실측: 결과가 `../"//../"//../settings.json` 같은 쓰레기 문자열이 됐다 — bash 5.3에서는
    # 같은 코드가 문제없이 동작해 이 결함을 처음엔 놓쳤다). `whole="${seg}/../"` 로 먼저
    # 완성한 뒤 그 변수를 패턴 자리에 쓰면 두 버전 모두에서 동일하게 동작한다.
    __dd_whole="${__dd_seg}/../"
    t="${t/"$__dd_whole"/}"
  done
  while [[ "$t" == ./* ]]; do t=${t#./}; done
  while [[ "$t" == */ && ${#t} -gt 1 ]]; do t=${t%/}; done
  NORM_TOK="$t"
}

# 정규화된 토큰이 컨트롤 플레인 위치인가 (0 = 그렇다).
# 대상은 열거가 아니라 **구조적 위치**다: 배선 파일 자신, 그 파일을 담는 `.claude` 하위 디렉터리,
# 그리고 실제로 배선을 담고 있는 `hooks/` 디렉터리.
CONTROL_PLANE_NAMES=(
  # 글로브 토큰이 이 이름들 중 하나를 덮을 수 있으면 컨트롤 플레인 삭제로 본다(아래 설명 참조).
  '.claude'
  '.claude/settings.json'
  '.claude/settings.local.json'
  '.claude/hooks'
  '.claude/plugins'
  'hooks/hooks.json'
)
# BRACE_R_*(위 __brace_range_info 가 채움)로 인덱스 $1(0-based) 번째 값을 만든다.
__brace_range_value() {
  local idx="$1" v
  v=$((BRACE_R_START + idx * BRACE_R_STEP * BRACE_R_DIR))
  if [[ "$BRACE_R_ALPHA" == 1 ]]; then
    printf "\\$(printf '%03o' "$v")"
  elif [[ "$BRACE_R_PAD" -gt 0 ]]; then
    local av=$v neg=""
    [[ $v -lt 0 ]] && { av=$((-v)); neg="-"; }
    printf '%s%0*d' "$neg" "$BRACE_R_PAD" "$av"
  else
    printf '%d' "$v"
  fi
}

# $1(콤마 없는 그룹 본문)이 bash 의 범위 확장(`{X..Y}`·`{X..Y..S}`)인지 판정한다(F65 6차
# 판정 반려 반영 — `.clau{d..d}e` 처럼 시작=끝인 **퇴화 범위**도 실제 bash 는 펴서 한 값을
# 낸다, 직접 확인: `echo {d..d}` → `d`. "콤마 없으면 리터럴"은 범위에는 성립하지 않았다).
# 성공하면 BRACE_R_START/END/STEP/DIR/PAD/ALPHA/COUNT 를 채우고 0. 실패(범위가 아님)면 1 —
# 그러면 몸통이 콤마도 `..` 도 없는 **진짜** 리터럴인지, 아니면 `..` 는 있으나 이 함수가 다루는
# 깔끔한 형태(정수-정수 또는 단일문자-단일문자, 선택적 정수 step)가 아닌 **알 수 없는** 형태인지는
# 호출자(`__brace_find_group`)가 `..` 존재 여부로 가른다 — 후자는 안전한 쪽(ask)으로 둔다.
# 숫자 자릿수를 15 자로 제한한다 — bash 정수는 64비트라 그 이상은 조용히 오버플로해 산술이
# 틀린 값을 낸다(실측: `{1..99999999999999999999}` 가 겉보기엔 안 죽고 계산되지만 값이
# 틀리다). 그 상황에서 "안전해 보이는 작은 카운트"로 잘못 계산되면 예산 검사가 무력화된다 —
# 자릿수 제한이 있으면 이런 입력은 애초에 범위로 인식되지 않아 suspicious(ask)로 떨어진다.
__brace_range_info() {
  local body="$1"
  local re_num='^(-?[0-9]+)\.\.(-?[0-9]+)(\.\.([0-9]+))?$'
  local re_alpha='^([A-Za-z])\.\.([A-Za-z])(\.\.([0-9]+))?$'
  if [[ "$body" =~ $re_num ]]; then
    local s="${BASH_REMATCH[1]}" e="${BASH_REMATCH[2]}" st="${BASH_REMATCH[4]:-1}"
    local sdig="${s#-}" edig="${e#-}"
    [[ ${#sdig} -gt 15 || ${#edig} -gt 15 || ${#st} -gt 15 ]] && return 1
    [[ "$st" == "0" ]] && return 1   # step 0 은 bash 에서도 정의되지 않은 형태
    BRACE_R_PAD=0
    if [[ "$sdig" == 0[0-9]* || "$edig" == 0[0-9]* ]]; then
      BRACE_R_PAD=${#sdig}
      [[ ${#edig} -gt $BRACE_R_PAD ]] && BRACE_R_PAD=${#edig}
    fi
    BRACE_R_START=$((s)); BRACE_R_END=$((e)); BRACE_R_STEP=$((st)); BRACE_R_ALPHA=0
    BRACE_R_DIR=1; [[ $BRACE_R_START -gt $BRACE_R_END ]] && BRACE_R_DIR=-1
    BRACE_R_COUNT=$(( ( (BRACE_R_END - BRACE_R_START) * BRACE_R_DIR / BRACE_R_STEP ) + 1 ))
    return 0
  fi
  if [[ "$body" =~ $re_alpha ]]; then
    local s="${BASH_REMATCH[1]}" e="${BASH_REMATCH[2]}" st="${BASH_REMATCH[4]:-1}"
    [[ ${#st} -gt 15 ]] && return 1
    [[ "$st" == "0" ]] && return 1
    BRACE_R_START=$(printf '%d' "'$s")
    BRACE_R_END=$(printf '%d' "'$e")
    BRACE_R_STEP=$((st)); BRACE_R_PAD=0; BRACE_R_ALPHA=1
    BRACE_R_DIR=1; [[ $BRACE_R_START -gt $BRACE_R_END ]] && BRACE_R_DIR=-1
    BRACE_R_COUNT=$(( ( (BRACE_R_END - BRACE_R_START) * BRACE_R_DIR / BRACE_R_STEP ) + 1 ))
    return 0
  fi
  return 1
}

# $1 전체를 **한 번만** 훑어 모든 `{`의 짝(있으면)을 스택으로 계산한다(F65 7차 판정 반려,
# Class E). 이전 구현은 `__brace_find_group()` 안에서 "짝을 못 찾으면 다음 `{`부터 끝까지
# 다시 스캔"을 반복했다 — 짝 없는 `{`가 N개면 O(n²)이다(실측: 열린 중괄호 600개가 훅
# 타임아웃(5초)을 넘는 5.26초, 4096자 상한 지점에서는 517초). 스택 기반 단일 패스는 문자
# 하나당 O(1) 작업만 하므로 총 O(n)이다 — bash 3.2 에는 연관배열이 없어(이 훅이 실행되는
# 실제 환경, `/bin/bash --version` 확인됨) 열린 위치를 **인덱스로 쓰는 일반 배열**
# MATCHCLOSE 에 닫힌 위치를 담는다(성긴 배열 대입은 3.2 에서도 된다).
__brace_prescan() {
  local t="$1"
  local n=${#t} k=0 c sp=0
  local -a stack=()
  MATCHCLOSE=()
  while [[ $k -lt $n ]]; do
    c="${t:k:1}"
    if [[ "$c" == '{' ]]; then
      stack[$sp]=$k; sp=$((sp+1))
    elif [[ "$c" == '}' && $sp -gt 0 ]]; then
      sp=$((sp-1)); MATCHCLOSE[${stack[$sp]}]=$k
    fi
    k=$((k+1))
  done
}

# $1 에서 **콤마 또는 범위를 담은, 균형 잡힌** 첫 중괄호 그룹을 찾는다(F65 5·6차 판정 반려 반영).
# 콤마도 `..` 도 없는 바깥 그룹은 실제 bash 에서도 리터럴이다 — `echo {a{b,c}}` 는 `{ab} {ac}` 를
# 낸다(바깥 `{`·`}` 는 글자 그대로 남고 안쪽 `{b,c}` 만 펴진다, 직접 확인). 그래서 바깥에서
# 안쪽으로 **점점 좁혀가며** 확장 가능한 그룹을 찾는다 — 첫 번째 시도에서 콤마도 `..` 도 없으면
# 그 `{` 를 리터럴로 치고 바로 다음 `{` 부터 다시 찾는다. 짝은 위 __brace_prescan() 이 미리
# 계산해 둔 것을 O(1)로 조회한다(5차 판정이 실측한 우회 — `{.claude,{x,y}}` — 는 짝을 "첫
# `}`"로 끊어 안쪽 그룹과 뒤섞인 결과였다 — 스택 기반 계산은 깊이를 정확히 추적하므로 같은
# 결함이 재발하지 않는다).
# 성공하면 BRACE_PRE/BRACE_BODY/BRACE_POST/BRACE_KIND(comma|range|suspicious) 를 채우고 0,
# 확장 가능한(또는 확장 여부가 불확실한) 그룹이 아예 없으면 1.
__brace_find_group() {
  local t="$1"
  # 주의: `n=${#t}` 를 위 선언과 같은 `local` 문에 두면 안 된다 — bash 는 그 우변을 t 가
  # 아직 이 스코프에 대입되기 **전**에 평가한다. set -u 라서 t 가 아무 데도 없으면 즉시
  # 죽지만, 호출자 스코프에 우연히 같은 이름 t 가 남아 있으면 **그 값으로 조용히 계산되는**
  # 쪽이 더 위험하다(실측: __control_plane_location_impl 이 같은 이름 t 를 갖고 있어 이
  # 형태로도 우연히 통과했었다 — 이름이 겹치지 않았다면 늘 죽었을 것이다).
  local n=${#t} start=0 i j c body bn k has_comma
  __brace_prescan "$t"
  while :; do
    i=-1; k=$start
    while [[ $k -lt $n ]]; do [[ "${t:k:1}" == '{' ]] && { i=$k; break; }; k=$((k+1)); done
    [[ $i -ge 0 ]] || return 1
    if [[ -z "${MATCHCLOSE[$i]+x}" ]]; then start=$((i+1)); continue; fi   # 짝 없음 — 리터럴, 다음 `{` 로
    j=${MATCHCLOSE[$i]}
    body="${t:i+1:j-i-1}"; bn=${#body}
    # 콤마 유무만 보지 않고 **개수까지** 센다(끝까지 스캔) — F65 6차 판정 부수 지적: 콤마를
    # 찾자마자 멈추면 항목 개수를 모른 채 __brace_split_top_level() 로 배열을 통째로 만들게
    # 되는데, 그 배열 생성 자체가 예산 확인보다 **먼저** 일어난다. 콤마 하나짜리 그룹은
    # 무해하지만 한 그룹 안에 콤마가 수만 개면(`{x1,x2,...,x10000}`) 배열 생성 자체가 이미
    # 무겁다(실측: 1만 콤마가 9.4초). 개수를 먼저 O(길이)로 세 두면 예산 확인이 배열 생성
    # **전에** 일어날 수 있다(아래 range 분기와 같은 패턴).
    has_comma=0; depth=0; k=0
    while [[ $k -lt $bn ]]; do
      c="${body:k:1}"
      if [[ "$c" == '{' ]]; then depth=$((depth+1))
      elif [[ "$c" == '}' ]]; then depth=$((depth-1))
      elif [[ "$c" == ',' && $depth -eq 0 ]]; then has_comma=$((has_comma+1)); fi
      k=$((k+1))
    done
    if [[ $has_comma -gt 0 ]]; then
      BRACE_PRE="${t:0:i}"; BRACE_BODY="$body"; BRACE_KIND=comma
      BRACE_POST="${t:j+1}"; BRACE_COMMA_COUNT=$((has_comma+1))
      return 0
    fi
    # 콤마가 없다 — 범위인지 본다(F65 6차 판정: 콤마 없다고 곧장 리터럴로 단정한 것이 반려
    # 사유였다). `..` 가 아예 없으면 bash 문법상 범위일 수 없으므로 진짜 리터럴이다.
    if [[ "$body" == *..* ]]; then
      BRACE_PRE="${t:0:i}"; BRACE_BODY="$body"; BRACE_POST="${t:j+1}"
      if __brace_range_info "$body"; then BRACE_KIND=range; else BRACE_KIND=suspicious; fi
      return 0
    fi
    start=$((i+1))   # 콤마도 `..` 도 없다 — 진짜 리터럴이다, 안쪽에서 계속 찾는다
  done
}

# $1(그룹 본문)을 **최상위(깊이 0) 콤마** 기준으로 나눠 BRACE_ITEMS 배열에 담는다.
# 중첩된 그룹 안의 콤마는 분리 지점이 아니다 — `a,{b,c}` 는 2개(`a`·`{b,c}`)로 나뉜다.
__brace_split_top_level() {
  local body="$1"
  local n=${#body} depth=0 k=0 c cur=""   # 위 함수와 같은 이유로 별도 local 문 — 자기참조 회피
  BRACE_ITEMS=()
  while [[ $k -lt $n ]]; do
    c="${body:k:1}"
    if [[ "$c" == '{' ]]; then depth=$((depth+1)); cur+="$c"
    elif [[ "$c" == '}' ]]; then depth=$((depth-1)); cur+="$c"
    elif [[ "$c" == ',' && $depth -eq 0 ]]; then BRACE_ITEMS+=("$cur"); cur=""
    else cur+="$c"
    fi
    k=$((k+1))
  done
  BRACE_ITEMS+=("$cur")
}

__control_plane_location_impl() {
  local t="$1" rest pd cand base
  # **재귀할 때마다 다시 정규화한다 (F65 7차 판정 반려, Class C).** 호출자(scan_control_plane_
  # delete)는 원본 토큰 하나에만 normalize_path_token()을 한 번 부른다 — 중괄호 확장이 만드는
  # 후보 문자열(`.claude/` + `.` + `/settings.json` = `.claude/./settings.json`)은 그 정규화를
  # 한 번도 거치지 않는다. `//`·`/./`·후행 `/`가 남으면 (a)/(b)/(c) 의 정확 일치 case 문이
  # 매치하지 못한다(실측: `rm -rf {.claude/,zz}` → `.claude/` 가 그대로 남아 allow, 실제로는
  # `.claude` 그 자체다). normalize_path_token 은 중괄호를 건드리지 않으므로 몇 번을 다시
  # 불러도 안전하다(멱등) — 매 재귀 진입점에서 다시 부른다.
  normalize_path_token "$t"; t="$NORM_TOK"
  # 길이 상한을 **모든** 토큰에 건다(F65 8차 판정 반려) — 중괄호가 있는 토큰만 걸던 이전
  # 버전은 틀린 전제 위에 있었다: "중괄호 없는 토큰은 __brace_prescan() 을 안 타니 안전하다"고
  # 봤는데, 실측해 보니 아래 (b)/(c) 분기의 `${t##*/}`·`${t##*.claude/}` 류 와일드카드 파라미터
  # 확장(추출)이 **이 bash에서 매칭 성공 여부와 무관하게 문자열 길이에 대해 이차식**이었다 —
  # 중괄호가 있든 없든 똑같이 느리다(실측: 6만자 문자열 1회 추출에 4.3~5.0초, 훅 타임아웃
  # 5초 근처/초과). 그래서 상한을 브레이스 분기 안이 아니라 여기, 진입점 전체에 건다.
  if [[ ${#t} -gt 512 ]]; then return 0; fi
  # **중괄호 확장을 먼저 편다 (F65 4차 판정 step 10, 5차 판정이 중첩·폭발 결함을 반려해 재작업).**
  # 셸은 명령을 실제로 실행할 때만 `{a,b}` 를 펼친다 — 우리는 문자열만 파싱하므로 `.claude/
  # {settings.json,hooks}` 가 아래 어떤 case 문에도 매치하지 않는 통짜 토큰으로 들어온다.
  # 정규화가 아니라 여기서 여는 이유: 정규화(`normalize_path_token`)는 토큰 하나를 문자열
  # 하나로 축약하는데, 중괄호는 토큰 하나가 **여러** 후보로 갈라지는 경우라 그 함수의 계약
  # (1 in → 1 out)과 안 맞는다.
  #
  # **폭발 상한 (5차 판정 반려 사유 2).** 순차로 이어진 콤마 그룹은 곱으로 늘어난다 — N 개면
  # 최악 2^N 경로다. 완전 전개는 대상과 무관하게 대상 판정 자체를 얼릴 수 있다(훅 타임아웃은
  # 5초인데 N=16 이 22.7초 걸렸다, 실측). 그래서 이 토큰 하나가 쓸 수 있는 "그룹 처리 예산"을
  # 두고, 소진되면 **펴는 것을 멈추고 안전한 쪽(ask)으로 즉시 반환**한다 — 대상이 컨트롤
  # 플레인인지 끝까지 확인하지 못했다는 뜻이므로, 모르면 allow 가 아니라 ask 다. 이 반환은
  # 즉시 호출 스택을 타고 위로 전파되어(부모의 `if ...; then return 0` 가 첫 성공에 바로
  # 멈춘다) 남은 형제 분기를 펴지 않는다 — 그래서 예산을 넘긴 뒤의 총 작업량도 예산에
  # 비례해 유계다(지수가 아니다). 대가: 컨트롤 플레인과 무관한데 그룹이 매우 많은(수십 개)
  # 명령도 이 상한에 걸리면 ask 로 뜬다 — 실제 명령에서 그런 형태는 나타나지 않는다는 것과
  # 맞바꾼 승인된 트레이드오프다(5차 판정 권고).
  case "$t" in
    *'{'*)
      # 길이 상한은 위(진입점)에서 이미 걸었다 — __brace_prescan()/__brace_find_group() 도
      # 문자 단위 스캔이라 같은 이차식 비용을 받으므로 별도로 다시 걸 필요가 없다.
      if __brace_find_group "$t"; then
        # BRACE_PRE/BRACE_POST 를 즉시 지역 변수로 복사한다 — 전역이라 아래 재귀 호출(중첩
        # 그룹을 만나면 __brace_find_group 을 다시 부른다)이 이 루프가 두 번째 이후 item 에
        # 쓰려는 값을 덮어쓴다. 복사 없이 `${BRACE_PRE}${item}${BRACE_POST}` 를 루프 안에서
        # 직접 읽으면, 첫 item 처리 중 재귀가 전역을 갈아치운 뒤 두 번째 item 은 엉뚱한
        # pre/post 로 재구성돼 실제로 위험한 대안을 놓친다(실측: `{a{p,q},.claude}/
        # settings.json` — 실제 bash 는 `.claude/settings.json` 을 포함해 세 단어로 펴는데,
        # 이 복사가 없으면 `.claude` 앞에 이전 분기의 pre(`a`)가 섞여 `a.claude/settings.json`
        # 으로 재구성되어 allow 로 샜다).
        local pre="$BRACE_PRE" post="$BRACE_POST"
        case "$BRACE_KIND" in
          suspicious)
            # `..` 는 있는데 이 코드가 인식하는 깔끔한 범위 형태(정수-정수·단일문자-단일문자,
            # 선택적 정수 step)가 아니다 — 무엇으로 펴지는지 모른다. F65 6차 판정의 교훈대로
            # "못 펴면 안전"이라고 단정하지 않는다 — 모르면 안전한 쪽(ask).
            return 0
            ;;
          range)
            # 카운트는 산술로 먼저 구했다(__brace_range_info, O(1)) — 실제 값을 만들기 전에
            # 예산부터 확인해야 `{1..999999999}` 류가 배열을 만들다 멈추지 않는다.
            __BRACE_BUDGET=$((__BRACE_BUDGET - BRACE_R_COUNT))
            if [[ $__BRACE_BUDGET -lt 0 ]]; then return 0; fi
            local ridx=0 rval
            while [[ $ridx -lt $BRACE_R_COUNT ]]; do
              rval=$(__brace_range_value "$ridx")
              if __control_plane_location_impl "${pre}${rval}${post}"; then return 0; fi
              ridx=$((ridx+1))
            done
            return 1
            ;;
          comma)
            # 예산은 배열을 만들기 **전에** 확인한다 — range 분기와 같은 이유다. 콤마 개수는
            # __brace_find_group() 이 이미 세어 뒀으므로(BRACE_COMMA_COUNT) 여기서 다시 셀
            # 필요가 없고, `__brace_split_top_level()`(배열 생성)은 예산 통과 후에만 부른다.
            __BRACE_BUDGET=$((__BRACE_BUDGET - BRACE_COMMA_COUNT))
            if [[ $__BRACE_BUDGET -lt 0 ]]; then return 0; fi
            __brace_split_top_level "$BRACE_BODY"
            local item
            for item in "${BRACE_ITEMS[@]+"${BRACE_ITEMS[@]}"}"; do
              if __control_plane_location_impl "${pre}${item}${post}"; then return 0; fi
            done
            return 1
            ;;
        esac
      fi
      # 콤마도 범위도 없다 — 중괄호가 전부 리터럴이다(예: `{.claude}`·`hooks/{hooks.json}`,
      # 실제 bash 도 펴지 않는다, 직접 확인). 정규화·글로브·경로 판정으로 그대로 떨어진다.
      ;;
  esac
  # 후행 글로브는 **그 디렉터리 안**을 비운다 — 디렉터리로 접어 판정한다(`rm -rf dir/*`).
  #
  # **F65 6차 판정 반려: 이 접기는 중괄호 확장이 끝난 뒤(여기)에서 해야 한다.** 예전에는
  # `scan_control_plane_delete()` 가 이 접기를 중괄호 처리보다 **먼저** 했다 — `{.claude/*,x}`
  # 같은 토큰에서 마지막 `/` 뒤 꼬리(`*,x}`)에 글로브 문자가 있다고 보고 그 앞을 잘라
  # `{.claude` 라는 깨진 토큰을 만들었고, 그 반쪽짜리 중괄호는 다음 단계에서 짝을 찾지 못해
  # 리터럴로 떨어져 결국 아무 것도 매치하지 않았다(격리 랩 실측: `.claude/settings.json`·
  # `.claude/hooks`·`hooks/hooks.json` 이 실제로 지워졌다). 접기를 여기(중괄호 확장이 이미
  # 끝나 `$t` 에 미확정 중괄호가 남아있지 않은 지점)로 옮기면, 콤마/범위 확장으로 나온 각
  # 후보 문자열(`.claude/*` 등) 위에서 접기가 실행되어 `.claude` 를 올바르게 되찾는다.
  base=${t##*/}
  case "$base" in
    *'*'*|*'?'*|*'['*)
      if [[ "$t" == */* ]]; then t=${t%/*}; fi
      ;;
  esac
  # 글로브가 남은 토큰 — 셸이 무엇으로 펼칠지 실행 전에는 모른다. 그래서 **패턴이 컨트롤 플레인
  # 이름을 덮을 수 있는가**를 본다(`rm -rf .clau*` 는 `.claude` 를 덮는다 — 이 라운드의 자체
  # 프로브가 잡은 반례다). `dir/<패턴>` 형태는 이 지점에 오기 전에 디렉터리로 접히므로 여기 남는
  # 것은 이름 자체가 패턴인 경우뿐이다 — `dist/*`·`node_modules/*` 에 마찰이 없는 이유다.
  case "$t" in
    *'*'*|*'?'*|*'['*)
      for cand in "${CONTROL_PLANE_NAMES[@]}"; do
        # shellcheck disable=SC2053  # 오른쪽이 패턴이다 — 토큰이 그 이름을 덮는지 본다
        if [[ "$cand" == $t ]]; then return 0; fi
      done
      # shellcheck disable=SC2053
      if [[ "hooks" == $t ]]; then
        pd="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
        if [[ -f "${pd%/}/hooks/hooks.json" ]]; then return 0; fi
      fi
      ;;
  esac
  # (a) 배선 파일 자신
  case "$t" in
    hooks/hooks.json|*/hooks/hooks.json) return 0 ;;
    .claude/settings.json|*/.claude/settings.json) return 0 ;;
    .claude/settings.local.json|*/.claude/settings.local.json) return 0 ;;
  esac
  # (b) `.claude` 를 성분으로 갖는 경로 — 그 뒤에 남는 꼬리로 판정한다.
  #     꼬리가 비었거나(`.claude`), 플러그인 설치 루트(`plugins`·`plugins/<이름>`)이거나,
  #     `hooks` 로 끝나면(`\.claude/**/hooks`) 그 디렉터리를 지우는 것이 배선을 지우는 것이다.
  #     `.claude/worktrees/…` 처럼 다른 꼬리가 남으면 발동하지 않는다 — 일상 정리에 마찰을 만들지 않는다.
  case "$t" in
    .claude|*/.claude) return 0 ;;
    .claude/*|*/.claude/*)
      rest=${t##*.claude/}
      case "$rest" in
        plugins) return 0 ;;
        plugins/*) if [[ "${rest#plugins/}" != */* ]]; then return 0; fi ;;
      esac
      case "$rest" in
        hooks|*/hooks) return 0 ;;
        # F65 4차 판정, step 11: 디렉터리 자체(위)뿐 아니라 그 **안의 개별 훅 파일**도 잡는다.
        # 같은 경로(`.claude/hooks/invariant-guard.sh` 등)에 대한 **쓰기**는 이미 F73의
        # in-place arm이 ask로 막는데 **삭제**만 빠져 있었다(실측: `rm .claude/hooks/
        # invariant-guard.sh` allow, 같은 파일 `echo > ...` 는 ask — 대칭이 깨져 있었다).
        # `.sh` 로 한정한다 — 확장자 없이 `hooks/*` 전부를 잡으면 `.claude/**/hooks/README.md`
        # 처럼 컨트롤 플레인과 무관한 파일까지 걸려 과잉차단이 된다.
        hooks/*.sh|*/hooks/*.sh) return 0 ;;
      esac
      ;;
  esac
  # (c) 배선을 담고 있는 `hooks/` 디렉터리.
  #     **이름이 아니라 실체로 앵커한다.** 12차 판정 지적: 이름만 보면 `rm -rf src/hooks` 처럼
  #     무관한 프로젝트 코드까지 걸린다(cc-harness 는 다른 저장소에 설치되는 플러그인이고
  #     React/Vue 계열에서 `src/hooks` 는 흔한 이름이다). 걸어야 하는 것은 세 자리뿐이다 —
  #     플러그인 설치 루트, 프로젝트 루트, 그리고 실제로 `hooks.json` 을 담고 있는 디렉터리.
  case "$t" in
    hooks|*/hooks)
      if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && "$t" == "${CLAUDE_PLUGIN_ROOT%/}/hooks" ]]; then return 0; fi
      pd="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
      pd="${pd%/}"
      if [[ "$t" == "$pd/hooks" ]]; then return 0; fi
      # 상대 토큰은 cwd 를 알 수 없다 — 그 자리에 배선 파일이 실제로 있을 때만 잡는다.
      if [[ "$t" == "hooks" && -f "$pd/hooks/hooks.json" ]]; then return 0; fi
      if [[ -f "$t/hooks.json" ]]; then return 0; fi
      ;;
  esac
  return 1
}

# 공개 진입점 — 토큰 하나를 판정할 때마다 중괄호 확장 예산을 새로 채운다. 재귀 호출
# (`__control_plane_location_impl`)은 이 예산을 공유해야 상한이 의미가 있으므로 이 함수를
# 다시 부르지 않는다 — 재귀마다 다시 채우면 상한이 매 분기에서 리셋돼 무력해진다.
control_plane_location() {
  __BRACE_BUDGET=64
  __control_plane_location_impl "$1"
}

# $1 을 토큰으로 나눈다(SPLIT_TOKS) — 따옴표·백슬래시를 **하나의 상태 기계**로 함께
# 추적한다(F65 11차 판정 반려로 재설계). 9·10차는 이 일을 두 개의 독립된 스캐너
# (__quote_aware_split·__has_real_dollar_quote)로 나눠 했는데, **둘 다 백슬래시를 몰랐다**
# — `normalize_path_token()`은 백슬래시를 지우는데, 이 두 스캐너는 백슬래시를 평범한
# 글자처럼 취급해 `\"` 를 "이스케이프된 리터럴 따옴표"가 아니라 "따옴표 문자 자체"로
# 잘못 셌다. 그러면 인용부호 상태가 실제 셸과 어긋나기 시작하고(짝이 하나씩 밀린다), 그
# 어긋난 상태 안에서 진짜 `$'...'` 이 "이미 열린 따옴표 안"으로 잘못 보여 검출을 피해간다
# — 격리 랩에서 zsh·bash 5.3·bash 3.2 전부 45가지 형태로 `.claude` 삭제까지 실증됐다
# (`rm -rf "\"" $'.claude'` 가 대표 사례).
#
# **원칙 전환(11차 판정 권고 채택, 12차 판정으로 스코프 수정)**: "위험한 표기를 하나씩
# 열거해 막는" 대신 "이 스캐너가 확실히 이해하는 형태(작은따옴표·큰따옴표·그 안팎의 백슬래시
# 이스케이프)가 아니면 펴 보지 않고 ask" 로 바꾼다. ANSI-C/로케일 인용(`$'`·`$"`)과 세그먼트
# 끝에서 안 닫힌 따옴표는 **무장(armed) 여부와 무관하게** 그 즉시 UNSAFE 로 반환한다 — 삭제
# 동사 자체를 `$'rm'` 처럼 위장하면 armed 판정 전에 걸러야 하고(9차 판정이 이미 실증), 이
# 표기를 잡아 주는 다른 층이 없다. 실제 셸도 안 닫힌 인용부호는 구문 오류로 거부하므로(직접
# 확인: `bash -c 'echo "x'` → 파싱 오류), 이 경우 ask 는 실행되지도 않을 명령에 대한 무해한
# 마찰이거나, 이 스캐너 자신이 어딘가에서 다시 어긋났다는 신호 둘 중 하나다.
#
# **명령 치환(`` ` ``·`$(`)은 11차 판정 반려 당시 같은 취급을 받았으나(무조건 UNSAFE), 12차
# 판정에서 회귀 테스트 2건("git commit -m \"...`code`...\"", "ls $(pwd)")으로 반려됐다** —
# 삭제 동사가 전혀 없는 세그먼트까지 막아, 11차 자신이 지적한 "과잉차단 회귀"를 오히려
# 더 넓혔다. 명령 치환은 두 층이 이미 나눠 맡는다: (1) 치환 **안에** 위험 동사가 리터럴로
# 있으면 Layer 2 INDIRECT_PATTERNS 가 이 함수보다 먼저 deny 한다(`` `rm ...` ``·`$(...rm...)`).
# (2) 치환이 **피연산자**를 만들어내는 경우(`rm $(cat list)`)는 `indirect_operand` 로
# `progress/contracts/sprint-51.json`의 `open_axes_2026_08_04`에 이미 선언된 수용 잔여
# 위험이다 — 경로가 명령문에 리터럴로 없으면 예측 계층은 원리적으로 그 값을 알 수 없다.
# 남는 몫은 "동사는 리터럴인데 피연산자 자리에 치환이 있어 그 값을 확정 못 하는" 경우뿐이고,
# 그건 **무장된 세그먼트에서만** 위험하다 — 그래서 백틱·`$(`는 즉시 UNSAFE 로 반환하지
# 않고 `SEGMENT_HAS_OPAQUE` 플래그만 세운 채 안전하게 건너뛰어 토큰화를 계속하고,
# `scan_control_plane_delete()` 가 armed 확정 후 이 플래그를 함께 본다(아래 참조).
#
# 백슬래시 규칙(직접 확인한 실제 bash 동작): 작은따옴표 안에서는 백슬래시가 전혀 특별하지
# 않다(`'a\b'` → `a\b`). 큰따옴표 안에서는 `\$`·`` \` ``·`\"`·`\\` 만 그 다음 글자를
# 이스케이프하고(예: `"a\$X"` → `a$X`, 변수 확장 안 됨) 그 외(`\z`)는 백슬래시까지 그대로
# 남는다(`"a\zb"` → `a\zb`). 따옴표 밖에서는 백슬래시가 다음 글자 하나를 무조건 리터럴로
# 만든다(`a\"b` → `a"b`, 새 인용을 열지 않는다 — 라운드 10 우회의 정확한 메커니즘).
# 백틱 쌍의 짝을 찾는다 — $2 는 여는 백틱의 인덱스. 안쪽 내용은 해석하지 않고 경계만
# 찾는다(중첩 백틱은 실제 셸에서도 백슬래시 이스케이프가 필요하므로 같은 규칙을 따른다).
# 짝을 못 찾으면 __OPAQUE_END=-1 — 호출자가 이를 SEGMENT_UNSAFE 로 처리한다.
__skip_backtick() {
  # 주의: `n=${#s}` 를 `s="$1"` 과 같은 `local` 문에 두면 안 된다 — bash 는 그 우변을 s 가
  # 아직 이 스코프에 대입되기 **전**에 평가한다(F65 7차 판정이 __brace_find_group() 에서
  # 이미 겪은 함정 — 호출자 스코프에 우연히 같은 이름 s 가 남아 있으면 그 값으로 조용히
  # 계산돼 겉보기엔 통과한다. 실측: __tokenize_segment() 의 지역변수도 이름이 s 라서 이
  # 형태로 처음엔 우연히 통과했었다). 반드시 별도 문으로 나눈다.
  local s="$1"
  local j=$(($2 + 1)) n=${#s} cj
  while [[ $j -lt $n ]]; do
    cj="${s:j:1}"
    if [[ "$cj" == '\' ]]; then
      j=$((j + 2)); continue
    elif [[ "$cj" == '`' ]]; then
      __OPAQUE_END=$((j + 1)); return
    fi
    j=$((j + 1))
  done
  __OPAQUE_END=-1
}

# `$(...)` 의 짝 맞는 `)` 를 찾는다 — $2 는 `$` 의 인덱스(`${s:$2+1:1}` 이 `(` 임을 호출자가
# 보장한다). 중첩 괄호는 깊이 카운트로 짝을 맞춘다 — **안쪽 따옴표는 보지 않는 근사치**다
# (예: `$(echo "(")` 처럼 문자열 리터럴 안에 홀수 괄호가 있으면 경계를 놓칠 수 있다). 이
# 함수는 피연산자 값 자체를 확정하려는 게 아니라 토큰 분리가 안 깨지게 구간만 건너뛰는
# 것이므로, 경계를 놓쳐도 이후 안 닫힌 따옴표 검사나 SEGMENT_HAS_OPAQUE 처리가 안전한
# 쪽(ask)으로 떨어뜨린다.
__skip_dollar_paren() {
  # 위 __skip_backtick() 과 같은 이유로 별도 local 문 — 자기참조 회피.
  local s="$1"
  local j=$(($2 + 2)) n=${#s} depth=1 cj
  while [[ $j -lt $n && $depth -gt 0 ]]; do
    cj="${s:j:1}"
    if [[ "$cj" == '\' ]]; then
      j=$((j + 2)); continue
    elif [[ "$cj" == '(' ]]; then
      depth=$((depth + 1))
    elif [[ "$cj" == ')' ]]; then
      depth=$((depth - 1))
    fi
    j=$((j + 1))
  done
  if [[ $depth -gt 0 ]]; then __OPAQUE_END=-1; else __OPAQUE_END=$j; fi
}

# 무장 동사의 유일한 출처(F65 13차 독립 판정 — 커밋 978d8f2 가 이 목록을 __note_opaque_verb()
# 안에 리터럴로 중복시켰다가 반려됐다: "다른 곳도 같은 목록일 것"이라는 산문 주장은 검증된
# 적이 없었다). 아래 `scan_control_plane_delete()` 의 무장 판정도 이 두 배열을 직접 순회한다
# — 그래서 동사를 하나 더하거나 빼려면 이 자리 하나만 고치면 되고, __note_opaque_verb() 의
# 치환-원문 스캔과 실제 armed 판정이 조용히 어긋날 길이 없다(텍스트 중복도, 그걸 대조하는
# 별도 패리티 테스트도 필요 없다 — 애초에 하나이므로).
ARM_DELETE_VERBS_UNCONDITIONAL=(rm rmdir unlink shred mv)
# `find` 는 술어(`-delete`)를 동반할 때만 무장한다(평범한 `find .claude` 는 읽기다) — 그래서
# 무조건 무장 배열과 분리한다. `scan_control_plane_delete()` 의 `-delete` 사전 검사와
# `__scan_opaque_verb_matches()` 양쪽이 이 변수를 직접 쓴다.
ARM_DELETE_VERB_DELETE_GATED="find"

# 명령 치환 구간의 **원문**에 삭제 동사가 리터럴 단어로 있으면 그 동사를 별도 토큰으로
# SPLIT_TOKS 에 흘려보낸다(F65 12차 판정 — 커밋 1096d5e 반려, 13차 판정 — 커밋 978d8f2
# 반려로 재작업). 안쪽을 해석하지 않고 건너뛰기만 하면, `` `mv .claude /tmp/sink` `` 처럼
# 동사와 피연산자가 통째로 치환 안에 있는 세그먼트는 armed 가 끝내 안 걸려 아래
# `SEGMENT_HAS_OPAQUE` 검사 자체가 호출되지 않는다 — Layer 2 INDIRECT_PATTERNS 는
# `rm|chmod|chown|mkfs|eval` 만 보고 위 6개 무장 동사 중 5개를 몰라서, 그 다섯 동사가
# 치환 안에 있으면 이 함수 앞에서도 아무도 안 잡는다(12차 판정 실측: 28건 lab 확인 우회).
#
# **13차 판정이 반려한 두 결함**: (1) 12차 재작업은 `[[ =~ ]]` 매치를 **한 번만** 잡고
# 반환했다 — `find` 가 진짜 동사(`mv` 등)보다 먼저 나타나면(`$(FOO=find mv .claude
# /tmp/sink)`) 첫 매치인 `find` 만 흘러가고 실제 동사 `mv` 는 영영 안 잡혔다(32건 lab
# 확인 우회 — `find` 뒤에 문자 그대로 `-delete` 가 없으면 `find` 단독으로는 무장하지
# 않는데, 그렇다고 `mv` 를 안 본 것도 아니었다). 수정: 매치를 찾을 때마다 그 뒤로
# 계속 스캔해 span 안의 **모든** 동사 낱말을 흘려보낸다. (2) 원문만 훑어서는 치환
# **안에서** 다시 백슬래시로 쪼갠 동사(`` `r\m -rf .claude` ``)를 못 봤다 — 24건은 진짜
# 인코딩(hex 등)이라 잔여로 남지만, 나머지는 `normalize_path_token()` 과 같은 방식으로
# 따옴표·백슬래시만 제거한 사본에서 다시 스캔하면 잡힌다(문맥은 안 보고 문자만 지우므로
# **더 찾을 수만** 있고 못 찾게 만들지는 않는다 — 안전한 보조 스캔). 이름이 우연히
# 겹치는 문맥(예: URL 경로의 "rm")까지 무장하는 과잉은 이 파일 전체가 이미 받아들인
# 트레이드오프다("동사는 세그먼트 어디에 있어도 무장한다" 참조).
# F65 14차 독립 판정이 반려한 결함: 이전 버전은 매치를 찾을 때마다 지우며 반복했는데,
# 그 반복에 상한(20회)을 뒀다 — **상한 자체가 우회였다**. 가리는 낱말(예: `find`)을 상한
# 개수만큼 쓰면 진짜 동사에 도달하기 전에 스캔이 멈췄다(`A1=find A2=find ... A20=find mv
# .claude ...` 가 20개째부터 allow로 샜다, 실측). 수정: 동사 **개수**를 세지 않는다 —
# 6개 무장 동사 각각에 대해 "이 span 안에 이 동사가 한 번이라도 있는가"만 독립적으로
# 한 번씩 묻는다(존재 여부는 몇 번 나오든 같다). 이러면 span 안에 같은/다른 동사가 몇
# 개가 있든 검사 횟수가 항상 6번으로 고정돼 상한이 애초에 필요 없다.
__scan_opaque_verb_matches() {
  local s="$1" verb
  for verb in "${ARM_DELETE_VERBS_UNCONDITIONAL[@]}" "$ARM_DELETE_VERB_DELETE_GATED"; do
    [[ "$s" =~ (^|[^A-Za-z0-9_])${verb}([^A-Za-z0-9_]|$) ]] && SPLIT_TOKS+=("$verb")
  done
}

# **순수 변수명뿐인** `${VAR}` 블록만 통째로 지운다(비어 있는 것으로 취급) — $1 은 원문.
# 안쪽에 `:`·`#`·`%`·`/` 등 연산자가 하나라도 있으면(`${VAR:-word}`·`${VAR#pattern}` 등)
# **지우지 않는다** — F65 15차 독립 판정이 반려한 결함: 그런 형태는 미정의 상태에서도
# 기본값·치환 문자열이 실제로 텍스트를 남길 수 있어(`${Z:-r}${Z:-m}` → `rm`), 통째로
# 지우는 근사가 오히려 그 리터럴 텍스트를 놓친다("낱말을 못 찾게 만들지는 않는다"는
# 불변식이 이 형태에서는 성립하지 않는다). 순수 변수명(`${Z}`)만 미정의/빈 값일 때
# 실제 셸에서도 아무 것도 안 남으므로 "지운다"가 유일하게 안전한 근사다. 변수명 자체는
# `{` 를 가질 수 없으므로 첫 `}` 까지만 보면 된다 — 중첩 깊이 계산이 필요 없고, 그래서
# 15차 판정이 지적한 "`${A:-{}` 를 중첩으로 잘못 세어 스캔이 스팬 끝까지 밀리는" 종류의
# 오버슈트 자체가 생기지 않는다.
__strip_dollar_brace() {
  # 주의: 아래 n=${#s} 를 s="$1" 과 같은 local 문에 두지 않는다(__skip_backtick() 참조 —
  # 이 파일이 F65 7차 판정 이래 반복 겪은 자기참조 함정).
  local s="$1"
  local out="" n=${#s} k=0 c inner end idx
  local -a close_pos=()
  idx=0
  while [[ $idx -lt $n ]]; do
    case "${s:idx:1}" in
      '}') close_pos+=("$idx") ;;
    esac
    idx=$((idx + 1))
  done
  local ci=0 nclose=${#close_pos[@]}
  while [[ $k -lt $n ]]; do
    c="${s:k:1}"
    if [[ "$c" == '$' ]]; then
      case "${s:k+1:1}" in
        '{')
          while [[ $ci -lt $nclose && ${close_pos[$ci]} -lt $((k + 2)) ]]; do
            ci=$((ci + 1))
          done
          if [[ $ci -lt $nclose ]]; then
            end=${close_pos[$ci]}
            inner="${s:$((k + 2)):$((end - k - 2))}"
            if [[ -z "$inner" || "$inner" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
              k=$((end + 1))
              continue
            fi
          fi
          ;;
      esac
    fi
    out+="$c"
    k=$((k + 1))
  done
  __STRIPPED="$out"
}

__note_opaque_verb() {
  local span="$1"
  local stripped
  __scan_opaque_verb_matches "$span"
  # 백슬래시-공백 쌍을 **가장 먼저** 통째로 지운다(줄 이음 폴딩 대응 — 순서가 중요하다,
  # 아래 일반 백슬래시 제거보다 나중이면 백슬래시가 이미 사라져 이 쌍을 못 찾는다). 이
  # 훅의 개행 정규화(파일 위쪽 NORMALIZED_CMD 구성)는 실제 줄 이음(`\<LF>`, 셸에서
  # 아무 것도 안 남기고 사라짐)을 공백으로 접어(`\<space>`) 넘긴다 — 그대로 두면
  # `` `r\<LF>m -rf .claude` `` 같은 흔한 줄바꿈 표기가 검출을 피한다(F65 14차 판정
  # 실측). 정상적인 "공백을 이스케이프한 파일명"(`my\ file.txt`)도 같이 뭉쳐지지만,
  # 이 사본은 동사 존재 여부만 보는 용도라 무해하다(뭉쳐진 결과가 우연히 무장 동사 6개
  # 중 하나와 정확히 같지 않은 한 아무 일도 안 난다).
  stripped="${span//\\ /}"
  stripped="${stripped//\'/}"; stripped="${stripped//\"/}"; stripped="${stripped//\\/}"
  # 이 사본을 **독립적으로** 스캔한다(아래 __strip_dollar_brace() 결과로 대체하지
  # 않는다) — F65 15차 독립 판정이 실측한 회귀: 이전 버전은 이 사본을 `${...}` 제거
  # 결과로 **덮어썼다**, 그래서 그 제거의 근사가 스팬 끝까지 과하게 밀리면 방금 이
  # 사본에서 이미 보이던 동사까지 함께 사라져 부모 커밋보다 약해졌다(40건 회귀, 32건
  # lab 확인 파괴). 변환마다 별도 사본을 두고 각각 독립적으로 스캔하면, 뒤 단계가
  # 무언가를 지나치게 지워도 앞 단계가 이미 찾은 매치는 그대로 남는다.
  local braced
  [[ "$stripped" != "$span" ]] && __scan_opaque_verb_matches "$stripped"
  __strip_dollar_brace "$stripped"
  braced="$__STRIPPED"
  [[ "$braced" != "$stripped" ]] && __scan_opaque_verb_matches "$braced"
}

__tokenize_segment() {
  local s="$1"
  SEGMENT_UNSAFE=0
  SEGMENT_HAS_OPAQUE=0
  SPLIT_TOKS=()
  # 빠른 경로 — 따옴표·백슬래시·`$`·백틱·중괄호가 하나도 없으면 이 스캐너가 할 일이
  # 없다(네이티브 패턴 테스트라 길이에 안전하다, 직접 실측 확인됨). 대다수 명령이 여기서
  # 끝난다.
  if [[ "$s" != *"'"* && "$s" != *'"'* && "$s" != *'\'* && "$s" != *'$'* && "$s" != *'`'* ]]; then
    read -r -a SPLIT_TOKS <<<"$s"
    return
  fi
  # 문자 단위 스캔이라 비용이 길이에 붙는다(F65 7차 판정 Class E 수정 때 실측: 이 인덱싱
  # 방식 자체가 이 bash에서 길이에 대해 이차식이다). 상한을 넘기면 스캔을 시작하지 않고
  # **안전한 쪽으로 판단한다(진짜로 침)** — 못 보면 allow 가 아니라 ask 다(F65 8차 판정
  # 반려: 예전엔 상한 초과 시 안전하지 않은 분리로 물러났다가 그 자리가 fail-open이었다).
  if [[ ${#s} -gt 2048 ]]; then
    SEGMENT_UNSAFE=1
    return
  fi
  local n=${#s} k=0 c nc inS=0 inD=0 cur="" started=0
  while [[ $k -lt $n ]]; do
    c="${s:k:1}"
    if [[ $inS -eq 1 ]]; then
      [[ "$c" == "'" ]] && inS=0
      cur+="$c"; started=1; k=$((k+1)); continue
    fi
    if [[ $inD -eq 1 ]]; then
      if [[ "$c" == '\' ]]; then
        nc="${s:k+1:1}"
        case "$nc" in
          '$'|'`'|'"'|'\') cur+="${c}${nc}"; k=$((k+2)); started=1; continue ;;
        esac
        cur+="$c"; k=$((k+1)); started=1; continue
      elif [[ "$c" == '"' ]]; then
        inD=0; cur+="$c"; k=$((k+1)); started=1; continue
      elif [[ "$c" == '`' ]]; then
        __skip_backtick "$s" "$k"
        [[ $__OPAQUE_END -lt 0 ]] && { SEGMENT_UNSAFE=1; return; }
        __note_opaque_verb "${s:k:$((__OPAQUE_END-k))}"
        cur+="${s:k:$((__OPAQUE_END-k))}"; SEGMENT_HAS_OPAQUE=1
        k=$__OPAQUE_END; started=1; continue
      elif [[ "$c" == '$' ]]; then
        nc="${s:k+1:1}"
        if [[ "$nc" == '(' ]]; then
          __skip_dollar_paren "$s" "$k"
          [[ $__OPAQUE_END -lt 0 ]] && { SEGMENT_UNSAFE=1; return; }
          __note_opaque_verb "${s:k:$((__OPAQUE_END-k))}"
          cur+="${s:k:$((__OPAQUE_END-k))}"; SEGMENT_HAS_OPAQUE=1
          k=$__OPAQUE_END; started=1; continue
        fi
        cur+="$c"; k=$((k+1)); started=1; continue
      else
        cur+="$c"; k=$((k+1)); started=1; continue
      fi
    fi
    # 어느 따옴표 안도 아니다.
    if [[ "$c" == '\' ]]; then
      nc="${s:k+1:1}"
      cur+="${c}${nc}"; k=$((k+2)); started=1; continue
    elif [[ "$c" == "'" ]]; then
      inS=1; cur+="$c"; k=$((k+1)); started=1; continue
    elif [[ "$c" == '"' ]]; then
      inD=1; cur+="$c"; k=$((k+1)); started=1; continue
    elif [[ "$c" == '`' ]]; then
      __skip_backtick "$s" "$k"
      [[ $__OPAQUE_END -lt 0 ]] && { SEGMENT_UNSAFE=1; return; }
      __note_opaque_verb "${s:k:$((__OPAQUE_END-k))}"
      cur+="${s:k:$((__OPAQUE_END-k))}"; started=1; SEGMENT_HAS_OPAQUE=1
      k=$__OPAQUE_END; continue
    elif [[ "$c" == '$' ]]; then
      nc="${s:k+1:1}"
      if [[ "$nc" == "'" || "$nc" == '"' ]]; then SEGMENT_UNSAFE=1; return; fi
      if [[ "$nc" == '(' ]]; then
        __skip_dollar_paren "$s" "$k"
        [[ $__OPAQUE_END -lt 0 ]] && { SEGMENT_UNSAFE=1; return; }
        __note_opaque_verb "${s:k:$((__OPAQUE_END-k))}"
        cur+="${s:k:$((__OPAQUE_END-k))}"; started=1; SEGMENT_HAS_OPAQUE=1
        k=$__OPAQUE_END; continue
      fi
      cur+="$c"; k=$((k+1)); started=1; continue
    elif [[ "$c" == ' ' || "$c" == $'\t' ]]; then
      [[ $started -eq 1 ]] && { SPLIT_TOKS+=("$cur"); cur=""; started=0; }
      k=$((k+1)); continue
    else
      cur+="$c"; k=$((k+1)); started=1; continue
    fi
  done
  if [[ $inS -eq 1 || $inD -eq 1 ]]; then
    SEGMENT_UNSAFE=1; return
  fi
  [[ $started -eq 1 ]] && SPLIT_TOKS+=("$cur")
}

# $1(NORMALIZED_CMD)을 `;`·`|`·`&` 로 세그먼트 나누되, 그 문자가 명령 치환(백틱·`$(`)
# **안**에 있으면 구분자로 보지 않는다 — security-auditor 감사(2026-09-04, AUDIT-2)가
# 실증: 예전의 순진한 `tr ';|&' '\n\n\n'` 는 `echo $(git rev-parse HEAD | cut -c1-7)`
# 의 `|` 도 구분자로 봐서 세그먼트를 반으로 잘랐다. 잘린 앞쪽 조각은 짝 잃은 `$(` 만 남고
# __skip_dollar_paren() 이 닫는 `)` 를 못 찾아 SEGMENT_UNSAFE=1(ask) 로 fail-closed 됐다
# — 삭제 동사가 전혀 없는 명령에 새 마찰이 생겼다(dec9293 은 allow, 12차 이후 ask). 이
# 함수는 **세그먼트 경계만** 정한다 — 세그먼트 안의 토큰 분리는 여전히
# __tokenize_segment() 가 한다. 이미 만든 __skip_backtick()/__skip_dollar_paren() 을
# 그대로 재사용해 치환 구간을 건너뛴다(따옴표 안의 구분자는 이 훅 최상단 NORMALIZED_CMD
# 정규화가 이미 공백으로 중화해 뒀으므로 여기서 다시 추적하지 않는다 — 남은 몫은 치환
# 안쪽뿐이다). 치환이 문자열 끝까지 안 닫히면(진짜로 깨진 명령) 남은 전체를 마지막
# 세그먼트 하나로 넘긴다 — 그 세그먼트를 __tokenize_segment() 가 다시 보고 똑같이
# SEGMENT_UNSAFE=1 로 fail-closed 하므로 안전 방향은 그대로 유지된다.
#
# **길이 상한(자체 발견, 판정 대상 아님 — F37 이 지적한 __strip_dollar_brace() 의
# 이차식 결함을 고치던 중, 이 함수 자체에 같은 계열의 결함이 있는 것을 커밋 전 실측으로
# 찾았다)**: 이 bash 는 `${s:k:1}` 같은 단일 문자 인덱싱 비용이 위치와 무관하게 문자열
# **전체 길이**에 비례한다(실측: 6만자 문자열에서 인덱싱 1회가 항상 ~4ms — 위치 0이든
# 59999든 동일). 이 함수는 세그먼트가 아니라 `NORMALIZED_CMD` **전체**를 훑으므로, 다른
# 문자 단위 스캐너들(세그먼트 2048자·브레이스 토큰 512자 상한)과 달리 상한이 없었다 —
# 6만자 명령에서 21초(5초 타임아웃을 훌쩍 넘긴다). 상한을 넘으면 정밀 분리를 포기하고
# 예전의 `tr` 분리로 되돌아간다 — 이 되돌아감은 F65 8차 판정이 겪은 함정과 방향이
# 반대다(그때는 상한 초과 시 안전하지 않은 분리로 물러나 fail-open 이었다). 여기서는
# `tr` 분리가 세그먼트를 **더 잘게만** 쪼갠다 — 놓치는 방향이 아니라 AUDIT-2 마찰이
# 극단적으로 긴 명령에서만 되살아나는 방향이라 게이트를 약화하지 않는다.
__split_segments() {
  local s="$1"
  local n=${#s}
  SEGMENTS=()
  if [[ $n -gt 8192 ]]; then
    local seg
    while IFS= read -r seg || [[ -n "$seg" ]]; do
      SEGMENTS+=("$seg")
    done < <(printf '%s' "$s" | tr ';|&' '\n\n\n')
    return
  fi
  local out="" k=0 c
  while [[ $k -lt $n ]]; do
    c="${s:k:1}"
    if [[ "$c" == '`' ]]; then
      __skip_backtick "$s" "$k"
      if [[ $__OPAQUE_END -lt 0 ]]; then
        out+="${s:k}"; break
      fi
      out+="${s:k:$((__OPAQUE_END-k))}"
      k=$__OPAQUE_END
      continue
    elif [[ "$c" == '$' && "${s:k+1:1}" == '(' ]]; then
      __skip_dollar_paren "$s" "$k"
      if [[ $__OPAQUE_END -lt 0 ]]; then
        out+="${s:k}"; break
      fi
      out+="${s:k:$((__OPAQUE_END-k))}"
      k=$__OPAQUE_END
      continue
    elif [[ "$c" == ';' || "$c" == '|' || "$c" == '&' ]]; then
      SEGMENTS+=("$out")
      out=""
      k=$((k + 1))
      continue
    else
      out+="$c"
      k=$((k + 1))
    fi
  done
  SEGMENTS+=("$out")
}

# === 인용 래퍼(sh -c "..."·인터프리터 -c/-e) 인자 언랩 (F65 20차 독립 판정) ===
#
# `__tokenize_segment()` 는 큰따옴표·작은따옴표로 감싼 다중 단어 인자를 공백을 보존한
# **하나의 복합 토큰**으로 묶는다(셸이 실제로 그렇게 인자를 하나로 넘기므로 맞는 동작이다).
# 그런데 아래 `__scan_one_segment_for_cp_delete()` 의 armed 판정은 토큰이 정확히 동사와
# 같거나(`rm`) `/동사` 로 끝나는지만 본다 — 복합 토큰("rm -f .claude/settings.json" 전체가
# 공백을 포함한 한 토큰)은 둘 중 무엇에도 해당하지 않아 애초에 armed 판정에 들어오지
# 못한다. 그 결과 `sh -c "rm -f .claude/settings.json"` 같은 명령에서 실제로 ask 를
# 내는 것은 이 토큰 계층이 아니라 Layer 3 ASK_PATTERNS 의 평문 리터럴 정규식이었다(ask
# 사유 문자열로 확인됨) — 그런데 그 정규식은 표기 하나(예: `//`)를 넓힐 때마다 셸이
# 투명하게 처리하는 다음 표기(인용 분할·백슬래시 이스케이프·글로브·상위경로 traversal)에서
# 똑같이 다시 새는 것으로 19~20차 독립 판정에서 반복 확인됐다 — 리터럴을 표기별로
# 열거하는 방식 자체가 수렴하지 않는다.
#
# 그래서 표기를 더 넓히는 대신, 인용 래퍼의 **인자를 한 겹 벗겨** 같은 토큰 스캐너에
# 재귀적으로 태운다 — `normalize_path_token()`·`CONTROL_PLANE_NAMES`·
# `ARM_DELETE_VERBS_UNCONDITIONAL` 이 bare 토큰에서 이미 성립시키는 판정을 래퍼 안의
# 인자에도 그대로 적용하면, 표기를 하나씩 열거할 필요 없이 그 표기들이 전부 함께
# 닫힌다(20차 판정 recommended_fix.primary). **한 겹만 벗긴다** — 중첩 래퍼
# (`sh -c "python3 -c \"...\""`)는 별도 축으로 남긴다(진단만 무한정 늘리지 않기 위한
# 의도적 경계, sprint-51.json 참조).
#
# 셸 이름 목록은 여기서 새로 정의한다(이 파일에 "셸 이름" 배열이 따로 없었다). 인터프리터
# 이름은 `INTERPRETER_ARM` 을 다시 나열하지 않고 그 값을 파싱해서 얻는다(F67 SC-2 와
# 같은 단일 출처 원칙 — 목록이 둘로 갈라지면 한쪽만 고쳤을 때 조용히 어긋난다).
WRAP_SHELL_TOKENS=(sh bash zsh dash ksh)
__wrap_interpreter_tokens_init() {
  local re="${INTERPRETER_ARM#\(}"
  re="${re%\)}"
  IFS='|' read -r -a WRAP_INTERPRETER_TOKENS <<<"$re"
}
__wrap_interpreter_tokens_init

# 토큰이 셸/인터프리터 이름인가 — 인용부호만 벗겨서 비교하고(백슬래시는 이 이름들에
# 실무상 나타나지 않으므로 다루지 않는다), 경로가 있으면 basename 접미사로도 매치한다
# (`/bin/sh`·`/usr/bin/env` 뒤의 `python3` 등 — 위 무장 동사 검사와 같은 관용구).
# 결과는 반환값이 아니라 `__WRAP_CLASS`("shell"|"interp")로 준다 — 호출자가 클래스별로
# 다른 플래그 문법을 판정해야 하기 때문이다(아래 __is_wrap_flag 참조).
__classify_wrap_verb() {
  local t="$1" stripped v
  stripped="${t//\'/}"; stripped="${stripped//\"/}"
  for v in "${WRAP_SHELL_TOKENS[@]}"; do
    if [[ "$stripped" == "$v" || "$stripped" == */"$v" ]]; then __WRAP_CLASS="shell"; return 0; fi
  done
  for v in "${WRAP_INTERPRETER_TOKENS[@]}"; do
    if [[ "$stripped" == "$v" || "$stripped" == */"$v" ]]; then __WRAP_CLASS="interp"; return 0; fi
  done
  return 1
}

# 이 토큰이 "다음 토큰을 코드/명령 문자열로 받는다" 는 플래그인가. 셸은 `-c` 를
# 결합 단축옵션으로도 쓴다(`bash -lc "..."` 가 20차 판정 실증 목록에 있다).
# **21차 독립 판정 반려**: 이전 버전은 `c` 를 클러스터 **마지막 글자로 앵커**했는데
# (`^-[A-Za-z]*c$`), 실제 셸은 클러스터 안 `c` 의 위치와 무관하게 다음 인자를 코드
# 문자열로 받는다 — `sh -cx '...'`·`sh -cv '...'`·`bash -cl '...'` 전부 실행되는데
# `c` 뒤에 다른 글자(`x`·`v`)가 오면 옛 정규식이 놓쳤다(격리 랩 실증: 16종 무프롬프트
# 삭제). `c` 가 클러스터 어디에 있어도 성립하도록 `^-[A-Za-z]*c[A-Za-z]*$` 로 고친다.
# 같은 판정이 `ftok` 의 따옴표도 벗긴다 — 이전에는 이 함수만 벗기지 않아 `sh '-c' '...'`
# 처럼 플래그 자체가 인용된 형태가 샜다(형제 함수 `__classify_wrap_verb()` 는 이미
# 벗기고 있었다 — 같은 정규화를 두 곳에 따로 심으면 이렇게 어긋난다).
# 인터프리터는 **결합하지 않는다** — 여기서 결합까지 허용하면 `perl -pe '...'`·
# `perl -ne '...'` 같은 매우 흔한 한 줄짜리 관용구(치환·필터 스크립트, 셸 코드가
# 아니다)가 전부 걸려 새 마찰이 된다. 그래서 인터프리터는 각 언어의 정확한 실행
# 플래그만 본다(`-c`: python·node 도 받아 준다 · `-e`: perl·ruby·node·lua · `-r`: php).
__is_wrap_flag() {
  local class="$1" ftok="$2" stripped
  stripped="${ftok//\'/}"; stripped="${stripped//\"/}"
  if [[ "$class" == "shell" ]]; then
    [[ "$stripped" =~ ^-[A-Za-z]*c[A-Za-z]*$ ]] && return 0
  else
    [[ "$stripped" == "-e" || "$stripped" == "-c" || "$stripped" == "-r" ]] && return 0
  fi
  return 1
}

# 인용된 코드 인자를 원래 셸 텍스트에 가깝게 되돌린다 — 정확한 셸 파싱이 아니라
# "동사·경로가 드러나는가" 만 보는 근사다(`__note_opaque_verb()` 와 같은 성격). 과하게
# 벗겨도 위험한 방향(더 잘 잡음)이지 안전한 방향(놓침)이 아니므로 정밀도를 더 추구하지
# 않는다. 결과는 `__UNQUOTED` 에 담는다.
__unquote_wrap_candidate() {
  local c="$1" n
  n=${#c}
  if [[ $n -ge 2 && "${c:0:1}" == "'" && "${c: -1}" == "'" ]]; then
    __UNQUOTED="${c:1:$((n - 2))}"
    return
  fi
  if [[ $n -ge 2 && "${c:0:1}" == '"' && "${c: -1}" == '"' ]]; then
    c="${c:1:$((n - 2))}"
  fi
  c="${c//\\\"/\"}"; c="${c//\\\`/\`}"; c="${c//\\\$/\$}"; c="${c//\\\\/\\}"
  __UNQUOTED="$c"
}

# 세그먼트의 토큰 배열(`__SEG_TOKS`, 호출자가 채운다 — bash 3.2 에는 nameref 가 없어
# 전역으로 주고받는다) 중 "셸/인터프리터 이름 ... 코드 플래그 ... <인자>" 형태를
# 찾는다. 세그먼트당 **첫 매치만** 본다 — 래퍼가 여럿인 정상 명령은 극히 드물고, 못
# 찾아도 이 축이 안 넓어질 뿐 다른 층의 fail-closed 는 그대로다. 찾으면 그 <인자>를
# 벗겨 `__UNWRAP_INNER` 에 채우고 0을 반환한다.
__find_wrapped_arg() {
  local -a t=("${__SEG_TOKS[@]+"${__SEG_TOKS[@]}"}")
  local n=${#t[@]} i=0 j k
  while [[ $i -lt $n ]]; do
    if __classify_wrap_verb "${t[$i]}"; then
      j=$((i + 1))
      while [[ $j -lt $n ]]; do
        if __is_wrap_flag "$__WRAP_CLASS" "${t[$j]}"; then
          # **21차 독립 판정 반려**: 이전 버전은 플래그 바로 다음 토큰(`t[j+1]`)을
          # 곧장 후보로 확정했는데, 실제 셸은 코드 플래그와 코드 인자 사이에 `--`나
          # 다른 단독 플래그가 더 끼어도 개의치 않고 그 다음 비-플래그 토큰을 코드로
          # 받는다(격리 랩 실증: `sh -c -- '...'`·`bash -c -x '...'` 둘 다 실행돼
          # `.claude` 를 지운다). `-` 로 시작하는 토큰을 건너뛰고 첫 비-플래그 토큰을
          # 후보로 삼는다 — 후보가 끝까지 없으면(플래그로만 끝나는 조각) 이 래퍼는
          # 포기하고 바깥 루프가 다음 위치의 래퍼 이름을 계속 찾는다.
          k=$((j + 1))
          while [[ $k -lt $n && "${t[$k]}" == -* ]]; do
            k=$((k + 1))
          done
          if [[ $k -lt $n ]]; then
            __unquote_wrap_candidate "${t[$k]}"
            __UNWRAP_INNER="$__UNQUOTED"
            return 0
          fi
          break
        fi
        j=$((j + 1))
      done
    fi
    i=$((i + 1))
  done
  return 1
}

# 명령을 세그먼트로 나눠 삭제 동사 뒤의 피연산자 토큰을 판정한다.
# 동사는 세그먼트 **어디에 있어도** 무장한다 — `sudo rm …`·`time rm …` 같은 접두 명령을 열거하지
# 않기 위해서다(열거하면 접두 한 단어로 게이트가 무력해진다 — F67 2차 판정이 `env` 로 실증했다).
#
# **전체 순회에 글로벌 시간 예산을 둔다(F65 17차 독립 판정)**: 세그먼트 2048자·브레이스
# 토큰 512자·`__split_segments()` 8192자 — 이 상한들은 전부 **세그먼트 하나**의 비용만
# 막는다. 17차 판정이 실증: 각각은 상한 아래라 개별로는 빠른("비싸지만 깨끗한") 세그먼트를
# 여러 개 이어 붙이면 총 시간이 그대로 누적된다 — 12개(~2.4만자)에서 5.54초로 5초
# 타임아웃을 넘긴다. 이 함수는 세그먼트를 순서대로 훑다 첫 히트에서 반환하므로, 느린
# 세그먼트들을 진짜 삭제 세그먼트보다 앞에 두면 타임아웃 예산이 다 써진 뒤에야(또는
# 아예 죽은 뒤) 판정이 나온다 — **이 커밋이 새로 만든 결함이 아니다**(부모 커밋에서도
# 순수 따옴표 세그먼트만으로 동일하게 재현됐다, 회귀 아님). 그래서 세그먼트 하나하나가
# 아니라 **순회 전체**에 시간 예산을 둔다 — 예산을 다 쓴 시점에 아직 다 훑지 못한
# 세그먼트가 남아 있으면, 그 나머지에 삭제가 있는지 없는지 알 수 없으므로 이 파일
# 전체의 원칙("모르면 allow 가 아니라 ask")대로 안전한 쪽으로 확인을 요청한다 — 이
# 파일 여기저기의 `SEGMENT_UNSAFE=1` fail-closed 관용구를 세그먼트 단위에서 **루프
# 단위**로 끌어올린 것과 같다. 예산은 이 훅의 5초 타임아웃의 절반(2.5초)로 잡아, 남은
# 절반은 이 시점까지 이미 실행된 나머지 계층(Layer 1·2·3)과 지금 처리 중인 세그먼트
# 자신의 처리 시간(이미 각자의 상한으로 유계)에 여유를 준다.
CP_DELETE_HIT=""

# 세그먼트 하나를 검사한다. $1=세그먼트 문자열, $2=1이면 인용 래퍼 언랩을 한 겹
# 시도한다(0이면 안 한다). 언랩된 내부를 재귀 스캔할 때는 항상 0을 넘겨 딱 한 겹으로
# 제한한다(F65 20차 독립 판정 recommended_fix.primary — "한 겹만 벗겨도 실증된 16종이
# 전부 닫힌다", 중첩 래퍼는 별도 축). 반환: 0=삭제 발견(CP_DELETE_HIT 설정), 1=없음.
__scan_one_segment_for_cp_delete() {
  local seg="$1" try_unwrap="$2"
  local tok armed __arm_verb __verb_armed inner_seg
  local -a toks
  __tokenize_segment "$seg"
  # 빈 배열을 `"${arr[@]}"` 로 그대로 펼치면 bash 3.2(이 훅이 실제로 실행되는 macOS 기본
  # 셸, set -u 상태)에서 "unbound variable" 로 죽는다 — bash 4.4 이전의 알려진 결함이다.
  # `"${arr[@]+"${arr[@]}"}"` 관용구가 두 버전 모두에서 안전하다.
  toks=("${SPLIT_TOKS[@]+"${SPLIT_TOKS[@]}"}")
  # ANSI-C/로케일 인용($'·$") 이나 안 닫힌 따옴표를 만났다 — 펴 보려 하지 않고 세그먼트
  # 전체를 즉시 ask 로 처리한다(위 __tokenize_segment() 주석 참조). 동사 토큰(`$'rm'`)과
  # 피연산자 토큰(`$'.claude'`) 어느 쪽에 있어도 같은 문제라 **토큰 단위가 아니라
  # 세그먼트 단위**로, 그리고 **무장 여부와 무관하게** 본다 — 동사 자체를 이 표기로
  # 위장하면 armed 판정 전에 걸러야 하고, 이 표기를 잡아 주는 다른 층이 없다(9차 판정).
  # 대가: `$'...'`을 쓰는, 삭제와 무관한 명령(예: `git commit -m $'여러\n줄'`)도 이
  # 세그먼트에 걸리면 마찰이 생긴다 — 승인된 트레이드오프다.
  #
  # 명령 치환(백틱·`$(`)은 다르게 다룬다 — `SEGMENT_UNSAFE` 대신 `SEGMENT_HAS_OPAQUE` 만
  # 세우고 토큰화는 계속된다(위 __tokenize_segment() 주석: Layer 2 가 위험 동사 내용을,
  # `open_axes_2026_08_04.indirect_operand` 가 임의 계산 피연산자를 이미 나눠 맡는다).
  # 그래서 여기서는 **무장이 확정된 뒤에만** 그 플래그를 본다 — 아래 armed 계산 이후.
  if [[ "$SEGMENT_UNSAFE" -eq 1 ]]; then CP_DELETE_HIT="$seg"; return 0; fi
  armed=0
  # `find … -delete` 는 동사가 술어로 온다. `-exec … rm` 은 아래 동사 검사가 무장한다.
  if [[ "$seg" == *"-delete"* ]]; then
    for tok in "${toks[@]+"${toks[@]}"}"; do
      normalize_path_token "$tok"
      # `${NORM_TOK##*/}` (basename 추출) 대신 접미사 패턴 **판정**을 쓴다 — F65 7차 판정
      # 재작업 도중 자체 발견(판정 대상 아님): `${var##pattern}` 처럼 와일드카드가 든 추출은
      # 이 bash에서 문자열 길이에 대해 이차식이다(직접 실측: 29KB 토큰 하나에 1.17초,
      # 5.8만자 토큰은 4.8초 — 매칭 성공/실패와 무관하게 똑같이 느리다). 반면 `[[ x == 패턴 ]]`
      # **판정**은 같은 조건에서 0.01초대다. 중괄호 그룹 콤마 하나짜리 피연산자 토큰은 실제로
      # 수만 자까지 커질 수 있고(F65 축), 이 자리는 그 토큰이 __control_plane_location_impl()
      # 의 512자 상한을 거치기 **전**이라 무방비였다.
      if [[ "$NORM_TOK" == "$ARM_DELETE_VERB_DELETE_GATED" || "$NORM_TOK" == */"$ARM_DELETE_VERB_DELETE_GATED" ]]; then armed=1; break; fi
    done
  fi
  for tok in "${toks[@]+"${toks[@]}"}"; do
    normalize_path_token "$tok"
    # 위와 같은 이유로 `${NORM_TOK##*/}` 추출이 아니라 접미사 판정을 쓴다. 목록은
    # ARM_DELETE_VERBS_UNCONDITIONAL 하나뿐이다(위 선언 참조) — 여기서 다시 나열하지
    # 않는다.
    __verb_armed=0
    for __arm_verb in "${ARM_DELETE_VERBS_UNCONDITIONAL[@]}"; do
      if [[ "$NORM_TOK" == "$__arm_verb" || "$NORM_TOK" == */"$__arm_verb" ]]; then
        __verb_armed=1; break
      fi
    done
    if [[ "$__verb_armed" -eq 1 ]]; then armed=1; continue; fi
    [[ "$armed" -eq 1 ]] || continue
    [[ -z "$NORM_TOK" || "$NORM_TOK" == -* ]] && continue
    # 후행 글로브 접기는 더 이상 여기서 하지 않는다(F65 6차 판정 반려) — 이 지점은 중괄호
    # 확장보다 **먼저** 실행되므로, `{.claude/*,x}` 같은 토큰의 마지막 `/` 뒤 꼬리(`*,x}`)를
    # 글로브로 오인해 앞을 잘라 `{.claude` 라는 깨진 토큰을 만들었다 — 그 반쪽짜리 중괄호는
    # 짝을 잃어 리터럴로 떨어지고 결국 아무 것도 매치하지 못했다(실측: `.claude` 삭제 성공).
    # 접기는 이제 `__control_plane_location_impl()` 안, 중괄호 확장이 끝난 뒤로 옮겼다 —
    # 그래야 콤마/범위 확장으로 나온 각 후보(`.claude/*` 등) 위에서 접기가 실행된다.
    if control_plane_location "$NORM_TOK"; then CP_DELETE_HIT="$tok"; return 0; fi
  done
  # 삭제 동사가 리터럴로 확정됐는데(armed) 세그먼트 어딘가에 명령 치환이 있었다
  # (SEGMENT_HAS_OPAQUE) — 그 치환이 만들어내는 피연산자 값은 정적으로 알 수 없으므로
  # (`rm -rf $(malicious)`), 리터럴 대조로는 못 잡았어도 안전한 쪽으로 ask 한다.
  if [[ "$armed" -eq 1 && "$SEGMENT_HAS_OPAQUE" -eq 1 ]]; then
    CP_DELETE_HIT="$seg (피연산자에 명령 치환이 있어 정적으로 확정할 수 없음)"
    return 0
  fi
  # F65 20차 독립 판정: 위 armed/operand 검사는 이 세그먼트의 **자기 자신** 토큰만
  # 봤다. 인용 래퍼(`sh -c "..."` 등)의 인자는 하나의 복합 토큰이라 위 검사에
  # 애초에 걸리지 않는다 — 한 겹 벗겨 같은 검사를 내부 문자열에 다시 태운다.
  if [[ "$try_unwrap" -eq 1 ]]; then
    __SEG_TOKS=("${toks[@]+"${toks[@]}"}")
    if __find_wrapped_arg; then
      __split_segments "$__UNWRAP_INNER"
      local -a __inner_segs=("${SEGMENTS[@]+"${SEGMENTS[@]}"}")
      for inner_seg in "${__inner_segs[@]+"${__inner_segs[@]}"}"; do
        [[ -z "$inner_seg" ]] && continue
        if __scan_one_segment_for_cp_delete "$inner_seg" 0; then return 0; fi
      done
    fi
  fi
  return 1
}

scan_control_plane_delete() {
  local seg
  local __budget_ms
  __split_segments "$NORMALIZED_CMD"
  for seg in "${SEGMENTS[@]}"; do
    # __HOOK_START_NS(파일 맨 위) 기준으로 잰다 — 이 함수가 불린 시점이 아니라 **훅
    # 전체가 시작된 시점**부터다(재작업 중 자체 발견, 판정 대상 아님: 이 위 단계들
    # (NORMALIZED_CMD 정규화 등)만으로도 아주 큰 입력에서는 이미 초 단위 시간이 들 수
    # 있어, 함수 진입 시점부터 재면 예산의 상당 부분이 조용히 먼저 소모된 뒤일 수
    # 있었다 — 실측: 14만자 입력에서 함수 진입 전 처리만으로 이미 2초 이상). 3초로
    # 잡아, 남은 2초는 지금 처리 중인 세그먼트 자신(각 캡으로 이미 유계)과 이 검사
    # 뒤에 남은 계층(ASK_PATTERNS 등)에 여유를 준다.
    __budget_ms=$(( ($(date +%s%N) - __HOOK_START_NS) / 1000000 ))
    if [[ $__budget_ms -gt 3000 ]]; then
      CP_DELETE_HIT="(세그먼트가 많아 시간 예산 안에 전부 확인하지 못함 — 남은 부분에 삭제가 있는지 알 수 없어 안전한 쪽으로 확인 요청)"
      return 0
    fi
    [[ -z "$seg" ]] && continue
    if __scan_one_segment_for_cp_delete "$seg" 1; then return 0; fi
  done
  return 1
}

# **동사 이름을 사전 필터로 쓰지 않는다 (F65 10차 판정 반려).** 예전에는 "삭제 동사가
# 아예 없는 명령은 건너뛴다"며 `(rm|rmdir|unlink|shred|mv|find)` 리터럴 부분 문자열을
# NORMALIZED_CMD 에서 먼저 찾고, 맞을 때만 scan_control_plane_delete() 를 불렀다 — 순전히
# 성능 최적화였는데 조용히 보안 게이트가 됐다. `'r'm -rf .claude` 처럼 동사 단어를 따옴표로
# 쪼개면 이 부분 문자열 검사가 실패해 **scan_control_plane_delete() 자체가 호출되지 않는다**
# — 그 함수 안의 정규화(따옴표 제거)는 이미 이 형태를 정확히 처리하는데, 그 앞의 문(gate)이
# 정규화 이전 원문에서 똑같은 실수(동사 철자를 문자 그대로 찾는 것)를 반복해 안쪽 로직에
# 도달하지도 못하게 막았다(실측: 격리 랩에서 zsh·bash 5.3·bash 3.2 전부 `.claude` 삭제
# 성공). 이 사전 필터가 막던 성능 문제(모든 명령마다 토큰 순회)는 이제 없다 — 5~9차에서
# 넣은 길이 상한들(512·2048자)이 이미 무거운 입력을 안쪽에서 막으므로, 짧은 정상 명령에서
# scan_control_plane_delete() 를 매번 부르는 비용은 무시할 만하다. 그래서 PURE_READ 여부만
# 보고 항상 부른다 — "이 명령엔 동사가 없다"는 판단을 내부 로직보다 먼저, 더 허술한
# 방법으로 내리지 않는다.
if [ "$PURE_READ" -eq 0 ] && scan_control_plane_delete; then
  log_decision ask
  jq -n --arg reason "컨트롤 플레인(배선 파일·설치 디렉터리)을 지우는 명령입니다 (pattern: control-plane-delete → $CP_DELETE_HIT). 실행 전 확인이 필요합니다." \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: $reason}}'
  exit 0
fi

if [ "$PURE_READ" -eq 0 ] && echo "$NORMALIZED_CMD" | grep -qiE "$(join_patterns "${ASK_PATTERNS[@]}")"; then
  for p in "${ASK_PATTERNS[@]}"; do
    if echo "$NORMALIZED_CMD" | grep -qiE "$p"; then
      # 면제할 수 있는 것은 **읽기를 잡는 arm**이다 — 목록은 EXEMPTABLE_ARM_TOKENS 한 곳에 있고
      # 판정은 arm_is_exemptable()이 한다(F67 SC-2: 어느 arm이 면제되는지 코드에서 읽힌다).
      #
      # 4차 판정 이전에는 SAFE_READ=1이 ASK 배열 **전체**를 건너뛰었고, 그 때문에 화이트리스트의
      # 결함 하나가 sed/awk 마찰을 넘어 egress 티어(`$(curl -T ~/.ssh/id_rsa …)`)와
      # INV-11 Bash 우회 게이트(`$(cp /tmp/x progress/feature_list.json)`)까지 열었다.
      # 3차에서 내가 'ASK 앞에 두었으니 최악도 ask→allow 한 단계'라고 주장한 손실 상한은
      # **면제 범위를 국소화해야 비로소 참이 된다.** 지금도 목록 밖 패턴이 하나라도 걸리면 ask다.
      #
      # F67이 feature_list arm 중 인터프리터 계열을 목록에 넣었다. F65 6차는 그것을 보류하며
      # '읽기 마찰은 게이트가 지키는 값어치에 비해 싸다'고 적었는데, 실측이 그 전제를 무너뜨렸다:
      # (a) 이 arm은 도구 이름만 보므로 순수 읽기를 잡고, (b) 개행으로 나눈 **무관한 두 명령**까지
      # 한 스팬으로 묶으며, (c) 같은 명령을 `;` 로 이으면 통과한다 — 표기 한 글자로 판정이 뒤집혀
      # 보호도 마찰도 실패하고 있었다. 사후 탐지·복구는 그 세 결함을 모두 갖지 않는다.
      # 면제 조건은 하나다: **그 arm이 읽기를 잡는가.** 경로 조건은 2026-08-02 사용자 결정으로
      # 철회했다 — 경로를 표기로 구속하려는 시도가 여섯 회전 연속 같은 결함을 냈고(경로 열거 →
      # 대소문자·추적 → `cd` 형태 → 정규식 앵커 → 문자 클래스 경계), 매 회전 "이번엔 원리적"이라고
      # 적고서 한 층 아래에서 같은 것이 나왔다. 명령 문자열로 경로를 확정하는 것은 F63이 열 회전에
      # 걸쳐 확인한 결정 불가능 축이며, 부분 구현은 닫힌 것으로 오인하게 만들어 오히려 나쁘다.
      # 그래서 다섯 도구(python·node·ruby·sed·awk 계열)는 **경로와 무관하게** 면제하고,
      # 보호는 전적으로 사후 탐지·복구에 맡긴다. 손실 상한은 INV-14에 그대로 적었다.
      # [상태 갱신] 이 블록은 F67 원안의 판단을 그대로 남긴 것이다 — F67 철회(2026-08-02) 때
      # 실제로는 인터프리터 계열이 목록에서 빠졌고(sed/awk만 남음), F71 override(2026-08-08)에서
      # 사용자 결정으로 다시 들어왔다(위 :163-178 주석, INV-14, ADR-004 Amendment 5 참조).
      # 지금 이 자리의 서술("다섯 도구·경로 무관 면제")은 F71 이후의 실제 코드 상태와 일치한다.
      if [ "$DATA_PLANE_DETECTED" -eq 0 ] && arm_is_exemptable "$p"; then
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
