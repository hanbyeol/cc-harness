---
paths:
  - "proto/**/*.proto"
---
# Protocol Buffers Rules
- proto3 syntax
- 필드 번호 재사용 금지
- breaking change → 새 버전(v2) 생성
- 변경 후 `make proto-gen` 필수
