# cc-harness 불변식 (INVARIANTS)

이 문서는 하네스의 **약화시킬 수 없는 성질**을 명문화한다.
재귀적 자기개선 루프(`/improve`)와 일반 작업 모두 이 불변식을 위반하는 방향으로
"개선"할 수 없다. `hooks/invariant-guard.sh`가 PreToolUse에서 이를 **결정론적으로 집행**한다.

> **핵심 원칙**: 검증 장치는 **add-only**다. 더 엄격하게(임계값 상향, deny 추가, 테스트 추가)는
> 자유지만, 더 느슨하게(임계값 하향, deny 삭제, 테스트 삭제) 만들려면 가드가 차단하고
> **사람의 명시적 승인**을 요구한다. 자동화된 루프는 이 경계를 넘을 수 없다.

## 왜 불변식이 필요한가
재귀적 자기개선의 고유 위험: 루프가 자기 검증 장치 자체를 수정 대상으로 삼으면, "통과율을
높이는" 가장 쉬운 길은 **기준을 낮추는 것**이다. evaluator를 관대하게, firewall을 느슨하게,
실패하는 테스트를 삭제하면 모든 게이트가 초록색이 된다 — 그리고 하네스는 무의미해진다.
독립 evaluator만으로는 이를 막을 수 없다(evaluator 자체가 수정 대상이므로). 따라서 메타
레벨의 고정점이 필요하다.

## 불변식 목록

### INV-1. Evaluator 독립성
implementer는 `feature_list.json`의 `passes`를 직접 `true`로 바꿀 수 없다. 오직 독립 evaluator만
판정한다. inline self-review로 대체하지 않는다 ([ADR-003](DECISIONS/ADR-003-superpowers-adoption.md)).
**왜 불변**: 자기 작업의 평가자는 자기 가정을 공유한다 — 독립성이 검증의 전제다.

### INV-2. min-of-5 채점
evaluator 종합 점수 = 5개 차원(기능·품질·보안·에러처리·테스트) 점수의 **최솟값**.
평균으로 바꾸지 않는다. **왜 불변**: 평균은 한 영역의 치명적 약점을 다른 영역으로 가린다.

### INV-3. 임계값은 하향·제거 불가
`progress/harness-config.json`(및 templates 기본값)의 `scoring.pass_threshold`,
`scoring.security_thresholds.{critical,standard,low}`는 **낮출 수 없고, 키를 제거할 수도 없다**
(제거는 기본값으로의 암묵적 완화 또는 게이트 무력화이므로 하향과 동급으로 본다). 높이는 것은 허용.
현재 기준선: pass_threshold ≥ 7, critical ≥ 7, standard ≥ 5, low ≥ 3.
**왜 불변**: 임계값 하향·제거는 "기준 미달을 통과로 재정의"하는 것 — 가장 직접적인 자기약화.
가드는 Write·Edit·MultiEdit 모두에서 최종 적용 결과(NEW)를 재구성해 검사한다 — 편집 도구를
바꿔 우회할 수 없다.

### INV-4. security_tier critical 자동 fail
`security_tier: critical` 기능은 보안 점수가 임계값 미만이면 다른 점수와 무관하게 fail.
이 규칙을 제거·우회하지 않는다. **왜 불변**: 보안은 협상 대상이 아니다.

### INV-5. Firewall deny 목록은 add-only
`hooks/pre-bash-firewall.sh`의 `BLOCKED`·`INDIRECT_PATTERNS` 배열에서 패턴을 **삭제할 수 없다**
(추가는 자유). ask 티어로의 강등도 deny 목록 축소로 간주한다. 가드는 **배열별로** 패턴 수를
검사하므로, 한 배열에서 빼고 다른 배열에 더해 총수를 맞추는 swap 우회도 차단한다.
**왜 불변**: 파괴적 명령 차단의 축소는 안전 회귀다. 오탐 수정이 필요하면 패턴을 *정밀화*하되
(같은 위험을 여전히 잡도록) 삭제하지 않는다 — 정밀화는 사람이 검토한다.

### INV-6. 테스트·기준은 add-only
`tests/*.bats`의 `@test`, Sprint Contract·acceptance criteria의 항목은 **삭제·약화할 수 없다**.
추가만 허용. **왜 불변**: 실패하는 테스트를 지워 초록을 만드는 것은 검증의 정반대다.
기준이 정말 틀렸다면 사람이 승인한다 (implementer/evaluator 규칙: criteria_backfill은 추가만).

### INV-7. 안전장치 자기 보호
`docs/INVARIANTS.md`·`hooks/invariant-guard.sh` 자체의 축소, 검사 로직 약화, 그리고
`hooks/hooks.json`에서의 invariant-guard **등록 제거**가 모두 가드 대상이다:
- 두 파일의 30% 이상 축소를 차단
- invariant-guard.sh의 `deny` 호출·`exit 2` 개수 감소를 차단 (라인 수를 유지한 채
  deny를 no-op로 바꾸는 semantic gutting 방어)
- hooks.json에서 invariant-guard 참조가 사라지면 차단 (한 줄로 가드를 끄는 우회 방어)

**왜 불변**: 가드를 끌 수 있으면 다른 모든 불변식이 무력해진다.

### INV-8. 프로파일은 검증을 교체할 뿐 제거하지 않는다
라이프사이클 프로파일(sdlc|iac|ops)은 **검증 모델을 교체**한다 — 검증 자체를 없애지 않는다.
각 프로파일은 자기 게이트를 **반드시** 가진다.
- **sdlc**: 독립 evaluator(5차원, min-of-5) — INV-1~7 그대로 적용.
- **iac**: plan-review 게이트(plan diff 일치 + tflint/trivy + smoke + 무drift). 이 게이트는 자체
  통과 기준을 **낮출 수 없다**(add-only). **plan 미확인 apply 금지**, **prod auto-approve 금지**.
- **ops**: health+회귀 게이트(롤아웃 status 성공 + readiness/liveness 정상 + 회귀 없음). 자체 통과
  기준을 낮출 수 없다(add-only). **라이브 prod 변경은 Plan 게이트 승인 + 롤백 준비 필수**.
- **프로파일 전환으로 검증을 우회할 수 없다**: profile을 바꿔 더 약한 게이트로 도망가는 것은
  금지다. sdlc 프로파일의 pass_threshold·security_thresholds·evaluator 독립성은 프로파일과
  무관하게 불변이며, invariant-guard는 sdlc 임계값 하향을 계속 차단한다.

**왜 불변**: 프로파일이 "검증을 끄는 스위치"가 되면 라이프사이클을 바꿨다는 핑계로 모든 게이트를
무력화할 수 있다 — 프로파일은 *어떻게 검증하는가*를 바꿀 뿐 *검증하는가*를 바꾸지 않는다.

**알려진 한계** (backlog): @test **본문**에 `skip`/조기 return을 주입해 개수는 유지한 채
테스트를 무력화하는 경우는 개수 기반 검사로 잡지 못한다(정상 `skip "도구 없음"`과 구분
곤란). 이는 pre-commit-gate의 실제 테스트 실행이 2차 방어선이다 — 무력화된 테스트라도
CI/게이트에서 실행되면 회귀가 드러난다.

