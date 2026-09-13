#!/usr/bin/env bats
# F65 SC-11 — 동사 위치 표기 축의 **생성 규칙** 검증 (sprint-51 step 15, 2026-09-11).
#
# tests/pre-bash-firewall.bats 의 F65 테스트들은 판정 라운드가 찾은 인스턴스를 손으로 옮겨
# 적은 목록이다 — 33~37차 다섯 라운드가 같은 메타 결함("열거가 축을 덮는다고 선언")으로
# 반려·재발을 반복했고, 37차는 계약에 이미 적힌 SC-10(4)(상한 fail-closed)·SC-10(6)(모든
# 무장 지점)을 같은 라운드에서 다시 어겼다. 손으로 쓴 코퍼스(66셀)가 상한 경계·4번째 지점·
# 구성 조합을 하나도 담지 못했기 때문이다. 이 파일은 축을 **곱으로 생성**한다:
#
#   {구성: 파라미터 확장·명령 치환·백틱·콤마 중괄호·퇴화 범위 중괄호·인용 분할·백슬래시}
#   × {위치: 삭제 동사 토큰(rm·rmdir·unlink·mv·shred)·find 토큰·-delete 술어 토큰}
#   × {문맥: bare 세그먼트·$( ) 스팬 안·백틱 스팬 안·bash -c 래퍼·eval 래퍼}
#   × {한 토큰 안의 구성 수: 1·2(서로 다른 구성, 서로 다른 삽입 위치)}
#
# 모든 셀은 ask 또는 deny 여야 하고, allow 를 기대하는 셀은 sprint-51.json 의
# `_residual_risk_AC11.open_axes_2026_08_04` 키에 먼저 귀속돼야 한다(SC-10(7)) — 이 파일은
# 귀속 키의 존재를 jq 로 확인한 뒤에만 그 셀을 건너뛴다. 새 구성·문맥은 풀에 add-only 로
# 추가한다. 풀에서 원소를 빼는 것은 사용자 승인 없이 불가(SC-11(2)).
#
# 별도 파일인 이유: 셀 수가 수백 개라 기존 스위트(345개, ~5분)에 합치면 실행 시간이 두 배가
# 된다. invariant-guard 의 tests/*.bats 보호(INV-6, @test 삭제 금지)는 이 파일에도 적용된다.

setup() {
  HOOK="$BATS_TEST_DIRNAME/../hooks/pre-bash-firewall.sh"
  CONTRACT="$BATS_TEST_DIRNAME/../progress/contracts/sprint-51.json"
}

run_firewall() {
  # stderr 를 합친다 — Layer 1·2 BLOCKED 는 평문으로 **stderr** 에 나가고 비영 종료한다.
  # 이걸 합치지 않으면 `$({rm…})` 같은 BLOCKED 셀의 stdout 이 비어 decision_of 가 allow 로
  # 오분류한다(37·38차 판정 probe 가 겪은 바로 그 오분류 — bats `run` 은 병합하지만 command
  # substitution 은 stdout 만 잡는다).
  printf '%s' "$1" | bash "$HOOK" 2>&1
}

# tests/pre-bash-firewall.bats::wired_firewall 과 동일 — 데이터 플레인 게이트는 끄고(탐지 훅
# 설치 상태를 만든다) 컨트롤 플레인 삭제 게이트만 본다.
wired_firewall() {
  local root="$BATS_TEST_TMPDIR/plugin"
  mkdir -p "$root/hooks"
  cp "$BATS_TEST_DIRNAME/../hooks/protected-integrity.sh" "$root/hooks/"
  cat > "$root/hooks/hooks.json" <<'JSON'
{"hooks":{"PostToolUse":[{"matcher":"Bash","hooks":[{"type":"command",
  "command":"bash \"${CLAUDE_PLUGIN_ROOT}/hooks/protected-integrity.sh\"","timeout":15}]}]}}
JSON
  CLAUDE_PLUGIN_ROOT="$root" run_firewall "$1"
}

delete_decision() {
  local json
  json=$(printf '%s' "$1" | jq -Rs '{tool_input:{command:.}}')
  wired_firewall "$json"
}

# 판정 문자열 하나로 축약한다: blocked / ask / deny / allow. **BLOCKED 를 반드시 구분한다** —
# 37·38차 판정의 probe 가 BLOCKED(Layer 1·2, 평문 출력 + 비영 종료)를 substring 검사에서
# allow 로 오분류해 `$({rm…})`·백틱 형태를 "새는 것"으로 잘못 보고했다(실제로는 실행 자체가
# 차단된다 — ask 보다 강하다). BLOCKED 는 stdout 이 `BLOCKED` 로 시작한다.
decision_of() {
  local out
  out=$(delete_decision "$1")
  case "$out" in
    BLOCKED*) echo blocked ;;
    *'"permissionDecision": "ask"'*) echo ask ;;
    *'"permissionDecision": "deny"'*) echo deny ;;
    *'"permissionDecision": "allow"'*) echo allow ;;
    *) echo allow ;;
  esac
}
# allow 가 아닌(=게이트된) 판정인가? ask·deny·blocked 는 전부 안전한 쪽이다.
gated() { [[ "$(decision_of "$1")" != allow ]]; }

# SC-10(7): allow 를 기대하는 셀은 계약의 잔여 키가 실제로 존재해야만 건너뛸 수 있다.
residual_exists() {
  jq -e --arg k "$1" '._residual_risk_AC11.open_axes_2026_08_04[$k] | type == "object"' "$CONTRACT" >/dev/null
}

# ---------------------------------------------------------------------------
# 원소 풀 (add-only)
# ---------------------------------------------------------------------------
CONSTRUCTS=(param cmdsub backtick brace_comma brace_range quote backslash)
# 위치 풀: 대상 낱말과, 그 낱말을 실제 명령 안에 넣는 템플릿(%s 자리).
TARGETS=(rm rmdir unlink mv shred find -delete)
template_for() {
  case "$1" in
    rm)      echo '%s -rf .claude' ;;
    rmdir)   echo '%s .claude' ;;
    unlink)  echo '%s .claude/settings.json' ;;
    mv)      echo '%s .claude /tmp/sink' ;;
    shred)   echo '%s .claude/settings.json' ;;
    find)    echo '%s .claude -delete' ;;
    -delete) echo 'find .claude %s' ;;
  esac
}
CONTEXTS=(bare dollar backtick bashc eval)

# 구성 하나를 낱말의 i 번째 글자 **앞**에 끼운다 — 셸이 실행 전에 투명하게 다시 써서
# 원래 낱말(또는 원래 낱말 + 무해한 여분 낱말)이 되는 형태만 쓴다.
#   param       r${Z}m        -> rm      (Z 미정의)
#   cmdsub      r$(true)m     -> rm
#   backtick    r`true`m      -> rm
#   brace_comma r{m,q}        -> rm rq   (첫 낱말이 동사)
#   brace_range r{m..m}       -> rm      (퇴화 범위)
#   quote       r'm'          -> rm
#   backslash   r\m           -> rm
wrap_char() {  # $1 construct, $2 char
  case "$1" in
    param)       printf '%s' "\${Z}$2" ;;
    cmdsub)      printf '%s' "\$(true)$2" ;;
    backtick)    printf '%s' "\`true\`$2" ;;
    brace_comma) printf '%s' "{$2,q}" ;;
    brace_range) printf '%s' "{$2..$2}" ;;
    quote)       printf '%s' "'$2'" ;;
    backslash)   printf '%s' "\\$2" ;;
  esac
}

