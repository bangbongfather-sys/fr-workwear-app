# Phase 1: 데이터 수집 파이프라인

> **목표**: 매일 새벽 3시(KST)에 자동으로 조달청 입찰공고를 가져와서, 방염복 관련 공고만 필터링해 Supabase DB에 적재.
>
> **검증 기준**: Phase 1 완료 시점에 DB에 매일 신규 매칭 공고가 자동으로 쌓이는 것을 확인할 수 있어야 함.

## 사전 조건

- [x] `00-prerequisites.md` 완료
- [x] `shared-reference.md` 내용 숙지

## Phase 1 산출물

```
fr-workwear-app/
├── src/features/tenders/types/index.ts           ← TypeScript 타입 정의
└── supabase/
    ├── migrations/
    │   └── 20260524_create_tender_tables.sql     ← DB 스키마
    └── functions/
        ├── _shared/
        │   ├── g2b-client.ts                     ← 조달청 API 클라이언트
        │   ├── matcher.ts                        ← 키워드 매칭 로직
        │   └── date-utils.ts                     ← KST 시간 처리
        └── poll-tenders/
            ├── index.ts                          ← 메인 함수
            └── deno.json
```

---

## Step 1. DB 마이그레이션 작성

**파일**: `supabase/migrations/20260524_create_tender_tables.sql`

```sql
-- =========================================
-- NJ Safety 입찰 모니터링 - Phase 1 스키마
-- =========================================

-- 1. 입찰공고 마스터 테이블
CREATE TABLE tenders (
  id BIGSERIAL PRIMARY KEY,
  bid_ntce_no TEXT NOT NULL,
  bid_ntce_ord TEXT DEFAULT '00',
  bid_ntce_nm TEXT NOT NULL,
  ntce_instt_nm TEXT,
  dminstt_nm TEXT,
  bsns_div_nm TEXT,
  prdct_clsfc_no TEXT,
  prdct_clsfc_no_nm TEXT,
  presmpt_prce NUMERIC,
  bid_begin_dt TIMESTAMPTZ,
  bid_clse_dt TIMESTAMPTZ,
  opengm_dt TIMESTAMPTZ,
  bid_ntce_url TEXT,
  ntce_kind_nm TEXT,
  match_score INT NOT NULL DEFAULT 0,
  matched_keywords TEXT[] DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'reviewed', 'applied', 'won', 'lost', 'skipped')),
  notified_at TIMESTAMPTZ,
  raw_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bid_ntce_no, bid_ntce_ord)
);

CREATE INDEX idx_tenders_clse_dt ON tenders(bid_clse_dt DESC);
CREATE INDEX idx_tenders_status ON tenders(status);
CREATE INDEX idx_tenders_score ON tenders(match_score DESC);
CREATE INDEX idx_tenders_created ON tenders(created_at DESC);

-- updated_at 자동 갱신 트리거
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tenders_updated_at
  BEFORE UPDATE ON tenders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 2. 키워드 사전
CREATE TABLE tender_keywords (
  id BIGSERIAL PRIMARY KEY,
  keyword TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL
    CHECK (category IN ('core', 'material', 'standard', 'usage', 'exclude')),
  weight INT NOT NULL DEFAULT 3,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. 시드 데이터 (shared-reference.md의 키워드 사전 그대로)
INSERT INTO tender_keywords (keyword, category, weight) VALUES
  ('방염복', 'core', 10),
  ('난연복', 'core', 10),
  ('방화복', 'core', 10),
  ('내열복', 'core', 8),
  ('아라미드복', 'core', 9),
  ('내염복', 'core', 8),
  ('방염작업복', 'core', 10),
  ('아라미드', 'material', 7),
  ('메타아라미드', 'material', 7),
  ('파라아라미드', 'material', 7),
  ('Nomex', 'material', 7),
  ('Arawin', 'material', 7),
  ('Kevlar', 'material', 5),
  ('아크플래시', 'standard', 8),
  ('NFPA 70E', 'standard', 7),
  ('IEC 61482', 'standard', 7),
  ('EN ISO 11612', 'standard', 7),
  ('KS K 0590', 'standard', 7),
  ('전기작업복', 'usage', 4),
  ('용접복', 'usage', 4),
  ('소방활동복', 'usage', 5),
  ('산불진화복', 'usage', 6),
  ('방염커튼', 'exclude', -20),
  ('방염도료', 'exclude', -20),
  ('방염시트', 'exclude', -20),
  ('방염페인트', 'exclude', -20),
  ('방염필름', 'exclude', -20);

-- 4. 수집 로그 (Phase 1 디버깅용)
CREATE TABLE tender_poll_logs (
  id BIGSERIAL PRIMARY KEY,
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  inqry_bgn_dt TEXT,
  inqry_end_dt TEXT,
  total_fetched INT NOT NULL DEFAULT 0,
  total_matched INT NOT NULL DEFAULT 0,
  total_inserted INT NOT NULL DEFAULT 0,
  duration_ms INT,
  status TEXT NOT NULL DEFAULT 'success'
    CHECK (status IN ('success', 'partial', 'failed')),
  error_msg TEXT
);

CREATE INDEX idx_poll_logs_run_at ON tender_poll_logs(run_at DESC);

-- 5. RLS 활성화
ALTER TABLE tenders ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender_poll_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_all_tenders" ON tenders
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "authenticated_all_keywords" ON tender_keywords
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "authenticated_read_logs" ON tender_poll_logs
  FOR SELECT TO authenticated USING (true);
```

