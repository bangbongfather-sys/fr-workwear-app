# Phase 3: 낙찰·계약 데이터 + 경쟁사 분석

> **목표**: 입찰공고에 이어 ① 낙찰결과와 ② 계약체결 정보를 자동 수집하여, "어떤 경쟁사가 어디에서 얼마에 낙찰받고 실제 계약금액은 얼마였는지" 추적 가능한 시스템 완성.
>
> **검증 기준**: 공고-낙찰-계약이 자동으로 연결되어 한 화면에서 보이고, 경쟁사별 누적 낙찰 통계가 표시됨.

## 사전 조건

- [x] Phase 1, 2 완료 후 1주 이상 안정 운영
- [x] DB에 누적 공고 데이터 존재

## Phase 3 산출물

```
fr-workwear-app/
├── src/features/tenders/
│   ├── api/
│   │   ├── bidResults.ts
│   │   ├── contracts.ts
│   │   ├── competitors.ts
│   │   └── keywords.ts
│   ├── hooks/
│   │   ├── useBidResults.ts
│   │   ├── useContracts.ts
│   │   ├── useCompetitors.ts
│   │   └── useKeywords.ts
│   ├── components/
│   │   ├── BidResultPanel.tsx
│   │   ├── ContractPanel.tsx
│   │   ├── CompetitorTable.tsx
│   │   ├── CompetitorDetailModal.tsx
│   │   ├── KeywordManager.tsx
│   │   └── TenderTimeline.tsx
│   └── pages/
│       ├── CompetitorsPage.tsx       ← /tenders/competitors
│       └── KeywordsPage.tsx          ← /tenders/keywords
└── supabase/
    ├── migrations/
    │   └── 20260615_create_bid_contract.sql
    └── functions/
        ├── poll-bid-results/
        └── poll-contracts/
```

---

## Step 1. DB 마이그레이션

**파일**: `supabase/migrations/20260615_create_bid_contract.sql`

```sql
-- 낙찰결과
CREATE TABLE bid_results (
  id BIGSERIAL PRIMARY KEY,
  bid_ntce_no TEXT NOT NULL,
  bid_ntce_ord TEXT DEFAULT '00',
  opengm_rslt_div_nm TEXT,            -- 낙찰/유찰
  scsbid_amt NUMERIC,                  -- 낙찰금액
  scsbid_rate NUMERIC,                 -- 낙찰률(%)
  scsbid_corp_nm TEXT,                 -- 낙찰업체명
  scsbid_corp_bizno TEXT,              -- 사업자번호
  scsbid_corp_ceo_nm TEXT,             -- 대표자
  rank_no INT,                         -- 순위
  prtcpt_cnt INT,                      -- 참여업체 수
  opengm_dt TIMESTAMPTZ,
  raw_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bid_ntce_no, bid_ntce_ord, scsbid_corp_bizno)
);

CREATE INDEX idx_bid_results_ntce ON bid_results(bid_ntce_no);
CREATE INDEX idx_bid_results_corp ON bid_results(scsbid_corp_nm);
CREATE INDEX idx_bid_results_bizno ON bid_results(scsbid_corp_bizno);
CREATE INDEX idx_bid_results_opengm ON bid_results(opengm_dt DESC);

-- 계약
CREATE TABLE contracts (
  id BIGSERIAL PRIMARY KEY,
  cntrct_no TEXT NOT NULL,
  cntrct_chg_ord TEXT DEFAULT '00',
  bid_ntce_no TEXT,
  cntrct_nm TEXT,
  cntrct_cncls_dt DATE,
  cntrct_amt NUMERIC,
  cntrctr_nm TEXT,                     -- 계약상대자
  cntrctr_bizno TEXT,
  cntrct_instt_nm TEXT,                -- 계약기관
  dminstt_nm TEXT,                     -- 수요기관
  cntrct_perd_bgn_dt DATE,
  cntrct_perd_end_dt DATE,
  raw_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cntrct_no, cntrct_chg_ord)
);

CREATE INDEX idx_contracts_bid_ntce ON contracts(bid_ntce_no);
CREATE INDEX idx_contracts_contractor ON contracts(cntrctr_nm);
CREATE INDEX idx_contracts_cncls_dt ON contracts(cntrct_cncls_dt DESC);

-- 경쟁사 요약 뷰 (실시간 집계)
CREATE OR REPLACE VIEW competitor_summary AS
SELECT 
  scsbid_corp_nm AS corp_nm,
  scsbid_corp_bizno AS bizno,
  COUNT(*) FILTER (WHERE rank_no = 1) AS win_count,
  COALESCE(SUM(scsbid_amt) FILTER (WHERE rank_no = 1), 0) AS total_won_amount,
  AVG(scsbid_rate) FILTER (WHERE rank_no = 1) AS avg_scsbid_rate,
  MAX(opengm_dt) AS last_won_at
FROM bid_results
WHERE scsbid_corp_nm IS NOT NULL
GROUP BY scsbid_corp_nm, scsbid_corp_bizno;

-- RLS
ALTER TABLE bid_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_all_bid_results" ON bid_results
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "authenticated_all_contracts" ON contracts
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
```

