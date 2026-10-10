# cc-harness v2 — 110개 기능 실측 분석과 품질·시간·토큰 최적화 설계

작성: 2026-10-10. 근거 데이터: `.harness/events/*.jsonl`(2,883건), `.harness/runs/*.metrics.jsonl`(557단계),
`.harness/verdicts/`(144건), `.harness/backlog.json`(527건), 계약 110개, builder 세션 기록(`~/.claude/projects/*harness-wt*`),
git 이력(2026-09-23 이후). 수치는 전부 이 저장소에서 다시 계산할 수 있다.

## 0. 한 줄 결론

v2는 **v1의 문제(한 기능이 45회 루프)를 완전히 해결했다** — 110/110 통과, 기능당 평균 1.2라운드, 차단 finding이 2건뿐이었다.
대신 **다른 종류의 루프**가 생겼다. 기능 110개 중 약 75%가 하네스가 하네스를 고치는 일이었고, 그 대부분은 두 가지 설계 선택의
후속 비용이다: (1) "verify = 전체 테스트 스위트"와 "기능당 테스트 파일 1개"가 만나 스위트가 310초까지 선형으로 커졌고,
그 시간을 줄이려고 캐시·병렬·재시도 기능 22개를 더 만들었다. (2) evaluator 스키마의 `out_of_scope` 배열이 라운드마다 2~8건의
비차단 메모를 만들었고, 그 메모 500여 건을 관리·소화하려고 backlog 서브시스템과 "backlog 수정 묶음" 기능 19개를 만들었다.
코어 ≤2,000줄 목표는 10,500줄(+테스트 32,000줄)이 됐고 SPEC은 11만 자다.

수렴 코어(계약·lint·approve·verify·eval·run 루프·어댑터, 약 3,000줄)는 다시 쓰지 않는다. 걷어낼 것은 그 위에 쌓인 7,000줄이다.

## 1. 실측

### 1.1 처리량과 수렴 (잘 된 것)

| 지표 | 값 |
|---|---|
| 기능 | 110개, 전부 `passed`, 2026-09-23 ~ 10-10 (17일) |
| 라운드 | r1 85 · r2 19 · r3 5 · r4 1 — run 시대(F15 이후) 1라운드 통과 96%, 평균 1.05 |
| 차단 finding | 144개 판정 중 **2건**(F34 AC-2, F56 AC-1 — 둘 다 가림 길이 자르기의 모서리) |
| verify가 잡은 것 | 명령 실패 8, 기준 check 실패 11, vacuous 11, flaky 6 (218 명령 · 815 check 중) |
| 기능당 비용 | 중앙값 $1.95, p90 $3.37, 최대 $9.80; 전체 $226 |

결정적 verify 앵커, 동결 계약, repro 필수 finding, 라운드 상한 — D2의 설계는 전부 작동했다. 유지한다.

### 1.2 시간은 어디에 쓰였나 (metrics 557단계, 76시간)

| 단계 | 비중 | 시간 | 중앙값 | p90 |
|---|---|---|---|---|
| build (builder 세션) | 53% | 40.1h | 16.0분 | 44.7분 |
| verify | 28% | 21.0h | 8.7분 | 18.7분 |
| post_merge_verify | 12% | 9.0h | 5.5분 | 15.3분 |
| eval (evaluator + security) | 4% | 3.4h | 0.7분 | 5.7분 |
| pre_merge_verify · 복구 · 충돌 해결 | 3% | 2.1h | | |

기능 하나의 종단 지연(run_start → passed): **중앙값 52분**, p90 17시간(병렬 대기·잠자기·resume 포함).

verify 내부(73건, 8.15h): `commands`(전체 스위트) **84%**, test_count 9%, 기준 check 7%, 무결성·정리 0.1%.
전체 스위트 1회 = 1,591개 테스트, **310초**(F82 때 462초). 기능당 verify + post_merge_verify + (캐시 미스면) base test_count
= 전체 스위트 2~3회. verify 결과 캐시 적중률 37%(22/60).

