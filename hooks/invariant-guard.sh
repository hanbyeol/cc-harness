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
#  - hooks/invariant-guard.sh, docs/INVARIANTS.md : 자기 축소(자기 보호)
#
set -euo pipefail

INPUT=$(cat 2>/dev/null || echo "")
[[ -z "$INPUT" ]] && exit 0

has_jq() { command -v jq &>/dev/null; }

# old_string의 첫 출현을 new_string으로 치환한 전체 내용을 stdout으로.
# 매치가 없으면 원본 그대로. (리터럴 치환 — 정규식 메타 영향 없음)
apply_replace() {
  awk -v o="$2" -v n="$3" '
    BEGIN { RS="\0" }
    {
      idx=index($0,o);
      if (idx>0) { printf "%s", substr($0,1,idx-1) n substr($0,idx+length(o)) }
      else { printf "%s", $0 }
    }
  ' <<<"$1" 2>/dev/null || printf '%s' "$1"
}

if ! has_jq; then
  # jq 없이는 입력 파싱 불가 — 보조 게이트이므로 경고 후 통과 (INV: fail-open)
  echo "invariant-guard: jq not found — guard inactive (가용성 우선)" >&2
  exit 0
fi

FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")
[[ -z "$FILE" ]] && exit 0
[[ ! -e "$FILE" ]] && exit 0   # 신규 생성은 약화가 아님 — 통과

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
      NEW_CONTENT=$(apply_replace "$(cat "$FILE")" "$OLD_S" "$NEW_S")
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
      NEW_CONTENT=$(apply_replace "$NEW_CONTENT" "$EO" "$EN")
    done
    ;;
  *)
    exit 0
    ;;
esac
[[ -z "$NEW_CONTENT" ]] && exit 0

deny() {
  echo "INVARIANT 위반: $1" >&2
  echo "  파일: $FILE" >&2
  echo "  검증 장치 약화는 자동 차단됩니다 — docs/INVARIANTS.md 참조." >&2
  echo "  의도적 변경이라면 사용자가 직접 편집/승인하세요." >&2
  exit 2
}

BASENAME=$(basename "$FILE")

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

exit 0
