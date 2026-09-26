# cc-harness v2 — SPEC

설계 근거: `docs/brainstorms/2026-09-23-v2-from-scratch.md` (v1 45회 루프 근본 원인 분석 포함).

## 1. 목적
AI 코딩 CLI(Claude Code · Codex CLI · Gemini CLI, 그 외 AGENTS.md 호환 도구)가
**평가 기반 개발 라이프사이클**(계약 → 구현 → 결정적 검증 → 독립 평가 → 보안 평가)을
사람 개입 최소로, **반드시 수렴하는 형태로** 수행하게 하는 플러그인.

비목표: 모델을 적대자로 가정한 in-process 방어(방화벽·무결성 훅), 하네스 자기개선 루프.

## 2. 사용자와 사용 방식
| 모드 | 흐름 |
|------|------|
| 대화형 | 사용자가 CLI 안에서 skill 호출(`spec` → `plan` → `build`) — skill이 코어 명령을 호출 |
| 자율 | 사람이 계약을 일괄 승인한 뒤 `harness run` — 코어가 기능별로 headless 세션을 띄워 끝까지 진행, 종료 시 보고서 + PR |

## 3. 용어
- **계약(contract)**: 기능 1개의 수락 기준. `.harness/contracts/F{n}.json`. 승인 시 해시로 동결.
- **check**: 기준 하나를 판정하는 셸 명령. exit 0 = 충족.
- **finding**: evaluator가 보고한 결함. `criterion_id` + `repro` 필수.
- **라운드**: build → verify → eval 1회.
- **blocked**: 수렴 실패로 사람의 결정이 필요한 상태.

## 4. 상태 파일 (`.harness/`, git 추적)
| 파일 | 내용 |
|------|------|
| `config.json` | profile, verify 명령, 임계값, 예산, max_rounds, 어댑터 역할 배정. 병합 순서 DEFAULTS ← profile ← config (config 우선). `init` 은 verify.commands 를 쓰지 않는다 — 사용자가 정하기 전까지 프로필 기본값이 적용된다. `init` 이 config.json 을 새로 만들 때는 프로젝트의 테스트 러너를 감지해 `verify.test_count` 를 쓴다: `package.json` 의 `scripts.test` 에 `node --test` 가 있으면 `preset:node-test`, 아니고 `go.mod` 가 있으면 `preset:go`, 아니고 `pytest.ini`·`conftest.py` 가 있거나 `pyproject.toml` 에 `[tool.pytest.ini_options]` 절이 있으면 `preset:pytest`. 해당 없으면 키를 쓰지 않는다. 기존 config.json 은 바꾸지 않는다 — `doctor` 가 같은 규칙으로 제안만 한다(§10). 최상위는 JSON 객체여야 하고, 기본값이 객체인 키(`budget`·`run`·`verify`·`limits`·`roles`·`rubric`)는 지정 시 객체여야 한다. `verify.commands`·`verify.skip_markers`·`verify.test_paths`·`env_allowlist`·`secret_globs`·`protected_branches` 는 지정 시 빈 문자열이 아닌 문자열의 배열이어야 하고(오류는 키 이름과 원소 번호 `key[i]`), `verify.test_count` 는 문자열 또는 null 이어야 하고, `run.max_parallel`·`run.verify_parallel`·`verify.check_parallel` 은 `'auto'` 또는 1 이상의 정수여야 하고(§6.3 동시 실행·§8 병렬 실행, 오류는 키 이름을 담은 `config_invalid`), `preset:` 으로 시작하면 `preset:node-test`·`preset:go`·`preset:pytest` 중 하나와 정확히 같아야 한다(아니면 `verify.test_count` 와 사용 가능한 프리셋 이름을 담은 `config_invalid`, §6.2-3), `from:` 으로 시작하면 `from:commands[i]` 형식이고 i 가 병합된 `verify.commands` 범위 안이어야 한다(아니면 `verify.test_count` 를 담은 `config_invalid`, §6.2-3). 역할 모델 정책(§10)의 값 — `roles.<역할>.model`·`roles.<역할>.by_tier.<tier>`·`roles.<역할>.escalate`·`roles.<역할>.conflict_model`·`adapters.<name>.model` — 은 `-` 로 시작하거나 공백·제어 문자를 포함하면 거부되고(SR-1, 어댑터 인자에 들어가지 않는다), `by_tier` 는 키가 `critical`·`standard` 뿐인 객체이고 값은 빈 문자열이 아닌 문자열, `escalate`·`conflict_model` 은 빈 문자열이 아닌 문자열이어야 한다(오류는 키 경로, 예: `roles.builder.by_tier.low` 를 담은 `config_invalid`, exit 2). `budget.git_timeout_sec`(기본 300) 은 양의 숫자여야 한다(0·음수·문자열·null 은 `budget.git_timeout_sec` 을 담은 `config_invalid`, exit 2) — 코어 git 명령의 시간 제한이고 `budget.step_timeout_sec` 과 독립이다(§6). `verify.vacuity_timeout_sec`(기본 120) 도 양의 숫자여야 한다(0·음수·문자열·null 은 `verify.vacuity_timeout_sec` 을 담은 `config_invalid`, exit 2) — `new: true` 기준의 base vacuity 실행 시간 제한이다(§6.3). 형식 검사는 프로필과 병합하기 전 사용자 파일에 대해 한다(`run --resume` 은 저장된 config 스냅샷에도 같은 검사를 한다) |
| `features.json` | `[{id, title, security_tier, depends_on[], status}]` — status ∈ `todo·approved·in_progress·passed·blocked·skipped`. 각 항목의 `id`·`title`·`status` 는 필수 문자열. `eval_round`(선택)는 대화형 eval 이 상태를 기록한 마지막 라운드(§7.6) |
| `contracts/F{n}.json` | 계약 (§5) |
| `verdicts/F{n}-r{k}.json` | 라운드별 판정 (§7) |
| `backlog.json` | `{ items: [...] }` — 범위 밖 발견 · blocked 재범위 제안. 항목 id(`B<n>`)·`priority`·`seen`·`sources`·`resolved_by` 규칙은 §7.7 |
| `runs/{ts}.md` | 자율 실행 보고서 |
| `runs/{ts}.metrics.jsonl`, `runs/eval.metrics.jsonl` | 단계별 실행 지표(한 줄 = 끝난 단계 하나, §8 실행 지표). `harness stats` 가 집계한다 |

`init` 은 없는 파일·디렉터리만 만든다. `.harness/` 가 일부만 있어도(예: `contracts/` 만) 빠진 것을 채우고 기존 파일은 건드리지 않는다. 상태 파일 쓰기는 원자적이다(같은 디렉터리의 임시 파일 → rename). 어느 단계에서 실패해도 임시 파일을 지우고 대상 파일은 이전 내용 그대로 남는다(`io` 에러).

`status: passed`는 **코어만** 기록한다(§7의 규칙을 통과한 경우). 모델 역할(builder)은 이 필드를 쓰지 않는다 — 협력적 모델 가정 하의 규약이며, 위반은 verify의 무결성 검사가 결정적으로 잡는다(§6.2).

## 5. 계약과 결정가능성 lint (`harness lint-contract`)
```json
{
  "id": "F3", "title": "...", "security_tier": "standard|critical", "version": 1,
  "acceptance_criteria": [{"id": "AC-1", "criterion": "...", "check": "<cmd>", "new": true}],
  "security_criteria":   [{"id": "SC-1", ...}],
  "error_scenarios":     [{"id": "ES-1", ...}],
  "out_of_scope": ["..."],
  "run_steps": ["build", "verify", "eval"],
  "resolves": ["B12"],
  "approval": {"by": "...", "at": "ISO8601", "hash": "sha256"}
}
```
`security_tier` 는 `standard|critical` 외 값이면 error. `run_steps` 는 선택(생략 시 위 기본값).
`resolves` 는 선택 — 이 기능이 해결하는 backlog 항목 id 배열(§7.7). 문자열 배열이 아니면 error, backlog 에 없거나 이미 해결된(`resolved_by` 있음) id 를 가리키면 warning.
lint 규칙(전부 결정적, 위반 = error):
1. 모든 기준에 비어 있지 않은 `check`.
2. 기준 id 유일, 형식 `AC-n|SC-n|ES-n` (n ≥ 1), 접두사는 소속 배열과 일치. 계약 `id` 는 파일명과 일치.
3. **전칭 부정 금지**: criterion 문장이 금지 패턴(`어떤 .*도`, `모든 .*에 대해`, `우회 불가`, `절대(로)?` + 공백/끝, `any possible`, `cannot be bypassed`, `no way to`, `never`)에 걸리고 `cases` 배열(열거된 시나리오, 각 항목에 check)이 없으면 error. 영문은 대소문자 무시, `never` 는 단어 경계.
7. `run_steps` 에 `rollout` 포함 시 error (SR-7).
4. 크기 상한: AC ≤ 12, SC ≤ 8, ES ≤ 8, 파일 ≤ 20KB (설정값).
5. `security_tier: critical` ⇒ SC ≥ 1.
6. `approval.hash` = `sha256(JSON.stringify(계약에서 approval 키를 제거한 객체))` (키 순서는 파일에 저장된 순서). hash 가 있으면 현재 내용(approval 제외)의 해시와 일치해야 함 — 불일치 = 승인 후 변경 → 재승인 필요.

