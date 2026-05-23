# Phase 1 — RTDB 스키마 결정사항 (B안 / Firebase RTDB 적용)

> 작업지시서 `phase-1-data-collection.md`의 PostgreSQL DDL을 Firebase RTDB 구조로 변환한 결정사항.

## 결정 컨벤션 (Phase 1 전체에 적용)

| 항목 | 결정 |
|---|---|
| **백엔드** | Cloudflare Worker (기존 `worker.js`) + Firebase RTDB (기존 `frw.json`과 동일 DB) |
| **신규 데이터 노드** | `tenders/` (top-level, 기존 `frw.json`과 형제) |
| **언어** | Worker 신규 코드는 TypeScript (`.ts`), 기존 `worker.js`는 그대로 유지 |
| **컬럼 네이밍** | **camelCase** (예: `bidClseDt`, `matchScore`) — fr-workwear-app 기존 패턴 |
| **시간 표현** | ISO 8601 문자열 (`"2026-05-22T03:00:00+09:00"` 또는 UTC `"2026-05-22T03:00:00.000Z"`) |
| **Firebase 키 안전화** | `.`, `$`, `#`, `[`, `]`, `/` → `_` 치환 (`noticeKey` 헬퍼) |
| **인증/RLS** | 기존 Firebase 규칙 `auth != null` 그대로. Worker는 `FIREBASE_DB_SECRET`(admin)로 접근 |

## RTDB 노드 구조

```
Firebase RTDB (njsafety-2ee24-default-rtdb)
│
├── frw.json                       (기존 회사 데이터 — 영향 없음)
├── frw_backup_YYYY-MM-DD.json     (기존 일일 백업 — 영향 없음)
│
└── tenders/                       ← 신규
    │
    ├── keywords/                  ← 키워드 사전 (RDBMS tender_keywords 대체)
    │   └── {auto-id}/
    │       ├── keyword         : "방염복"
    │       ├── category        : "core" | "material" | "standard" | "usage" | "exclude"
    │       ├── weight          : 10
    │       ├── isActive        : true
    │       └── createdAt       : "2026-05-23T22:30:00.000Z"
    │
    ├── notices/                   ← 수집된 공고 (RDBMS tenders 대체)
    │   └── {bidNtceNo}_{bidNtceOrd}/   ← 복합 키 (PG UNIQUE 제약 대체)
    │       ├── bidNtceNo       : "20260523-00012"
    │       ├── bidNtceOrd      : "00"
    │       ├── bidNtceNm       : "방염복 50착 구매"
    │       ├── ntceInsttNm     : "조달청"
    │       ├── dminsttNm       : "○○소방서"
    │       ├── bsnsDivNm       : "물품"
    │       ├── prdctClsfcNo    : "..."
    │       ├── prdctClsfcNoNm  : "방염복"
    │       ├── presmptPrce     : 15000000
    │       ├── bidBeginDt      : "2026-05-23T10:00:00+09:00"
    │       ├── bidClseDt       : "2026-05-30T10:00:00+09:00"
    │       ├── opengmDt        : "2026-05-30T11:00:00+09:00"
    │       ├── bidNtceUrl      : "https://..."
    │       ├── ntceKindNm      : "일반"
    │       ├── matchScore      : 17
    │       ├── matchedKeywords : ["방염복", "아라미드"]
    │       ├── status          : "new"
    │       ├── notifiedAt      : null
    │       ├── rawData         : { ... 조달청 원본 응답 ... }
    │       ├── createdAt       : "2026-05-23T18:01:23.456Z"
    │       └── updatedAt       : "2026-05-23T18:01:23.456Z"
    │
    └── pollLogs/                  ← 수집 로그 (운영 모니터링)
        └── {auto-id}/
            ├── runAt           : "2026-05-23T18:00:01.234Z"
            ├── inqryBgnDt      : "202605220000"
            ├── inqryEndDt      : "202605222359"
            ├── totalFetched    : 18234
            ├── totalMatched    : 5
            ├── totalInserted   : 5
            ├── durationMs      : 12345
            ├── status          : "success" | "partial" | "failed"
            └── errorMsg        : null
```

