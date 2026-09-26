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
| `config.json` | profile, verify 명령, 임계값, 예산, max_rounds, 어댑터 역할 배정. 병합 순서 DEFAULTS ← profile ← config (config 우선). `init` 은 verify.commands 를 쓰지 않는다 — 사용자가 정하기 전까지 프로필 기본값이 적용된다. `init` 이 config.json 을 새로 만들 때는 프로젝트의 테스트 러너를 감지해 `verify.test_count` 를 쓴다: `package.json` 의 `scripts.test` 에 `node --test` 가 있으면 `preset:node-test`, 아니고 `go.mod` 가 있으면 `preset:go`, 아니고 `pytest.ini`·`conftest.py` 가 있거나 `pyproject.toml` 에 `[tool.pytest.ini_options]` 절이 있으면 `preset:pytest`. 해당 없으면 키를 쓰지 않는다. 기존 config.json 은 바꾸지 않는다 — `doctor` 가 같은 규칙으로 제안만 한다(§10). 최상위는 JSON 객체여야 하고, 기본값이 객체인 키(`budget`·`verify`·`limits`·`roles`·`rubric`)는 지정 시 객체여야 한다. `verify.commands`·`verify.skip_markers`·`verify.test_paths`·`env_allowlist`·`secret_globs`·`protected_branches` 는 지정 시 빈 문자열이 아닌 문자열의 배열이어야 하고(오류는 키 이름과 원소 번호 `key[i]`), `verify.test_count` 는 문자열 또는 null 이어야 하고, `preset:` 으로 시작하면 `preset:node-test`·`preset:go`·`preset:pytest` 중 하나와 정확히 같아야 한다(아니면 `verify.test_count` 와 사용 가능한 프리셋 이름을 담은 `config_invalid`, §6.2-3). 형식 검사는 프로필과 병합하기 전 사용자 파일에 대해 한다 |
| `features.json` | `[{id, title, security_tier, depends_on[], status}]` — status ∈ `todo·approved·in_progress·passed·blocked·skipped`. 각 항목의 `id`·`title`·`status` 는 필수 문자열. `eval_round`(선택)는 대화형 eval 이 상태를 기록한 마지막 라운드(§7.6) |
| `contracts/F{n}.json` | 계약 (§5) |
| `verdicts/F{n}-r{k}.json` | 라운드별 판정 (§7) |
| `backlog.json` | `{ items: [...] }` — 범위 밖 발견 · blocked 재범위 제안. 항목 id(`B<n>`)·`priority`·`seen`·`sources`·`resolved_by` 규칙은 §7.7 |
| `runs/{ts}.md` | 자율 실행 보고서 |

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
### 6.1 명령
config의 `verify.commands`(예: test·lint·build)를 순서대로 실행. 하나라도 비정상 종료 = fail. 실행 파일이 없으면 `command not found: <이름>` 으로 보고한다(판정 규칙은 §7.3 의 명령 미발견과 같다).
실패 시 **1회 재실행**, 결과가 다르면 `flaky`로 기록하고 fail로 취급.

### 6.2 무결성 검사 (base 대비 diff)
diff = `merge-base(base, HEAD)` ↔ **작업 트리**(커밋 안 된 변경 + untracked 파일 포함). base 측 실행(test_count·vacuous 검사)은 merge-base 를 임시 detached worktree 로 꺼내 수행하고 끝나면 제거한다.
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

