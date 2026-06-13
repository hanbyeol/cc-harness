---
name: finish-branch
description: "작업 브랜치 마무리 워크플로우. TRIGGER: 사용자가 '브랜치 마무리', '머지 준비', 'PR 만들어', 'PR 올려', 'finish branch', '작업 끝났어', '릴리스 준비' 등 브랜치를 정리·통합하려 하면 이 스킬 실행."
---
# /finish-branch — 브랜치 마무리

작업 브랜치를 검증·정리하고 **PR / 로컬 머지 / 보류** 중 하나로 마무리한다.
main 직접 커밋 금지 규칙의 출구 워크플로우.

## 사용법
```
/finish-branch            # 현재 브랜치 마무리
```

## Process

### 1. 게이트 — 전체 테스트
- 프로젝트의 전체 테스트 실행 (make test, bats tests/ 등 프로젝트 표준 명령)
- **실패 시 마무리 중단**: 실패 내역 요약 후 안내
  - 원인 불명확 → `/debug`
  - evaluator 반려 건 → `/implement --retry`
- 린트 실행 (있는 경우)

### 2. 산출물 정합성 확인
- feature_list.json: 이 브랜치에서 작업한 기능의 `passes` 상태 확인
  - **passes: false인 기능이 포함되어 있으면 경고** — evaluator 미통과 코드의 머지 여부는 사용자 결정
- 문서 drift 간이 점검: 변경 파일 대비 SPEC/ARCHITECTURE/acceptance-criteria 반영 여부
  (의심 항목이 많으면 `/sync-docs` 실행 제안)
- progress/session-handoff-draft.json에 미완료 항목이 남아 있으면 표시

### 3. 커밋 상태 정리
- uncommitted 변경 확인 — 있으면 커밋 또는 의도적 제외인지 확인
- 커밋 메시지가 규칙(영어, 컨벤션)을 따르는지 점검
- main 대비 변경 요약 생성 (`git log main..HEAD --oneline`, diffstat)

### 4. 마무리 옵션 제시 — 사용자 선택
환경을 감지해 가능한 옵션만 제시:

| 옵션 | 조건 | 동작 |
|------|------|------|
| **PR 생성** | `gh` 사용 가능 + 원격 존재 | push + `gh pr create` — 제목 `[component] description` 규칙 |
| **로컬 머지** | — | main으로 fast-forward/merge (원격 없는 로컬 프로젝트용) |
| **보류** | — | 현재 상태 유지, handoff에 다음 작업 기록 |

- **push·PR 생성은 외부 공개 동작 — 실행 전 반드시 사용자 확인을 받는다**
- gh 미설치 또는 원격 없음 → PR 옵션은 제시하지 않고 로컬 머지/보류만
- PR 본문: 변경 요약 + Sprint Contract 기준 충족 내역 + breaking change 시 마이그레이션 가이드

### 5. 머지 + 검증 + 삭제 — **반드시 이 순서로, 단계 분리**
브랜치 삭제는 머지가 **확인된 뒤에만** 실행한다. 머지와 삭제를 한 명령/한 단계에 묶지 않는다.
```
① 머지/push  →  ② 검증  →  ③ (검증 통과 시에만) 브랜치 삭제
```
- **② 검증 필수**: PR 머지면 API로 `merged == true` 확인, 로컬 머지면
  `git ls-remote origin refs/heads/main`의 SHA가 로컬 main과 일치하는지 확인.
  검증 실패 시 **브랜치를 삭제하지 않고 중단**한다.
- **왜**: 열린 PR의 브랜치를 머지 전에 삭제하면 GitHub가 PR을 **미머지 상태로 auto-close**한다
  (실제 발생 사고 — 머지 curl 실패 후 삭제가 실행되어 작업이 유실될 뻔함). git 객체는 reflog로
  복구 가능하지만, 삭제는 머지 확인 뒤로 미루는 것이 올바른 순서다.
- PR API가 불안정하면 git 인증(push/ls-remote)으로 폴백 — 단, 위 검증 순서는 동일하게 지킨다.

### 6. 사후 처리
- 머지·삭제 완료 후: progress/claude-progress.txt 갱신, 태그(해당 시), handoff 정리
- phase-gate.json의 해당 phase 상태 갱신 (해당 시)

## Constraints
- 테스트 실패 상태로 PR/머지 진행 금지 (사용자가 명시적으로 강행하는 경우만 예외, 사유 기록)
- main 직접 커밋 금지 — 이 스킬은 브랜치에서만 동작 (main이면 안내 후 종료). 단 **검증된 feature
  브랜치를 main으로 머지**하는 것은 직접 커밋이 아니라 정상 통합 출구다
- force push 금지 (firewall이 차단). 이력 정리가 필요하면 사용자에게 위임
- 외부 공개 동작(push, PR)은 사용자 확인 없이 실행하지 않는다
- **머지·삭제 단계 분리**: 브랜치 삭제는 머지 verified 후에만 (위 5단계) — 단일 명령 금지