### INV-9. Firewall allow 계층은 deny/ask 이후에만 평가된다 (위험정의 우선)
`hooks/pre-bash-firewall.sh`의 Layer 4(allow)는 **반드시 deny(L1/2)·ask(L3) 뒤에** 위치한다.
Layer 4는 **default-allow**(위험 정의에 걸리지 않은 명령은 통과) 모델이므로, 안전성은 전적으로
**deny+ask 위험 정의의 완전성**에 실린다. 따라서 위험 명령은 반드시 Layer 4 도달 **전에**
`exit 2`(deny) 또는 `ask`로 걸러져야 한다. allow의 config 토글(`firewall.auto_allow`, 기본 true)은
**allow만** 켜고 끈다 — deny/ask는 이 값과 무관하게 항상 실행된다.
**왜 불변**: allow를 deny/ask보다 앞에 두거나 토글로 가드를 끄면 안전 회귀다. deny/ask 목록은
add-only(INV-5)이며 여기엔 **하네스 자기보호**(검증 파일·비밀키에 대한 Bash 쓰기를 ask로 게이트 —
invariant-guard의 Edit|Write 후킹을 우회하는 경로 차단)가 포함된다.
**단 자기보호의 수단은 F65에서 갈렸다** — 되돌릴 수 없는 것만 예측으로 막고, 되돌릴 수 있는
검증 파일 변경은 사후 탐지·복구가 담당한다(INV-14). default-allow 확장·위험정의
완화는 사람이 검토(critical 티어)하고, 위험 명령이 allow로 새지 않음은 `tests/pre-bash-firewall.bats`의
회귀 배터리(rm·sudo·terraform destroy·kubectl delete·git reset --hard 등이 output에
`permissionDecision:"allow"` 미포함, 하네스 검증파일 쓰기는 `ask`)가 고정한다. → [ADR-004](DECISIONS/ADR-004-firewall-auto-allow.md)

### INV-10. 도구 방화벽 allow 계층은 add-only (확장 불가)
`hooks/pre-tool-firewall.sh`(Bash 외 도구의 크로스도구 권한 계층, [ADR-005](DECISIONS/ADR-005-cross-tool-permission-tier.md))의
**auto-allow를 넓히는 편집은 차단된다** — Bash 방화벽의 deny/ask add-only(INV-5)와 대칭이다.
`invariant-guard.sh`가 Edit|Write|MultiEdit 시점에 결정론적으로 집행한다:
- **`emit_allow` 방출 지점 수 증가** 차단 (기본 fall-through를 `emit_allow`로 바꾸는 default-allow 플립·allow 브랜치 추가 방어)
- **read-verb 화이트리스트에 write-verb**(create·update·delete·send·upload·exec·run 등) **유입** 차단 (MCP write auto-allow 방어)
- **읽기전용 빌트인 목록에 변형 도구**(Edit·Write·MultiEdit·NotebookEdit·Task·file_upload) **유입** 차단

**왜 불변**: 도구(특히 MCP)는 한 번의 호출이 곧 액션(메일 전송·삭제·업로드)이라, allowlist를 넓히면 위험 도구가 무프롬프트로 실행된다. Bash 방화벽만 보호하고 도구 방화벽을 방치하면 자기보호가 비대칭이 된다. 축소(화이트리스트 verb 제거)는 강화이므로 자유.
**알려진 한계**: read-verb 라인을 여러 줄로 분할하는 등 정교한 재구성 우회는 라인 기반 검사로 못 잡는다 — 위 위협 모델(speed-bump)과 동일하며 behavioral 프로브·코드 리뷰가 2차 방어선이다.

### INV-11. passes 전환은 evaluator-feedback 근거 필수 (기계 검증)
`progress/feature_list.json`에서 어떤 feature의 `passes`를 `false→true`로 바꾸는 편집
(신규·중복 id로 `passes:true`를 끼워 넣는 것 포함)은, 해당 id를 평가한 **최신
evaluator-feedback 레코드**가 다음을 만족할 때만 통과한다 — `invariant-guard.sh`가
Edit|Write|MultiEdit 시점에 결정론적으로 재검증한다:
- 레코드가 존재하고(`progress/agent-comms/evaluator-feedback-*.json`, archive 제외) `verdict`가 pass
- 5차원 점수(`functionality`·`code_quality`·`security`·`error_handling`·`test_coverage`)가 완비되고
  **min-of-5 ≥ `pass_threshold`** (INV-2의 산술을 기계 재검증)
- `security_tier: critical`이면 **`scores.security` ≥ `security_thresholds.critical`** (INV-4의 기계 재검증)
- **evaluator 실행 기록(F54)**: 위 feedback 검증에 더해, SubagentStop 훅
  (`hooks/subagent-evaluator-log.sh`, matcher `^cc-harness:evaluator$`)이 캡처한 evaluator 실행 로그
  (`progress/agent-comms/evaluator-runs.jsonl`)에 **최근(≤48h, 시간창) 실행 기록이 하나 이상** 있어야 한다.
  SubagentStop은 Claude Code가 실행하므로 메인 루프가 발화 자체를 위조할 수 없다 — feedback JSON만 작성하고
  evaluator를 실제로 돌리지 않은 경로를 차단한다. 시간창은 신뢰 가능한 벽시계(NOW)와 훅이 기록한 정수 `epoch`로
  판정한다 — 논리적·반올림된 feedback 파일명 타임스탬프(예: `T14-00-00`, 수동 지정)와 직접 순서 비교하면
  flaky하므로 쓰지 않는다. 이 로그는 `is_protected()`로 append-only 보호된다(기존 라인 사후 삭제·변조 차단).

`progress/contracts/sprint-*.json`의 `agreed:false→true` 전환도 비어있지 않은
`acceptance_criteria`·`implementation_steps`를 전제한다(Plan 산출물 없는 합의 금지).
`passes:true→false` 리셋은 약화가 아니므로 항상 허용. `templates/`는 스캐폴딩이므로 제외.
**왜 불변**: INV-1/2/4는 이 불변식 이전까지 프롬프트 관례로만 집행됐다 — "결정론적 도구 >
프롬프트" 원칙의 코어 루프 적용. 가드는 evaluator를 **대체하지 않는다** — 판정의 존재와
산술만 재검증하며, 판정 내용의 생성은 여전히 독립 evaluator의 전권이다.
delete-then-recreate(파일 삭제 후 `passes:true`로 재생성)로 primary 가드를 우회하는 경로는
막는다 — feature_list.json은 파일 부재 시에도 신규 생성 면제에서 제외되어, 없는 파일에 대한
`passes:true` Write도 근거를 요구한다. 문자열 타입 점수(`"3"`)로 min-of-5를 가리는 우회도
타입 검사로 fail-closed한다.
**알려진 한계(정직히)**: F54가 위조 난이도를 '가짜 feedback 파일 1개 작성'에서 '최근 evaluator 실행이
SubagentStop 훅에 캡처됨'으로 올렸지만 **완전 차단은 아니다**(self-referential 한계 — 검증 장치의 상태도
결국 파일이다). evaluator-runs.jsonl도 파일이라, 위조자가 (a) 실제로 evaluator를 최근 돌렸거나(그러면
위조할 이유가 없다) (b) 실행 로그에 그럴듯한 `epoch` 레코드를 직접 append하면 시간창 검사를 통과할 수 있다.
(b)는 append-only 보호(기존 라인 사후 변조·삭제 차단)와 Bash firewall ASK(`progress/` 쓰기 게이트)가
speed-bump로 막지만 append 자체를 원천 봉쇄하지는 못한다. 또한 시간창 검사는 per-feature 정밀 대응이
아니다 — 같은 창(≤48h) 안의 정당한 evaluator 실행 1건이 다른 전환도 만족시킨다. 목표는 '완전 방지'가
아니라 '위조 난이도 상향'이다(F38 과대주장 정정 교훈). Bash로 feature_list.json을 직접 쓰는 우회는
firewall ASK(basename 앵커 — `progress//`·`cd progress` 등 경로정규화 변종 포함)가 게이트하고,
behavioral 프로브 코퍼스가 이 부류의 누출을 감시한다.

