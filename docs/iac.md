# iac 프로필 — `harness tf-check` 와 provider 캐시

iac 프로필(`"profile": "iac"`)의 verify 는 `harness tf-check` 한 명령이다. verify 는 이 명령을 PATH 의 `harness` 가
아니라 코어 자신의 `bin/harness.mjs` 로 실행하므로 `harness` 가 PATH 에 없어도 된다(`docs/SPEC.md` §6.1). 규칙의 원문은 `docs/SPEC.md` §4 의
프로필 절이다. `terraform plan`·`apply` 는 verify 가 실행하지 않는다(클라우드 자격 증명이 SR-2 로 전달되지 않는다) —
plan 은 `plan-review` skill 로 검토한다.

`harness claude-md` 는 iac 프로필 프로젝트의 CLAUDE.md 블록에 `## Profile: iac` 절을 넣는다(begin 표시는
`<!-- cc-harness:begin v<버전> profile=iac -->`). 내용은 `templates/profile-iac.md` 다 — plan diff 가 명세이고 verify 는
`harness tf-check`, plan·apply 는 `plan-review` skill 로 하고 apply 는 사용자의 명시적 승인 뒤에만, prod 나 상태 저장
리소스의 replace·destroy 는 사라질 것을 다시 말한 뒤 묻고, `terraform apply -auto-approve`·`destroy`·`state rm` 은
승인 없이 실행하지 않는다. config 의 profile 을 바꾸면 블록이 outdated 가 되므로 `harness claude-md` 를 다시 실행한다
(`docs/SPEC.md` §4.1).

## tf-check 가 하는 일

```
harness tf-check [--dir <path>] [--scan <name>]...
```

1. 저장소(또는 `--dir` 아래)에서 `*.tf` 파일이 있는 디렉터리를 모두 찾는다. `.terraform`·`.harness`·`.git` 과
   심볼릭 링크 디렉터리는 들어가지 않는다.
2. 그 디렉터리마다 `terraform init -backend=false -input=false` 와 `terraform validate` 를 **그 디렉터리에서** 실행한다.
   모듈이 여러 개여도 루트 하나만 검사하던 이전 방식과 달리 모듈마다 검증된다.
3. 그 디렉터리 자체나 `tests/` 하위에 `*.tftest.hcl` 또는 `*.tftest.json` 이 있으면, init·validate 가 성공한 뒤
   그 디렉터리에서 `terraform test -no-color` 를 실행한다. 테스트 파일이 없거나 init·validate 가 실패한 디렉터리에서는
   실행하지 않는다. verify 에는 클라우드 자격 증명이 전달되지 않으므로 테스트는 `mock_provider` 로 쓴다.
4. `terraform fmt -check -recursive` 를 검사 범위의 맨 위 디렉터리에서 **한 번** 실행한다.
5. `--scan <name>` 으로 지정한 정책 스캐너를 검사 범위의 맨 위 디렉터리에서 지정 순서대로 한 번씩 실행한다.

하나라도 실패하면 exit 1 이고, 실패한 디렉터리를 프로젝트 기준 경로(`modules/bad`)로 stderr 에 출력한다.
성공한 디렉터리는 `ok <경로>` 로 stdout 에 나온다. 마지막 줄 `tf-check: failed: …` 에 실패한 항목이 모인다
(디렉터리 경로, `test <경로>`, `fmt`, `scan <name>`).

- **terraform test 실패**: stderr 에 `<경로>: test failed: <출력 꼬리>` 를 쓰고 실패 목록에 `test <경로>` 를 넣는다.
  나머지 디렉터리와 fmt 검사는 계속한다. 성공하면 `ok test <경로>` 다.

- **init 실패**: 그 디렉터리의 경로와 init 오류 앞 300자를 출력하고 validate 는 건너뛴다. 나머지 디렉터리 검사는
  계속하고 마지막에 exit 1 로 끝난다.
- **terraform 없음**: `harness tf-check: command not found: terraform` 을 stderr 에 출력하고 exit 127 로 끝난다. `harness run` 은 이것을
  기능의 실패가 아니라 환경 문제로 보고 실행을 중단한다(`docs/SPEC.md` §8, F29). terraform 을 설치하거나 PATH 를
  고친 뒤 `harness run --resume` 으로 이어간다.
