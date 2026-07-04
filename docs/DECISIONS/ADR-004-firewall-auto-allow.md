# ADR-004: Firewall 자동 허용(allow) 계층

**Status**: Accepted (v1.13.0, sprint-13 / F27)

## Context

`hooks/pre-bash-firewall.sh`는 Bash PreToolUse 훅으로 위험 명령만 처리했다:
- **Layer 1/2 (deny, exit 2)**: 파괴적/간접 실행 차단
- **Layer 3 (ask)**: 복구 가능하지만 위험한 명령을 `permissionDecision:"ask"`로 강등

그 외 명령은 판정 없이 `exit 0` → Claude Code 기본 권한 흐름으로 넘어가, 정적 allow 규칙이 없으면 **사용자에게 Y/n 프롬프트**가 뜬다. cc-harness가 플러그인으로 설치되어 skill/agent가 실행될 때 `git status`, `go test`, `grep`, `git commit` 같은 안전 명령마다 사용자 확인이 필요해 자동화 흐름이 끊겼다.

대안으로 사용자 전역 `settings.json`의 `permissions.allow`에 규칙을 쌓는 방법이 있으나, (1) 사용자마다 수작업 유지가 필요하고 (2) cc-harness가 **다른 프로젝트에 설치되는 플러그인**일 때 cc-harness의 프로젝트 settings는 그 프로젝트에 적용되지 않는다. 훅은 플러그인이 활성인 모든 프로젝트에서 동작하므로 이식성이 있다.

## Decision

동일 훅에 **Layer 4 (allow)**를 추가한다. deny/ask를 모두 통과한 명령이 **읽기 전용 + 저위험 로컬 쓰기 allowlist**에 명시적으로 매칭될 때만 `permissionDecision:"allow"`를 방출해 무프롬프트로 진행한다.

**허용 대상**: 조회 명령(ls/cat/grep/rg/find/jq/diff/wc/stat/du/df/git status·log·diff·show 등) · git 안전/승인된 서브커맨드(add/commit/stash/switch/fetch/config, branch·tag는 파괴 플래그 없을 때) · 빌드·테스트(go build/test/vet/run, gofmt, bats, npm/pnpm test/run) · 저위험 로컬 쓰기(mkdir/touch/cp/mv).

**제외(기존처럼 프롬프트 또는 ask/deny)**: `git push`(외부 반영) · `git checkout`/`git reset`/`git clean`/`git rebase`(작업본·히스토리 위험) · `terraform`/`kubectl`/`helm`(iac·ops 리뷰 게이트 `/plan-review`·`/rollout`) · 인터프리터(`python`/`perl`/`awk`/`sed`/`node -e`) · `npm install`(postinstall) · `sudo`/`rm`/`dd` 등.

**보수적 가드**: 파이프라인의 **모든 세그먼트**가 allowlist여야 허용. command substitution `$(...)`·백틱·process substitution·파일 리다이렉트(`>`,`>>`)·경로 지정 명령이 있으면 자동 허용하지 않고 fall-through한다(`2>/dev/null`·`2>&1` 등 stderr 폐기 리다이렉트는 허용).

**토글**: `progress/harness-config.json`의 `firewall.auto_allow`(기본 `true`)로 allow 계층만 on/off. deny/ask는 이 값과 무관하게 항상 실행된다.

## Consequences

**긍정**:
- 하네스 skill/agent가 안전 명령에서 사용자 확인 없이 자동 진행 → 자동화 흐름 유지.
- 플러그인 훅에 내장 → 설치된 모든 프로젝트에 이식(전역/프로젝트 settings 무수정).
- deny/ask보다 **나중에** 평가되므로 위험 명령은 절대 allow되지 않는다(우선순위 보장).

**트레이드오프 / 수용된 위험**:
- allowlist는 코드에 하드코딩 — 확장 시 코드 변경(evaluator+security-auditor 리뷰 경유, critical 티어).
- `cp`/`mv`는 경로 제약을 두지 않는다(비root 권한으로 blast radius 제한 + 저위험 티어로 수용).
- backtick/`$(...)`를 포함한 안전 명령(예: 백틱 든 커밋 메시지)은 보수적으로 자동 허용되지 않고 프롬프트된다(안전 우선, 회귀 아님).

**집행**: 위험 명령이 allow로 새지 않음을 `tests/pre-bash-firewall.bats`의 회귀 배터리(rm -rf /·sudo·dd of=/dev·git push --force·terraform destroy·kubectl delete·git reset --hard 등이 deny/ask이며 output에 allow 미포함)로 고정. deny/ask 목록의 add-only 불변식(INV-5)이 allow보다 앞선 우선순위를 보존한다. → [INVARIANTS.md](../INVARIANTS.md) INV-9
