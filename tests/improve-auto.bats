#!/usr/bin/env bats

# F39: /improve --auto (batch-approval unattended loop) — structure & safety invariants.
# Docs/skill feature: assert the safety-critical clauses are present and the artifacts exist.

PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
SKILL="$PLUGIN_ROOT/skills/improve/SKILL.md"
ADR="$PLUGIN_ROOT/docs/DECISIONS/ADR-006-batch-approval-autonomy.md"
INV="$PLUGIN_ROOT/docs/INVARIANTS.md"
QUEUE="$PLUGIN_ROOT/progress/approval-queue.json"

@test "F39: improve SKILL documents the --auto N mode" {
  grep -qE '\-\-auto N' "$SKILL"
  grep -q '무인' "$SKILL"
}

@test "F39: improve SKILL states gates are un-weakened in auto mode" {
  # 무인 모드가 우회하는 것은 후보 선택뿐 — 게이트는 무약화
  grep -q '무약화' "$SKILL"
  grep -qE 'invariant-guard|evaluator|Stop 게이트' "$SKILL"
}

@test "F39: improve SKILL isolates critical/invariant candidates to approval-queue" {
  grep -q 'approval-queue.json' "$SKILL"
  grep -qE 'critical .*무인.*(제외|않는다|불가)|무인.*critical' "$SKILL"
}

@test "F39: improve SKILL defines the 4 stop conditions" {
  grep -qE '중단 조건' "$SKILL"
  grep -q 'evaluator fail' "$SKILL"
  grep -q 'invariant-guard 차단' "$SKILL"
}

@test "F39: ADR-006 exists and is Accepted" {
  [ -f "$ADR" ]
  grep -qE '^\*\*Status\*\*: Accepted' "$ADR"
  grep -q 'F35' "$ADR"   # INV-11 선행 전제 명문화
}

@test "F39: INVARIANTS declares INV-12 (no unattended execution for critical/guard)" {
  grep -qE 'INV-12' "$INV"
  grep -q '무인 실행 불가' "$INV"
  # 검증 장치 목록에 핵심 파일이 명시돼야 함
  grep -q 'invariant-guard.sh' "$INV"
}

@test "F39: INV-12 and SKILL exclude tests/*.bats from unattended runs (security-auditor gap)" {
  # is_protected(F41)가 보호하는 tests/*.bats가 무인 제외 목록에도 있어야 대칭 —
  # count 검사로 못 잡는 @test 본문 skip 주입 약화를 무인 루프가 하지 못하게.
  grep -q 'tests/\*.bats' "$INV"
  grep -q 'tests/\*.bats' "$SKILL"
}

@test "F39: approval-queue.json is valid JSON with a queued array" {
  command -v jq >/dev/null || skip "jq not installed"
  jq -e '.queued | type == "array"' "$QUEUE"
}

# === F68: 승인 배치화를 전 워크플로우로 ===
# /improve 에만 있던 --auto 를 implement·change-request 로 확대하고, 대상이 배치 게이트에서
# 명시 승인된 경우 critical 도 무인 진행할 수 있게 한다. 게이트는 매 회전 무약화.

IMPL_SKILL="$PLUGIN_ROOT/skills/implement/SKILL.md"
CR_SKILL="$PLUGIN_ROOT/skills/change-request/SKILL.md"

@test "F68: implement SKILL documents --auto N batch mode" {
  grep -qE '\-\-auto N?' "$IMPL_SKILL"
  grep -q '무인' "$IMPL_SKILL"
  # 배치 게이트가 받는 3항목: 범위·N·중단조건
  grep -qE '범위' "$IMPL_SKILL"
  grep -qE '중단 ?조건' "$IMPL_SKILL"
}

@test "F68: implement SKILL defines the on-fail policy with two values" {
  grep -q 'revert-and-continue' "$IMPL_SKILL"
  grep -q 'queue-and-stop' "$IMPL_SKILL"
}

@test "F68: change-request SKILL documents --auto batch mode" {
  grep -qE '\-\-auto' "$CR_SKILL"
  grep -q '무인' "$CR_SKILL"
}

@test "F68: implement SKILL states gates stay un-weakened in batch mode" {
  # 배치화는 승인 지점의 이동이지 검증 완화가 아니다
  grep -qE '무약화|약화하지 않|완화가 아니' "$IMPL_SKILL"
  grep -q 'evaluator' "$IMPL_SKILL"
}

