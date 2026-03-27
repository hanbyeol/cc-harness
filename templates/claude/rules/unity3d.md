---
paths:
  - "Assets/**/*.cs"
  - "Assets/**/*.shader"
  - "Packages/**/*.cs"
---
# Unity3D / C# Rules

## C# 코드 스타일
- C# 네이밍: PascalCase (클래스/메서드/프로퍼티), camelCase (로컬 변수/파라미터), `_camelCase` (private 필드)
- `var` 타입 추론 적극 활용 (단, 타입이 불명확할 때는 명시)
- nullable 허용 컨텍스트에서 null 체크 필수 (`?.`, `??` 활용)
- `async`/`await` 사용 시 `UniTask` 우선 (`Task` 사용 자제)

## Unity 아키텍처 원칙
- MonoBehaviour 의존성 최소화 — 게임 로직은 순수 C# 클래스로 분리
- ScriptableObject로 데이터 정의 (하드코딩 상수 금지)
- Scene 간 데이터 전달: ScriptableObject 이벤트 채널 또는 명시적 DI
- `GameObject.Find`, `FindObjectOfType` 런타임 호출 금지 — Inspector 주입 또는 서비스 로케이터 사용
- `Update()`에서 무거운 연산 금지 — 코루틴, Job System, Burst Compiler 활용

## 성능
- 가비지 생성 최소화: `StringBuilder`, 오브젝트 풀링, 구조체 활용
- `string` 비교 시 `StringComparison.Ordinal` 명시
- Physics: `RaycastNonAlloc`, `OverlapSphereNonAlloc` 등 NonAlloc 버전 우선
- 드로우 콜 최소화: 동적 배칭, GPU 인스턴싱, Atlas 텍스처
- `Camera.main` 매 프레임 호출 금지 — `Awake()`에서 캐싱

## 에디터 자동화 (MCP 연동)
- Unity MCP가 활성화된 경우 Unity Editor를 직접 제어할 수 있음:
  - GameObject 생성/수정, 컴포넌트 추가, 씬 저장
  - 스크립트 실행, 빌드 트리거, Asset 임포트
  - Console 로그 읽기, Play Mode 제어
- Unity MCP 포트 기본값: `8090` (Unity Editor에서 `Tools > MCP Server` 확인)

## 테스트
- Unity Test Runner 사용 (EditMode + PlayMode)
- EditMode 테스트: 로직/유틸리티 단위 테스트
- PlayMode 테스트: 씬 통합 테스트 (최소화)
- `[UnityTest]` 코루틴 테스트는 실제 프레임 의존 시에만 사용

## 보안
- `PlayerPrefs`에 민감 데이터 저장 금지
- 서버 통신: HTTPS 전용, 인증서 핀닝 고려
- 빌드 시 개발용 디버그 코드 (`Debug.Log`, 치트키) 제거 확인 — `#if UNITY_EDITOR` 또는 `#if DEBUG` 가드

## 패키지 관리
- Unity Package Manager(UPM) 우선 사용
- 서드파티 패키지: `Packages/manifest.json`으로 관리 (Assets/에 직접 복붙 지양)