### INV-12. 검증 장치·critical 후보는 무인 실행 불가
`/improve --auto`(무인 배치 자기개선 루프, [ADR-006](DECISIONS/ADR-006-batch-approval-autonomy.md))는
저위험 후보만 무인 처리한다. 다음 대상 후보는 **무인으로 절대 처리하지 않고** 반드시 사람 승인을
거친다(`progress/approval-queue.json`에 적립):
- 검증 장치 파일: `harness-config.json`·`hooks/pre-bash-firewall.sh`·`hooks/pre-tool-firewall.sh`·
  `hooks/invariant-guard.sh`·`docs/INVARIANTS.md`·`hooks/hooks.json`·`agents/evaluator.md`·`feature_list.json`·
  `evaluator-runs.jsonl`·`tests/*.bats`·`skills/change-request/SKILL.md`·`skills/improve/SKILL.md`·`skills/hotfix/SKILL.md`·
  `hooks/protected-integrity.sh`·`.guarded-edits`·`.integrity-baseline`·`approval-queue.json`·`hooks/*.sh`
  (F67이 `hooks/*.sh` 를 추가 — 방화벽 면제 arm 이 훅 스크립트 전체를 덮는데 탐지 대상은 셋뿐이라
  여덟이 예측도 탐지도 없이 남아 있었다. 두 목록을 함께 넓혀야 한다: 한쪽만이면 티켓 미발급으로
  정당한 편집이 되돌려진다(F65 회귀).)
  (F68이 `approval-queue.json`을 추가 — 무인 루프가 자기 승인 범위를 넓히지 못하게 하는 자리다.
  이 파일을 고칠 수 있으면 "무엇이 무인 제외인가"를 루프가 스스로 다시 쓸 수 있다.)
  (뒤 셋은 F65가 추가 — 탐지기 자신과 그 상태 파일이다. 파괴되면 자기를 복구할 수 없으므로
  데이터 플레인이 아니라 컨트롤 플레인이며, 상태 파일은 도구 경로 쓰기를 전면 차단한다. INV-14 참조.)
- `security_tier: critical`인 모든 후보

**승인된 범위 안에서의 예외 (F68)**: 위 금지는 **후보를 자동 선정하는** 루프(`/improve --auto`)에
적용된다. 대상이 배치 게이트에서 **명시 승인**된 경우(`/implement --auto`·`/change-request --auto` —
사람이 feature 하나를 보고 범위·회전수·fail 정책·중단조건을 승인한다)는 다르다: **승인된 범위
안에서만** critical도 무인으로 진행할 수 있다. 승인 범위 밖의 검증 장치 파일을 건드리면 무인이
중단되고 `progress/approval-queue.json`에 적립된다.

**승인 범위에 넣을 수 없는 것**: `tests/*.bats`는 명시 승인이어도 무인 편집 대상이 아니다 — 아래에서
못박듯 count 기반 검사는 `@test` 본문의 `skip` 주입을 잡지 못하므로, 범위에 넣으면 그 제외 근거가
그대로 무력해진다(F68 1차 판정 지적). 예외는 "무인 금지 목록에서 빼는 것"이 아니라 "명시 승인된
대상에 한해 진행을 허용하는 것"이며, 이 파일 계열은 그 허용에서도 빠진다.

두 경로를 가르는 기준은 위험도가 아니라 **사람이 무엇을 보고 승인했는가**다. 자동 선정은 사람이
대상을 보지 못한 채 루프가 고르므로 critical을 열 수 없고, 명시 승인은 그 대상 하나에 대해 사람이
범위를 확정했으므로 열 수 있다.

무엇이 바뀌지 않는가: **게이트는 매 회전 그대로다**(독립 evaluator min-of-5 · invariant-guard ·
bats · Stop 게이트). 배치화는 **승인 지점의 이동**이지 검증 강도의 변경이 아니다. 승인 범위에
대해 코드가 실제로 주는 것은 아래 하나이며, **완전한 차단이 아니다** — 아래 "알려진 한계"가
그 경계다(F37 6차 판정: 절대문으로 열어 놓고 몇 줄 뒤에 철회하면 앞 문장만 읽는 독자가 생긴다):
- 배치 승인 기록(`_batch_approval`)은 **단일 쓰기로 교체할 수 없다** — `agreed:true`를 유지한 채
  변경하는 것, `agreed`를 내리며 들고 가는 것, 커밋된 값과 다른 값으로 덮는 것이 모두 차단된다.
  최초 발행은 통과한다(배치 게이트의 정상 산출이다).

  **그러나 완전한 차단이 아니다.** 리셋 → 커밋 → 재발행 순서로 오면 각 쓰기가 정상 절차와
  구분되지 않는다(F37 4차 판정이 종단 재현으로 실증했다). 게다가 그 중간 커밋은 공격 수단이
  아니라 `/change-request` Step 6이 지시하는 정상 흐름이다. 이 축에서 네 번 연속 반증됐고
  매번 직전이 지목한 순서만 닫혔다 — 근본 원인은 승인의 증거가 **계약 파일과 git 히스토리 안에만**
  있다는 것이다. 둘 다 루프의 권한 안이므로 어떤 기준점을 잡아도 루프가 그것을 움직인다.
  위조 불가능한 통제는 **ExitPlanMode 실행 이력 대조**뿐이며(F54가 `passes`에 건 것과 같은 계열),
  새 훅이 필요해 F69로 분리했다. 그때까지 이 항목이 주는 것은 차단이 아니라 **단일 쓰기 차단과
  감사 가능성**이다. (계약의 다른 필드는 설계상 편집된다 — 이 불변은 `is_protected()`가 아니라
  `invariant-guard.sh`의 전용 분기가 강제한다. `is_protected()`는 쓰기 금지가 아니라 fail-closed
  판정·티켓 발급의 **대상 집합**이며, 이 둘을 혼동한 것이 F68 1차 판정의 반려 사유였다.)
- `approval-queue.json`은 **append-only**다. 적립은 통과하고(그것이 중단 경로 자체다) 삭제·비우기·
  기존 항목 변조·재정렬은 차단된다. 판정은 접두 일치로 하므로 "2건 지우고 2건 넣기"처럼 길이가
  같은 치환도 잡힌다.

**알려진 한계** (F37 2·4·5차 판정이 실측한 것을 포함한다):
- **히스토리를 접으면 승인 기록이 저장소에서 사라진다.** `git reset --soft <base>` + commit(또는
  `--amend`)으로 발행 커밋을 접으면 `git log -p`·`git log --all` 어디에도 승인 범위가 남지 않는다.
  세 명령 모두 firewall `allow` 다. 따라서 "재발행은 감사에 남는다"는 **성립하지 않는다** — 5차
  판정이 이 문장을 반증했고 기준에서 내렸다.
