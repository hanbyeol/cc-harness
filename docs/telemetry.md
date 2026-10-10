# harness export — 현장 데이터 내보내기 (기본으로 켜짐)

여러 프로젝트에서 하네스가 어떻게 쓰이는지(어느 lint 규칙이 자주 걸리는지, 지적이 왜 이관되는지, 단계별 시간·비용)를
한곳에 모으기 위한 기능이다. 각 프로젝트의 이벤트 기록(`.harness/events/*.jsonl`)을 **익명화한 묶음**으로 로컬
**허브 디렉터리**에 쓴다. 규칙의 원문은 `docs/SPEC.md` §2 현장 데이터 내보내기다.

- 원격 서버로 보내지 않는다. 허브는 이 컴퓨터의 디렉터리이고, 그것을 어디로 옮길지는 사람이 정한다.
- 암호화하지 않는다. 대신 묶음에는 아래 허용 목록의 값만 남는다.

## 기본으로 켜짐, 끄는 방법

기본으로 켜져 있다. `.harness/config.json` 에 `telemetry` 가 없거나 `telemetry.share` 가 없으면 `harness export` 가
동작하고, `harness run`(중단된 경우 제외)과 `harness eval` 이 끝날 때 export 를 한 번 실행한다(`telemetry.auto_export` 도
기본값이 `true`). 자동 export 의 출력은 stderr 로만 가고, 실패해도 run·eval 의 결과와 종료 코드는 바뀌지 않는다.

끄는 방법은 둘이다.

1. 프로젝트에서 끄기 — `.harness/config.json` 에 다음을 둔다. `telemetry.share` 가 `false` 거나 불리언이 아닌 값
   (`"true"`·`1`·`null` 등)이면 `harness export` 는 `telemetry.share is off` 를 출력하고 아무것도 쓰지 않는다(exit 0).

   ```json
   { "telemetry": { "share": false } }
   ```

   자동 export 만 끄려면 `{ "telemetry": { "auto_export": false } }` — `harness export` 는 그대로 쓸 수 있다.
2. 환경에서 끄기 — 환경 변수 `CC_HARNESS_TELEMETRY` 가 `0`·`off`·`false`·`no`(앞뒤 공백·대소문자 무관 — `OFF`·`False`
   도 된다)면 config 와 상관없이 export 와 자동 export 가 모두 꺼진다(예: `CC_HARNESS_TELEMETRY=0 harness run`, 셸 프로필에
   `export CC_HARNESS_TELEMETRY=off`). 없거나 `1`·`on`·`yes` 면 config 를 따르고, 그 밖의 값이면 경고 한 줄을 내고 config 를 따른다.

기본값으로 켜진 상태에서 프로젝트의 첫 export(`.harness/events/.exported` 가 아직 없을 때)가 성공하면 stderr 에 한 줄
안내가 나온다. `share` 를 명시적으로 `true` 로 둔 경우와 두 번째 export 부터는 나오지 않는다.

```
harness: telemetry is on by default — anonymized events go to <hub> (local only); set "telemetry": {"share": false} in .harness/config.json or CC_HARNESS_TELEMETRY=0 to turn it off
```

지금 상태는 `harness doctor` 의 한 줄로 확인한다: `telemetry: on (default)`·`on (config)`·`off (config)`·
`off (CC_HARNESS_TELEMETRY)` 중 하나와 허브 경로.

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

묶음 파일은 `<hub>/<project>/<시각>.jsonl` 이다. `<project>` 는 설치별 salt 를 넣은 해시 — sha256(salt + 로컬 project id)
앞 16자다(로컬 project id 는 이벤트의 `project`, 저장소 최상위 경로의 sha256 앞 16자). `<시각>` 은 내보낸 시각의 ISO 8601 기본 형식(예: `20260928T123456.789Z` — Windows 에서도 쓸 수
있게 `:` 가 없다)이다. POSIX 에서 export 가 새로 만드는 허브·프로젝트 디렉터리는 모드 0700, 묶음 파일은 0600 이다
(소유자만 읽을 수 있다).

설치별 salt 는 `~/.cc-harness/salt`(Windows 는 `USERPROFILE` 아래)이다. 첫 export 가 crypto 난수 32바이트(64자 hex)로 만들고
파일은 0600, 새로 만든 `~/.cc-harness` 디렉터리는 0700 이다. salt 는 내보낸 값(`project`, `data.test`·`data.tests`)에만 들어가고
salt 자체는 묶음·허브·`.harness/` 어디에도 쓰이지 않는다 — 허브만 보고는 경로나 테스트 이름을 짐작해 해시를 맞춰 볼 수 없다.
로컬 이벤트 파일의 `project` 는 salt 없는 값 그대로다. salt 파일을 지우면 다음 export 가 새 salt 를 만들고 같은 저장소도 새 id 로
내보낸다(이전 묶음은 남고 `harness learn` 은 다른 프로젝트로 센다). salt 파일이 64자 hex 가 아니거나 읽을 수 없으면 export 는 경고만
내고 아무것도 내보내지 않으며(exit 0) 그 파일을 덮어쓰지 않는다.

