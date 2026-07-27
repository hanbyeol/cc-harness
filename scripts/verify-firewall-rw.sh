#!/usr/bin/env bash
#
# verify-firewall-rw.sh — 방화벽의 읽기/쓰기 판정 배터리 (F63, 상설)
#
# 왜 상설인가: F63은 보호 경로에서 읽기와 쓰기를 가르는 변경이고, 그 경계는 "도구 이름"이
# 아니라 "쓰기 술어"가 정한다. 술어가 실제 쓰기 집합보다 좁으면 조용히 우회가 열린다 —
# 구현 중 경로 목록 불일치로 4건, 1차 판정에서 플래그 토큰화·sed w 명령으로 54건이
# 그렇게 열렸고 둘 다 배터리가 잡았다. bats는 두 경우 모두 전부 초록이었다.
#
# 형태 축을 반드시 포함한다: 1차 판정의 지적이 "전후 대조만 규정하고 대조 입력의
# 커버리지를 규정하지 않으면 입력이 좁을 때 항상 통과한다"였다.
#
# 사용법: bash scripts/verify-firewall-rw.sh [저장소경로]
# 종료코드: 읽기가 ask이거나 쓰기가 allow면 1
#
set -uo pipefail
REPO="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
FW="$REPO/hooks/pre-bash-firewall.sh"
FAILED=0

# 보호 대상 — is_protected/INV-12가 다루는 경로 계열을 대표한다
TARGETS=(
  "progress/harness-config.json"
  "hooks/lib.sh"
  "hooks/hooks.json"
  "hooks/invariant-guard.sh"
  "tests/probes.bats"
  "docs/INVARIANTS.md"
  "progress/feature_list.json"
  ".claude/settings.json"
  ".claude/settings.local.json"
)

# 읽기 형태 — 전부 allow여야 한다(과탐이면 승인 프롬프트가 반복된다)
READS=(
  "sed -n '1,20p' %s"
  "sed -n 5p %s"
  "sed -n '/word/p' %s"
  "sed 's/a/b/' %s"
  "awk 'NR<10' %s"
  "awk '{print \$1}' %s"
  "awk -F: '{print}' %s"
  "grep -c x %s"
  "cat %s"
  "head -5 %s"
  "tail -5 %s"
  "wc -l %s"
)

# 쓰기 형태 — 전부 ask여야 한다(하나라도 allow면 보호 상실)
WRITES=(
  "sed -i 's/a/b/' %s"
  "sed -i.bak 's/a/b/' %s"
  "sed -ie 's/a/b/' %s"
  "sed -ni 's/a/b/' %s"
  "sed -in 's/a/b/' %s"
  "sed --in-place 's/a/b/' %s"
  "sed -n 'w %s' src.txt"
  "sed 's/x/y/w %s' src.txt"
  "sed 'w %s' src.txt"
  "sed -n 'w%s' src.txt"
  "sed 's/x/y/w%s' src.txt"
  "sed -n '1w %s' src.txt"
  "sed -n '/re/w %s' src.txt"
  "sed 's/a/b/' %s -i"
  "sed --expression='w %s' src.txt"
  "awk -v f=%s '{print > f}' src.txt"
  "awk 'BEGIN{f=\"%s\"; print \"x\" > f}'"
  "awk 'BEGIN{system(\"rm %s\")}'"
  "perl -i -pe 's/a/b/' %s"
  "perl -i.bak -pe 's/a/b/' %s"
  "perl -pi -e 's/a/b/' %s"
  "awk -i inplace '{print}' %s"
  "awk -iinplace '{print}' %s"
  "awk --in-place '{print}' %s"
  "awk '{print > \"%s\"}' src.txt"
  "echo x > %s"
  "echo x >> %s"
  "cp /tmp/x %s"
  "mv /tmp/x %s"
  "install /tmp/x %s"
  "rsync /tmp/x %s"
  "ln -sf /tmp/x %s"
  "tee %s < /tmp/x"
  "truncate -s 0 %s"
  "dd of=%s if=/tmp/x"
  "vim %s"
  "ed %s"
  "patch %s < p.diff"
  "python3 -c open %s"
  "node -e writeFileSync %s"
  # 3차 판정 — 프로그램이 파일에 있어 쓰기 수단이 명령행에 나타나지 않는 형태.
  # 부정 조건(-i·-v·print>·system 부재)만 보는 술어는 이것을 구조적으로 볼 수 없다.
  "awk -f prog.awk %s"
  "awk --file=prog.awk %s"
  "awk -E prog.awk %s"
  "awk --exec=prog.awk %s"
  "awk --include=inplace '{print}' %s"
  # 3차 판정 — GNU sed의 s///e는 패턴 공간을 셸로 실행한다(읽기가 아니라 임의 실행).
  "sed 's/.*/touch pwned/e' %s"
  "sed 's/a/b/e' %s"
  "sed 's/a/b/ge' %s"
  # 이름 변형 — 경로는 명령행에 그대로 보이는데 단어경계가 g 접두를 놓친다
  "gsed -i 's/a/b/' %s"
  "gsed -n 'w %s' src.txt"
  "gawk -i inplace '{print}' %s"
  "mawk -i inplace '{print}' %s"
  "sponge %s"
  # 4차 판정 — 앵커는 인자 **형태**만 보고 그 인자가 놓인 **셸 문맥**은 보지 않는다.
  # ${IFS}가 공백을 대신하므로 `[^ ']+$` 파일 슬롯에 명령 치환이 통째로 들어간다.
  "awk '{print}' \$(cp\${IFS}src.txt\${IFS}%s)"
  "sed -n 5p \$(cp\${IFS}src.txt\${IFS}%s)"
  "awk 'NR<10' \`cp src.txt %s\`"
  "sed -n '1,5p' \$(tee\${IFS}%s)"
  # 4차 판정 별건 — 인용부호 안의 `;`가 ASK 패턴의 [^;|&]* 스팬을 끊는다
  "sed -n 'p;w %s' src.txt"
  "sed 'p;s/a/b/w %s' src.txt"
  # 5차 판정 — 중괄호 없는 $IFS + 프로세스 치환. 배제 문자를 열거한 4차 가드가 빠뜨린 조합이다.
  "awk '{print}' <(patch\$IFS./%s\$IFS./p.diff)"
  "sed -n 5p <(cp\$IFS/tmp/x\$IFS./%s)"
  "awk 'NR<10' <(tee\$IFS%s)"
  "sed -n 1p \$IFS%s"
  # 5차 별건 — 인용 세미콜론이 에디터 arm 밖(cp·tee)에도 남아 있었다
  "cp 'a;b' %s"
  "tee 'a;b' %s"
)

