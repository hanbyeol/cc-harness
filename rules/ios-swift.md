---
paths:
  - "apps/ios/**/*.swift"
---
# iOS/Swift Rules
- SwiftUI 우선, UIKit은 레거시 호환 시만
- async/await 사용
- force unwrap 금지 (init 또는 guaranteed non-nil 컨텍스트에서만 허용, guard let / ?? 우선)
- 네트워크: URLSession async/await
- 테스트: XCTest + XCUITest (UI), Swift Testing (단위)
- 패키지: SPM 사용 시 exact 또는 ~> 버전 제약 (wildcard * 금지)

## Security
- 인증 토큰: Keychain only (UserDefaults 금지)
- 토큰 갱신: 만료 전 자동 refresh 구현, 갱신 실패 시 재로그인 유도
- App Transport Security: 예외 도메인 최소화
- 민감 데이터: 스크린샷/앱 스위처에 마스킹 처리
- 로컬 저장: 민감 정보는 Keychain, 일반 데이터는 Core Data/SwiftData
- SQLite: parameterized query만 사용 (문자열 보간 금지)
- 입력 검증: URL scheme, Universal Link 파라미터 검증 필수
