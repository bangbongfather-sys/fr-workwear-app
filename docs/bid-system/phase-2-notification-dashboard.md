# Phase 2: 이메일 알림 + React 대시보드

> **목표**: Phase 1에서 수집한 데이터를 ① 매일 아침 이메일로 받고, ② fr-workwear-app에서 `/tenders` 메뉴로 조회 가능하게 만든다.
>
> **검증 기준**: 매일 아침 KST 8:30~9:00 사이에 신규 입찰 공고 요약 이메일이 도착하고, 웹앱에서 공고 리스트와 상세 정보를 확인할 수 있어야 함.

## 사전 조건

- [x] Phase 1 완료 (DB에 데이터가 자동으로 쌓이는 상태)
- [x] Resend 도메인 검증 완료
- [x] Supabase Secrets에 `RESEND_API_KEY`, `NOTIFICATION_EMAIL_FROM`, `NOTIFICATION_EMAIL_TO` 등록

## Phase 2 산출물

```
fr-workwear-app/
├── src/features/tenders/
│   ├── api/
│   │   └── tenders.ts                    ← Supabase 쿼리 함수
│   ├── hooks/
│   │   └── useTenders.ts                 ← React Query 훅
│   ├── components/
│   │   ├── TenderCard.tsx                ← 개별 공고 카드
│   │   ├── TenderList.tsx                ← 리스트 컴포넌트
│   │   ├── TenderDetailModal.tsx         ← 상세 모달
│   │   ├── StatusBadge.tsx               ← 상태 배지
│   │   ├── DeadlineChip.tsx              ← 마감 임박 표시
│   │   └── DashboardSummary.tsx          ← 상단 통계 카드
│   ├── pages/
│   │   ├── TendersDashboardPage.tsx      ← /tenders (메인)
│   │   ├── TendersListPage.tsx           ← /tenders/list (전체 리스트)
│   │   └── TenderDetailPage.tsx          ← /tenders/:id (상세)
│   └── utils/
│       ├── format.ts                     ← 금액/날짜 포맷터
│       └── deadline.ts                   ← D-day 계산
└── supabase/
    ├── migrations/
    │   └── 20260601_create_notifications.sql
    └── functions/
        ├── _shared/
        │   └── email-templates.ts
        └── send-tender-notification/
            ├── index.ts
            └── deno.json
```

---

## Step 1. DB 마이그레이션 (알림 로그)

**파일**: `supabase/migrations/20260601_create_notifications.sql`

```sql
CREATE TABLE notifications_log (
  id BIGSERIAL PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'kakao')),
  recipient TEXT NOT NULL,
  subject TEXT,
  tender_ids BIGINT[] NOT NULL DEFAULT '{}',
  tender_count INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed')),
  provider_msg_id TEXT,
  error_msg TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_status ON notifications_log(status, created_at DESC);

ALTER TABLE notifications_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_read_notifications" ON notifications_log
  FOR SELECT TO authenticated USING (true);
```

---

## Step 2. 이메일 발송 Edge Function

### 2-1. `supabase/functions/_shared/email-templates.ts`

