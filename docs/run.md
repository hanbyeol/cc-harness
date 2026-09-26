# harness run — 병합 복구와 실패 기록

`harness run` 이 통과한 기능을 integration 브랜치에 병합할 때 생기는 실패를 어떻게 한 번 복구하고, 실패를 어디에
기록하는지 설명한다. 규칙의 원문은 `docs/SPEC.md` §6.1(flaky)·§7.3(판정 파일)·§8(run)이다.

## 병합 복구 — 기능당 1회

평가를 통과한 기능은 전용 worktree(`.harness/wt/_integration`)에서 integration 브랜치에 `--no-ff` 로 병합되고,
병합된 결과를 다시 verify 한다(병합 후 verify). 여기서 실패하면 기능을 바로 `blocked` 하지 않고 **한 번** 복구한다.
복구는 두 종류이고 **합쳐서 기능당 1회**다. 한 번 복구한 기능이 다시 실패하면 복구 없이 `blocked` 된다. 복구는
라운드를 소모하지 않는다(보고서의 라운드 수·수렴 비교에 들어가지 않는다).

| 실패 | 복구 (`Merge recovery`) | 복구 뒤에도 실패하면 |
|------|-------------------------|----------------------|
| 병합 충돌 | `conflict` — 충돌 파일 목록으로 builder 1회 | `blocked(merge_conflict)` |
| 병합 후 verify 실패(명령 없음 제외) | `post_merge_verify` — 실패 항목으로 builder 1회 | `blocked(post_merge_verify)` |
| 병합 후 verify 의 명령 없음 | 복구 없음 | run 이 environment 사유로 멈춤(`harness run --resume`) |

두 복구의 순서는 같다.

1. integration 병합을 되돌린다 — integration 은 그 기능 병합 전 커밋 그대로다.
2. 그 기능 worktree(`.harness/wt/F{n}`)에 integration 브랜치를 병합한다. 충돌이면 충돌 상태 그대로 둔다.
3. builder 를 1회 부른다 — 그 기능 worktree 에서만, 병합 잠금 밖에서(다른 기능의 병합은 계속된다).
   - `conflict`: 충돌 파일 목록을 준다. builder 가 끝난 뒤 충돌 파일에 충돌 표시가 남아 있으면 실패다.
   - `post_merge_verify`: 실패한 항목(명령 문자열 또는 기준 id 와 메시지 앞 300자)을 준다.
4. verify·eval 을 다시 거친다. base 는 기능 worktree 에 병합한 integration 커밋이다.
5. 통과하면 다시 병합하고 병합 후 verify 를 거쳐 `passed` 가 된다.

builder 가 실패하거나, 다시 거친 verify·eval·병합 후 verify 가 실패하면 `blocked` 이고 integration 은 그 기능 병합 전
커밋 그대로다. 복구 뒤의 병합이 충돌하면 `merge_conflict` 다. 복구가 통과해 다시 병합되기 전까지 integration 브랜치의
커밋은 바뀌지 않는다.

### 충돌 표시

충돌 해결 뒤 코어가 확인하는 충돌 표시는 git 이 쓰는 형태 그대로다.

- 줄 시작의 `<<<<<<< ` 또는 `>>>>>>> `(뒤에 공백)
- 단독 `=======` 줄(CRLF 줄 끝 포함)

줄 중간에 `` `<<<<<<<` `` 를 인용한 문서(SPEC, 이 문서)는 충돌 표시가 아니므로 그런 파일이 충돌 파일이어도 해결이
받아들여진다.

## 실패 기록

### 보고서 (`.harness/runs/{runId}.md`)

- 기능 표의 `Merge recovery` 열: `none`, `conflict → passed|failed`, `post_merge_verify → passed|failed`.
  `Conflict resolution` 열(`no`·`resolved`·`failed`)은 그대로 있다.
- `Blocked` 절: verify 또는 병합 후 verify 실패로 blocked 된 기능은 실패 항목마다
  ``- failed: `<항목>` — <메시지>`` 줄이 나온다.
- `## Flaky tests` 절: 흔들린 테스트가 있었던 기능마다 ``- F{n}: `이름`, …`` 한 줄.

### 판정 파일 (`.harness/verdicts/F{n}-r{k}.json`)

- `verify_failures`: `harness eval` 이 verify 실패로 fail 이면 `[{item, message}]` — 실패한 명령 문자열·기준 id·
  `test_count`·`skip markers`·`.harness changes` 와 메시지 앞 300자. env_allowlist 밖 환경 변수 값은
  `[redacted]` 로 바뀐다. eval 출력에도 `verify failures:` 아래 `<항목> — <메시지>` 로 나온다.
- `flaky_tests`: verify 결과에 흔들린 테스트가 있으면 그 이름 목록.

### 흔들린 테스트 (`flaky_tests`)

verify 명령이 첫 실행에 실패하고 재실행에 통과하면 flaky 다(verify 는 여전히 fail). 코어는 첫 실행의 출력에서
`✖ `(node spec reporter) 또는 `not ok `(TAP)로 시작하는 줄(앞 공백 무시)의 테스트 이름을 최대 20개 모은다. 끝의
`(12ms)` 시간과 TAP `# …` 지시어는 떼고, 같은 이름은 한 번만 센다. 이 목록이 verify 결과(명령별과 전체)·판정 파일·
run 보고서에 `flaky_tests` 로 기록된다.

## base vacuity 실행의 시간 제한

`new: true` 기준을 base 임시 worktree 에서 다시 돌리는 vacuity 실행은 max(`verify.vacuity_timeout_sec`(기본 120),
같은 check 의 head 쪽 실행 시간의 3배) 로 제한되고, `budget.step_timeout_sec` 을 넘지 않는다. head 실행 시간은 코어가 잰
값이고 check 출력으로 바꿀 수 없다. 그래서 head 에서 5초 걸리는 check 는 `vacuity_timeout_sec` 이 2 여도 base 에서 15초까지
돌 수 있고, base 에서 6초 뒤 통과하면 vacuous 로 잡힌다. head 쪽 check 가 실패해 base 실행을 하지 않는 기준은 제한을
계산하지 않는다. 시간을 넘긴 base 실행은 프로세스 트리째 종료되고 "base 에서 통과하지 않음"으로 본다 — 그 기준은 vacuous
가 아니고 head 결과대로 판정되며 결과에 `base_timed_out: true` 와 적용된 제한 `base_timeout_sec`(초)가 남고, verify
`warnings` 에도 그 초가 나온다. head 쪽 기준 check·`verify.commands`·`test_count` 는 `budget.step_timeout_sec` 로만
제한된다.

base vacuity 실행이 명령 없음(127·9009·`not recognized`·ENOENT, 출력 `command not found`)으로 끝나면 — 예: base
worktree 에 설치되지 않은 도구 — vacuity 를 판정할 수 없다. 그 기준은 `base_not_found: true` 와 `command not found on base: <프로그램>` 으로 fail 이고,
run 의 verify 에서는 기능을 blocked 하지 않고 다른 명령 없음과 똑같이 environment 사유로 멈춘다(`command not found`,
`harness run --resume`).

## 범위 밖

- 복구 시도 횟수를 설정으로 늘리기 — 항상 기능당 1회다.