### 1.3 토큰·비용은 어디에 쓰였나

| 역할 | 호출 | 비용 | 비중 | 호출당 중앙값 | 턴 중앙값 | 턴당 컨텍스트 중앙값 / p90 / 최대 |
|---|---|---|---|---|---|---|
| builder (opus-5-5) | 80 | $100 (metrics 기준 $177) | 78% | $1.16 · 14.8분 | 28 | **48K / 89K / 144K** |
| evaluator (sonnet) | 58 | $14 ($47) | 21% | $0.20 · 0.2분 | 3 | 31K / 61K |
| security-reviewer (opus) | 7 | $3 | 1% | $0.38 | 5 | 38K |

builder 토큰: cache_read **135.2M**, cache_creation 4.6M, output 1.36M, input 0.004M. 즉 비용의 본체는
"턴마다 다시 읽는 컨텍스트"다. 출력은 턴당 중앙값 519토큰.

builder 세션 기록 8건(F104~F110)을 열어 본 결과:
- 첫 5~10턴이 **저장소 탐색**이다. `ls src test`, `ls lib core`(둘 다 없는 디렉터리), `wc -l lib/*.mjs`, `grep -rn … | head -80`.
  프롬프트에도 CLAUDE.md에도 모듈 지도가 없어서 세션마다 처음부터 더듬는다.
- `lib/run.mjs`(2,026줄, `runFeatures` 한 함수가 1,255줄)를 `sed -n 760,1110p`, `sed -n 1880,2012p`처럼 300줄 단위로
  여러 번 읽는다. 300줄 ≈ 4K 토큰이 그 뒤 모든 턴의 cache_read에 얹힌다. F106(106턴, $3.83)은 최대 컨텍스트 144K였다.
- 테스트 실행이 턴의 절반(F106: 85 Bash 중 59회 테스트). 전체 스위트는 돌리지 않는다(F99 효과).

### 1.4 evaluator 게이트의 신호 대 소음

- 이벤트에 남은 finding 140건: **140건 전부 `backlogged/out_of_scope`**, 차단 0.
- 점수 평균 8.4~8.9(임계 7). 점수가 7 미만으로 내려간 건 대화형 초기(F1~F14)뿐.
- backlog 527건: evaluator 279 + security-reviewer 140 출처. 우선순위 low 347 · medium 8 · high 4.
  2026-09-27에 316건을 일괄 triage, 이후 사람이 `backlog close`로 101건을 닫았고 그중 **83건이 obsolete**
  ("hypothetical", "cosmetic", "coverage note", "matter of taste", "dup of …").
- 나머지 425건은 `resolved_by` — 38개 기능이 backlog 항목을 "해결"했고, F96·F97·F98·F102·F104·F107·F108·F109·F110은
  제목부터 "backlog 수정 묶음"이다. F101→F107→F109→F110(telemetry salt 자리표시)은 매 라운드의 out_of_scope 메모가 다음
  기능이 된 **4단 미니 루프**다.

evaluator가 잡은 실제 결함 2건의 비용: evaluator $47 + security $3 + 사람의 triage(close 이벤트 91회) + 묶음 기능 ~19개
(× $2 + 50분). 게이트로서의 가치는 "verify가 통과한 코드를 다른 모델이 한 번 더 본다"는 보험이지, finding 생산이 아니다.

### 1.5 기능 110개의 분류

| 부류 | 기능 | 수 |
|---|---|---|
| 사용자 가치(코어·skill·언어·모델 정책·이어가기 등) | F1~F8, F15, F17, F22, F23, F28, F39, F40, F43, F47, F61, F62, F64, F66, F70, F72~F75, F95, F103 | ~28 |
| verify 속도·캐시·병렬·재시도 | F24, F25, F26, F30, F33, F37, F42, F65, F78, F79, F80, F81, F83, F84, F85, F87, F89, F91, F92, F94, F100, F106 | ~22 |
| 견고성·모서리(Windows, 신호, 잠자기, git 시간 제한 …) | F9~F14, F16, F20, F21, F29, F31, F32, F35, F36, F38, F44, F48, F49, F50, F88, F105 | ~21 |
| telemetry · insights · learn · 이벤트 | F27, F54~F60, F63, F71, F101, F107, F109, F110 | ~15 |
| backlog 묶음 · 정리 · 테스트 안정화 | F41, F45, F46, F51, F52, F53, F67, F69, F77, F86, F90, F93, F96, F97, F98, F99, F102, F104, F108 | ~19 |

