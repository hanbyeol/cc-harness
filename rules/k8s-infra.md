---
paths:
  - "deploy/**/*.yaml"
  - "deploy/**/*.yml"
---
# Kubernetes Rules
- Kustomize overlay: base → dev/staging/prod
- Image tag: git SHA short
- SecurityContext: runAsNonRoot=true, readOnlyRootFilesystem=true
- Resource limits 필수 (requests + limits)
- Secret: External Secrets Operator (Secret 리소스 직접 생성 금지)

## Security
- RBAC: 최소 권한 원칙 — ClusterRole 대신 namespaced Role 우선
- NetworkPolicy: 기본 deny-all, 필요한 통신만 허용
- Pod Security Standards: restricted 프로필 적용
- 이미지: 신뢰할 수 있는 레지스트리만 허용, latest 태그 금지
- Secrets: etcd 암호화 활성화 확인, 환경변수 대신 volume mount 권장