@test "F68: the evaluator dispatch protocol is documented with its 4 clauses" {
  # 이번 세션 실측: 프롬프트를 열어 두면 evaluator 1회가 133k 토큰·41분이 된다.
  grep -qE '탐색' "$IMPL_SKILL"          # (a) 대상·명령·기대값 명시로 탐색 제거
  grep -qE '재현 ?스크립트' "$IMPL_SKILL" # (b) 재현 스크립트 선제공
  grep -qE '3개 ?이하|세 개 이하' "$IMPL_SKILL"  # (c) 확인 항목 상한
  grep -qE '완성 후 1회|1회만' "$IMPL_SKILL"     # (d) 중간 판정 금지
}

@test "F68: INV-12 distinguishes auto-selected candidates from an approved scope" {
  # /improve --auto 는 후보를 자동 선정하므로 critical 무인 금지(현행 유지).
  # /implement --auto 는 대상이 명시 승인되므로 그 범위 안에서만 무인 허용.
  grep -q 'INV-12' "$INV"
  grep -qE '자동 선정|자동선정' "$INV"
  grep -qE '명시 ?승인|승인된 범위' "$INV"
}

@test "F68: INV-12 keeps the unattended prohibition for auto-selected critical work" {
  # 확대가 전면 개방으로 읽히면 안 된다 — 후보 자동 선정 경로의 금지는 남아야 한다.
  grep -qE '무인으로 절대 처리하지 않|무인 금지' "$INV"
  grep -q 'approval-queue' "$INV"
}

@test "F68: ADR-006 records the scope extension and its condition" {
  grep -qE 'F68|배치 게이트에서 명시' "$ADR"
}

# --- SC-4 동작 테스트 (1차 판정: grep 단언은 성질이 거짓인 채로 통과했다) ---
#
# 1차 판정이 실증한 것: is_protected() 는 전면 차단이 아니라 fail-closed 판정·티켓 발급의
# 대상 집합이다. 거기에 이름을 올린 것만으로 "루프가 고칠 수 없다"가 되지 않는다.
# 아래는 전부 훅을 실제로 실행해 판정을 확인한다.

guard_write() {   # $1=파일 $2=새 내용 → exit 2 면 deny
  python3 -c '
import json,sys
print(json.dumps({"session_id":"t","cwd":sys.argv[1],"hook_event_name":"PreToolUse",
                  "tool_name":"Write","tool_input":{"file_path":sys.argv[2],"content":sys.argv[3]}}))
' "$PLUGIN_ROOT" "$1" "$2" | bash "$PLUGIN_ROOT/hooks/invariant-guard.sh"
}

fw_verdict() {    # $1=명령 → stdout 에 permissionDecision
  python3 -c '
import json,sys
print(json.dumps({"session_id":"t","cwd":sys.argv[1],"hook_event_name":"PreToolUse",
                  "tool_name":"Bash","tool_input":{"command":sys.argv[2]}}))
' "$PLUGIN_ROOT" "$1" | bash "$PLUGIN_ROOT/hooks/pre-bash-firewall.sh"
}

@test "F68: enqueueing to the approval queue still passes (the stop path must live)" {
  command -v jq >/dev/null || skip "jq not installed"
  local grown
  grown=$(jq -c '.queued += [{"feature_id":"F99","reason":"probe"}]' "$QUEUE")
  run guard_write "$QUEUE" "$grown"
  [ "$status" -ne 2 ]
}

# 아래 둘은 **항목이 든 사본**으로 판정한다. 실제 큐는 비어 있는 것이 정상이고(중단이 없었다는
# 뜻이다), 빈 큐에 대고 "비우기"를 시도하면 0→0이라 감소가 성립하지 않아 성질을 검증하지 못한다.
# 저장소 상태는 건드리지 않는다 — 훅은 basename으로 판정하므로 임시 경로로도 같은 브랜치를 탄다.
seed_queue() {    # 항목 1개가 든 큐 사본 경로를 만든다
  local tmp="$BATS_TEST_TMPDIR/approval-queue.json"
  printf '%s' '{"queued":[{"feature_id":"F99","reason":"범위 밖 접촉","at":"2026-07-31T00:00:00+0900"}]}' > "$tmp"
  printf '%s' "$tmp"
}

