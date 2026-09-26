# cc-harness

> AI 코딩 CLI(Claude Code · Gemini CLI · Codex CLI, 그 외 AGENTS.md 호환 도구)를 위한 평가 기반 개발 하네스 —
> 계약 → 구현 → 결정적 검증 → 독립 평가를 **반드시 수렴하는 형태로** 수행한다.

> **Note:** [Harness.io](https://harness.io)(CI/CD 플랫폼)와 무관합니다. 여기서 "harness"는
> [AI agent harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
> engineering 개념 — 에이전트가 일관된 품질로 일하도록 둘러싸는 구조 — 을 뜻합니다.

v2는 v1을 처음부터 다시 쓴 버전입니다. 설계 근거는 `docs/brainstorms/2026-09-23-v2-from-scratch.md`,
명세는 `docs/SPEC.md`에 있습니다.

## 구성

| 구성 요소 | 내용 |
|-----------|------|
| 코어 CLI | `bin/harness.mjs`, `lib/` — Node ≥ 22, 런타임 의존성 0, Windows·macOS·Linux |
| 워크플로우 지시 | `AGENTS.md` — 모든 CLI가 읽는 단일 원천 |
| Skills | `spec` · `plan` · `build` · `fix` · `status` · `plan-review`(iac) · `rollout`(ops) |
| 역할 | `agents/` — builder · evaluator · security-reviewer (Claude subagent 겸 headless 프롬프트) |
| 프로필 | `profiles/` — `sdlc`(기본) · `iac`(`harness tf-check`, [docs/iac.md](docs/iac.md)) · `ops` |
| 상태 | 대상 프로젝트의 `.harness/` (git 추적) — config · features · contracts · verdicts · backlog · runs |

코어 명령: `harness init`, `harness lint-contract`, `harness approve`, `harness verify`, `harness eval`,
`harness run`, `harness status`, `harness stats`, `harness doctor`, `harness migrate-v1`. 옵션은 `harness --help`.

## 설치

어느 CLI를 쓰든 먼저 대상 프로젝트에 상태 디렉터리를 만듭니다.

```bash
npx github:hanbyeol/cc-harness init      # .harness/ 생성 (기존 파일은 덮어쓰지 않음)
npx github:hanbyeol/cc-harness doctor    # 설치된 CLI·버전, 역할별 플래그 지원 여부 확인
```

`harness`가 PATH에 없으면 이후 모든 명령을 `npx github:hanbyeol/cc-harness <command>`로 실행하면 됩니다
(`npm i -g github:hanbyeol/cc-harness`로 설치하면 `harness`가 PATH에 생깁니다).
**주의:** npm 레지스트리의 `cc-harness` 패키지는 이 프로젝트와 무관한 다른 도구입니다 — 항상 위의 `github:hanbyeol/cc-harness` 지정자로 실행하세요.

### Claude Code 플러그인

```bash
/plugin marketplace add hanbyeol/cc-harness
/plugin install cc-harness
```

skills·agents가 네이티브로 로딩되고, SessionStart 훅 하나(`harness status --brief`)가 세션 시작 시
현재 상태를 보여 줍니다.

### Gemini CLI 확장

```bash
gemini extensions install https://github.com/hanbyeol/cc-harness
```

`gemini-extension.json`이 `AGENTS.md`를 컨텍스트 파일로 지정합니다. Gemini용 SessionStart 훅은 아직 없습니다.

### Codex CLI 및 기타 도구 (AGENTS.md + skills)

Codex·Cursor·opencode 등 AGENTS.md를 읽는 도구는 이 저장소의 `AGENTS.md`를 프로젝트 루트에 두고
`skills/`를 도구가 읽는 위치에 복사하면 됩니다. 코어 명령은 `npx github:hanbyeol/cc-harness <command>`로 호출합니다.
Codex 어댑터는 experimental입니다(`harness doctor`로 플래그 확인).

## 사용법

### 대화형: spec → plan → build

CLI 안에서 skill을 순서대로 부릅니다. skill이 필요한 코어 명령을 대신 호출합니다.

1. **spec** — 요청을 계약 `.harness/contracts/F{n}.json`과 `features.json` 항목(`todo`)으로 만든다.
   모든 기준에는 check(성공 시 exit 0인 셸 명령)가 있어야 한다.
2. **plan** — `harness lint-contract F{n}`으로 결정가능성을 검사하고, 사용자에게 계약을 보여 준 뒤
   승인을 받으면 `harness approve F{n}`으로 해시 동결한다.
3. **build** — TDD로 구현한 뒤 `harness verify F{n}`(결정적 검증)과 `harness eval F{n}`(독립 평가)을 실행한다.

`harness eval`은 판정 뒤 기능 상태를 코어가 직접 기록하고, run과 같은 수렴 규칙을 적용합니다.
pass는 `passed`, 라운드가 남은 fail은 `in_progress`(남은 라운드 수 출력), 라운드 소진·발산·정체·eval_error 2회 연속·
근거 없는 저점은 `blocked`(사유와 재범위 제안을 backlog에 기록)입니다. 이미 `passed`·`blocked`인 기능, 승인되지 않았거나
해시가 바뀐 계약, 이미 있는 라운드 번호는 어댑터 호출 없이 거부합니다(exit 2).

작고 원인이 명확한 수정(3파일 이하, 비보안)은 `fix` skill, 현황은 `status` skill(`harness status`)을 씁니다.

### 자율: approve → run

```bash
harness approve F3 F4 F5          # 사람이 계약을 일괄 승인 (lint 통과 계약만)
harness run --max-usd 20          # approved 기능을 의존 순서대로 끝까지 진행 (준비된 기능은 모두 동시에)
harness run --parallel 2          # 동시에 진행하는 기능을 2개로 제한 (1 이면 순차)
harness run --resume              # 중단된 run을 상태 파일만으로 재개
```

기능마다 `.harness/wt/F{n}` worktree와 `harness/F{n}` 브랜치에서 build → verify → eval 라운드를 돌고,
통과하면 integration 브랜치에 병합한 뒤 병합 결과를 다시 verify합니다. 종료 시 `.harness/runs/{ts}.md`
보고서를 씁니다. 코어는 `main`(및 protected 브랜치)에 병합·push하지 않습니다 — main 병합은 사람이 결정합니다.

- **병렬** — `run.max_parallel`이 없거나 `'auto'`면 의존성이 충족된 기능을 개수 제한 없이 모두 동시에 진행합니다.
  양의 정수나 `--parallel N`이면 그 수가 상한입니다. verify(병합 후 verify 포함)는 build·eval과 별도인 풀에서
  최대 `run.verify_parallel`개만 동시에 돕니다(`'auto'`·미지정 = `max(1, floor(CPU 수 / 8))`). worktree·브랜치·병합
  git 호출은 하나의 잠금으로 직렬화되고 병합은 한 번에 하나입니다.
- **verify 내부 동시 실행** — 한 verify 안에서 기준 check와 `new: true` 기준의 base vacuity 실행은 동시에 최대
  `verify.check_parallel`개 돕니다(`'auto'`·미지정 = `max(1, floor(CPU 수 / 4))`). head·base 테스트 수는 동시에 세고,
  base 테스트 수를 센 뒤 기능의 테스트 파일을 base에 얹고 나서야 base vacuity 실행이 시작됩니다. 동시 실행 중 실패한
  check는 모두 끝난 뒤 혼자 한 번 더 돌려 통과하면 pass(`parallel_retry: true`와 경고)로 기록합니다. 시간 초과는
  재확인 없이 fail입니다. check끼리 DB·포트 같은 자원을 공유하면 `verify.check_parallel`을 1로 두세요 — 전처럼
  하나씩 순서대로 실행됩니다. `verify.commands`는 항상 순서대로 실행됩니다.
- **테스트 수** — `verify.test_count`를 `from:commands[i]`로 두면 `verify.commands[i]` 출력의 마지막 `# tests N`(TAP)
  또는 `ℹ tests N`(node spec) 줄에서 수를 읽어 따로 실행하지 않습니다(base에서는 같은 명령을 한 번 실행). base 쪽 수는
  모든 방식에서 (base 커밋, 명령)별로 `.harness/runs/test-count-cache.json`에 캐시되어 다음 verify는 base에서 다시 세지 않습니다.
- **병합 충돌** — 기능 병합이 충돌하면 코어가 그 기능 worktree에서 integration을 병합해 충돌 상태를 만들고,
  충돌 파일 목록과 함께 builder를 1회 부릅니다. 해결 결과는 verify·eval을 다시 거친 뒤 병합됩니다. 그래도 충돌하거나
  builder가 실패하거나 줄 시작 충돌 표시가 남으면 `blocked`(`merge_conflict`)이고 integration은 그대로입니다. 병합 후
  verify 실패도 실패 항목과 함께 builder를 1회 불러 복구합니다. 두 복구는 합쳐서 기능당 1회이며 라운드를 소모하지 않습니다.
  복구 규칙, 보고서의 `Merge recovery` 열, 판정의 `verify_failures`·`flaky_tests`는 [docs/run.md](docs/run.md)에 있습니다.
- **사전 점검** — run은 worktree·브랜치를 만들거나 builder를 부르기 전에 역할별 CLI(`builder`·`evaluator`, 범위에
  critical 기능이 있으면 `security-reviewer`)가 usable인지 확인하고, 아니면 exit 2로 멈춥니다. gemini는 인증 정보
  (`GEMINI_API_KEY`·`GOOGLE_GENAI_USE_VERTEXAI`·`GOOGLE_GENAI_USE_GCA` 또는 settings의 `security.auth.selectedType`)가
  없으면 `not authenticated`로 unusable입니다. `harness doctor`로 미리 확인하세요.
- **잠자기** — run 동안 macOS는 `caffeinate -i`, Linux는 `systemd-inhibit`으로 유휴 잠자기를 막습니다(Windows 미지원,
  배터리로 덮개를 닫으면 OS가 강제로 재웁니다). 그래도 잠들어 단계가 시간 제한에 걸리면 `blocked(budget)`가 아니라
  중단으로 처리되고, `harness run --resume`이 그 단계부터 다시 수행합니다.
- **시간 제한** — `budget.step_timeout_sec`(기본 1800)은 역할 CLI·`verify.commands`·기준 check·`test_count`·repro를, `budget.git_timeout_sec`
  (기본 300)은 코어 git(worktree·diff·merge 등)을 제한합니다. 넘긴 git은 트리째 종료되고 `git <명령> timed out after <N>s`로 끝납니다.
  base vacuity 실행은 `verify.vacuity_timeout_sec`(기본 120)과 `budget.step_timeout_sec` 중 작은 값으로 제한되고, 넘기면
  vacuous가 아닌 것으로 봅니다(`base_timed_out: true`, 자세한 규칙은 `docs/run.md`).
- **명령 없음** — verify·병합 후 verify에서 `verify.commands`·`test_count`·기준 check의 프로그램이 설치돼 있지 않으면
  (exit 127·9009, `not recognized`, ENOENT) 기능은 `blocked`가 아닙니다. run이 상태를 저장하고 명령 이름과
  `command not found`를 출력하며 멈춥니다(병합 후 verify면 병합을 되돌린 뒤). 설치하거나 PATH를 고친 뒤
  `harness run --resume`하면 그 단계부터 다시 수행하고 라운드를 소모하지 않습니다. 병렬 run에서는 새 기능을 시작하지 않고
  진행 중인 기능은 현재 단계를 끝낸 뒤 멈춥니다. exit 1 같은 일반 실패는 지금처럼 라운드 실패입니다.
- **보고서의 실패 항목** — verify·병합 후 verify 실패로 blocked 된 기능은 보고서에 실패한 명령 문자열 또는 기준 id와
  메시지 앞 300자가 `- failed:` 줄로 나옵니다. env_allowlist 밖 환경 변수 값은 `[redacted]`로 가려집니다.
- **지표와 `harness stats`** — run은 단계(build·verify·eval·merge·post_merge_verify·conflict_resolve)가 끝날 때마다
  `.harness/runs/{ts}.metrics.jsonl`에 시간·비용·역할·모델을 한 줄씩 남기고(대화형 `harness eval`은
  `.harness/runs/eval.metrics.jsonl`), 보고서에 기능별 단계 표를 넣습니다. 프롬프트·출력·환경 변수 값은 기록하지 않습니다.
  `harness stats [--since YYYY-MM-DD] [--json]`은 단계별 횟수·중앙값·p90 시간·비용, 역할·모델별 비용, 1라운드 통과율과
  평균 라운드 수를 보여주고, 규칙 기반 제안을 냅니다 — 최근 10단계 중 2개 이상이 `budget.step_timeout_sec`의 90% 이상이면
  step_timeout 상향, verify 시간이 30% 초과면 `verify.check_parallel` 상향, builder 비용이 70% 초과이고 standard 기능이
  있으면 standard 기능 builder 모델 변경. 제안은 자동 적용되지 않습니다.
- **역할 모델 정책** — `roles.<역할>`에 등급별 모델 `by_tier`, builder 승격 모델 `escalate`, 충돌 해결 모델 `conflict_model`:
  `{"adapter": "claude", "model": "sonnet", "by_tier": {"critical": "opus"}, "escalate": "opus", "conflict_model": "opus"}`.
  선택 순서: `conflict_model`(충돌 해결) → `escalate`(같은 계약 2라운드 이상, builder만) → `by_tier.<등급>` → `model` →
  `adapters.<name>.model`. `-`로 시작하거나 공백·제어 문자가 든 모델 값과 잘못된 `by_tier` 키는 `config_invalid`(exit 2).
  metrics·verdict에는 호출한 모델이, independence는 실제로 쓴 모델로, doctor는 `fresh-context for <tier>` 경고를 냅니다.
- **대화형과 혼용** — run은 같은 계약 해시로 이미 평가된 라운드(대화형 `harness eval` 포함)를 이어받아 라운드 상한과
  수렴 비교에 넣습니다.

## 수렴 규칙

v2의 핵심은 모든 기능이 **통과하거나, 멈추고 사람에게 넘어가는** 것입니다. 무한 루프는 설계상 불가능해야 합니다.

- **결정 가능한 기준** — 모든 기준에 실행 가능한 check가 있어야 합니다. "어떤 방법으로도 우회 불가" 같은
  전칭 부정은 lint가 거부하며, 열거된 `cases`(각각 check 포함)로 다시 써야 합니다.
- **동결된 계약** — 승인 시 계약을 sha256 해시로 동결합니다. 기준을 바꾸면 새 버전 + 재승인이며,
  라운드 중 기준이 조용히 늘어나지 않습니다.
- **criterion_id + repro** — evaluator finding이 차단적이려면 계약의 기준 id(또는 `REGRESSION`)와
  repro 명령이 있어야 하고, 코어가 worktree에서 repro를 직접 실행해 실패를 재현해야 합니다.
  그 외는 `backlog.json`으로 갑니다.
- **위협 경계(D1)** — 모델은 협력적이라고 가정하고 **사고**만 막습니다. 빌더가 고의로 git 내부(index 플래그,
  filter, replace ref, hooks)나 셸·런타임 의미를 조작해야 성립하는 finding은 범위 밖(backlog)입니다.
  파괴 방지는 각 CLI의 네이티브 sandbox·권한, worktree 격리, 최소 deny 목록, 병합 후 verify가 맡습니다.
- **최대 3라운드, 실패는 엄격히 감소** — 기능당 `max_rounds`(기본 3). 2라운드부터 차단적 finding 수가
  직전보다 줄어야 하고, 직전에 통과한 기준이 다시 실패하면 발산입니다. 라운드와 수렴 비교는 **계약 해시 단위**입니다 —
  재승인한 새 버전은 1라운드부터 다시 세고, 판정 파일(`verdicts/F{n}-r{k}.json`) 번호는 기능별로 계속 늘어나며 덮어쓰지 않습니다.
- **blocked** — 발산·정체·라운드 소진 시 기능은 `blocked`가 되고 재범위 제안(분할 / 기준 재작성 / 위험 수용)이
  backlog에 기록됩니다. 의존 기능은 `skipped`, 독립 기능은 계속 진행합니다. critical 기능이 blocked면 run 전체가 멈춥니다.
- **min-of-5** — 점수 = 기능·품질·보안·에러·테스트의 최솟값. `security_tier: critical`은 보안 7 미만이면 fail이고
  security-reviewer 판정이 추가로 필요합니다. 근거(재현 가능한 finding) 없는 저점은 1회 재요청 후 `blocked(needs-human)`.

## v1에서 마이그레이션

```bash
harness migrate-v1            # progress/feature_list.json → .harness/features.json
harness migrate-v1 --force    # 이미 있는 .harness/features.json을 덮어쓸 때
```

- 기능의 id·이름·security_tier를 옮기고, `passes: true`는 `passed`, 나머지는 `todo`가 됩니다. v1의 `low` 티어는
  `standard`로 매핑되며, 원래 status·티어·의존성·계약 경로(`progress/contracts/sprint-{n}.json`)는 각 기능의 `v1` 필드에 남습니다.
- v1 status가 `PARTIAL`·`in_progress`(`in-progress`)·`blocked`·`deferred`(`hold`)로 시작하면(대소문자 무시) `todo`로 두고 `v1.state`에 `partial`·`in_progress`·`blocked`·`deferred` 중 하나를 기록해 시작한 작업을 구분합니다. `harness status`는 v1에서 온 todo 기능에 `(v1: <v1.status 앞 60자>)`를 붙이고, `--brief`는 `N todo (v1 partial P · blocked B)`로 나눠 보이며, `harness status --todo-v1`은 그 기능만 `v1.state`별로 id·제목·v1 status(앞 120자)를 보여 줍니다.
- v1 계약은 변환하지 않습니다. 필요한 기능은 `spec` skill로 v2 계약을 새로 씁니다.
- `.harness/`가 없으면 `harness init`과 같은 구조로 만듭니다. v1 파일이 없으면 아무것도 쓰지 않고 exit 2.
- v1은 태그 **`v1.39.18-final`**로 보존됩니다. v2 브랜치에서는 v1 전용 파일(`hooks/*.sh`, `scripts/`,
  `docs/INVARIANTS.md`, `tests/`, `init.sh`, `progress/` 등)이 제거됩니다.

### 무엇이 왜 바뀌었나

v1은 에너지 대부분을 "자율 구동 모델의 파괴적 행위 방어"에 썼고, 그 방어는 수렴하지 않았습니다.
한 기능(F65)이 판정 43회 이상, 커밋 88개를 거치며 보안 점수가 3↔5를 오갔고 7에 한 번도 닿지 않았습니다 —
이른바 45회 루프입니다. 원인은 구현 품질이 아니라 설계였습니다.

원인별 v2 대응(결정가능성 lint, 계약 동결, 라운드 상한, in-process 방어 제거, CLI 중립 코어)과 설계 근거는
`docs/brainstorms/2026-09-23-v2-from-scratch.md`에 있습니다.

## 개발

테스트·기준 check·lint 명령과 CI 매트릭스(ubuntu · macos · windows × Node 22 · 24)는 `CLAUDE.md`에 있습니다.

## License

MIT
