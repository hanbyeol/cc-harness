# 라이프사이클 프로파일 + iac 프로파일

## 문제 정의
cc-harness는 단일 라이프사이클(SDLC)만 인코딩한다. terraform 프로비저닝과 k8s 운영은 검증
모델·산출물·위험 프로파일이 다른 별개 라이프사이클이라, SDLC 워크플로우를 그대로 적용하면
토큰·시간이 과도하다(실사례: innocrew/infrastructure, 458 .tf, full-SDLC CLAUDE.md 매 세션 주입,
변경당 SPEC/ARCH/criteria/Sprint Contract 4종 cascade + 5차원 evaluator).

## 결정 사항 (사용자 승인)
1. **라이프사이클 프로파일 추상화** — 구조층은 공통 유지, 프로파일이 워크플로우 레이어를 교체.
   활성 프로파일만 CLAUDE.md에 주입(토큰 절감).
2. **iac 프로파일 먼저** — terraform 프로비저닝. ops(k8s) 프로파일은 검증 후 후속.

## 아키텍처
```
cc-harness 구조층 (프로파일 무관, 재사용)
  Plan 게이트 · security_tier · firewall · change-request 영향분석 ·
  session-context · /improve · invariant-guard · /finish-branch
└─ profile (harness-config.json: "profile": "sdlc|iac|ops")
   ├─ sdlc (기본): spec-writer/architect/implementer/evaluator, 5차원 eval, SPEC→criteria→Sprint
   ├─ iac:  plan-review 게이트, 정책 스캔(tflint/trivy), drift, cost — 코드+plan이 스펙
   └─ ops:  관측→진단→조치→검증, runbook, deploy-operator 재사용 (후속)
```

### 프로파일이 정의하는 것
- **주입할 CLAUDE.md 섹션**: 프로파일별 워크플로우만 (setup-claudemd가 profile 읽어 선택 주입)
- **검증 모델**: sdlc=evaluator 5차원 / iac=plan-review+정책+drift / ops=health+회귀
- **활성 스킬·에이전트**: 프로파일 스코프
- **firewall 확장 패턴**: 프로파일별 추가 deny/ask (add-only — INV-5)

## iac 프로파일 구체
- **검증 모델 교체**: 5차원 evaluator → plan-review 게이트
  - 산출물 = `terraform plan` diff. 게이트 = (1)plan diff가 의도와 일치 (2)tflint/trivy/checkov 통과
    (3)smoke-test (4)cost(infracost, 있으면) (5)apply 후 state 무drift
- **산출물 경량화**: 변경당 SPEC.md/ARCHITECTURE.md 강제 폐지. change-request 영향분석(blast radius)은 유지
- **스킬**: `/plan-review`, `/apply`(환경별 승인 — prod는 Plan 게이트 필수), `/drift`
- **firewall add-only**: prod `terraform destroy`·`apply -auto-approve`·state 직접 편집 = deny,
  `import`·`taint` = ask

## 불변식 안전 (필수 제약)
- iac 프로파일의 plan-review 게이트는 sdlc evaluator를 **대체가 아니라 프로파일별 대안**이다.
  sdlc 프로파일의 pass_threshold·security_thresholds·evaluator 독립성(INV-1~7)은 **그대로 불변**.
- 프로파일 전환이 검증 장치 약화로 악용되지 않도록: profile은 harness-config의 키이고,
  invariant-guard는 sdlc 임계값 하향을 계속 차단. iac 게이트도 자체 통과 기준을 낮추지 못하게
  INVARIANTS에 iac 불변식 추가(plan 미확인 apply 금지, prod auto-approve 금지 등).
- "프로파일을 ops로 바꿔서 검증을 건너뛴다" 같은 우회 차단: 프로파일은 **검증 모델을 교체**할 뿐
  검증 자체를 제거하지 않는다 — 각 프로파일은 자기 게이트를 반드시 가진다.

## 전제 조건 (구현 전 처리)
1. **보안**: innocrew/infrastructure의 terraform_accessKeys.csv를 .gitignore + 키 이동(+로테이션)
2. **인프라 repo 업데이트**: pre-1.5 복사 설치 → 1.9.0+ 네이티브 (프로파일은 1.10+ 기능이므로)

## 미해결 질문 (스펙 단계로)
1. 프로파일 선택 UX: harness-config 수동 vs init.sh preset vs 자동 감지(*.tf 존재→iac 제안)?
2. 한 repo가 멀티 프로파일(인프라 repo가 terraform+k8s 둘 다)일 때 — 디렉토리별 프로파일?
3. iac 게이트를 evaluator 에이전트로 구현 vs 신규 plan-reviewer 에이전트?
4. 기존 sdlc 사용자 무영향 보장 (profile 미지정=sdlc 기본) — 회귀 0 검증 방법
5. 프로파일별 CLAUDE.md 주입을 setup-claudemd가 어떻게 — 별도 profile 섹션 파일 vs 조건부 블록?
