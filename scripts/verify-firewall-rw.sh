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
)

decide() {
  jq -n --arg c "$1" '{tool_name:"Bash",tool_input:{command:$c}}' \
    | bash "$FW" 2>/dev/null \
    | jq -r '.hookSpecificOutput.permissionDecision // "none"' 2>/dev/null || echo "err"
}

R_OK=0; R_BAD=0; W_OK=0; W_BAD=0
BAD_READS=""; BAD_WRITES=""

for t in "${TARGETS[@]}"; do
  for fmt in "${READS[@]}"; do
    # shellcheck disable=SC2059
    cmd=$(printf "$fmt" "$t")
    if [ "$(decide "$cmd")" = "allow" ]; then R_OK=$((R_OK+1)); else
      R_BAD=$((R_BAD+1)); BAD_READS="$BAD_READS
    $cmd"; fi
  done
  for fmt in "${WRITES[@]}"; do
    # shellcheck disable=SC2059
    cmd=$(printf "$fmt" "$t")
    if [ "$(decide "$cmd")" = "allow" ]; then
      W_BAD=$((W_BAD+1)); BAD_WRITES="$BAD_WRITES
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
[ "$FAILED" -eq 0 ] && echo "  배터리 통과"
exit "$FAILED"