### 6.3 기준 check
계약의 모든 check 실행 → 기준별 pass/fail. check 가 하나도 없는 계약은 fail(공허한 통과 방지). `new: true` 기준은 **base에서 fail이어야 한다**(base에서 이미 통과하면 공허한 기준 → fail로 보고).
base 쪽 실행 전에 `verify.test_paths`(경로 매칭은 SR-4 의 `secret_globs` 와 같은 규칙) 에 맞는 테스트 파일 중 merge-base 대비 **추가·수정된 것(untracked 포함)** 을 작업 트리 내용 그대로 base 임시 worktree 에 얹는다 — "기능의 테스트가 기능 이전 코드에서 이미 통과하는가"를 본다. 새 테스트 파일에 든 기준이 base 에서 "테스트 없음"으로 실패해 non-vacuous 로 세어지던 빈틈을 막는다. 삭제된 테스트 파일은 base 쪽에 그대로 둔다. 작업 트리 쪽 경로가 심볼릭 링크면 얹지 않고, base 쪽 대상이 심볼릭 링크나 디렉터리면 먼저 지운 뒤 쓴다(링크를 따라 쓰지 않는다). `verify.test_paths` 가 비어 있으면 얹지 않고, `new: true` 기준이 있을 때 경고한다. §6.2-3 의 `test_count` 는 얹기 전 base 에서 센다(얹은 뒤에 세면 기능이 지운 테스트가 base 쪽에서도 사라져 감소를 못 잡는다). 얹기가 실패하면 verify 는 `io` 오류로 끝난다. 경로는 프로젝트(`.harness` 가 있는 디렉터리) 기준으로 매칭한다. sdlc 프로필 기본값: `test/**`, `tests/**`, `__tests__/**`, `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`.

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
   - verify 가 실패한 상태로 `harness eval` 을 직접 호출하면 evaluator 는 실행되지만 verdict 는 fail 이고 low-score 재요청은 하지 않는다. (`run` 은 verify 통과 후에만 평가를 호출한다 — §8.3.)
   - **위협 경계(D1)**: 결함이 성립하려면 빌더가 **고의로** git 내부·설정(index 플래그 `skip-worktree`/`assume-unchanged`, clean/smudge filter, replace ref, hooks, `.git/config`·`.git/info/*`)이나 셸·런타임 의미를 조작해야 하는 finding은 적대적 시나리오로 분류해 `out_of_scope`(backlog)로 보낸다 — repro가 있어도 차단적이지 않다. 협력적 모델의 **사고**(평범한 도구 사용·평범한 실수로 생기는 결함)만 차단한다. 구조적 백스톱은 §8.5의 병합 후 verify(실제로 병합된 커밋 검증)다. (2026-09-23 사용자 결정 — v1의 비수렴 원인 재발 방지)
   - `score = min(5개 점수)`. critical이면 security < 7 자동 fail.
   - **verdict = pass** ⇔ verify pass ∧ 차단적 finding 0 ∧ score ≥ threshold.
   - 차단적 finding 0 인데 score < threshold(critical의 security < 7 포함) → `unsupported_low_score`. evaluator에 "재현 가능한 finding을 제시하거나 점수를 정정하라"고 **1회** 재요청. 여전히 근거가 없으면 기능 `blocked(needs-human)` — 거짓 통과도, 근거 없는 재작업 루프도 만들지 않는다.
4. critical: security-reviewer 역할로 같은 절차 1회 추가. security-reviewer 는 **security 차원과 그 finding 만** 판정에 반영한다(최종 security = min(evaluator, reviewer)). 나머지 차원 점수는 기록만 한다. 둘 다 pass여야 pass.
5. `independence`: evaluator 어댑터가 builder와 다른 모델이면 `cross-model`, 아니면 `fresh-context`.
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

## 8. 자율 실행 (`harness run [F…] [--max-usd N]`)
**사전 점검**: 새 run 은 integration 브랜치·첫 기능의 worktree·`harness/F{n}` 브랜치를 만들거나 builder 를 부르기 전에 `harness doctor`(§10)의 역할 판정을 확인한다. builder·evaluator 가, 범위(인자로 준 기능, 없으면 `approved`/`in_progress` 기능 전체)에 `critical` 기능이 있으면 security-reviewer 도 usable 이어야 한다 — 하나라도 usable 이 아니면 각 역할 이름과 이유(`not installed`, `--help lacks …`, `not authenticated …`)를 담은 메시지로 exit 2, 아무것도 만들지 않는다. critical 기능이 범위에 없으면 security-reviewer 는 보지 않는다. 범위에 실행할 기능이 없으면 점검하지 않는다. `--resume` 재개는 점검하지 않는다.
run 도중 evaluator(또는 security-reviewer) 어댑터가 `adapter_unavailable`(예: gemini 인증 실패 exit 41)을 돌려주면 그 기능은 eval_error 재시도 없이 바로 blocked(`adapter_unavailable`)이고, 다음 기능도 같은 역할을 쓰므로 run 전체가 정지한다(`stopped: adapter_unavailable`).