@test "F68: emptying the approval queue is denied (SC-4)" {
  command -v jq >/dev/null || skip "jq not installed"
  # 적립 기록은 중단의 증거다 — 루프가 지울 수 있으면 무인 중단이 없었던 일이 된다
  run guard_write "$(seed_queue)" '{"queued": []}'
  [ "$status" -eq 2 ]
}

@test "F68: rewriting an existing queue entry is denied (SC-4)" {
  command -v jq >/dev/null || skip "jq not installed"
  local q; q=$(seed_queue)
  local tampered; tampered=$(jq -c '.queued[0].reason = "tampered"' "$q")
  run guard_write "$q" "$tampered"
  [ "$status" -eq 2 ]
}

@test "F68: injecting or widening _batch_approval in an agreed contract is denied (SC-4)" {
  command -v jq >/dev/null || skip "jq not installed"
  local c="$PLUGIN_ROOT/progress/contracts/sprint-54.json" widened
  widened=$(jq -c '._batch_approval = {scope:["**/*"], N:99, on_fail:"revert-and-continue"}' "$c")
  run guard_write "$c" "$widened"
  [ "$status" -eq 2 ]
}

@test "F68: laundering the scope through an agreed flip is denied (F37 2차 판정)" {
  command -v jq >/dev/null || skip "jq not installed"
  # 2차 판정 실증: agreed:true 를 false 로 내렸다가 다시 올리면서 _batch_approval 을 교체하면
  # 두 쓰기가 모두 통과했다. 단일 쓰기만 막고 **전이**를 안 본 탓이다.
  # 승인을 내리는 것은 정상 워크플로우(/change-request 가 계약 수정 시 리셋한다)이므로 전이
  # 자체는 막을 수 없다. 대신 **승인 기록을 함께 무효화**하도록 강제한다 — 범위를 들고
  # 내려갔다 올라오는 경로를 닫는다.
  local c="$BATS_TEST_TMPDIR/sprint-99.json"
  mkdir -p "$BATS_TEST_TMPDIR/contracts" && c="$BATS_TEST_TMPDIR/contracts/sprint-99.json"
  jq -n '{sprint:99, feature_id:"F99", agreed:true,
          acceptance_criteria:[{id:"AC-1"}], implementation_steps:[{step:"s"}],
          _batch_approval:{scope:["hooks/x.sh"], N:2}}' > "$c"

  # 범위를 들고 내려가는 것 → deny
  local carried; carried=$(jq -c '.agreed = false' "$c")
  run guard_write "$c" "$carried"
  [ "$status" -eq 2 ]

  # 승인 기록을 함께 지우고 내려가는 것 → 통과 (정상 재작성 경로)
  local cleared; cleared=$(jq -c '.agreed = false | del(._batch_approval)' "$c")
  run guard_write "$c" "$cleared"
  [ "$status" -ne 2 ]
}

@test "F68: a committed approval scope resists re-minting without an intervening commit" {
  command -v jq >/dev/null || skip "jq not installed"
  command -v git >/dev/null || skip "git not installed"
  # **이 테스트가 덮는 범위를 정확히 적는다.** 이전 주석은 "순서 전체를 고정한다"였는데 실제로는
  # 커밋 없는 [쓰기,쓰기]만 모델링해, 성립하지 않는 성질을 초록으로 보증했다(F37 4차 판정 지적).
  # 커밋을 끼운 순서는 아래 별도 테스트가 **통과함을** 고정한다 — 알려진 한계이기 때문이다.
  local d="$BATS_TEST_TMPDIR/repo" c
  mkdir -p "$d/progress/contracts"
  git -C "$d" init -q
  git -C "$d" config user.email t@t
  git -C "$d" config user.name t
  c="$d/progress/contracts/sprint-99.json"
  jq -n '{sprint:99, feature_id:"F99", agreed:true,
          acceptance_criteria:[{id:"AC-1"}], implementation_steps:[{step:"s"}],
          _batch_approval:{scope:["skills/implement/SKILL.md"], N:3}}' > "$c"
  git -C "$d" add -A
  git -C "$d" commit -qm init

  # 1단계: 승인 기록을 지우고 내려가기 — 정상 리셋이므로 통과한다
  local step1; step1=$(jq -c '.agreed = false | del(._batch_approval)' "$c")
  run guard_write "$c" "$step1"
  [ "$status" -ne 2 ]
  printf '%s' "$step1" > "$c"   # 실제 순서대로 잇기 위해 워킹트리에 반영

  # 2단계: 새 범위로 다시 올리기 — 여기서 막혀야 한다.
  # 커밋된 승인이 있는 계약에서 범위가 바뀌면, 어떤 경로로 왔든 사람이 그 범위를 본 적이 없다.
  local step2
  step2=$(jq -c '.agreed = true | ._batch_approval = {scope:["**/*","tests/*.bats"], N:99}' <<<"$step1")
  run guard_write "$c" "$step2"
  [ "$status" -eq 2 ]
}

