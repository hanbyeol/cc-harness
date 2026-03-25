---
paths:
  - "apps/ios/**/*.swift"
---
# iOS/Swift Rules
- SwiftUI 우선, UIKit은 레거시 호환 시만
- async/await 사용
- 인증 토큰: Keychain only (UserDefaults 금지)
- force unwrap 금지
- 네트워크: URLSession async/await