- **`git ls-files` 가 비면 HEAD 대조 자체를 건너뛴다.** `git rm --cached <계약>` 후 두 번 쓰면
  커밋 0회로 재발행된다. `git rm --cached` 가 firewall `ask` 라 마찰이 있을 뿐 차단은 아니다.
- **고정되는 것은 `_batch_approval` 하나뿐이다.** 같은 계약의 `acceptance_criteria`·
  `security_criteria`·`security_tier` 는 `agreed:true` 상태에서도 단일 쓰기로 교체된다 — 기준을
  다시 쓰는 것은 범위를 넓히는 것보다 **더 직접적인 자기확장**이다.
- **신규 계약**을 처음부터 `agreed:true`와 넓은 범위로 만드는 경로는 INV-11의 구조 검사만 거친다.
  실제 승인 이벤트(ExitPlanMode)는 위조할 수 없으나 그 기록은 위조 가능하므로, "사람이 이 범위를
  봤다"를 사후에 기계로 확인하지는 못한다.
- **`scope` 의 내용은 검사되지 않는다.** 위에서 `tests/*.bats` 를 승인 범위에서 제외한다고 적었으나
  그것을 강제하는 코드는 없다 — 산문 규정이다. 배치 루프가 그 값을 읽고 스스로 지켜야 한다.
- **미커밋 적립은 `git checkout --` 로 흔적 없이 사라진다.** 큐는 "증가만 하는" 파일인데 탐지기의
  회복 모델은 "HEAD == 진실"을 전제하므로, 되돌림이 보호가 아니라 파괴로 작동하는 유일한 보호
  파일이다. 세 계층(firewall·invariant-guard·protected-integrity) 모두 무출력으로 통과한다.

위 항목들은 INV-11이 이미 문서화한 "완전 방지가 아니라 위조 난이도 상향" 계열이다. F54가 `passes`
전환에 건 실행 이력 대조를 `agreed` 전환에 적용하고, 큐를 커밋 시점이 아니라 적립 시점에 고정하는
것이 다음 단계다.

이 목록은 `invariant-guard.sh`의 `is_protected()`(F41) 집합과 정합해야 한다 — 어느 한쪽에만 있는 파일은
무인 루프가 게이트를 약화시킬 비대칭 경로가 된다. 이 정합은 프롬프트 관례가 아니라 **기계 검증된다**:
`tests/invariant-guard.bats`의 양방향 대칭 테스트(F45)가 (a) 이 bullet의 각 검증장치 파일이 `is_protected()`에서
차단되는지, (b) `is_protected()`의 각 arm이 여기 문서화됐는지를 파싱 대조해 — 어느 목록에 파일을 추가하든
비대칭이면 CI가 실패한다. (F45가 실제로 잡은 사례: `agents/evaluator.md`가 이 목록엔 있으나 `is_protected()`엔
없어 jq 부재 시 채점 기준 편집이 fail-closed로 차단되지 않던 갭 — 수정되어 대칭 성립.) 특히 `tests/*.bats`는 test_coverage 채점 근거이자
INV-6(add-only) 대상인데, count 기반 검사만으로는 `@test` 본문에 `skip`을 주입하는 약화를 못 잡으므로
무인 처리에서 반드시 제외한다. (`contracts/sprint-*.json`은 예외 — 루프가 매 회전 계약을 작성·합의해야 하고
INV-11이 빈 계약 합의를 막으므로 무인 대상이다.)

(F48이 추가한 사례: `skills/change-request/SKILL.md`·`skills/improve/SKILL.md`·`skills/hotfix/SKILL.md`의
'적용 조건' 문구가 F48 이전에는 evaluator 실행 여부에 영향을 주지 않았으나, F48의 자동 티어 라우팅부터는
이 문구가 evaluator 생략 여부를 직접 결정한다 — `agents/evaluator.md`와 동일한 성격의 자기약화 사각지대라
같은 방식(fail-closed 전용, 내용 diff 기반 능동 약화 탐지는 없음)으로 편입했다. **알려진 한계**: 대칭(b)
테스트의 arm 추출 정규식은 경로 구분자(`/`)를 인식하지 못해 이 3개 파일이 모두 `SKILL.md`라는 동일 토큰으로
축약 매칭된다 — (b) 방향은 "SKILL.md라는 이름의 무언가가 여기 문서화됐는지"만 약하게 검증하며 3개 전부가
개별 문서화됐는지는 보장하지 않는다. 보안상 중요한 (a) 방향(문서화된 파일이 실제로 `is_protected()`에서
차단되는지)은 백틱 토큰 단위로 3개를 정밀 개별 검증하므로 온전하다.)

(F60이 닫은 우회: 위 세 스킬의 보호는 F48 시점에 **파일 경로 리터럴**이었다. 스킬을 여러 파일로 분할해
배치 승인 조건이나 무인 제외 규칙을 하위 파일로 옮기면 그 내용이 보호 밖으로 나가, 게이트 임계값을 낮추는
대신 **게이트 정의의 위치를 옮기는** 우회가 성립했다. 결과는 같다 — 무인 루프가 자기 중단 조건을 편집할 수
있게 된다. F58의 착수 전 제약 조사에서 발견됐고 그때는 해당 스킬을 분할하지 않는 것으로 회피했으나,
금지가 계약 산문에만 있어 기계적 강제가 없었다. F60은 세 스킬을 **디렉터리 단위**로 보호해 하위 파일과
중첩 경로까지 커버한다. 기존 파일 경로 arm은 지우지 않고 남겼다 — 대칭(b)의 arm 추출이 확장자로 끝나는
토큰만 인식하므로 글롭으로 교체했다면 그 arm들이 추출 대상에서 빠져 대칭 검증 커버리지가 조용히 줄었을
것이다. 교체가 아니라 추가이며, 위 bullet의 백틱 토큰 목록은 그대로 유효하다. **남는 한계**: 경로 기반
보호이므로 게이트 정의를 이 세 디렉터리 **밖**으로 옮기는 우회는 여전히 막지 못한다 — 그것은 경로 목록을
늘려서는 닫을 수 없고 내용 기반 판단이 필요하다.)

**왜 불변**: 무인 루프의 근본 위험은 자동화가 검증 장치 자체를 약화시키는 것이다(F12/INVARIANTS 위협 모델의
핵심). 자율성은 게이트·임계값·denylist를 **건드리지 않는** 개선에만 부여되고, 그 경계를 넘는 변경은 언제나
사람을 거친다. 무인 모드가 우회하는 것은 "후보 선택의 사람 개입"뿐이며, 검증 게이트(invariant-guard·bats·
evaluator min-of-5·Stop)는 매 회전 무약화로 유지된다. F35(INV-11)가 선행 전제다 — passes 전환이 기계
검증되지 않으면 무인 루프는 금지된다.

### INV-13. 설치 경로 간 훅 배선은 대칭이다
cc-harness는 설치 경로가 둘이고 각자 다른 파일로 훅을 배선한다 — 플러그인 경로는 `hooks/hooks.json`,
`init.sh` 경로는 루트 `settings.json`(→ `.claude/settings.json`으로 설치, `init.sh:612`). **두 배선의
훅 스크립트 집합은 대칭이어야 하며**, 어느 한쪽에서 스크립트를 제거하는 편집은 차단된다.

