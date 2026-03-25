---
paths:
  - "deploy/**/*.yaml"
  - "deploy/**/*.yml"
---
# Kubernetes Rules
- Kustomize overlay: base → dev/staging/prod
- Image tag: git SHA short
- SecurityContext: runAsNonRoot=true
- Resource limits 필수
- Secret: External Secrets Operator