```typescript
export interface TenderForEmail {
  id: number
  bid_ntce_no: string
  bid_ntce_nm: string
  ntce_instt_nm: string | null
  dminstt_nm: string | null
  presmpt_prce: number | null
  bid_clse_dt: string | null
  bid_ntce_url: string | null
  match_score: number
  matched_keywords: string[]
}

function formatPrice(amount: number | null): string {
  if (amount === null) return '-'
  return amount.toLocaleString('ko-KR') + '원'
}

function formatDate(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000)
  return kst.toISOString().slice(0, 16).replace('T', ' ')
}

function calculateDaysLeft(clseDt: string | null): number | null {
  if (!clseDt) return null
  const now = Date.now()
  const clse = new Date(clseDt).getTime()
  return Math.ceil((clse - now) / (1000 * 60 * 60 * 24))
}

function deadlineBadge(clseDt: string | null): string {
  const days = calculateDaysLeft(clseDt)
  if (days === null) return ''
  if (days < 0) return `<span style="background:#fee;color:#c00;padding:2px 8px;border-radius:4px;font-size:11px;">마감</span>`
  if (days <= 1) return `<span style="background:#fee;color:#c00;padding:2px 8px;border-radius:4px;font-size:11px;">D-${days}</span>`
  if (days <= 3) return `<span style="background:#fff3cd;color:#856404;padding:2px 8px;border-radius:4px;font-size:11px;">D-${days}</span>`
  return `<span style="background:#e6f0fa;color:#1e3a5f;padding:2px 8px;border-radius:4px;font-size:11px;">D-${days}</span>`
}

export function renderTenderEmail(tenders: TenderForEmail[]): string {
  const todayKST = new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString().slice(0, 10)
  
  const rows = tenders.map(t => `
    <tr style="border-bottom:1px solid #e2e8f0;">
      <td style="padding:12px 8px;vertical-align:top;">
        <a href="${t.bid_ntce_url ?? '#'}" 
           style="color:#1e3a5f;text-decoration:none;font-weight:600;">
          ${escapeHtml(t.bid_ntce_nm)}
        </a>
        <div style="margin-top:4px;">${deadlineBadge(t.bid_clse_dt)}</div>
        <div style="margin-top:6px;font-size:11px;color:#718096;">
          매칭: ${t.matched_keywords.join(', ')} (점수 ${t.match_score})
        </div>
      </td>
      <td style="padding:12px 8px;vertical-align:top;font-size:13px;color:#4a5568;">
        ${escapeHtml(t.dminstt_nm ?? t.ntce_instt_nm ?? '-')}
      </td>
      <td style="padding:12px 8px;vertical-align:top;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;">
        ${formatPrice(t.presmpt_prce)}
      </td>
      <td style="padding:12px 8px;vertical-align:top;font-size:12px;color:#718096;">
        ${formatDate(t.bid_clse_dt)}
      </td>
    </tr>
  `).join('')
  
  return `
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>NJ Safety 입찰 알리미</title>
</head>
<body style="margin:0;padding:0;background:#f7f9fc;font-family:'Pretendard',-apple-system,sans-serif;color:#1a202c;">
  <div style="max-width:680px;margin:0 auto;padding:24px;">
    <div style="background:#1e3a5f;color:white;padding:20px 24px;border-radius:8px 8px 0 0;">
      <h1 style="margin:0;font-size:20px;">🔔 NJ Safety 입찰 알리미</h1>
      <div style="margin-top:4px;font-size:13px;opacity:0.85;">
        ${todayKST} · 신규 매칭 공고 <strong>${tenders.length}건</strong>
      </div>
    </div>
    
    <div style="background:white;padding:0;border-radius:0 0 8px 8px;border:1px solid #e2e8f0;border-top:none;">
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:#f7f9fc;text-align:left;font-size:12px;color:#718096;text-transform:uppercase;">
            <th style="padding:10px 8px;">공고명</th>
            <th style="padding:10px 8px;">발주기관</th>
            <th style="padding:10px 8px;text-align:right;">추정가</th>
            <th style="padding:10px 8px;">마감일시</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    
    <div style="margin-top:16px;padding:16px;background:white;border-radius:8px;border:1px solid #e2e8f0;font-size:12px;color:#718096;text-align:center;">
      이 메일은 NJ Safety 입찰 모니터링 시스템에서 자동 발송되었습니다.<br>
      알림 설정 변경은 웹앱에서 가능합니다.
    </div>
  </div>
</body>
</html>
  `.trim()
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]!))
}
```

### 2-2. `supabase/functions/send-tender-notification/index.ts`

