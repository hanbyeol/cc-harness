---
paths:
  - "apps/mobile/**/*.ts"
  - "apps/mobile/**/*.tsx"
  - "apps/rn/**/*.ts"
  - "apps/rn/**/*.tsx"
---
# React Native Rules
- Strict TypeScript: no `any`, no `as` casting
- 네비게이션: React Navigation (type-safe routes)
- 상태 관리: Zustand 또는 TanStack Query (API 캐싱)
- 스타일: StyleSheet.create() 사용, inline style 최소화
- 플랫폼 분기: `Platform.select()` 또는 `.ios.ts` / `.android.ts` 파일 분리
- 네이티브 모듈: Turbo Modules (New Architecture) 우선
- 테스트: Jest + React Native Testing Library

## Security
- 인증 토큰: react-native-keychain (Keychain/Keystore 기반 저장)
- 민감 데이터: AsyncStorage에 시크릿 저장 금지
- 네트워크: SSL Pinning 적용 (react-native-ssl-pinning)
- 딥링크: URL scheme 검증 필수 (악의적 딥링크 방어)
- 코드 난독화: Hermes 번들 + ProGuard (Android)
- JS 번들: 원격 코드 로딩 금지 (CodePush 사용 시 서명 검증)