@test "F68: minting an approval record for the first time is allowed" {
  command -v jq >/dev/null || skip "jq not installed"
  command -v git >/dev/null || skip "git not installed"
  # 최초 발행은 배치 게이트의 정상 산출이다 — 막으면 배치 모드 자체가 성립하지 않는다.
  local d="$BATS_TEST_TMPDIR/repo2" c
  mkdir -p "$d/progress/contracts"
  git -C "$d" init -q
  git -C "$d" config user.email t@t
  git -C "$d" config user.name t
  c="$d/progress/contracts/sprint-98.json"
  jq -n '{sprint:98, feature_id:"F98", agreed:false,
          acceptance_criteria:[{id:"AC-1"}], implementation_steps:[{step:"s"}]}' > "$c"
  git -C "$d" add -A
  git -C "$d" commit -qm init

  local minted
  minted=$(jq -c '.agreed = true | ._batch_approval = {scope:["hooks/x.sh"], N:2}' "$c")
  run guard_write "$c" "$minted"
  [ "$status" -ne 2 ]
}

@test "F68: change-request Step 6 tells the caller to drop _batch_approval" {
  # 3차 판정: 절차를 문자 그대로 따르면 배치 승인이 걸린 계약에서 DENY 가 나고,
  # --auto 회전에서는 하드 스톱이 된다.
  grep -q '_batch_approval' "$CR_SKILL"
}

@test "F68: all three documents state the limit instead of promising a guarantee" {
  # 3차: 9eb1a82 가 ADR 만 고쳐 나머지 둘이 어긋났다(지연이 문서 사이를 옮겨 다녔다).
  # 4차: 셋이 함께 움직인 뒤에도 **셋 다 코드를 넘어섰다** — "어떤 순서로도 차단된다"는 단정이
  # 커밋을 끼운 순서로 반증됐다. 이제 강제 수준과 한계를 함께 적는다.
  # 5차 판정: `.md` 만 검사하면 doc-code 일치가 **doc-doc 일치로 축소된다.** 철회한 주장이
  # 훅의 deny 메시지와 주석에 그대로 살아 있었고 이 테스트가 놓쳤다. 코드도 대상에 넣는다.
  local d guard="$PLUGIN_ROOT/hooks/invariant-guard.sh"
  for d in "$INV" "$IMPL_SKILL" "$ADR" "$guard"; do
    grep -qE '단일 쓰기' "$d"
    ! grep -qE '어떤 순서로도 차단|어떤 쓰기 순서로도 재발행 불가' "$d"
  done
  # 한계의 출구(F69)도 넷 다 가리켜야 한다 — 없으면 "못 막는다"만 남고 계획이 사라진다
  for d in "$INV" "$IMPL_SKILL" "$ADR" "$guard"; do
    grep -q 'F69' "$d"
  done
}

@test "F68: the limits list covers every order known to pass" {
  # 5차 판정: 4차가 '순서 D'(히스토리 접기)를 넘겨줬는데 한계 목록에 넣지 않았다.
  # 알려진 통과 순서가 목록에 없으면 그 다음 판정이 같은 것을 다시 찾는다.
  grep -qE 'reset --soft|히스토리를 접' "$INV"
  grep -qE 'ls-files' "$INV"
  grep -qE 'acceptance_criteria.*단일 쓰기|단일 쓰기로 교체' "$INV"
}

