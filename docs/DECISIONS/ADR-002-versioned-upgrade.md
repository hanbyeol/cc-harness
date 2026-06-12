# ADR-002: 버전 기반 업그레이드 프로세스 (v1.5.0)

## Status
Accepted — 2026-06-12

## Context
v1.4까지 plugin은 설치 상태를 빈 marker 파일(`.claude/.cc-harness-installed`)로만 기록했다.
설치된 버전을 알 수 없으므로:
- 업그레이드를 감지할 수 없어 마이그레이션을 매 세션 무조건 실행하거나 아예 못 함
- `.claude/rules/` 복사본은 최초 복사 후 **영구히 갱신되지 않음** — plugin이 rules를 개선해도
  기존 프로젝트에는 반영 안 됨
- 사용자가 rule을 수정했는지 알 수 없어, 덮어쓰면 커스터마이징 파괴 / 안 덮어쓰면 영구 stale

## Decision
SessionStart 훅(`setup-claudemd.sh`)에 버전 기반 업그레이드 체계를 도입한다:

1. **버전 기록**: `.claude/.cc-harness-installed`에 설치된 plugin 버전 문자열을 기록.
   plugin 버전은 `$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json`에서 런타임에 읽는다.
2. **버전 게이트**: 기록된 버전 == 현재 버전이면 마이그레이션·rules 갱신을 건너뛴다
   (매 세션 비용 0). CLAUDE.md 섹션 갱신만 매 세션 수행 (저비용 self-heal).
3. **Pristine 추적**: rules 복사 시 `.claude/.cc-harness-rules.sha256` manifest에 해시 기록.
   업그레이드 시 파일의 현재 해시가 manifest와 일치하면(= 사용자 미수정) 새 버전으로 자동
   갱신, 불일치하면(= 사용자 수정) 보존하고 안내 출력.
4. **마이그레이션 체인**: 버전 전환 시 필요한 마이그레이션(예: v1.4 복사본 정리 — ADR-001)을
   실행. 모든 마이그레이션은 멱등으로 작성한다.
5. **업그레이드 안내**: `{이전} → {새 버전}` 전환 내역과 갱신/보존된 파일을 세션 시작 시 출력.

## 향후 마이그레이션 추가 방법
새 버전에서 마이그레이션이 필요하면 `setup-claudemd.sh`의 `VERSION_CHANGED` 블록에
멱등 로직을 추가한다. 특정 버전 이전에만 필요한 마이그레이션은 `INSTALLED_VERSION`
비교로 가드한다 (pre-1.5 설치는 `INSTALLED_VERSION`이 빈 문자열).

## Consequences
- plugin 업데이트가 기존 프로젝트에 안전하게 전파된다 (rules 개선 포함)
- 사용자 커스터마이징은 절대 자동으로 덮어쓰지 않는다 — 보존 + 안내
- pre-1.5 설치(빈 marker 파일)는 첫 세션에서 자동으로 새 체계로 편입된다
- manifest가 없는 pre-1.5 rules는 현재 plugin 버전과 동일할 때만 추적 대상으로 편입,
  다르면 수정본으로 간주해 보존한다 (안전 우선)