마지막 내보내기의 시각과 이벤트 파일별 바이트 위치는 프로젝트의 `.harness/events/.exported` 에 기록된다. 다음 export 는 각 파일에서 그 위치 뒤에 추가된 줄만 내보내므로 같은 이벤트를 두 번 내보내지 않고, 같은 밀리초에 기록된 이벤트도 빠뜨리지 않는다. 이벤트 파일이 잘리거나 교체되면 그 파일을 처음부터 내보내고 경고한다. 허브에
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
| `project` | salt 를 넣은 저장소 경로 해시 — 경로 자체는 없다 |
| `round` | 라운드 번호 |
| `data.rule` | lint 규칙 이름 |
| `data.reason` | 지적의 이관 사유(`missing_repro`·`repro_not_reproduced` 등), 기능 상태가 바뀐 사유(`pass`·`stall`·`max_rounds` 등) |
| `data.outcome` | `blocking`·`backlogged` |
| `data.from`·`data.to` | status 이벤트의 이전·새 기능 상태(`todo`·`approved`·`in_progress`·`passed`·`blocked`·`skipped`) |
| `data.model` | 모델 이름 |
| `data.role` | 역할(`builder`·`evaluator`·`security-reviewer`) |
| `data.dimension` | 평가 차원 |
| `data.kind` | 개입 종류(`harness note --kind`) |
| `data.test`·`data.tests` | sha256(salt + 테스트 이름) 앞 16자 |

그 밖에 `data` 의 수치·불리언(시간, 비용, 개수 등)은 코드 식별자 형태의 키에서만 남는다.

남지 않는 것: 기능 id·제목, 기준 문장, 지적 요약, 명령 문자열(check·repro·verify 명령), 파일 경로, 세션 id,
환경 변수 값, 사람이 쓴 사유·메모, 저장소 경로, git remote, 사용자 이름.

## 허브 분석 — `harness learn`

허브에 모인 묶음으로 하네스 자체를 개선할 과제를 찾는다. 규칙의 원문은 `docs/SPEC.md` §2 하네스 자기 개선이다.
분석은 읽기만 하고, 개선 과제는 **후보**일 뿐이다 — 계약 초안을 만들거나 승인하지 않으며 사람이 계약으로 만들고 승인한다.

```bash
harness learn                              # 기본 허브(export 와 같은 위치)의 버전별 지표와 후보
harness learn --hub /path/to/hub --json    # 같은 내용을 JSON 으로
harness learn --since 2026-09-01           # 그날(UTC) 이후의 줄만
harness learn --propose                    # 후보를 이 저장소의 backlog 에 추가(같은 규칙이면 갱신)
harness learn --compare 2.0.0 2.1.0        # 두 버전의 지표를 나란히, 변화량과 방향
```

- 허브가 없거나 셀 줄이 없으면 `no field data` 를 출력하고 exit 0 이다.
- 허브의 줄도 위 허용 목록으로 다시 거른다. 목록 밖의 키(누가 손으로 넣었거나 오염된 묶음)는 무시하고 파일마다
  `ignored keys outside the allowlist: …` 경고를 낸다. 올바른 줄이 아니면 세지 않고 `lines skipped` 경고를 낸다.

### 버전별 지표

기능 하나 = `to` 가 `passed`·`blocked` 인 status 이벤트. `harness run` 은 그 이벤트에 기능의 builder 호출 합계
(`build_duration_ms`·`build_turns`·`build_cost_usd`)를 넣는다.

| 지표 | 뜻 |
|------|----|
| `build` | 기능당 build 시간·턴·비용의 중앙값(`build_duration_ms`·`build_turns`·`build_cost_usd`) |
| `first_round_pass_rate` | 1라운드에 passed 된 기능 / 끝난 기능 |
| `blocked_rate`·`blocked_reasons` | blocked 된 기능 / 끝난 기능, blocked 사유 분포 |
| `interventions` | 사람 개입(`harness note`) 수 |
| `lint_rejections` | lint 거부 규칙 상위 3 |
| `reproduction_rate` | 지적 재현율 = blocking 지적 / 전체 지적 |
| `ci_repeated` | 2개 이상의 CI 기록에서 실패한 테스트 해시 상위 3 |

### 개선 과제 후보 규칙과 임계값

규칙(이 순서로): `lint_rule`(lint 규칙마다), `backlog_reason`(지적 이관 사유마다), `low_reproduction`(전체 재현율 50% 미만),
`blocked_reason`(blocked 사유마다), `intervention`(개입 종류마다), `ci_repeated`(2개 이상의 CI 기록에서 실패한 테스트마다).

후보마다 근거 `evidence: {projects, events, versions}` 가 붙고, 근거가 **2개 이상 프로젝트**이거나 **이벤트 10건 이상**인 후보만 나온다.
한 프로젝트의 우연한 일로 하네스를 바꾸지 않기 위해서다. `priority` 는 근거 프로젝트 3개 이상 `high`, 2개 `medium`, 1개 `low`.

### `--propose`

후보를 현재 저장소의 `.harness/backlog.json` 에 `source: "field-data"`, `learn_rule`(`<rule>:<subject>`), `summary`, `priority`,
`evidence`, `seen: 1` 로 추가한다. 같은 `learn_rule` 의 열린(해결되지 않은) field-data 항목이 이미 있으면 새로 만들지 않고 그 항목의
`seen` 을 1 늘리고 `evidence` 를 새 값으로 바꾼다. 해결된 항목은 다시 열지 않고 새 항목을 만든다.

### `--compare <v1> <v2>`

`build_duration_ms`·`build_turns`·`build_cost_usd`·`first_round_pass_rate`·`blocked_rate`·`interventions`·`reproduction_rate` 를
두 버전에 대해 나란히 보여 주고 변화량(v2 − v1)과 방향을 붙인다. 시간·턴·비용·blocked 비율·개입은 줄면, 통과율·재현율은 늘면
`improved`, 반대면 `worse`, 같으면 `same`, 한쪽에 값이 없으면 `n/a` 다.
