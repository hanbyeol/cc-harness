---
paths:
  - "apps/android/**/*.kt"
  - "apps/android/**/*.kts"
---
# Android/Kotlin Rules
- Kotlin-first, Java 금지 (레거시 제외)
- Jetpack Compose 우선
- DI: Hilt
- Coroutines + Flow
- ProGuard/R8 규칙 업데이트 확인

## Security
- 인증 토큰: EncryptedSharedPreferences 또는 Android Keystore
- 네트워크: Certificate Pinning 적용 (OkHttp CertificatePinner)
- 로컬 DB: SQLCipher 또는 Room + 암호화
- 로그: 릴리스 빌드에서 민감 정보 로깅 금지
- WebView: JavaScript 인터페이스 최소화, `setAllowFileAccess(false)`