**적용 방법**:
```bash
supabase db push
# 또는 대시보드 SQL Editor에서 실행
```

**검증**:
- Supabase 대시보드 → Table Editor → `tenders`, `tender_keywords`, `tender_poll_logs` 3개 테이블 확인
- `tender_keywords` 테이블에 27개 행이 INSERT 되었는지 확인

---

## Step 2. 공통 모듈 작성

### 2-1. `supabase/functions/_shared/date-utils.ts`

```typescript
/** KST 변환 */
export function toKST(date: Date = new Date()): Date {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000)
}

/** 조달청 API용 datetime 포맷 (YYYYMMDDHHMM) */
export function formatG2BDatetime(date: Date): string {
  const kst = toKST(date)
  const y = kst.getUTCFullYear()
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0')
  const d = String(kst.getUTCDate()).padStart(2, '0')
  const h = String(kst.getUTCHours()).padStart(2, '0')
  const min = String(kst.getUTCMinutes()).padStart(2, '0')
  return `${y}${m}${d}${h}${min}`
}

/** 어제 00:00 ~ 23:59 (KST) 범위 반환 */
export function getYesterdayRangeKST(): { bgn: string; end: string } {
  const now = new Date()
  const kst = toKST(now)
  kst.setUTCDate(kst.getUTCDate() - 1)
  const y = kst.getUTCFullYear()
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0')
  const d = String(kst.getUTCDate()).padStart(2, '0')
  const ymd = `${y}${m}${d}`
  return { bgn: `${ymd}0000`, end: `${ymd}2359` }
}

/** 조달청 API 응답의 날짜 문자열을 ISO 8601로 변환 */
export function parseG2BDate(s: string | null | undefined): string | null {
  if (!s) return null
  // 형식: "2026-05-22 10:00:00" 또는 "20260522100000"
  let normalized = s.trim()
  if (/^\d{14}$/.test(normalized)) {
    normalized = `${normalized.slice(0,4)}-${normalized.slice(4,6)}-${normalized.slice(6,8)} ${normalized.slice(8,10)}:${normalized.slice(10,12)}:${normalized.slice(12,14)}`
  }
  // KST 가정 → ISO 8601 변환
  return new Date(normalized.replace(' ', 'T') + '+09:00').toISOString()
}
```

### 2-2. `supabase/functions/_shared/g2b-client.ts`

