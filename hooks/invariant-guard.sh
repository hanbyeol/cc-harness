#!/usr/bin/env bash
#
# invariant-guard.sh — PreToolUse(Edit|Write|MultiEdit) 가드
#
# 하네스의 검증 장치를 약화시키는 편집을 결정론적으로 차단한다 (docs/INVARIANTS.md).
# add-only 원칙: 더 엄격하게는 자유, 더 느슨하게는 deny(exit 2) + 사람 승인 요구.
#
# 검사 대상:
#  - progress/harness-config.json  : pass_threshold·security_thresholds 하향
#  - hooks/pre-bash-firewall.sh     : BLOCKED·INDIRECT_PATTERNS 패턴 수 감소
#  - tests/*.bats                   : @test 개수 감소
#  - settings.json                  : 훅 배선(스크립트) 제거 — 설치 경로 간 대칭 (INV-13)
#  - hooks/invariant-guard.sh, docs/INVARIANTS.md : 자기 축소(자기 보호)
#
set -euo pipefail

INPUT=$(cat 2>/dev/null || echo "")
[[ -z "$INPUT" ]] && exit 0

has_jq() { command -v jq &>/dev/null; }
has_awk() { command -v awk &>/dev/null; }

# is_protected: 편집 대상이 하네스 보호 파일인가? (단일 출처)
# 아래 jq-존재 디스패치 브랜치들이 개별 검사하는 파일 집합과 동일하게 유지한다 —
# 하드코딩 중복 drift를 막기 위해 보호 대상 목록을 이 함수 하나로 정의한다.
# 주 사용처: jq 부재 시 fail-closed 판정(내용 검사 불가 시 보호 파일 편집을 보수적으로 차단).
is_protected() {
  local f="$1" b
  b=$(basename "$f" 2>/dev/null || echo "")
  case "$b" in
    harness-config.json | \
    pre-bash-firewall.sh | \
    pre-tool-firewall.sh | \
    invariant-guard.sh | \
    INVARIANTS.md | \
    hooks.json | \
    feature_list.json | \
    evaluator.md | \
    *.bats)
      return 0 ;;
  esac
  case "$f" in
    */tests/*.bats) return 0 ;;
    */contracts/sprint-*.json) return 0 ;;  # agreed 전환 보호(INV-11) — jq-존재 브랜치 9번째와 정합
    */skills/change-request/SKILL.md | skills/change-request/SKILL.md | \
    */skills/improve/SKILL.md | skills/improve/SKILL.md | \
    */skills/hotfix/SKILL.md | skills/hotfix/SKILL.md) return 0 ;;  # F48: 티어 라우팅/배치 조건 정의 파일 자기보호(evaluator.md/F45와 동일한 fail-closed 방식)
  esac
  return 1
}

# is_wiring_file: 훅 배선을 정의하는 파일인가? (F52 / INV-13)
# is_protected()와 의도적으로 분리한다 — 두 함수는 서로 다른 질문에 답한다:
#   is_protected()   "편집 자체를 보수적으로 막아야 하는가?"  → 전면 차단
#   is_wiring_file() "도구 결핍 시 fail-closed여야 하는가?"   → 결핍 시에만 차단
# settings.json을 is_protected()에 넣지 않는 이유: 이 파일은 훅 배선 외에 env·permissions·
# enabledPlugins 등 사용자의 정당한 설정도 담는다. 전면 차단하면 설치된 프로젝트에서 무관한
# 설정을 고칠 때마다 게이트가 걸려 마찰이 과도하다. 대신 아래 settings.json 브랜치가
# **배선 약화만** 탐지한다(내용 기반). 다만 그 내용 검사는 jq/awk에 의존하므로, 도구가 없으면
# 검사 자체가 무력화된다 — 그 경우까지 통과시키면 F41이 닫은 fail-open이 되살아난다.
# 따라서 아래 fail-closed 게이트(has_jq/has_awk)에는 포함시킨다.
is_wiring_file() {
  local b
  b=$(basename "$1" 2>/dev/null || echo "")
  [[ "$b" == "settings.json" ]]
}