---

## Step 2. Edge Functions

### 2-1. `supabase/functions/_shared/g2b-client.ts` 확장

Phase 1 파일에 추가:

```typescript
const BID_RESULT_BASE = 'https://apis.data.go.kr/1230000/ad/ScsbidInfoService'
const CONTRACT_BASE = 'https://apis.data.go.kr/1230000/ad/CntrctInfoService'

export interface G2BBidResultItem {
  bidNtceNo: string
  bidNtceOrd?: string
  opengRsltDivNm?: string
  scsbidAmt?: string
  scsbidRate?: string
  scsbidCorpNm?: string
  scsbidCorpBizno?: string
  scsbidCorpCeoNm?: string
  rankNo?: string
  prtcptCnt?: string
  opengDt?: string
  [key: string]: any
}

export interface G2BContractItem {
  cntrctNo: string
  cntrctChgOrd?: string
  bidNtceNo?: string
  cntrctNm?: string
  cntrctCnclsDt?: string
  cntrctAmt?: string
  cntrctrNm?: string
  cntrctrBizno?: string
  cntrctInsttNm?: string
  dminsttNm?: string
  cntrctPerdBgnDt?: string
  cntrctPerdEndDt?: string
  [key: string]: any
}

/** 낙찰결과(물품) 수집 */
export async function fetchAllThngBidResults(
  inqryBgnDt: string,
  inqryEndDt: string,
): Promise<G2BBidResultItem[]> {
  const results: G2BBidResultItem[] = []
  let pageNo = 1
  const numOfRows = 500
  
  while (true) {
    const url = `${BID_RESULT_BASE}/getOpengResultListInfoThng` +
      `?serviceKey=${encodeURIComponent(SERVICE_KEY!)}` +
      `&pageNo=${pageNo}&numOfRows=${numOfRows}` +
      `&inqryDiv=1&inqryBgnDt=${inqryBgnDt}&inqryEndDt=${inqryEndDt}` +
      `&type=json`
    
    const data = await fetchWithRetry(url)
    const items = data.response.body.items
    if (!items || items === '' || (Array.isArray(items) && items.length === 0)) break
    results.push(...items)
    if (items.length < numOfRows) break
    pageNo++
    if (pageNo > 20) break
    await new Promise(r => setTimeout(r, 200))
  }
  return results
}

/** 계약(물품) 수집 */
export async function fetchAllThngContracts(
  inqryBgnDt: string,
  inqryEndDt: string,
): Promise<G2BContractItem[]> {
  const results: G2BContractItem[] = []
  let pageNo = 1
  const numOfRows = 500
  
  while (true) {
    const url = `${CONTRACT_BASE}/getCntrctInfoListThng` +
      `?serviceKey=${encodeURIComponent(SERVICE_KEY!)}` +
      `&pageNo=${pageNo}&numOfRows=${numOfRows}` +
      `&inqryDiv=1&inqryBgnDt=${inqryBgnDt}&inqryEndDt=${inqryEndDt}` +
      `&type=json`
    
    const data = await fetchWithRetry(url)
    const items = data.response.body.items
    if (!items || items === '' || (Array.isArray(items) && items.length === 0)) break
    results.push(...items)
    if (items.length < numOfRows) break
    pageNo++
    if (pageNo > 20) break
    await new Promise(r => setTimeout(r, 200))
  }
  return results
}
```

### 2-2. `supabase/functions/poll-bid-results/index.ts`