비대칭은 곧 "한쪽 경로로 설치한 사용자만 게이트 없이 동작"을 뜻한다. F52가 발견한 실제 상태가 그랬다:
`invariant-guard.sh`와 `pre-tool-firewall.sh`가 `settings.json`에 배선되지 않아, `init.sh` 경로로 설치한
프로젝트는 **INV-1~INV-12가 전부 미집행**이었다. `init.sh:602-609`가 스크립트를 복사는 하므로 파일은
존재했고, 그래서 dead file로 오래 눈에 띄지 않았다.

**집행**: `tests/hook-wiring-parity.bats`가 두 배선 파일에서 스크립트 basename 집합을 추출해 양방향
대조한다(F45가 `is_protected()`↔INV-12에 쓴 파싱 대조 패턴과 동형). 의도적 제외는 **사유가 달린
allowlist**로만 허용해 '조용한 누락'과 구분한다 — 현재 유일한 항목은 `setup-claudemd.sh`(플러그인
SessionStart 전용, 프로젝트로 복사하면 `CLAUDE_PLUGIN_ROOT`가 `.claude`를 가리켜 자기 설치를 지우는
self-wipe 위험, `init.sh:278,604`). 더해 `invariant-guard.sh`의 `settings.json` 브랜치가 배선 축소를
런타임에 차단한다.

**설계 — 전면 차단이 아니라 약화 탐지**: `settings.json`은 `is_protected()`에 넣지 **않는다**. 이 파일은
훅 배선 외에 `env`·`permissions`·`enabledPlugins` 등 사용자의 정당한 설정도 담으므로, 전면 차단은
설치된 프로젝트에서 마찰이 과도하다. 대신 기존 배선이 신규 내용에 보존되지 않을 때만 deny한다
(`harness-config.json` 임계값 비교·`invariant-guard.sh` 30% 축소 검사가 쓰는 '약화 탐지' 패턴과 동일).

비교 단위는 **(event, matcher, 훅 오브젝트 전문)** 이며, 추출은 `.hooks` 하위만 순회하는 **구조
앵커**로 한다. 접근은 **default-deny**다 — OLD의 각 훅 오브젝트가 NEW에 정규화(jq -S) 동일하게
보존될 때만 통과한다:

- **오브젝트 전문(정규화 JSON) 비교** — 훅 오브젝트에는 `command` 외에 실행을 좌우하는 필드가 많다
  (공식 스키마: `type`·`if`·`once`·`async`·`asyncRewake`·`shell`·`args`·`timeout` 등 24개). 그중
  일부만 비교하면 비교되지 않는 형제 필드를 변조해 훅을 죽이면서 추출값을 유지할 수 있다. 그래서 필드를
  열거하지 않고 **오브젝트 전체**를 비교한다 — 어떤 필드를 추가·변조·삭제하든 정규화 문자열이 달라져
  deny되며, 스키마에 아직 없는 미래 벤더 필드까지 자동으로 default-deny다. allowlist(차이 허용 필드
  나열)는 두지 않는다 — 그 자체가 "빠뜨린 필드"라는 새 우회 표면이 된다. `timeout` 증가처럼 무해한
  편집이 막히면 사람이 직접 승인하면 된다.
- **구조 앵커** — `.. | objects`처럼 임의 위치를 훑으면 `hooks` 키를 `disabled_hooks`로 통째 옮겨도
  (훅은 죽고 오브젝트만 남음) 통과한다.
- **matcher의 포함관계(동일성 아님)** — `matcher`를 어떤 도구에도 매치하지 않는 값으로 바꾸면 이름이
  남아도 훅은 영원히 발화하지 않으므로 축소·무력화는 막아야 한다. 반면 `|NotebookEdit` 추가나 `matcher`
  삭제(=전체매치)처럼 **넓히는** 편집은 보호 강화이므로 허용한다 — 동일성을 요구하면 정당한 강화까지
  막는 과잉 차단이 된다.

여기에 **문서 레벨 도달성**을 더한다: 훅이 실제로 발화하려면 (배선됨) AND (최상위 스위치가 죽이지
않음)이어야 한다. 오브젝트를 아무리 정밀 비교해도 `disableAllHooks: true` 같은 **최상위 boolean**은
오브젝트 바깥이라 안 걸린다 — 이 하나로 invariant-guard 자신을 포함한 전 훅이 죽는다. 그래서 OLD에
배선이 있었으면, 그 배선을 통째로 죽이는 최상위 스위치(`disableAllHooks`·`allowManagedHooksOnly`)를
off/부재 → on 으로 켜는 편집도 차단한다. 이 스위치 목록은 하드코딩하되, 그 **완전성을 테스트가 공식
스키마와 대조**한다(`hook-wiring-parity.bats`) — 스키마에 새 hook-disabling boolean이 생기면 테스트가
실패해 등록을 강제한다. 목록을 사람이 열거하는 게 아니라 스키마가 정의하는 셈이라, 이 역시 인스턴스가
아니라 클래스를 겨냥한다.

요컨대 이 검사가 지키는 것은 이름의 존재가 아니라 **실행 도달성**이며 — 그것은 훅 오브젝트가 아니라
settings **문서 전체**의 속성이다. 집합 보존도, 오브젝트 보존도, 그 자체로는 실행 보장이 아니다.

이 정의는 **네 차례** 판정을 거쳐 도달했다. 1차가 (a)(b)(c) 세 인스턴스를 실증했고, 그것들만 닫은
수정을 2차가 `true # ` 접두로, 3차가 형제 필드(`if`·`once`·`async`·`type`)로, 4차가 최상위
`disableAllHooks`로 차례로 뚫었다. 매번 "재현된 사례를 인코딩한" 수정이었고, 잔존 우회는 매번 더
단순·치명적이었다(점수 7→6→5→4). **실증된 인스턴스를 하나씩 닫는 수정은 클래스를 닫지 못한다** —
안전장치를 고칠 때는 재현된 사례가 아니라 그 사례가 속한 클래스를 겨냥하고, 검증도 인스턴스 재현이
아니라 속성(오브젝트·문서 전 범위에 대한 스키마 구동 table-driven)으로 한다.

저장소 CI와 런타임 가드는 **같은 앵커 경로를 재사용**해야 한다 — 같은 불변식을 검사하는 추출기가 두
벌이고 강도가 다르면 약한 쪽이 실제 방어선이 되고, 설치된 프로젝트에는 CI가 없어 런타임 가드가 유일한
층이다.

면제되는 것은 애초에 훅을 배선하지 않는 settings 파일(예: `enabledPlugins`만 담은 것)뿐이다 — OLD
집합이 공집합이라 통과한다. **`.claude/settings.json`은 면제 대상이 아니다**: `init.sh`가 배선된
`settings.json`을 그대로 복사하므로 그 파일도 `hooks` 키를 가지며, 오히려 설치 프로젝트에서 실제로
동작하는 배선이라 가장 보호가 필요한 대상이다.

이 때문에 `is_protected()`와 별개로 `is_wiring_file()`을 둔다. 두 술어는 서로 다른 질문에 답한다 —
전자는 "편집 자체를 막아야 하는가"(전면 차단), 후자는 "도구 결핍 시 fail-closed여야 하는가". 내용 기반
검사는 jq/awk에 의존하므로 `is_wiring_file()`은 `has_jq`/`has_awk` 게이트에 **포함되어야** 한다.
포함하지 않으면 jq만 지워서 배선 검사를 통째로 우회할 수 있다(F41이 닫은 fail-open과 동형).
`is_protected()` 목록에는 넣지 않으므로 INV-12의 검증 장치 파일 목록도 변경하지 않으며, 따라서
F45의 양방향 대칭 테스트는 그대로 성립한다.

