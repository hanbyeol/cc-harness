---
paths:
  - "services/legacy/**/*.java"
---
# Spring Boot Rules (Legacy)
- Constructor injection (field injection 금지)
- @Transactional은 서비스 레이어만
- 새 기능은 Go 마이그레이션 검토 우선
- 테스트: JUnit 5 + MockMvc (통합), Mockito (단위)
- 예외 처리: @ControllerAdvice 중앙 핸들러, 내부 스택 트레이스 노출 금지

## Security
- SQL: JPA parameterized query 또는 @Query에 named parameter만 사용 (문자열 연결 금지)
- 인증: Spring Security 필터 체인, 세션 고정 공격 방어 (sessionFixation.migrateSession)
- CSRF: 상태 변경 엔드포인트에 CSRF 토큰 적용
- 입력 검증: @Valid + Bean Validation (javax.validation), 커스텀 validator 필요 시 추가
- 의존성: `./mvnw dependency:tree` 또는 `./gradlew dependencies`로 취약점 확인
