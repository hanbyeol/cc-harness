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
| `config.json` | profile, verify 명령, 임계값, 예산, max_rounds, 어댑터 역할 배정. 병합 순서 DEFAULTS ← profile ← config (config 우선). `init` 은 verify.commands 를 쓰지 않는다 — 사용자가 정하기 전까지 프로필 기본값이 적용된다. 최상위는 JSON 객체여야 하고, 기본값이 객체인 키(`budget`·`verify`·`limits`·`roles`·`rubric`)는 지정 시 객체여야 한다 |
| `features.json` | `[{id, title, security_tier, depends_on[], status}]` — status ∈ `todo·approved·in_progress·passed·blocked·skipped`. 각 항목의 `id`·`title`·`status` 는 필수 문자열 |
| `contracts/F{n}.json` | 계약 (§5) |
| `verdicts/F{n}-r{k}.json` | 라운드별 판정 (§7) |
| `backlog.json` | 범위 밖 발견 · blocked 재범위 제안 |
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
  "approval": {"by": "...", "at": "ISO8601", "hash": "sha256"}
}
```
`security_tier` 는 `standard|critical` 외 값이면 error. `run_steps` 는 선택(생략 시 위 기본값).
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
config의 `verify.commands`(예: test·lint·build)를 순서대로 실행. 하나라도 비정상 종료 = fail.
실패 시 **1회 재실행**, 결과가 다르면 `flaky`로 기록하고 fail로 취급.

### 6.2 무결성 검사 (base 대비 diff)
diff = `merge-base(base, HEAD)` ↔ **작업 트리**(커밋 안 된 변경 + untracked 파일 포함). base 측 실행(test_count·vacuous 검사)은 merge-base 를 임시 detached worktree 로 꺼내 수행하고 끝나면 제거한다.
worktree 안의 `.harness/` 는 코어가 쓰는 기록 경로 `verdicts/**`, `backlog.json`, `runs/**` 만 면제하고, **그 외 어떤 경로든** 변경되면 fail (아래 2는 그 부분집합). 면제는 git 이 보고하는 `/` 경로의 정확한 세그먼트 기준이다(`verdicts-x/…`, `backlog.json.bak`, `runs` 라는 파일은 보호). 모노레포 하위 프로젝트는 그 프로젝트의 `<sub>/.harness` 기준으로 같다.
1. 추가된 줄에 skip/focus 마커 없음: `.skip(`, `.only(`, `xit(`, `xdescribe(`, `@pytest.mark.skip`, `@Disabled`, `t.Skip(`, `@Ignore` (목록은 config로 추가 가능, 제거 불가 — 기본 목록은 코드에 고정).
   마커는 **토큰 경계**로 매칭한다: 마커가 식별자 문자로 시작하면 바로 앞 문자가 식별자 문자가 아니어야 한다(`process.exit(` ≠ `xit(`, `list.Skip(` ≠ `t.Skip(`). 구두점으로 시작하는 마커는 부분문자열 매칭.
2. `.harness/config.json`, `.harness/contracts/**`, `.harness/features.json` 변경 없음 (면제 경로와 함께 바뀌어도 fail, 보고 목록에는 보호 경로만).
3. `verify.test_count` 명령이 설정된 경우 base 대비 테스트 수 비감소. 미설정 시 경고만.

### 6.3 기준 check
계약의 모든 check 실행 → 기준별 pass/fail. check 가 하나도 없는 계약은 fail(공허한 통과 방지). `new: true` 기준은 **base에서 fail이어야 한다**(base에서 이미 통과하면 공허한 기준 → fail로 보고).

## 7. 독립 평가 (`harness eval F{n}`)
1. evaluator 역할 어댑터로 headless **읽기 전용** 세션 실행. 입력: 동결 계약 + diff(시크릿 제외 §9) + verify 결과.
2. 출력 JSON 스키마:
```json
{"scores": {"functionality":0,"quality":0,"security":0,"errors":0,"tests":0},
 "findings": [{"criterion_id":"AC-1|REGRESSION","dimension":"...","summary":"...","repro":"<cmd>"}],
 "out_of_scope": [{"summary":"..."}]}
```
3. 코어 판정:
   - 스키마 불일치 → 1회 재요청, 재실패 시 라운드 무효(`eval_error`, 라운드 소모 없음, 2회 연속이면 blocked). eval_error 는 `verdicts/F{n}-r{k}.eval_error.json`(consecutive 카운터 포함)에 기록하며 라운드 파일로 세지 않는다. 어댑터 `timeout`·`exit_nonzero` 도 eval_error(재시도 없음).
   - finding이 **차단적**이려면: `criterion_id`가 계약에 존재(또는 `REGRESSION`) ∧ `repro` 존재 ∧ **코어가 worktree에서 repro를 실행해 비정상 종료 재현**. 그 외는 `backlog.json`으로. repro 가 명령 미발견(127/9009)·실행 불가면 비차단(`repro_not_runnable`), 시그널 종료는 비정상 종료로 본다. 코어는 repro 가 git 내부 조작(update-index 플래그, filter clean/smudge, replace, hooksPath, git config, `.git/config`·`.git/info`)을 포함하면 실행하지 않고 `adversarial_scenario` 로 backlog 한다(D1 의 결정적 보조).
   - verify 가 실패한 상태로 `harness eval` 을 직접 호출하면 evaluator 는 실행되지만 verdict 는 fail 이고 low-score 재요청은 하지 않는다. (`run` 은 verify 통과 후에만 평가를 호출한다 — §8.3.)
   - **위협 경계(D1)**: 결함이 성립하려면 빌더가 **고의로** git 내부·설정(index 플래그 `skip-worktree`/`assume-unchanged`, clean/smudge filter, replace ref, hooks, `.git/config`·`.git/info/*`)이나 셸·런타임 의미를 조작해야 하는 finding은 적대적 시나리오로 분류해 `out_of_scope`(backlog)로 보낸다 — repro가 있어도 차단적이지 않다. 협력적 모델의 **사고**(평범한 도구 사용·평범한 실수로 생기는 결함)만 차단한다. 구조적 백스톱은 §8.5의 병합 후 verify(실제로 병합된 커밋 검증)다. (2026-09-23 사용자 결정 — v1의 비수렴 원인 재발 방지)
   - `score = min(5개 점수)`. critical이면 security < 7 자동 fail.
   - **verdict = pass** ⇔ verify pass ∧ 차단적 finding 0 ∧ score ≥ threshold.
   - 차단적 finding 0 인데 score < threshold(critical의 security < 7 포함) → `unsupported_low_score`. evaluator에 "재현 가능한 finding을 제시하거나 점수를 정정하라"고 **1회** 재요청. 여전히 근거가 없으면 기능 `blocked(needs-human)` — 거짓 통과도, 근거 없는 재작업 루프도 만들지 않는다.
4. critical: security-reviewer 역할로 같은 절차 1회 추가. security-reviewer 는 **security 차원과 그 finding 만** 판정에 반영한다(최종 security = min(evaluator, reviewer)). 나머지 차원 점수는 기록만 한다. 둘 다 pass여야 pass.
5. `independence`: evaluator 어댑터가 builder와 다른 모델이면 `cross-model`, 아니면 `fresh-context`.

## 8. 자율 실행 (`harness run [F…] [--max-usd N]`)
기능별(의존 순서, `approved`만):
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
8. 종료 → `runs/{ts}.md` 보고서. integration → main 병합은 하지 않는다(PR 생성은 `gh` 가 있으면 제안만).

예산: 단계별 timeout(기본 30분), 단계별 USD(어댑터 지원 시), run 전체 USD. 단계 초과 시 해당 기능 blocked(`budget`), run 초과 시 진행 중 기능 blocked(`budget`) 후 전체 정지.
중단 복구: run은 상태 파일(`runs/current.json`, config 스냅샷 포함)만으로 재개 가능(`harness run --resume`). SIGINT 는 진행 중 단계의 프로세스 트리를 종료하고 상태를 저장한 뒤 exit 130.
이전 run 의 `harness/F{n}` 브랜치가 남아 있으면 자동으로 지우지 않는다(작업 보존) — 해당 기능은 blocked(`worktree`), 사용자가 브랜치를 지우고 재시도한다. blocked 기능의 worktree 는 점검용으로 남기고, passed 기능의 worktree·브랜치는 제거한다.

## 9. 보안 요구사항
- SR-1 verify·check·repro 명령은 **worktree를 cwd로**, timeout과 함께 실행된다.
- SR-2 repro/check 실행 환경은 env 허용목록(PATH, HOME, LANG, TMP 계열, config에서 추가한 이름)만 전달 — API 키·토큰 미전달.
- SR-3 repro는 deny 패턴(`git push`, `rm -rf /`, `rm -rf ~`, `curl … | sh`, `sudo`)에 걸리면 실행하지 않고 finding을 비차단 처리. 판정은 셸이 실제로 실행할 명령 기준 — 줄 이음(백슬래시+개행)을 제거한 뒤 검사한다.
- SR-4 headless 프롬프트에 들어가는 diff에서 `.env*`, `*.pem`, `*.key`, `id_*`, `*.p12`, config의 `secret_globs` 경로 제외.
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

`doctor`: 설치된 CLI·버전 탐지, 각 어댑터가 쓰는 플래그가 `--help` 출력에 존재하는지 확인, 역할 배정 권장(builder ≠ evaluator 모델).
플래그 부재 시 해당 역할 배정 불가로 보고(추측 실행 금지).

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
설치: `npx cc-harness init` (대상 프로젝트에 `.harness/` 생성, 감지된 CLI별 설치 안내 출력).

## 12. 에러 시나리오
| # | 상황 | 동작 |
|---|------|------|
| E1 | 어댑터 CLI 미설치/미인증 | 해당 단계 실패 → 기능 blocked(`adapter_unavailable`), doctor 안내 |
| E2 | headless 출력 JSON 파싱 실패 | §7.3 재요청 규칙 |
| E3 | 병합 충돌 | 병합 중단(`git merge --abort`), 기능 blocked(`merge_conflict`) |
| E4 | worktree 생성 실패 | 기능 blocked, 나머지 계속 |
| E5 | 예산·timeout 초과 | 프로세스 종료(자식 포함), blocked(`budget`) |
| E6 | 상태 파일 손상(JSON 파싱 불가, §4 형식 위반 — config 가 객체 아님·객체 키의 타입 오류, features 항목의 id·title·status 누락/비문자열) | 즉시 정지(exit 2), 파일 경로·필드 이름 또는 항목 번호(`features[i]`)를 포함한 수정 안내 — 추측 복구 금지 |
| E7 | 실행 중 인터럽트(SIGINT) | 현재 단계 종료, 상태 저장, `--resume` 안내 |

## 13. v1 마이그레이션 (`harness migrate-v1`)
`progress/feature_list.json` → `.harness/features.json` (id·이름·passes→status 보존). v1 계약은 변환하지 않고 참조 경로만 기록.
v1 `security_tier: low` 는 `standard` 로 매핑(원래 값은 `v1.security_tier`). v1 의존성은 `depends_on` 으로 옮기지 않고 `v1.dependencies` 에 보존(v1 기능은 v2 에서 실행 대상이 아니므로). `.harness/features.json` 이 이미 있으면(빈 목록 포함) `--force` 없이 거부.
v1 파일은 v2 브랜치에서 제거 — `v1.39.18-final` 태그로 보존: hooks/*.sh, scripts/, docs/INVARIANTS.md, docs/DECISIONS/, tests/, init.sh, templates/, evals/, config/, progress/, 루트 settings.json, profiles/*.md, v1 전용 agents(architect·deploy-operator·implementer·qa-reviewer·security-auditor·spec-writer·test-writer)·skills(brainstorm·change-request·debug·finish-branch·hotfix·implement·improve·progress·sync-docs). 남겨 두면 플러그인이 v2 skills 와 함께 로드해 충돌한다.