- **`--dir <path>`**: 그 디렉터리 아래만 검사한다. 상대 경로는 현재 디렉터리 기준이다. 없는 디렉터리는 exit 2.

## 정책 스캐너 (`--scan`)

`--scan <name>` 은 여러 번 줄 수 있고 name 은 `tflint`·`trivy`·`checkov` 중 하나다. 각 스캐너는 fmt 검사 뒤에
다음 명령으로 실행된다.

| name | 명령 |
| --- | --- |
| `tflint` | `tflint --recursive --no-color` |
| `trivy` | `trivy config --quiet --exit-code 1 .` |
| `checkov` | `checkov -d . --quiet --compact` |

- exit 0 이면 `ok scan <name>` 이다. 0 이 아니면(tflint 는 이슈가 있으면 exit 2) stderr 에
  `scan <name> failed: <출력 꼬리>` 를 쓰고 실패 목록에 `scan <name>` 을 넣는다.
- 값이 없거나 다른 이름(`--scan rm`)이면 아무것도 실행하지 않고 exit 2 이며, 메시지에 허용 이름 목록이 있다.
- 지정한 스캐너가 PATH 에 없으면 terraform 을 실행하기 전에 `harness tf-check: command not found: <name>` 을
  stderr 에 쓰고 exit 127 로 끝난다. terraform 이 없을 때처럼 `harness run` 은 환경 문제로 본다.
- `--scan` 이 없으면 stdout 에 `tf-check: no policy scanners (--scan tflint|trivy|checkov)` 한 줄이 나온다.
- 스캐너를 verify 에 넣으려면 `.harness/config.json` 의 `verify.commands` 를 예컨대
  `["harness tf-check --scan tflint --scan trivy"]` 로 바꾼다. 스캐너 설치와 규칙 설정 파일(`.tflint.hcl` 등)은
  프로젝트가 준비한다.
- 코어에는 심각도 필터나 예외 옵션이 없다. 허용할 규칙은 스캐너가 실행 디렉터리(검사 범위의 맨 위)에서 읽는
  자체 파일로 남긴다: `.tflint.hcl`(규칙 끄기), `.trivyignore`(ID 한 줄에 하나), `.checkov.yaml`(`skip-check:`).
  예외가 파일로 커밋되므로 리뷰에서 보인다.

## provider 캐시

모듈 디렉터리마다 `init` 을 하면 같은 provider 를 디렉터리 수만큼 받게 된다. `tf-check` 는 terraform 의
`TF_PLUGIN_CACHE_DIR` 을 공유 캐시로 쓴다.

- `TF_PLUGIN_CACHE_DIR` 이 이미 설정돼 있으면 그 값을 그대로 쓴다.
- 없으면 `<사용자 캐시 디렉터리>/cc-harness/terraform-plugins` 를 만들어 설정한다. 사용자 캐시 디렉터리는 Windows 에서
  `%LOCALAPPDATA%`, macOS 에서 `~/Library/Caches`, 그 외에서 `$XDG_CACHE_HOME`(없으면 `~/.cache`)이다.
- 두 번째 실행부터는 캐시에 있는 provider 를 다시 받지 않는다.
- 캐시 디렉터리를 만들 수 없으면 경고하고 캐시 없이 계속한다.

verify 명령은 환경이 걸러진 채 실행된다(SR-2). iac 프로필의 `env_allowlist` 기본값이 `["TF_PLUGIN_CACHE_DIR"]` 이라
사용자가 지정한 캐시 경로는 `tf-check` 까지 전달된다. `config.json` 에서 `env_allowlist` 를 직접 지정하면 배열이
프로필 값을 대체하므로 `TF_PLUGIN_CACHE_DIR` 을 다시 넣는다. `XDG_CACHE_HOME` 은 허용 목록에 없어, verify 안에서는
Linux 에서도 `~/.cache/cc-harness/terraform-plugins` 가 쓰인다.
