---
paths:
  - "apps/web/**/*.ts"
  - "apps/web/**/*.tsx"
---
# React/TypeScript Rules
- Strict TypeScript: no `any`, no `as` casting
- Named export, Props interface 같은 파일
- Custom hooks: use* 접두어, 별도 파일
- 테스트: Vitest + Testing Library
- 에러 바운더리: 주요 라우트에 ErrorBoundary 적용
- 로딩/에러/빈 상태: 모든 비동기 UI에 3가지 상태 처리

## Security
- XSS: `dangerouslySetInnerHTML` 사용 금지 (불가피 시 DOMPurify 적용)
- 사용자 입력: 렌더링 전 이스케이프 확인 (React 기본 이스케이프 외 URL/href 주의)
- 인증 토큰: localStorage 대신 httpOnly cookie 또는 메모리 저장
- API 호출: 인증 헤더는 중앙 interceptor에서 관리
- 민감 정보: 클라이언트 번들에 API key, secret 포함 금지