@test "F68: the commit-in-between order passes — a documented limit, not a promise" {
  command -v jq >/dev/null || skip "jq not installed"
  command -v git >/dev/null || skip "git not installed"
  # F37 4차 판정이 실증한 순서다. 코드가 막지 못하므로 **통과함을 고정**한다.
  # 통과를 테스트로 적는 이유: (a) 문서의 한계 서술과 코드가 일치함을 기계로 묶고,
  # (b) F69(ExitPlanMode 이력 대조)가 이것을 막으면 이 테스트가 먼저 깨져 신호가 된다.
  local d="$BATS_TEST_TMPDIR/repo3" c
  mkdir -p "$d/progress/contracts"
  git -C "$d" init -q
  git -C "$d" config user.email t@t
  git -C "$d" config user.name t
  c="$d/progress/contracts/sprint-97.json"
  jq -n '{sprint:97, feature_id:"F97", agreed:true,
          acceptance_criteria:[{id:"AC-1"}], implementation_steps:[{step:"s"}],
          _batch_approval:{scope:["skills/implement/SKILL.md"], N:3}}' > "$c"
  git -C "$d" add -A
  git -C "$d" commit -qm init

  # 쓰기1: Step 6이 지시하는 정상 리셋
  local step1; step1=$(jq -c '.agreed = false | del(._batch_approval)' "$c")
  run guard_write "$c" "$step1"
  [ "$status" -ne 2 ]
  printf '%s' "$step1" > "$c"

  # 중간 커밋 — 공격 수단이 아니라 정상 절차다. 여기서 HEAD 의 승인 기록이 사라진다.
  git -C "$d" add -A
  git -C "$d" commit -qm reset

  # 쓰기2: 새 범위로 재발행 — "최초 발행"과 구분되지 않아 통과한다.
  # `-eq 0` 으로 단언한다(5차 판정): `-ne 2` 는 훅이 죽어도 "한계가 유지된다"로 읽힌다.
  local step2
  step2=$(jq -c '.agreed = true | ._batch_approval = {scope:["**/*"], N:99}' <<<"$step1")
  run guard_write "$c" "$step2"
  [ "$status" -eq 0 ]
}

@test "F68: the formatter skip list and PROTECTED_GLOBS json entries are the same set" {
  # `post-edit-format.sh` 주석은 "이 목록은 PROTECTED_GLOBS 중 .json 확장자를 갖는 것 전부와
  # 같아야 한다"고 규정하고 "tests/protected-integrity.bats 가 두 목록의 정합을 검사한다"고
  # 적었다 — **그 테스트는 없었다.** 그래서 approval-queue.json 을 PROTECTED_GLOBS 에만 넣은
  # 비대칭을 아무도 잡지 못했다(F68 실측). 어긋나면 재포맷이 무결성 티켓을 깨고
  # protected-integrity 가 정당한 편집을 되돌린다 — F66 등록이 그렇게 조용히 사라진 적이 있다.
  local pi="$PLUGIN_ROOT/hooks/protected-integrity.sh"
  local pef="$PLUGIN_ROOT/hooks/post-edit-format.sh"
  local globs skips
  globs=$(sed -n '/^PROTECTED_GLOBS=(/,/^)/p' "$pi" | grep -oE "'[^']*\.json'" | tr -d "'" | sort -u)
  skips=$(grep -oE '[A-Za-z0-9_./*-]+\.json' "$pef" | sort -u)
  [ -n "$globs" ]
  [ -n "$skips" ]
  # 보호 대상 .json 중 포맷 제외 목록에 없는 것이 있으면 실패
  local missing
  missing=$(comm -23 <(printf '%s\n' "$globs") <(printf '%s\n' "$skips"))
  [ -z "$missing" ]
}