`harness approve F3 [F4 ...]`: 규칙 1–5·7 을 통과한 계약에 approval 을 (재)기록, features.status → `approved`. 기존 approval 의 hash 불일치(규칙 6)는 재승인을 막지 않는다 — 재승인이 곧 해소 수단이다. hash 없는 approval 은 lint error 는 아니지만 실행 대상이 아니다.

## 6. 결정적 검증 (`harness verify F{n}`)
**시간 제한** — 두 제한은 서로 독립이다. `budget.step_timeout_sec`(기본 1800)은 사용자 명령 — `verify.commands`·기준 check·`verify.test_count`(eval 의 repro 와 역할 CLI 호출 포함) — 하나하나를 제한한다(base vacuity 실행은 `verify.vacuity_timeout_sec` 과 둘 중 작은 값, §6.3). `budget.git_timeout_sec`(기본 300)은 verify·eval·run 이 코어 목적으로 실행하는 git 명령(`worktree add`·`remove`, `diff`, `ls-files`, `merge`, `merge-base`, `rev-parse`, `for-each-ref` 등) 하나하나를 제한한다. 넘긴 git 명령은 프로세스 트리째 종료되고 `git` 오류(`HarnessError` code `git`)로 끝나며, 메시지는 `git <하위 명령> timed out after <N>s` 다(`worktree` 는 `worktree add` 처럼 두 단어). 재시도는 없다.

### 6.1 명령
config의 `verify.commands`(예: test·lint·build)를 순서대로 실행. 하나라도 비정상 종료 = fail. 실행 파일이 없으면 `command not found: <이름>` 으로 보고한다(판정 규칙은 §7.3 의 명령 미발견과 같다).
실패 시 **1회 재실행**, 결과가 다르면 `flaky`로 기록하고 fail로 취급. 첫 실행에 실패하고 재실행에 통과한 명령은 첫 실행 출력(stdout·stderr)에서 `✖ ` 또는 `not ok ` 로 시작하는 줄(앞 공백 무시)의 테스트 이름(끝의 `(12ms)` 시간·TAP `# …` 지시어 제외, 중복 제거, 최대 20개)을 그 명령의 `flaky_tests` 로, 모든 명령의 합(최대 20개)을 verify 결과의 `flaky_tests` 로 기록한다. 이 기록은 판정을 바꾸지 않는다(여전히 fail).

### 6.2 무결성 검사 (base 대비 diff)
diff = `merge-base(base, HEAD)` ↔ **작업 트리**(커밋 안 된 변경 + untracked 파일 포함). base 측 실행(test_count·vacuous 검사)은 merge-base 를 임시 detached worktree 로 꺼내 수행하고 끝나면 제거한다. 그 `git worktree add` 가 실패하면 worktree 가 아닌 경로에 `git worktree remove` 를 호출하지 않고 임시 디렉터리만 지우며, verify 는 원래 git 오류 메시지를 담은 `git` 오류로 끝난다.
worktree 안의 `.harness/` 는 코어가 쓰는 기록 경로 `verdicts/**`, `backlog.json`, `runs/**` 만 면제하고, **그 외 어떤 경로든** 변경되면 fail (아래 2는 그 부분집합). 면제는 git 이 보고하는 `/` 경로의 정확한 세그먼트 기준이다(`verdicts-x/…`, `backlog.json.bak`, `runs` 라는 파일은 보호). 모노레포 하위 프로젝트는 그 프로젝트의 `<sub>/.harness` 기준으로 같다.
1. 추가된 줄에 skip/focus 마커 없음: `.skip(`, `.only(`, `xit(`, `xdescribe(`, `@pytest.mark.skip`, `@Disabled`, `t.Skip(`, `@Ignore` (목록은 config로 추가 가능, 제거 불가 — 기본 목록은 코드에 고정).
   마커는 **토큰 경계**로 매칭한다: 마커가 식별자 문자로 시작하면 바로 앞 문자가 식별자 문자가 아니어야 한다(`process.exit(` ≠ `xit(`, `list.Skip(` ≠ `t.Skip(`). 구두점으로 시작하는 마커는 부분문자열 매칭.
2. `.harness/config.json`, `.harness/contracts/**`, `.harness/features.json` 변경 없음 (면제 경로와 함께 바뀌어도 fail, 보고 목록에는 보호 경로만).
3. `verify.test_count` 명령이 설정된 경우 base 대비 테스트 수 비감소. 미설정 시 경고만.
   값이 셸 명령이면 stdout 마지막 비어 있지 않은 줄의 정수가 테스트 수다(종료 코드 0 이어야 함). 값이 프리셋이면 코어가 **고정된 실행 파일 이름과 고정 인자 배열로 셸 없이** 실행하고(config 의 다른 값은 인자에 들어가지 않는다), 출력에서 수를 센다. 실패한 테스트도 수에 들어가므로 러너의 종료 코드는 보지 않는다(통과 여부는 §6.1 의 명령이 판정).
   - `preset:node-test` — `node --test --test-reporter=tap`, 출력의 마지막 `# tests N` 줄의 N.
   - `preset:go` — `go test -list . ./...`, `Test`·`Example`·`Fuzz` 로 시작하는 줄 수(`ok`·`?` 패키지 줄은 세지 않는다). 이름 줄도 패키지 줄도 없으면 수를 찾지 못한 것이다.
   - `preset:pytest` — `python -m pytest --collect-only -q`, 출력의 마지막 `N tests collected`(단수 `1 test collected` 포함)의 N.
   실행 파일이 PATH 에 없으면 test count 는 `error`, 메시지 `command not found: <이름>`. 출력에서 수를 찾지 못하면 `error`, 메시지 `no test count in output`. 시간 초과·시그널 종료도 `error`. `error` 는 verify fail 이다. 알 수 없는 프리셋은 config 검사에서 거부된다(§4).
   값이 `from:commands[i]` 이면 테스트 수를 위해 명령을 따로 실행하지 않는다: head 쪽 수는 §6.1 에서 이미 실행한 `verify.commands[i]` 의 stdout(재실행했으면 마지막 실행)에서 마지막 `# tests N`(TAP 리포터) 또는 `ℹ tests N`(node spec 리포터) 줄의 N 이다(줄 맨 앞부터 매칭 — 들여쓴 하위 테스트 요약은 세지 않는다). base 쪽 수는 같은 명령 문자열을 base 임시 worktree 에서 한 번 실행한 출력에서 같은 규칙으로 읽는다. 종료 코드는 보지 않는다(실패한 테스트도 센다). 출력에 그런 줄이 없으면 `error`, 메시지 `no test count in output of verify.commands[i]`. i 는 0 또는 앞에 0 이 없는 10진 정수여야 하고 병합된 config 의 `verify.commands` 범위 안이어야 한다 — 아니면 작업 없이 `config_invalid`(exit 2), 메시지에 `verify.test_count` (§4). 셸 명령으로서 `from:` 으로 시작하는 값은 쓸 수 없다.
   **base 테스트 수 캐시**: base 쪽 수(셸 명령·프리셋·`from:` 모두)는 `.harness/runs/test-count-cache.json` 에 `{ entries: [{ base, command, rule, count }] }` 로 저장된다 — `base` 는 merge-base 커밋 sha, `command` 는 셸 명령 문자열·프리셋 값·`verify.commands[i]` 의 문자열, `rule` 은 세는 규칙(`stdout-integer`·`preset`·`summary`). 한 커밋의 테스트는 바뀌지 않으므로 같은 키의 다음 verify 는 base 에서 실행하지 않고 저장된 값을 쓴다. 커밋이나 명령이 다르면 다시 실행한다. 저장은 수를 얻은 경우에만 하고(`error` 는 저장하지 않는다), 최근 200 항목만 남긴다. 값이 음이 아닌 정수가 아닌 항목(문자열·음수·소수·null)은 쓰지 않고 다시 실행해 그 항목을 덮어쓴다. 파일이 JSON 으로 읽히지 않거나 형식(`entries` 배열)이 다르면 무시하고 다시 실행하며 `warnings` 에 캐시 경로를 남기고 새 값으로 다시 쓴다 — verify 는 그 이유로 실패하지 않는다. 쓰기 실패도 경고만 한다. 캐시는 코어의 기록 경로(`runs/**`)라 무결성 검사 대상이 아니다. 캐시는 각 worktree 의 로컬 기록이라 커밋하지 않는다 — `harness init` 이 만드는 `.harness/.gitignore` 에 `runs/test-count-cache.json` 이 있고, `harness run` 이 builder 변경을 커밋할 때(§8) 이 파일은 빼고 스테이징한다.
   결과의 `integrity.testCount.source` 는 `{ head, base }` 로 각 값의 출처다: `parsed`(verify 명령 출력에서 읽음), `ran`(테스트 수를 위해 실행), `cache`(캐시). `harness verify` 출력은 `test count: ok (base 5 [cache], head 5 [parsed])` 처럼 수 옆에 출처를 보인다.