# old_string의 첫 출현을 new_string으로 치환한 전체 내용을 stdout으로.
# 매치가 없으면 원본 그대로. (리터럴 치환 — 정규식 메타 영향 없음)
# 주의(F49): o/n은 awk -v가 아니라 환경변수(ENVIRON[])로 전달한다 — POSIX awk의 -v 할당은
# 문자열 리터럴처럼 백슬래시 이스케이프를 처리해, o/n에 백슬래시(이 코드베이스의 멀티라인
# case문 line-continuation처럼 흔한 패턴)가 있으면 손상된다(로케일/멀티바이트 무관, 전
# awk 구현 공통). 환경변수 값은 이스케이프 처리 없이 그대로 전달된다.
apply_replace() {
  local __IG_OLD__="$2" __IG_NEW__="$3"
  __IG_OLD__="$__IG_OLD__" __IG_NEW__="$__IG_NEW__" awk '
    BEGIN { RS="\0"; o=ENVIRON["__IG_OLD__"]; n=ENVIRON["__IG_NEW__"] }
    {
      idx=index($0,o);
      if (idx>0) { printf "%s", substr($0,1,idx-1) n substr($0,idx+length(o)) }
      else { printf "%s", $0 }
    }
  ' <<<"$1" 2>/dev/null
  # 폴백 없음(F50): awk 실패 시 원본을 반환해 실패를 숨기지 않는다 — 함수의 종료 상태가
  # awk의 실제 종료 코드로 전파되어, 호출부가 fail_closed_on_apply_failure()로 명시 판정한다.
}

deny() {
  echo "INVARIANT 위반: $1" >&2
  echo "  파일: $FILE" >&2
  echo "  검증 장치 약화는 자동 차단됩니다 — docs/INVARIANTS.md 참조." >&2
  echo "  의도적 변경이라면 사용자가 직접 편집/승인하세요." >&2
  exit 2
}

# apply_replace 실패(awk 부재/오류) 시 보호 파일은 deny, 비보호는 가용성 우선 (F50, has_jq 대칭)
fail_closed_on_apply_failure() {
  is_protected "$FILE" && deny "apply_replace 실패(awk 오류/부재) — 편집 시뮬레이션 불가, fail-closed (INV-7)"
  exit 0
}

if ! has_jq; then
  # jq 부재 = 기계 검증의 단일 실패점(모든 INV 검사가 jq에 의존). 안전장치는 결핍 시
  # fail-closed가 캐논: 보호 파일 편집은 차단(사람 승인 요구), 비보호 파일은 가용성 유지(통과).
  # jq 없이 file_path만 추출 — content 값 오염을 피해 tool_input.file_path의 첫 매치만 사용.
  NOJQ_FILE=$(printf '%s' "$INPUT" \
    | grep -oE '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' 2>/dev/null \
    | head -n1 \
    | sed -E 's/.*"file_path"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' 2>/dev/null || true)
  if [[ -n "$NOJQ_FILE" ]] && { is_protected "$NOJQ_FILE" || is_wiring_file "$NOJQ_FILE"; }; then
    echo "INVARIANT 위반: jq 부재 상태에서 보호 파일 편집을 차단합니다 (fail-closed)" >&2
    echo "  파일: $NOJQ_FILE" >&2
    echo "  jq가 없으면 invariant-guard의 기계 검증이 무력화됩니다 — 안전장치는 결핍 시 차단이 원칙(docs/INVARIANTS.md)." >&2
    echo "  jq를 설치하거나(brew install jq / apt-get install jq), 사람이 직접 편집/승인하세요." >&2
    exit 2
  fi
  # 비보호 파일: jq 없이도 가용성 우선 통과 (가드는 검증 파일에만 관여).
  echo "invariant-guard: jq not found — 비보호 파일이므로 통과 (가용성 우선)" >&2
  exit 0
fi

FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")
[[ -z "$FILE" ]] && exit 0
# 신규 생성은 대개 약화가 아니므로 통과 — 단, feature_list.json은 예외.
# delete-then-recreate로 passes:true를 주입하면 primary 가드(INV-11)를 우회할 수 있으므로
# 파일이 없어도 feature_list.json은 아래 브랜치로 내려보내 passes:true 근거를 검증한다 (F-2).
if [[ ! -e "$FILE" ]]; then
  case "$(basename "$FILE")" in
    feature_list.json) [[ "$FILE" == *"/templates/"* ]] && exit 0 ;;  # templates 스캐폴딩만 면제
    *) exit 0 ;;
  esac
fi

# awk 부재 = 이 스크립트 대부분의 기계 검증(임계값·카운트 비교, apply_replace 등)의 단일
# 실패점(F51, has_jq와 대칭) — TOOL 종류(Write 포함) 무관하게 보호 파일은 fail-closed.
if ! has_awk && { is_protected "$FILE" || is_wiring_file "$FILE"; }; then
  echo "INVARIANT 위반: awk 부재 상태에서 보호 파일 편집을 차단합니다 (fail-closed)" >&2
  echo "  파일: $FILE" >&2
  echo "  awk가 없으면 대부분의 기계 검증(임계값·카운트 비교·apply_replace)이 무력화됩니다 — 안전장치는 결핍 시 차단이 원칙(docs/INVARIANTS.md)." >&2
  echo "  awk를 설치하거나, 사람이 직접 편집/승인하세요." >&2
  exit 2
elif ! has_awk; then
  # 비보호 파일: awk 없이도 가용성 우선 통과 (가드는 검증 파일에만 관여).
  echo "invariant-guard: awk not found — 비보호 파일이므로 통과 (가용성 우선)" >&2
  exit 0
fi

# Edit/MultiEdit: new_string(들)을 old에 적용한 결과를 NEW로, Write: content가 곧 NEW.
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")
NEW_CONTENT=""
case "$TOOL" in
  Write)
    NEW_CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty' 2>/dev/null || echo "")
    ;;
  Edit)
    OLD_S=$(echo "$INPUT" | jq -r '.tool_input.old_string // empty' 2>/dev/null || echo "")
    NEW_S=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty' 2>/dev/null || echo "")
    if [[ -n "$OLD_S" ]]; then
      if ! NEW_CONTENT=$(apply_replace "$(cat "$FILE")" "$OLD_S" "$NEW_S"); then
        fail_closed_on_apply_failure
      fi
    else
      NEW_CONTENT=$(cat "$FILE")
    fi
    ;;
  MultiEdit)
    # edits 배열을 순차 적용해 실제 NEW_CONTENT를 재구성한다 (no-op 우회 차단)
    NEW_CONTENT=$(cat "$FILE")
    EDIT_COUNT=$(echo "$INPUT" | jq -r '.tool_input.edits | length' 2>/dev/null || echo 0)
    for ((ei = 0; ei < EDIT_COUNT; ei++)); do
      EO=$(echo "$INPUT" | jq -r ".tool_input.edits[$ei].old_string // empty" 2>/dev/null || echo "")
      EN=$(echo "$INPUT" | jq -r ".tool_input.edits[$ei].new_string // empty" 2>/dev/null || echo "")
      [[ -z "$EO" ]] && continue
      if ! NEW_CONTENT=$(apply_replace "$NEW_CONTENT" "$EO" "$EN"); then
        fail_closed_on_apply_failure
      fi
    done
    ;;
  *)
    exit 0
    ;;
esac
[[ -z "$NEW_CONTENT" ]] && exit 0

BASENAME=$(basename "$FILE")

