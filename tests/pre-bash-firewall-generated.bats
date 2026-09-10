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
PAYLOAD_OPERANDS=('.claude' './.claude' '.claude/' '.claude/settings.json')
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

# ---------------------------------------------------------------------------
# SC-10(4) 경계 쌍 — 이 축의 구현이 도입한 상한은 초과 시 안전한 쪽으로 떨어진다.
# ---------------------------------------------------------------------------
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