### 6.3 기준 check
계약의 모든 check 실행 → 기준별 pass/fail. check 가 하나도 없는 계약은 fail(공허한 통과 방지). `new: true` 기준은 **base에서 fail이어야 한다**(base에서 이미 통과하면 공허한 기준 → fail로 보고).
base 쪽 실행 전에 `verify.test_paths`(경로 매칭은 SR-4 의 `secret_globs` 와 같은 규칙) 에 맞는 테스트 파일 중 merge-base 대비 **추가·수정된 것(untracked 포함)** 을 작업 트리 내용 그대로 base 임시 worktree 에 얹는다 — "기능의 테스트가 기능 이전 코드에서 이미 통과하는가"를 본다. 새 테스트 파일에 든 기준이 base 에서 "테스트 없음"으로 실패해 non-vacuous 로 세어지던 빈틈을 막는다. 삭제된 테스트 파일은 base 쪽에 그대로 둔다. 작업 트리 쪽 경로가 심볼릭 링크면 얹지 않고, base 쪽 대상이 심볼릭 링크나 디렉터리면 먼저 지운 뒤 쓴다(링크를 따라 쓰지 않는다). `verify.test_paths` 가 비어 있으면 얹지 않고, `new: true` 기준이 있을 때 경고한다. §6.2-3 의 `test_count` 는 얹기 전 base 에서 센다(얹은 뒤에 세면 기능이 지운 테스트가 base 쪽에서도 사라져 감소를 못 잡는다). 얹기가 실패하면 verify 는 `io` 오류로 끝난다. 경로는 프로젝트(`.harness` 가 있는 디렉터리) 기준으로 매칭한다. sdlc 프로필 기본값: `test/**`, `tests/**`, `__tests__/**`, `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`.

**base 실행 시간 제한** (`verify.vacuity_timeout_sec`, 기본 120): `new: true` 기준의 base vacuity 실행 하나하나는 `verify.vacuity_timeout_sec` 과 `budget.step_timeout_sec` 중 작은 값으로 제한된다. base 쪽 실행이 시간을 넘기면 프로세스 트리째 종료되고, 그 기준은 base 에서 통과하지 않은 것으로 본다 — vacuous 가 아니고 head 결과대로 판정되며 결과에 `base_timed_out: true` 가 남는다(head 쪽 `timedOut` 과 다르고 fail 사유가 아니다). base 임시 worktree 는 시간 초과여도 verify 끝에 지워진다. head 쪽 기준 check·`verify.commands`·`test_count`(base 쪽 테스트 수 포함) 는 지금처럼 `budget.step_timeout_sec` 으로만 제한된다. 값이 양의 숫자가 아니면 `verify.vacuity_timeout_sec` 을 담은 `config_invalid`(exit 2, §4). 범위 밖: base 쪽 실행 결과 캐시.

**동시 실행** (`verify.check_parallel`):
- 기준 check(작업 트리)와 `new: true` 기준의 base vacuity 실행(base 임시 worktree)은 하나의 상한을 공유해 동시에 최대 `verify.check_parallel` 개 실행된다. 없거나 `'auto'`(기본)이면 max(1, floor(CPU 수 / 4))(가용 CPU 수; `harness run` 안에서는 run 시작 때 읽은 값)이다. `'auto'` 도 1 이상의 정수도 아니면(0·소수·다른 문자열·숫자 문자열) 작업 없이 `config_invalid`(exit 2), 메시지에 `verify.check_parallel` 이 나온다(§4).
- 실행 순서 제약: **base 테스트 수 → 얹기 → base vacuity**. §6.2-3 의 head·base 테스트 수 산출이 모두 끝나고 기능의 테스트 파일을 base 에 얹은 뒤에만 기준 check 와 base vacuity 실행이 시작된다. head 쪽과 base 쪽 테스트 수는 동시에 센다.
- 결과의 `criteria` 는 check 가 끝난 순서와 무관하게 계약 순서다.
- 다른 실행과 동시에 돌다가 실패한 check 는 모든 동시 실행이 끝난 뒤 혼자 한 번 더 실행한다(하나씩, 계약 순서). 그때 통과하면 pass 로 기록하고 결과에 `parallel_retry: true`, `warnings` 에 기준 id 를 남긴다(공유 자원 의존 가능성 — 필요하면 `check_parallel` 1). 다시 실패하면 fail(`parallel_retry: true`)이다. 단독 재확인에서 통과한 `new: true` 기준은 그 뒤 base vacuity 실행도 혼자 한다. 시간 초과된 check 는 단독 재확인 없이 fail(`timedOut`)이고, 다른 check 의 결과는 그대로 기록된다.
- **base 단독 재확인**: `new: true` 기준의 base vacuity 실행이 다른 실행과 동시에 돌다가 통과하지 못하면(실패·시간 초과 모두) 경합 때문에 실패했을 수 있고, 그러면 vacuous 기준이 통과할 수 있다. 그래서 그 결과로 판정하지 않고, 모든 동시 실행(head 단독 재확인 포함)이 끝난 뒤 그 base 실행을 혼자 한 번 더 한다(하나씩, 계약 순서, 같은 base 시간 제한). vacuous 판정은 이 단독 실행 결과로 한다 — 통과하면 vacuous, 실패면 head 결과대로, 시간 초과면 vacuous 가 아니고 `base_timed_out: true`. 재확인한 기준의 결과에는 `base_retry: true` 가 남는다. `verify.check_parallel` 이 1 이면 동시 실행이 없으므로 base 단독 재확인도 없다.
- `verify.check_parallel` 이 1 이면 지금처럼 모두 하나씩 순서대로 실행된다: head 테스트 수 → base 테스트 수, 그다음 기준마다 check → (필요하면) base vacuity. 동시 실행이 없으므로 단독 재확인도 없다.
- 범위 밖: `verify.commands` 끼리의 병렬 실행(§6.1 은 항상 순서대로), check 별 자원 충돌(DB·포트) 자동 감지 — 필요한 프로젝트는 `check_parallel` 1 로 설정한다.

## 7. 독립 평가 (`harness eval F{n}`)
1. evaluator 역할 어댑터로 headless **읽기 전용** 세션 실행. 입력: 동결 계약 + diff(시크릿 제외 §9) + verify 결과.
2. 출력 JSON 스키마:
```json
{"scores": {"functionality":0,"quality":0,"security":0,"errors":0,"tests":0},
 "findings": [{"criterion_id":"AC-1|REGRESSION","dimension":"...","summary":"...","repro":"<cmd>","severity":"high|medium|low","backlog_id":"B3"}],
 "out_of_scope": [{"summary":"...","severity":"high|medium|low","backlog_id":"B3"}]}
```
   `severity`·`backlog_id` 는 선택이며 backlog 로 가는 항목에만 쓰인다(§7.7). 스키마 밖 값은 스키마 오류가 아니라 무시된다.
3. 코어 판정:
   - 스키마 불일치 → 1회 재요청, 재실패 시 라운드 무효(`eval_error`, 라운드 소모 없음, 2회 연속이면 blocked). eval_error 는 `verdicts/F{n}-r{k}.eval_error.json`(consecutive 카운터 포함)에 기록하며 라운드 파일로 세지 않는다. 어댑터 `timeout`·`exit_nonzero` 도 eval_error(재시도 없음).
   - finding이 **차단적**이려면: `criterion_id`가 계약에 존재(또는 `REGRESSION`) ∧ `repro` 존재 ∧ **코어가 worktree에서 repro를 실행해 비정상 종료 재현**. 그 외는 `backlog.json`으로. repro 가 명령 미발견(127/9009, Windows `cmd.exe` 의 exit 1 + stderr 첫 줄이 `'<프로그램>' is not recognized as an internal or external command` 로 시작 — 문구를 인용만 한 출력은 해당 없음)·실행 불가면 비차단(`repro_not_runnable`), 시그널 종료는 비정상 종료로 본다. 코어는 repro 가 git 내부 조작(update-index 플래그, filter clean/smudge, replace, hooksPath, git config, `.git/config`·`.git/info`)을 포함하면 실행하지 않고 `adversarial_scenario` 로 backlog 한다(D1 의 결정적 보조).
   - verify 가 실패한 상태로 `harness eval` 을 직접 호출하면 evaluator 는 실행되지만 verdict 는 fail 이고 low-score 재요청은 하지 않는다. (`run` 은 verify 통과 후에만 평가를 호출한다 — §8.3.) 이때 판정 파일에 `verify_failures`(§8 보고서의 실패 항목과 같은 `{item, message}` — 실패한 명령 문자열·기준 id·`test_count`·`skip markers`·`.harness changes`, 메시지 앞 300자, env_allowlist 밖 환경 변수 값은 `[redacted]`)가 기록되고 eval 출력의 `verify failures:` 아래에 `<항목> — <메시지>` 로 같은 항목이 나온다. verify 결과에 `flaky_tests`(§6.1)가 있으면 판정 파일에 `flaky_tests` 로, 출력에 `flaky tests: …` 로 기록된다.
   - **위협 경계(D1)**: 결함이 성립하려면 빌더가 **고의로** git 내부·설정(index 플래그 `skip-worktree`/`assume-unchanged`, clean/smudge filter, replace ref, hooks, `.git/config`·`.git/info/*`)이나 셸·런타임 의미를 조작해야 하는 finding은 적대적 시나리오로 분류해 `out_of_scope`(backlog)로 보낸다 — repro가 있어도 차단적이지 않다. 협력적 모델의 **사고**(평범한 도구 사용·평범한 실수로 생기는 결함)만 차단한다. 구조적 백스톱은 §8.5의 병합 후 verify(실제로 병합된 커밋 검증)다. (2026-09-23 사용자 결정 — v1의 비수렴 원인 재발 방지)
   - `score = min(5개 점수)`. critical이면 security < 7 자동 fail.
   - **verdict = pass** ⇔ verify pass ∧ 차단적 finding 0 ∧ score ≥ threshold.
   - 차단적 finding 0 인데 score < threshold(critical의 security < 7 포함) → `unsupported_low_score`. evaluator에 "재현 가능한 finding을 제시하거나 점수를 정정하라"고 **1회** 재요청. 여전히 근거가 없으면 기능 `blocked(needs-human)` — 거짓 통과도, 근거 없는 재작업 루프도 만들지 않는다.
