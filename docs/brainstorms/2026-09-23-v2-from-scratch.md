# cc-harness v2 — from scratch 재설계

## 문제 정의

v1은 "더 나은 개발 방식"보다 "자율 구동 모델의 파괴적 행위 방어"에 대부분의 에너지를 썼고,
그 방어는 수렴하지 않았다.

### 실측 (2026-09-23, v1.39.18 기준)
| 지표 | 값 |
|------|-----|
| 방어 훅(pre-bash-firewall·invariant-guard·protected-integrity) | ~5,700줄 bash — 전체 훅 코드의 81% |
| docs/INVARIANTS.md | 1,650줄 (에이전트+스킬 프롬프트 전체 ~1,600줄보다 김) |
| 2026-08 이후 커밋 | 206개 중 142개(69%)가 방어 관련 |
| 미완 기능 | F63~F78 6개 전부 방어 |
| F65 | 커밋 88개, 판정 43회+, 계약 파일 256KB, 보안 점수 3↔5 진동(7 도달 0회) |
| F63 | 10회전 전부 fail, 점수 5→2 하락 후에야 "질문이 틀렸다"로 폐기 |
| F78 | 6회전 진행 중, 최신 3/10 (`git replace`·smudge 필터·`"nan"` 우회) |

### 45회 루프의 근본 원인 (구현 품질이 아니라 설계 결함)
1. **결정 불가능한 목표** — "어떤 bash 표기로도 컨트롤 플레인을 바꿀 수 없다"는 튜링 완전한 셸에 대한
   전칭 부정이다. 문자열 분석으로는 원리적으로 닫히지 않으므로 판정자는 매 회차 새 표기를 찾는다.
2. **evaluator 범위의 무한 확장** — 4차 판정부터 "계약 범위 밖" 우회로 fail. 기준 역전파가 각 발견을
   새 SC로 흡수해(SC-1→SC-15) 골대가 매 라운드 이동했다.
3. **정지 규칙 부재** — 라운드 상한도, 점수 추세 검사도 없었다. F63의 선례(10회전, 점수 하락)가
   F65에 전혀 반영되지 않았다.
4. **자기참조** — 하네스가 하네스를 지킨다. 가드 자신이 사고(정당한 편집 되돌림, 2,058줄 원장)를
   만들고, 그 수습이 다시 기능(F78)이 됐다.
5. **잘못된 계층** — OS 수준 보장(파일 보호)을 에이전트 프로세스 안의 문자열 매칭으로 구현하려 했다.

## 결정 사항

### D1. 위협 모델: 협력적 모델 + 사고 방지
- 모델은 규칙을 따르려 한다고 가정한다. 방어 대상은 **실수에 의한 파괴**뿐.
- 파괴 방지는 각 CLI의 네이티브 권한·sandbox + worktree 격리 + 최소 deny 목록(~5줄)에 위임.
  하네스 자신은 in-process 방화벽·무결성 훅을 두지 않는다.
- 게이트 무결성은 **구조**로 보장한다: 결정적 verify 앵커 + 별도 컨텍스트(가능하면 다른 모델) evaluator.

### D2. 수렴 규칙 — v1 루프의 직접 대응 (사용자 확정)
| v1 원인 | v2 대응 | 집행 |
|---------|---------|------|
| 결정 불가능한 목표 | 모든 AC/SC는 **유한·실행 가능한 검증**(테스트/명령)을 가져야 한다. 전칭 부정("우회 불가" 류)은 lint가 거부 → 열거형 시나리오로 재작성하거나 OS 계층 통제로 이관 | `harness lint-contract` (Plan 게이트 전) |
| 범위 확장 | 계약 **동결**. evaluator의 fail finding은 `criterion_id` + `repro` 명령 필수. 둘 중 하나라도 없으면 비차단 → backlog. 예외: 이미 통과한 동작의 회귀 | 판정 JSON 스키마를 코어가 검사 + **repro를 코어가 재실행해 실측 확인** |
| 정지 규칙 부재 | 기능당 최대 **3라운드**(설정값). 라운드 N의 실패 집합이 N-1의 **진부분집합**이어야 함 — 새 실패 등장 = 발산 → 즉시 `blocked` | `harness run` 루프(코드) |
| 기준 중도 변경 | 승인 후 기준 변경 = 새 계약 버전 → Plan 게이트 재승인. 자동 흡수 금지 | 계약 해시 |
| 자기참조 | 하네스는 자기 보호를 하지 않는다. 자율 실행 중 하네스 자신의 설정/임계값 변경 금지(실행 시작 시 스냅샷) | 설정 스냅샷 |