@test "F68: a case-variant path is the same file (F37 7차 판정)" {
  command -v jq >/dev/null || skip "jq not installed"
  command -v git >/dev/null || skip "git not installed"
  # 7차 판정 실증: macOS APFS 는 기본 대소문자 무시라 `SPRINT-…json` 이 `sprint-…json` 과
  # **동일 inode** 인데 가드의 판정은 case 매칭이라 갈렸다 — Write 1회로 승인 범위가 교체됐고
  # rm 도 커밋도 필요 없었다. 판정을 파일 동일성으로 올려 이 클래스를 닫는다.
  local d="$BATS_TEST_TMPDIR/repo7" c
  mkdir -p "$d/progress/contracts"
  git -C "$d" init -q
  git -C "$d" config user.email t@t
  git -C "$d" config user.name t
  c="$d/progress/contracts/sprint-93.json"
  jq -n '{sprint:93, feature_id:"F93", agreed:true,
          acceptance_criteria:[{id:"AC-1"}], implementation_steps:[{step:"s"}],
          _batch_approval:{scope:["skills/implement/SKILL.md"], N:3}}' > "$c"
  git -C "$d" add -A && git -C "$d" commit -qm mint

  # 대소문자만 바꾼 경로로 범위 교체 시도 — 같은 파일이므로 막혀야 한다.
  # 대소문자 구분 FS 에서는 별개 파일이라 이 시나리오가 성립하지 않는다.
  if [ -e "$d/progress/contracts/SPRINT-93.json" ]; then
    local widened
    widened=$(jq -c '._batch_approval = {scope:["**/*"], N:99}' "$c")
    run guard_write "$d/progress/contracts/SPRINT-93.json" "$widened"
    [ "$status" -eq 2 ]
  else
    skip "case-sensitive filesystem — variant is a distinct file"
  fi
}

@test "F68: deleting the contract does not open a re-mint path (F37 6차 판정)" {
  command -v jq >/dev/null || skip "jq not installed"
  command -v git >/dev/null || skip "git not installed"
  # 6차 판정 실증: `rm <계약>`(firewall allow) 후 **한 번의 Write** 로 범위가 교체됐다 —
  # 커밋도, 히스토리 재작성도, `git rm --cached`(ask) 도 필요 없는 가장 싼 경로였다.
  # 원인은 신규 생성 통과 예외에 `sprint-*.json` arm 이 없어 계약 브랜치에 도달조차 못 한 것.
  # 세 줄 위가 feature_list.json 에 대해 이미 같은 클래스를 닫아 두었다(F-2).
  local d="$BATS_TEST_TMPDIR/repo5" c
  mkdir -p "$d/progress/contracts"
  git -C "$d" init -q
  git -C "$d" config user.email t@t
  git -C "$d" config user.name t
  c="$d/progress/contracts/sprint-95.json"
  jq -n '{sprint:95, feature_id:"F95", agreed:true,
          acceptance_criteria:[{id:"AC-1"}], implementation_steps:[{step:"s"}],
          _batch_approval:{scope:["skills/implement/SKILL.md"], N:3}}' > "$c"
  git -C "$d" add -A && git -C "$d" commit -qm mint

  local widened
  widened=$(jq -c '._batch_approval = {scope:["**/*"], N:99}' "$c")
  rm "$c"                      # firewall 이 allow 하는 경로
  run guard_write "$c" "$widened"
  [ "$status" -eq 2 ]
}

@test "F68: creating a genuinely new contract still passes" {
  command -v jq >/dev/null || skip "jq not installed"
  command -v git >/dev/null || skip "git not installed"
  # 위 arm 이 정상 스캐폴딩을 막으면 안 된다 — HEAD 에 없는 계약의 최초 작성은 통과한다.
  local d="$BATS_TEST_TMPDIR/repo6" c
  mkdir -p "$d/progress/contracts"
  git -C "$d" init -q
  git -C "$d" config user.email t@t
  git -C "$d" config user.name t
  printf 'x\n' > "$d/README.md"
  git -C "$d" add -A && git -C "$d" commit -qm base

  c="$d/progress/contracts/sprint-94.json"
  local fresh
  fresh=$(jq -nc '{sprint:94, feature_id:"F94", agreed:false,
                   acceptance_criteria:[{id:"AC-1"}], implementation_steps:[{step:"s"}]}')
  run guard_write "$c" "$fresh"
  [ "$status" -eq 0 ]
}