```typescript
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { renderTenderEmail, TenderForEmail } from '../_shared/email-templates.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!
const EMAIL_FROM = Deno.env.get('NOTIFICATION_EMAIL_FROM')!
const EMAIL_TO = Deno.env.get('NOTIFICATION_EMAIL_TO')!

async function sendEmail(subject: string, html: string): Promise<{ id?: string; error?: string }> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: EMAIL_TO.split(',').map(e => e.trim()),
      subject,
      html,
    }),
  })
  
  const data = await res.json()
  if (!res.ok) return { error: data.message ?? `HTTP ${res.status}` }
  return { id: data.id }
}

Deno.serve(async (_req) => {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  
  try {
    // 알림 안 보낸 신규 공고 조회 (최근 24시간 내 추가된 것 중)
    const { data: tenders, error } = await supabase
      .from('tenders')
      .select('id, bid_ntce_no, bid_ntce_nm, ntce_instt_nm, dminstt_nm, presmpt_prce, bid_clse_dt, bid_ntce_url, match_score, matched_keywords')
      .is('notified_at', null)
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order('match_score', { ascending: false })
      .order('bid_clse_dt', { ascending: true })
    
    if (error) throw error
    if (!tenders || tenders.length === 0) {
      console.log('[notify] 발송할 신규 공고 없음')
      return new Response(JSON.stringify({ sent: false, reason: 'no_new_tenders' }))
    }
    
    // 이메일 발송
    const subject = `[NJ Safety] 신규 입찰 ${tenders.length}건 (${new Date(Date.now() + 9*60*60*1000).toISOString().slice(0,10)})`
    const html = renderTenderEmail(tenders as TenderForEmail[])
    const { id, error: emailError } = await sendEmail(subject, html)
    
    // 결과 기록
    const logEntry = {
      channel: 'email' as const,
      recipient: EMAIL_TO,
      subject,
      tender_ids: tenders.map(t => t.id),
      tender_count: tenders.length,
      status: emailError ? 'failed' as const : 'sent' as const,
      provider_msg_id: id ?? null,
      error_msg: emailError ?? null,
      sent_at: emailError ? null : new Date().toISOString(),
    }
    await supabase.from('notifications_log').insert(logEntry)
    
    if (emailError) throw new Error(emailError)
    
    // 알림 완료 표시
    await supabase
      .from('tenders')
      .update({ notified_at: new Date().toISOString() })
      .in('id', tenders.map(t => t.id))
    
    return new Response(JSON.stringify({ 
      sent: true, 
      count: tenders.length, 
      messageId: id 
    }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[notify] 실패:', msg)
    return new Response(JSON.stringify({ error: msg }), { status: 500 })
  }
})
```

### 2-3. Cron 등록 (KST 08:30 발송)

```sql
SELECT cron.schedule(
  'send-tender-notification-daily',
  '30 23 * * *',  -- UTC 23:30 = KST 08:30
  $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/send-tender-notification',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY'
    ),
    timeout_milliseconds := 30000
  );
  $$
);
```

> Phase 1의 폴링은 03:00, 이메일 발송은 08:30 → 그 사이 5.5시간 동안 사용자가 자기 전 데이터에 대해 검토할 시간 확보. (브리핑 선호 시간대 8:30~8:50과 일치하도록 의도적으로 설정.)

---

## Step 3. 프론트엔드 — 유틸리티

### 3-1. `src/features/tenders/utils/format.ts`

```typescript
export function formatPrice(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '-'
  return amount.toLocaleString('ko-KR') + '원'
}

export function formatPriceShort(amount: number | null | undefined): string {
  if (!amount) return '-'
  if (amount >= 1_0000_0000) return `${(amount / 1_0000_0000).toFixed(1)}억`
  if (amount >= 10000) return `${(amount / 10000).toFixed(0)}만`
  return amount.toLocaleString('ko-KR')
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Seoul'
  })
}

export function formatDate(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleDateString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: 'Asia/Seoul'
  })
}
```

### 3-2. `src/features/tenders/utils/deadline.ts`

```typescript
export type DeadlineLevel = 'expired' | 'critical' | 'warning' | 'caution' | 'normal'

export function calculateDaysLeft(clseDt: string | null): number | null {
  if (!clseDt) return null
  const ms = new Date(clseDt).getTime() - Date.now()
  return Math.ceil(ms / (1000 * 60 * 60 * 24))
}

export function getDeadlineLevel(clseDt: string | null): DeadlineLevel {
  const days = calculateDaysLeft(clseDt)
  if (days === null) return 'normal'
  if (days < 0) return 'expired'
  if (days <= 1) return 'critical'
  if (days <= 3) return 'warning'
  if (days <= 7) return 'caution'
  return 'normal'
}

export function deadlineClassNames(level: DeadlineLevel): string {
  return {
    expired: 'text-gray-500 bg-gray-100',
    critical: 'text-red-700 bg-red-50 border-red-200',
    warning: 'text-orange-700 bg-orange-50 border-orange-200',
    caution: 'text-yellow-800 bg-yellow-50 border-yellow-200',
    normal: 'text-blue-700 bg-blue-50 border-blue-200',
  }[level]
}
```

---

## Step 4. 프론트엔드 — API 레이어

### 4-1. `src/features/tenders/api/tenders.ts`