설계 문서(2026-09-23)의 비목표: "`/improve`·자기진단 프로브·KPI 텔레메트리는 제외", "하네스 자기개선 루프 비목표".
telemetry 부류 15개(critical 등급 5개 포함)는 그 비목표를 정면으로 구현한 것이다. 로컬 전용·익명화·opt-out 허브의 salt 파일
자리표시 방어가 `security_tier: critical` 기능 두 개(F109, F110)가 됐다.

### 1.6 코드·문서 규모

| 항목 | 목표(설계 문서) | 실측 |
|---|---|---|
| 코어 + content | ≤ ~2,000줄 | lib 7,910 + commands 1,737 + bin 85 + content 748 = **10,480줄** |
| 테스트 | — | 110파일, 32,408줄, 1,591개 (기능당 코드 60줄 : 테스트 300줄 ≈ **1:5**) |
| SPEC.md | 명세 | 541줄 **114K자(≈52K 토큰)**; §8 run만 29K자; 한 줄 1,000자 넘는 문단 다수 |
| README.md | 요약 | 1,387자짜리 한 줄 포함 |
| 설정 항목 | 소수 | 30개 (`verify.cache`, `retry_scope`, `vacuity_timeout_sec`, `check_parallel`, `limits.*` …) |
| CLI 명령 | 7개(init·lint·verify·eval·run·status·doctor) | 20개 |
| critical 등급 | run·verify만 | **46/110** |

### 1.7 테스트 스위트의 시간은 어디에 있나 (이 머신, 2026-10-10 실행: 1,923개 · 314초 · 테스트 시간 합 2,809초)

| 테스트의 기능 부류 | 테스트 시간 합 | 비중 |
|---|---|---|
| verify 속도·캐시·병렬·시간 제한 (F24·F25·F31·F33·F37·F78·F79·F81·F83·F85·F87 …) | 1,074s | **38%** |
| 사용자 가치(코어) | 643s | 23% |
| 견고성·모서리 | 549s | 20% |
| telemetry·learn·insights | 313s | 11% |
| backlog 묶음·정리 | 230s | 8% |

가장 느린 테스트 25개가 전부 verify 캐시·병렬·시간 제한 부류다(F78 AC-5 74초 — F70~F77 계약의 모든 check를 다시 실행,
F33 AC-3 38초, F81 AC-1 34초, F31 SC-1 31초 ×2 …). 즉 **스위트의 절반이 스위트를 빨리 돌리려고 만든 기능의 테스트**다.
P1·P6로 그 기능을 지우면 테스트도 함께 사라져 스위트가 ~50% 줄고, 남는 verify 범위 축소가 그 위에 얹힌다.

테스트 86개 파일이 SPEC/README/docs 본문을 검사한다(SPEC.md 참조 95곳, 838개 기준 중 102개가 "문서가 X를 적는다" 기준).
SPEC 문장이 테스트에 고정되어 있으니 SPEC은 **추가만 가능**하고 다시 쓸 수 없다 — 그래서 11만 자가 됐다.

## 2. 구조적 원인 — 다섯 가지 결합

1. **verify 앵커 = 전체 스위트** × **기능당 테스트 파일 1개**. 스위트는 기능 수에 비례해 자라고(310초), verify는 그것을 기능당
   2~3회 돌린다. 설계 대응은 앵커 범위를 바꾸는 대신 캐시(커밋 키 → 트리 키 → 테스트 트리 키 → 결과 캐시 → vacuity 재사용)와
   병렬·재시도 범위 축소를 쌓는 것이었다 — 22개 기능, lib ~1,500줄, 테스트 ~5,000줄, 설정 항목 8개.