```typescript
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { fetchAllThngBidResults } from '../_shared/g2b-client.ts'
import { getYesterdayRangeKST, parseG2BDate } from '../_shared/date-utils.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req) => {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  
  try {
    const url = new URL(req.url)
    const { bgn, end } = (url.searchParams.get('bgn') && url.searchParams.get('end'))
      ? { bgn: url.searchParams.get('bgn')!, end: url.searchParams.get('end')! }
      : getYesterdayRangeKST()
    
    const items = await fetchAllThngBidResults(bgn, end)
    console.log(`[poll-bid-results] 수집: ${items.length}건`)
    
    // 우리 DB에 있는 공고번호 조회 (성능: 전체 결과 중 우리가 관심있는 것만 저장)
    const ourBidNos = new Set<string>()
    const { data: tenders } = await supabase
      .from('tenders')
      .select('bid_ntce_no')
    tenders?.forEach(t => ourBidNos.add(t.bid_ntce_no))
    
    // 추가 정책: 우리 DB에 없어도 일단 저장(경쟁사 전체 분석용)
    // → 시작은 우리 공고로 한정해서 데이터 양을 줄이는 것이 안전
    const filtered = items.filter(it => ourBidNos.has(it.bidNtceNo))
    console.log(`[poll-bid-results] 우리 공고 매칭: ${filtered.length}건`)
    
    const rows = filtered.map(it => ({
      bid_ntce_no: it.bidNtceNo,
      bid_ntce_ord: it.bidNtceOrd ?? '00',
      opengm_rslt_div_nm: it.opengRsltDivNm ?? null,
      scsbid_amt: it.scsbidAmt ? Number(it.scsbidAmt) : null,
      scsbid_rate: it.scsbidRate ? Number(it.scsbidRate) : null,
      scsbid_corp_nm: it.scsbidCorpNm ?? null,
      scsbid_corp_bizno: it.scsbidCorpBizno ?? null,
      scsbid_corp_ceo_nm: it.scsbidCorpCeoNm ?? null,
      rank_no: it.rankNo ? Number(it.rankNo) : null,
      prtcpt_cnt: it.prtcptCnt ? Number(it.prtcptCnt) : null,
      opengm_dt: parseG2BDate(it.opengDt),
      raw_data: it,
    }))
    
    let inserted = 0
    if (rows.length > 0) {
      const { data, error } = await supabase
        .from('bid_results')
        .upsert(rows, { 
          onConflict: 'bid_ntce_no,bid_ntce_ord,scsbid_corp_bizno',
          ignoreDuplicates: false 
        })
        .select('id')
      if (error) throw error
      inserted = data?.length ?? 0
      
      // 우리 응찰 공고 중 1위면 status='won', 아니면 그대로
      // (Phase 3에서는 사용자가 수동으로 status='applied' 했던 것에 한해 자동 업데이트)
      const wonBidNos = rows
        .filter(r => r.rank_no === 1)
        .map(r => r.bid_ntce_no)
      
      // 실제 won/lost 판정은 우리 회사 사업자번호 매칭이 필요 → Phase 4에서 처리
    }
    
    return new Response(JSON.stringify({ 
      fetched: items.length, 
      matched: filtered.length, 
      inserted 
    }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[poll-bid-results] 실패:', msg)
    return new Response(JSON.stringify({ error: msg }), { status: 500 })
  }
})
```

### 2-3. `supabase/functions/poll-contracts/index.ts`

위와 동일한 패턴으로 `fetchAllThngContracts` 사용. 우리 DB의 공고번호와 매칭되는 계약만 저장.

### 2-4. Cron 등록

```sql
-- 낙찰: KST 04:00 (공고 폴링 1시간 뒤)
SELECT cron.schedule('poll-bid-results-daily', '0 19 * * *', $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/poll-bid-results',
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY')
  );
$$);

-- 계약: KST 04:30
SELECT cron.schedule('poll-contracts-daily', '30 19 * * *', $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/poll-contracts',
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY')
  );
$$);
```

---

## Step 3. 프론트엔드 — API & Hooks

### 3-1. `src/features/tenders/api/bidResults.ts`

```typescript
import { supabase } from '@/lib/supabase'
import type { BidResult } from '../types'

export async function fetchBidResultsByTender(bidNtceNo: string): Promise<BidResult[]> {
  const { data, error } = await supabase
    .from('bid_results')
    .select('*')
    .eq('bid_ntce_no', bidNtceNo)
    .order('rank_no', { ascending: true })
  if (error) throw error
  return data ?? []
}
```

### 3-2. `src/features/tenders/api/contracts.ts`

```typescript
import { supabase } from '@/lib/supabase'
import type { Contract } from '../types'

export async function fetchContractsByTender(bidNtceNo: string): Promise<Contract[]> {
  const { data, error } = await supabase
    .from('contracts')
    .select('*')
    .eq('bid_ntce_no', bidNtceNo)
    .order('cntrct_cncls_dt', { ascending: false })
  if (error) throw error
  return data ?? []
}
```

### 3-3. `src/features/tenders/api/competitors.ts`