기능별(의존 순서, `approved`와 대화형 eval 이 남긴 `in_progress`):
1. worktree `.harness/wt/F{n}` + 브랜치 `harness/F{n}` (base = integration 브랜치)
2. **build**: builder headless 세션(쓰기 가능, CLI 네이티브 sandbox) — 계약 + 직전 라운드 차단적 finding 전달
3. verify (§6) 실패 시 build 재시도, 라운드당 최대 3회. 3회 모두 실패하면 평가 없이 라운드 fail — 차단 집합 = 실패 기준 id (+`VERIFY:commands`/`VERIFY:integrity`)
4. eval (§7)
5. pass → `integration` 브랜치에 `--no-ff` 병합(사용자 작업 트리가 아닌 전용 `.harness/wt/_integration` 에서) → 병합 후 verify → 성공 시 `passed`. 병합 후 verify 실패 → integration 을 병합 전 커밋으로 되돌리고 blocked(`post_merge_verify`)
6. fail → **수렴 검사**: 라운드 k(≥2)에서
   - 발산: k-1에서 통과한 기준 id가 k에서 차단적 finding으로 등장
   - 정체: **차단 기준 id 집합**의 크기가 k-1 대비 감소하지 않음(같은 기준의 finding 여러 개는 하나로 센다)
   - 둘 중 하나, 또는 k = max_rounds(기본 3) 소진 → `blocked`
7. blocked → 재범위 제안(분할/기준 재작성/위험 수용)을 backlog에 기록, 의존 기능은 `skipped`, 독립 기능은 계속. **critical이 blocked면 run 전체 정지.**
8. 라운드 k 는 이번 계약(승인 해시)의 라운드이고 보고서의 라운드 수도 그것이다. 라운드 상한·수렴 비교는 계약 해시 단위이며, 판정 파일 번호는 기능별로 계속 증가한다(§7.6) — 이전 계약의 `F{n}-r{k}.json` 이 있으면 새 판정은 다음 번호에 쓰고 기존 파일은 덮어쓰지 않는다. run 은 같은 계약 해시의 이전 판정(대화형 `harness eval` 의 판정 포함)을 이어받아 라운드 상한과 수렴 비교에 넣는다 — 그 판정이 j 개면 run 의 첫 라운드는 j+1 이고(보고서·결과의 라운드 수도 이 번호), 첫 라운드의 fail 은 그 해시의 직전 판정(fail 일 때)과 수렴 비교한다. j ≥ max_rounds 면 builder 를 부르지 않고 `blocked`(`max_rounds`). 이전 판정 파일이 JSON 으로 읽히지 않으면 builder 호출 전에 `state_corrupt`(파일 경로 포함, exit 2, E6).
9. 종료 → `runs/{ts}.md` 보고서. integration → main 병합은 하지 않는다(PR 생성은 `gh` 가 있으면 제안만).

예산: 단계별 timeout(기본 30분), 단계별 USD(어댑터 지원 시), run 전체 USD. 단계 초과 시 해당 기능 blocked(`budget`), run 초과 시 진행 중 기능 blocked(`budget`) 후 전체 정지.
중단 복구: run은 상태 파일(`runs/current.json`, config 스냅샷 포함)만으로 재개 가능(`harness run --resume`). run 이 실제로 쓰는 config 스냅샷(새 run·재개·직접 전달 모두)은 시작 전에 §4 의 형식 검사를 다시 거친다 — 형식이 틀리면 작업 없이 `config_invalid` exit 2. SIGINT 는 진행 중 단계의 프로세스 트리를 종료하고 상태를 저장한 뒤 exit 130.
잠자기 방지: run 은 첫 기능 전에 시스템 잠자기를 막는 프로세스를 시작하고 run 이 끝나면(SIGINT 중단 포함) 종료한다 — darwin 은 `caffeinate -i -w <run 의 pid>`, linux 는 `systemd-inhibit --what=idle:sleep --mode=block …`(run 의 pid 가 사라지면 끝나는 대기 명령을 붙잡는다). PATH 검색으로 찾은 고정 이름만 인자 배열로, 셸 없이 실행하며 config 값·기능 id 는 인자에 넣지 않는다. 명령이 PATH 에 없거나 시작 직후(또는 run 도중) 종료되면, 또는 win32 등 그 밖의 platform 이면 run 은 그대로 진행하고 출력과 run 보고서에 `sleep inhibitor unavailable` 이 나온다(Windows 의 잠자기 방지, 배터리에서 덮개를 닫을 때의 강제 잠자기는 범위 밖).
잠자기로 끊긴 단계: 단계(build·verify·병합 후 verify 포함·eval) 도중 시스템 잠자기가 60초 이상 감지되고(벽시계 경과 − 단조 시계 경과, 또는 주기 tick 사이 벽시계 간격의 초과분) 그 단계가 timeout 으로 끝나면(build·eval 어댑터의 `timeout`, verify 명령·기준 check 의 timeout) 그 기능은 blocked(`budget`)가 아니다 — run 은 상태를 저장하고 중단하며 출력에 `system sleep` 과 `harness run --resume` 이 나온다(exit 1). 기능 status 는 바뀌지 않고(`in_progress`), build 시도 횟수와 eval_error 횟수도 소모되지 않는다. `harness run --resume` 은 같은 라운드의 중단된 단계를 다시 수행한다(build 가 끝나고 verify 가 끊겼으면 verify 부터). 잠자기가 감지되지 않은(60초 미만 포함) timeout 은 지금처럼 blocked(`budget`)이고, timeout 없이 잠자기만 있었던 단계는 영향이 없다. 잠자기 시간만큼 단계 제한 시간을 늘리지는 않는다.
이전 run 의 `harness/F{n}` 브랜치가 남아 있으면 자동으로 지우지 않는다(작업 보존) — 해당 기능은 blocked(`worktree`), 사용자가 브랜치를 지우고 재시도한다. blocked 기능의 worktree 는 점검용으로 남기고, passed 기능의 worktree·브랜치는 제거한다.