## PostgreSQL DDL → RTDB 매핑 차이점

| PostgreSQL 기능 | RTDB 대응 |
|---|---|
| `BIGSERIAL PRIMARY KEY` | Firebase auto-id (push key) 또는 복합 키 |
| `UNIQUE (bid_ntce_no, bid_ntce_ord)` | 복합 키 `{bidNtceNo}_{bidNtceOrd}` 로 자연스럽게 보장 |
| `CHECK (status IN ('new', ...))` | TypeScript 타입 `TenderStatus`로 컴파일 타임 검증 |
| `TIMESTAMPTZ DEFAULT NOW()` | ISO 8601 문자열을 Worker 코드에서 명시 |
| `CREATE INDEX idx_tenders_clse_dt ON tenders(bid_clse_dt DESC)` | 필요 시 `.indexOn` 보안 규칙 추가 (Phase 2 검토) |
| `CREATE TRIGGER trg_tenders_updated_at` | Worker에서 upsert 시 `updatedAt` 직접 설정 |
| `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` | 기존 RTDB 규칙 `auth != null` 그대로 활용 |
| `CREATE POLICY "authenticated_*"` | 기존 정책 그대로 — Worker는 secret으로 우회, 클라이언트는 인증 우회 안 됨 |

## 데이터 인덱싱 전략

Phase 1에서는 데이터량 적음 (일일 매칭 공고 0~수 건, 6개월 누적 수십~수백 건). 클라이언트가 `tenders/notices` 전체를 fetch 후 메모리 필터링으로 충분.

Phase 2 이후 데이터 100건 이상이면 다음 인덱스 추가:

```json
// Firebase RTDB Rules
{
  "rules": {
    ...,
    "tenders": {
      "notices": {
        ".indexOn": ["bidClseDt", "matchScore", "status", "createdAt"]
      }
    }
  }
}
```

## 시드 데이터 (키워드 27개)

`worker-src/tenders/types.ts`의 `SEED_KEYWORDS` 상수로 코드화. Step 3 Worker 라우트 완성 후 Step 5 단계에서 일회성 등록:

```bash
# 예시 (Step 5에서 사용할 명령)
curl -X POST https://fr-workwear-app.njsafety91.workers.dev/api/tenders/seed-keywords
```

키워드를 코드 상수로 관리하는 이유:
- 재현 가능성 (앱 재배포·신규 머신에서도 동일 시드)
- 버전 관리 (git diff로 변경 이력 추적)
- 코드 리뷰 가능

향후 UI로 키워드 CRUD 추가 시(Phase 3) `isActive: false` 토글로 비활성화하거나 새 키워드 추가. 시드 키워드는 base set으로 유지.

## 매칭 임계값

- 기본값: `MATCH_THRESHOLD = 7` (작업지시서 그대로)
- override: Worker 환경변수 `MATCH_THRESHOLD`(plain var) 또는 wrangler secret
- 매칭 0건이면 Step 7 검증 단계에서 5로 낮춰 재시도 권장 (트러블슈팅 표 참조)

## 보안 검토

- ✅ `G2B_SERVICE_KEY`는 wrangler secret으로만 보관 (코드/Git/클라이언트 노출 0)
- ✅ Worker만 Firebase admin secret으로 `tenders/*` 노드 접근. 클라이언트는 기존 `/api/sync` 라우트 통해서만 접근 (`auth != null` 규칙)
- ✅ Edge에서 raw 조달청 응답을 `rawData`에 통째 저장 (재처리/디버깅용). 민감정보 포함 시 추가 검토 필요하나, 입찰 공고는 공개 정보라 문제 없음

## Phase 1 완료 후 Phase 2 진입 조건 (B안 기준)

- ✅ `tenders/keywords`에 27개 키워드 등록
- ✅ `tenders/notices`에 매칭 공고 1건 이상 존재 (수동 호출로 과거 7일 데이터 수집해 검증)
- ✅ Cloudflare Workers Cron Triggers가 매일 KST 3시(UTC 18시) 실행 → `tenders/pollLogs`에 `success` 로그 1건 이상
