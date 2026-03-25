---
paths:
  - "services/**/*.go"
  - "packages/**/*.go"
  - "cmd/**/*.go"
  - "internal/**/*.go"
---
# Go Rules
- Error wrapping: `fmt.Errorf("[context]: %w", err)`
- context.Context는 첫 번째 파라미터
- Table-driven tests with t.Run()
- 구조화 로깅: slog 사용
- internal/ 패키지 경계 준수
- cmd/에는 main.go만, 비즈니스 로직 금지
- 신규 의존성 추가 시 `go mod tidy` 실행