# === settings.json: 훅 배선 무력화 차단 (INV-13) ===
# cc-harness는 설치 경로가 둘이고 각자 다른 파일로 훅을 배선한다 — 플러그인은 hooks/hooks.json,
# init.sh는 settings.json(→ .claude/settings.json). 한쪽에서 게이트가 빠지면 그 경로로 설치한
# 프로젝트만 무방비가 된다(F52가 실제로 그 상태를 발견: invariant-guard·pre-tool-firewall 미배선).
# is_protected()의 전면 차단이 아니라 **배선 약화만** 탐지한다 — 이 파일은 env·permissions·
# enabledPlugins 등 사용자의 정당한 설정도 담으므로 전면 차단은 마찰이 과도하다.
# 주의: init.sh가 배선된 settings.json을 그대로 .claude/settings.json으로 복사하므로 설치본도
# hooks 키를 갖는다 — 설치본은 면제 대상이 **아니다**. 면제되는 것은 애초에 훅을 배선하지 않는
# settings 파일(예: enabledPlugins만 담은 것)뿐이며, 그 경우 OLD 집합이 공집합이라 통과한다.
if [[ "$BASENAME" == "settings.json" ]]; then
  if ! echo "$NEW_CONTENT" | jq -e '.' &>/dev/null; then
    deny "settings.json이 유효한 JSON이 아닙니다 (INV-13)"
  fi
  # 배선을 (event, matcher, script) 3-튜플로 추출한다.
  #
  # 구조 앵커(.hooks 하위만 순회)를 쓰는 이유 — `.. | objects | .command`처럼 임의 위치를
  # 훑으면 다음이 통과한다(F52 evaluator가 실증):
  #   (a) 실제 배선을 지우고 "echo invariant-guard.sh" 같은 미끼 문자열만 남기기
  #   (c) hooks 키를 disabled_hooks 등으로 통째 이동 — 훅은 죽지만 문자열은 남음
  # matcher를 튜플에 포함하는 이유:
  #   (b) matcher를 NeverMatchXYZ로 바꾸면 스크립트 이름이 그대로여도 훅이 영원히 발화하지
  #       않는다 — **집합 보존이 곧 실행 보장은 아니다**.
  # 즉 이 검사가 지키는 것은 '이름의 존재'가 아니라 '실행 도달성'이다.
  #
  # 저장소 CI(tests/hook-wiring-parity.bats)와 동일한 앵커 경로를 의도적으로 재사용한다 —
  # 같은 불변식을 검사하는 추출기가 두 벌이고 강도가 다르면 약한 쪽이 실제 방어선이 된다.
  wired_set() {
    jq -r '
      (.hooks // {}) | to_entries[] as $e
      | ($e.value // [])[] as $grp
      | ($grp.matcher // "") as $m
      | (($grp.hooks // [])[] | .command // empty)
      | [$e.key, $m, .] | @tsv
    ' <<<"$1" 2>/dev/null \
      | awk -F'\t' '{
          n=$3
          sub(/.*\//, "", n)          # 경로 제거 → 파일명만
          sub(/["'"'"' ].*$/, "", n)  # 뒤따르는 따옴표·인자 제거
          if (n ~ /\.sh$/) print $1 "\t" $2 "\t" n
        }' \
      | sort -u || true
  }
  OLD_W=$(wired_set "$(cat "$FILE")")
  NEW_W=$(wired_set "$NEW_CONTENT")
  MISSING=""
  while IFS= read -r s; do
    [[ -z "$s" ]] && continue
    # -F: basename의 `.`이 정규식 any-char로 해석되지 않도록 리터럴 비교
    grep -qxF "$s" <<<"$NEW_W" || MISSING="$MISSING [${s//$'\t'/ | }]"
  done <<< "$OLD_W"
  if [[ -n "$MISSING" ]]; then
    deny "settings.json 배선 무력화 (event | matcher | script):$MISSING — 배선의 실행 도달성 축소는 게이트 약화 (INV-13)"
  fi
  exit 0
fi

# === harness-config.json: 임계값 하향 차단 (INV-3) ===
if [[ "$BASENAME" == "harness-config.json" ]]; then
  if ! echo "$NEW_CONTENT" | jq -e '.' &>/dev/null; then
    deny "harness-config.json이 유효한 JSON이 아닙니다"
  fi
  for path in '.scoring.pass_threshold' \
              '.scoring.security_thresholds.critical' \
              '.scoring.security_thresholds.standard' \
              '.scoring.security_thresholds.low'; do
    OLD_V=$(jq -r "$path // empty" "$FILE" 2>/dev/null || echo "")
    NEW_V=$(echo "$NEW_CONTENT" | jq -r "$path // empty" 2>/dev/null || echo "")
    if [[ -n "$OLD_V" ]]; then
      # 키 제거도 약화다 — old에 있던 임계값이 new에서 사라지면 deny (INV-3)
      if [[ -z "$NEW_V" ]]; then
        deny "$path 제거 ($OLD_V → 없음) — 임계값 키 제거는 약화 (INV-3)"
      fi
      # 숫자 비교 — 하향이면 deny
      if awk -v a="$OLD_V" -v b="$NEW_V" 'BEGIN{exit !(b+0 < a+0)}'; then
        deny "$path 하향 ($OLD_V → $NEW_V) — 임계값은 add-only(상향만) (INV-3)"
      fi
    fi
  done
  exit 0
fi

# === pre-bash-firewall.sh: deny 패턴 수 감소 차단 (INV-5) ===
if [[ "$BASENAME" == "pre-bash-firewall.sh" ]]; then
  # 배열별로 패턴 라인 수를 센다 — 배열 간 swap(한쪽 삭제+다른쪽 추가)으로 총합을
  # 유지하는 우회를 차단하기 위해 BLOCKED·INDIRECT_PATTERNS·ASK를 개별 검사.
  # awk: `NAME=(` 부터 닫는 `)` 까지 구간에서 작은따옴표로 시작하는 라인 수.
  count_array() {
    awk -v arr="$2" '
      $0 ~ "^"arr"=\\(" { inb=1; next }
      inb && /^\)/ { inb=0 }
      inb && /^[[:space:]]*'\''/ { c++ }
      END { print c+0 }
    ' <<<"$1" 2>/dev/null || echo 0
  }
  OLD_ALL=$(cat "$FILE")
  for arr in BLOCKED INDIRECT_PATTERNS ASK_PATTERNS; do
    O=$(count_array "$OLD_ALL" "$arr")
    N=$(count_array "$NEW_CONTENT" "$arr")
    if [[ "$N" -lt "$O" ]]; then
      deny "firewall $arr 패턴 감소 ($O → $N) — deny 목록은 add-only (INV-5)"
    fi
  done
  # 안전판: 전체 패턴 수 감소도 차단 (배열 정의 자체 삭제 등)
  count_total() { grep -cE "^[[:space:]]*'" <<<"$1" 2>/dev/null || true; }
  OLD_T=$(count_total "$OLD_ALL"); NEW_T=$(count_total "$NEW_CONTENT")
  if [[ "$NEW_T" -lt "$OLD_T" ]]; then
    deny "firewall deny 패턴 총수 감소 ($OLD_T → $NEW_T) — deny 목록은 add-only (INV-5)"
  fi
  exit 0
fi

# === tests/*.bats: @test 개수 감소 차단 (INV-6) ===
if [[ "$FILE" == *"/tests/"*.bats || "$BASENAME" == *.bats ]]; then
  count_tests() { grep -cE "^@test " <<<"$1" 2>/dev/null || true; }
  OLD_T=$(count_tests "$(cat "$FILE")")
  NEW_T=$(count_tests "$NEW_CONTENT")
  if [[ "$NEW_T" -lt "$OLD_T" ]]; then
    deny "@test 개수 감소 ($OLD_T → $NEW_T) — 테스트는 add-only (INV-6)"
  fi
  exit 0
fi

# === hooks.json: invariant-guard 실제 실행 등록 보존 (INV-7) ===
# 텍스트 substring이 아니라 jq로 실제 hook command를 추출해 검사한다 (미끼 필드·rename 우회 차단).
if [[ "$BASENAME" == "hooks.json" ]]; then
  # OLD가 invariant-guard.sh를 PreToolUse command로 등록하고 있었는가?
  guard_registered() {
    jq -r '[.. | objects | .command? // empty] | .[]' <<<"$1" 2>/dev/null \
      | grep -qE 'invariant-guard\.sh("|$| )'
  }
  if guard_registered "$(cat "$FILE")" && ! guard_registered "$NEW_CONTENT"; then
    deny "hooks.json에서 invariant-guard.sh 실행 등록 제거/변경 — 안전장치 자기 보호 (INV-7)"
  fi
  exit 0
fi

# === 자기 보호: invariant-guard.sh / INVARIANTS.md (INV-7) ===
if [[ "$BASENAME" == "invariant-guard.sh" || "$BASENAME" == "INVARIANTS.md" ]]; then
  OLD_LINES=$(wc -l < "$FILE" 2>/dev/null | tr -d ' ')
  NEW_LINES=$(printf '%s\n' "$NEW_CONTENT" | wc -l | tr -d ' ')
  # 30% 이상 축소를 약화로 간주 (소폭 편집은 허용)
  if [[ "$OLD_LINES" -gt 0 ]] && awk -v o="$OLD_LINES" -v n="$NEW_LINES" 'BEGIN{exit !(n+0 < o*0.7)}'; then
    deny "$BASENAME 대폭 축소 ($OLD_LINES → $NEW_LINES 줄) — 안전장치 자기 보호 (INV-7)"
  fi
  # semantic gutting 차단: deny 호출·실제 exit 2 statement 수가 줄면 라인 수가 유지돼도 약화.
  # exit 2는 라인 앵커로 검사해 주석 위장(`: # exit 2`)을 배제한다.
  if [[ "$BASENAME" == "invariant-guard.sh" ]]; then
    count_tok() { grep -cE "$2" <<<"$1" 2>/dev/null || true; }
    for tok in '^[[:space:]]*deny ' '^[[:space:]]*exit 2[[:space:]]*$'; do
      O=$(count_tok "$(cat "$FILE")" "$tok")
      N=$(count_tok "$NEW_CONTENT" "$tok")
      if [[ "$N" -lt "$O" ]]; then
        deny "invariant-guard.sh의 차단 로직 감소 ('$tok' $O → $N) — semantic gutting 차단 (INV-7)"
      fi
    done
    # deny() 함수 본문 무결성: 함수 안에 실제 'exit 2' statement가 남아 있어야 한다.
    # (본문을 return 0으로 재정의하고 토큰을 주석으로 위장하는 우회 차단)
    deny_has_exit() {
      awk '/^deny\(\) *\{/{inf=1} inf && /^[[:space:]]*exit 2[[:space:]]*$/{found=1} inf && /^\}/{inf=0} END{exit !found}' <<<"$1"
    }
    if deny_has_exit "$(cat "$FILE")" && ! deny_has_exit "$NEW_CONTENT"; then
      deny "invariant-guard.sh의 deny() 함수에서 'exit 2' 제거 — 안전장치 무력화 차단 (INV-7)"
    fi
  fi
  exit 0
fi

# === pre-tool-firewall.sh: 도구 방화벽 allow 확장 차단 (INV-10) ===
# Bash 방화벽(INV-5)과 대칭 — 도구 auto-allow(빌트인·MCP read-verb 화이트리스트)를
# 넓히는 편집(default-allow 플립·write-verb 유입·변형 빌트인 유입)을 결정론적으로 막는다.
if [[ "$BASENAME" == "pre-tool-firewall.sh" ]]; then
  # (a) allow 방출 지점(emit_allow) 수 증가 차단 — default-allow 플립·allow 브랜치 추가 방어
  count_emit() { grep -cE 'emit_allow' <<<"$1" 2>/dev/null || true; }
  OLD_E=$(count_emit "$(cat "$FILE")"); NEW_E=$(count_emit "$NEW_CONTENT")
  if [[ "$NEW_E" -gt "$OLD_E" ]]; then
    deny "pre-tool-firewall.sh의 allow 방출(emit_allow) 지점 증가 ($OLD_E → $NEW_E) — 도구 auto-allow 확장은 약화 (INV-10)"
  fi
  # (b) read-verb 화이트리스트 라인에 write-verb 유입 차단 — MCP write auto-allow 방어
  WRITE_VERBS='create|update|delete|send|remove|upload|write|put|post|patch|exec|run|install|deploy|modify|drop|revoke|move|copy|rename|clear|reset|kill|stop|restart|apply|edit'
  if grep -E 'get\|list\|search\|read\|fetch' <<<"$NEW_CONTENT" | grep -qiE "\b(${WRITE_VERBS})\b"; then
    deny "pre-tool-firewall.sh의 read-verb 화이트리스트에 write-verb 유입 — MCP write auto-allow는 약화 (INV-10)"
  fi
  # (c) 읽기전용 빌트인 라인에 변형 도구 유입 차단
  if grep -E 'WebFetch\|WebSearch' <<<"$NEW_CONTENT" | grep -qE '\b(Edit|Write|MultiEdit|NotebookEdit|Task|file_upload)\b'; then
    deny "pre-tool-firewall.sh의 읽기전용 빌트인 목록에 변형 도구 유입 — auto-allow 확장은 약화 (INV-10)"
  fi
  exit 0
fi

# === feature_list.json: passes 전환 근거 검증 (INV-11) ===
# passes:false→true(신규·중복 id로 true 유입 포함)는 evaluator-feedback 근거가 있어야 한다:
# 해당 id를 평가한 최신 레코드가 verdict pass, 5차원 완비, min-of-5 ≥ pass_threshold,
# critical 티어는 scores.security ≥ security_thresholds.critical.
# evaluator를 대체하지 않는다 — 판정의 존재와 산술만 재검증한다(speed-bump, INVARIANTS 위협모델).
if [[ "$BASENAME" == "feature_list.json" && "$FILE" != *"/templates/"* ]]; then
  if ! echo "$NEW_CONTENT" | jq -e '.' &>/dev/null; then
    deny "feature_list.json이 유효한 JSON이 아닙니다 (INV-11)"
  fi
  PROG_DIR=$(dirname "$FILE")
  COMMS_DIR="$PROG_DIR/agent-comms"
  CFG="$PROG_DIR/harness-config.json"
  PASS_T=7; CRIT_T=7
  if [[ -f "$CFG" ]]; then
    PASS_T=$(jq -r '.scoring.pass_threshold // 7' "$CFG" 2>/dev/null || echo 7)
    CRIT_T=$(jq -r '.scoring.security_thresholds.critical // 7' "$CFG" 2>/dev/null || echo 7)
  fi
  NEW_TRUE_IDS=$(echo "$NEW_CONTENT" | jq -r '[.features[]? | select(.passes==true) | .id] | unique | .[]' 2>/dev/null || echo "")
  while IFS= read -r fid; do
    [[ -z "$fid" ]] && continue
    # old에서 이미(모든 동일 id 항목이) true였으면 전환 아님 — 신규 id·false 항목은 검증 대상.
    # 파일 부재(delete-then-recreate)면 prior true 없음 → 모든 passes:true가 검증 대상 (F-2).
    if [[ -f "$FILE" ]]; then
      OLD_TRUE=$(jq -r --arg id "$fid" '[.features[]? | select(.id==$id) | .passes == true] | (length > 0) and all' "$FILE" 2>/dev/null || echo "false")
    else
      OLD_TRUE="false"
    fi
    [[ "$OLD_TRUE" == "true" ]] && continue
    AUTH=""
    if [[ -d "$COMMS_DIR" ]]; then
      while IFS= read -r fbf; do
        if jq -e --arg id "$fid" '.features_evaluated // [] | index($id)' "$fbf" &>/dev/null; then
          AUTH="$fbf"; break
        fi
      done < <(ls -1 "$COMMS_DIR"/evaluator-feedback-*.json 2>/dev/null | sort -r)
    fi
    [[ -z "$AUTH" ]] && deny "feature $fid passes:true 전환 근거 없음 — evaluator-feedback 레코드 부재. passes는 독립 evaluator 판정 후에만 (INV-1/INV-11)"
    V=$(jq -r '.verdict // empty' "$AUTH" 2>/dev/null || echo "")
    [[ "$V" == pass* ]] || deny "feature $fid 최신 판정 verdict='$V' — pass 판정 없이 passes:true 불가 (INV-1/INV-11)"
    # 타입 검사 fail-closed: 문자열 점수("3")는 jq min에서 숫자보다 크게 정렬돼 최솟값을
    # 가릴 수 있으므로 number가 아닌 차원이 하나라도 있으면 "missing"으로 취급해 차단 (F-4).
    MIN=$(jq -r '[.scores.functionality, .scores.code_quality, .scores.security, .scores.error_handling, .scores.test_coverage] | if any(. == null or (type != "number")) then "missing" else min end' "$AUTH" 2>/dev/null || echo "missing")
    if [[ "$MIN" == "missing" ]]; then
      deny "feature $fid 판정의 5차원 점수 불완전/비수치 — min-of-5 재검증 불가 (INV-2/INV-11)"
    fi
    if awk -v m="$MIN" -v t="$PASS_T" 'BEGIN{exit !(m+0 < t+0)}'; then
      deny "feature $fid min-of-5=$MIN < pass_threshold=$PASS_T — 통과 요건 미달 (INV-2/INV-11)"
    fi
    # tier는 NEW_CONTENT를 우선 신뢰(파일 부재 시에도 동작) — NEW에 없으면 디스크 폴백, 최종 기본 standard
    TIER=$(echo "$NEW_CONTENT" | jq -r --arg id "$fid" '[.features[]? | select(.id==$id) | .security_tier] | first // empty' 2>/dev/null || echo "")
    if [[ -z "$TIER" || "$TIER" == "null" ]] && [[ -f "$FILE" ]]; then
      TIER=$(jq -r --arg id "$fid" '[.features[]? | select(.id==$id) | .security_tier] | first // empty' "$FILE" 2>/dev/null || echo "")
    fi
    [[ -z "$TIER" || "$TIER" == "null" ]] && TIER="standard"
    if [[ "$TIER" == "critical" ]]; then
      SEC=$(jq -r '.scores.security // empty' "$AUTH" 2>/dev/null || echo "")
      if [[ -z "$SEC" ]] || awk -v s="$SEC" -v t="$CRIT_T" 'BEGIN{exit !(s+0 < t+0)}'; then
        deny "feature $fid (critical) scores.security=$SEC < $CRIT_T — 보안 미달은 자동 fail (INV-4/INV-11)"
      fi
    fi
  done <<< "$NEW_TRUE_IDS"
  exit 0
fi

# === contracts/sprint-*.json: agreed 전환 구조 검증 (INV-11) ===
# agreed:false→true는 Plan 게이트 산출물(비어있지 않은 acceptance_criteria·implementation_steps)을
# 전제한다 — 빈 계약의 무단 합의를 차단. 내용 검증은 Plan 게이트(사람)의 몫.
if [[ "$FILE" == *"/contracts/"* && "$BASENAME" == sprint-*.json && "$FILE" != *"/templates/"* ]]; then
  # 주의: `.agreed // empty`는 false를 삼킨다(jq alternative) — tostring으로 false 보존
  OLD_AG=$(jq -r '.agreed | if . == null then "" else tostring end' "$FILE" 2>/dev/null || echo "")
  NEW_AG=$(echo "$NEW_CONTENT" | jq -r '.agreed | if . == null then "" else tostring end' 2>/dev/null || echo "")
  if [[ "$OLD_AG" == "false" && "$NEW_AG" == "true" ]]; then
    AC_N=$(echo "$NEW_CONTENT" | jq -r '.acceptance_criteria | length' 2>/dev/null || echo 0)
    ST_N=$(echo "$NEW_CONTENT" | jq -r '.implementation_steps | length' 2>/dev/null || echo 0)
    if [[ "$AC_N" -lt 1 || "$ST_N" -lt 1 ]]; then
      deny "agreed:true 전환에 acceptance_criteria($AC_N)·implementation_steps($ST_N) 필요 — Plan 산출물 없는 합의 금지 (INV-11)"
    fi
  fi
  exit 0
fi

exit 0
