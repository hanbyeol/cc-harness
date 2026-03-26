# General Rules
- 한국어 주석 OK, 코드·커밋 메시지는 영어
- PR 제목: `[component] description`
- main 직접 커밋 금지
- 공유 패키지 변경 시 의존 패키지 전체 테스트
- Breaking change 시 마이그레이션 가이드 필수 (PR 본문 또는 docs/DECISIONS/)
- Deprecated 코드: `// Deprecated: use X instead (removal: vN.M)` 주석 + 호출처 업데이트
- 환경 변수로 시크릿 관리 — 코드에 하드코딩 금지
- 에러 응답에 내부 스택 트레이스 노출 금지