```typescript
import { supabase } from '@/lib/supabase'  // 기존 fr-workwear-app의 supabase 클라이언트
import type { Tender, TenderStatus } from '../types'

export async function fetchTenders(filters?: {
  status?: TenderStatus | TenderStatus[]
  minScore?: number
  searchKeyword?: string
  limit?: number
}): Promise<Tender[]> {
  let query = supabase
    .from('tenders')
    .select('*')
    .order('match_score', { ascending: false })
    .order('bid_clse_dt', { ascending: true })
  
  if (filters?.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status]
    query = query.in('status', statuses)
  }
  if (filters?.minScore !== undefined) {
    query = query.gte('match_score', filters.minScore)
  }
  if (filters?.searchKeyword) {
    query = query.ilike('bid_ntce_nm', `%${filters.searchKeyword}%`)
  }
  if (filters?.limit) {
    query = query.limit(filters.limit)
  }
  
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

export async function fetchTenderById(id: number): Promise<Tender | null> {
  const { data, error } = await supabase
    .from('tenders')
    .select('*')
    .eq('id', id)
    .single()
  if (error) throw error
  return data
}

export async function updateTenderStatus(
  id: number,
  status: TenderStatus
): Promise<void> {
  const { error } = await supabase
    .from('tenders')
    .update({ status })
    .eq('id', id)
  if (error) throw error
}

export async function fetchDashboardStats() {
  const now = new Date()
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  
  const [newCount, deadlineSoon, weekTotal] = await Promise.all([
    supabase.from('tenders').select('id', { count: 'exact', head: true })
      .eq('status', 'new'),
    supabase.from('tenders').select('id', { count: 'exact', head: true })
      .lte('bid_clse_dt', new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString())
      .gte('bid_clse_dt', now.toISOString())
      .in('status', ['new', 'reviewed']),
    supabase.from('tenders').select('id', { count: 'exact', head: true })
      .gte('created_at', weekAgo.toISOString()),
  ])
  
  return {
    newCount: newCount.count ?? 0,
    deadlineSoonCount: deadlineSoon.count ?? 0,
    weekTotalCount: weekTotal.count ?? 0,
  }
}
```

### 4-2. `src/features/tenders/hooks/useTenders.ts`

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchTenders, fetchTenderById, updateTenderStatus, fetchDashboardStats } from '../api/tenders'
import type { TenderStatus } from '../types'

export function useTenders(filters?: Parameters<typeof fetchTenders>[0]) {
  return useQuery({
    queryKey: ['tenders', filters],
    queryFn: () => fetchTenders(filters),
    staleTime: 60_000,  // 1분
  })
}

export function useTender(id: number | null) {
  return useQuery({
    queryKey: ['tenders', id],
    queryFn: () => fetchTenderById(id!),
    enabled: id !== null,
  })
}

export function useUpdateTenderStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: number; status: TenderStatus }) =>
      updateTenderStatus(id, status),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenders'] })
      qc.invalidateQueries({ queryKey: ['tender-stats'] })
    },
  })
}

export function useDashboardStats() {
  return useQuery({
    queryKey: ['tender-stats'],
    queryFn: fetchDashboardStats,
    staleTime: 60_000,
  })
}
```

---

## Step 5. 프론트엔드 — 컴포넌트

### 5-1. `src/features/tenders/components/DeadlineChip.tsx`

```tsx
import { calculateDaysLeft, getDeadlineLevel, deadlineClassNames } from '../utils/deadline'

interface Props { clseDt: string | null }

export function DeadlineChip({ clseDt }: Props) {
  const days = calculateDaysLeft(clseDt)
  const level = getDeadlineLevel(clseDt)
  
  if (days === null) return null
  
  const label = days < 0 ? '마감' : `D-${days}`
  
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border ${deadlineClassNames(level)}`}>
      {label}
    </span>
  )
}
```

### 5-2. `src/features/tenders/components/StatusBadge.tsx`

```tsx
import type { TenderStatus } from '../types'

const STATUS_LABELS: Record<TenderStatus, { label: string; className: string }> = {
  new:      { label: '신규',   className: 'bg-blue-100 text-blue-800' },
  reviewed: { label: '검토',   className: 'bg-purple-100 text-purple-800' },
  applied:  { label: '응찰',   className: 'bg-orange-100 text-orange-800' },
  won:      { label: '낙찰',   className: 'bg-green-100 text-green-800' },
  lost:     { label: '미낙찰', className: 'bg-gray-100 text-gray-600' },
  skipped:  { label: '제외',   className: 'bg-gray-100 text-gray-500' },
}

export function StatusBadge({ status }: { status: TenderStatus }) {
  const { label, className } = STATUS_LABELS[status]
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${className}`}>
      {label}
    </span>
  )
}
```

### 5-3. `src/features/tenders/components/TenderCard.tsx`

```tsx
import { Link } from 'react-router-dom'
import type { Tender } from '../types'
import { DeadlineChip } from './DeadlineChip'
import { StatusBadge } from './StatusBadge'
import { formatPriceShort, formatDateTime } from '../utils/format'

