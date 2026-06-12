# ADR-001: Plugin-native loading으로 전환 (v1.5.0)

## Status
Accepted — 2026-06-12

## Context
v1.4까지 plugin의 `setup-claudemd.sh`(SessionStart 훅)는 agents/skills/hooks를 프로젝트의
`.claude/` 디렉토리로 복사하고, hooks를 프로젝트 `settings.json`에 머지했다. 그러나 Claude Code
plugin 시스템은 agents/skills/hooks를 **네이티브로 로드**하므로 이 방식은 다음 문제를 일으켰다:

1. **이중 등록** — 모든 agent/skill이 `architect`와 `cc-harness:architect`처럼 2벌 노출.
   매 세션 수천 토큰 낭비 + 에이전트 라우팅 모호성.
2. **CLAUDE.md 중복 삽입** — 하네스 내용이 이미 있는 프로젝트에도 마커 섹션을 추가 삽입.
3. **조용한 미설치** — 사용자 `settings.json`에 `hooks` 키가 이미 있으면 hook 머지를 건너뛰어
   firewall/format/gate가 등록되지 않음.

## Decision
- agents/skills/hooks는 **복사하지 않는다**. plugin이 네이티브로 로드한다.
- 런타임 hooks(firewall, format, gate, handoff, session-context)는 `hooks/hooks.json`에
  `${CLAUDE_PLUGIN_ROOT}` 경로로 등록한다 — settings.json 머지 제거.
- rules만 `.claude/rules/`로 복사한다 (path-scoped rules는 plugin 네이티브 미지원).
- CLAUDE.md 삽입은 멱등으로: 센티널 문구가 마커 밖에 이미 존재하면 스킵/중복 제거,
  손상된 마커(begin만 존재)는 파일을 건드리지 않는다.

## Migration (v1.4 → v1.5)
**Plugin 사용자**: 자동. v1.5 첫 세션에서 `setup-claudemd.sh`가:
- plugin 원본과 **동일한** `.claude/agents|skills|hooks` 복사본을 제거
- `settings.json`의 hooks 섹션이 plugin 기본값과 동일하면 함께 제거
  (스크립트만 지우면 참조가 깨지므로 쌍으로 처리)
- **수정된(커스터마이징된) 복사본은 보존**하고 안내를 출력 — 이 경우 이중 등록이 남으므로,
  커스텀 내용을 별도 이름으로 옮기고 원본 복사본은 삭제할 것을 권장

**Bootstrapper(`npx cc-harness`) 사용자**: 영향 없음. init.sh 경로는 기존처럼 `.claude/` 복사
+ `settings.json` 등록 방식을 유지한다 (plugin 미설치 환경용).

**수동 정리가 필요한 경우**:
```bash
# 복사본이 plugin 원본과 동일한지 확인 후 제거
rm -rf .claude/agents .claude/skills .claude/hooks
# settings.json에서 cc-harness hook 항목 제거 (다른 hook이 없다면 hooks 키 전체)
```

## Consequences
- 세션 컨텍스트 토큰 사용량 감소 (agent/skill 정의 1벌만 로드)
- plugin 업데이트 시 agents/skills/hooks가 즉시 반영 (복사본 갱신 불필요)
- agents/skills를 프로젝트별로 커스터마이징하려면 `.claude/agents/`에 **다른 이름으로**
  파일을 만들어 오버라이드 (plugin 네임스페이스와 충돌 방지)
