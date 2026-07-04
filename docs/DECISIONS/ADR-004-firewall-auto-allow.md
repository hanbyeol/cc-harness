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

## Amendment — 인자 인지 분류 (F27 후속, v1.13.1)

**문제**: 최초 구현(v1.13.0)은 세그먼트의 **첫 단어만** allowlist와 대조하고 인자·서브커맨드를 무시했다. 이는 두 방향으로 동시에 틀렸다:
- **너무 헐거움(보안 구멍)**: `find . -delete`·`find . -exec rm -rf {} +`·`cp x progress/harness-config.json`·`mv y tests/*.bats`·`sed -i ... harness-config`·`git config core.hooksPath ...`·`git stash drop|clear`·`git switch --discard-changes`·`npm exec <pkg>`가 전부 무프롬프트 allow. 특히 `cp/mv/sed`가 검증 파일을 덮어쓸 수 있어, invariant-guard(Edit|Write만 후킹)를 Bash 경유로 우회 — INV-3/5/6의 자동 약화 speed bump를 무력화.
- **너무 좁음(마찰)**: `sed`·`awk`·`make`·`cargo build/test`·`docker ps`·`kubectl get`·`curl -s`·`ps`·`brew list`·`tar -t` 같은 안전한 개발 이너루프 명령이 allowlist에 없어 매번 Y/n 프롬프트.

**결정**: 분류를 **인자 인지(argument-aware)**로 정밀화한다 — allowlist 확장(마찰 제거)과 위험 인자 가드 추가(구멍 봉쇄)를 동시에. 둘 다 강화 방향이라 INV-9(allowlist 확장은 사람 검토 + 회귀 배터리)에 부합.
- **확장(allow 추가)**: 순수 조회(sed 읽기·awk·less·tac·rev·ps·free·lsof·ss·ping·dig 등) · 빌드/테스트 러너(make/gmake/mvn/gradle, cargo build·test·check·clippy) · 컨테이너/오케스트레이션 **읽기 서브커맨드**(docker ps·logs·inspect, kubectl get·describe·logs, helm list·status, podman) · 네트워크 **조회**(curl/wget GET) · 패키지 조회(brew/pip list·show).
- **가드(위험 인자 → 제외/프롬프트)**: `find`의 `-delete|-exec|-execdir|-ok|-fprintf|-fls`; 파일 쓰기 명령(cp·mv·tar·ln·install·rsync·sed·awk)의 **보호 경로**(harness-config.json·hooks/*.sh·tests/*.bats·INVARIANTS.md·.git/·~/.ssh·~/.aws·~/.gnupg·/etc/) 겨냥; `awk system()`·`sed s///e` 코드 실행; `curl/wget`의 변형 플래그(`-X POST/PUT/DELETE/PATCH`·`-d`·`--data`·`--upload-file`); `git config` 쓰기(읽기 `--get/--list/-l`만 허용)·`git stash drop|clear`·`git switch --discard-changes/-f/-C`; `npm/pnpm/yarn exec` 제거.

**여전히 제외(설계상)**: `git push`(외부 반영) · `npm install`(postinstall) · 인터프리터 직접 실행(`python`/`node`/`ruby` 스크립트 — 임의 코드) · `git checkout`/`reset`/`clean`(L3 ask) · `sudo`/`rm`/`dd`.

이로써 line 19·21(sed/awk·cp/mv 관련)·36(cp/mv 경로 무제약)의 원래 서술은 이 개정으로 대체된다.

**집행**: `tests/pre-bash-firewall.bats`에 negative-space 배터리(위 구멍 14종이 allow 미방출)와 positive 배터리(안전 이너루프 13종이 allow 방출) 추가 — 회귀 시 즉시 실패.
