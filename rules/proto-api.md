---
paths:
  - "proto/**/*.proto"
---
# Protocol Buffers Rules
- proto3 syntax
- 필드 번호 재사용 금지 (reserved 키워드로 보호 — 재사용 시 기존 클라이언트 데이터 손상)
- Breaking change → 새 버전(v2) 디렉토리 생성 (proto/v1/, proto/v2/ 구조)
- 변경 후 `make proto-gen` 필수
- buf lint 통과 필수
- 버전 간 하위 호환성: 최소 직전 2개 버전 지원