@test "F68: folding history erases the approved scope entirely (limit D)" {
  command -v jq >/dev/null || skip "jq not installed"
  command -v git >/dev/null || skip "git not installed"
  # 5차 판정 실증. 위 순서보다 **강한** 통과 경로다 — firewall 이 allow 하는 git 명령만으로
  # 승인 범위가 저장소 어디에도 남지 않는다. 약한 쪽만 고정하면 이 경로가 목록 밖에 남는다.
  # F69(ExitPlanMode 이력 대조)가 이것을 막으면 이 테스트가 먼저 깨져 신호가 된다.
  local d="$BATS_TEST_TMPDIR/repo4" c base
  mkdir -p "$d/progress/contracts"
  git -C "$d" init -q
  git -C "$d" config user.email t@t
  git -C "$d" config user.name t
  c="$d/progress/contracts/sprint-96.json"

  jq -n '{sprint:96, feature_id:"F96", agreed:false,
          acceptance_criteria:[{id:"AC-1"}], implementation_steps:[{step:"s"}]}' > "$c"
  git -C "$d" add -A && git -C "$d" commit -qm base
  base=$(git -C "$d" rev-parse HEAD)

  jq -c '.agreed = true | ._batch_approval = {scope:["skills/implement/SKILL.md"], N:3}' "$c" > "$c.new"
  mv "$c.new" "$c"
  git -C "$d" add -A && git -C "$d" commit -qm mint

  local step1; step1=$(jq -c '.agreed = false | del(._batch_approval)' "$c")
  run guard_write "$c" "$step1"
  [ "$status" -eq 0 ]
  printf '%s' "$step1" > "$c"

  # 발행 커밋을 접는다 — reset --soft · commit 모두 firewall allow 다
  git -C "$d" reset --soft "$base"
  git -C "$d" add -A && git -C "$d" commit -qm folded

  local step2; step2=$(jq -c '.agreed = true | ._batch_approval = {scope:["**/*"], N:99}' <<<"$step1")
  run guard_write "$c" "$step2"
  [ "$status" -eq 0 ]

  # 승인 범위가 히스토리 어디에도 남지 않는다 — "재발행은 감사에 남는다"가 거짓인 근거
  run bash -c "git -C '$d' log -p --all 2>/dev/null | grep -c 'skills/implement/SKILL.md' || echo 0"
  [ "${output//[^0-9]/}" -eq 0 ]
}

@test "F68: ADR-006 no longer claims the queue is write-blocked" {
  # c516c37 이 INVARIANTS·SKILL 만 좁히고 권위 기록인 ADR 을 빠뜨렸다(2차 판정 지적).
  ! grep -qE 'approval-queue\.json.*쓰기가 차단' "$ADR"
  grep -qE 'append-only' "$ADR"
}

@test "F68: SC-4 verification does not cite is_protected as the enforcement point" {
  # 계약의 판정 기준이 1차 반려 사유였던 오독을 그대로 담고 있으면, 문자 그대로 읽을 때
  # SC-4 가 자동 충족된다(2차 판정 지적).
  command -v jq >/dev/null || skip "jq not installed"
  local v
  v=$(jq -r '.security_criteria[] | select(.id=="SC-4") | .verification' \
      "$PLUGIN_ROOT/progress/contracts/sprint-54.json")
  [[ "$v" != *'is_protected'* ]]
  [[ "$v" == *'append-only'* || "$v" == *'전용 분기'* ]]
}

@test "F68: the bash path to the approval queue is gated too" {
  # invariant-guard 는 Edit|Write 만 후킹한다 — 리다이렉트로 우회되면 보호가 없는 것과 같다
  run fw_verdict "echo {} > progress/approval-queue.json"
  [[ "$output" == *'"permissionDecision": "ask"'* ]]
}

@test "F68: the approval queue is covered by post-hoc detection" {
  # 예측만 있고 탐지가 없으면 한 경로가 통제 밖에 남는다(1차 판정 지적)
  grep -q 'approval-queue' "$PLUGIN_ROOT/hooks/protected-integrity.sh"
}

@test "F68: stop conditions 3 and 5 name a real field and a real number" {
  # 1차 판정: rejected_for 는 evaluator 출력 스키마에 없고 계약에만 사람이 적은 필드였다.
  # 5번은 타임아웃 값 자체가 없었다 — 이번 세션의 600초 스톨이 바로 그 시나리오다.
  grep -q 'failed_criteria' "$IMPL_SKILL"
  grep -qE '[0-9]{3,4}초' "$IMPL_SKILL"
}

@test "F68: the approved scope cannot include tests/*.bats" {
  # INV-12 는 count 기반 검사가 @test 본문의 skip 주입을 못 잡으므로 bats 를 무인에서
  # 제외한다고 스스로 못박았다. 승인 범위 예외가 그 논거를 덮으면 안 된다.
  grep -qE 'tests/\*\.bats.*(승인 범위|범위에 포함할 수 없|예외에서 제외)|(승인 범위|예외에서 제외).*tests/\*\.bats' "$INV"
}