- `blocked` 처리: 재범위 제안(분할 / 기준 재작성 / 위험 수용)을 기록하고 **독립적인 다음 기능으로 진행**,
  종료 시 한 번 보고. 단 **critical 기능이 blocked면 run 전체 정지**.
- min-of-5 채점, critical 보안 7/10 자동 fail은 유지(임계값은 `.harness/config.json`).

### D3. 구조: 씬 플러그인 + CLI 중립 코어
```
cc-harness v2
├─ core/                Node.js, 런타임 의존성 0, Win/macOS/Linux
│   └─ harness          init · lint-contract · verify · eval · run · status · doctor
│      adapters/        claude · codex · gemini · generic  (headless 호출 + capability 플래그)
├─ content/             단일 원천
│   ├─ AGENTS.md        워크플로우 지시 (Codex·Gemini·Cursor·opencode가 읽음)
│   ├─ skills/          spec · plan · build · fix · status · plan-review(iac) · rollout(ops)   (SKILL.md 표준)
│   ├─ roles/           builder · evaluator · security-reviewer   (subagent 겸 headless 프롬프트)
│   └─ profiles/        sdlc · iac · ops   (= verify 명령 + evaluator 루브릭)
└─ dist/                빌드 산출물: .claude-plugin · codex · gemini-extension (content에서 생성)

대상 프로젝트 상태: .harness/
  config.json  features.json  contracts/F{n}.json(동결·해시)  verdicts/F{n}-r{k}.json  backlog.json  runs/{ts}.md
```
- 1급 지원: Claude Code, Codex CLI, Gemini CLI. 그 외(Cursor/opencode 등)는 AGENTS.md + skills 베스트 에포트.
- 오케스트레이터는 **모델 컨텍스트가 아니라 Node 프로세스**다. 각 단계는 새 headless 세션
  (`claude -p` / `codex exec` / `gemini -p`)으로 실행 → 컨텍스트 누적·compaction 문제 제거, 재시도 상한이 코드로 보장.
- 대화형 사용(자율 아님)에서는 skills가 같은 코어 명령을 호출한다 — 경로는 달라도 게이트는 하나.

### D4. `harness run` — 기능 1개의 수명주기
1. **(사람, 1회)** 대상 기능들의 계약 → `lint-contract` 통과 → 배치 Plan 승인 → 계약 동결(해시)
2. 기능별 worktree + `feat/F{n}` 브랜치 생성 (의존 순서대로)
3. **build** — builder headless 세션, TDD. 내부 verify 재시도 ≤3, 토큰·시간 예산
4. **verify (결정적)** — 프로필의 명령(test·lint·build) + **테스트 무결성 검사**:
   base 대비 테스트 케이스 수 비감소, 신규 skip/only 마커 없음, `.harness/config.json` 미변경.
   (협력적 모델 가정에서도 "통과를 위한 무심코 약화"를 결정적으로 잡는 값싼 장치)
5. **eval** — evaluator headless 세션(가능하면 builder와 **다른 모델**), 입력 = 동결 계약 + diff + verify 출력.
   코어가 스키마 검증 + fail finding의 repro 재실행. critical이면 security-reviewer 동일 규칙으로 추가.
6. pass → 코어가 판정을 기록하고 `integration` 브랜치로 병합 → 병합 후 verify 재실행 → 다음 기능
7. fail → 라운드+1(단조감소 검사, ≤3) / 발산·소진 → `blocked` + 재범위 제안
8. 종료 → 실행 보고서 + `integration → main` PR. **main 병합은 항상 사람**.

## 리스크 사전 분석 (내장 회피책)
| # | 리스크 | 회피/극복 |
|---|--------|-----------|
| R1 | 비수렴 루프 (v1 재발) | D2 전체 — 라운드 상한·단조감소·계약 동결·결정가능성 lint |
| R2 | 거짓 통과 | 결정적 verify 앵커 + 테스트 무결성 검사 + 별도 컨텍스트/타 모델 evaluator |
| R3 | 거짓 실패 (evaluator 환각) | finding은 repro 필수, 코어가 재실행해 재현 안 되면 기각 |
| R4 | 환경 파괴 | worktree 격리, CLI 네이티브 sandbox, deny ~5줄, main 직접 push 없음 |
| R5 | 비용·시간 폭주 | 단계별 토큰/시간 예산, 라운드 상한, run 전체 예산, 초과 시 정지·보고 |
| R6 | 긴 실행의 컨텍스트 소실 | Node 오케스트레이터 + 단계별 새 세션 + 상태는 전부 `.harness/` 파일 |
| R7 | 기능 간 병합 충돌 | 의존 순서 직렬 병합, 병합 후 verify 재실행, 충돌 시 해당 기능만 `blocked` |
| R8 | flaky 테스트 | verify 실패 시 1회 재실행, 불일치면 flaky로 기록(통과로 치지 않음) |
| R9 | 스펙 모호성 | 자율 실행 중 추측 금지 → `blocked(needs-input)`, 다음 기능 진행 |
| R10 | CLI 포맷 드리프트 (Codex/Gemini 업데이트) | content 단일 원천 → dist 생성, `harness doctor`가 설치 CLI의 capability를 실측 |
| R11 | 교차 모델 evaluator 불가 (미설치·미인증) | 같은 CLI 새 세션으로 폴백, 판정에 `independence: cross-model|fresh-context` 기록 |
| R12 | 크로스 OS | 코어에 bash 없음, 경로는 Node path API, 명령은 프로필에 OS별 오버라이드 허용 |
| R13 | ops 프로필의 라이브 변경 | 라이브 클러스터 변경(`rollout`)은 **자율 실행 대상에서 제외** — 항상 사람 승인 |
| R14 | 하네스 자기개선 재발 | `/improve` 제거. 하네스 개선은 일반 기능과 동일 경로(수렴 규칙 적용) |

