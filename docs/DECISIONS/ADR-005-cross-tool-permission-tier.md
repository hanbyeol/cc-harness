# ADR-005: 크로스도구 권한 계층 (Bash 밖 자율성)

**Status**: Accepted (v1.14.0, sprint-14 / F28)

## Context

F27([ADR-004](ADR-004-firewall-auto-allow.md))가 `pre-bash-firewall.sh`에 auto-allow를 넣어 **Bash 명령**의 승인 마찰을 없앴다. 그러나 하네스의 자율성 정책은 **Bash 도구 하나에만** 걸려 있었다 — `hooks.json`이 firewall을 `PreToolUse(Bash)`에만 등록하기 때문이다. WebFetch·WebSearch·MCP 등 나머지 도구는 Claude Code 네이티브 권한 시스템(settings의 `permissions`)이 관장하며, 특히 **WebFetch는 도메인 단위로 승인**해 리서치·문서수집 중 새 도메인마다 Y/n 프롬프트가 떠 자동화 흐름이 끊겼다.

"안전한 것은 묻지 말고 통과"라는 자율성 목표는 도구 전체에 걸친 것인데, 정교한 4계층 Bash 방화벽을 갖고도 나머지 도구엔 정책이 0이었다 — 비대칭.

## Decision

새 PreToolUse 훅 `hooks/pre-tool-firewall.sh`를 Bash 외 도구(`WebFetch|WebSearch|NotebookRead|mcp__.*`)에 등록한다. 읽기전용 도구면 `permissionDecision:"allow"`를 방출해 무프롬프트로 진행하고, 그 외는 판정 없이 `exit 0` → 네이티브 프롬프트로 넘긴다.

**핵심 설계 — allowlist 모델(default-allow 아님)**: Bash는 인자로 위험을 판별할 수 있어 default-allow(deny/ask로 위험만 차단)가 맞다. 그러나 **도구, 특히 MCP는 한 번의 호출이 곧 액션**(이메일 전송·캘린더 삭제·파일 업로드)이라 인자로 위험을 판별할 수 없다. 따라서 여기선 **읽기전용 화이트리스트에 명시적으로 매칭될 때만 allow**하고, 미분류·미지 verb는 오허용이 아니라 프롬프트한다.

- **allow(읽기전용)**: 빌트인 `WebFetch`·`WebSearch`·`NotebookRead`; MCP read-verb — `get`·`list`·`search`·`read`·`fetch`·`view`·`describe`·`query`·`find`·`show`·`inspect`·`count`·`download`·`suggest`·`resolve`·`preview`·`check`·`status`·`explain`.
- **gate(프롬프트)**: MCP write-verb(`create`·`update`·`delete`·`send`·`apply`·`remove`·`upload`·`label`·`move`·`copy`·`draft`·`respond`·`authenticate`·`execute`·`run`·`install`·`deploy` 등)·`file_upload`·`computer`·`navigate`·`NotebookEdit`·**미지의 도구/verb 전부**.
- **범위 제외**: `Edit`·`Write`·`MultiEdit`은 invariant-guard 관할(검증파일 보호 무손상), `Bash`는 pre-bash-firewall 관할. `Read`·`Grep`·`Glob`은 Claude Code 네이티브 자동허용이라 핫패스 오버헤드 회피 위해 matcher 제외.

**토글**: `progress/harness-config.json`의 `firewall.auto_allow_tools`(기본 `true`). off면 allow만 끄고 전부 네이티브 프롬프트로 안전하게 degrade — 이 훅은 deny를 방출하지 않으므로 위험 도구는 어차피 항상 프롬프트다.

## Consequences

**긍정**:
- WebFetch(도메인 무관)·WebSearch·MCP read가 무프롬프트 → 리서치·조회 자율성 회복. Bash에 이어 도구 전반으로 자율성 일반화.
- 플러그인 훅 내장 → 설치된 모든 프로젝트에 이식(전역/프로젝트 settings 무수정, [ADR-001](ADR-001-plugin-native-loading.md) 일관).

**트레이드오프 / 수용된 위험**:
- 화이트리스트라 새로운 read-only verb(예: MCP 서버의 비표준 조회 동사)는 목록에 없으면 프롬프트 — 오허용보다 안전측. 필요 시 verb 추가(코드 변경, critical 티어 리뷰).
- `navigate`·`tabs_context` 같은 사실상 읽기성 도구도 read-verb가 아니면 보수적으로 프롬프트(과게이트 수용).

**보안 원칙 — 자율성 확장은 위험정의 확장을 동반한다**: F27에서 auto-allow를 인자 판별 없이 넓혔다가 구멍(cp가 harness-config 덮어쓰기 등)이 났던 실수와 동형을 피한다. 도구 자율성을 넓히되 MCP write·외부반영·업로드는 명시적으로 게이트에 남긴다.

**집행**: `tests/pre-tool-firewall.bats`가 (a) 읽기전용 빌트인·MCP read → allow, (b) MCP write/send/delete/upload·미지 verb·미지 도구·`Edit`/`Bash`(범위 밖) → allow 미방출, (c) 토글 off·jq 부재·malformed 입력 → fail-safe(allow 미방출)를 고정. `hooks.json`의 invariant-guard·pre-bash-firewall 등록 잔존(INV-7)은 skill-frontmatter/consistency 테스트가 고정.