4. critical: security-reviewer 역할로 같은 절차 1회 추가. security-reviewer 는 **security 차원과 그 finding 만** 판정에 반영한다(최종 security = min(evaluator, reviewer)). 나머지 차원 점수는 기록만 한다. 둘 다 pass여야 pass. evaluator 와 security-reviewer 는 **동시에** 실행된다. reviewer 의 low-score 재요청은 순차 실행 때처럼 evaluator 에 차단 finding 이 없을 때만 하며, 그래서 evaluator 결과를 기다린다. evaluator 에 차단 finding 이 있으면 reviewer 결과(점수·finding·backlog 항목·오류)는 판정에 쓰지 않고 verdict 의 `reviews.security-reviewer` 에 `"unused"` 로 기록한다. 판정은 어차피 fail 이라 순차 실행 때와 같다.
5. `independence`: 그 기능에 실제로 쓴 builder 모델(1라운드 모델, 2라운드 이상이면 승격 모델, 충돌 해결을 했으면 충돌 모델 — §10 역할 모델 정책) 중 하나라도 그 기능 등급의 evaluator 모델과 같으면(어댑터와 모델이 같음, 둘 다 미지정도 같음) `fresh-context`, 아니면 `cross-model`. 대화형 eval 은 계약 라운드 k 로 같은 정책을 적용한다. verdict 의 `reviews.evaluator`·`reviews.security-reviewer` 에는 점수와 함께 실제로 호출한 `adapter`·`model` 이 남는다(`"unused"` 는 그대로).
6. **대화형 eval 의 상태 기록** (`harness eval F{n}` 직접 호출 — `run` 은 이 경로를 쓰지 않고 §8.5 대로 병합 후 verify 를 거쳐서만 `passed` 를 기록한다). 수렴 판정은 run 의 `convergence()` 와 같다. verdict 파일에는 `origin: eval`(run 은 `origin: run`)이 남는다.
   - 사전 거부(어댑터 호출 없음, verdict 파일 없음, exit 2): 계약 미승인·해시 불일치 또는 status 가 `approved`·`in_progress` 가 아님. status 가 `passed`·`blocked` 면 메시지에 현재 status. `--round k` 로 이미 verdict 가 있는 라운드를 지정하면 덮어쓰지 않는다. 직전 라운드 verdict 가 JSON 으로 읽히지 않으면 `state_corrupt`(파일 경로 포함, E6).
   - pass → `passed` (출력 `status: passed`, exit 0).
   - fail, 라운드 k < max_rounds, 수렴(k=1 이거나 차단 id 집합이 직전 라운드의 진부분집합) → `in_progress`, exit 1, 출력에 남은 라운드 수(`rounds left: n`).
   - fail 이면서 직전 라운드에 없던 차단 id → `blocked`(reason `divergence`), 차단 집합이 줄지 않음 → `blocked`(reason `stall`), k = max_rounds → `blocked`(reason `rounds`). verify 실패만 있고 finding 이 없는 라운드의 차단 집합은 `VERIFY`.
   - needs-human → `blocked`(reason `needs_human`). eval_error 1회 → status 변화 없음(exit 2), 2회 연속 → `blocked`(reason `eval_error`).
   - `blocked` 이면 backlog.json 에 `source: F{n}-blocked`, `reason`, 재범위 선택지 `split`·`rewrite`·`accept` 항목을 추가한다(같은 라운드·reason 은 한 번만).
   - **라운드와 판정 파일 번호**: 판정 파일 번호는 기능별로 계속 증가한다 — `F{n}-r{k}.json` 의 k 는 계약 버전과 무관하게 기존 최대 번호 + 1 이고, 기존 판정 파일은 덮어쓰지 않는다(`run`·`eval` 모두). 라운드 상한(max_rounds)과 수렴 비교는 계약 해시 단위다 — 현재 승인 해시와 같은 `contract_hash` 의 판정만 세고, 수렴은 그 해시의 직전 판정하고만 비교한다. 그래서 blocked 후 새 버전으로 재승인하면 max_rounds 라운드를 새로 받는다. 판정 기록의 `contract_round` 가 현재 계약 해시 안에서의 라운드 번호이고, 출력에 `round <contract_round>/<max_rounds>` 가 나온다. `contract_hash` 가 없는 판정(F18 이전 기록)은 다른 계약의 라운드로 취급해 파일 번호 계산에만 넣는다. 판정 파일이 JSON 으로 읽히지 않으면(해시를 알 수 없음) 어댑터 호출 없이 `state_corrupt`(파일 경로 포함, E6).
   - features.json 쓰기가 실패하면 verdict 파일은 남기고 exit 2(`io`). features 항목의 `eval_round` 가 기록된 마지막 라운드이며, 최신 `origin: eval` verdict 의 라운드가 그와 다르면 다음 `harness eval F{n}` 은 새 평가 없이 그 라운드의 상태 기록을 재시도한다.
7. **backlog 정리 루프** (`backlog.json`)
   - **id**: 코어가 backlog 를 쓸 때(평가 결과 기록, blocked 재범위 제안, resolves 해결) `id` 가 없는 항목(기존 항목 포함)에 파일 순서대로 `B1`, `B2`, … 를 붙인다. 새 번호는 기존 `B<n>` 중 가장 큰 번호 다음이고, 이미 있는 id 는 바뀌지 않는다. id 가 중복된 backlog 는 E6(state_corrupt, 메시지에 중복 id) — 평가·status·lint-contract 가 파일을 고치지 않고 exit 2.
   - **severity → priority**: findings·out_of_scope 항목의 `severity`(`high`·`medium`·`low`)는 backlog 항목의 `priority` 로 기록된다. 그 외 값은 무시되고 `priority` 를 쓰지 않는다. 기존 항목의 priority 는 소급 추정하지 않는다.
   - **열린 항목**: `resolved_by` 가 없는 항목. 평가 프롬프트의 `## Open backlog` 절에 열린 항목의 `id`·`priority`·`summary` 를 priority `high`→`medium`→`low`→없음 순(같은 priority 안에서는 파일 순서)으로 최대 40개 넣는다.
   - **반복 지적 합치기**: 평가자 출력 항목의 `backlog_id` 가 열린 항목 id 와 같으면 새 항목을 만들지 않고 그 항목의 `seen` 을 1 늘리고(없으면 1 로 보고 2) `sources` 에 `F{n}-r{k}`(이번 기능·판정 파일 번호)를 추가한다. `backlog_id` 가 없는 id 이거나 이미 해결된 항목을 가리키면 새 항목으로 추가된다. 요약 문장의 유사도로 자동 중복 판정은 하지 않는다.
   - **resolves**: 계약의 `resolves`(§5)에 적힌 열린 항목은 그 기능이 `passed` 로 기록될 때(대화형 `harness eval` §7.6, `harness run` §8.5 각각) `resolved_by` 가 기능 id 가 된다. fail·blocked 이면 바뀌지 않는다. 이미 해결된 항목의 `resolved_by` 는 덮어쓰지 않는다.
   - **status**: `harness status` 는 `backlog: N open (high a · medium b · low c · none d)` 줄과 열린 `high` 항목 최대 5개(id·summary 앞 100자)를 보여 준다. `--brief` 에는 열린 high 항목 수만 ` — backlog high: n` 으로 덧붙인다(0 이면 생략). backlog.json 이 `{ items: [...] }` 가 아니면 status 도 E6 로 exit 2.
   - **새 계약을 쓸 때**(spec skill): 열린 `high` 항목을 검토해 이 기능이 해결하는 항목의 id 를 `resolves` 에 넣는다.