# 읽기지만 화이트리스트가 커버하지 않아 ask로 남는 형태 — 마찰이며 보호 상실이 아니다.
# 목록으로 남겨 두는 이유: 나중에 화이트리스트를 넓힐 때 무엇을 넓히는지 알기 위해서다.
KNOWN_FRICTION=(
  "gsed -n '1,5p' %s"
  "sed -n '\$=' %s"
  "awk -f prog.awk %s"
)

decide() {
  jq -n --arg c "$1" '{tool_name:"Bash",tool_input:{command:$c}}' \
    | bash "$FW" 2>/dev/null \
    | jq -r '.hookSpecificOutput.permissionDecision // "none"' 2>/dev/null || echo "err"
}

R_OK=0; R_BAD=0; W_OK=0; W_BAD=0
BAD_READS=""; BAD_WRITES=""
ALLOWED=()   # 2단계에서 실제로 실행해볼 명령 — 1단계가 allow로 판정한 것 전부

for t in "${TARGETS[@]}"; do
  for fmt in "${READS[@]}"; do
    # shellcheck disable=SC2059
    cmd=$(printf "$fmt" "$t")
    if [ "$(decide "$cmd")" = "allow" ]; then R_OK=$((R_OK+1)); ALLOWED+=("$cmd"); else
      R_BAD=$((R_BAD+1)); BAD_READS="$BAD_READS
    $cmd"; fi
  done
  for fmt in "${WRITES[@]}"; do
    # shellcheck disable=SC2059
    cmd=$(printf "$fmt" "$t")
    if [ "$(decide "$cmd")" = "allow" ]; then
      W_BAD=$((W_BAD+1)); ALLOWED+=("$cmd"); BAD_WRITES="$BAD_WRITES
    $cmd"; else W_OK=$((W_OK+1)); fi
  done
done

echo "방화벽 읽기/쓰기 배터리 — 대상 ${#TARGETS[@]}종 × 읽기 ${#READS[@]}형태 · 쓰기 ${#WRITES[@]}형태"
printf "  읽기 allow : %s / %s\n" "$R_OK" "$((R_OK+R_BAD))"
printf "  쓰기 ask   : %s / %s\n" "$W_OK" "$((W_OK+W_BAD))"

if [ "$R_BAD" -gt 0 ]; then
  echo "  ✗ 읽기인데 ask (과탐 — 승인 프롬프트 유발):$BAD_READS"
  FAILED=1
fi
if [ "$W_BAD" -gt 0 ]; then
  echo "  ✗ 쓰기인데 allow (보호 상실):$BAD_WRITES"
  FAILED=1
fi

