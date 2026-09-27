# harness export — 현장 데이터 내보내기 (opt-in)

여러 프로젝트에서 하네스가 어떻게 쓰이는지(어느 lint 규칙이 자주 걸리는지, 지적이 왜 이관되는지, 단계별 시간·비용)를
한곳에 모으기 위한 기능이다. 각 프로젝트의 이벤트 기록(`.harness/events/*.jsonl`)을 **익명화한 묶음**으로 로컬
**허브 디렉터리**에 쓴다. 규칙의 원문은 `docs/SPEC.md` §2 현장 데이터 내보내기다.

- 원격 서버로 보내지 않는다. 허브는 이 컴퓨터의 디렉터리이고, 그것을 어디로 옮길지는 사람이 정한다.
- 암호화하지 않는다. 대신 묶음에는 아래 허용 목록의 값만 남는다.

## 켜기 (opt-in)

기본은 꺼져 있다. `.harness/config.json` 에 다음을 넣어야 동작한다.

```json
{ "telemetry": { "share": true, "auto_export": false } }
```

- `telemetry.share` 가 `true` 가 아니면 `harness export` 는 `telemetry.share is off` 를 출력하고 아무것도 쓰지 않는다(exit 0).
- `telemetry.auto_export` 도 `true` 면 `harness run`(중단된 경우 제외)과 `harness eval` 이 끝날 때 export 를 한 번 실행한다.
  그 출력은 stderr 로만 가고, 실패해도 run·eval 의 결과와 종료 코드는 바뀌지 않는다.

## 사용

```bash
harness export --dry-run          # 쓰지 않고 내보낼 줄 수와 첫 3줄을 보여 준다
harness export                    # 기본 허브에 쓴다
harness export --hub /path/to/hub # 다른 허브에 쓴다
```

## 허브 위치

1. `--hub <dir>`
2. 없으면 환경 변수 `CC_HARNESS_HUB`
3. 없으면 `<사용자 홈>/.cc-harness/hub` (`~/.cc-harness/hub`)

묶음 파일은 `<hub>/<project>/<시각>.jsonl` 이다. `<project>` 는 저장소 최상위 경로의 sha256 앞 16자(이벤트의
`project` 와 같다), `<시각>` 은 내보낸 시각의 ISO 8601 기본 형식(예: `20260928T123456.789Z` — Windows 에서도 쓸 수
있게 `:` 가 없다)이다.

마지막 내보내기 시각은 프로젝트의 `.harness/events/.exported` 에 기록된다. 다음 export 는 그 시각 이후의 이벤트만 내보내므로 같은 이벤트를 두 번 내보내지 않는다. 허브에
쓸 수 없으면 경로와 오류를 출력하고 exit 1 이며 `.exported` 는 바뀌지 않는다 — 고친 뒤 다시 실행하면 같은 이벤트가 나간다.

## 허용 필드

묶음의 한 줄에는 다음만 남는다. 목록은 코드(`lib/telemetry.mjs`)에 고정되어 있고, 여기에 없는 필드·값은 버려진다.

| 필드 | 값 |
|------|----|
| `ts` | 이벤트 시각 |
| `stage` | plan·build·verify·eval·security·feedback |
| `type` | 단계 안의 사건 이름(코드 식별자 형태가 아니면 null) |
| `harness_version` | 하네스 버전 |
| `profile` | 프로필 이름(코어의 프로필이 아니면 null) |
| `project` | 저장소 경로의 해시 — 경로 자체는 없다 |
| `round` | 라운드 번호 |
| `data.rule` | lint 규칙 이름 |
| `data.reason` | 지적의 이관 사유(`missing_repro`·`repro_not_reproduced` 등) |
| `data.outcome` | `blocking`·`backlogged` |
| `data.model` | 모델 이름 |
| `data.role` | 역할(`builder`·`evaluator`·`security-reviewer`) |
| `data.dimension` | 평가 차원 |
| `data.kind` | 개입 종류(`harness note --kind`) |
| `data.test`·`data.tests` | 테스트 이름의 sha256 앞 16자 |

그 밖에 `data` 의 수치·불리언(시간, 비용, 개수 등)은 코드 식별자 형태의 키에서만 남는다.

남지 않는 것: 기능 id·제목, 기준 문장, 지적 요약, 명령 문자열(check·repro·verify 명령), 파일 경로, 세션 id,
환경 변수 값, 사람이 쓴 사유·메모, 저장소 경로, git remote, 사용자 이름.