## 검토한 대안
| 대안 | 결과 | 사유 |
|------|------|------|
| 현 수준 적대적 방어 유지 | 기각 | 결정 불가능한 목표 — 45회 실측으로 증명됨 |
| 보상 해킹 구조 차단(CI 사후검증만) | 부분 채택 | 테스트 무결성 검사로 흡수, 별도 계층은 과잉 |
| B. Workflow 엔진(Claude Workflow 스크립트) | 기각 | Claude Code 전용 — 멀티 CLI 요구와 충돌. 결정적 흐름 제어는 Node 코어가 대신 제공 |
| C. CLAUDE.md + verify만 | 기각 | iac/ops 프로필·자율 실행·멀티 CLI 배포 불가 |
| 새 repo / 점진 축소 | 기각 | 이력·마켓플레이스 경로 유지 필요 / 기존 가정 잔존 |
| Python 코어 | 기각 | Windows 기본 미설치, 세 CLI 모두 npm 배포 경로가 있어 Node가 사실상 전제 |
| 범위 밖 critical 보안 발견도 fail 허용 | 기각 | v1 루프의 직접 원인(골대 이동) — backlog + critical run 정지로 대체 |

## 제약·가정
- v2 브랜치에서 재작성, v1은 `v1.39.18` 태그로 보존. F63~F78은 `superseded`로 종료.
- v1 사용 프로젝트용 마이그레이션 가이드 + 상태 변환(`progress/` → `.harness/`) 제공.
- 범위: 핵심 SDLC 루프 + iac/ops 프로필 + 무인 자율 실행. `/improve`·자기진단 프로브·KPI 텔레메트리는 제외.
- 목표 규모: 코어 + content ≤ ~2,000줄 (v1 ~21,000줄).

## 보안 고려사항
- 예상 security_tier: 코어의 `run`·`verify`(임의 명령 실행, 브랜치 병합)는 **critical**, 나머지 standard.
- 민감 데이터: 없음(하네스 자체). 단 headless CLI 호출 시 프롬프트에 시크릿이 실리지 않도록
  diff 입력에서 `.env*` 등 제외 목록 적용.
- verify/repro 명령은 프로필·계약에 선언된 것만 실행(모델이 즉석 생성한 명령을 코어가 실행하지 않음 — repro는
  계약 동결 이후 evaluator 출력이므로, worktree 안에서 sandbox 모드로만 실행).

## 미해결 질문 (스펙 단계로)
1. CLI capability 실측 (2026-09-23 스파이크):
   - Claude Code 2.1.280 — `-p`, `--json-schema`(판정 구조화 출력), `--max-budget-usd`(예산을 코드로 집행), `--model`. ✅
   - Gemini CLI 0.38.1 — `-p`, `-o json`, `--approval-mode plan`(읽기전용 → evaluator에 적합), `-s` sandbox, `gemini skills`(SKILL.md 네이티브). ✅
   - Codex CLI — 이 머신 미설치로 미검증. `codex exec` 기반 어댑터는 `doctor` 실측 전까지 experimental 표시.
2. 테스트 무결성 검사의 언어별 "테스트 케이스 수" 산출 방식 (러너 JSON 리포터 우선, 없으면 비활성+경고)
3. 교차 모델 기본 페어링 정책 (builder=Claude, evaluator=Codex 등) 및 사용자 설정 방식
4. 예산 기본값 (단계별 토큰/시간, run 전체)
5. repro 재실행의 sandbox 구현 — CLI 네이티브 sandbox 재사용 vs 코어 자체 제한(타임아웃·네트워크 차단)
