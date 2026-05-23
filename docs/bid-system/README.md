# NJ Safety 입찰 모니터링 시스템 — Claude Code 작업지시서

## 프로젝트 개요

fr-workwear-app에 **조달청 나라장터 입찰 모니터링 서브시스템**을 통합합니다. 매일 새벽 자동으로 신규 방염복 관련 입찰공고를 수집하여, 이메일(추후 카카오 알림톡)로 알림을 받고 웹 대시보드에서 관리합니다.

## 기술 스택

- **Frontend**: React (기존 fr-workwear-app)
- **Backend**: Supabase (Edge Functions + PostgreSQL + Cron)
- **External**: 조달청 OpenAPI (data.go.kr), Resend (이메일)
- **언어**: 모든 UI 텍스트와 주석은 한국어

## Phase 구성

| Phase | 내용 | 예상 소요 | 파일 |
|-------|------|----------|------|
| Phase 1 | DB 스키마 + Edge Function으로 입찰공고 수집·필터링·적재 | 2~3일 | `phase-1-data-collection.md` |
| Phase 2 | Resend 이메일 알림 + React 대시보드 메인 페이지 | 3~4일 | `phase-2-notification-dashboard.md` |
| Phase 3 | 낙찰·계약 API 추가 + 경쟁사 분석 화면 + 키워드 관리 UI | 4~5일 | `phase-3-bid-results-analysis.md` |
| Phase 4 | 마감 임박 알림 + 변경이력 추적 + 워크플로우 + 카카오 알림톡 | 1~2주 | `phase-4-advanced-features.md` |

## 진행 순서

1. **`00-prerequisites.md`** — 시작 전 수동 준비 작업 (인증키 발급, 환경변수, Resend 가입 등)
2. **`phase-1-data-collection.md`** — DB와 데이터 수집 파이프라인 구축
3. **각 Phase 동작 검증** 후 다음 Phase 진행
4. **`shared-reference.md`** — 모든 Phase에서 공통 참조하는 자료 (조달청 API 명세, 키워드 사전, 컨벤션)

## Claude Code 사용 방법

각 Phase 파일을 Claude Code에 던질 때:

```
# 예시
@phase-1-data-collection.md 이 작업지시서대로 구현해줘. 
shared-reference.md도 참조해야 해.
완료하면 체크리스트 확인하고 PR 형태로 정리해줘.
```

Phase별로 끊어서 진행하는 이유:
- 한 Phase가 너무 길면 Claude Code 토큰 한도에 걸릴 수 있음
- 각 Phase는 독립적으로 동작 검증 가능 (Phase 1 끝나면 DB에 데이터 쌓이는지 확인 후 Phase 2 진입)
- 디버깅이 쉬워짐

## 핵심 원칙

1. **한국어 우선**: 모든 UI 라벨, 주석, 에러 메시지는 한국어
2. **navy(#1e3a5f) / orange 브랜딩** 유지 (NJ Safety 기존 톤)
3. **TypeScript strict 모드** 사용
4. **에러 처리 필수**: 외부 API 호출은 반드시 try-catch + 로깅
5. **환경변수 분리**: API 키, DB URL 등 절대 하드코딩 금지
6. **점진적 배포**: 각 Phase 완료 후 사용자 검증 → 다음 Phase

## 파일 목록

```
nj-bid-system/
├── README.md                          (이 파일)
├── 00-prerequisites.md                (수동 준비 작업)
├── shared-reference.md                (공통 참조 자료)
├── phase-1-data-collection.md         (Phase 1)
├── phase-2-notification-dashboard.md  (Phase 2)
├── phase-3-bid-results-analysis.md    (Phase 3)
└── phase-4-advanced-features.md       (Phase 4)
```
