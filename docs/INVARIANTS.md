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
invariant-guard의 Edit|Write 후킹을 우회하는 경로 차단)가 포함된다. default-allow 확장·위험정의
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
**알려진 한계**: 가짜 evaluator-feedback 파일을 Write로 위조한 뒤 passes를 뒤집는 경로는
텍스트 검사로 막을 수 없다(훅은 호출 주체를 구별하지 못한다) — 위조에는 그럴듯한 5차원
점수·verdict가 필요하므로 문턱은 높아지지만, 위협 모델상 speed-bump다. Bash로
feature_list.json을 직접 쓰는 우회는 firewall ASK(basename 앵커 — `progress//`·`cd progress`
등 경로정규화 변종 포함)가 게이트하고, behavioral 프로브 코퍼스가 이 부류의 누출을 감시한다.

### INV-12. 검증 장치·critical 후보는 무인 실행 불가
`/improve --auto`(무인 배치 자기개선 루프, [ADR-006](DECISIONS/ADR-006-batch-approval-autonomy.md))는
저위험 후보만 무인 처리한다. 다음 대상 후보는 **무인으로 절대 처리하지 않고** 반드시 사람 승인을
거친다(`progress/approval-queue.json`에 적립):
- 검증 장치 파일: `harness-config.json`·`hooks/pre-bash-firewall.sh`·`hooks/pre-tool-firewall.sh`·
  `hooks/invariant-guard.sh`·`docs/INVARIANTS.md`·`hooks/hooks.json`·`agents/evaluator.md`·`feature_list.json`
- `security_tier: critical`인 모든 후보

**왜 불변**: 무인 루프의 근본 위험은 자동화가 검증 장치 자체를 약화시키는 것이다(F12/INVARIANTS 위협 모델의
핵심). 자율성은 게이트·임계값·denylist를 **건드리지 않는** 개선에만 부여되고, 그 경계를 넘는 변경은 언제나
사람을 거친다. 무인 모드가 우회하는 것은 "후보 선택의 사람 개입"뿐이며, 검증 게이트(invariant-guard·bats·
evaluator min-of-5·Stop)는 매 회전 무약화로 유지된다. F35(INV-11)가 선행 전제다 — passes 전환이 기계
검증되지 않으면 무인 루프는 금지된다.

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
