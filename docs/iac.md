# iac 프로필 — `harness tf-check` 와 provider 캐시

iac 프로필(`"profile": "iac"`)의 verify 는 `harness tf-check` 한 명령이다. 규칙의 원문은 `docs/SPEC.md` §4 의
프로필 절이다. `terraform plan`·`apply` 는 verify 가 실행하지 않는다(클라우드 자격 증명이 SR-2 로 전달되지 않는다) —
plan 은 `plan-review` skill 로 검토한다.

## tf-check 가 하는 일

```
harness tf-check [--dir <path>]
```

1. 저장소(또는 `--dir` 아래)에서 `*.tf` 파일이 있는 디렉터리를 모두 찾는다. `.terraform`·`.harness`·`.git` 과
   심볼릭 링크 디렉터리는 들어가지 않는다.
2. 그 디렉터리마다 `terraform init -backend=false -input=false` 와 `terraform validate` 를 **그 디렉터리에서** 실행한다.
   모듈이 여러 개여도 루트 하나만 검사하던 이전 방식과 달리 모듈마다 검증된다.
3. `terraform fmt -check -recursive` 를 검사 범위의 맨 위 디렉터리에서 **한 번** 실행한다.

하나라도 실패하면 exit 1 이고, 실패한 디렉터리를 프로젝트 기준 경로(`modules/bad`)로 stderr 에 출력한다.
성공한 디렉터리는 `ok <경로>` 로 stdout 에 나온다.

- **init 실패**: 그 디렉터리의 경로와 init 오류 앞 300자를 출력하고 validate 는 건너뛴다. 나머지 디렉터리 검사는
  계속하고 마지막에 exit 1 로 끝난다.
- **terraform 없음**: `command not found: terraform` 을 stderr 에 출력하고 exit 127 로 끝난다. `harness run` 은 이것을
  기능의 실패가 아니라 환경 문제로 보고 실행을 중단한다(`docs/SPEC.md` §8, F29). terraform 을 설치하거나 PATH 를
  고친 뒤 `harness run --resume` 으로 이어간다.
- **`--dir <path>`**: 그 디렉터리 아래만 검사한다. 상대 경로는 현재 디렉터리 기준이다. 없는 디렉터리는 exit 2.

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