interface Props {
  tender: Tender
  onClick?: (tender: Tender) => void
}

export function TenderCard({ tender, onClick }: Props) {
  return (
    <div 
      onClick={() => onClick?.(tender)}
      className="bg-white border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow cursor-pointer"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <StatusBadge status={tender.status} />
            <DeadlineChip clseDt={tender.bid_clse_dt} />
            <span className="text-xs text-gray-500">점수 {tender.match_score}</span>
          </div>
          <h3 className="font-semibold text-gray-900 line-clamp-2 mb-1">
            {tender.bid_ntce_nm}
          </h3>
          <div className="text-sm text-gray-600 mb-2">
            {tender.dminstt_nm ?? tender.ntce_instt_nm}
          </div>
          <div className="flex flex-wrap gap-1">
            {tender.matched_keywords.map(kw => (
              <span key={kw} className="text-xs bg-orange-50 text-orange-700 px-2 py-0.5 rounded">
                {kw}
              </span>
            ))}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-lg font-bold text-[#1e3a5f] tabular-nums">
            {formatPriceShort(tender.presmpt_prce)}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            마감 {formatDateTime(tender.bid_clse_dt)}
          </div>
        </div>
      </div>
    </div>
  )
}
```

### 5-4. `src/features/tenders/components/DashboardSummary.tsx`

```tsx
import { useDashboardStats } from '../hooks/useTenders'

export function DashboardSummary() {
  const { data, isLoading } = useDashboardStats()
  
  if (isLoading || !data) {
    return <div className="grid grid-cols-3 gap-4">
      {[1,2,3].map(i => <div key={i} className="h-24 bg-gray-100 rounded-lg animate-pulse" />)}
    </div>
  }
  
  const cards = [
    { label: '검토 대기', value: data.newCount, accent: 'text-blue-600' },
    { label: '마감 임박 (3일 이내)', value: data.deadlineSoonCount, accent: 'text-red-600' },
    { label: '이번 주 신규', value: data.weekTotalCount, accent: 'text-[#1e3a5f]' },
  ]
  
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {cards.map(c => (
        <div key={c.label} className="bg-white border border-gray-200 rounded-lg p-5">
          <div className="text-sm text-gray-600 mb-2">{c.label}</div>
          <div className={`text-3xl font-bold tabular-nums ${c.accent}`}>
            {c.value.toLocaleString('ko-KR')}<span className="text-base ml-1 text-gray-500">건</span>
          </div>
        </div>
      ))}
    </div>
  )
}
```

### 5-5. `src/features/tenders/components/TenderList.tsx`

```tsx
import { TenderCard } from './TenderCard'
import type { Tender } from '../types'

interface Props {
  tenders: Tender[]
  emptyText?: string
  onTenderClick?: (tender: Tender) => void
}

export function TenderList({ tenders, emptyText = '공고가 없습니다', onTenderClick }: Props) {
  if (tenders.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500 bg-gray-50 rounded-lg">
        {emptyText}
      </div>
    )
  }
  return (
    <div className="space-y-3">
      {tenders.map(t => (
        <TenderCard key={t.id} tender={t} onClick={onTenderClick} />
      ))}
    </div>
  )
}
```

---

## Step 6. 프론트엔드 — 페이지

### 6-1. `src/features/tenders/pages/TendersDashboardPage.tsx`

```tsx
import { useNavigate } from 'react-router-dom'
import { useTenders } from '../hooks/useTenders'
import { DashboardSummary } from '../components/DashboardSummary'
import { TenderList } from '../components/TenderList'