## 8. 자율 실행 (`harness run [F…] [--max-usd N] [--parallel N]`)
**사전 점검**: 새 run 은 integration 브랜치·첫 기능의 worktree·`harness/F{n}` 브랜치를 만들거나 builder 를 부르기 전에 `harness doctor`(§10)의 역할 판정을 확인한다. builder·evaluator 가, 범위(인자로 준 기능, 없으면 `approved`/`in_progress` 기능 전체)에 `critical` 기능이 있으면 security-reviewer 도 usable 이어야 한다 — 하나라도 usable 이 아니면 각 역할 이름과 이유(`not installed`, `--help lacks …`, `not authenticated …`)를 담은 메시지로 exit 2, 아무것도 만들지 않는다. critical 기능이 범위에 없으면 security-reviewer 는 보지 않는다. 범위에 실행할 기능이 없으면 점검하지 않는다. `--resume` 재개는 점검하지 않는다.
run 도중 evaluator(또는 security-reviewer) 어댑터가 `adapter_unavailable`(예: gemini 인증 실패 exit 41)을 돌려주면 그 기능은 eval_error 재시도 없이 바로 blocked(`adapter_unavailable`)이고, 다음 기능도 같은 역할을 쓰므로 run 전체가 정지한다(`stopped: adapter_unavailable`).

기능별(의존 순서, `approved`와 대화형 eval 이 남긴 `in_progress`):
1. worktree `.harness/wt/F{n}` + 브랜치 `harness/F{n}` (base = integration 브랜치)
2. **build**: builder headless 세션(쓰기 가능, CLI 네이티브 sandbox) — 계약 + 직전 라운드 차단적 finding 전달
3. verify (§6) 실패 시 build 재시도, 라운드당 최대 3회. 3회 모두 실패하면 평가 없이 라운드 fail — 차단 집합 = 실패 기준 id (+`VERIFY:commands`/`VERIFY:integrity`)
4. eval (§7)
5. pass → `integration` 브랜치에 `--no-ff` 병합(사용자 작업 트리가 아닌 전용 `.harness/wt/_integration` 에서) → 병합 후 verify → 성공 시 `passed`. 병합 후 verify 실패 → integration 을 병합 전 커밋으로 되돌리고 1회 복구(아래 **병합 후 verify 복구**), 복구 뒤에도 실패하면 blocked(`post_merge_verify`)
6. fail → **수렴 검사**: 라운드 k(≥2)에서
   - 발산: k-1에서 통과한 기준 id가 k에서 차단적 finding으로 등장
   - 정체: **차단 기준 id 집합**의 크기가 k-1 대비 감소하지 않음(같은 기준의 finding 여러 개는 하나로 센다)
   - 둘 중 하나, 또는 k = max_rounds(기본 3) 소진 → `blocked`
7. blocked → 재범위 제안(분할/기준 재작성/위험 수용)을 backlog에 기록, 의존 기능은 `skipped`, 독립 기능은 계속. **critical이 blocked면 run 전체 정지.**
8. 라운드 k 는 이번 계약(승인 해시)의 라운드이고 보고서의 라운드 수도 그것이다. 라운드 상한·수렴 비교는 계약 해시 단위이며, 판정 파일 번호는 기능별로 계속 증가한다(§7.6) — 이전 계약의 `F{n}-r{k}.json` 이 있으면 새 판정은 다음 번호에 쓰고 기존 파일은 덮어쓰지 않는다. run 은 같은 계약 해시의 이전 판정(대화형 `harness eval` 의 판정 포함)을 이어받아 라운드 상한과 수렴 비교에 넣는다 — 그 판정이 j 개면 run 의 첫 라운드는 j+1 이고(보고서·결과의 라운드 수도 이 번호), 첫 라운드의 fail 은 그 해시의 직전 판정(fail 일 때)과 수렴 비교한다. j ≥ max_rounds 면 builder 를 부르지 않고 `blocked`(`max_rounds`). 이전 판정 파일이 JSON 으로 읽히지 않으면 builder 호출 전에 `state_corrupt`(파일 경로 포함, exit 2, E6).
9. 종료 → `runs/{ts}.md` 보고서. integration → main 병합은 하지 않는다(PR 생성은 `gh` 가 있으면 제안만).

**병렬 실행** (`run.max_parallel`, `run.verify_parallel`, `harness run --parallel N`):
- `run.max_parallel` 이 없거나 `'auto'`(기본)이고 `--parallel` 도 없으면 의존성이 충족된 `approved` 기능을 개수 제한 없이 모두 동시에 시작한다. `run.max_parallel` 이 1 이상의 정수이거나 `--parallel N`(우선, `--resume` 에서도 바꿀 수 있음)이면 그 수가 동시에 진행하는 기능의 상한이고, 1 이면 기능을 하나씩 진행한다. 동시에 시작하는 기능은 서로 의존하지 않는다. 범위 안의 기능에 직접·전이 의존하는 기능은 빈 슬롯이 있어도 의존 기능이 `passed`(병합과 병합 후 verify 완료)가 된 뒤에만 시작한다. `run.max_parallel` 이 `'auto'` 도 1 이상의 정수도 아니면(`'auto'` 가 아닌 문자열·0·소수 등), 또는 `run.verify_parallel` 이 `'auto'` 도 1 이상의 정수도 아니면 작업 없이 `config_invalid`(exit 2), `--parallel` 값이 양의 정수가 아니면 `usage`(exit 2)이고, 모두 메시지에 키·옵션 이름이 나온다.
- **verify 풀**: 기능의 verify 와 병합 후 verify 는 build·eval 과 별도인 풀에서 실행되고 동시에 `run.verify_parallel` 개를 넘지 않는다. `run.verify_parallel` 이 없거나 `'auto'` 면 max(1, floor(CPU 수 / 8))(가용 CPU 수는 run 시작 때 한 번 읽는다)이다. build·eval 은 이 풀의 영향을 받지 않는다.
- **git 직렬화**: `git worktree add`·`remove` 와 브랜치 생성·삭제·병합(`git branch`, `git merge`, `git worktree add -b` 포함)을 하는 모든 코어 git 호출은 하나의 잠금으로 직렬화된다 — 병렬 기능들의 이런 호출은 서로 겹치지 않는다.
- 기능마다 자기 worktree(`.harness/wt/F{n}`)에서만 build·verify·eval 이 실행된다. 상태 파일의 `active` 가 진행 중인 기능 전부를 담는다(`current` 는 그 첫 항목). 한 프로세스가 동기적으로 쓰므로 쓰기가 유실되지 않는다.
- integration 브랜치 병합은 한 번에 하나만 한다. 각 병합의 병합 후 verify 가 끝난 뒤에야 다음 병합이 시작된다. 먼저 병합된 기능은 `passed` 로 남는다.
- **병합 충돌 해결**: 기능 병합이 충돌하면 integration 병합을 되돌리고(`git merge --abort`, integration 은 병합 전 커밋 그대로) 즉시 blocked 하지 않는다. 코어가 그 기능 worktree 에서 integration 브랜치를 병합해 충돌 상태를 만들고, 충돌 파일 목록을 담아 builder 를 1회 호출한다(그 기능 worktree 에서만, 병합 잠금 밖에서 — 다른 기능의 병합은 계속된다). builder 가 성공하고 충돌 파일에 충돌 표시가 없으면 코어가 그 병합 커밋을 완성하고, verify·eval 을 다시 거친다(verify·eval 의 base 는 병합한 integration 커밋). 통과하면 다시 병합해 `passed` 가 된다. 충돌 해결 시도 뒤에도 병합이 충돌하거나, builder 가 실패하거나, 충돌 표시가 남아 있거나, 다시 거친 verify·eval 이 실패하면 blocked(`merge_conflict`)이고 integration 은 그 기능 병합 전 커밋 그대로다. 충돌 해결은 기능당 1회이며 라운드를 소모하지 않는다(보고서의 라운드 수·수렴 비교에 들어가지 않는다).
- **충돌 표시**: 충돌 표시는 줄 시작의 `<<<<<<< `·`>>>>>>> `(공백 포함)와 단독 `=======` 줄(CRLF 포함)만이다. 줄 중간에 `<<<<<<<` 를 인용한 문서(예: 이 SPEC)는 충돌 표시가 아니다.
- **병합 후 verify 복구**: 병합 후 verify 가 명령 없음이 아닌 이유로 실패하면 코어가 integration 병합을 되돌린 뒤(integration 은 병합 전 커밋 그대로) 즉시 blocked 하지 않는다. 그 기능 worktree 에 integration 브랜치를 병합하고, 실패한 항목(명령 문자열 또는 기준 id 와 메시지 — 보고서의 `- failed:` 줄과 같은 형식)을 담아 builder 를 1회 호출한다(그 기능 worktree 에서만, 병합 잠금 밖에서). builder 가 성공하면 verify·eval 을 다시 거치고(base 는 병합한 integration 커밋) 통과하면 다시 병합해 `passed` 가 된다. 복구 뒤에도 verify·eval·병합 후 verify 가 실패하거나 builder 가 실패하면 blocked(`post_merge_verify`)이고 integration 은 그 기능 병합 전 커밋 그대로다(복구 뒤 병합이 충돌하면 `merge_conflict`). 병합 충돌 해결과 이 복구는 합쳐서 기능당 1회다 — 먼저 한쪽을 썼으면 다른 쪽 실패는 복구 없이 blocked 이다. 복구는 라운드를 소모하지 않는다(보고서의 라운드 수·수렴 비교에 들어가지 않는다). 명령 없음이면 복구하지 않고 지금처럼 environment 사유로 run 이 멈춘다(아래 명령 없음 규칙). 복구 builder 호출은 지표의 `post_merge_recovery` 단계다.
- **integration 참조 확인**: 병합 충돌 해결과 병합 후 verify 복구는 기능 worktree 에 integration 브랜치를 병합하기 전에 `refs/heads/<integration_branch>` 가 커밋으로 해석되는지 확인한다. 해석되지 않으면 `git merge` 를 호출하지 않고 그 기능만 blocked(`merge_conflict`)이며 detail 에 integration 브랜치 이름이 나온다. git 에 `null`·`undefined`·빈 문자열 참조가 전달되지 않는다.
- **builder 변경 커밋**: 병합 전 기능 worktree 에 커밋되지 않은 builder 변경이 있으면 코어가 `harness: F<n> round <r> builder changes` 로 커밋한다. `.harness/runs/test-count-cache.json`(§6.2-3 캐시)은 스테이징하지 않으며, 그것 말고 바뀐 것이 없으면 커밋하지 않는다.
- 비용은 run 합계 하나로 누적된다. 합계가 run 예산을 넘으면 새 기능도 새 단계(build·verify·eval·병합)도 시작하지 않고, 진행 중인 기능은 현재 단계가 끝나면 blocked(`budget`)가 된다. 그 뒤 run 이 `budget` 으로 멈춘다.
- critical 기능이 blocked 되면(그 밖의 run 정지 사유도 마찬가지) 새 기능을 시작하지 않는다. 진행 중인 다른 기능은 현재 라운드를 끝낸다. 통과하면 병합까지 하고, 라운드가 fail 이면 다음 라운드 없이 blocked(`run_stopped`, backlog 재범위 제안 없음)가 된다. 그 뒤 run 이 `critical_blocked` 로 멈춘다.
- SIGINT 는 진행 중인 모든 단계의 프로세스 트리를 종료하고 진행 중이던 기능 전부를 상태 파일에 저장한다. `--resume` 은 그 기능 전부를 슬롯 수와 상관없이 이어서 진행한다. 한 기능의 치명적 오류(시스템 잠자기 뒤 timeout 난 단계, 상태 파일 손상)도 다른 기능의 단계를 멈추고 같은 방식으로 저장한다.
- critical 기능의 evaluator 와 security-reviewer 는 동시에 실행된다. evaluator 에 차단 finding 이 있으면 reviewer 결과는 `unused` 로 기록된다(§7.4).
- 보고서에 실제 적용된 `max parallel: N`(`auto` 면 `auto (no limit)`)·`verify parallel: N`(`auto` 면 CPU 수와 함께), 병렬로 진행된 모든 기능의 결과와 기능별 충돌 해결 여부(`no`·`resolved`·`failed`)가 나온다. 기능 표의 `Merge recovery` 열은 병합 복구 시도와 결과다 — `none`, 또는 `conflict → passed|failed`·`post_merge_verify → passed|failed`(결과 객체의 `mergeRecovery`: `{kind, result}` 또는 null).
- 범위 밖: verify 명령의 병렬화(기준 check·base 실행·test_count 의 동시 실행은 §6.3), 여러 run 프로세스의 동시 실행, 진행 중 기능의 우선순위 조정, API 요금 한도(429)에 따른 자동 감속, 파일 겹침을 미리 예측하는 스케줄링.