```typescript
const BASE_URL = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService'

export interface G2BTenderItem {
  bidNtceNo: string
  bidNtceOrd?: string
  bidNtceNm: string
  ntceInsttNm?: string
  dminsttNm?: string
  bsnsDivNm?: string
  prdctClsfcNo?: string
  prdctClsfcNoNm?: string
  presmptPrce?: string
  bidBeginDt?: string
  bidClseDt?: string
  opengDt?: string
  bidNtceUrl?: string
  ntceKindNm?: string
  [key: string]: any
}

export interface G2BResponse<T> {
  response: {
    header: { resultCode: string; resultMsg: string }
    body: {
      items: T[] | ''
      totalCount: number
      pageNo: number
      numOfRows: number
    }
  }
}

const SERVICE_KEY = Deno.env.get('G2B_SERVICE_KEY')
if (!SERVICE_KEY) {
  throw new Error('G2B_SERVICE_KEY environment variable is required')
}

/** 재시도 로직이 포함된 fetch */
async function fetchWithRetry(url: string, retries = 3): Promise<any> {
  let lastError: Error | null = null
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const code = data.response?.header?.resultCode
      if (code !== '00') {
        throw new Error(`G2B Error [${code}]: ${data.response?.header?.resultMsg}`)
      }
      return data
    } catch (err) {
      lastError = err as Error
      console.warn(`[G2B] Attempt ${i + 1}/${retries} failed: ${lastError.message}`)
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)))
      }
    }
  }
  throw lastError
}

/** 입찰공고(물품) 페이징 전체 수집 */
export async function fetchAllThngTenders(
  inqryBgnDt: string,
  inqryEndDt: string,
): Promise<G2BTenderItem[]> {
  const results: G2BTenderItem[] = []
  let pageNo = 1
  const numOfRows = 500
  
  while (true) {
    const url = `${BASE_URL}/getBidPblancListInfoThngPPSSrch` +
      `?serviceKey=${encodeURIComponent(SERVICE_KEY!)}` +
      `&pageNo=${pageNo}&numOfRows=${numOfRows}` +
      `&inqryDiv=1&inqryBgnDt=${inqryBgnDt}&inqryEndDt=${inqryEndDt}` +
      `&type=json`
    
    const data: G2BResponse<G2BTenderItem> = await fetchWithRetry(url)
    const items = data.response.body.items
    
    if (!items || items === '' || (Array.isArray(items) && items.length === 0)) {
      break
    }
    
    results.push(...(items as G2BTenderItem[]))
    
    const fetched = (items as G2BTenderItem[]).length
    if (fetched < numOfRows) break
    
    pageNo++
    // 안전장치: 최대 20페이지(10,000건)까지만
    if (pageNo > 20) {
      console.warn('[G2B] Reached max page limit (20)')
      break
    }
    
    // API rate limit 보호
    await new Promise(r => setTimeout(r, 200))
  }
  
  return results
}
```

### 2-3. `supabase/functions/_shared/matcher.ts`

```typescript
import { createClient } from 'jsr:@supabase/supabase-js@2'

export interface KeywordRow {
  keyword: string
  category: string
  weight: number
}

export interface MatchResult {
  score: number
  matchedKeywords: string[]
}

/** 텍스트에 대해 키워드 매칭 + 점수 산출 */
export function calculateMatchScore(text: string, keywords: KeywordRow[]): MatchResult {
  const lower = text.toLowerCase()
  let score = 0
  const matched: string[] = []
  
  for (const kw of keywords) {
    if (lower.includes(kw.keyword.toLowerCase())) {
      score += kw.weight
      if (kw.weight > 0) {
        matched.push(kw.keyword)
      }
    }
  }
  
  return { score, matchedKeywords: matched }
}

/** Supabase에서 활성 키워드 로드 */
export async function loadActiveKeywords(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<KeywordRow[]> {
  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const { data, error } = await supabase
    .from('tender_keywords')
    .select('keyword, category, weight')
    .eq('is_active', true)
  
  if (error) throw new Error(`키워드 로드 실패: ${error.message}`)
  return data ?? []
}
```

---

## Step 3. Edge Function 작성

### 3-1. `supabase/functions/poll-tenders/deno.json`

```json
{
  "imports": {
    "@supabase/supabase-js": "jsr:@supabase/supabase-js@2"
  }
}
```

### 3-2. `supabase/functions/poll-tenders/index.ts`