```typescript
import { supabase } from '@/lib/supabase'

export interface CompetitorSummary {
  corp_nm: string
  bizno: string | null
  win_count: number
  total_won_amount: number
  avg_scsbid_rate: number | null
  last_won_at: string | null
}

export async function fetchCompetitorRanking(limit = 50): Promise<CompetitorSummary[]> {
  const { data, error } = await supabase
    .from('competitor_summary')
    .select('*')
    .order('total_won_amount', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data ?? []
}

export async function fetchCompetitorDetail(corpNm: string) {
  const [winsRes, allBidsRes] = await Promise.all([
    supabase.from('bid_results').select('*, tenders!inner(bid_ntce_nm, dminstt_nm)')
      .eq('scsbid_corp_nm', corpNm).eq('rank_no', 1)
      .order('opengm_dt', { ascending: false }),
    supabase.from('bid_results').select('*')
      .eq('scsbid_corp_nm', corpNm),
  ])
  return { 
    wins: winsRes.data ?? [], 
    allBids: allBidsRes.data ?? [] 
  }
}
```

### 3-4. `src/features/tenders/api/keywords.ts`

```typescript
import { supabase } from '@/lib/supabase'
import type { TenderKeyword } from '../types'

export async function fetchAllKeywords(): Promise<TenderKeyword[]> {
  const { data, error } = await supabase
    .from('tender_keywords')
    .select('*')
    .order('weight', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function addKeyword(input: Omit<TenderKeyword, 'id' | 'created_at'>) {
  const { error } = await supabase.from('tender_keywords').insert(input)
  if (error) throw error
}

export async function updateKeyword(id: number, patch: Partial<TenderKeyword>) {
  const { error } = await supabase.from('tender_keywords').update(patch).eq('id', id)
  if (error) throw error
}

export async function deleteKeyword(id: number) {
  const { error } = await supabase.from('tender_keywords').delete().eq('id', id)
  if (error) throw error
}
```

Hooks(`useBidResults`, `useContracts`, `useCompetitors`, `useKeywords`)는 Phase 2 패턴과 동일하게 React Query로 래핑.

---

## Step 4. 프론트엔드 — 컴포넌트

### 4-1. `BidResultPanel.tsx` (공고 상세 페이지에 삽입)

```tsx
import { useBidResultsByTender } from '../hooks/useBidResults'
import { formatPrice } from '../utils/format'

export function BidResultPanel({ bidNtceNo }: { bidNtceNo: string }) {
  const { data: results = [], isLoading } = useBidResultsByTender(bidNtceNo)
  
  if (isLoading) return <div className="h-32 bg-gray-100 rounded animate-pulse" />
  if (results.length === 0) return (
    <div className="text-gray-500 text-sm py-6 text-center">아직 개찰 결과가 없습니다</div>
  )
  
  return (
    <div className="bg-white border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b bg-gray-50">
        <h3 className="font-semibold">개찰 결과 ({results.length}개 업체 참여)</h3>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-xs text-gray-600">
          <tr>
            <th className="px-3 py-2 text-left">순위</th>
            <th className="px-3 py-2 text-left">업체명</th>
            <th className="px-3 py-2 text-right">투찰금액</th>
            <th className="px-3 py-2 text-right">낙찰률</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r, i) => (
            <tr key={r.id} className={i === 0 ? 'bg-orange-50' : 'border-t'}>
              <td className="px-3 py-2 font-semibold">{r.rank_no ?? '-'}</td>
              <td className="px-3 py-2">{r.scsbid_corp_nm}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatPrice(r.scsbid_amt)}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {r.scsbid_rate?.toFixed(2)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

### 4-2. `CompetitorTable.tsx`

```tsx
import { useCompetitorRanking } from '../hooks/useCompetitors'
import { formatPrice } from '../utils/format'