## 9. 보안 요구사항
- SR-1 verify·check·repro 명령은 **worktree를 cwd로**, timeout과 함께 실행된다.
- SR-2 repro/check 실행 환경은 env 허용목록(PATH, HOME, LANG, TMP 계열, config에서 추가한 이름)만 전달 — API 키·토큰 미전달.
- SR-3 repro는 deny 패턴(`git push`, `rm -rf /`, `rm -rf ~`, `curl … | sh`, `sudo`)에 걸리면 실행하지 않고 finding을 비차단 처리. 판정은 셸이 실제로 실행할 명령 기준 — 줄 이음(백슬래시+개행)을 제거한 뒤 검사한다.
- SR-4 headless 프롬프트에 들어가는 diff에서 `.env*`, `*.pem`, `*.key`, `id_*`, `*.p12`, config의 `secret_globs` 경로 제외. 시크릿 파일의 내용이 다른 경로로 옮겨진 경우도 제외한다: merge-base·HEAD·index·작업 트리에서 시크릿 경로가 가진 blob 과 내용(작업 트리 파일, 또는 추적 파일의 merge-base 버전)이 같은 경로(이름 변경·git 밖 이동·복사), 그리고 git 이름 변경 탐지(`-M`, 유사도 50% 이상, `diff.renameLimit` 제한 없음)가 시크릿 경로를 원본으로 짝지은 대상 경로. 빈 blob 은 내용 일치에 쓰지 않는다. 제외된 경로는 모두 excluded 에 집계된다. 부분 인용·과거 이력의 시크릿은 범위 밖.
- SR-5 코어는 `main`(및 config의 protected 브랜치)에 병합·push하지 않는다. 브랜치 이름은 대소문자를 무시하고 비교한다(대소문자 비구분 파일시스템에서는 같은 loose ref). run 시작 전 로컬 브랜치 목록(`git for-each-ref refs/heads/`)을 확인해, `integration_branch` 와 대소문자만 다른 기존 브랜치(예: `Work` vs `work`)가 있으면 브랜치 생성·worktree 추가·병합 전에 두 이름을 모두 담은 메시지로 exit 2. 철자가 정확히 같은 브랜치는 그대로 쓰고, 없으면 base 에서 만든다. 브랜치 목록을 얻지 못하면 run 을 시작하지 않고 exit 2.
- SR-6 evaluator·security-reviewer는 읽기 전용 모드로 호출된다(어댑터별 플래그).
- SR-7 ops 프로필의 라이브 변경 skill(`rollout`)은 `run` 대상이 될 수 없다(lint가 거부).

