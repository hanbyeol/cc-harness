---
paths:
  - "apps/flutter/**/*.dart"
  - "lib/**/*.dart"
  - "packages/**/*.dart"
---
# Flutter/Dart Rules
- Dart 3+ null safety 필수
- 위젯: StatelessWidget 우선, StatefulWidget은 최소화
- 상태 관리: Riverpod 또는 Bloc (프로젝트 표준 따름)
- 라우팅: go_router (type-safe routes)
- 네트워크: dio + retrofit (interceptor 기반 인증)
- 코드 생성: freezed + json_serializable (불변 모델)
- 테스트: flutter_test + integration_test
- 린트: `flutter analyze` + custom analysis_options.yaml

## Security
- 인증 토큰: flutter_secure_storage (Keychain/Keystore 기반)
- 민감 데이터: SharedPreferences에 시크릿 저장 금지
- 네트워크: Certificate Pinning (dio CertificatePinner)
- 난독화: `flutter build --obfuscate --split-debug-info`
- 플랫폼 채널: MethodChannel 입력 검증 필수
- WebView: JavaScript 인터페이스 최소화, URL 화이트리스트
- 환경 설정: dart-define 또는 dotenv, 하드코딩 금지
