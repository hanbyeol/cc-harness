---
name: sync-docs
description: "문서와 코드 간 불일치 검사 및 동기화. TRIGGER: 사용자가 '문서 동기화', '문서 업데이트', 'sync docs', '코드랑 문서가 안 맞아', 'drift 확인', '산출물 점검' 등을 요청하면 이 스킬 실행."
---
# /sync-docs — 산출물 동기화 검사

구현 코드와 설계 문서 사이의 **불일치(drift)를 탐지**하고 산출물을 현재 상태에 맞게 업데이트한다.

## 사용법
```
/sync-docs              # 전체 검사 (git log·feature_list 샘플링, 저비용)
/sync-docs spec|architecture|criteria   # 특정 산출물만
/sync-docs --deep       # 1M 컨텍스트 전수 검사 (고비용, 월 1회 권장)
```

## Process (기본 모드)
1. **상태 수집**: git log 최근 변경 파일 + feature_list.json 완료 기능 + progress/agent-comms 최근 output.
2. **Spec drift** (docs/SPEC.md): feature_list의 passes:true 기능 ↔ SPEC 기능 섹션 교차 대조 —
   구현됐으나 SPEC 미반영 / SPEC엔 있으나 코드 흔적 없음 / 보안 요구 ↔ SECURITY-CHECKLIST 불일치.
3. **Architecture drift** (ARCHITECTURE.md): 새 컴포넌트·API 변경·기술 스택이 문서에 미반영인지.
4. **Criteria drift** (acceptance-criteria.json): 구현 기능에 criteria 누락 / 삭제 기능의 잔존 criteria /
   security_criteria ↔ 실제 보안 구현 불일치.
5. **Feature list 정합**: feature ID로 코드 파일 검색(implementer-output.json의 files_changed) —
   코드엔 있으나 미등록 / 등록됐으나 코드 흔적 없음 / passes:true인데 `make test` 실패.
6. **리포트 출력** → 각 drift에 수정 방안 제시 → 사용자 승인 시 갱신 → `docs: sync documents with implementation`.

리포트 형식: `<파일>: ⚠ <항목> — <불일치 내용>` 목록 + `Actions needed: N`.

## Deep Audit — `/sync-docs --deep`
기본 모드는 샘플링이라 cross-file 불일치를 놓친다. Deep은 **1M 컨텍스트**에 repo 전체를 단일
패스로 적재해 전수 교차 검증한다.

**실행 전제** (둘 다 충족해야 진행):
- **1M 컨텍스트 모델**: `claude-fable-5`/`claude-mythos-5`(기본) 또는 모델 ID에 `[1m]` suffix.
  아니면 사용자에게 전환 안내 후 중단.
- **비용 동의**: 일반 대비 **10~20배 토큰**. Fable 5/Mythos 5는 새 tokenizer로 동일 콘텐츠가
  **~30% 더 많은 토큰**·단가도 높음($10/$50 per MTok). 실행 전 명시적 동의 요청.
- 권장 빈도: 월 1회 또는 major milestone 직전(릴리스·아키텍처 리팩터링 전).

**컨텍스트 로드**(상위→하위 순): docs/SPEC·ARCHITECTURE·API-DESIGN, acceptance-criteria.json,
feature_list·sprint-*.json, 소스 디렉토리(src/lib/app/packages 등), 테스트, 설정/스키마.

**전수 교차 검증 항목** (샘플링이 놓치는 것):
- **Cross-file 불일치**: 한 요구사항이 여러 모듈에 분산 구현됐을 때 일관성
- **암묵적 의존성**: 문서엔 없으나 코드상 존재하는 모듈 간 의존
- **Silent drift**: feature_list·git log엔 없지만 코드에 존재하는 기능
- **Contract violation**: Sprint Contract acceptance_criteria ↔ 실제 테스트·구현 전수 대조
- **Security 전파**: SPEC 보안 항목이 관련된 **모든** 핸들러에 일관 적용됐는지
- **Error coverage**: error_scenarios ↔ 실제 에러 경로 매핑
- **Dead code/orphan**: 어떤 feature에도 속하지 않는 코드

**언제 deep을 쓰나**: 월간 정기 감사 / 릴리스 전 최종 점검 / 아키텍처 리팩터링 직전 /
오랜만에 본 레거시 모듈. (스프린트 주간 점검·단일 기능 확인은 기본 모드로 충분.)

**비용 절감**: `.syncignore`로 빌드 아티팩트·lock·dist 제외, deep 결과는 progress/agent-comms/에
저장해 재참조.

## Constraints
- 코드 수정 금지 — 문서만 업데이트, 자동 수정은 사용자 확인 후에만
- `--deep`는 1M 컨텍스트 모델에서만 — 미지원 시 전환 안내 후 중단
