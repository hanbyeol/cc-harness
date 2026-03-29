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
- 테스트: JUnit 5 + Espresso (UI), MockK (단위), Turbine (Flow 테스트)
- ProGuard/R8: keep 규칙에 커스텀 콜백, 직렬화 클래스 포함, 난독화 빌드 테스트 필수

## Security
- 인증 토큰: EncryptedSharedPreferences 또는 Android Keystore
- 네트워크: Certificate Pinning 적용 (OkHttp CertificatePinner)
- 로컬 DB: SQLCipher 또는 Room + 암호화
- 로그: 릴리스 빌드에서 민감 정보 로깅 금지
- WebView: JavaScript 인터페이스 최소화, `setAllowFileAccess(false)`
- 입력 검증: Intent extra, deep link parameter 검증 필수
- 의존성: `./gradlew dependencyUpdates`로 취약 라이브러리 확인