# 낱말 w 에 구성 A 를 i 번째, 구성 B(선택)를 j 번째 글자에 적용해 재구성한다.
build_word() {  # $1 word, $2 constructA, $3 idxA, [$4 constructB, $5 idxB]
  local w="$1" a="$2" ia="$3" b="${4:-}" ib="${5:--1}" out="" k ch
  for ((k = 0; k < ${#w}; k++)); do
    ch="${w:$k:1}"
    if [[ $k -eq $ia ]]; then out+="$(wrap_char "$a" "$ch")"
    elif [[ -n "$b" && $k -eq $ib ]]; then out+="$(wrap_char "$b" "$ch")"
    else out+="$ch"; fi
  done
  printf '%s' "$out"
}

wrap_context() {  # $1 context, $2 cell command
  case "$1" in
    bare)     printf '%s' "$2" ;;
    dollar)   printf '%s' "\$($2)" ;;
    backtick) printf '%s' "\`$2\`" ;;
    bashc)    printf '%s' "bash -c \"$2\"" ;;
    eval)     printf '%s' "eval \"$2\"" ;;
  esac
}

# 문맥별 잔여 귀속: allow 가 정당한 문맥은 여기서만 선언한다(SC-10(7)).
residual_key_for_context() {
  case "$1" in
    eval) echo eval_wrapper ;;
    *) echo "" ;;
  esac
}

