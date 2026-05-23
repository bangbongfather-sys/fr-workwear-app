# 공통 참조 자료 (Shared Reference)

> 모든 Phase에서 공통으로 참조하는 자료입니다. Claude Code에 작업 지시 시 반드시 이 파일도 함께 첨부하세요.

## 1. 조달청 OpenAPI 명세

### 1-1. 기본 정보

| 항목 | 값 |
|------|------|
| 베이스 URL | `https://apis.data.go.kr/1230000/ad/BidPublicInfoService` |
| 인증 방식 | 쿼리스트링 `serviceKey={Decoding 키}` |
| 응답 형식 | `&type=json` 권장 |
| 페이징 | `pageNo`, `numOfRows` (최대 999, 권장 500) |
| 일일 호출한도 | 개발계정 1,000회/일 (운영계정 10,000회/일) |

### 1-2. 핵심 오퍼레이션

**입찰공고 (Phase 1)**
- 물품 검색: `getBidPblancListInfoThngPPSSrch`
- 용역 검색: `getBidPblancListInfoServcPPSSrch`
- 공사 검색: `getBidPblancListInfoCnstwkPPSSrch`
- 외자 검색: `getBidPblancListInfoFrgcptPPSSrch`
- 공고 상세: `getBidPblancListInfoThng`
- 변경이력: `getBidPblancListInfoChgHstry`

방염복은 거의 **물품(Thng)** 으로 발주됩니다. 용역/공사는 Phase 4에서 추가 검토.

**낙찰정보 (Phase 3)**
- 물품 개찰결과: `getOpengResultListInfoThng`
- 물품 낙찰자: `getScsbidListSttusThng`

**계약정보 (Phase 3)**
- 물품 계약목록: `getCntrctInfoListThng`
- 계약 상세: `getCntrctInfoListThngDtl`

### 1-3. 필수 파라미터 (입찰공고 검색)

```
serviceKey   : Decoding 인증키
pageNo       : 페이지 번호 (1부터)
numOfRows    : 페이지당 건수 (1~999, 권장 500)
inqryDiv     : 조회구분 (1=공고게시일, 2=개찰일)
inqryBgnDt   : 조회시작일시 (YYYYMMDDHHMM, 예: 202605220000)
inqryEndDt   : 조회종료일시 (YYYYMMDDHHMM)
type         : 응답형식 (json | xml)
```

### 1-4. 주요 응답 필드 (입찰공고)

| 필드명 | 한글명 | 비고 |
|--------|--------|------|
| `bidNtceNo` | 입찰공고번호 | PK |
| `bidNtceOrd` | 공고차수 | 정정공고 시 증가 |
| `bidNtceNm` | 공고명 | 키워드 매칭 대상 |
| `ntceInsttNm` | 공고기관 | 조달청 등 |
| `dminsttNm` | 수요기관 | 실수요처 (한전, 소방서 등) |
| `bsnsDivNm` | 업무구분 | 물품/용역/공사/외자 |
| `prdctClsfcNo` | 세부품명번호 | 분류코드 |
| `prdctClsfcNoNm` | 세부품명 | 키워드 매칭 대상 |
| `presmptPrce` | 추정가격 | 원 단위 |
| `bidBeginDt` | 입찰개시일시 | |
| `bidClseDt` | 입찰마감일시 | 알림 우선순위 |
| `opengDt` | 개찰일시 | |
| `bidNtceUrl` | 공고상세 URL | |
| `ntceKindNm` | 공고종류 | 일반/정정/취소/긴급 |

### 1-5. 응답 구조 예시

```json
{
  "response": {
    "header": { "resultCode": "00", "resultMsg": "NORMAL SERVICE." },
    "body": {
      "items": [
        {
          "bidNtceNo": "20260523001",
          "bidNtceNm": "방염복 50착 구매",
          "ntceInsttNm": "조달청",
          "dminsttNm": "○○소방서",
          "presmptPrce": "15000000",
          ...
        }
      ],
      "totalCount": 123,
      "pageNo": 1,
      "numOfRows": 500
    }
  }
}
```

### 1-6. 에러 케이스 주의사항

- `resultCode: "00"` 이외는 에러
- 트래픽 초과 시 `resultCode: "22"` (요청 제한)
- 응답에 `items`가 빈 문자열 `""` 로 올 수 있음 (구버전 API 호환 처리)
- 일시적 503/타임아웃 자주 발생 → 재시도 로직 필수 (3회, exponential backoff)