**실행 지표와 `harness stats`** (§8.11):
- `harness run` 은 단계가 끝날 때마다 `runs/{runId}.metrics.jsonl` 에 JSON 한 줄을 추가한다. 단계는 `build`(build 시도마다)·`verify`(기능 worktree 의 verify 마다)·`eval`·`merge`(integration 병합 시도, outcome `merged`·`conflict`)·`post_merge_verify`, 충돌 해결이 있으면 `conflict_resolve`, 병합 후 verify 복구가 있으면 `post_merge_recovery` 다. 필드는 정확히 `feature`·`round`(이번 계약의 라운드)·`step`·`started_at`·`ended_at`(ISO 8601)·`duration_ms`·`cost_usd`(어댑터가 보고하지 않거나 코어 단계면 null)·`role`(`builder`·`evaluator`, verify·merge 같은 코어 단계는 `core`)·`adapter`·`model`(그 단계에서 실제로 호출한 값 — §10 역할 모델 정책으로 고른 등급별·승격·충돌 모델, 코어 단계는 null)·`outcome`(build·conflict_resolve·post_merge_recovery 는 `ok` 또는 어댑터 오류, verify 는 `pass`·`fail`·`error`, eval 은 판정) 이다. run 의 eval 단계는 한 줄이고 비용은 evaluator 와 security-reviewer 의 합이다.
- 대화형 `harness eval` 은 evaluator·security-reviewer 어댑터 호출(재요청 포함)마다 `runs/eval.metrics.jsonl` 에 같은 형식의 한 줄을 추가한다(`step` = `eval`, `role` = 호출한 역할, `outcome` = `ok` 또는 어댑터 오류).
- 지표 줄에는 위 필드만 있다 — 프롬프트·diff·어댑터 출력 본문·환경 변수 값은 들어가지 않는다.
- run 보고서에 기능별 단계 표(`## Steps`, 라운드·단계·시간·비용·모델·outcome)가 들어간다.
- `harness stats [--since YYYY-MM-DD] [--json]` 은 `runs/` 의 모든 `*.metrics.jsonl` 을 모아 단계별 횟수·중앙값·p90(nearest rank: 정렬한 값의 ceil(0.9·n) 번째) 시간·비용 합과 평균, 역할·모델 쌍별 비용 합, 기능별 1라운드 통과율과 평균 라운드 수(판정 outcome `pass`·`fail` 이 있는 eval 줄 기준 — 기능의 라운드 수는 그 줄들의 최대 round, 1라운드 통과는 round 1 의 `pass`)와 제안을 출력한다. `--json` 이면 같은 내용을 JSON(`steps`·`cost_by_role_model`·`features`·`suggestions` 등)으로 출력한다. `--since` 는 `ended_at` 이 그 날짜(UTC 0시) 이후인 줄만 집계하고, 날짜 형식이 틀리면 `usage`(exit 2).
- JSON 객체가 아닌 줄은 건너뛰고 stderr 에 파일 이름과 줄 번호(`warning: <file>:<line>: …`)를 담은 경고를 내며 exit 0 이다. metrics 파일이 하나도 없으면 `no metrics yet` 을 출력하고 exit 0 이다.
- 제안(규칙 기반, config 에 자동 적용하지 않는다): (a) `ended_at` 기준 최근 10개 줄 중 2개 이상의 시간이 `budget.step_timeout_sec 의 90%` 이상이면 `step_timeout` — `budget.step_timeout_sec` 상향, (b) `verify`·`post_merge_verify` 시간 합이 전체 단계 시간의 30% 를 넘으면 `verify.check_parallel` 상향, (c) builder 비용이 전체 비용의 70% 를 넘고 features.json 에 standard 기능이 있으면 `builder_model` — standard 기능의 builder 에 더 싼 모델. 조건이 맞는 규칙만 출력한다.
- 범위 밖: 기존 보고서·판정에서 과거 지표를 역산, 제안의 자동 적용, 비용을 보고하지 않는 어댑터의 비용 추정.