export function CompetitorTable({ onSelect }: { onSelect: (corp: string) => void }) {
  const { data: competitors = [], isLoading } = useCompetitorRanking(50)
  
  if (isLoading) return <div className="h-64 bg-gray-100 rounded animate-pulse" />
  
  return (
    <div className="bg-white border rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-[#1e3a5f] text-white text-xs">
          <tr>
            <th className="px-4 py-3 text-left">순위</th>
            <th className="px-4 py-3 text-left">업체명</th>
            <th className="px-4 py-3 text-right">낙찰 건수</th>
            <th className="px-4 py-3 text-right">누적 낙찰액</th>
            <th className="px-4 py-3 text-right">평균 낙찰률</th>
            <th className="px-4 py-3 text-left">최근 낙찰일</th>
          </tr>
        </thead>
        <tbody>
          {competitors.map((c, i) => (
            <tr key={c.bizno ?? c.corp_nm} 
                className="border-t hover:bg-gray-50 cursor-pointer"
                onClick={() => onSelect(c.corp_nm)}>
              <td className="px-4 py-3 font-semibold">{i + 1}</td>
              <td className="px-4 py-3">
                <div className="font-medium">{c.corp_nm}</div>
                <div className="text-xs text-gray-500">{c.bizno ?? '-'}</div>
              </td>
              <td className="px-4 py-3 text-right tabular-nums">{c.win_count.toLocaleString()}</td>
              <td className="px-4 py-3 text-right tabular-nums font-semibold">
                {formatPrice(c.total_won_amount)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {c.avg_scsbid_rate?.toFixed(2) ?? '-'}%
              </td>
              <td className="px-4 py-3 text-xs text-gray-600">
                {c.last_won_at ? new Date(c.last_won_at).toLocaleDateString('ko-KR') : '-'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

### 4-3. `KeywordManager.tsx`

CRUD UI. 카테고리별로 그룹화하여 표시. 활성/비활성 토글, 가중치 인라인 편집, 추가/삭제 버튼.

핵심 패턴:
```tsx
const categories = ['core', 'material', 'standard', 'usage', 'exclude'] as const
const grouped = keywords.reduce((acc, k) => {
  (acc[k.category] = acc[k.category] ?? []).push(k)
  return acc
}, {} as Record<string, TenderKeyword[]>)

return categories.map(cat => (
  <section key={cat}>
    <h3>{CATEGORY_LABELS[cat]}</h3>
    {grouped[cat]?.map(k => <KeywordRow key={k.id} keyword={k} />)}
  </section>
))
```

### 4-4. `TenderTimeline.tsx` — 공고 상세에 표시

공고 → 낙찰 → 계약 흐름을 타임라인으로:

```
2026-05-15 ───── 입찰공고 게시
2026-05-22 ───── 입찰마감
2026-05-23 ───── 개찰완료 (A업체 낙찰, 14,500,000원)
2026-05-30 ───── 계약체결 (계약금액 14,500,000원)
```

각 단계의 데이터 존재 여부에 따라 상태 표시 (회색 = 미발생, 컬러 = 완료).

---

## Step 5. 페이지

### 5-1. `CompetitorsPage.tsx`

```tsx
import { useState } from 'react'
import { CompetitorTable } from '../components/CompetitorTable'
import { CompetitorDetailModal } from '../components/CompetitorDetailModal'

export function CompetitorsPage() {
  const [selected, setSelected] = useState<string | null>(null)
  
  return (
    <div className="container mx-auto px-4 py-6 max-w-6xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-[#1e3a5f]">경쟁사 분석</h1>
        <p className="text-sm text-gray-600 mt-1">
          누적 낙찰액 기준 상위 50개사
        </p>
      </header>
      
      <CompetitorTable onSelect={setSelected} />
      
      {selected && (
        <CompetitorDetailModal 
          corpNm={selected} 
          onClose={() => setSelected(null)} 
        />
      )}
    </div>
  )
}
```

### 5-2. `KeywordsPage.tsx`

`KeywordManager` 컴포넌트만 임베드.

### 5-3. `TenderDetailPage.tsx` 업데이트

기존 페이지에 `<BidResultPanel>`, `<ContractPanel>`, `<TenderTimeline>` 추가.

---

## Step 6. 라우팅 추가

```tsx
<Route path="/tenders/competitors" element={<CompetitorsPage />} />
<Route path="/tenders/keywords" element={<KeywordsPage />} />
```

내비게이션에 "경쟁사", "키워드 관리" 메뉴 추가.

---

## Phase 3 완료 체크리스트

- [ ] `bid_results`, `contracts` 테이블 + `competitor_summary` 뷰 생성
- [ ] `poll-bid-results`, `poll-contracts` 함수 배포 + Cron 등록
- [ ] 며칠 대기 후, 우리 공고의 개찰결과가 자동 적재됨 확인
- [ ] 공고 상세 페이지에 개찰 결과 패널 표시
- [ ] 경쟁사 페이지에 누적 통계 테이블 표시
- [ ] 키워드 관리 페이지에서 추가/수정/삭제 동작
- [ ] 키워드 변경 시 다음 폴링부터 반영됨 확인

---

## Phase 3 → Phase 4 진입 조건

- ✅ 경쟁사 데이터가 충분히 쌓여 의미있는 분석 가능 (최소 2~3주 운영)
- ✅ 어떤 경쟁사를 지속 모니터링할지 선별 가능

Phase 4에서는 **워크플로우 강화 + 카카오 알림톡 + 변경이력 추적**을 추가합니다.