---

## 2. 키워드 사전 (Phase 1 시드 데이터)

```sql
INSERT INTO tender_keywords (keyword, category, weight) VALUES
  -- 핵심 키워드 (제품명 직접 매칭)
  ('방염복', 'core', 10),
  ('난연복', 'core', 10),
  ('방화복', 'core', 10),
  ('내열복', 'core', 8),
  ('아라미드복', 'core', 9),
  ('내염복', 'core', 8),
  ('방염작업복', 'core', 10),

  -- 소재 키워드
  ('아라미드', 'material', 7),
  ('메타아라미드', 'material', 7),
  ('파라아라미드', 'material', 7),
  ('Nomex', 'material', 7),
  ('Arawin', 'material', 7),
  ('Kevlar', 'material', 5),

  -- 규격/인증 키워드
  ('아크플래시', 'standard', 8),
  ('NFPA 70E', 'standard', 7),
  ('IEC 61482', 'standard', 7),
  ('EN ISO 11612', 'standard', 7),
  ('KS K 0590', 'standard', 7),

  -- 용도 키워드 (낮은 가중치)
  ('전기작업복', 'usage', 4),
  ('용접복', 'usage', 4),
  ('소방활동복', 'usage', 5),
  ('산불진화복', 'usage', 6),

  -- 제외 키워드 (음수 가중치, 오탐 방지)
  ('방염커튼', 'exclude', -20),
  ('방염도료', 'exclude', -20),
  ('방염시트', 'exclude', -20),
  ('방염페인트', 'exclude', -20),
  ('방염필름', 'exclude', -20);
```

**임계값**: `match_score >= 7` 인 공고만 적재 (조정 가능)

---

## 3. NJ Safety 디자인 컨벤션

### 3-1. 컬러

```css
--nj-navy: #1e3a5f;
--nj-navy-light: #2c5282;
--nj-orange: #ff6b35;
--nj-orange-light: #ff8c61;
--nj-bg: #f7f9fc;
--nj-text: #1a202c;
--nj-text-muted: #718096;
--nj-border: #e2e8f0;
--nj-success: #38a169;
--nj-warning: #d69e2e;
--nj-danger: #e53e3e;
```

### 3-2. 폰트

- 본문: `'Pretendard', -apple-system, sans-serif`
- 숫자/금액: `tabular-nums` 적용
- 헤딩: 700 weight
- 본문: 400 weight

### 3-3. 컴포넌트 패턴

- Tailwind CSS 기반
- shadcn/ui 컴포넌트 우선 사용 (기존 fr-workwear-app에 이미 있다면)
- 카드 그림자: `shadow-sm` 기본, hover 시 `shadow-md`
- 둥근 모서리: `rounded-lg` (8px)
- 모든 인터랙티브 요소에 `transition-colors` 또는 `transition-shadow`

### 3-4. 마감 임박 색상 규칙 (Phase 2~)

| 남은 시간 | 색상 | Tailwind |
|----------|------|----------|
| D-1 이내 | 빨강 | `text-red-600 bg-red-50` |
| D-3 이내 | 주황 | `text-orange-600 bg-orange-50` |
| D-7 이내 | 노랑 | `text-yellow-700 bg-yellow-50` |
| D-7 이후 | 회색 | `text-gray-600` |

---

## 4. 코딩 컨벤션

### 4-1. 파일 구조 (제안)

```
fr-workwear-app/
├── src/
│   ├── features/
│   │   └── tenders/                  ← 입찰 관련 모든 코드
│   │       ├── api/                  ← Supabase 쿼리
│   │       ├── components/           ← React 컴포넌트
│   │       ├── hooks/                ← useTenders, useKeywords 등
│   │       ├── types/                ← TypeScript 타입
│   │       ├── utils/                ← 매칭 점수, 포맷터
│   │       └── pages/                ← /tenders 라우트 페이지들
│   └── ...
└── supabase/
    ├── functions/
    │   ├── poll-tenders/             ← Phase 1
    │   ├── send-notification/        ← Phase 2
    │   ├── poll-bid-results/         ← Phase 3
    │   ├── poll-contracts/           ← Phase 3
    │   └── _shared/                  ← 공통 모듈 (g2b-client, formatters)
    └── migrations/
        ├── 20260524_create_tender_tables.sql      ← Phase 1
        ├── 20260601_create_notifications.sql      ← Phase 2
        └── ...
```