예산: 단계별 timeout(기본 30분), 단계별 USD(어댑터 지원 시), run 전체 USD. 단계 초과 시 해당 기능 blocked(`budget`), run 초과 시 진행 중 기능 blocked(`budget`) 후 전체 정지.
중단 복구: run은 상태 파일(`runs/current.json`, config 스냅샷 포함)만으로 재개 가능(`harness run --resume`). run 이 실제로 쓰는 config 스냅샷(새 run·재개·직접 전달 모두)은 시작 전에 §4 의 형식 검사를 다시 거친다 — 형식이 틀리면 작업 없이 `config_invalid` exit 2. SIGINT 는 진행 중 단계의 프로세스 트리를 종료하고 상태를 저장한 뒤 exit 130.
잠자기 방지: run 은 첫 기능 전에 시스템 잠자기를 막는 프로세스를 시작하고 run 이 끝나면(SIGINT 중단 포함) 종료한다 — darwin 은 `caffeinate -i -w <run 의 pid>`, linux 는 `systemd-inhibit --what=idle:sleep --mode=block …`(run 의 pid 가 사라지면 끝나는 대기 명령을 붙잡는다). PATH 검색으로 찾은 고정 이름만 인자 배열로, 셸 없이 실행하며 config 값·기능 id 는 인자에 넣지 않는다. 명령이 PATH 에 없거나 시작 직후(또는 run 도중) 종료되면, 또는 win32 등 그 밖의 platform 이면 run 은 그대로 진행하고 출력과 run 보고서에 `sleep inhibitor unavailable` 이 나온다(Windows 의 잠자기 방지, 배터리에서 덮개를 닫을 때의 강제 잠자기는 범위 밖).
잠자기로 끊긴 단계: 단계(build·verify·병합 후 verify 포함·eval) 도중 시스템 잠자기가 60초 이상 감지되고(벽시계 경과 − 단조 시계 경과, 또는 주기 tick 사이 벽시계 간격의 초과분) 그 단계가 timeout 으로 끝나면(build·eval 어댑터의 `timeout`, verify 명령·기준 check 의 timeout) 그 기능은 blocked(`budget`)가 아니다 — run 은 상태를 저장하고 중단하며 출력에 `system sleep` 과 `harness run --resume` 이 나온다(exit 1). 기능 status 는 바뀌지 않고(`in_progress`), build 시도 횟수와 eval_error 횟수도 소모되지 않는다. `harness run --resume` 은 같은 라운드의 중단된 단계를 다시 수행한다(build 가 끝나고 verify 가 끊겼으면 verify 부터). 잠자기가 감지되지 않은(60초 미만 포함) timeout 은 지금처럼 blocked(`budget`)이고, timeout 없이 잠자기만 있었던 단계는 영향이 없다. 잠자기 시간만큼 단계 제한 시간을 늘리지는 않는다.
환경 실패(명령 없음): run 의 verify(기능 worktree) 또는 병합 후 verify 에서 `verify.commands`·`test_count`·기준 check 중 하나가 명령 없음(POSIX exit 127, Windows exit 9009 또는 cmd.exe 의 `'<프로그램>' is not recognized …`, spawn ENOENT)으로 끝나면 기능의 잘못이 아니므로 그 기능은 blocked 가 아니다 — run 은 상태를 저장하고 environment 사유로 멈추며(exit 1) 출력에 명령 이름(셸 메시지가 가리키는 프로그램, 없으면 명령의 첫 단어)·`command not found`·`harness run --resume` 이 나온다. 병합 후 verify 에서면 integration 을 병합 전 커밋으로 되돌린 뒤 멈춘다. 기능 status(`in_progress`)·라운드·build 시도 횟수는 바뀌지 않는다. `harness run --resume` 은 중단된 단계부터 다시 수행한다(build 가 끝났으면 builder 없이 verify 부터, 병합 후 verify 였으면 병합부터) — 라운드를 소모하지 않는다. 명령이 여전히 없으면 builder 를 부르지 않고 같은 사유로 다시 멈춘다(라운드·비용 소모 없음). 병렬 run 에서는 새 기능을 시작하지 않고, 진행 중인 다른 기능은 현재 단계를 끝낸 뒤(프로세스를 죽이지 않는다) 다음 단계 전에 멈추며, 진행 중이던 기능 전부가 상태 파일의 `active` 에 남는다. 명령 없음이 아닌 실패(exit 1 등)는 지금처럼 라운드 실패·blocked 규칙을 따른다. 디스크·네트워크 같은 다른 환경 문제의 분류와 PATH 자동 복구는 범위 밖이다.
보고서의 실패 항목: verify(라운드의 마지막 verify) 또는 병합 후 verify 실패로 blocked 된 기능은 보고서의 `Blocked` 절에 실패한 항목마다 `- failed: `<항목>` — <메시지>` 줄이 나온다. 항목은 실패한 명령 문자열(`verify.commands`), 기준 id, `test_count`, `skip markers`·`.harness changes` 이고, 메시지는 실패 설명(명령은 출력 끝부분 포함)의 앞 300자다. 메시지에서 env_allowlist(§9 SR-2) 밖 환경 변수의 값(8자 이상)은 `[redacted]` 로 바뀐다.
흔들린 테스트: 기능의 verify(병합 후 verify 포함) 결과에 `flaky_tests`(§6.1)가 있으면 run 결과의 그 기능 항목에 `flaky_tests`(합, 최대 20개)로, 보고서의 `## Flaky tests` 절에 `- F{n}: `이름`, …` 줄로 나온다.
이전 run 의 `harness/F{n}` 브랜치가 남아 있으면 자동으로 지우지 않는다(작업 보존) — 해당 기능은 blocked(`worktree`), 사용자가 브랜치를 지우고 재시도한다. blocked 기능의 worktree 는 점검용으로 남기고, passed 기능의 worktree·브랜치는 제거한다.

## 9. 보안 요구사항
- SR-1 verify·check·repro 명령은 **worktree를 cwd로**, timeout과 함께 실행된다.
- SR-2 repro/check 실행 환경은 env 허용목록(PATH, HOME, LANG, TMP 계열, config에서 추가한 이름)만 전달 — API 키·토큰 미전달.
- SR-3 repro는 deny 패턴(`git push`, `rm -rf /`, `rm -rf ~`, `curl … | sh`, `sudo`)에 걸리면 실행하지 않고 finding을 비차단 처리. 판정은 셸이 실제로 실행할 명령 기준 — 줄 이음(백슬래시+개행)을 제거한 뒤 검사한다.
- SR-4 headless 프롬프트에 들어가는 diff에서 `.env*`, `*.pem`, `*.key`, `id_*`, `*.p12`, config의 `secret_globs` 경로 제외. 시크릿 파일의 내용이 다른 경로로 옮겨진 경우도 제외한다: merge-base·HEAD·index·작업 트리에서 시크릿 경로가 가진 blob 과 내용(작업 트리 파일, 또는 추적 파일의 merge-base 버전)이 같은 경로(이름 변경·git 밖 이동·복사), 그리고 git 이름 변경 탐지(`-M`, 유사도 50% 이상, `diff.renameLimit` 제한 없음)가 시크릿 경로를 원본으로 짝지은 대상 경로. 빈 blob 은 내용 일치에 쓰지 않는다. 제외된 경로는 모두 excluded 에 집계된다. 부분 인용·과거 이력의 시크릿은 범위 밖.
- SR-5 코어는 `main`(및 config의 protected 브랜치)에 병합·push하지 않는다. 브랜치 이름은 대소문자를 무시하고 비교한다(대소문자 비구분 파일시스템에서는 같은 loose ref). run 시작 전 로컬 브랜치 목록(`git for-each-ref refs/heads/`)을 확인해, `integration_branch` 와 대소문자만 다른 기존 브랜치(예: `Work` vs `work`)가 있으면 브랜치 생성·worktree 추가·병합 전에 두 이름을 모두 담은 메시지로 exit 2. 철자가 정확히 같은 브랜치는 그대로 쓰고, 없으면 base 에서 만든다. 브랜치 목록을 얻지 못하면 run 을 시작하지 않고 exit 2.
- SR-6 evaluator·security-reviewer는 읽기 전용 모드로 호출된다(어댑터별 플래그).
- SR-7 ops 프로필의 라이브 변경 skill(`rollout`)은 `run` 대상이 될 수 없다(lint가 거부).
- SR-8 기록 파일의 가림: run 상태 파일(`.harness/runs/current.json`), verdict 파일(`F{n}-r{k}.json`·`.eval_error.json`), backlog 항목에 저장되는 문자열(verify 명령·기준 출력과 메시지, `verify_failures`, blocking·backlog 의 요약·repro, re-scope 제안)에서 env_allowlist(SR-2) 밖 환경 변수의 값(8자 이상)은 보고서(§8)와 같은 규칙으로 `[redacted]` 로 바뀐다. 값은 문자열 그대로(정규식 아님) 비교하고, 허용목록 안 변수와 8자 미만 값은 가리지 않는다. 가림은 파일을 쓰기 직전 사본에 적용되고(상태 파일은 모든 저장 경로 — 중단·blocked 포함), run 은 메모리의 원래 값으로 계속한다. 파일을 다시 읽는 데 쓰는 식별자(config 스냅샷, 기능·기준 id, 커밋 sha, 충돌 파일 경로, 라운드 이력)는 가리지 않으므로 `--resume` 은 가려진 상태 파일로도 이어진다. 이미 커밋된 과거 기록과 환경 변수 밖의 비밀은 범위 밖.

## 10. 어댑터 (`harness doctor`)
| 어댑터 | 쓰기(builder) | 읽기전용(evaluator) | 구조화 출력 | 예산 | 모델 |
|--------|--------------|--------------------|------------|------|------|
| claude | `claude -p --permission-mode auto --disallowedTools <deny>` | `--permission-mode plan` | `--output-format json` (+ schema 가 있으면 `--json-schema`) — 비용은 래퍼의 `total_cost_usd`(예산 소진 exit 1 에도 존재) | `--max-budget-usd` | `--model` |
| gemini | `gemini -p "" --approval-mode yolo -s` (`-p ""` 는 headless 선택, 프롬프트는 stdin) | `--approval-mode plan` | `-o json` | timeout만 | `-m` |
| codex (experimental, 플래그 미실측) | `codex exec --sandbox workspace-write -` | `--sandbox read-only` | 프롬프트 + JSON 추출 | timeout만 | `--model` |
| generic | config `adapters.generic.command` | config `adapters.generic.read_only_command` — **없으면 읽기전용 역할 배정 불가**(쓰기 모드로 폴백 금지, SR-6) | JSON 추출 | timeout만 | — |

역할 배정(`config.roles.<role>`)은 `"claude"` 또는 `{"adapter": "claude", "model": "opus"}`. model 생략 시 `adapters.<name>.model`.