# 한 문맥의 곱 전체를 돌려 새는 셀을 모은다 — fail-fast 가 아니라 전수 수집(red 목록 확정용).
sweep_context() {  # $1 context
  local ctx="$1" key; key=$(residual_key_for_context "$ctx")
  if [[ -n "$key" ]]; then
    residual_exists "$key" || { echo "문맥 $ctx 의 잔여 키 $key 가 sprint-51.json 에 없다(SC-10(7))"; return 1; }
    echo "context=$ctx: declared residual ($key) — 셀 생성만 하고 판정은 기록만 한다"
  fi
  local -a leaks=()
  local t tpl a b word cell cmd d n=0
  for t in "${TARGETS[@]}"; do
    tpl=$(template_for "$t")
    # 단일 구성 — 두 번째 글자 앞(rm 은 'r'|'m', -delete 는 '-'|'d')
    for a in "${CONSTRUCTS[@]}"; do
      [[ "$ctx" == backtick && "$a" == backtick ]] && continue   # 백틱 안의 백틱은 셸 문법상 불가
      word=$(build_word "$t" "$a" 1)
      # shellcheck disable=SC2059
      cell=$(printf "$tpl" "$word"); cmd=$(wrap_context "$ctx" "$cell")
      d=$(decision_of "$cmd"); n=$((n + 1))
      if [[ "$d" == allow ]]; then
        if [[ -n "$key" ]]; then echo "residual[$key] allow: $cmd"; else leaks+=("$cmd"); fi
      fi
    done
    # 두 구성 — 서로 다른 구성을 첫 글자·두 번째 글자 앞에
    for a in "${CONSTRUCTS[@]}"; do
      for b in "${CONSTRUCTS[@]}"; do
        [[ "$a" == "$b" ]] && continue
        [[ "$ctx" == backtick && ( "$a" == backtick || "$b" == backtick ) ]] && continue
        word=$(build_word "$t" "$a" 0 "$b" 1)
        # shellcheck disable=SC2059
        cell=$(printf "$tpl" "$word"); cmd=$(wrap_context "$ctx" "$cell")
        d=$(decision_of "$cmd"); n=$((n + 1))
        if [[ "$d" == allow ]]; then
          if [[ -n "$key" ]]; then echo "residual[$key] allow: $cmd"; else leaks+=("$cmd"); fi
        fi
      done
    done
  done
  echo "context=$ctx cells=$n leaks=${#leaks[@]}"
  if [[ ${#leaks[@]} -gt 0 ]]; then
    printf 'LEAK %s\n' "${leaks[@]}"
    return 1
  fi
}

@test "F65 SC-11 생성 규칙: bare 세그먼트 — {구성}×{동사·find·-delete}×{단일·2중} 전수 ask/deny" {
  run sweep_context bare
  echo "$output"
  [ "$status" -eq 0 ]
}

@test "F65 SC-11 생성 규칙: \$( ) 스팬 안 — 같은 곱 전수 ask/deny (SC-10(6) 4번째 지점)" {
  run sweep_context dollar
  echo "$output"
  [ "$status" -eq 0 ]
}

@test "F65 SC-11 생성 규칙: 백틱 스팬 안 — 같은 곱(백틱 구성 제외) 전수 ask/deny (SC-10(6) 4번째 지점)" {
  run sweep_context backtick
  echo "$output"
  [ "$status" -eq 0 ]
}

@test "F65 SC-11 생성 규칙: bash -c 래퍼 안 — 같은 곱 전수 ask/deny (AC-12 코드 전달 경로)" {
  run sweep_context bashc
  echo "$output"
  [ "$status" -eq 0 ]
}

@test "F65 SC-11 생성 규칙: eval 래퍼 — 계약에 귀속된 잔여(eval_wrapper)라야 allow 를 허용한다 (SC-10(7))" {
  # eval 은 -c 모양 플래그가 없는 셸 텍스트 전달 메커니즘이라 wrapper_code_delivery_mechanism
  # 의 현재 열거 밖이다(37차 판정 발견, 선행 갭 — 이 step 에서 닫지 않고 등록만 한다).
  # 이 테스트는 (1) 잔여 키가 계약에 존재하고 (2) 곱을 생성해 실행할 수 있음만 확인한다.
  # 잔여가 닫히면 residual_key_for_context 에서 eval 을 빼는 것만으로 이 문맥이 게이트된다.
  run sweep_context eval
  echo "$output"
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# SC-11(1) 네 번째 차원 — 확장 결과가 담는 내용(expansion payload). 38차 독립 판정(2026-09-11):
# 위 곱은 구성을 낱말 **안에** 끼우고 피연산자를 별도 낱말로 두므로, `{rm,-rf,.claude}` 처럼
# 한 콤마 중괄호 토큰이 동사와 컨트롤 플레인 경로를 **함께** 품는 셀을 구조적으로 만들 수
# 없었다(초기 코드부터 allow + 격리 랩 실제 삭제). 여기서는 payload 를 별도 풀로 생성한다.
# ---------------------------------------------------------------------------
# **대상 표기도 생성 인자다(39차 독립 판정 criteria_gaps, 2026-09-11).** 초판은 여기에
# 컨트롤 플레인 대상을 두 리터럴로 하드코딩했다 — 축이 38차가 지적한 지점보다 한 단계 더
# 아래에서 다시 좁혀진 것이라, `{rm,-rf,x/../.claude}`(`..` 를 거쳐 같은 대상에 도달하는 표기)
# 를 스위트가 구조적으로 만들 수 없었다(그 셀은 allow + 격리 랩 실제 삭제였다). 대상과 표기를
# 분리해 곱으로 만든다.
# **대상 풀은 판정 함수의 모든 팔에 닿아야 한다(SC-12(8), 41차 독립 판정 criteria_gaps,
# 2026-09-13).** 40차 대응의 풀은 세 개였고 그 중 어느 것도 `__control_plane_location_impl()` 의
# **꼬리 추출 팔**(`rest=${t##*.claude/}` → `plugins`·`plugins/<이름>`·`hooks`·`hooks/*.sh`)에
# 닿지 않았다. 그래서 대소문자 인자를 추가했는데도 그 팔의 비대칭(파라미터 확장은 `nocasematch`
# 의 지배를 받지 않는다)을 구조적으로 볼 수 없었고, 41차가 `find .CLAUDE/plugins -delete` 로
# `.claude/plugins/**` 실제 삭제를 실증했다. 아래 풀은 판정 함수의 팔 목록에서 역으로 도출한
# 것이다 — 팔을 추가하면 이 풀에도 대표 대상을 추가한다.
CP_BASE_TARGETS=(
  '.claude'                         # (b) 꼬리 없음
  '.claude/settings.json'           # (a) 배선 파일
  '.claude/settings.local.json'     # (a) 배선 파일
  'hooks/hooks.json'                # (a) 배선 파일
  '.claude/plugins'                 # (b) 플러그인 설치 루트
  '.claude/plugins/myplug'          # (b) 이름 붙은 플러그인
  '.claude/hooks'                   # (b) 꼬리가 hooks
  '.claude/worktrees/wt1/hooks'     # (b) 중첩된 hooks 꼬리
  '.claude/hooks/invariant-guard.sh' # (b) hooks 안의 개별 훅 파일
  'hooks'                           # (c) 실체 앵커(프로젝트 루트의 hooks/hooks.json)
)
# 환경 접두도 표기 인자다 — 미전개 `$PWD` 는 셸이 cwd 로 펴지만 (c) 팔의 실체 앵커를
# 무력화해 `find $PWD/hooks -delete` 가 allow 였다(41차, 랩에서 hooks/hooks.json 실제 삭제).
CP_ENV_PREFIXES=('$PWD/' '${PWD}/')
# ---------------------------------------------------------------------------
# **표기 풀은 가드 자신의 접기 규칙에서 도출된다(SC-12(1)·(3), 40차 독립 판정 criteria_gaps,
# 2026-09-12).** 39차 대응까지 이 자리는 손으로 쓴 리터럴 7개였다 — 38차(페이로드 내용) →
# 39차(대상 표기) → 40차(접기 규칙의 **위치형**·비교 의미)가 같은 메타 결함을 한 층씩 아래에서
# 반복한 이유가 그것이다. 매 라운드가 직전 판정이 실측한 인스턴스만 목록에 더했고, 풀이 가드의
# 규칙에서 나오지 않는 한 '가드가 아는 규칙'과 '테스트가 아는 규칙'의 차이가 곧 다음 누수가
# 됐다. 아래 표는 `normalize_path_token()` 이 접는 규칙을 그대로 옮긴 것이며, 각 규칙을
# **접두형·중간형·말단형** 세 위치로 기계 전개한다. 40차가 격리 랩에서 실제 삭제를 실증한 누수
# (`find .claude/. -delete`·`find .claude/hooks/.. -delete`)가 정확히 '중간형만 구현된 규칙의
# 말단형'이었다 — 규칙을 코드에 더하면 이 생성기가 그 규칙의 세 위치형을 자동으로 낸다.
# **규칙은 조합되고, 조합도 생성된다(SC-14(4), 42차 독립 판정 criteria_gaps, 2026-09-13).**
# 40~41차 대응은 규칙을 **하나씩만** 돌았고 규칙끼리 겹친 형태는 `combo` 팔에 손으로 쓴 리터럴
# 3개였다. 그래서 42차가 실측한 `$PWD//hooks`(접두 규칙 + `//` 규칙의 겹침 — 접두 제거가 `//`
# 접기보다 먼저 돌아 절대 경로 `/hooks` 가 남고, 그것이 이름 패턴에는 맞지만 실체 앵커 둘을
# 모두 비켜갔다 + 랩에서 `hooks/hooks.json` 실제 삭제)를 생성기가 만들 수 없었다. 39차가
# '리터럴 7개'로 지적한 결함이 한 층 아래(규칙 조합)에서 반복된 것이다 — 이제 조합을 **생성**한다.
#
# 규칙을 두 갈래로 나눈다. **내부 규칙**은 경로 안에서 접히는 것(`//`·`/./`·`seg/../`)이라
# 서로 자유롭게 합성해도 같은 파일을 가리킨다. **경계 규칙**(미전개 환경 접두)은 경로 앞에
# 절대 경로를 붙이는 것이라 합성 순서가 의미를 바꾼다 — `x/../$PWD/hooks` 는 `$PWD` 가 절대
# 경로여서 `hooks` 와 **다른 파일**이고, `$PWD/$PWD/hooks` 도 그렇다. 그래서 경계 규칙은 항상
# **가장 바깥에 한 번만** 적용한다(그 제약이 곧 '합성은 동일 파일을 보존해야 한다'는 규칙이다).
CP_FOLD_RULES=(dsl dot dotdot)          # 내부 규칙 — 서로 합성 가능
CP_FOLD_OUTER_RULES=(envpfx)            # 경계 규칙 — 가장 바깥, 한 번만
CP_FOLD_CHILD='sub'   # 말단 `seg/..` 형이 경유하는 자식 세그먼트 이름
cp_fold_spellings() {  # $1 target, $2 rule -> 같은 대상을 가리키는 표기들
  local x="$1" r="$2"
  case "$r" in
    dsl)      # `//` → `/`
      printf '%s\n' ".//$x" "$x//"
      if [[ "$x" == */* ]]; then printf '%s\n' "${x%%/*}//${x#*/}"; fi
      ;;
    dot)      # `/./` → `/` (말단형이 40차 누수 계열)
      printf '%s\n' "./$x" "$x/" "$x/."
      if [[ "$x" == */* ]]; then printf '%s\n' "${x%%/*}/./${x#*/}"; fi
      ;;
    dotdot)   # `seg/../` 제거 (말단형이 40차 누수 계열)
      printf '%s\n' "x/../$x" "a/b/../../$x" "$x/../$x" "$x/$CP_FOLD_CHILD/.."
      if [[ "$x" == */* ]]; then printf '%s\n' "${x%%/*}/$CP_FOLD_CHILD/../${x#*/}"; fi
      ;;
    envpfx)   # 미전개 환경 접두 — 셸은 cwd 로 펴는데 실체 앵커 팔이 무력화됐다(41차)
      # **경계 자체가 `//` 자리다(42차)**: 접두와 경로 사이에 슬래시를 하나 더 넣은 형태
      # (`$PWD//hooks`)가 42차가 실측한 누수다. 접두는 슬래시로 끝나므로 `$p/$x` 가 그 형태다.
      local p
      for p in "${CP_ENV_PREFIXES[@]}"; do printf '%s\n' "$p$x" "$p/$x"; done
      ;;
  esac
}
cp_notations() {  # $1 target -> 정경 표기 + 내부 규칙 단일 적용(기존 테스트들이 쓰는 풀)
  local x="$1" r
  printf '%s\n' "$x"
  for r in "${CP_FOLD_RULES[@]}"; do cp_fold_spellings "$x" "$r"; done
  for r in "${CP_FOLD_OUTER_RULES[@]}"; do cp_fold_spellings "$x" "$r"; done
}
# 내부 규칙 쌍의 합성(규칙 r1 산출물에 r2 를 다시 적용) — 조합 폐쇄의 안쪽 절반.
cp_inner_closure() {  # $1 target
  local x="$1" r1 r2 s
  printf '%s\n' "$x"
  for r1 in "${CP_FOLD_RULES[@]}"; do
    cp_fold_spellings "$x" "$r1"
    while IFS= read -r s; do
      for r2 in "${CP_FOLD_RULES[@]}"; do cp_fold_spellings "$s" "$r2"; done
    done < <(cp_fold_spellings "$x" "$r1")
  done
}
# 조합 폐쇄 전체 — 내부 폐쇄 ∪ 경계 규칙(내부 폐쇄의 각 산출물에 한 번). 중복은 호출자가 거른다.
cp_notations_closure() {  # $1 target
  local x="$1" s r
  cp_inner_closure "$x" | while IFS= read -r s; do
    printf '%s\n' "$s"
    for r in "${CP_FOLD_OUTER_RULES[@]}"; do cp_fold_spellings "$s" "$r"; done
  done
}
# **비교 의미도 생성 인자다(SC-12(2)).** 옛 문자열 레이어는 `grep -qiE`(대소문자 무시)인데
# F65 가 그것을 대체한 토큰 축은 대소문자를 구분해서, `rm -rf .CLAUDE` 는 옛 정규식이 잡아
# ask 인데 **새 축에만 존재하는 동사**(`find … -delete`·`mv`·`rmdir`)는 전부 allow 였다 —
# macOS 기본 APFS 가 대소문자를 무시하므로 40차 격리 랩에서 `.claude` 가 통째로 지워졌다.
cp_case_variants() {  # $1 spelling -> 원형 · 전체 대문자 · 첫 알파벳만 대문자
  local x="$1"
  printf '%s\n' "$x"
  printf '%s' "$x" | tr '[:lower:]' '[:upper:]'; printf '\n'
  printf '%s' "$x" | awk '{ i=match($0,/[a-z]/); if (i>0) $0=substr($0,1,i-1) toupper(substr($0,i,1)) substr($0,i+1); print }'
}
# payload 스윕은 문맥마다 도는 비용이 크므로 대표 표기 4개만 쓴다(전체 표기 곱은 아래
# 표기·리터럴 대조 테스트가 bare 문맥에서 전수로 덮는다).
PAYLOAD_OPERANDS=('.claude' './.claude' 'x/../.claude' '.claude/settings.json')
# $1 verb, $2 operand, $3 padding kind(none|extra|alts70|len600) -> 한 토큰짜리 명령
payload_token() {
  local v="$1" o="$2" pad="$3" body
  case "$v" in
    rm)      body="rm,-rf,$o" ;;
    rmdir)   body="rmdir,$o" ;;
    unlink)  body="unlink,$o" ;;
    mv)      body="mv,$o,/tmp/sink" ;;
    shred)   body="shred,$o" ;;
    find)    body="find,$o,-delete" ;;
  esac
  case "$pad" in
    none)   ;;
    extra)  body="$body,-v" ;;
    alts70) body="$body,$(printf 'x%s,' $(seq 1 70) | sed 's/,$//')" ;;
    len600) body="$body,$(printf 'A%.0s' $(seq 1 600))" ;;
  esac
  printf '{%s}' "$body"
}

