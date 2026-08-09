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
  # 무게). 안전한 이유는 이 제거가 **기존 arm의 동작을 바꾸지 않는다**는 데 있다 — 전체
  # ASK_PATTERNS 중 `-i` 리터럴을 포함하는 arm은 셋뿐이고(일반/contracts `--in-place`,
  # feature_list.json `-i`) 셋 다 도구 목록에 `perl`이 섞여 있어(`(g?sed|perl|g?awk|mawk)`)
  # `READ_CAPABLE_ARM`(`(g?sed|g?awk|mawk)`)을 연속 부분문자열로 포함하지 않는다 — 그래서
  # 아래 토큰 매치 단계에서 여전히 실패해 면제되지 않는다(perl 계속 ask, 실측 확인됨). 실제
  # 면제는 이 arm들이 아니라 F73이 새로 추가한, perl 없이 `(g?sed|g?awk|mawk)`만 쓰는 arm에서만
  # 일어난다. `protected-integrity` 등 `-i`를 우연히 포함하는 다른 패턴은 아래 별도 하드 제외가
  # 이미 막는다.
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
  '\bperl\b[^;|&]*(^| )-[a-zA-Z]*i[a-zA-Z]*[^;|&]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.(sh|json)|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md|\.claude/settings(\.local)?\.json)'
  '\bperl\b[^;|&]*--in-place[^;|&]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.(sh|json)|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md|\.claude/settings(\.local)?\.json)'
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
  '\b(g?sed|perl|g?awk|mawk)\b[^;|&]*(^| )-[a-zA-Z]*i[a-zA-Z]*[^;|&]*hooks/[A-Za-z0-9_.-]+\.json'
  '\b(g?sed|perl|g?awk|mawk)\b[^;|&]*--in-place[^;|&]*hooks/[A-Za-z0-9_.-]+\.json'
  # sed의 w 명령/s///w 플래그 — 플래그도 리다이렉트도 없이 임의 파일에 쓴다.
  # 실측: sed -n 'w victim' src → victim에 src 내용 · sed 's/x/PWN/w victim2' → victim2=PWN.
  # F63 이전에는 에디터 이름 목록이 sed를 통째로 잡아 가려져 있었다.
  '\bg?sed\b[^;|&]*\bw\b *[^;|&]*(harness-config\.json|hooks/[A-Za-z0-9_.-]+\.(sh|json)|tests/[A-Za-z0-9_.-]+\.bats|INVARIANTS\.md|\.claude/settings(\.local)?\.json)'
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
  '\b(python3?|node|nodejs|ruby|perl|php|lua)\b[^;|&]*(hooks/[A-Za-z0-9_.-]+\.json|\.claude/settings(\.local)?\.json)'
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
  '>>? *[^ ]*(hooks/hooks\.json|\.claude/settings(\.local)?\.json)'
  '\b(cp|mv|install|rsync|ln|tee|sponge|truncate)\b[^;|&]*(hooks/hooks\.json|\.claude/settings(\.local)?\.json)'
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
  '\b(rm|unlink|shred)\b[^;|&]*(hooks/hooks\.json|\.claude/settings(\.local)?\.json)'
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
  t=${t//\'/}; t=${t//\"/}; t=${t//\\/}          # 따옴표·백슬래시 제거 (`'.claude'`·`\rm`)
  while [[ "$t" == *"$dsl"* ]]; do t=${t//"$dsl"/"$sl"}; done
  while [[ "$t" == *"$dot"* ]]; do t=${t//"$dot"/"$sl"}; done
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
control_plane_location() {
  local t="$1" rest pd cand
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

# 명령을 세그먼트로 나눠 삭제 동사 뒤의 피연산자 토큰을 판정한다.
# 동사는 세그먼트 **어디에 있어도** 무장한다 — `sudo rm …`·`time rm …` 같은 접두 명령을 열거하지
# 않기 위해서다(열거하면 접두 한 단어로 게이트가 무력해진다 — F67 2차 판정이 `env` 로 실증했다).
CP_DELETE_HIT=""
scan_control_plane_delete() {
  local seg tok base armed
  local -a toks
  # 마지막 세그먼트에는 개행이 없다 — `read` 의 종료 상태만 보면 그 세그먼트를 통째로 흘린다
  # (첫 구현이 그랬고, 배터리가 전부 allow 로 나와 즉시 드러났다).
  while IFS= read -r seg || [[ -n "$seg" ]]; do
    [[ -z "$seg" ]] && continue
    read -r -a toks <<<"$seg"
    armed=0
    # `find … -delete` 는 동사가 술어로 온다. `-exec … rm` 은 아래 동사 검사가 무장한다.
    if [[ "$seg" == *"-delete"* ]]; then
      for tok in "${toks[@]}"; do
        normalize_path_token "$tok"
        if [[ "${NORM_TOK##*/}" == "find" ]]; then armed=1; break; fi
      done
    fi
    for tok in "${toks[@]}"; do
      normalize_path_token "$tok"
      case "${NORM_TOK##*/}" in
        rm|rmdir|unlink|shred|mv) armed=1; continue ;;
      esac
      [[ "$armed" -eq 1 ]] || continue
      [[ -z "$NORM_TOK" || "$NORM_TOK" == -* ]] && continue
      # 후행 글로브는 **그 디렉터리 안**을 비운다 — 디렉터리로 접어 판정한다.
      base=${NORM_TOK##*/}
      case "$base" in
        *'*'*|*'?'*|*'['*)
          if [[ "$NORM_TOK" == */* ]]; then NORM_TOK=${NORM_TOK%/*}; fi
          ;;
      esac
      if control_plane_location "$NORM_TOK"; then CP_DELETE_HIT="$tok"; return 0; fi
    done
  done < <(printf '%s' "$NORMALIZED_CMD" | tr ';|&' '\n\n\n')
  return 1
}

# 삭제 동사가 아예 없는 명령(대부분)은 토큰 순회를 건너뛴다.
if [ "$PURE_READ" -eq 0 ] \
   && [[ "$NORMALIZED_CMD" =~ (^|[^A-Za-z0-9_])(rm|rmdir|unlink|shred|mv|find)([^A-Za-z0-9_]|$) ]] \
   && scan_control_plane_delete; then
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
