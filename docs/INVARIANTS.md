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
- **프로파일 전환으로 검증을 우회할 수 없다**: profile을 바꿔 더 약한 게이트로 도망가는 것은
  금지다. sdlc 프로파일의 pass_threshold·security_thresholds·evaluator 독립성은 프로파일과
  무관하게 불변이며, invariant-guard는 sdlc 임계값 하향을 계속 차단한다.

**왜 불변**: 프로파일이 "검증을 끄는 스위치"가 되면 라이프사이클을 바꿨다는 핑계로 모든 게이트를
무력화할 수 있다 — 프로파일은 *어떻게 검증하는가*를 바꿀 뿐 *검증하는가*를 바꾸지 않는다.

**알려진 한계** (backlog): @test **본문**에 `skip`/조기 return을 주입해 개수는 유지한 채
테스트를 무력화하는 경우는 개수 기반 검사로 잡지 못한다(정상 `skip "도구 없음"`과 구분
곤란). 이는 pre-commit-gate의 실제 테스트 실행이 2차 방어선이다 — 무력화된 테스트라도
CI/게이트에서 실행되면 회귀가 드러난다.

## 위협 모델 — 가드가 막는 것과 못 막는 것
invariant-guard.sh는 자기 자신도 프로젝트 워크트리의 **수정 가능한 파일**이다. 따라서
"파일에 임의 내용을 쓸 수 있는 행위자가 가드 소스 자체를 재작성하는 것"은 텍스트/구조 검사만으로
완전히 막을 수 없다 — 이는 버그가 아니라 근본적 한계다(self-referential 보호의 한계).

가드의 **실제 위협 모델**은 다음이다:
- **막는 대상**: 자동화된 `/improve` 루프나 부주의한 편집이 검증 장치를 **우연히/손쉽게** 약화시키는 것
  (임계값 하향·키 제거, deny 패턴 삭제, 테스트 삭제, 가드 등록 제거, 명백한 semantic gutting).
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
- 가드는 `jq` 부재 시 harness-config 수치 검사를 건너뛰고 경고만 출력한다(가용성 우선,
  firewall과 달리 보조 게이트이므로 fail-open). 그 외 패턴 검사는 jq 없이도 동작.

## 변경 이력
- 2026-06-13: 최초 작성 (재귀적 자기개선 루프 안전장치, sprint-3 F12)