2. **evaluator 스키마의 `out_of_scope`**. "그 밖에 눈에 띈 것은 전부 적어라"고 하면 Sonnet은 성실히 적는다. 그 결과물을
   관리하려고 backlog 서브시스템(id·심각도·seen·resolves·close·decide·insights)이 생겼고, 소화하려고 묶음 기능이 생겼다.
3. **문서 기준(docs check)**. SPEC 문장을 테스트가 고정하므로 SPEC은 모서리 사례 원장이 됐다. 사람도 모델도 읽지 않는다
   (builder는 grep만 한다). 계약 110개가 이미 그 원장인데 산문으로 한 번 더 유지한다.
4. **builder 컨텍스트 위생 부재**. 모듈 지도 없음, 2,000줄 파일, headless 세션에 사용자 홈 `~/CLAUDE.md`(대화형 spec/plan 안내)
   까지 로드. 턴당 48~144K의 대부분이 작업과 무관한 재읽기다.
5. **등급·범위 규율 완화**. critical 46개, 비목표였던 telemetry 15개. 등급은 reviewer 호출과 SC 기준을 늘리고, 범위 밖 기능은
   그 자체로 시간을 쓸 뿐 아니라 모서리·후속 기능을 낳는다.

## 3. 설계 — 무엇을 어떻게 바꾸나

원칙: 수렴 규칙(D2)은 한 글자도 바꾸지 않는다. 바꾸는 것은 **게이트의 위치와 범위, 프롬프트의 내용, 코드와 문서의 형태**다.

### P1. verify 범위 — 기능 verify는 "기준 check + 영향 모듈 테스트", 전체 스위트는 integration에서 한 번

현재 verify는 `verify.commands`(전체 스위트) → 테스트 수 → 기준 check → base vacuity. 제안:

- **기능 verify**: 무결성 검사(그대로) + 기준 check(그대로, `t.mjs`가 이미 id로 파일을 고른다) + **변경 모듈의 테스트 파일**.
  변경 파일 집합에서 `import … from './x.mjs'` 그래프를 역추적해 그 모듈을 import 하는 테스트 파일만 돌린다(정규식 한 번,
  외부 의존성 없음). 전형적으로 30~60초.
- **전체 스위트**: 병합 후 verify에서 기능마다 돌리지 않고 **run 종료 시 integration에서 한 번** + CI. 실패하면 마지막 병합
  기능부터 되돌리며 범인을 찾는다(218회 중 8회만 실패했고 대부분 기능 자신의 테스트였다 — 드문 경로를 흔한 경로의 비용으로
  막고 있었다). 순차 run이면 기능마다 돌려도 된다(설정 `verify.full_suite: per_feature | per_run`).
- 테스트 수 비감소 검사는 영향 범위 안에서만(전체 수는 integration 검사 때).

효과: verify 중앙값 8.7분 → ~1분, post_merge_verify 5.5분 → 대부분 0. 기능당 벽시계 −35~40%(76h 중 31h → ~8h).
**삭제 가능**: 테스트 수 캐시 3종(F30·F83·F84·F85), verify 결과 캐시(F87), 실패 파일만 재실행(F100), vacuity 재사용(F79),
`verify.cache`·`retry_scope`·`check_parallel`·`run.verify_parallel` 설정 — lib ~1,500줄, 테스트 ~4,000줄.
결정적 앵커는 그대로다: 기준 check가 계약이고, 전체 스위트는 여전히 integration → PR을 막는다.

### P2. 테스트를 기능이 아니라 모듈 단위로