**왜 불변**: 게이트의 가치는 "실제로 실행되는가"에 달려 있다. 배선이 빠진 게이트는 코드가 온전해도
존재하지 않는 것과 같다 — INV-7(안전장치 자기 보호)이 스크립트 *내용*을 지킨다면, INV-13은 그 스크립트가
*실행되도록 등록되어 있음*을 지킨다. 두 축이 함께여야 자기보호가 닫힌다.

## 위협 모델 — 가드가 막는 것과 못 막는 것
invariant-guard.sh는 자기 자신도 프로젝트 워크트리의 **수정 가능한 파일**이다. 따라서
"파일에 임의 내용을 쓸 수 있는 행위자가 가드 소스 자체를 재작성하는 것"은 텍스트/구조 검사만으로
완전히 막을 수 없다 — 이는 버그가 아니라 근본적 한계다(self-referential 보호의 한계).

가드의 **실제 위협 모델**은 다음이다:
- **막는 대상**: 자동화된 `/improve` 루프나 부주의한 편집이 검증 장치를 **우연히/손쉽게** 약화시키는 것
  (임계값 하향·키 제거, deny 패턴 삭제, 테스트 삭제, 가드 등록 제거, 명백한 semantic gutting,
  그리고 **jq 삭제로 가드 전체를 무력화**하는 것 — jq 부재 시 보호 파일 편집은 fail-closed로 차단된다).
  이런 "쉬운 약화"를 막아 자동 루프가 게이트를 스스로 낮추지 못하게 한다.
- **막지 못하는 대상**: 가드의 검사 로직을 정확히 알고 우회하도록 **의도적으로 정교하게 조작된**
  가드 소스 재작성. 이에 대한 방어는 가드가 아니라 두 가지 외부 장치가 담당한다:
  1. **플러그인 캐시 분리**: 배포 환경에서 실행되는 가드는 `${CLAUDE_PLUGIN_ROOT}`(읽기 전용
     캐시)의 사본이다 — 프로젝트 워크트리의 `.claude/`나 hooks를 편집해도 **실행되는 가드는
     바뀌지 않는다**. cc-harness 자체 repo에서 개발할 때만 가드와 워크트리가 같다.
  2. **코드 리뷰 + CI**: 가드 소스 변경은 PR 리뷰와 bats/shellcheck CI를 거친다 — 무력화된
     테스트라도 pre-commit-gate/CI에서 실행되면 회귀가 드러난다(2차 방어선).

즉 가드는 **암호학적 통제가 아니라 자동화에 대한 speed bump**다. 사람이 의도적으로 기준을
조정해야 한다면 가드 안내에 따라 직접 편집/승인한다.

## 집행 방식
- `hooks/invariant-guard.sh` (PreToolUse: Edit|Write|MultiEdit)가 위 파일들에 대한 편집을
  가로채 old(디스크) vs new(제안) 비교로 위반을 감지하면 `exit 2`로 차단.
- 차단은 절대 금지가 아니라 **자동화 차단**이다 — 사람이 의도적으로 임계값을 조정하거나
  오래된 테스트를 정리해야 한다면, 가드 안내에 따라 직접 편집/승인할 수 있다.
- 가드는 `jq` 부재 시 **fail-closed**로 동작한다(구 fail-open에서 강화, sprint-27 F41).
  jq는 모든 기계 검증(INV-1~10)의 공통 의존이라 jq를 지우면 가드 전체가 무력화되는 **단일 실패점**이다 —
  안전장치는 결핍 시 통과가 아니라 **차단**이 캐논이다. 따라서 편집 대상이 **보호 파일**
  (`harness-config.json`·`pre-bash-firewall.sh`·`pre-tool-firewall.sh`·`invariant-guard.sh`·
  `INVARIANTS.md`·`hooks.json`·`feature_list.json`·`tests/*.bats`)이면, jq 없이 내용을
  검사할 수 없으므로 보수적으로 `exit 2`(차단)하고 jq 설치 또는 사람의 직접 편집/승인을 요구한다.
  비보호 파일은 기존대로 통과(가용성 유지)한다. 보호 파일 판정은 `is_protected()` 함수 하나로 정의해
  jq-존재 디스패치 브랜치와 **단일 출처**로 정합한다(하드코딩 중복 drift 방지). jq 존재 시 동작은 무변경.

## 변경 이력
- 2026-06-13: 최초 작성 (재귀적 자기개선 루프 안전장치, sprint-3 F12)
- 2026-07-04: INV-9 추가 (firewall allow 계층은 deny/ask 이후에만 평가, sprint-13 F27, v1.13.0)
- 2026-07-05: INV-10 추가 (도구 방화벽 pre-tool-firewall.sh allow 계층 add-only — Bash 방화벽과 자기보호 대칭, sprint-20 F34, v1.15.5)
- 2026-07-05: INV-9 갱신 (Layer 4 default-allow 전환 — 위험정의(deny+ask) 우선 모델. 하네스
  자기보호(검증파일·비밀키 Bash 쓰기 → ask)를 add-only로 편입, F27 후속 v1.13.1)
- 2026-07-05: INV-11 추가 (passes:false→true 전환은 evaluator-feedback 근거 기계 검증 —
  INV-1/2/4의 프롬프트 관례를 결정론적 집행으로 상향. contracts agreed 전환 구조 검증,
  firewall ASK에 feature_list.json 보호경로 + behavioral 코퍼스 확장, sprint-21 F35, v1.16.0)
- 2026-07-06: invariant-guard의 jq 부재 동작을 fail-open → **fail-closed**로 강화 (INV-7 자기보호
  연장 — jq 삭제라는 단일 실패점으로 가드를 무력화하는 것을 차단: 보호 파일 편집은 `exit 2`, 비보호는
  가용성 유지. 보호 목록은 `is_protected()` 단일 출처. CI에 probes/cost-report shellcheck + jq 설치
  검증 step 추가. sprint-27 F41)
- 2026-07-06: INV-12 추가 (무인 자기개선 루프 `/improve --auto`에서 검증 장치 파일·critical 후보는
  무인 실행 불가 — approval-queue.json 사람 승인 큐로 격리. 자율성은 게이트·임계값·denylist를 건드리지
  않는 저위험 개선에만. ADR-006, sprint-25 F39, v1.21.0)
- 2026-07-06: INV-12 갱신 (검증 장치 파일 목록에 `skills/change-request/SKILL.md`·
  `skills/improve/SKILL.md`·`skills/hotfix/SKILL.md` 추가 — 자동 티어 라우팅이 이 파일들의 조건
  문구를 evaluator 생략 여부의 결정 요인으로 만들어 생긴 사각지대를 `agents/evaluator.md`(F45)와
  동일한 fail-closed 전용 방식으로 봉합. `is_protected()`는 전체경로 매칭(basename 아님)이라 다른
  스킬의 SKILL.md는 비보호 유지. 대칭(b) 파서는 경로 구분자 미인식으로 3개 파일이 `SKILL.md` 토큰
  하나로 축약 매칭되는 알려진 한계 있음(문서화만, 파서 확장은 backlog). sprint-34 F48)