### 4-2. TypeScript 타입 (Phase 1에서 정의)

```typescript
// src/features/tenders/types/index.ts

export type TenderStatus = 'new' | 'reviewed' | 'applied' | 'won' | 'lost' | 'skipped'

export interface Tender {
  id: number
  bid_ntce_no: string
  bid_ntce_ord: string | null
  bid_ntce_nm: string
  ntce_instt_nm: string | null
  dminstt_nm: string | null
  bsns_div_nm: string | null
  prdct_clsfc_no: string | null
  prdct_clsfc_no_nm: string | null
  presmpt_prce: number | null
  bid_begin_dt: string | null
  bid_clse_dt: string | null
  opengm_dt: string | null
  bid_ntce_url: string | null
  match_score: number
  matched_keywords: string[]
  status: TenderStatus
  notified_at: string | null
  created_at: string
}

export interface TenderKeyword {
  id: number
  keyword: string
  category: 'core' | 'material' | 'standard' | 'usage' | 'exclude'
  weight: number
  is_active: boolean
}

export interface BidResult {
  id: number
  bid_ntce_no: string
  opengm_rslt_div_nm: string | null
  scsbid_amt: number | null
  scsbid_rate: number | null
  scsbid_corp_nm: string | null
  scsbid_corp_bizno: string | null
  opengm_dt: string | null
}

export interface Contract {
  id: number
  cntrct_no: string
  bid_ntce_no: string | null
  cntrct_nm: string | null
  cntrct_cncls_dt: string | null
  cntrct_amt: number | null
  cntrctr_nm: string | null
  cntrct_instt_nm: string | null
}
```

### 4-3. 네이밍 규칙

- DB 컬럼: `snake_case` (조달청 API의 camelCase는 변환해서 저장)
- TypeScript 변수: `camelCase`
- React 컴포넌트: `PascalCase`
- Supabase Edge Function 디렉토리: `kebab-case`
- 한국어 라벨은 별도 i18n 파일 없이 인라인으로 (1인 프로젝트라 오버엔지니어링 회피)

### 4-4. 에러 처리 원칙

```typescript
// 외부 API 호출은 반드시 재시도 + 로깅
async function callG2BWithRetry(url: string, retries = 3): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (data.response?.header?.resultCode !== '00') {
        throw new Error(`G2B Error: ${data.response?.header?.resultMsg}`)
      }
      return data
    } catch (err) {
      console.error(`[G2B] Attempt ${i + 1} failed:`, err)
      if (i === retries - 1) throw err
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)))
    }
  }
}
```

### 4-5. 한국 시간(KST) 처리

```typescript
// KST는 UTC+9
function toKST(date: Date = new Date()): Date {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000)
}

function formatKSTDate(date: Date): string {
  return toKST(date).toISOString().slice(0, 10).replace(/-/g, '')
}

// 조달청 API용 datetime 포맷 (YYYYMMDDHHMM)
function formatG2BDatetime(date: Date): string {
  const kst = toKST(date)
  return kst.toISOString().slice(0, 16).replace(/[-:T]/g, '')
}
```

---

## 5. Supabase 보안 정책 (RLS)

1인 사용 프로젝트지만, 최소한의 보안은 유지:

```sql
-- 모든 테이블에 RLS 활성화
ALTER TABLE tenders ENABLE ROW LEVEL SECURITY;
ALTER TABLE bid_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications_log ENABLE ROW LEVEL SECURITY;

-- 인증된 사용자(supabase auth)만 읽기/쓰기 가능
CREATE POLICY "authenticated_read" ON tenders
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "authenticated_update" ON tenders
  FOR UPDATE TO authenticated USING (true);

-- service_role(Edge Function)은 RLS 자동 우회되므로 별도 정책 불필요
```

향후 팀 확장 시 user_id 컬럼 추가하여 멀티유저 대응.

---

## 6. 참고 링크

- 조달청 OpenAPI 가이드: https://www.data.go.kr/data/15129394/openapi.do
- Supabase Edge Functions: https://supabase.com/docs/guides/functions
- Supabase Cron: https://supabase.com/docs/guides/database/extensions/pg_cron
- Resend API: https://resend.com/docs/api-reference/emails/send-email
- 카카오 알림톡 (Phase 4): https://kakaobusiness.gitbook.io/main/tool/bizmessage/notice_friendtalk