`test/f87-verify-cache.test.mjs` → `test/verify.test.mjs` 안의 `F87 AC-1 …` 테스트. 이름 접두어는 유지하므로 `t.mjs`와
계약 check는 그대로 동작한다. 같은 함수를 여러 기능이 다른 파일에서 검사하던 중복이 드러나 합쳐진다. 스위트 시간이 기능 수가
아니라 모듈 수에 비례하게 된다. P1의 "영향 모듈 테스트"가 자연스럽게 파일 단위가 된다.

함께: **문서 기준을 없앤다**. "SPEC §x가 Y를 적는다(문서 check)" 기준 102개 대신 계약에 `docs: ["docs/run.md#병합-복구"]`
필드를 두고 lint가 그 파일·앵커의 존재만 본다. evaluator 루브릭 `quality`에 "docs 필드의 문서가 변경과 맞는다"를 넣는다.
SPEC 본문을 고정하던 테스트 95곳은 P3와 함께 제거.

### P3. SPEC.md를 5K 토큰 규범 명세로 다시 쓰고, 모서리 원장은 계약에서 생성

- SPEC = 목적·역할·상태 파일·계약 형식·lint 규칙·verify 단계·판정 규칙·run 수명주기·보안 요구(SR)·에러 코드. 각 항목은
  "무엇을 보장하는가"만. 현재 §2(20K자)·§7(15K자)·§8(29K자)의 "…이면 …이고 …면 …" 사슬은 전부 계약 기준의 산문 복제다.
- `harness contracts --md` 가 110개 계약의 기준을 모듈·주제별로 묶은 `docs/reference/*.md`를 생성한다. 손으로 유지하지 않는다.
- README의 1,000자 문단은 각 1~2줄 + 링크.

토큰 효과는 간접적이다(역할 프롬프트는 SPEC을 싣지 않는다). 효과는 사람의 읽기 비용, 문서 기준 소멸, SPEC 재작성 가능성.

### P4. evaluator — 차단 finding만, `out_of_scope` 삭제, backlog는 사람·verify 출처만

- 출력 스키마: `{scores, findings[]}`. `out_of_scope` 배열을 **스키마에서 뺀다**. 프롬프트: "재현 가능한 결함(계약 기준 또는
  회귀)만 보고한다. 그 밖의 관찰은 적지 않는다. 결함이 없으면 높은 점수를 주고 끝낸다." 선택 필드로 `notes`(최대 3개,
  `severity: high`만) — run 보고서의 `## Observations`에만 쓰고 backlog에는 넣지 않는다.
- backlog는 남긴다. 출처는 사람(`decide`), verify(flaky), run(blocked 재범위 제안)만. `seen`·`backlog_id` 병합·
  `## Open backlog` 프롬프트 절(F22·F75의 그 부분)은 제거 — evaluator가 더는 메모를 내지 않으니 필요 없다.
- evaluator 루브릭에 한 줄: "점수는 결함의 유무로 정한다. 취향·가설·향후 위험은 점수에 반영하지 않는다."

효과: evaluator 출력 토큰 −60%(작다). 진짜 효과는 하류 — triage 0, 묶음 기능 0. 기능 전체의 ~17%(19개)가 이 부류였다.
B1(integration 브랜치 대소문자 충돌, high)처럼 드물게 가치 있는 관찰은 `notes`로 보고서에 남는다.

### P5. builder 프롬프트와 세션 위생

1. **모듈 지도**를 프롬프트에 넣는다(또는 추적 파일 `docs/MAP.md`를 프로젝트 CLAUDE.md가 `@docs/MAP.md`로 import).
   한 모듈에 한 줄 — 책임, 공개 함수 2~3개, 담당 테스트 파일. ≈600 토큰. 관찰된 탐색 턴 5~10개(턴의 15~25%)가 사라진다.
   이 저장소에서는 `harness init`이 `lib/`·`src/`·`test/` 트리에서 초안을 만들고 사람이 다듬는다.