sweep_payload_context() {  # $1 context
  local ctx="$1" key; key=$(residual_key_for_context "$ctx")
  if [[ -n "$key" ]]; then
    residual_exists "$key" || { echo "문맥 $ctx 의 잔여 키 $key 가 sprint-51.json 에 없다(SC-10(7))"; return 1; }
  fi
  local -a leaks=()
  local v o pad tok cmd d n=0
  for v in rm rmdir unlink mv shred find; do
    for o in "${PAYLOAD_OPERANDS[@]}"; do
      for pad in none extra alts70 len600; do
        tok=$(payload_token "$v" "$o" "$pad"); cmd=$(wrap_context "$ctx" "$tok")
        d=$(decision_of "$cmd"); n=$((n + 1))
        if [[ "$d" == allow ]]; then
          if [[ -n "$key" ]]; then echo "residual[$key] allow: ${cmd:0:80}"; else leaks+=("${cmd:0:100}"); fi
        fi
      done
    done
  done
  echo "payload context=$ctx cells=$n leaks=${#leaks[@]}"
  if [[ ${#leaks[@]} -gt 0 ]]; then printf 'LEAK %s\n' "${leaks[@]}"; return 1; fi
}

@test "F65 SC-11 확장 payload: 동사+컨트롤 플레인 피연산자(+패딩)를 한 콤마 중괄호 토큰에 담아도 bare 문맥에서 전수 ask (38차)" {
  run sweep_payload_context bare
  echo "$output"
  [ "$status" -eq 0 ]
}

@test "F65 SC-11 확장 payload: 같은 토큰을 \$( )·백틱·bash -c 문맥과 인접 대입 뒤에 두어도 전수 ask (38차, SC-10(6))" {
  local ctx
  for ctx in dollar backtick bashc; do
    run sweep_payload_context "$ctx"
    echo "$output"
    [ "$status" -eq 0 ]
  done
  # 접두 대입(`Q=1 …`)·별도 세그먼트 대입 뒤에 오는, **동사가 리터럴인** 콤마 중괄호는 ask.
  # (`Q=1` 은 환경 접두일 뿐 동사 출처가 아니다 — 동사 `rm` 은 중괄호 안 리터럴이다.)
  local c leaks=()
  for c in 'Q=1 {rm,-rf,.claude}' 'Q=1; {rm,-rf,.claude}'; do
    gated "$c" || leaks+=("$c")
  done
  [[ ${#leaks[@]} -eq 0 ]] || { printf 'LEAK %s\n' "${leaks[@]}"; false; }
  # 동사 **값이 변수에서 오고 그 변수 참조가 중괄호 잎 안에 있는** 형태(`V=rm; {$V,-rf,.claude}`)는
  # assign_then_invoke_verb 의 일반 값-추적 잔여(declared residual)다 — 인접 사례(토큰 전체가
  # 정확히 `$V`/`${V}`)만 닫혔고, 잎 안에 박힌 참조는 범위 밖이다. 기록만 한다(경계 이동 감지).
  residual_exists assign_then_invoke_verb
  echo "residual[assign_then_invoke_verb] $(decision_of 'V=rm; {$V,-rf,.claude}'): V=rm; {\$V,-rf,.claude}"
}

@test "F65 SC-11 확장 payload: eval 문맥은 잔여(eval_wrapper) 귀속 확인 후 기록만" {
  run sweep_payload_context eval
  echo "$output"
  [ "$status" -eq 0 ]
}

@test "F65 SC-12 생성기 자기검사: 표기 풀이 조용히 잘리지 않는다 (이 라운드 자체 발견)" {
  # **이 테스트가 있는 이유**: 초판 생성기는 `[[ "$x" == */* ]] && printf …` 로 중간형을 냈는데,
  # 슬래시가 없는 대상(`.claude`)에서 그 조건이 거짓이면 함수의 **마지막 명령이 비영 종료**가
  # 되고 bats 의 `set -e` 가 프로세스 치환 서브셸을 그 자리에서 죽여 풀이 13개에서 3개로 잘렸다.
  # 그런데도 판정 테스트는 전부 초록이었다 — **남은 3개가 전부 통과했기 때문**이다. 축이 조용히
  # 좁아지는 바로 그 실패 양식(38·39·40차가 반복 지적한 것)을 셸 수준에서 다시 재현한 것이므로,
  # 생성기 자신의 산출 수와 핵심 위치형의 존재를 고정한다. 규칙을 add-only 로 더하면 이 수도
  # 함께 올린다 — 수가 맞지 않으면 그 자리에서 실패한다.
  local n
  n=$(cp_notations '.claude' | wc -l | tr -d ' ')
  [[ "$n" -eq 14 ]] || { echo "슬래시 없는 대상의 단일 규칙 표기 수가 14가 아니다: $n (규칙을 더했으면 이 수를 올린다)"; false; }
  n=$(cp_notations '.claude/settings.json' | wc -l | tr -d ' ')
  [[ "$n" -eq 17 ]] || { echo "슬래시 있는 대상의 단일 규칙 표기 수가 17이 아니다: $n"; false; }
  # **조합 폐쇄도 수로 고정한다(SC-14(4), 42차)** — 규칙을 하나씩만 돌던 시절로 조용히 돌아가는
  # 것을 막는다. 42차의 `$PWD//hooks` 는 쌍 합성에서만 나오는 셀이었다.
  n=$(cp_notations_closure 'hooks' | sort -u | wc -l | tr -d ' ')
  [[ "$n" -ge 400 ]] || { echo "조합 폐쇄 셀이 $n 개 — 400 미만이면 쌍 합성이 생성되지 않는다"; false; }
  cp_notations_closure 'hooks' | grep -qFx '$PWD//hooks' \
    || { echo "42차가 실측한 조합 셀(환경 접두 + 이중 슬래시)이 폐쇄에 없다"; false; }
  # 40차가 격리 랩에서 실제 삭제를 실증한 두 말단형이 풀에 반드시 있다.
  cp_notations '.claude' | grep -qx '\.claude/\.' || { echo "말단형(슬래시-점)이 풀에 없다"; false; }
  cp_notations '.claude' | grep -qx '\.claude/sub/\.\.' || { echo "말단형(세그먼트-점점)이 풀에 없다"; false; }
  # 41차가 실증한 환경 접두도 풀에 있어야 한다.
  cp_notations 'hooks' | grep -qx '\$PWD/hooks' || { echo "환경 접두 형태가 풀에 없다"; false; }
  n=$(cp_case_variants '.claude' | sort -u | wc -l | tr -d ' ')
  [[ "$n" -eq 3 ]] || { echo "대소문자 변형이 3종이 아니다: $n"; false; }
  # **대상 풀이 판정 함수의 팔 전체를 덮는지(SC-12(8))** — 팔을 더하면 이 수도 올린다.
  [[ "${#CP_BASE_TARGETS[@]}" -eq 10 ]] \
    || { echo "대상 풀이 10종이 아니다: ${#CP_BASE_TARGETS[@]} (판정 팔을 더했으면 대표 대상도 더한다)"; false; }
  # 꼬리 추출 팔에 닿는 대상이 실제로 들어 있는지 — 41차 누수가 정확히 이 팔에 있었다.
  printf '%s\n' "${CP_BASE_TARGETS[@]}" | grep -qx '\.claude/plugins' || { echo "plugins 팔 대상이 없다"; false; }
  printf '%s\n' "${CP_BASE_TARGETS[@]}" | grep -qx '\.claude/hooks' || { echo "hooks 꼬리 팔 대상이 없다"; false; }
}

@test "F65 SC-12 대상 표기 × 정경 판정 동치 — 규칙 표에서 도출된 어떤 표기도 정경 표기보다 약해지지 않는다 (40차)" {
  # **단정 형태가 parity 가 아니라 정경 동치인 이유(SC-12(4))**: 39차 대응은 '리터럴 철자와
  # 중괄호 철자의 판정이 같은가'를 단정했는데, 40차가 실증한 누수는 두 철자가 **양쪽 모두
  # allow** 였다 — parity 는 성립하므로 구조적으로 잡을 수 없었다. 기준점은 같은 대상의
  # **정경 표기**(`.claude`·`.claude/settings.json`·`hooks/hooks.json`)가 받는 판정이다.
  local tgt op can lit exp fails=()
  for tgt in "${CP_BASE_TARGETS[@]}"; do
    can=$(decision_of "rm -rf $tgt")
    [[ "$can" == allow ]] && fails+=("정경 표기가 allow — 기준점이 무너졌다: rm -rf $tgt")
    while IFS= read -r op; do
      lit=$(decision_of "rm -rf $op")
      exp=$(decision_of "{rm,-rf,$op}")
      [[ "$lit" != "$can" ]] && fails+=("리터럴이 정경과 다름($lit != $can): rm -rf $op")
      [[ "$exp" != "$can" ]] && fails+=("중괄호가 정경과 다름($exp != $can): {rm,-rf,$op}")
    done < <(cp_notations "$tgt")
  done
  [[ ${#fails[@]} -eq 0 ]] || { printf 'MISMATCH %s\n' "${fails[@]}"; false; }
}

@test "F65 SC-12 대상 표기: find/-delete·mv·rmdir 도 같은 표기 곱에서 정경 판정과 같다 (40차)" {
  # 40차가 실증한 말단형 누수는 `rm` 철자에서는 무해했다(BSD rm 이 `.`/`..` 말단을 거부한다) —
  # 피해는 전부 `find`·`mv`·`rmdir` 로 들어왔다. 동사별로 정경 기준점을 따로 잡는다.
  local op v can d fails=()
  for v in 'find %s -delete' 'mv %s /tmp/sink' 'rmdir %s' '{find,%s,-delete}' '{mv,%s,/tmp/sink}' '{rmdir,%s}'; do
    # shellcheck disable=SC2059
    can=$(decision_of "$(printf "$v" '.claude')")
    [[ "$can" == allow ]] && fails+=("정경 표기가 allow — 기준점이 무너졌다: $(printf "$v" '.claude')")
    while IFS= read -r op; do
      # shellcheck disable=SC2059
      d=$(decision_of "$(printf "$v" "$op")")
      [[ "$d" != "$can" ]] && fails+=("정경과 다름($d != $can): $(printf "$v" "$op")")
    done < <(cp_notations '.claude')
  done
  [[ ${#fails[@]} -eq 0 ]] || { printf 'MISMATCH %s\n' "${fails[@]}"; false; }
}

@test "F65 SC-12 비교 의미: 대소문자 변형이 정경 판정과 같다 — 옛 레이어(grep -qiE)와의 대칭 (40차)" {
  # 40차 격리 랩: `find .CLAUDE -delete`·`mv .CLAUDE /tmp/sink`·`rmdir .CLAUDE`·
  # `{find,.CLAUDE,-delete}`·`bash -c "find .CLAUDE -delete"` 가 전부 allow 였고 `.claude` 가
  # 실제로 지워졌다. `rm -rf .CLAUDE` 만 ask 였던 것은 옛 문자열 레이어의 `grep -qiE` 덕이다 —
  # 새 토큰 축이 그보다 약한 비교 의미를 쓰면 대체가 곧 약화가 된다(SC-12(2)).
  # **41차 독립 판정 criteria_gaps(2026-09-13)**: 40차 대응은 이 자리에 피연산자 5개를 손으로
  # 적어 대소문자 인자를 **대상 곱에 교차하지 않았다** — 그 5개 중 어느 것도 판정 함수의 꼬리
  # 추출 팔(`rest=${t##*.claude/}`)에 닿지 않아, `shopt` 이 파라미터 확장을 지배하지 못하는
  # 결함(`find .CLAUDE/plugins -delete` + 실제 삭제)을 스위트가 구조적으로 볼 수 없었다.
  # 이제 **대상 풀 전체 × 대소문자 3종**을 돈다(SC-12(8)).
  local tgt cv v can d fails=()
  for v in 'rm -rf %s' 'find %s -delete' 'rmdir %s' '{find,%s,-delete}'; do
    for tgt in "${CP_BASE_TARGETS[@]}"; do
      # shellcheck disable=SC2059
      can=$(decision_of "$(printf "$v" "$tgt")")
      [[ "$can" == allow ]] && fails+=("정경 표기가 allow — 기준점이 무너졌다: $(printf "$v" "$tgt")")
      while IFS= read -r cv; do
        # shellcheck disable=SC2059
        d=$(decision_of "$(printf "$v" "$cv")")
        [[ "$d" != "$can" ]] && fails+=("정경과 다름($d != $can): $(printf "$v" "$cv")")
      done < <(cp_case_variants "$tgt")
    done
  done
  # 표기 변형과 대소문자 변형이 **겹칠 때**도 약해지지 않는지 — 대표 말단형·경유형에 교차.
  for tgt in '.claude/plugins' '.claude/hooks' 'hooks'; do
    for v in 'find %s -delete' 'mv %s /tmp/sink'; do
      # shellcheck disable=SC2059
      can=$(decision_of "$(printf "$v" "$tgt")")
      for n in "$tgt/." "$tgt/$CP_FOLD_CHILD/.." "x/../$tgt"; do
        while IFS= read -r cv; do
          # shellcheck disable=SC2059
          d=$(decision_of "$(printf "$v" "$cv")")
          [[ "$d" != "$can" ]] && fails+=("표기×대소문자 교차가 정경과 다름($d != $can): $(printf "$v" "$cv")")
        done < <(cp_case_variants "$n")
      done
    done
  done
  [[ ${#fails[@]} -eq 0 ]] || { printf 'MISMATCH %s\n' "${fails[@]}"; false; }
}

@test "F65 SC-14 표기 규칙 조합 폐쇄: 규칙 두 개가 겹친 표기도 정경보다 약하지 않다 (42차)" {
  # 42차가 실측한 `$PWD//hooks`(+ 랩에서 hooks/hooks.json 실제 삭제)는 **규칙 두 개의 겹침**
  # 이었고, 생성기가 규칙을 하나씩만 돌아 그 셀을 만들 수 없었다. 이제 내부 규칙 쌍의 합성에
  # 경계 규칙을 한 번 씌운 폐쇄 전체를 돈다. 비용이 크므로 동사는 `rm -rf` 하나로 고정한다 —
  # 동사 축은 위의 단일 규칙 테스트들이 이미 교차한다(조합은 표기의 성질이고 동사와 직교한다).
  # 대상은 두 앵커 방식의 대표 하나씩: `.claude`(이름 앵커)와 `hooks`(실체 앵커 — 42차 누수가
  # 난 쪽은 이 팔뿐이었다).
  local tgt can op d n fails=()
  for tgt in '.claude' 'hooks'; do
    can=$(decision_of "rm -rf $tgt")
    [[ "$can" == allow ]] && fails+=("정경 표기가 allow — 기준점이 무너졌다: rm -rf $tgt")
    n=0
    while IFS= read -r op; do
      n=$((n + 1))
      d=$(decision_of "rm -rf $op")
      [[ "$d" != "$can" ]] && fails+=("조합 표기가 정경과 다름($d != $can): rm -rf $op")
    done < <(cp_notations_closure "$tgt" | sort -u)
    [[ "$n" -ge 400 ]] || fails+=("$tgt 의 폐쇄 셀이 $n 개 — 400 미만이면 조합이 생성되지 않는다")
  done
  [[ ${#fails[@]} -eq 0 ]] || { printf 'MISMATCH %s\n' "${fails[@]}"; false; }
}

@test "F65 SC-14 효과 등급 하한: 어떤 철자도 같은 효과의 평범한 철자보다 약하지 않다 (42차 제안)" {
  # **이 테스트가 조건 자체다(SC-14(1)~(3)).** 38~42차의 모든 누수가 같은 형태였다 — 어떤
  # 표기가 평범한 철자보다 약했다. 42차의 `find .claude -exec truncate -s 0 {} +`(랩에서
  # settings.json 13→0바이트)는 평범한 철자 `truncate -s 0 .claude/settings.json` 이 ask 인데도
  # allow 였다. 그래서 효과 등급마다 **정경 철자의 판정을 기준점으로 먼저 재고**, 그 철자를
  # 감싼 형태가 그보다 약하지 않은지 본다. 평범한 철자가 allow 인 효과는 하한이 없으므로
  # 비교 대상이 아니다(그 경우는 잔여로 귀속하고 여기서는 기록만 한다).
  local tgt='.claude/settings.json' plain wrapped can d fails=() notes=()
  # {효과 등급 대표 철자} — 배선을 무력화하는 수단은 삭제만이 아니다(SC-14(2)).
  local -a PLAIN=(
    "rm -f %s"                 "unlink %s"              "shred %s"
    "mv %s /tmp/sink43"        "truncate -s 0 %s"       ": > %s"
    "cp /dev/null %s"          "chmod 000 %s"           "dd if=/dev/null of=%s"
  )
  # {그 철자를 감싸는 형태} — find 술어·래퍼·치환·중괄호.
  for plain in "${PLAIN[@]}"; do
    # shellcheck disable=SC2059
    can=$(decision_of "$(printf "$plain" "$tgt")")
    if [[ "$can" == allow ]]; then
      notes+=("하한 없음(평범한 철자가 allow): $(printf "$plain" "$tgt")")
      continue
    fi
    local verb="${plain%% *}"
    local rest="${plain#* }"
    for wrapped in \
      "find ${tgt%/*} -exec ${plain//\%s/{\}} +" \
      "find ${tgt%/*} -exec ${plain//\%s/{\}} \\;" \
      "find ${tgt%/*} -execdir ${plain//\%s/{\}} +" \
      "bash -c \"$(printf "$plain" "$tgt")\"" \
      "{${verb},${rest//\%s/$tgt}}" ; do
      d=$(decision_of "$wrapped")
      [[ "$d" == allow ]] && fails+=("평범한 철자는 $can 인데 감싼 형태가 allow: $wrapped")
    done
  done
  printf '%s\n' "${notes[@]+${notes[@]}}"
  [[ ${#fails[@]} -eq 0 ]] || { printf 'WEAKER %s\n' "${fails[@]}"; false; }
}

@test "F65 SC-13 동사 위치: 동사가 피연산자보다 뒤에 와도 판정된다 — find -exec 계열 (41차, 사용자 범위 결정)" {
  # **단일 패스의 구조적 결함**: `scan_control_plane_delete()` 가 세그먼트를 좌→우로 한 번
  # 훑으며 동사를 만나면 armed 를 켜고 **그 뒤** 토큰만 피연산자로 보기 때문에,
  # `find PATH -exec VERB {} +`(그 삭제의 표준 관용구)에서 PATH 는 armed 이전에 지나쳐
  # 판정되지 않았다. 같은 원인이 `operand_before_verb_ordering`(2026-09-02 등록)과
  # `find_exec_delete_verb`(41차 회전 등록) 두 이름으로 따로 기록돼 있었다.
  # 기준점은 같은 대상을 `-delete` 로 지우는 형태다 — 그것이 ask 이면 `-exec` 도 ask 여야 한다.
  local tgt can d fails=() v
  for tgt in '.claude' '.claude/settings.json' 'hooks/hooks.json' '.claude/plugins' '.claude/hooks'; do
    can=$(decision_of "find $tgt -delete")
    [[ "$can" == allow ]] && fails+=("기준점이 무너졌다: find $tgt -delete")
    for v in "find $tgt -exec rm -rf {} +" "find $tgt -exec rm -rf {} \\;" \
             "find $tgt -execdir rm -rf {} +" "find $tgt -exec unlink {} \\;" \
             "find $tgt -ok rm {} \\;" "find . -name $tgt -exec rm -rf {} +" \
             "find $tgt -exec shred {} \\;" "find $tgt -exec mv {} /tmp/sink \\;"; do
      d=$(decision_of "$v")
      [[ "$d" != "$can" ]] && fails+=("동사가 뒤에 와서 정경과 다름($d != $can): $v")
    done
  done
  # 동사가 앞인 형태와 뒤인 형태의 판정이 같아야 한다(위치 무관) — 문맥 축에도 교차한다.
  for v in 'bash -c "find .claude -exec rm -rf {} +"' '$(find .claude -exec rm -rf {} +)' \
           'Q=1 find .claude -exec rm -rf {} +' 'find .CLAUDE -exec rm -rf {} +' \
           'find .claude/. -exec rm -rf {} +' 'find $PWD/.claude -exec rm -rf {} +'; do
    [[ "$(decision_of "$v")" == allow ]] && fails+=("문맥·표기 교차에서 allow: $v")
  done
  [[ ${#fails[@]} -eq 0 ]] || { printf 'MISMATCH %s\n' "${fails[@]}"; false; }
}

@test "F65 SC-13 마찰 대조군: 컨트롤 플레인이 아닌 경로의 find -exec 는 allow 를 유지한다" {
  # 두 패스 분리는 **동사 앞 토큰을 새로 판정 대상으로 만든다** — 이 변경의 주된 위험은
  # 누수가 아니라 과잉 차단이다(SC-13(4)). 정상 워크플로우가 그대로 allow 인지 고정한다.
  local c leaks=()
  for c in 'find src -exec rm {} +' 'find build -exec chmod 644 {} +' 'find . -name "*.tmp" -delete' \
           'find node_modules -exec rm -rf {} +' 'find dist -type f -exec shred {} \;' \
           'find . -name "*.log" -exec mv {} /tmp/logs \;' 'find docs -exec grep -l TODO {} +'; do
    [[ "$(decision_of "$c")" != allow ]] && leaks+=("$c")
  done
  [[ ${#leaks[@]} -eq 0 ]] || { printf 'NEW FRICTION %s\n' "${leaks[@]}"; false; }
}

@test "F65 SC-12·SC-13 변이 테스트: 이 라운드의 수정 지점을 하나씩 지우면 해당 셀이 red 가 된다" {
  # 39차 판정이 쓴 방법 — "테스트가 실제로 고정하는가"는 수정을 되돌려 봐야 안다. 40차는
  # 512자 캡의 두 exit 을 뒤바꿔도 아무 테스트도 실패하지 않는다는 것을, 41차는 빈 문자열
  # 보정 줄이 관측 가능한 효과가 0이라는 것을 이 방법으로 찾아냈다. 훅 사본을 변이시켜
  # (원본은 건드리지 않는다) 판정이 실제로 뒤집히는지 확인한다 — 네 지점 전부.
  local mut="$BATS_TEST_TMPDIR/mutant.sh" saved="$HOOK"
  mutate() {  # $1 sed 식, $2 설명, $3 이 변이로 allow 가 되어야 하는 명령
    sed "$1" "$saved" > "$mut"
    ! cmp -s "$saved" "$mut" || { echo "$2: 대상 줄을 찾지 못했다 — 변이가 적용되지 않았다"; return 1; }
    HOOK="$mut"
    local d; d=$(decision_of "$3")
    HOOK="$saved"
    [[ "$d" == allow ]] || { echo "$2: 지워도 판정이 $d — 이 테스트가 고정하는 대상이 바뀌었다 ($3)"; return 1; }
  }
  # (1) 말단형 센티넬(SC-12(1), 40차)
  mutate 's|^  if \[\[ "\$t" == \*/\* && "\$t" != \*/ \]\]; then t="\$t\$sl"; fi$|  :|' \
    '말단형 센티넬' 'find .claude/. -delete'
  # (2) 비교용 소문자 사본(SC-12(7), 41차) — 이 한 줄이 `.claude/plugins` 꼬리 추출까지 덮는다.
  mutate 's|^  if \[\[ "\$t" == \*\[\[:upper:\]\]\* \]\]; then tl=\$(printf .*$|  :|' \
    '소문자 비교 사본' 'find .CLAUDE/plugins -delete'
  # (3) `$PWD` 접두 제거(41차) — 미전개 접두가 실체 앵커를 무력화한다.
  # (3) `$PWD` 접두 처리는 아래 (6)에서 **치환** 형태로 고정한다(42차가 삭제 방식을 반려했다).
  # (4) 2패스 피연산자 재검사(SC-13(1), 41차) — 동사보다 앞선 피연산자를 보는 유일한 경로.
  mutate 's|^      __cp_judge_operand "\$tok" && return 0$|      :|' \
    '2패스 피연산자 판정' 'find .claude -exec rm -rf {} +'
  # (5) find 무장 술어 배열(SC-13(1)·SC-14, 42차) — `-exec` 를 빼면 평범한 철자보다 약해진다.
  mutate 's|^ARM_FIND_DELETE_PREDICATES=(-delete -exec -execdir -ok)$|ARM_FIND_DELETE_PREDICATES=(-delete)|' \
    'find 무장 술어' 'find .claude -exec truncate -s 0 {} +'
  # (6) `$PWD` 접두의 `.` 치환(42차) — 삭제로 되돌리면 `$PWD//hooks` 가 다시 샌다.
  mutate 's|^  if \[\[ "\$t" == .\$PWD/.\* \]\]; then t="./\${t#.\$PWD/.}"$|  if false; then :|' \
    '$PWD 접두 치환' 'rm -rf $PWD//hooks'
  # (7) 512자 캡의 미확정 플래그(41·42차) — 판정은 둘 다 ask 이므로 **사유**로 고정한다.
  local mut2="$BATS_TEST_TMPDIR/mutant2.sh" long big out
  sed 's|^  if \[\[ ${#t} -gt 512 \]\]; then CP_LOC_UNDECIDED=1; return 0; fi$|  if [[ ${#t} -gt 512 ]]; then return 0; fi|' \
    "$saved" > "$mut2"
  ! cmp -s "$saved" "$mut2" || { echo "512자 캡 줄을 찾지 못했다 — 변이가 적용되지 않았다"; false; }
  long=$(printf 'a%.0s' $(seq 1 600)); big="rm -rf /tmp/$long"
  HOOK="$mut2"; out=$(delete_decision "$big"); HOOK="$saved"
  grep -q 'control-plane-delete →' <<<"$out" \
    || { echo "512자 캡 플래그를 지워도 사유가 바뀌지 않는다 — 이 테스트가 고정하는 대상이 없다"; false; }
}

@test "F65 SC-12 ask 사유의 정직성: 컨트롤 플레인 잎이 없는 보수적 ask 는 일치라고 말하지 않는다 (40차)" {
  # 40차 부수 지적: 예산 초과 콤마 중괄호의 ask 사유가 `control-plane-delete → x{f1,…}` 라고
  # 보고했다 — 그 토큰에는 컨트롤 플레인 잎이 하나도 없다. 보안 프롬프트가 거짓을 말하면
  # 사용자가 진짜 경고를 무시한다.
  local alts big out
  alts=$(printf 'f%s,' $(seq 1 65)); big="cp x{${alts%,}} /tmp/"
  [[ "$(decision_of "$big")" == ask ]] || { echo "예산 초과 fail-safe 가 사라졌다(경계 이동)"; false; }
  out=$(delete_decision "$big")
  grep -q 'control-plane-delete-undecided' <<<"$out" \
    || { echo "보수적 ask 가 여전히 일치라고 보고한다: $out"; false; }
  # 실제로 일치한 경우는 그대로 일치라고 말한다(두 문장이 뒤바뀌지 않았는지).
  out=$(delete_decision 'rm -rf .claude')
  grep -q 'pattern: control-plane-delete →' <<<"$out" \
    || { echo "실제 일치가 undecided 로 보고된다: $out"; false; }
  # **512자 상한 경로의 사유도 고정한다(41·42차 연속 지적).** 두 라운드 모두 "이 경로의
  # `CP_LOC_UNDECIDED=1` 을 지워도 어떤 테스트도 실패하지 않는다"고 적었다 — 상한을 넘는
  # 피연산자 토큰은 컨트롤 플레인 잎이 없어도 보수적으로 ask 가 되므로, 그 ask 는 일치가
  # 아니라 확정 불가로 보고돼야 한다.
  local long big2
  long=$(printf 'a%.0s' $(seq 1 600))
  big2="rm -rf /tmp/$long"
  [[ "$(decision_of "$big2")" == ask ]] || { echo "512자 초과 토큰의 보수적 ask 가 사라졌다"; false; }
  out=$(delete_decision "$big2")
  grep -q 'control-plane-delete-undecided' <<<"$out" \
    || { echo "512자 초과 경로가 일치라고 보고한다: ${out:0:200}"; false; }
}

# ---------------------------------------------------------------------------
# SC-10(4) 경계 쌍 — 이 축의 구현이 도입한 상한은 초과 시 안전한 쪽으로 떨어진다.
# ---------------------------------------------------------------------------
@test "F65 SC-10(4) 마찰 경계: 컨트롤 플레인 잎이 없는 큰 콤마 중괄호는 예산 초과 시 ask 로 떨어진다(의도된 fail-safe, 39차 기록)" {
  # 39차 판정 error/medium: 예산(64)을 넘는 콤마 중괄호는 컨트롤 플레인 잎이 없어도 ask 다 —
  # 판정 불가(2)를 보수적 무장으로 처리하고 그 토큰을 피연산자 판정에 흘리기 때문이다(SC-11(5)).
  # 안전한 방향이지만 **의도된 마찰**이므로 경계를 고정해 둔다: 64 이하는 allow, 초과는 ask.
  local n64 n65 alts
  alts=$(printf 'f%s,' $(seq 1 64)); n64="cp x{${alts%,}} /tmp/"
  alts=$(printf 'f%s,' $(seq 1 65)); n65="cp x{${alts%,}} /tmp/"
  [[ "$(decision_of "$n64")" == allow ]] || { echo "64 대안은 allow 여야 한다(경계 이동)"; false; }
  [[ "$(decision_of "$n65")" != allow ]] || { echo "65 대안이 allow — 예산 초과 fail-safe 가 사라졌다"; false; }
}
@test "F65 SC-10(4) 경계: __VERB_BRACE_BUDGET(64) 안팎의 콤마 대안 수에서 find/-delete 가 전부 ask" {
  local n alts cmd d leaks=()
  for n in 8 63 64 65 66 80 200; do
    alts=$(printf 'g,%.0s' $(seq 1 "$n"))
    cmd="{f,${alts%,}}ind .claude -delete"
    d=$(decision_of "$cmd")
    [[ "$d" == allow ]] && leaks+=("alternatives=$n -> allow")
    cmd="find .claude -{d,${alts%,}}elete"
    d=$(decision_of "$cmd")
    [[ "$d" == allow ]] && leaks+=("predicate alternatives=$n -> allow")
  done
  [[ ${#leaks[@]} -eq 0 ]] || { printf 'LEAK %s\n' "${leaks[@]}"; false; }
}

@test "F65 SC-10(4) 경계: 512자 토큰 상한 안팎(511/512/513/600)에서 중괄호 동사가 전부 ask" {
  local len pad cmd d leaks=() tok
  for len in 511 512 513 600; do
    # 토큰 = "{f,<pad>}ind" 가 정확히 len 자가 되도록 pad 를 맞춘다.
    pad=$(printf 'g%.0s' $(seq 1 $((len - 7))))
    tok="{f,${pad}}ind"
    [[ ${#tok} -eq $len ]] || { echo "픽스처 길이 오류: ${#tok} != $len"; false; }
    cmd="$tok .claude -delete"
    d=$(decision_of "$cmd")
    [[ "$d" == allow ]] && leaks+=("len=$len -> allow")
    cmd="{r,${pad}}m -rf .claude"
    d=$(decision_of "$cmd")
    [[ "$d" == allow ]] && leaks+=("rm len=$((len + 1)) -> allow")
  done
  [[ ${#leaks[@]} -eq 0 ]] || { printf 'LEAK %s\n' "${leaks[@]}"; false; }
}

# ---------------------------------------------------------------------------
# 대입 후 호출(assign_then_invoke_verb, 인접 사례) — 세 위치 전부에서 잡힌다.
# ---------------------------------------------------------------------------
@test "F65 SC-11 대입 문맥: 직전 세그먼트의 VAR=리터럴이 동사·find·-delete 세 위치 어디에 와도 ask" {
  local c leaks=()
  for c in 'V=rm; $V -rf .claude' 'V=rm; ${V} -rf .claude' 'V="rm"; $V -rf .claude' "V='rm'; \$V -rf .claude" \
           'V=rmdir; $V .claude' 'V=unlink; $V .claude/settings.json' 'V=mv; $V .claude /tmp/sink' \
           'V=find; $V .claude -delete' 'V="find"; ${V} .claude -delete' \
           'D=-delete; find .claude $D' 'D=-delete; find .claude ${D}' "D='-delete'; find .claude \$D" 'D="-delete"; find .claude $D' \
           'D=-delete; find hooks/hooks.json $D' 'D=-delete; find .claude/settings.json $D' \
           'P=.claude; rm -rf $P' 'P=.claude/settings.json; rm ${P}' \
           'V=rm && $V -rf .claude' 'V=rm;$V -rf .claude'; do
    [[ "$(decision_of "$c")" == allow ]] && leaks+=("$c")
  done
  [[ ${#leaks[@]} -eq 0 ]] || { printf 'LEAK %s\n' "${leaks[@]}"; false; }
}

@test "F65 SC-11 대입 문맥: 선언된 잔여(체이닝·export·declare·부분 인용·개입 세그먼트)는 계약 키에 귀속돼 있다" {
  residual_exists assign_then_invoke_verb
  # 기록만 — 이 셀들이 ask 로 바뀌면 sprint-51.json 의 서술을 갱신한다(경계 이동 감지).
  local c
  for c in 'A=rm; B=${A}; ${B} hooks/hooks.json' 'export V=rm; $V hooks/hooks.json' 'declare V=rm; $V hooks/hooks.json' \
           'V="r"m; $V hooks/hooks.json' 'V=rm; echo; $V hooks/hooks.json'; do
    echo "residual[assign_then_invoke_verb] $(decision_of "$c"): $c"
  done
}

# ---------------------------------------------------------------------------
# 마찰 대조군 — 이 축의 수정이 무관한 명령을 새로 막지 않는다.
# ---------------------------------------------------------------------------
@test "F65 SC-11 마찰 대조군: 평범한 중괄호·치환·대입·큰 중괄호 피연산자는 allow 유지" {
  local c leaks=()
  for c in 'echo {1,2,3}' 'cp file.txt{,.bak}' 'mkdir -p {src,test}/dir' 'echo file{1..5}.txt' \
           'ls {src,test}' 'touch f{1,2}.txt' 'cp file{1..300} /tmp/' 'ls x{1..a}' \
           'V=hello; echo $V' 'DIR=src; ls ${DIR}' 'V=cat; $V README.md' 'D=-name; find . $D "*.json"' \
           "find .claude -name '*.json'" 'bash -c "echo {a,b}"' 'echo `ls {src,test}`' \
           'git log --format={%h,%s} -3' 'printf "%s\n" {a..c}' \
           'cp {a,b,c} /tmp/' "cp x{$(printf 'A%.0s' $(seq 1 600))} /tmp/" 'cp {src,test}/x.txt /tmp/'; do
    [[ "$(decision_of "$c")" != allow ]] && leaks+=("$c -> $(decision_of "$c")")
  done
  [[ ${#leaks[@]} -eq 0 ]] || { printf 'FRICTION %s\n' "${leaks[@]}"; false; }
}
