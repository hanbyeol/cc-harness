---
name: rollout
description: "라이브 k8s 변경 안전 루프 (ops 프로파일). TRIGGER: 사용자가 '롤아웃', '배포 변경', 'rollout', '스케일', '재시작', '이미지 업데이트', '조치해줘' 등 돌아가는 클러스터에 변경을 가하려 하면 이 스킬 실행. SDLC의 evaluator를 대신하는 ops 검증 게이트(health+회귀)."
---
# /rollout — 라이브 변경 안전 루프

ops 프로파일의 핵심 조치 게이트. 돌아가는 시스템에 변경을 **롤백 준비된 채로** 가하고
health로 검증한다. 변경을 작성한 주체가 스스로 "OK"를 판정하지 않는다 — Plan 게이트와 health가 승인한다.

## 사용법
```
/rollout                    # 현재 컨텍스트 변경
/rollout prod               # 특정 환경 (승인 필수)
```

## Process

### 1. 현 상태 관측 (조치 전 필수)
- `kubectl get/describe`로 대상 리소스의 현재 상태·replica·이미지·health 확인
- 이전 안정 버전(롤백 대상) 식별: 이미지 태그(git SHA), `kubectl rollout history`
- 영향 범위(blast radius): 네임스페이스·의존 서비스·트래픽 비중

### 2. 변경안 제시 + Plan 게이트
- 무엇을·어디에·왜 바꾸는지, 예상 영향, **롤백 방법**을 요약
- **prod·critical은 ExitPlanMode로 사용자 승인 필수** (auto-approve 금지)
- standard는 변경안 표시 후 진행

### 3. 롤백 준비 적용
- 적용 전 롤백 경로 확보 (이전 이미지 태그 보존, `kubectl rollout undo` 가능 상태 확인)
- 가능하면 점진 적용(canary/rolling) — deploy-operator 패턴 재사용
- `kubectl apply`/`helm upgrade`/`kubectl set image` 등으로 변경

### 4. health/회귀 검증 (evaluator 대신)
- 롤아웃 완료: `kubectl rollout status` 성공
- health: readiness/liveness 프로브 정상, Pod Running, 에러 로그 급증 없음
- 회귀: 기존 엔드포인트/기능 smoke 확인 (영향 서비스 포함)

### 5. 실패 시 자동 롤백
- 위 검증 실패 → **즉시 이전 안정 버전으로 롤백**(`kubectl rollout undo` / 이전 태그 재배포)
- 롤백 후 원인은 `/debug`로 추적 — 같은 변경을 무작정 재시도하지 않는다

## 판정 (evaluator 대신) — ops 게이트
조치 성공 = 롤아웃 status 성공 + readiness/liveness 정상 + 회귀 없음.
- **prod·critical**: 위 전부 + Plan 게이트 승인 + 롤백 준비 확인.
- **standard**: 게이트 통과 시 진행.

## Constraints
- 현 상태를 관측하지 않고 조치하지 않는다
- 모든 라이브 변경은 롤백 경로를 준비한다 (실패 시 즉시 복구)
- prod 라이브 변경은 사용자 확인 없이 실행하지 않는다 — firewall이 delete/scale 0/uninstall/undo/drain을 ask로 강제
- ops 게이트(health+회귀)의 통과 기준을 임의로 낮추지 않는다 (add-only, INV-8)