2. **headless 세션에 사용자 홈 CLAUDE.md를 싣지 않는다**: claude 어댑터에 `--setting-sources project`(없으면 `--add-dir` 없이
   `HOME`을 임시 디렉터리로). 대화형 워크플로 안내(spec·plan skill, 한국어 규칙)는 builder에게 무의미한 2~3K 토큰이다.
   프로젝트 CLAUDE.md의 관리 블록도 headless에서는 중복이다 — 역할 프롬프트가 같은 규칙을 이미 담는다.
3. **`lib/run.mjs` 분할**: `run/state.mjs`(상태 파일·resume), `run/worktree.mjs`(worktree·브랜치·잠금), `run/feature.mjs`
   (기능 하나의 build→verify→eval 라운드), `run/merge.mjs`(병합·복구), `run/report.mjs`. `runFeatures`는 스케줄러 100줄.
   builder가 300줄 모듈 하나를 읽으면 끝나고, 단위 테스트가 가능해져 38초짜리 f6-run 종단 테스트가 줄어든다.
   p90 컨텍스트 89K → ~60K 예상(run을 건드리는 기능에서).
4. builder 프롬프트에 **직전 라운드의 verify 결과 전문**이 아니라 실패 항목만(이미 그렇게 한다 — 유지).
5. 세션 기록에서 측정을 계속한다: `harness stats`에 "탐색 턴 비율"(`ls`·`wc`·`grep -rn` 으로 시작하는 Bash의 비율)을 추가해
   지도가 효과를 내는지 본다.

### P6. 범위 — telemetry·learn·insights를 떼어낸다

- 유지: `events`(이 분석이 그것으로 가능했다; 쓰기 비용 0), `stats`.
- 제거 또는 별도 패키지(`cc-harness-telemetry`): `export`·`learn`·`insights`·`ci-record`·`note`·`decide`(decide는 run 재범위
  결정이라 `approve --accept-risk` 류 옵션으로 흡수). salt·허브·allowlist·`.exported` 위치 추적 전부 함께.
- −6 명령, −~2,000줄 lib, −~5,000줄 테스트(스위트 −20%), critical 기능 부류 하나 소멸.

### P7. security_tier — "신뢰 경계"로 정의를 좁힌다

critical = 모델·사용자가 준 명령을 실행하는 경로(verify 명령·check·repro 실행기) ∨ 브랜치 병합·worktree 조작 ∨ 저장소 밖 쓰기.
로그 텍스트의 가림, 설정 검증, 메시지 문구는 standard. 46 → ~10. SC 기준·reviewer 호출·"보안 후속" 기능이 함께 준다.

### P8. 역할 모델 정책 — 이미 지원하는 `by_tier`를 쓴다

builder는 119단계 전부 Opus($164). Sonnet builder 16단계는 $13.5. 제안 config:
```json
"roles": {
  "builder":   {"adapter": "claude", "model": "claude-sonnet-5-5", "by_tier": {"critical": "claude-opus-5-5"}, "escalate": "claude-opus-5-5"},
  "evaluator": {"adapter": "claude", "model": "claude-opus-5-5"}
}
```
evaluator를 Opus로 올리는 이유: 호출당 $0.20·3턴으로 싸고, 게이트의 가치는 "다른 모델이 본다"에 있으니 builder가 Sonnet이면
evaluator가 Opus여야 cross-model이 유지된다. 1라운드 통과율이 96%에서 얼마나 내려가는지 **표준 기능 10개로 측정**한 뒤 결정한다
(내려간 라운드 비용 < 절감 비용이면 유지). 예상 builder 비용 −40%.

### P9. 계약 — 기준은 동작, 파일 구조가 아니다

838개 check 중 824개가 `node test/t.mjs "F AC"`다. 기준 = "그 이름의 테스트가 있고 통과한다"이며, 실효는 vacuity 검사가
준다(11건 적발). 유지하되 lint에 두 경고를 더한다: 기준 문장이 파일·함수 이름을 지정하면("lib/x.mjs 가 y 를 export") 경고,
`new: false` 기준이 다른 기능의 테스트를 check로 쓰면 회귀 가드로 표시(지금 관례를 lint가 안다).

