# cc-harness — ops profile

## Priority
Correctness > Safety > Speed

## 라이프사이클 — Kubernetes 운영 (day-2 ops)
이 프로젝트는 **k8s 운영(day-2)** 프로파일이다. SDLC의 빌드도, IaC의 프로비저닝도 아니라
**라이브 시스템 운영**이다 — 루프는 **관측 → 진단 → 조치 → 검증**. 변경은 돌아가는 클러스터에
가해지므로 롤백 준비·blast radius·prod 보호가 핵심이다.

### 운영 루프
1. **관측 (observe)**: `kubectl get/describe/logs/events`, 메트릭/대시보드로 현재 상태를 본다.
   조치 전에 항상 desired state와 actual state의 차이를 확인한다.
2. **진단 (diagnose)**: 이상이면 **`/debug`**(재현→근본원인→최소수정→회귀)로 근본 원인을 찾는다.
   증상에 반응하지 말고 원인을 추적한다.
3. **조치 (remediate)**: **`/rollout`**으로 변경을 안전하게 적용 — 현 상태 관측 → Plan 게이트 승인
   → 롤백 준비 적용 → health 검증. prod는 사용자 승인 필수.
4. **검증 (verify)**: 롤아웃이 desired state에 도달했고, readiness/liveness가 정상이며, 기존 동작에
   회귀가 없는지 확인한다.

### 검증 게이트 = health + 회귀 (5차원 evaluator 아님)
ops 검증은 "테스트 커버리지"가 아니라 **롤아웃 성공 + readiness/liveness 정상 + 회귀 없음**이다.
이것이 SDLC의 독립 evaluator를 대신하는 ops 게이트다.

## Security & Safety by Design
- **security_tier**: prod 클러스터/네임스페이스·stateful 워크로드 = critical / 일반 워크로드 = standard / 읽기 = low
- **prod 파괴 차단**: `kubectl delete`·`scale --replicas=0`·`helm uninstall`·`rollout undo`·`drain`은
  firewall이 ask로 확인을 강제한다(`kubectl delete namespace/-A`는 deny). prod 강제 승인은 /rollout·Plan 게이트.
- **롤백 준비 필수**: 모든 라이브 변경은 이전 안정 버전으로 되돌릴 경로를 준비한다.
- **재사용**: rules/k8s-infra.md(RBAC 최소권한·NetworkPolicy deny-all·Pod Security restricted),
  deploy-operator(canary·blue-green·자동 롤백), Phase 6 관측성(메트릭·구조화 로깅·알럿·runbook).
- **runbook**: 장애 시나리오별 대응 절차를 `docs/runbooks/`에 둔다 — 인시던트 시 /debug·/rollout이 참조.

## 요청 → 행동 라우팅 (ops)

| 사용자 의도 | 행동 |
|-------------|------|
| 롤아웃/스케일/재시작/배포 변경 | → `/rollout` (관측→승인→롤백준비 적용→검증) |
| 원인 불명 장애/이상 동작 | → `/debug` (4단계 근본원인) |
| 운영 변경 영향 분석 | → `/change-request` (blast radius) |
| 브랜치 마무리/PR | → `/finish-branch` |
| 하네스 자기개선 | → `/improve` |
| 진행 상태 확인 | → `/progress` |

## 검증 티어링 (ops)
- **low**(읽기·조회) → 경량(관측만)
- **standard** → /rollout health 검증
- **critical**(prod·stateful) → /rollout + **Plan 게이트 승인 필수** + 롤백 준비 + health/회귀 검증.
  **critical은 절대 경량화 금지.**

## Generator-Reviewer 분리 (ops)
- 변경을 작성한 주체가 스스로 "조치 OK"를 판정하지 않는다 — Plan 게이트(사용자)와 health 검증이 승인.
- prod 라이브 변경은 사용자 확인 없이 실행하지 않는다 — firewall이 파괴적 kubectl/helm을 ask로 강제.

## Skills
- `/rollout` — 라이브 변경 안전 루프 (관측→승인→롤백준비 적용→health 검증→실패 시 자동 롤백)
- `/debug [증상]` — 인시던트 4단계 근본원인
- `/change-request {설명}` — 운영 변경 영향(blast radius) 분석
- `/finish-branch` · `/improve` · `/progress` · `/sync-docs`