- 2026-07-20: INV-13 추가 (설치 경로 간 훅 배선 대칭 — `init.sh` 경로 `settings.json`에
  `invariant-guard.sh`·`pre-tool-firewall.sh`가 미배선이어서 그 경로로 설치한 프로젝트는 INV-1~INV-12가
  전부 미집행이었다. 배선 복원 + `is_wiring_file()` 신설(`is_protected()`와 분리 — 전면 차단이 아니라
  배선 축소만 탐지, `has_jq`/`has_awk` fail-closed 게이트에는 포함) + `tests/hook-wiring-parity.bats`
  양방향 대칭 회귀 테스트. sprint-38 F52)
- 2026-07-22: apply_replace() awk 구현 독립성 (INV-7 자기보호 연장) — `RS="\0"`로 파일 전체를
  1레코드로 읽는 방식이 awk 구현마다 다르다(gawk는 NUL 구분≈전체읽기, BSD one-true-awk는 `RS=""`
  문단 모드로 강등). BSD awk에서 빈 줄을 걸친 old_string이 매칭 실패해 편집 미반영(false-deny 및
  약화 편집 미탐지 false-allow)과 빈 줄 소실(실측 518→473줄)이 발생했다. **안전장치는 특정 awk 구현의
  시맨틱을 가정하지 않는다** — apply_replace를 RS 미사용 라인 버퍼 축적(`{buf=buf $0 ORS} END{index로
  치환}`)으로 재작성해 구현 독립성을 확보. F49(ENVIRON 이스케이프)·F50(실패 fail-closed)·F51(부재
  게이트)은 회귀 없이 보존. apply_replace의 네 번째 결함이며, 셋 다 리눅스 CI(gawk)에서만 검증되고
  기존 테스트가 전부 단일라인 old_string이라 놓쳤다 — 테스트에 빈 줄 픽스처를 잠가 다섯 번째를 막는다.
  sprint-39 F53)
- 2026-07-24: INV-11 강화 — evaluator 실행 기계 검증 (F54). SubagentStop 훅
  (`subagent-evaluator-log.sh`, matcher `^cc-harness:evaluator$`)이 evaluator 서브에이전트 종료를
  `evaluator-runs.jsonl`에 `{agent_id,timestamp,epoch,...}`로 캡처 — Claude Code가 실행하므로 메인 루프가
  위조 불가. INV-11이 passes 전환 시 **최근(≤48h, 시간창) 실행 기록**을 신뢰 벽시계 NOW와 정수 epoch로
  대조(논리적 feedback 타임스탬프 순서 비교는 flaky해 미채택). `evaluator-runs.jsonl`을 `is_protected()`+
  INV-12 목록에 대칭 편입하고 전용 append-only 브랜치(OLD가 NEW의 접두 보존 + 라인 수 비감소)로 사후
  변조 차단. 설치 경로 대칭(INV-13/F52)으로 `hooks.json`·`settings.json` 양쪽 배선. **한계 정직 명문화**:
  완전 방지 아님(self-referential) — 위조 로그 append는 speed-bump로만 막히고 시간창은 per-feature 정밀
  대응이 아니다. 목표는 '완전 차단'이 아니라 '위조 난이도 상향'(F38 과대주장 정정). sprint-40 F54)
- 2026-07-25: 빈 Write truncation 클래스 차단 (INV-7 연장, F54 judge2 A6 후속). `[[ -z "$NEW_CONTENT" ]]
  && exit 0` 단락이 개별 약화 검사(@test 수·임계값·firewall 패턴·실행기록·배선) 이전에 위치해,
  빈 내용 Write로 보호 파일을 통째로 비우면 그 파일의 검사를 통째로 우회할 수 있었다(evaluator-runs를
  비워 append-only를 우회하는 인스턴스로 발견, 하지만 .bats @test 전멸·harness-config 임계값 제거 등
  모든 보호 파일에 해당하는 **클래스**). 기존에 내용이 있던 보호/배선 파일(`is_protected || is_wiring_file`
  + `-s`)의 빈 Write는 truncation으로 차단한다 — 신규·이미 빈 파일은 파괴할 게 없어 통과. '실증된 인스턴스가
  아니라 클래스를 닫는다'는 F52 교훈의 적용. sprint-40 F54 follow-up)

### INV-14. 검증 장치는 예측이 아니라 탐지·복구로 지킨다 (F65)

`is_protected()`가 다루는 git 추적 파일(**데이터 플레인** — `tests/*.bats`·`harness-config.json`·
`INVARIANTS.md`·`feature_list.json`·`contracts/sprint-*.json`·`evaluator.md`·`skills/{change-request,improve,hotfix}/*`
및 이름으로 지정된 훅들)의
내용은 **HEAD와 같거나, 그 변경이 invariant-guard 심사를 거친 것**이어야 한다. Bash 경로로 생긴
그 밖의 변경은 `hooks/protected-integrity.sh`(PostToolUse:Bash)가 탐지해 HEAD 내용으로 되돌리고
보고한다.

**왜 바꿨나**: 이전 모델은 "이 Bash 명령이 보호 파일을 쓸 것인가"를 명령 문자열로 예측해 ask로
막았다. 그 질문은 결정 불가능하다 — 셸도, 셸이 부르는 sed·awk·perl·python도 튜링 완전하므로
실행하지 않고 효과를 알 수 없다. F63이 10회전 동안 그 방향을 시도했고 매 회전 새 우회 표기가
나왔다(붙여쓴 optarg · 중괄호 확장 · 명령 치환 · 프로세스 치환 · 인용 제거 미수행 · 이름 변형 ·
경로 표기). 예측이 불가능하니 알려진 형태를 나열할 수밖에 없었고, 그 나열이 곧 커버리지 상한이
되는 동시에 **읽기까지 잡아** 사용자가 보고한 반복 승인 프롬프트를 만들었다.
반면 "파일이 바뀌었는가"는 사후에 자명하게 결정되며 도구·표기와 무관하다 — 한 번도 본 적 없는
방법이라도 잡힌다.

**경계 — 예측이 계속 유일한 수단인 것**:
- **컨트롤 플레인**(`hooks/hooks.json`·`.claude/settings*.json`): 이 둘을 바꾸면 탐지 훅의 배선 자체를
  끌 수 있고, settings.json은 gitignore 대상이라 HEAD 복구도 불가능하다.
- **되돌릴 수 없는 것**(Layer 1·2의 파괴적 명령, 시크릿 외부 유출): 사후 복구가 성립하지 않는다.

**정직한 약화**: 데이터 플레인의 보장이 "Bash로 쓸 수 없다"에서 "Bash로 **지속적으로** 쓸 수 없다"로
바뀐다. 한 Bash 호출 안에서 변조와 소비가 함께 일어나면 복구는 그 뒤다. 하네스에서 임계값·훅을
소비하는 것은 다음 도구 호출이므로 실무 노출은 낮지만, 없는 위험이 아니다. 이 교환으로 얻는 것은
메커니즘 전수 커버리지와 마찰 제거다.