## 10. 어댑터 (`harness doctor`)
| 어댑터 | 쓰기(builder) | 읽기전용(evaluator) | 구조화 출력 | 예산 | 모델 |
|--------|--------------|--------------------|------------|------|------|
| claude | `claude -p --permission-mode auto --disallowedTools <deny>` | `--permission-mode plan` | `--output-format json` (+ schema 가 있으면 `--json-schema`) — 비용은 래퍼의 `total_cost_usd`(예산 소진 exit 1 에도 존재) | `--max-budget-usd` | `--model` |
| gemini | `gemini -p "" --approval-mode yolo -s` (`-p ""` 는 headless 선택, 프롬프트는 stdin) | `--approval-mode plan` | `-o json` | timeout만 | `-m` |
| codex (experimental, 플래그 미실측) | `codex exec --sandbox workspace-write -` | `--sandbox read-only` | 프롬프트 + JSON 추출 | timeout만 | `--model` |
| generic | config `adapters.generic.command` | config `adapters.generic.read_only_command` — **없으면 읽기전용 역할 배정 불가**(쓰기 모드로 폴백 금지, SR-6) | JSON 추출 | timeout만 | — |

역할 배정(`config.roles.<role>`)은 `"claude"` 또는 `{"adapter": "claude", "model": "opus"}`. model 생략 시 `adapters.<name>.model`.

- 프롬프트는 **stdin**으로 전달한다(Windows 명령줄 길이 한계 회피).
- `<deny>`(builder 쓰기 모드의 네이티브 deny 목록, SPEC D1의 "~5줄"): `Bash(git push:*)`, `Bash(git reset --hard:*)`, `Bash(rm -rf /:*)`, `Bash(rm -rf ~:*)`, `Bash(sudo:*)`. 지원하지 않는 CLI는 해당 CLI의 sandbox 플래그로 대체.
- 어댑터 호출은 CLI 인증을 위해 **부모 env를 상속**한다(SR-2의 허용목록은 verify·check·repro 명령에만 적용).

`doctor`: 설치된 CLI·버전 탐지, 각 어댑터가 쓰는 플래그가 `--help` 출력에 존재하는지 확인, 역할 배정 권장(builder ≠ evaluator 모델). 끝에 `test count: <값>` 을, 미설정이면 `test count: not configured` 와 §4 의 `init` 감지 규칙으로 찾은 제안(`suggest: preset:<이름>`, 있을 때)을 출력한다 — config.json 은 쓰지 않는다.
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
| E6 | 상태 파일 손상(JSON 파싱 불가, §4 형식 위반 — backlog 가 `{ items: [...] }` 아님·항목 id 중복, config 가 객체 아님·객체 키의 타입 오류·배열 키가 배열 아님 또는 빈/비문자열 원소·test_count 타입 오류·알 수 없는 프리셋, features 항목의 id·title·status 누락/비문자열) | 즉시 정지(exit 2), 파일 경로·필드 이름 또는 항목 번호(`features[i]`)를 포함한 수정 안내 — 추측 복구 금지 |
| E7 | 실행 중 인터럽트(SIGINT) | 현재 단계 종료, 상태 저장, `--resume` 안내 |

## 13. v1 마이그레이션 (`harness migrate-v1`)
`progress/feature_list.json` → `.harness/features.json` (id·이름·passes→status 보존). v1 계약은 변환하지 않고 참조 경로만 기록.
v1 `security_tier: low` 는 `standard` 로 매핑(원래 값은 `v1.security_tier`). v1 항목의 이름은 `name`, 없으면 `title`, 둘 다 없으면 id. id 가 `F<n>` 이 아니면 목록 순서대로 쓰이지 않은 가장 작은 `F<n>` 을 받고 원래 id 는 `v1.id` 에 남는다(`F<n>` id 는 그대로). v1 의존성은 새 id 로 바꿔 `depends_on` 에 넣고(목록에 없는 id 는 빼고 경고) 원본은 `v1.dependencies` 에 보존. v1 status 가 `removed`·`cancelled`·`archived` 로 시작하면(대소문자 무시) `skipped`, 그 외는 passes 로 `passed`/`todo`. 요약에 passed·todo·skipped·재번호 수를 출력. `.harness/features.json` 이 이미 있으면(빈 목록 포함) `--force` 없이 거부.
v1 파일은 v2 브랜치에서 제거 — `v1.39.18-final` 태그로 보존: hooks/*.sh, scripts/, docs/INVARIANTS.md, docs/DECISIONS/, tests/, init.sh, templates/, evals/, config/, progress/, 루트 settings.json, profiles/*.md, v1 전용 agents(architect·deploy-operator·implementer·qa-reviewer·security-auditor·spec-writer·test-writer)·skills(brainstorm·change-request·debug·finish-branch·hotfix·implement·improve·progress·sync-docs). 남겨 두면 플러그인이 v2 skills 와 함께 로드해 충돌한다.
