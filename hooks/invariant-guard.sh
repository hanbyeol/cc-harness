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
#  - settings.json                  : 훅 배선 무력화 — 설치 경로 간 대칭 (INV-13)
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
    protected-integrity.sh | \
    .guarded-edits | \
    .integrity-baseline | \
    INVARIANTS.md | \
    hooks.json | \
    feature_list.json | \
    evaluator.md | \
    evaluator-runs.jsonl | \
    approval-queue.json | \
    *.bats)
      return 0 ;;
  esac
  case "$f" in
    */tests/*.bats) return 0 ;;
    */contracts/sprint-*.json) return 0 ;;  # agreed 전환 보호(INV-11) — jq-존재 브랜치 9번째와 정합
    */skills/change-request/SKILL.md | skills/change-request/SKILL.md | \
    */skills/improve/SKILL.md | skills/improve/SKILL.md | \
    */skills/hotfix/SKILL.md | skills/hotfix/SKILL.md) return 0 ;;  # F48: 티어 라우팅/배치 조건 정의 파일 자기보호(evaluator.md/F45와 동일한 fail-closed 방식)
    # F60: 위 3스킬의 디렉터리 전체로 확장. 스킬을 분할해 배치 승인 조건이나 무인 제외
    # 규칙을 하위 파일로 옮기면 게이트 정의가 보호 밖으로 나가는 우회가 성립한다(F58 발견).
    # 위 full-path arm을 지우지 않고 남겨 두는 이유: F45/F46 대칭 (b) 파서는 arm을 확장자로
    # 끝나는 토큰으로만 추출하므로, 글롭으로 교체하면 그 arm들이 추출 대상에서 빠져
    # INV-12 대칭 검증의 커버리지가 조용히 줄어든다. 교체가 아니라 추가여야 한다.
    */skills/change-request/* | skills/change-request/* | \
    */skills/improve/* | skills/improve/* | \
    */skills/hotfix/* | skills/hotfix/*) return 0 ;;
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
#
# 구현: 각 줄을 buf에 축적(RS 미사용)한 뒤 END에서 index()로 첫 출현을 치환한다.
# 주의(F53): RS="\0"로 전체를 1레코드로 읽는 방식은 awk 구현마다 시맨틱이 다르다 — gawk는
# NUL 구분(사실상 전체읽기)이지만 BSD one-true-awk는 RS="\0"를 RS=""(문단 모드)로 강등해
# 파일을 빈 줄 경계로 쪼갠다. 그러면 빈 줄을 걸친 old_string이 매칭 실패하고(편집 미반영으로
# false-deny·false-allow) 레코드 사이 빈 줄이 소실된다(실측 518→473줄). 라인 버퍼 축적은
# RS에 의존하지 않아 awk 구현 독립적이다 — apply_replace의 네 번째 결함(F49~F51 계보)이라
# awk 시맨틱 가정을 아예 제거했다. trailing newline은 호출부 $()가 정규화하므로 무해.
# 주의(F49): o/n은 awk -v가 아니라 환경변수(ENVIRON[])로 전달한다 — POSIX awk의 -v 할당은
# 문자열 리터럴처럼 백슬래시 이스케이프를 처리해, o/n에 백슬래시(이 코드베이스의 멀티라인
# case문 line-continuation처럼 흔한 패턴)가 있으면 손상된다(로케일/멀티바이트 무관, 전
# awk 구현 공통). 환경변수 값은 이스케이프 처리 없이 그대로 전달된다.
apply_replace() {
  local __IG_OLD__="$2" __IG_NEW__="$3"
  __IG_OLD__="$__IG_OLD__" __IG_NEW__="$__IG_NEW__" awk '
    { buf = buf $0 ORS }
    END {
      o = ENVIRON["__IG_OLD__"]; n = ENVIRON["__IG_NEW__"]
      idx = index(buf, o)
      if (idx > 0) { printf "%s", substr(buf,1,idx-1) n substr(buf,idx+length(o)) }
      else { printf "%s", buf }
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
  # grep/sed/head 등 추출 파이프라인 도구까지 결핍이면 NOJQ_FILE이 비어 보호 판정 자체가
  # 불가능하다 — 그 경우도 fail-closed로 차단한다(F52 2차 evaluator가 지적한 low 이슈).
  if [[ -z "$NOJQ_FILE" ]] && grep -q '"file_path"' <<<"$INPUT" 2>/dev/null; then
    echo "INVARIANT 위반: jq 부재 + file_path 추출 실패 — 보호 대상 판정 불가, fail-closed" >&2
    exit 2
  fi
  # 비보호 파일: jq 없이도 가용성 우선 통과 (가드는 검증 파일에만 관여).
  echo "invariant-guard: jq not found — 비보호 파일이므로 통과 (가용성 우선)" >&2
  exit 0
fi

FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")
[[ -z "$FILE" ]] && exit 0

# === 가드를 통과한 편집을 원장에 남긴다 (F65) ===
# protected-integrity.sh(PostToolUse:Bash)는 "보호 파일이 HEAD와 다른데 가드를 거치지 않았으면
# 복구"한다. 그 판단에는 '어떤 변경이 심사를 통과했는가'가 필요하므로 여기서 기록한다.
# deny()는 exit 2로 끝나므로 기록되지 않는다 — 통과한 편집만 원장에 오른다.
record_guarded_edit() {
  local rc=$? root rel sha
  [[ $rc -ne 0 ]] && return 0
  root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || echo "")}"
  [[ -z "$root" || ! -d "$root/progress" ]] && return 0
  # 저장소 밖 경로는 티켓을 만들지 않는다 — 테스트가 임시 디렉터리에서 돌 때 실 저장소
  # 티켓을 오염시키던 원인이다(실제로 209줄까지 쌓였고 그중 160줄이 보호 파일 경로였다).
  [[ "$FILE" == "$root"/* ]] || return 0
  rel="${FILE#"$root"/}"
  # **내용 해시를 함께 적는다.** 경로만 적으면 정당한 편집 한 번이 그 경로를 영구 면제로
  # 만든다. 해시를 붙이면 티켓은 '이 내용의 이 편집' 하나에만 유효하고, 소비되면 사라진다.
  # 편집 직후의 파일 내용을 해시해야 하는데 이 훅은 PreToolUse이므로 아직 쓰이지 않았다 —
  # 그래서 심사에 쓴 NEW_CONTENT(편집 후 예상 내용)를 해시한다. 실제 쓰인 내용이 다르면
  # 티켓이 맞지 않아 복구되므로, 틀리는 방향이 안전하다.
  # NEW_CONTENT가 없으면 심사 분기까지 가지 않은 것이다(비보호 파일·신규 생성). 티켓을
  # 만들지 않는다 — 만들면 비보호 편집마다 무의미한 줄이 쌓여 티켓 파일이 다시 오염된다.
  [[ -z "${NEW_CONTENT:-}" ]] && return 0
  sha=$(printf '%s' "$NEW_CONTENT" | git hash-object --stdin 2>/dev/null || echo "")
  [[ -z "$sha" ]] && return 0
  printf '%s %s\n' "$sha" "$rel" >> "$root/progress/.guarded-edits" 2>/dev/null || true
}
trap record_guarded_edit EXIT
# 신규 생성은 대개 약화가 아니므로 통과 — 단, 아래 둘은 예외.
# delete-then-recreate로 passes:true를 주입하면 primary 가드(INV-11)를 우회할 수 있으므로
# 파일이 없어도 feature_list.json은 아래 브랜치로 내려보내 passes:true 근거를 검증한다 (F-2).
# F68 6차 판정: `contracts/sprint-*.json` 에 같은 arm 이 없어 **같은 우회가 그대로 열려 있었다** —
# `rm <계약>` (firewall allow) 후 한 번의 Write 로 `_batch_approval` 이 교체됐다. 커밋도,
# 히스토리 재작성도, `git rm --cached`(ask) 도 필요 없는 가장 싼 경로였다. 세 줄 위가 이미
# 이 클래스를 닫아 두었는데 계약만 빠져 있었다.
if [[ ! -e "$FILE" ]]; then
  case "$(basename "$FILE")" in
    feature_list.json) [[ "$FILE" == *"/templates/"* ]] && exit 0 ;;  # templates 스캐폴딩만 면제
    sprint-*.json)
      # 계약 디렉터리 밖(예: 임의 위치의 동명 파일)과 templates 스캐폴딩은 면제
      [[ "$FILE" == *"/templates/"* || "$FILE" != *"/contracts/"* ]] && exit 0 ;;
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
# 빈 내용 Write = 파일 전체 비우기(truncation). 아래 개별 브랜치는 내용을 파싱해 약화를
# 탐지하므로 빈 내용에는 검사할 것이 없어 통과시켜 왔다 — 그러나 이는 클래스 우회다(F54 A6,
# judge2가 evaluator-runs에서 실증): 보호 파일을 빈 Write로 비우면 그 파일의 개별 약화 검사
# (@test 수·임계값·firewall 패턴·실행기록·배선)를 통째로 우회해 검증 장치를 무력화할 수 있다.
# 따라서 기존에 내용이 있던 보호/배선 파일의 truncation은 차단한다(fail-closed 게이트와 동일
# 술어). 신규·이미 빈 파일(-s 거짓)은 파괴할 게 없으므로 통과. (인스턴스가 아니라 클래스를 닫음)
if [[ -z "$NEW_CONTENT" ]]; then
  if { is_protected "$FILE" || is_wiring_file "$FILE"; } && [[ -s "$FILE" ]]; then
    deny "$(basename "$FILE") 전체 비우기(빈 Write) — 보호 파일 truncation은 개별 약화 검사를 우회하는 검증장치 무력화 (INV-7)"
  fi
  exit 0
fi

BASENAME=$(basename "$FILE")

# === 탐지기의 상태 파일: 도구 경로 쓰기 전면 차단 (F65 2차 판정) ===
# .guarded-edits(면제 티켓)와 .integrity-baseline(세션 기준선)은 **기계가 관리한다.**
# 도구로 쓸 정당한 이유가 없고, 쓸 수 있으면 복구를 임의로 면제할 수 있다.
# 2차 판정이 Write 경로로 임의 티켓을 넣는 것을 실증했다 — 그때는 이 브랜치가 없었다.
case "$BASENAME" in
  .guarded-edits | .integrity-baseline)
    deny "$BASENAME 는 탐지기가 관리하는 상태 파일 — 도구로 쓸 수 없다 (INV-14)" ;;
esac

# === protected-integrity.sh: 탐지 기능 제거 차단 ===
# 전면 차단은 하지 않는다(개발 중 정당한 수정이 있다). 다른 훅과 같은 방식으로 **기능 제거만**
# 막는다 — 복구 호출과 보호 대상 목록이 사라지면 탐지기가 껍데기가 된다.
if [[ "$BASENAME" == "protected-integrity.sh" ]]; then
  # 토큰은 **코드에만 나타나는 것**으로 고른다 — 주석에도 있는 문자열을 쓰면 코드를 들어내도
  # 주석이 남아 검사를 통과한다(실측으로 확인했다).
  for token in 'RESTORED+=(' 'PROTECTED_GLOBS=(' 'consume_ticket()' 'git_operation_in_progress()' 'ls-tree'; do
    if grep -qF "$token" "$FILE" 2>/dev/null && ! grep -qF "$token" <<<"$NEW_CONTENT"; then
      deny "protected-integrity.sh 에서 '$token' 제거 — 탐지 기능 축소 (INV-14)"
    fi
  done
fi

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
  # 배선을 (event, matcher, **훅 오브젝트 전문**)으로 추출한다 — default-deny 설계.
  #
  # 왜 오브젝트 전문(정규화 JSON)인가: 훅 오브젝트에는 command 외에 실행을 좌우하는 필드가
  # 많다(공식 스키마: type·if·once·async·asyncRewake·shell·args·timeout 등 24개). 그중 일부만
  # 비교하면, 비교되지 않는 형제 필드를 변조해 훅을 죽이면서 추출값은 동일하게 유지할 수 있다.
  # F52는 이 함정을 세 번 반복했다 —
  #   1차: basename만 비교 → 미끼 문자열·matcher 무력화·hooks 키 이동으로 우회
  #   2차: command 전문 추가 → `true # …` 접두(주석 처리)로 우회
  #   3차: (event,matcher,command) 튜플 → `if`·`once`·`async`·`type` 등 형제 필드로 우회
  # 인스턴스를 하나씩 닫는 방식으로는 끝나지 않는다. 그래서 접근을 뒤집는다: **오브젝트 전체를
  # 정규화(jq -S)해 비교**하고, OLD의 각 훅이 NEW에 정규화 동일하게 보존될 때만 통과시킨다.
  # 어떤 필드를 추가·변조·삭제하든 정규화 문자열이 달라져 deny된다 — 스키마에 아직 없는 미래
  # 벤더 필드까지 자동으로 default-deny다. allowlist(차이 허용 필드 나열)는 의도적으로 두지
  # 않는다 — 그 자체가 "허용 목록에서 빠뜨린 필드"라는 새 우회 표면이 되기 때문이다. timeout
  # 증가처럼 무해한 편집이 막히면 사람이 직접 승인하면 된다(안전장치는 보수적이 원칙).
  #
  # 왜 구조 앵커(.hooks 하위만)인가: `.. | objects`처럼 임의 위치를 훑으면 hooks 키를
  # disabled_hooks로 통째 옮겨도(훅은 죽고 오브젝트만 남음) 통과한다.
  #
  # 왜 matcher만 예외(동일성 아니라 포함관계)인가: matcher 확대(예: `|NotebookEdit` 추가,
  # matcher 삭제=전체매치)는 보호를 **넓히는** 정당한 강화다. 동일성을 요구하면 이런 편집까지
  # 막는 과잉 차단이 된다(2·3차 지적). 축소·무력화(NeverMatchXYZ 등)는 포함관계 위반으로 잡힌다.
  #
  # 종합: 이 검사가 지키는 것은 이름의 존재가 아니라 **실행 도달성**이다.
  #
  # 훅 실행을 문서 레벨에서 죽이는 최상위 스위치. 훅 오브젝트를 아무리 정밀 비교해도 이건
  # 오브젝트 **바깥**이라 안 걸린다 — F52 4차 evaluator가 disableAllHooks:true 하나로
  # invariant-guard 자신을 포함한 전 훅을 죽이며 우회했다. 배선(오브젝트)뿐 아니라 그 배선의
  # 문서 레벨 실행 도달성까지 봐야 한다. 이 목록의 완전성은 hook-wiring-parity.bats가 공식
  # 스키마의 hook 관련 boolean과 대조해 강제한다(새 스위치 추가 시 테스트 실패 → 등록 강제).
  HOOK_KILL_SWITCHES="disableAllHooks allowManagedHooksOnly"
  # 각 배선을 [event, matcher, tojson(hook)] JSON 배열 한 줄로 추출한다 — 구분자·제어문자
  # 불필요(jq -c가 개행 없는 한 줄을 보장하고, 필드는 아래에서 다시 jq로 뽑는다). 이전엔 탭·SOH
  # 구분자를 썼으나 탭은 read의 whitespace라 빈 matcher에서 필드가 밀렸고 제어문자는 파일에
  # 리터럴로 새는 문제가 있었다 — JSON 배열 라인이 둘 다 없앤다.
  wired_rows() {
    jq -S -c '
      (.hooks // {}) | to_entries[] as $e
      | ($e.value // [])[] as $grp
      | ($grp.hooks // [])[] as $h
      | select($h | (.command // "") | test("\\.sh"))
      | [$e.key, ($grp.matcher // ""), ($h | tojson)]
    ' <<<"$1" 2>/dev/null | sort -u || true
  }
  # NEW matcher(nm)가 OLD matcher(om)를 커버하는가 (nm의 매치 집합 ⊇ om의 매치 집합).
  #   - nm 빈 문자열/부재 = 전체 매치 → 모든 om을 커버(widening) → 통과
  #   - om 전체 매치인데 nm 구체적 → narrowing → 차단
  #   - 둘 다 alternation → om의 각 대안이 nm에 문자열로 존재해야 커버(보수적 근사)
  matcher_covers() {
    local om="$1" nm="$2" a
    [[ "$om" == "$nm" ]] && return 0
    [[ -z "$nm" ]] && return 0
    [[ -z "$om" ]] && return 1
    while IFS= read -r a; do
      [[ -z "$a" ]] && continue
      tr '|' '\n' <<<"$nm" | grep -qxF "$a" || return 1
    done < <(tr '|' '\n' <<<"$om")
    return 0
  }
  OLD_R=$(wired_rows "$(cat "$FILE")")
  NEW_R=$(wired_rows "$NEW_CONTENT")
  # (문서 레벨) OLD에 배선이 하나라도 있었으면, 그 배선을 통째로 죽이는 최상위 스위치를
  # off/부재 → on 으로 켜는 편집을 차단한다. OLD에 배선이 없으면 죽일 것도 없으므로 스킵.
  # 값 강건화(F52 5차 evaluator, A3): jq -c로 타입을 보존하고 **false/부재만 off**로 본다 —
  # disableAllHooks:1(숫자)·"true"(문자열) 같은 스펙 위반 truthy 값도 on으로 잡아 fail-closed.
  # (문자열 "false"처럼 애매한 스펙 위반값도 보수적으로 on 취급해 차단한다.)
  if [[ -n "$OLD_R" ]]; then
    for __sw in $HOOK_KILL_SWITCHES; do
      __o=$(jq -c --arg k "$__sw" '.[$k] // false' <<<"$(cat "$FILE")" 2>/dev/null || echo false)
      __n=$(echo "$NEW_CONTENT" | jq -c --arg k "$__sw" '.[$k] // false' 2>/dev/null || echo false)
      [[ "$__o" == "false" && "$__n" != "false" ]] \
        && deny "settings.json 최상위 $__sw 켜짐(off→$__n) — 배선된 훅을 문서 레벨에서 전부 무력화 (INV-13)"
    done
  fi
  MISSING=""
  while IFS= read -r __row; do
    [[ -z "$__row" ]] && continue
    ev=$(jq -r '.[0]' <<<"$__row" 2>/dev/null || echo "")
    om=$(jq -r '.[1]' <<<"$__row" 2>/dev/null || echo "")
    hj=$(jq -c '.[2]' <<<"$__row" 2>/dev/null || echo "")
    FOUND=0
    while IFS= read -r __nrow; do
      [[ -z "$__nrow" ]] && continue
      nev=$(jq -r '.[0]' <<<"$__nrow" 2>/dev/null || echo "")
      nm=$(jq -r '.[1]' <<<"$__nrow" 2>/dev/null || echo "")
      nhj=$(jq -c '.[2]' <<<"$__nrow" 2>/dev/null || echo "")
      # 훅 오브젝트 전문(정규화 JSON)이 바이트 동일하고 event가 같아야 후보
      [[ "$nev" == "$ev" && "$nhj" == "$hj" ]] || continue
      if matcher_covers "$om" "$nm"; then FOUND=1; break; fi
    done <<< "$NEW_R"
    [[ "$FOUND" -eq 1 ]] || MISSING="$MISSING [$ev | ${om:-<all>}]"
  done <<< "$OLD_R"
  if [[ -n "$MISSING" ]]; then
    deny "settings.json 배선 무력화 (event | matcher):$MISSING — 훅 오브젝트의 실행 도달성 축소는 게이트 약화 (INV-13)"
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

# === evaluator-runs.jsonl: evaluator 실행 로그 append-only 보호 (INV-11/F54) ===
# 이 파일의 유일한 정당한 기록자는 SubagentStop 훅의 bash `>>`다 — Edit/Write/MultiEdit 도구가
# 아니므로 invariant-guard를 애초에 경유하지 않는다(정상 기록은 이 브랜치에 도달조차 안 함).
# 따라서 도구로 이 파일을 건드리는 것은 이미 캡처된 실행 기록의 삭제·타임스탬프 변조·재정렬
# 시도로 본다: OLD 전체가 NEW의 접두(prefix)로 보존되고 라인 수가 줄지 않을 때만 허용(순수 append).
# 한계(정직히): 위조된 실행 레코드를 새로 append하는 것 자체는 못 막는다(self-referential) —
# 그러나 이미 기록된 실행의 사후 변조/삭제는 차단해 로그 신뢰도를 speed-bump로 올린다.
if [[ "$BASENAME" == "evaluator-runs.jsonl" ]]; then
  OLD_ALL=$(cat "$FILE" 2>/dev/null || echo "")
  # 라인 수는 awk NR로 센다(grep -c는 빈 입력에서 "0" 출력 + exit1 → `|| echo 0` 이중출력 버그).
  OLD_N=$(printf '%s' "$OLD_ALL" | awk 'END{print NR+0}' 2>/dev/null || echo 0)
  NEW_N=$(printf '%s' "$NEW_CONTENT" | awk 'END{print NR+0}' 2>/dev/null || echo 0)
  if [[ "$NEW_N" -lt "$OLD_N" ]]; then
    deny "evaluator-runs.jsonl 라인 수 감소 ($OLD_N → $NEW_N) — evaluator 실행 로그는 append-only (INV-11/F54)"
  fi
  # OLD 전체가 NEW의 접두여야 한다(기존 라인 불변): head -n OLD_N NEW == OLD.
  if [[ "$OLD_N" -gt 0 ]]; then
    NEW_PREFIX=$(printf '%s' "$NEW_CONTENT" | head -n "$OLD_N" 2>/dev/null || echo "")
    if [[ "$NEW_PREFIX" != "$OLD_ALL" ]]; then
      deny "evaluator-runs.jsonl 기존 라인 변조/삭제/재정렬 — 실행 로그는 append-only(기존 라인 불변) (INV-11/F54)"
    fi
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
    # === F54: evaluator 실행 기계 검증 — 실행존재 + 시간창 (INV-11 강화) ===
    # AUTH(feedback)의 존재·내용만으로는 '실제 evaluator가 돌았는지' 알 수 없다 — 메인 루프가
    # feedback JSON을 위조해 passes를 전환할 수 있다(F35가 남긴 알려진 갭). SubagentStop 훅
    # (하네스가 실행하므로 메인 루프가 발화를 위조할 수 없다)이 캡처한 evaluator 실행 기록
    # (evaluator-runs.jsonl)에, **최근(시간창 내)** 실행이 하나라도 있어야 passes 전환을 허용한다.
    #
    # 왜 feedback timestamp와 순서 비교(≤)를 쓰지 않는가: feedback 파일명 타임스탬프는 논리적·
    # 반올림값(예: T10-15-00, T14-00-00 — 수동 지정)이라 벽시계 실행시각과 직접 비교하면 flaky하다.
    # 대신 신뢰 가능한 벽시계 NOW와, 훅이 기록한 정수 epoch만 비교한다(정수 산술 — BSD/GNU date
    # ISO 파싱차 무관). 이것이 사용자 승인 설계 'A: 실행존재 + 시간창'의 정합 구현이다.
    # 한계(정직히): evaluator-runs도 파일이라 완전 방지는 불가(self-referential). 위조자가 실행
    # 기록까지 위조하려면 실제 evaluator를 최근 돌렸거나(위조 무의미) 로그에 append해야 하는데,
    # 후자는 append-only 보호(is_protected)와 firewall ASK가 speed-bump로 막는다. per-feature
    # 정밀 대응은 아니다(최근 실행 1건이 같은 창의 다른 전환도 만족) — 위조 난이도 상향이 목표.
    RUNS="$COMMS_DIR/evaluator-runs.jsonl"
    F54_WINDOW=172800   # 48h — evaluator 실행 '최근성' 창. 다세션(장기) 작업 허용하되 수주 전
                        # 스테일 실행은 배제. 창 상한은 미래 클럭스큐 1h 허용.
    NOW_EPOCH=$(date +%s 2>/dev/null || echo 0)
    RUN_OK=false
    if [[ -f "$RUNS" && "$NOW_EPOCH" -gt 0 ]]; then
      while IFS= read -r __re; do
        [[ -z "$__re" ]] && continue
        # 정수 epoch만 신뢰(F54 이전 레코드엔 epoch 부재 → 빈값 → 보수적 제외). 시간창 내면 OK.
        if awk -v r="$__re" -v now="$NOW_EPOCH" -v w="$F54_WINDOW" \
             'BEGIN{ if (r !~ /^[0-9]+$/) exit 1; exit !(r+0 >= now-w && r+0 <= now+3600) }'; then
          RUN_OK=true; break
        fi
      done < <(jq -r '.epoch // empty' "$RUNS" 2>/dev/null)
    fi
    [[ "$RUN_OK" == "true" ]] || deny "feature $fid evaluator 실행 기록 부재 — SubagentStop이 캡처한 최근(≤48h) evaluator 실행이 없다. feedback만으로 passes 전환 불가 (INV-11/F54)"
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

# === approval-queue.json: 무인 중단 기록 append-only 보호 (INV-12/F68) ===
# F68 1차 판정이 실증한 것: `is_protected()`에 이름을 올리는 것만으로는 쓰기가 막히지 않는다 —
# 그 함수는 fail-closed 판정과 무결성 티켓 발급의 **대상 집합**이지 전면 차단이 아니다.
# 이 큐는 무인 루프가 "승인 범위 밖을 만나 멈췄다"는 **증거**다. 지울 수 있으면 중단이
# 없었던 일이 되므로, evaluator-runs.jsonl 과 같은 append-only 규칙을 건다.
# 적립(항목 추가)은 통과해야 한다 — 그것이 중단 경로 자체이기 때문이다.
if [[ "$BASENAME" == "approval-queue.json" ]]; then
  OLD_Q=$(jq '.queued | length' "$FILE" 2>/dev/null || echo 0)
  NEW_Q=$(printf '%s' "$NEW_CONTENT" | jq '.queued | length' 2>/dev/null || echo "")
  if [[ -z "$NEW_Q" ]]; then
    deny "approval-queue.json 이 유효한 JSON이 아니거나 .queued 배열이 없음 — 중단 기록은 파싱 가능해야 한다 (INV-12/F68)"
  fi
  if [[ "$NEW_Q" -lt "$OLD_Q" ]]; then
    deny "approval-queue.json 항목 감소 ($OLD_Q → $NEW_Q) — 무인 중단 기록은 append-only (INV-12/F68)"
  fi
  # 기존 항목 불변: OLD 전체가 NEW의 접두여야 한다.
  if [[ "$OLD_Q" -gt 0 ]]; then
    OLD_PREFIX=$(jq -cS '.queued' "$FILE" 2>/dev/null || echo "")
    NEW_PREFIX=$(printf '%s' "$NEW_CONTENT" | jq -cS ".queued[:$OLD_Q]" 2>/dev/null || echo "")
    if [[ "$OLD_PREFIX" != "$NEW_PREFIX" ]]; then
      deny "approval-queue.json 기존 항목 변조/삭제/재정렬 — 중단 기록은 append-only(기존 항목 불변) (INV-12/F68)"
    fi
  fi
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
  # F68 SC-4: 이미 합의된 계약의 **배치 승인 범위**는 수정 불가다. 1차 판정 실증 —
  # agreed 전환만 검사하면 `_batch_approval: {scope:["**/*"], N:99}` 를 사후 주입할 수 있고,
  # 그러면 무인 루프가 자기 승인 범위를 스스로 다시 쓰는 것과 같다. 범위를 바꾸려면
  # 새 배치 게이트를 거쳐야 한다(사람이 다시 본다).
  OLD_BA=$(jq -cS '._batch_approval // null' "$FILE" 2>/dev/null || echo null)
  NEW_BA=$(printf '%s' "$NEW_CONTENT" | jq -cS '._batch_approval // null' 2>/dev/null || echo null)

  # F37 3차 판정: 아래 두 검사는 `agreed` 를 내릴 때 범위를 **들고 가는 것**만 막았고,
  # 지우고 내려갔다 **새로 발행하며** 올라오는 경로는 그대로였다 — 쓰기 2회로 동일해서
  # 우회 비용 증분이 0이었다(종단 재현으로 실증됨: 사람이 승인한 범위가 두 번의 통과 쓰기로
  # `scope:["**/*"]` 이 되고 `_agreed_note` 는 그대로 남아 감사 기록이 오도했다).
  #
  # 그래서 순서가 아니라 **값**을 고정한다 — 다만 이것은 **단일 쓰기 교체를 막을 뿐**이다.
  # 최초 발행(HEAD 에 값 없음)은 통과한다 — 배치 게이트의 정상 산출이다.
  # **막지 못하는 것**(INV-12 "알려진 한계" 참조, F37 4·5차 판정 실증):
  #  - 리셋 → 커밋 → 재발행 순서. 중간 커밋은 /change-request Step 6 이 지시하는 정상 흐름이다.
  #  - `git reset --soft` 등으로 히스토리를 접으면 승인 범위가 저장소 어디에도 남지 않는다.
  #  - `git ls-files` 가 비면(추적 해제) 이 블록 전체를 건너뛴다.
  # 위조 불가능한 강제는 ExitPlanMode 실행 이력 대조뿐이며 F69 가 담당한다.
  if [[ "$NEW_BA" != "null" ]]; then
    CDIR=$(dirname "$FILE")
    REL=$(git -C "$CDIR" ls-files --full-name -- "$FILE" 2>/dev/null || echo "")
    if [[ -n "$REL" ]]; then
      HEAD_BA=$(git -C "$CDIR" show "HEAD:$REL" 2>/dev/null | jq -cS '._batch_approval // null' 2>/dev/null || echo null)
      if [[ "$HEAD_BA" != "null" && "$HEAD_BA" != "$NEW_BA" ]]; then
        deny "_batch_approval 이 커밋된 승인과 다름 — 단일 쓰기로는 교체할 수 없다. 범위를 바꾸려면 새 계약을 만든다 (INV-12/F68 SC-4). 완전한 차단은 아니다: 알려진 한계는 INV-12 참조, 위조 불가능한 강제는 F69"
      fi
    fi
  fi

  if [[ "$OLD_AG" == "true" ]]; then
    if [[ "$NEW_AG" == "true" && "$OLD_BA" != "$NEW_BA" ]]; then
      deny "_batch_approval 변경 — 합의된 계약의 배치 승인 범위는 수정 불가. 범위를 바꾸려면 새 배치 게이트를 거친다 (INV-12/F68 SC-4)"
    fi
    # F37 2차 판정이 실증한 우회: `agreed` 를 false 로 내렸다가 다시 올리면서 범위를 교체하면
    # 두 쓰기가 모두 통과했다 — 단일 쓰기만 보고 **전이**를 보지 않은 탓이다.
    # 승인을 내리는 것 자체는 정상 워크플로우다(/change-request 가 계약 수정 시 리셋한다).
    # 그래서 전이를 막는 대신 **승인 기록을 함께 무효화**하도록 강제한다: 범위를 들고
    # 내려갔다 올라오는 경로가 닫히고, 새 범위는 새 배치 게이트를 거쳐 들어와야 한다.
    if [[ "$NEW_AG" != "true" && "$NEW_BA" != "null" ]]; then
      deny "agreed 해제 시 _batch_approval 이 남아 있음 — 합의를 내리면 배치 승인도 무효화해야 한다(범위 세탁 차단). 계약 재작성 시 이 필드를 제거하라 (INV-12/F68 SC-4)"
    fi
  fi
  exit 0
fi

exit 0