**역할 모델 정책.** 객체 배정은 모델을 더 세분할 수 있다:
`{"adapter": "claude", "model": "sonnet", "by_tier": {"critical": "opus", "standard": "sonnet"}, "escalate": "opus", "conflict_model": "opus"}`.
- `by_tier` (모든 역할): 기능의 계약 `security_tier` 별 모델. 해당 등급 키가 없으면 `model`.
- `escalate` (builder): 같은 계약의 2라운드 이상 build(run 이 이어받은 라운드 포함 — 이어받아 시작한 첫 라운드가 2 이상이면 그 라운드부터)에 쓴다. 1라운드는 `by_tier`/`model`.
- `conflict_model` (builder): 병합 충돌 해결 builder 호출(§8.10)에 쓴다. 없으면 그 라운드의 builder 모델(승격 포함).

선택 순서(builder 는 위에서부터, evaluator·security-reviewer 는 셋째부터): `conflict_model`(충돌 해결 호출) → `escalate`(2라운드 이상) → `by_tier.<기능 등급>` → `model` → `adapters.<name>.model` → 미지정(CLI 기본값). 어댑터는 역할의 `adapter` 하나이며 정책은 모델만 바꾼다. 모델 값은 config 검사에서 형식이 확인되고(§4, SR-1) 어댑터 인자 직전에 다시 확인된다. 호출한 모델은 metrics 줄(§8.11)과 verdict `reviews`(§7)에 기록되고 independence(§7 5.)는 실제로 쓴 모델로 정한다.

- 프롬프트는 **stdin**으로 전달한다(Windows 명령줄 길이 한계 회피).
- `<deny>`(builder 쓰기 모드의 네이티브 deny 목록, SPEC D1의 "~5줄"): `Bash(git push:*)`, `Bash(git reset --hard:*)`, `Bash(rm -rf /:*)`, `Bash(rm -rf ~:*)`, `Bash(sudo:*)`. 지원하지 않는 CLI는 해당 CLI의 sandbox 플래그로 대체.
- 어댑터 호출은 CLI 인증을 위해 **부모 env를 상속**한다(SR-2의 허용목록은 verify·check·repro 명령에만 적용).

`doctor`: 설치된 CLI·버전 탐지, 각 어댑터가 쓰는 플래그가 `--help` 출력에 존재하는지 확인(정책의 어느 값이든 모델이 있으면 모델 플래그 포함), 역할 배정 권장(builder ≠ evaluator 모델). 역할 줄에는 기본 모델을, 그 아래 한 줄씩 등급별 모델(`critical`·`standard`)과 builder 의 `escalate (r≥2)`·`conflict` 모델(미설정이면 `not set`)을 보여 준다. 등급마다 builder 가 그 등급에서 쓸 수 있는 모델(1라운드·승격·충돌) 중 하나가 evaluator 의 그 등급 모델과 같으면 `fresh-context for <tier>` 경고를 낸다. 끝에 `test count: <값>` 을, 미설정이면 `test count: not configured` 와 §4 의 `init` 감지 규칙으로 찾은 제안(`suggest: preset:<이름>`, 있을 때)을 출력한다 — config.json 은 쓰지 않는다.
플래그 부재 시 해당 역할 배정 불가로 보고(추측 실행 금지).

gemini 인증 판정(비용이 드는 호출 없이): 환경 변수 `GEMINI_API_KEY` · `GOOGLE_GENAI_USE_VERTEXAI` · `GOOGLE_GENAI_USE_GCA` 중 하나가 (비어 있지 않게) 있거나, 사용자 `~/.gemini/settings.json`(HOME 기준)에 `security.auth.selectedType` 이 있으면 인증됨. 모두 없으면 `not authenticated` — gemini 를 쓰는 역할은 usable 이 아니다(플래그 검사를 통과해도). `settings.json` 이 JSON 으로 읽히지 않으면 스택 트레이스 없이 `not authenticated (settings.json unreadable)`. 판정은 변수·키의 **존재만** 보고, 값은 doctor·run 출력과 보고서에 쓰지 않는다. doctor 는 설치된 gemini 의 CLI 줄에 인증 상태(`authenticated (<변수 이름 또는 settings.json>)` / 이유)를 표시한다 — 역할에 배정되지 않았으면 종료 코드에 영향이 없다. claude·codex 의 인증은 판정하지 않는다.
gemini 실행이 exit 41(인증 실패)로 끝나면 결과는 `exit_nonzero` 가 아니라 `adapter_unavailable` 이고 detail 에 `authentication` 이 나온다(CLI 의 stderr 는 옮기지 않는다).

## 11. 배포 형태 (단일 루트, 빌드 단계 없음)
```
.claude-plugin/plugin.json   Claude Code 플러그인
gemini-extension.json        Gemini 확장 (contextFileName: AGENTS.md)
AGENTS.md                    공통 워크플로우 지시 (Codex·Cursor·opencode 포함)
skills/                      spec · plan · build · fix · status · plan-review · rollout   (SKILL.md)
agents/                      builder · evaluator · security-reviewer (Claude subagent 겸 headless 역할 프롬프트)
profiles/                    sdlc · iac · ops (.json: verify 명령·루브릭)
rules/                       언어별 규칙 (v1 유지)
bin/harness.mjs, lib/*.mjs   코어 (Node ≥ 22 — Node 20 은 2026-04 EOL 이고 `node --test` glob 이 21+ 부터; 런타임 의존성 0)
hooks/hooks.json             Claude SessionStart 1개: `harness status --brief` — Claude 전용(`${CLAUDE_PLUGIN_ROOT}`). Gemini 도 이 파일을 로드하지만 변수가 비어 실패(비치명). Gemini 는 `${extensionPath}` 변형을 쓰는 방법이 확인될 때까지 hook 없음으로 간주
```
설치: `npx github:hanbyeol/cc-harness init` (npm 레지스트리의 `cc-harness` 는 다른 프로젝트) (대상 프로젝트에 `.harness/` 생성, 감지된 CLI별 설치 안내 출력).

## 12. 에러 시나리오
| # | 상황 | 동작 |
|---|------|------|
| E1 | 어댑터 CLI 미설치/미인증 | 해당 단계 실패 → 기능 blocked(`adapter_unavailable`), doctor 안내 |
| E2 | headless 출력 JSON 파싱 실패 | §7.3 재요청 규칙 |
| E3 | 병합 충돌 | 병합 중단(`git merge --abort`), 기능 blocked(`merge_conflict`) |
| E4 | worktree 생성 실패 | 기능 blocked, 나머지 계속 |
| E5 | 예산·timeout 초과 | 프로세스 종료(자식 포함), blocked(`budget`) |
| E6 | 상태 파일 손상(JSON 파싱 불가, §4 형식 위반 — backlog 가 `{ items: [...] }` 아님·항목 id 중복, config 가 객체 아님·객체 키의 타입 오류·배열 키가 배열 아님 또는 빈/비문자열 원소·test_count 타입 오류·알 수 없는 프리셋·`from:commands[i]` 형식 오류 또는 범위 밖, features 항목의 id·title·status 누락/비문자열) | 즉시 정지(exit 2), 파일 경로·필드 이름 또는 항목 번호(`features[i]`)를 포함한 수정 안내 — 추측 복구 금지 |
| E7 | 실행 중 인터럽트(SIGINT) | 현재 단계 종료, 상태 저장, `--resume` 안내 |

## 13. v1 마이그레이션 (`harness migrate-v1`)
`progress/feature_list.json` → `.harness/features.json` (id·이름·passes→status 보존). v1 계약은 변환하지 않고 참조 경로만 기록.
v1 `security_tier: low` 는 `standard` 로 매핑(원래 값은 `v1.security_tier`). v1 항목의 이름은 `name`, 없으면 `title`, 둘 다 없으면 id. id 가 `F<n>` 이 아니면 목록 순서대로 쓰이지 않은 가장 작은 `F<n>` 을 받고 원래 id 는 `v1.id` 에 남는다(`F<n>` id 는 그대로). v1 의존성은 새 id 로 바꿔 `depends_on` 에 넣고(목록에 없는 id 는 빼고 경고) 원본은 `v1.dependencies` 에 보존. v1 status 가 `removed`·`cancelled`·`archived` 로 시작하면(대소문자 무시) `skipped`, 그 외는 passes 로 `passed`/`todo`. 요약에 passed·todo·skipped·재번호 수를 출력. `.harness/features.json` 이 이미 있으면(빈 목록 포함) `--force` 없이 거부.
v1 파일은 v2 브랜치에서 제거 — `v1.39.18-final` 태그로 보존: hooks/*.sh, scripts/, docs/INVARIANTS.md, docs/DECISIONS/, tests/, init.sh, templates/, evals/, config/, progress/, 루트 settings.json, profiles/*.md, v1 전용 agents(architect·deploy-operator·implementer·qa-reviewer·security-auditor·spec-writer·test-writer)·skills(brainstorm·change-request·debug·finish-branch·hotfix·implement·improve·progress·sync-docs). 남겨 두면 플러그인이 v2 skills 와 함께 로드해 충돌한다.