# === 2단계: allow 판정분을 실제로 실행해 파일이 바뀌지 않는지 확인 ===
#
# 왜 필요한가: 1단계는 훅의 판정만 본다 — 술어를 술어로 검사하는 셈이라, 내가 '읽기'라고
# 믿는 형태가 실제로는 쓰기일 때 구조적으로 볼 수 없다. F63 3차 판정이 정확히 그렇게
# 뚫렸다: `awk -f prog.awk <보호경로>` 가 allow였고 실제로 파일을 덮어썼는데, 1단계
# 배터리는 468건 전부 통과를 보고했다. 형태 목록에 없으면 안 보이기 때문이다.
#
# 2단계가 실제로 더하는 것(과장하지 않고 정확히):
#   (1) **READS의 분류 자체를 실행으로 검증한다.** 내가 '읽기'라고 믿고 READS에 넣은 형태가
#       사실 쓰기면 1단계는 allow를 기대값과 일치한다고 보고하고 넘어간다 — 2단계만이 잡는다.
#       3차 판정의 `awk -f`가 정확히 그 성질이었다(부정 조건을 전부 통과하는 '읽기처럼 보이는 쓰기').
#   (2) 1단계가 새어나갔다고 판정한 WRITE가 **실제로 파일을 바꾸는지** 확인한다 — 판정 불일치와
#       실제 보호 상실을 구분해준다.
# 2단계가 하지 못하는 것: 두 목록에 **없는** 형태의 발견. ALLOWED는 목록에서 나오므로
# 열거되지 않은 우회는 여기서도 보이지 않는다. 목록의 출처 규정(SC-1)이 여전히 1차 방어선이다.
# 실행에는 워치독이 필요하다 — allow가 샌 명령이 vim처럼 대화형이면 배터리가 멈춘다.
# macOS에는 timeout이 없으므로 perl의 alarm으로 폴백한다(alarm은 exec 후에도 유지되며
# SIGALRM 기본 동작이 종료다). 셋 다 없을 때만 건너뛰고, 그 사실을 명시적으로 보고한다.
GUARD=""
if command -v timeout &>/dev/null; then GUARD="timeout"
elif command -v gtimeout &>/dev/null; then GUARD="gtimeout"
elif command -v perl &>/dev/null; then GUARD="perl"
fi

run_guarded() {
  case "$GUARD" in
    perl) perl -e 'alarm 5; exec("bash","-c",$ARGV[0])' "$1" ;;
    *)    "$GUARD" 5 bash -c "$1" ;;
  esac
}

manifest() { find . -type f -exec shasum {} \; 2>/dev/null | LC_ALL=C sort; }

if [ -z "$GUARD" ]; then
  echo "  ⚠ 2단계 건너뜀 — timeout·gtimeout·perl 중 어느 것도 없어 워치독을 걸 수 없다."
  echo "    allow 판정분의 실행 검증이 수행되지 않았다(조용한 축소가 아니라 명시적 보고)."
else
  SANDBOX=$(mktemp -d)
  trap 'rm -rf "$SANDBOX"' EXIT
  (
    cd "$SANDBOX" || exit 1
    mkdir -p progress hooks tests docs .claude
    for t in "${TARGETS[@]}"; do mkdir -p "$(dirname "$t")"; printf 'ORIGINAL\n' > "$t"; done
    printf 'SRC\n' > src.txt
    # 쓰기 프로그램이 담긴 파일 — 명령행에 쓰기 수단이 전혀 나타나지 않는 형태의 재료
    printf 'BEGIN{ print "PWNED" > "hooks/lib.sh" }\n' > prog.awk
    printf 'w hooks/lib.sh\n' > prog.sed
  )

  MUTATED=0; MUTATED_LIST=""
  for cmd in "${ALLOWED[@]}"; do
    before=$( cd "$SANDBOX" && manifest )
    ( cd "$SANDBOX" && run_guarded "$cmd" ) >/dev/null 2>&1 </dev/null || true
    after=$( cd "$SANDBOX" && manifest )
    if [ "$before" != "$after" ]; then
      MUTATED=$((MUTATED+1)); MUTATED_LIST="$MUTATED_LIST
    $cmd"
      ( cd "$SANDBOX" && rm -rf ./* && mkdir -p progress hooks tests docs .claude
        for t in "${TARGETS[@]}"; do mkdir -p "$(dirname "$t")"; printf 'ORIGINAL\n' > "$t"; done
        printf 'SRC\n' > src.txt
        printf 'BEGIN{ print "PWNED" > "hooks/lib.sh" }\n' > prog.awk
        printf 'w hooks/lib.sh\n' > prog.sed )
    fi
  done

  printf "  실행 검증  : %s건 실행, 파일 변경 %s건\n" "${#ALLOWED[@]}" "$MUTATED"
  if [ "$MUTATED" -gt 0 ]; then
    echo "  ✗ allow인데 실제로 파일을 바꿨다:$MUTATED_LIST"
    FAILED=1
  fi
fi

# 알려진 마찰 — 읽기인데 화이트리스트가 커버하지 않아 ask로 남는 형태. 실패로 치지 않고
# 보고만 한다. 화이트리스트가 하한이라는 사실을 숫자로 남겨, 넓힐 때 무엇을 넓히는지 보이게 한다.
FRICTION=0
for t in "${TARGETS[@]}"; do
  for fmt in "${KNOWN_FRICTION[@]}"; do
    # shellcheck disable=SC2059
    [ "$(decide "$(printf "$fmt" "$t")")" != "allow" ] && FRICTION=$((FRICTION+1))
  done
done
printf "  알려진 마찰 : %s / %s (읽기지만 ask — 보호 상실 아님)\n" \
  "$FRICTION" "$((${#TARGETS[@]} * ${#KNOWN_FRICTION[@]}))"

[ "$FAILED" -eq 0 ] && echo "  배터리 통과"
exit "$FAILED"
