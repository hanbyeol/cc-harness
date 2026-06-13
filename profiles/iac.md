# cc-harness — iac profile

## Priority
Correctness > Safety > Speed

## 라이프사이클 — IaC 프로비저닝 (plan → apply)
이 프로젝트는 **terraform 프로비저닝** 프로파일이다. SDLC의 spec→implement→evaluator가 아니라
**plan → 리뷰 → apply → state 확인** 루프를 따른다. terraform 코드와 `terraform plan`이 스펙이다 —
변경마다 SPEC.md/ARCHITECTURE.md/acceptance-criteria를 새로 쓰지 않는다.

### 변경 절차
1. **영향 분석 (blast radius)**: 변경이 건드리는 리소스·환경(shared/dev/staging/prod)·의존을 식별.
   prod·상태저장(RDS/state backend)·DNS는 security_tier critical.
2. **terraform 코드 작성/수정**: 해당 디렉토리 규칙(modules/environments) 준수.
3. **`/plan-review`**: `terraform plan` diff를 게이트로 검증 — (1)plan이 의도와 일치(예상치 못한
   replace/destroy 없음) (2)tflint/trivy(있으면 checkov) 통과 (3)smoke-test (4)apply 후 plan이
   no-change(무drift). **이것이 SDLC의 5차원 evaluator를 대신하는 iac 검증 게이트다.**
4. **Plan 게이트 — apply 승인**: 변경 요약 + plan diff + 영향 환경을 ExitPlanMode로 제시.
   **prod apply는 사용자 승인 필수** (auto-approve 금지).
5. **apply → state 확인**: 적용 후 `terraform plan`이 no-change인지, smoke-test 통과인지 확인.

### 검증 = 5차원 점수 아님
IaC 검증은 plan diff 일치 + 정책 스캔(tflint/trivy) + smoke-test + 무drift다.
"테스트 커버리지" 대신 "plan 일치·정책 통과·state 무drift"로 판정한다.

## Security & Safety by Design
- **security_tier**: prod·RDS·state backend·DNS = critical / 일반 인프라 = standard / 읽기·태그 = low
- **prod 파괴 차단**: `terraform destroy`·`apply -auto-approve`·`state rm/push`는 firewall이 ask로
  확인을 강제한다 — prod 강제 승인은 /plan-review·Plan 게이트가 담당.
- **plan 미확인 apply 금지**: plan을 보지 않고 apply하지 않는다(불변식 INV-8).
- 시크릿: 키 파일을 repo에 두지 않는다(SSO/단기 자격증명), .gitignore 확인.

## 요청 → 행동 라우팅 (iac)

| 사용자 의도 | 행동 |
|-------------|------|
| 인프라 변경(리소스 추가/수정/삭제) | → `/change-request` (영향분석) → terraform 작성 → `/plan-review` |
| plan 검토 / apply 전 확인 | → `/plan-review` 실행 |
| 원인 불명 인프라 이상/장애 | → `/debug` 실행 |
| 브랜치 마무리/PR | → `/finish-branch` 실행 |
| 하네스 자기개선 | → `/improve` 실행 |
| 진행 상태 확인 | → `/progress` 실행 |

## 검증 티어링 (iac)
- **low**(읽기·태그·문서) → 경량(plan 확인만)
- **standard** → /plan-review 게이트 (plan + 정책 + smoke)
- **critical**(prod·RDS·DNS·state) → /plan-review + **Plan 게이트 승인 필수** + apply 후 drift 확인.
  **critical은 절대 경량화 금지.**

## Generator-Reviewer 분리 (iac)
- 변경을 작성한 주체가 스스로 "apply OK"를 판정하지 않는다 — /plan-review 게이트와 Plan 게이트(사용자)가 승인한다.
- prod state를 바꾸는 명령은 사용자 확인 없이 실행하지 않는다.

## Skills
- `/plan-review` — terraform plan diff 리뷰 게이트 (정책·smoke·drift)
- `/change-request {설명}` — 변경 영향(blast radius) 분석
- `/debug [증상]` — 인프라 장애 4단계 근본원인
- `/finish-branch` — 브랜치 마무리: 테스트 → drift 확인 → PR/머지
- `/improve` — 하네스 자기개선 루프
- `/progress` · `/sync-docs`