```typescript
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { fetchAllThngTenders } from '../_shared/g2b-client.ts'
import { calculateMatchScore, loadActiveKeywords } from '../_shared/matcher.ts'
import { getYesterdayRangeKST, parseG2BDate } from '../_shared/date-utils.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const MATCH_THRESHOLD = Number(Deno.env.get('MATCH_THRESHOLD') ?? '7')

interface RunResult {
  fetched: number
  matched: number
  inserted: number
  durationMs: number
  matchedTenders: any[]
}

async function runPoll(bgn: string, end: string): Promise<RunResult> {
  const startTime = Date.now()
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  
  console.log(`[poll-tenders] 시작: ${bgn} ~ ${end}`)
  
  // 1. 키워드 로드
  const keywords = await loadActiveKeywords(SUPABASE_URL, SERVICE_ROLE_KEY)
  console.log(`[poll-tenders] 활성 키워드 ${keywords.length}개 로드`)
  
  // 2. 조달청 API 호출
  const items = await fetchAllThngTenders(bgn, end)
  console.log(`[poll-tenders] 수집 완료: ${items.length}건`)
  
  // 3. 매칭 + DB 적재
  const matchedRows: any[] = []
  for (const item of items) {
    const text = `${item.bidNtceNm} ${item.prdctClsfcNoNm ?? ''}`
    const { score, matchedKeywords } = calculateMatchScore(text, keywords)
    
    if (score < MATCH_THRESHOLD) continue
    
    matchedRows.push({
      bid_ntce_no: item.bidNtceNo,
      bid_ntce_ord: item.bidNtceOrd ?? '00',
      bid_ntce_nm: item.bidNtceNm,
      ntce_instt_nm: item.ntceInsttNm ?? null,
      dminstt_nm: item.dminsttNm ?? null,
      bsns_div_nm: '물품',
      prdct_clsfc_no: item.prdctClsfcNo ?? null,
      prdct_clsfc_no_nm: item.prdctClsfcNoNm ?? null,
      presmpt_prce: item.presmptPrce ? Number(item.presmptPrce) : null,
      bid_begin_dt: parseG2BDate(item.bidBeginDt),
      bid_clse_dt: parseG2BDate(item.bidClseDt),
      opengm_dt: parseG2BDate(item.opengDt),
      bid_ntce_url: item.bidNtceUrl ?? null,
      ntce_kind_nm: item.ntceKindNm ?? null,
      match_score: score,
      matched_keywords: matchedKeywords,
      raw_data: item,
    })
  }
  
  console.log(`[poll-tenders] 매칭 완료: ${matchedRows.length}건`)
  
  // 4. Upsert (중복 시 update)
  let inserted = 0
  if (matchedRows.length > 0) {
    const { data, error } = await supabase
      .from('tenders')
      .upsert(matchedRows, {
        onConflict: 'bid_ntce_no,bid_ntce_ord',
        ignoreDuplicates: false,
      })
      .select('id')
    
    if (error) throw new Error(`DB 적재 실패: ${error.message}`)
    inserted = data?.length ?? 0
  }
  
  const durationMs = Date.now() - startTime
  
  // 5. 로그 적재
  await supabase.from('tender_poll_logs').insert({
    inqry_bgn_dt: bgn,
    inqry_end_dt: end,
    total_fetched: items.length,
    total_matched: matchedRows.length,
    total_inserted: inserted,
    duration_ms: durationMs,
    status: 'success',
  })
  
  return {
    fetched: items.length,
    matched: matchedRows.length,
    inserted,
    durationMs,
    matchedTenders: matchedRows,
  }
}

Deno.serve(async (req) => {
  try {
    // 수동 호출 시 ?bgn=YYYYMMDDHHMM&end=YYYYMMDDHHMM 으로 범위 지정 가능
    const url = new URL(req.url)
    const bgnParam = url.searchParams.get('bgn')
    const endParam = url.searchParams.get('end')
    
    const { bgn, end } = (bgnParam && endParam)
      ? { bgn: bgnParam, end: endParam }
      : getYesterdayRangeKST()
    
    const result = await runPoll(bgn, end)
    
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.error('[poll-tenders] 실패:', errorMsg)
    
    // 실패 로그
    try {
      const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
      await supabase.from('tender_poll_logs').insert({
        status: 'failed',
        error_msg: errorMsg,
      })
    } catch {}
    
    return new Response(JSON.stringify({ error: errorMsg }), {
      headers: { 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
```

---

## Step 4. TypeScript 타입 정의 (프론트엔드용)

### 4-1. `src/features/tenders/types/index.ts`

shared-reference.md의 4-2 섹션 그대로 사용. 추가로:

```typescript
export interface TenderPollLog {
  id: number
  run_at: string
  inqry_bgn_dt: string | null
  inqry_end_dt: string | null
  total_fetched: number
  total_matched: number
  total_inserted: number
  duration_ms: number | null
  status: 'success' | 'partial' | 'failed'
  error_msg: string | null
}
```