**어느 arm이 예측에서 빠졌나 (F67)**: 면제 대상 토큰은 `hooks/pre-bash-firewall.sh`의
`EXEMPTABLE_ARM_TOKENS` **한 곳에 열거된다** — 읽기 가능 도구(`sed`·`awk`·`mawk`)와
인터프리터(`python`·`node`·`ruby`·`perl`·`php`·`lua`) 둘이다. 넣는 기준은 하나다: **그 arm이
읽기를 잡는가.** 도구 이름만으로 판정하는 arm은 순수 읽기까지 ask로 만들고 그 판정을 구문으로
고칠 수 없다 — 인터프리터는 `-c` 뒤가 임의 프로그램이라 가르려면 대상 언어의 파서가 필요하다.
반대로 쓰기 신호가 명령에 드러나는 arm(리다이렉트 `>` · `cp`/`mv`/`tee` 이름 · in-place `-i` ·
`dd of=` · `sed w`)은 읽기를 잡지 않으므로 목록에 넣지 않는다 — 면제해도 마찰이 줄지 않고
손실 상한만 늘어난다.

토큰이 일치해도 면제되지 않는 것: 컨트롤 플레인 · 탐지기 자신 · 티켓 원장. 그래서 **arm은
평면을 섞지 않아야 한다** — 한 arm에 두 평면을 담으면 컨트롤 플레인 배제가 그 arm을 통째로
잡아 데이터 플레인 읽기까지 예측에 남는다(1차 판정이 실측했다: 면제가 `feature_list.json`
하나에만 닿고 `hooks/*.sh`·`harness-config.json` 인터프리터 읽기는 여전히 ask였다). 인터프리터
arm은 그래서 데이터 플레인용과 컨트롤 플레인용 둘로 나뉘어 있다.

**컨트롤 플레인은 인터프리터 읽기도 ask다.** 사후 복구가 없어 예측이 유일한 통제인데 인터프리터는
읽기임을 확정할 수 없기 때문이다. 같은 파일을 `sed -n` 으로 읽으면 allow인 것은 도구 이름 때문이
아니라 `-i` 부재로 **읽기가 확정되기** 때문이다 — 판정 근거는 도구가 아니라 확정 가능성이다.

F65는 인터프리터 arm을 보류하며 "읽기 마찰은 이 게이트가 지키는 값어치에 비해 싸다"고 적었는데,
실측이 그 전제를 무너뜨렸다. 이 arm은 (a) 순수 읽기를 잡고, (b) 개행으로 나눈 **무관한 두 명령**을
한 스팬으로 묶으며, (c) 같은 명령을 `;` 로 이으면 통과시켰다 — 표기 한 글자로 판정이 뒤집혀
**보호도 마찰도 실패하고 있었다.** 사후 탐지·복구는 세 결함을 모두 갖지 않는다. 그 대가로 위
"한 Bash 호출 안의 변조·소비 창"이 `sed`·`awk` 뿐 아니라 `python3 -c` 로도 열린다.

**개행 오인식은 알려진 갭이다 (F67)**: `[^;|&]*` 스팬은 개행을 명령 경계로 보지 않는다. 정규화가
개행을 공백으로 접기 때문이며, 그래서 무관한 두 명령이 한 스팬으로 묶이는 과탐이 남고 같은 명령을
`;` 로 이으면 빠져나간다.

**고치려다 되돌렸다.** F67이 개행을 `;` 로 바꿨더니 **컨트롤 플레인이 열렸다** — heredoc 본문의
개행이 구분자가 되어 스팬이 끊기고, `python3 - <<'EOF'` 안에서 `.claude/settings.json` 을 쓰는
명령이 ask에서 allow로 뒤집혔다(1차 판정이 격리 랩에서 파일 교체까지 실증). 그 경로는 gitignore
대상이라 사후 복구도 없다. 셸에서 개행이 구분자가 아닌 자리는 인용부호 안과 줄 이음만이 아니라
heredoc 본문·`|`/`&&` 뒤 줄바꿈·`(`/`{` 블록과 절 사이가 모두 해당하고, 전수를 맞추려면 셸 파서가
필요하다. 부분 구현은 매번 이런 구멍을 만든다. **그래서 갭으로 남긴다** — 스팬이 길게 유지되는
방향이므로 비용은 마찰이고 보호는 약해지지 않는다.

**복구는 작업을 파괴하지 않는다**: git 작업 진행 중(merge·rebase·cherry-pick·revert·bisect)에는 복구하지
않고 보고만 하며, 복구할 때는 되돌릴 내용을 `progress/.integrity-quarantine/<시각>/` 에 먼저 보관한다.
1차 판정이 무조건 복구가 `git stash pop` 으로 되살린 작업을 **비가역으로** 지우는 것을 실증했다 —
마찰을 없애려다 그보다 나쁜 해악을 만들 뻔했다.

**탐지기 자신은 데이터 플레인이 아니다**: 분류 축은 "되돌릴 수 있는가" 하나가 아니라 **"자기를 복구할
수 있는가"**까지다. `protected-integrity.sh`(파괴되면 자기를 복구할 수 없다)와 티켓 파일
`progress/.guarded-edits`(복구 여부의 근거)는 컨트롤 플레인이며 예측이 막는다. 파일을 바꾸지 않고
탐지를 실명시키는 git 메타 조작(`update-index --assume-unchanged|--skip-worktree`, `rm --cached`)도 같다.

**티켓은 내용에 묶이고 한 번만 쓰인다**: invariant-guard가 편집을 허용할 때 `<내용해시> <경로>` 를 남기고,
탐지기는 일치 시 그 줄을 소비하며 **소비 사실을 `progress/.integrity-restores` 에 기록한다**.
경로만 적으면 정당한 편집 한 번이 그 경로를 영구 면제로 만든다.

**티켓 파일에 대한 보장의 정확한 범위**: Edit/Write 경로는 invariant-guard가 **전면 차단**한다(상태 파일은
기계가 관리하므로 도구로 쓸 정당한 이유가 없다). Bash 경로는 basename 앵커로 게이트하므로 경로 표기를
바꾸는 우회(`cd progress && … >> .guarded-edits`·`progress//…`)는 잡히지만, **명령행에 경로가 나타나지 않는
형태**(`python3 script.py`)는 잡히지 않는다 — 예측의 원리적 한계다. 즉 티켓 파일은 셸을 쥔 상대에게
위조 불가능하지 않다. 남는 것은 소비 로그뿐이며, 이 층이 지키는 것은 실수와 지름길이지 결정적 공격자가 아니다.

**열거는 인덱스가 아니라 커밋 트리에서 한다**: `git ls-tree -r HEAD` 를 쓴다. `git ls-files` 는 인덱스를 읽으므로
인덱스를 건드리는 모든 명령이 탐지를 실명시킨다 — `update-index --assume-unchanged`·`--skip-worktree`·
`--force-remove`·`rm --cached`. 그 셋을 ASK 패턴으로 열거했더니 네 번째가 즉시 나왔다(2차 판정).
트리에서 열거하면 이 클래스가 통째로 닫힌다.

**두 집합은 같아야 한다**: `PROTECTED_GLOBS ≡ is_protected()`. 넓으면 편집 시 티켓이 발급되지 않는 파일이
복구 대상에 들어가 **정당한 편집이 되돌려지고**(실측: `hooks/lib.sh`), 좁으면 그 경로는 예측도 탐지도
없이 남는다.

**배선이 없으면 예측이 되살아난다**: 방화벽은 탐지 훅의 배선을 확인해 데이터 플레인 게이트를 끄고,
확인에 실패하면 켜진 상태로 남긴다(fail-safe). `tests/protected-integrity.bats`가 이 성질과
두 설치 경로(hooks.json·settings.json)의 배선 대칭(INV-13)을 함께 고정한다.