### P10. 기대 효과 (기능당 중앙값)

| | 현재 | P1+P4+P5+P6+P8 후 |
|---|---|---|
| 벽시계(run_start → passed) | 52분 | ~25분 |
| verify + post_merge_verify | 8.7 + 5.5분 | ~1 + 0분 (run당 전체 스위트 1회 별도) |
| builder 턴 / 턴당 컨텍스트 | 28 / 48K | ~22 / ~38K |
| 비용 | $1.95 | ~$1.0 |
| 사람의 triage | close 91회 / 110기능 | 0 |
| 하네스 자기 작업 비율 | ~75% | 목표 <20% |
| 코드 / 테스트 / SPEC | 10.5K / 32K줄 / 114K자 | ~6K / ~18K줄 / ~15K자 |
| 전체 스위트 1회 | 314초 (1,923개) | ~90초 (P1·P6로 테스트 시간의 49% 삭제 + 모듈 단위 중복 제거) |

가장 큰 항목은 표에 없다: 하네스가 **자기 일을 만들지 않게** 되는 것. 같은 17일에 사용자 가치 기능이 28개가 아니라 70~80개였을 것이다.

## 4. 실행 순서 — 각 단계가 계약 하나

from-scratch 재작성은 하지 않는다(v1→v2가 보여 줬듯 재작성은 가정을 리셋하지만 비용이 크고, 이번엔 코어가 멀쩡하다).
각 단계는 독립적으로 가치가 있고 되돌릴 수 있다.

| 단계 | 내용 | 등급 | 위험 | 선행 |
|---|---|---|---|---|
| 0 | `lib/run.mjs` 분할(동작 불변), 모듈 지도, headless 세션에서 홈 CLAUDE.md 제외 | standard | 낮음 | — |
| 1 | P4 evaluator 스키마·프롬프트, backlog 출처 축소 | standard | 낮음 (verdict 형식 변경 → 판정 파일 버전 2) | — |
| 2 | P1 verify 범위(영향 모듈) + run 종료 시 전체 스위트, 캐시 3종·결과 캐시·재시도 범위 삭제 | **critical** (verify 경로) | 중간 — 영향 그래프 누락 시 회귀를 integration에서야 잡음. 완화: 첫 2주는 `full_suite: per_feature` 기본, 수치 비교 후 전환 | 0 |
| 3 | P2 테스트 모듈 단위 재배치 + 문서 기준 제거, P3 SPEC 재작성 + `contracts --md` | standard | 중간 — 큰 diff. `assert-count.mjs`가 이름 변경을 막으므로 그 규칙에 "파일 이동은 허용" 추가 필요 | 1 |
| 4 | P6 telemetry 분리, P7 등급 정의, P8 모델 정책 측정 | standard | 낮음 | 1 |

단계 0·1은 하루, 2는 이틀, 3은 사흘(대부분 기계적 이동), 4는 하루.

## 5. 바꾸지 않는 것

- D1 위협 모델, D2 수렴 규칙(동결·repro·라운드 상한·엄격 감소·blocked), min-of-5, critical 보안 7.
- Node 오케스트레이터 + 단계별 새 headless 세션. 어댑터 구조(claude·gemini·codex·generic).
- `t.mjs`의 "일치하는 테스트가 없으면 실패" 규칙과 vacuity 검사 — 824개 check의 실효를 지키는 두 장치다.
- `.harness/` 상태 파일 형식(verdict 스키마 버전만 올린다).
- 사람의 결정 지점: approve, blocked, protected 브랜치 병합.

## 6. 측정으로 확인할 것

각 단계 전후로 `harness stats --since`와 이 문서의 1.2~1.4 스크립트를 다시 돌려 비교한다. 특히:
1라운드 통과율(P8 전환 조건), verify 중앙값(P1), builder 턴·턴당 컨텍스트(P5), backlog 신규 항목 수(P4 — 0이어야 한다),
기능 분류에서 "하네스 자기 작업" 비율(P6·P7).