---

## Step 5. Cron 스케줄 등록

Supabase SQL Editor에서 실행:

```sql
-- KST 03:00 = UTC 18:00
SELECT cron.schedule(
  'poll-tenders-daily',
  '0 18 * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/poll-tenders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY'
    ),
    timeout_milliseconds := 60000
  ) as request_id;
  $$
);

-- 등록 확인
SELECT * FROM cron.job WHERE jobname = 'poll-tenders-daily';

-- 실행 이력 확인
SELECT * FROM cron.job_run_details 
  WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'poll-tenders-daily')
  ORDER BY start_time DESC LIMIT 10;
```

> ⚠️ `YOUR_PROJECT_REF`, `YOUR_SERVICE_ROLE_KEY` 는 본인 값으로 교체. SERVICE_ROLE_KEY는 보안상 민감하므로, Supabase Vault에 저장해 참조하는 방식이 더 좋음 (개선사항으로 노트).

---

## Step 6. 배포 및 검증

### 6-1. 배포
```bash
cd fr-workwear-app

# 마이그레이션
supabase db push

# Edge Function 배포
supabase functions deploy poll-tenders --no-verify-jwt
# (--no-verify-jwt: Cron에서 호출하려면 필요)
```

### 6-2. 수동 테스트

**과거 7일 데이터로 테스트** (실제 결과가 있을 확률 높음):

```bash
# YYYYMMDDHHMM 형식
curl -X POST "https://YOUR_PROJECT_REF.supabase.co/functions/v1/poll-tenders?bgn=202605160000&end=202605221200" \
  -H "Authorization: Bearer YOUR_ANON_KEY"
```

**기대 응답 예시**:
```json
{
  "fetched": 18234,
  "matched": 5,
  "inserted": 5,
  "durationMs": 12345,
  "matchedTenders": [
    {
      "bid_ntce_nm": "방염복 50착 구매",
      "dminstt_nm": "○○소방서",
      "match_score": 17,
      "matched_keywords": ["방염복", "아라미드"]
      // ...
    }
  ]
}
```

### 6-3. DB 확인

Supabase 대시보드 → Table Editor → `tenders` 테이블에 행이 들어와 있는지 확인.

### 6-4. 로그 확인
```sql
SELECT * FROM tender_poll_logs ORDER BY run_at DESC LIMIT 5;
```

---

## Phase 1 완료 체크리스트

- [ ] `tenders`, `tender_keywords`, `tender_poll_logs` 3개 테이블 생성됨
- [ ] `tender_keywords`에 27개 키워드 시드 데이터 삽입됨
- [ ] `poll-tenders` Edge Function 배포 성공
- [ ] 수동 호출로 과거 데이터 수집 성공 (`fetched > 0`)
- [ ] 매칭된 공고 1건 이상 DB에 저장됨 (테스트 기간을 길게 잡으면 보통 발견됨)
- [ ] Cron 스케줄 등록 완료 (`cron.job` 조회로 확인)
- [ ] 다음 날 새벽 3시에 자동 실행 + `tender_poll_logs`에 success 로그 1건 생성됨

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| `resultCode: 22` | 일일 호출한도 초과 | 다음날 대기, 또는 운영계정 신청 |
| `resultCode: 30` | 인증키 오류 | Decoding 키 다시 확인 |
| `items: ""` | 해당 기간 데이터 없음 | 정상 (검색 기간 확장 시도) |
| 매칭 0건 | 임계값 너무 높음 | `MATCH_THRESHOLD` 환경변수 5로 낮춰서 재시도 |
| Cron 실행 안 됨 | `pg_cron`, `pg_net` 미활성화 | Extensions 확인 |
| 503 타임아웃 빈발 | 조달청 API 점검 | 재시도 로직이 처리, 3회 실패 시 다음 날 재시도 |

---

## Phase 1 → Phase 2 진입 조건

다음 모두 충족 시 Phase 2 진행:
- ✅ 자동 폴링이 최소 2일 연속 정상 동작
- ✅ 누적 매칭 공고 1건 이상 (없으면 임계값 조정해서 강제로라도 확보)
- ✅ `tenders` 테이블 조회로 데이터 구조 확인 완료

Phase 2에서는 이 데이터를 기반으로 이메일 알림과 React 대시보드를 만듭니다.