export function TendersDashboardPage() {
  const navigate = useNavigate()
  const { data: newTenders = [], isLoading } = useTenders({ 
    status: 'new', 
    limit: 10 
  })
  
  return (
    <div className="container mx-auto px-4 py-6 max-w-6xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-[#1e3a5f]">입찰 모니터링</h1>
        <p className="text-sm text-gray-600 mt-1">
          나라장터에서 자동 수집한 방염복 관련 공고
        </p>
      </header>
      
      <div className="mb-8">
        <DashboardSummary />
      </div>
      
      <section className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">신규 공고 (상위 10건)</h2>
          <button
            onClick={() => navigate('/tenders/list')}
            className="text-sm text-[#1e3a5f] hover:underline"
          >
            전체 보기 →
          </button>
        </div>
        {isLoading ? (
          <div className="space-y-3">
            {[1,2,3].map(i => <div key={i} className="h-24 bg-gray-100 rounded-lg animate-pulse" />)}
          </div>
        ) : (
          <TenderList 
            tenders={newTenders} 
            emptyText="검토 대기 중인 공고가 없습니다"
            onTenderClick={(t) => navigate(`/tenders/${t.id}`)}
          />
        )}
      </section>
    </div>
  )
}
```

### 6-2. `src/features/tenders/pages/TendersListPage.tsx`

전체 리스트 + 필터 (상태/기관/검색어). Claude Code가 위 패턴을 참고해 구현.

### 6-3. `src/features/tenders/pages/TenderDetailPage.tsx`

`useTender(id)`로 단건 조회 → 모든 필드 표시 + 상태 변경 버튼(`useUpdateTenderStatus`).
조달청 원본 공고 링크(`bid_ntce_url`)를 새 탭으로 열기.

---

## Step 7. 라우팅 등록

기존 `src/App.tsx` 또는 라우터 설정 파일에 추가:

```tsx
import { TendersDashboardPage } from '@/features/tenders/pages/TendersDashboardPage'
import { TendersListPage } from '@/features/tenders/pages/TendersListPage'
import { TenderDetailPage } from '@/features/tenders/pages/TenderDetailPage'

// 라우트 정의에 추가
<Route path="/tenders" element={<TendersDashboardPage />} />
<Route path="/tenders/list" element={<TendersListPage />} />
<Route path="/tenders/:id" element={<TenderDetailPage />} />
```

기존 사이드바/내비게이션에 "입찰 모니터링" 메뉴 추가.

---

## Step 8. 배포 및 검증

### 8-1. 배포
```bash
supabase db push
supabase functions deploy send-tender-notification --no-verify-jwt
# Cron 등록 (위 Step 2-3 SQL)

# 프론트엔드
npm run build
# Vercel 등 배포
```

### 8-2. 이메일 수동 테스트
```bash
curl -X POST "https://YOUR_PROJECT_REF.supabase.co/functions/v1/send-tender-notification" \
  -H "Authorization: Bearer YOUR_ANON_KEY"
```

→ 메일함 확인 + Supabase Table Editor에서 `notifications_log` 확인

### 8-3. 웹앱 동작 확인
- `/tenders` 접속 → 대시보드 통계 + 신규 공고 리스트
- 공고 카드 클릭 → 상세 페이지
- 상태 변경 (신규 → 검토) → 새로고침 시 반영 확인

---

## Phase 2 완료 체크리스트

- [ ] `notifications_log` 테이블 생성됨
- [ ] `send-tender-notification` 함수 배포 + 수동 호출 시 이메일 수신 확인
- [ ] 이메일 HTML 디자인이 네이비/오렌지 톤으로 렌더링됨
- [ ] Cron 등록 후 다음 날 KST 08:30에 자동 발송 확인
- [ ] `/tenders` 접속 시 대시보드 통계 정상 표시
- [ ] 공고 카드 + 상세 페이지 + 상태 변경 동작
- [ ] 모바일 반응형 확인 (모바일에서 카드가 깔끔하게 표시)

---

## Phase 2 → Phase 3 진입 조건

- ✅ 1주일 정도 사용해보고 이메일 알림이 안정적으로 도착하는지 확인
- ✅ "어떤 정보가 더 필요한가" 사용 피드백 (다음 Phase에 반영)

다음 Phase 3는 **낙찰·계약 데이터를 추가**해서 경쟁사 분석 화면을 만듭니다.
