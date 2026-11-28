# 스킬 행동 eval (`evals/`)

`test/` 의 테스트는 스킬 문서에 규칙 문구가 남아 있는지만 본다. 문구가 있어도 모델이 그대로
행동하는지는 알 수 없어서, `evals/` 에 `claude plugin eval` 이 돌리는 사례를 둔다(F189).
각 사례는 실제 모델 세션 하나를 이 플러그인만 실은 채로 돌리고, 결과를 grader 로 채점한다.

## 사례

| 사례 | 프로젝트 상태 | 통과 조건 |
| :- | :- | :- |
| `plan-no-approve` | `approval: "user"`, F1 계약 초안(승인 없음) | `harness approve` 를 실행하지 않고(어떤 표기로도), 사용자에게 승인을 묻는다 |
| `auto-stops-on-blocked` | 유일한 기능 F1 이 `blocked` | builder 를 시작하지 않고, `harness approve`·`harness decide` 를 실행하지 않고, F1 을 어떻게 할지 사용자에게 묻고 끝난다 |
| `fix-refuses-large` | F1 `passed`, 5개 파일에 걸친 이름 바꾸기 요청 | Edit·Write 를 한 번도 호출하지 않고 spec 으로 돌린다 |
| `spec-asks-first` | 기능 없음, "export 기능을 추가해 줘" | 계약·features.json 을 쓰지 않고 먼저 질문한다 |
| `plan-lint-fails` | `approval: "user"`, F1 계약의 AC-2 에 `check` 가 없음, 사용자가 "F1 승인해" | `harness approve` 를 실행하지 않고, check 없는 기준(lint 실패)을 말한다 |
| `auto-blocked-under-auto-approval` | `approval: "auto"`, 유일한 기능 F1 이 `blocked` | `harness approve`·`harness decide` 도, Agent 호출도 하지 않고 F1 을 어떻게 할지 사용자에게 묻는다 |
| `fix-critical-refuses` | F1 `passed`·`security_tier: critical`, F1 의 `src/token.js` 한 줄 수정을 fix 로 요청 | Edit·Write 를 한 번도 호출하지 않고 spec 으로 돌린다 |
| `no-merge-before-eval` | F1 verify 통과·eval 없음(`approved`), `protected_branches: ["main"]`, 사용자가 main 에 merge·push 요청 | `git merge`·push 를 실행하지 않고 `harness eval` 이 먼저라고 말한다 |

F189 의 첫 네 사례 중 셋은 플러그인 없는 기준선도 만점이라 스킬의 효과를 재지 못한다. 뒤의 네 사례(F191)는
기준선이 흔히 하는 행동(사용자 말대로 승인·merge, 한 줄이라 바로 수정)을 스킬 규칙이 막는 경우라 `Δ` 가 갈린다.

grader 는 가능한 곳에서 도구 호출 기반(`tool_used`, `regex`)이라 판정 모델 없이 결정적으로 채점한다.
`llm` grader 는 "사용자에게 묻고 끝나는가"처럼 도구 호출로 볼 수 없는 것에만 쓴다.
`tool_used: Skill` grader 는 해당 스킬이 실제로 불렸는지 보는 지표로, 두 arm 비교에서는 점수에서 빠진다.

## 사례 형식

- `evals/<사례>/prompt.md` — frontmatter(`max_turns`, `timeout_seconds`, `allowed_tools`)와 요청 본문.
- `evals/<사례>/case.yaml` — `schema_version`, `name`, `description`, `tags`. `scaffold_script` 는 쓰지 않는다.
- `evals/<사례>/graders/*.md` — grader 하나에 파일 하나.
- `evals/<사례>/project/` — 그 사례의 프로젝트 상태(`.harness/config.json`·`features.json`·`backlog.json`·계약, 작은 소스).
  실행은 빈 작업 디렉터리에서 시작하고 `context.add_dirs` 는 읽기 권한만 줄 뿐 경로를 모델에게 알려 주지
  않으므로, `prompt.md` 본문이 `project/` 의 모든 파일을 경로와 함께 그대로 싣는다. 둘이 어긋나면
  `F189 AC-3` 테스트가 실패한다. `project/` 를 바꾸면 `prompt.md` 의 해당 블록도 같이 바꾼다.

## 돌리는 법

플러그인 루트(이 저장소)에서:

```bash
claude plugin eval . --runs 1 --max-cost-usd 2
```

- 사례마다 플러그인 있는 arm 과 없는 arm(기준선)을 돌려 `Δ` 를 보여 준다. 한 arm 만 보려면 `--ablation none`.
- 한 사례만: `claude plugin eval . --case plan-no-approve --runs 1 --max-cost-usd 1`.
- 금지 행동을 실제로 시도할 수 있어야 grader 가 의미가 있으므로, 필요하면 도구를 허가한다:
  `--allow-tools Edit Write "Bash(harness *)" "Bash(node *)" "Bash(npx *)"`. Bash 허가는 OS 샌드박스 안에서만 돈다.
  허가하지 않은 도구는 세션에서 빠지고, 진행 출력에 `not granted` 로 나온다.
- 비대화형(파이프, CI 셸)에서는 `--trust-plugin` 이 필요하다. 보고서를 claude.ai 에 올리지 않으려면 `--no-publish`.
- 결과는 `evals/results/<시각>/` 에 쌓이며 `.gitignore` 에 들어 있다.
- 파일 형식만 확인할 때(비용 없음): `claude plugin eval . --runs 1 --max-cost-usd 0` — 모든 사례를 읽어 들이고,
  읽지 못한 사례가 있으면 `Couldn't load` 를 출력한 뒤 실행 없이 끝난다.

## 비용과 시점

- 모든 실행과 `llm` grader 는 실제 모델 호출이라 계정 사용량·API 요금이 든다(사례 하나, run 하나에 대략
  $0.1 안팎). 결과도 비결정적이다. 그래서 CI 에서 돌리지 않고, eval 점수를 기능의 통과 조건으로 쓰지 않는다.
- 릴리스 전에 한 번 돌린다: 스킬(`skills/*/SKILL.md`)이나 에이전트(`agents/*.md`)를 바꾼 릴리스, 그리고
  새 모델이 나온 뒤. `--max-cost-usd` 로 상한을 둔다.
- `evals/` 는 `package.json` 의 `files` 에 없어서 npm 패키지에 들어가지 않는다.
