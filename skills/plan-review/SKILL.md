---
name: plan-review
description: "terraform plan diff 리뷰 게이트 (iac 프로파일). TRIGGER: 사용자가 'plan 리뷰', 'terraform plan 확인', 'apply 전 검토', 'plan 봐줘', 'plan-review' 등 인프라 변경을 적용 전에 검증하려 하면 이 스킬 실행. SDLC의 evaluator를 대신하는 IaC 검증 게이트."
---
# /plan-review — terraform plan 리뷰 게이트

iac 프로파일의 핵심 검증 게이트. SDLC의 5차원 evaluator를 대신해 **`terraform plan` diff를
근거로** 인프라 변경을 apply 전에 검증한다. plan을 보지 않고 apply하지 않는다(INV-8).

## 사용법
```
/plan-review                # 현재 디렉토리/환경 plan 검토
/plan-review prod           # 특정 환경
```

## Process

### 1. plan 생성 + diff 검토
- `terraform plan -out=tfplan` 실행, `terraform show tfplan`로 diff 확인
- **의도와 일치하는가**: 추가/변경/삭제 리소스가 변경 요청과 부합하는지
- **예상치 못한 파괴 감지**: `replace`/`destroy`/`forces replacement`가 의도치 않게 있는지 —
  특히 RDS·state backend·DNS 같은 stateful/critical 리소스의 replace는 적신호
- 영향 환경(shared/dev/staging/prod)과 blast radius 명시

### 2. 정책 스캔
- `tflint` (구문·provider 규칙), `trivy config`(또는 tfsec/checkov, 있으면) — IaC 보안 정책
- 실패 시 게이트 fail — 수정 후 재실행

### 3. smoke-test (해당 시)
- 기존 smoke-test 스크립트(tests/smoke-test-*.sh)로 핵심 동작 확인
- DNS/네트워크/DB 등 변경이 실제 응답에 영향 없는지

### 4. apply 후 drift 확인
- apply 후 `terraform plan`이 **no-change(무drift)** 인지 — 적용이 실제 상태에 정확히 반영됐는지
- drift가 있으면 원인 추적(`/debug`) 후 재정렬

## 판정 (evaluator 대신)
게이트 통과 = (1)plan diff 의도 일치 + (2)정책 스캔 통과 + (3)smoke 통과 + (4)apply 후 무drift.
- **prod·critical**: 위 전부 + **Plan 게이트(ExitPlanMode) 사용자 승인 필수**. auto-approve 금지.
- **standard**: 게이트 통과 시 진행.
- **low**(읽기·태그): plan 확인만.

## Constraints
- plan 미확인 apply 금지 (INV-8)
- prod state 변경은 사용자 확인 없이 실행하지 않는다 — firewall이 destroy/auto-approve/state rm을 ask로 강제
- 변경을 작성한 주체가 스스로 "apply OK"를 판정하지 않는다 — 이 게이트와 Plan 게이트(사용자)가 승인
- plan-review 게이트의 통과 기준을 임의로 낮추지 않는다 (add-only, INV-8)
