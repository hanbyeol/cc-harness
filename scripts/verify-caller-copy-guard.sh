#!/usr/bin/env bash
#
# verify-caller-copy-guard.sh — F62 사본 목록 가드의 mutation 배터리 (상설)
#
# 왜 상설인가: 이 가드는 다섯 차례 판정에서 매번 새로운 우회가 발견됐고, 그때마다
# 임시 스크립트로 재현했다. 배터리가 저장소 밖에 있으면 다음 수정이 무엇을 잃는지
# 아무도 자동으로 알 수 없다 — 실제로 3차 수정이 직전 버전이 잡던 드리프트를 놓치는
# 회귀를 만들었고, bats는 628건 전부 초록이었다. 가드를 고칠 때는 이 배터리를 먼저 돌린다.
#
# 각 케이스는 pristine lab(git archive HEAD + git init)에서 독립 실행된다 — 한 케이스의
# staged 파일이 다음으로 새면 결과가 오염된다(4차 판정에서 실제로 발생).
#
# 사용법: bash scripts/verify-caller-copy-guard.sh [작업디렉토리]
# 종료코드: 기대와 다른 결과가 하나라도 있으면 1
#
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${1:-$(mktemp -d)}"
LAB="$WORK/lab"
FAILED=0

_strip() {   # 진짜 사본에서 지시 삭제
  python3 - "$1" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
open(p, 'w').write(re.sub(r'[^\n]*test-writer[^\n]*isolation[^\n]*worktree[^\n]*\n', '', s))
PY
}
_strip_all() {   # 사본 경로는 계약에서 읽는다 — 여기 다시 적으면 AC-1이 없앤 중복이
                 # 세 번째 장소에 생긴다(6차 판정 지적). lab 안에서 호출되므로 상대 경로.
  local f
  while IFS= read -r f; do
    [ -n "$f" ] && _strip "$f"
  done < <(jq -r '._caller_side_copies.files[]?' progress/contracts/sprint-45.json 2>/dev/null)
}
_set_list() {
  python3 - "$@" <<'PY'
import json, sys
p = 'progress/contracts/sprint-45.json'; d = json.load(open(p))
d['_caller_side_copies']['files'] = sys.argv[1:]
json.dump(d, open(p, 'w'), ensure_ascii=False, indent=2); open(p, 'a').write('\n')
PY
}
_decoy() { mkdir -p "$(dirname "$1")"; printf '# decoy\ntest-writer는 `isolation: "worktree"`로 디스패치.\n' > "$1"; }

_fresh() {
  rm -rf "$LAB"; mkdir -p "$LAB"
  (cd "$REPO" && git archive HEAD) | tar -x -C "$LAB"
  cp "$REPO/tests/skill-frontmatter.bats" "$LAB/tests/"
  (cd "$LAB" && git init -q && git add -A \
     && git -c user.email=t@t -c user.name=t commit -qm base) >/dev/null 2>&1
}

_run() {   # _run <라벨> <기대 실패 단언들|none> <셋업 함수>
  local label="$1" expect="$2" setup="$3"
  _fresh
  ( cd "$LAB" && $setup >/dev/null 2>&1
    got=$(bats tests/skill-frontmatter.bats 2>&1 | grep -E '^not ok' | awk '{print "#"$3}' | sort | tr '\n' ' ' | sed 's/ $//')
    [ -n "$got" ] || got="none"
    if [ "$got" = "$expect" ]; then
      printf '  ok    %-32s %s\n' "$label" "$got"
    else
      printf '  FAIL  %-32s 기대=%s 실제=%s\n' "$label" "$expect" "$got"; exit 1
    fi ) || FAILED=1
}

# --- 케이스 ---
c_pristine() { true; }
# universe 밖 미등록 사본. agents/ 는 쓰지 않는다 — 그곳에 파일을 만들면 plugin.json 개수
# 검사(#5)와 frontmatter 검사(#8)까지 함께 실패해 F62 가드의 반응과 섞인다.
c_e4()       { _decoy docs/DISPATCH.md; git add -A; }
c_name_dir() { printf '\ntest-writer는 `isolation: "worktree"`로 디스패치.\n' >> skills/progress/SKILL.md; git add -A; }
# _strip_all 은 계약에서 사본 경로를 읽으므로 **목록을 바꾸기 전에** 호출해야 한다.
# 순서를 뒤집으면 decoy를 지우게 되어 진짜 사본이 남는다(이 배터리가 스스로 잡은 부작용).
c_t2()       { _strip_all; local i; for i in 1 2 3 4; do _decoy "docs/d$i.md"; done; git add -A
               _set_list docs/d1.md docs/d2.md docs/d3.md docs/d4.md; }
c_t3()       { _strip_all; mkdir -p .tmp; printf '.tmp/\n' >> .gitignore
               local i; for i in 1 2 3 4; do _decoy ".tmp/d$i.md"; done
               _set_list .tmp/d1.md .tmp/d2.md .tmp/d3.md .tmp/d4.md; }
c_m1()       { _set_list CLAUDE.md skills/implement/SKILL.md templates/CLAUDE.md.tmpl
               _strip templates/docs/HARNESS-GUIDE.md; }
c_dup()      { _strip_all; _set_list CLAUDE.md CLAUDE.md CLAUDE.md CLAUDE.md; }
c_rogue()    { _decoy skills/debug/rogue.md; git add -A; }
c_empty()    { _set_list; }
c_strip1()   { _strip templates/docs/HARNESS-GUIDE.md; }

echo "F62 caller-copy guard 배터리 ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
_run "pristine"                  "none"          c_pristine
_run "E4 universe 밖 미등록"     "#11"           c_e4
_run "이름충돌 skills/progress"  "#11"           c_name_dir
_run "t2 범위 밖 decoy 붕괴"     "#12"           c_t2
_run "t3 gitignored decoy"       "#12"           c_t3
_run "M1' 목록축소+지시삭제"     "#13"           c_m1
_run "중복 패딩 + 전삭제"        "#10 #11 #13"   c_dup
_run "(b) 미등록 사본 신설"      "#11"           c_rogue
_run "목록 비우기"               "#10 #11 #13"   c_empty
_run "(a) 목록 파일 지시 삭제"   "#10 #11"       c_strip1

rm -rf "$LAB"
[ "$FAILED" -eq 0 ] && echo "배터리 통과" || echo "배터리 실패 — 가드가 기대와 다르게 동작한다"
exit "$FAILED"
