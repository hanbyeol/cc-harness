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

## Security
- SQL: 반드시 parameterized query 사용 (`db.Query("... WHERE id = $1", id)`)
- 시크릿: `os.Getenv()` 사용, 하드코딩 금지
- 입력 검증: 외부 입력은 반드시 검증 후 사용 (길이, 형식, 범위)
- HTTP 응답: 내부 에러 메시지 노출 금지 (`err.Error()`를 직접 반환하지 않음)
- 의존성: `govulncheck ./...` 통과 필수
