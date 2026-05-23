# Phase 4: 워크플로우 + 카카오 알림톡 + 변경이력 추적

> **목표**: 시스템을 "단순 알림 도구"에서 "B2G 수주 파이프라인 관리 시스템"으로 확장. 마감 임박/공고 변경/낙찰 결과를 실시간성 있게 알리고, 응찰 결정 워크플로우를 정착시킴.
>
> **검증 기준**: 마감 D-3/D-1에 별도 알림이 자동 발송되고, 공고 변경(정정/취소) 발생 시 즉시 감지, 카카오 알림톡으로도 받기.

## 사전 조건

- [x] Phase 1~3 완료
- [x] **법인 사업자등록증** (NJ Safety 법인 전환 완료)
- [x] 카카오 비즈니스 계정 (사업자 인증)

## Phase 4 산출물

```
fr-workwear-app/
├── src/features/tenders/
│   ├── components/
│   │   ├── ApplicationForm.tsx           ← 응찰 검토 입력
│   │   ├── DeadlineRemindersList.tsx
│   │   ├── ChangeHistoryPanel.tsx
│   │   └── BidPipeline.tsx               ← 칸반 보드
│   ├── pages/
│   │   ├── PipelinePage.tsx              ← /tenders/pipeline
│   │   └── SettingsPage.tsx              ← /tenders/settings
└── supabase/
    ├── migrations/
    │   └── 20260701_phase4_extensions.sql
    └── functions/
        ├── check-deadlines/              ← D-3, D-1 알림
        ├── poll-change-history/          ← 변경이력 감지
        ├── send-kakao-notification/      ← 알림톡 발송
        └── _shared/
            ├── kakao-client.ts
            └── kakao-templates.ts
```

---

## Step 1. DB 확장

**파일**: `supabase/migrations/20260701_phase4_extensions.sql`

```sql
-- 1. 응찰 검토 데이터
CREATE TABLE tender_applications (
  id BIGSERIAL PRIMARY KEY,
  tender_id BIGINT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('pending', 'apply', 'skip')),
  estimated_cost NUMERIC,                  -- 우리 견적가
  estimated_margin NUMERIC,                -- 예상 마진(%)
  our_bid_amount NUMERIC,                  -- 실제 투찰 금액
  application_memo TEXT,
  skip_reason TEXT,
  reviewer TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tender_id)
);

CREATE TRIGGER trg_applications_updated_at
  BEFORE UPDATE ON tender_applications
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 2. 변경이력
CREATE TABLE tender_change_history (
  id BIGSERIAL PRIMARY KEY,
  bid_ntce_no TEXT NOT NULL,
  bid_ntce_ord TEXT NOT NULL,
  change_type TEXT,                        -- 정정/취소/연기 등
  change_reason TEXT,
  prev_data JSONB,
  new_data JSONB,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_change_history_bid_ntce ON tender_change_history(bid_ntce_no);
CREATE INDEX idx_change_history_unnotified ON tender_change_history(notified, detected_at);

-- 3. 마감 알림 발송 이력
CREATE TABLE deadline_reminders_sent (
  id BIGSERIAL PRIMARY KEY,
  tender_id BIGINT NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  reminder_type TEXT NOT NULL CHECK (reminder_type IN ('d-3', 'd-1', 'd-day')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tender_id, reminder_type)
);

-- 4. 우리 회사 정보 (낙찰/미낙찰 자동 판정용)
CREATE TABLE our_company (
  id BIGSERIAL PRIMARY KEY,
  corp_nm TEXT NOT NULL,
  bizno TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO our_company (corp_nm, bizno) VALUES
  ('엔제이세이프티(주)', 'XXX-XX-XXXXX');  -- 실제 법인명/사업자번호로 교체

-- 5. 알림 설정
CREATE TABLE notification_settings (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID DEFAULT auth.uid(),
  email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  kakao_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  kakao_phone TEXT,                        -- 010XXXXXXXX
  deadline_d3_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  deadline_d1_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  change_notify_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  min_match_score INT NOT NULL DEFAULT 7,
  quiet_hours_start INT DEFAULT 22,        -- 22시
  quiet_hours_end INT DEFAULT 7,           -- 07시
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);

-- RLS
ALTER TABLE tender_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender_change_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE deadline_reminders_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE our_company ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_all_applications" ON tender_applications
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_read_history" ON tender_change_history
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_reminders" ON deadline_reminders_sent
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_all_company" ON our_company
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "user_own_settings" ON notification_settings
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- 6. 낙찰/미낙찰 자동 판정 함수
CREATE OR REPLACE FUNCTION update_application_result()
RETURNS TRIGGER AS $$
DECLARE
  our_biznos TEXT[];
  tender_id_var BIGINT;
BEGIN
  -- 우리 회사 사업자번호 목록
  SELECT array_agg(bizno) INTO our_biznos FROM our_company WHERE is_active;
  
  -- 응찰 신청한 공고 찾기
  SELECT a.tender_id INTO tender_id_var
  FROM tender_applications a
  JOIN tenders t ON a.tender_id = t.id
  WHERE t.bid_ntce_no = NEW.bid_ntce_no 
    AND a.decision = 'apply';
  
  IF tender_id_var IS NULL THEN
    RETURN NEW;
  END IF;
  
  -- 우리가 1위면 won, 아니면 lost
  IF NEW.rank_no = 1 AND NEW.scsbid_corp_bizno = ANY(our_biznos) THEN
    UPDATE tenders SET status = 'won' WHERE id = tender_id_var;
  ELSIF NEW.rank_no = 1 THEN
    -- 다른 업체가 낙찰
    UPDATE tenders SET status = 'lost' WHERE id = tender_id_var;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_auto_update_result
  AFTER INSERT OR UPDATE ON bid_results
  FOR EACH ROW EXECUTE FUNCTION update_application_result();
```

---

## Step 2. 마감 임박 알림

### 2-1. `supabase/functions/check-deadlines/index.ts`

```typescript
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  
  const now = new Date()
  const in1Day = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000)
  
  // D-3 대상 (대상: 검토/응찰 결정 안 한 것 + 응찰 결정한 것)
  const { data: d3Tenders } = await supabase
    .from('tenders')
    .select('id, bid_ntce_nm, dminstt_nm, bid_clse_dt, bid_ntce_url, presmpt_prce')
    .gte('bid_clse_dt', in1Day.toISOString())
    .lte('bid_clse_dt', in3Days.toISOString())
    .in('status', ['new', 'reviewed', 'applied'])
  
  // 이미 D-3 알림 보낸 것 제외
  const d3Ids = (d3Tenders ?? []).map(t => t.id)
  const { data: alreadySent } = await supabase
    .from('deadline_reminders_sent')
    .select('tender_id')
    .eq('reminder_type', 'd-3')
    .in('tender_id', d3Ids)
  
  const alreadySentSet = new Set((alreadySent ?? []).map(r => r.tender_id))
  const toSendD3 = (d3Tenders ?? []).filter(t => !alreadySentSet.has(t.id))
  
  // D-1 대상 동일 패턴
  const { data: d1Tenders } = await supabase
    .from('tenders')
    .select('id, bid_ntce_nm, dminstt_nm, bid_clse_dt, bid_ntce_url, presmpt_prce')
    .gte('bid_clse_dt', now.toISOString())
    .lte('bid_clse_dt', in1Day.toISOString())
    .in('status', ['new', 'reviewed', 'applied'])
  
  const d1Ids = (d1Tenders ?? []).map(t => t.id)
  const { data: d1AlreadySent } = await supabase
    .from('deadline_reminders_sent')
    .select('tender_id')
    .eq('reminder_type', 'd-1')
    .in('tender_id', d1Ids)
  
  const d1SentSet = new Set((d1AlreadySent ?? []).map(r => r.tender_id))
  const toSendD1 = (d1Tenders ?? []).filter(t => !d1SentSet.has(t.id))
  
  // 알림 발송
  if (toSendD3.length > 0 || toSendD1.length > 0) {
    await fetch(`${SUPABASE_URL}/functions/v1/send-deadline-notification`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ d3: toSendD3, d1: toSendD1 }),
    })
    
    // 발송 이력 기록
    const reminderRows = [
      ...toSendD3.map(t => ({ tender_id: t.id, reminder_type: 'd-3' as const })),
      ...toSendD1.map(t => ({ tender_id: t.id, reminder_type: 'd-1' as const })),
    ]
    await supabase.from('deadline_reminders_sent').insert(reminderRows)
  }
  
  return new Response(JSON.stringify({ 
    d3_sent: toSendD3.length, 
    d1_sent: toSendD1.length 
  }))
})
```

Cron 등록 (KST 09:00, 14:00 하루 2회):
```sql
SELECT cron.schedule('check-deadlines', '0 0,5 * * *', $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/check-deadlines',
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY')
  );
$$);
```

---

## Step 3. 변경이력 추적

### 3-1. `supabase/functions/poll-change-history/index.ts`

조달청 입찰공고정보서비스의 `getBidPblancListInfoChgHstry` 오퍼레이션을 호출하여, **우리 DB에 있는 공고**의 변경이력만 매일 수집.

```typescript
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { fetchWithRetry } from '../_shared/g2b-client.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SERVICE_KEY = Deno.env.get('G2B_SERVICE_KEY')!
const BASE = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService'

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  
  // 현재 마감 전인 공고만 추적 (이미 끝난 건 변경될 일 없음)
  const { data: activeTenders } = await supabase
    .from('tenders')
    .select('id, bid_ntce_no, bid_ntce_ord, bid_clse_dt, raw_data')
    .gte('bid_clse_dt', new Date().toISOString())
    .in('status', ['new', 'reviewed', 'applied'])
  
  const detected: any[] = []
  
  for (const t of activeTenders ?? []) {
    try {
      // 각 공고의 최신 차수 조회 (정정공고 발생 시 차수 증가)
      const url = `${BASE}/getBidPblancListInfoThng?serviceKey=${encodeURIComponent(SERVICE_KEY)}` +
        `&bidNtceNo=${t.bid_ntce_no}&pageNo=1&numOfRows=10&type=json`
      const data = await fetchWithRetry(url)
      const items = data.response.body.items
      if (!items || items === '') continue
      
      const latest = Array.isArray(items) ? items[0] : items
      const latestOrd = latest.bidNtceOrd ?? '00'
      
      if (latestOrd !== t.bid_ntce_ord) {
        // 차수 변경 발견
        const { data: inserted } = await supabase
          .from('tender_change_history')
          .insert({
            bid_ntce_no: t.bid_ntce_no,
            bid_ntce_ord: latestOrd,
            change_type: latest.ntceKindNm ?? '정정',
            change_reason: latest.rbidPermsnYn ?? null,
            prev_data: t.raw_data,
            new_data: latest,
          })
          .select()
          .single()
        
        if (inserted) detected.push(inserted)
        
        // 마스터 테이블도 업데이트
        await supabase.from('tenders').update({
          bid_ntce_ord: latestOrd,
          raw_data: latest,
        }).eq('id', t.id)
      }
      
      // rate limit 보호
      await new Promise(r => setTimeout(r, 300))
    } catch (err) {
      console.error(`[change-history] ${t.bid_ntce_no} 실패:`, err)
    }
  }
  
  if (detected.length > 0) {
    await fetch(`${SUPABASE_URL}/functions/v1/send-change-notification`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ changes: detected }),
    })
  }
  
  return new Response(JSON.stringify({ 
    checked: activeTenders?.length ?? 0, 
    detected: detected.length 
  }))
})
```

Cron (KST 11:00, 16:00):
```sql
SELECT cron.schedule('poll-change-history', '0 2,7 * * *', $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/poll-change-history',
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY')
  );
$$);
```

---

## Step 4. 카카오 알림톡

### 4-1. 사전 작업 (수동)

1. **카카오비즈니스 계정 생성** (https://business.kakao.com)
2. **발신 프로필 등록** (사업자등록증 + 통신판매업신고증 필요, 승인 1~3일)
3. **알림톡 템플릿 등록 및 심사** (승인 평균 5~7영업일)
   - 템플릿 예: `[NJ Safety 입찰알리미] #{공고기관}에서 #{공고명}이(가) 게시되었습니다. 추정가 #{추정가}원, 마감 #{마감일시}. 자세히 보기: #{URL}`
4. **API 발송 채널 결정**
   - 직접 카카오 API: 가장 저렴 (건당 8~15원)하지만 발신프로필 신청 복잡
   - **추천: 솔라피(Solapi), 알리고(Aligo) 같은 메시지 게이트웨이** — 가입 즉시 사용 가능, 건당 9~12원, API 단순

### 4-2. `supabase/functions/_shared/kakao-client.ts` (솔라피 기준)

```typescript
const SOLAPI_API_KEY = Deno.env.get('SOLAPI_API_KEY')!
const SOLAPI_API_SECRET = Deno.env.get('SOLAPI_API_SECRET')!
const SOLAPI_PFID = Deno.env.get('SOLAPI_PFID')!          // 카카오 채널 ID
const SOLAPI_TEMPLATE_ID = Deno.env.get('SOLAPI_TEMPLATE_ID')!
const SOLAPI_FROM = Deno.env.get('SOLAPI_FROM')!          // 발신번호

interface KakaoSendParams {
  to: string                                              // 수신자 010XXXXXXXX
  variables: Record<string, string>                       // 템플릿 치환값
}

/** HMAC-SHA256 서명 생성 */
async function generateSignature(date: string, salt: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(SOLAPI_API_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(date + salt))
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function sendKakaoAlimtalk(params: KakaoSendParams) {
  const date = new Date().toISOString()
  const salt = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const signature = await generateSignature(date, salt)
  
  const res = await fetch('https://api.solapi.com/messages/v4/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `HMAC-SHA256 apiKey=${SOLAPI_API_KEY}, date=${date}, salt=${salt}, signature=${signature}`,
    },
    body: JSON.stringify({
      message: {
        to: params.to,
        from: SOLAPI_FROM,
        kakaoOptions: {
          pfId: SOLAPI_PFID,
          templateId: SOLAPI_TEMPLATE_ID,
          variables: params.variables,
        },
      },
    }),
  })
  
  if (!res.ok) {
    const err = await res.json()
    throw new Error(`Solapi error: ${err.errorMessage ?? res.status}`)
  }
  return await res.json()
}
```

### 4-3. `supabase/functions/send-kakao-notification/index.ts`

```typescript
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { sendKakaoAlimtalk } from '../_shared/kakao-client.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req) => {
  const { tenderIds, notificationType } = await req.json()
  // notificationType: 'new' | 'd-3' | 'd-1' | 'change'
  
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  
  // 알림 활성 사용자 조회
  const { data: settings } = await supabase
    .from('notification_settings')
    .select('*')
    .eq('kakao_enabled', true)
  
  if (!settings || settings.length === 0) {
    return new Response(JSON.stringify({ sent: 0, reason: 'no_active_users' }))
  }
  
  const { data: tenders } = await supabase
    .from('tenders')
    .select('id, bid_ntce_nm, dminstt_nm, ntce_instt_nm, presmpt_prce, bid_clse_dt, bid_ntce_url')
    .in('id', tenderIds)
  
  let successCount = 0
  for (const user of settings) {
    if (!user.kakao_phone) continue
    
    // 조용 시간(quiet hours) 체크
    const hour = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours()
    if (isQuietHour(hour, user.quiet_hours_start, user.quiet_hours_end)) continue
    
    for (const tender of tenders ?? []) {
      try {
        await sendKakaoAlimtalk({
          to: user.kakao_phone.replace(/-/g, ''),
          variables: {
            '#{공고기관}': tender.dminstt_nm ?? tender.ntce_instt_nm ?? '-',
            '#{공고명}': tender.bid_ntce_nm,
            '#{추정가}': (tender.presmpt_prce ?? 0).toLocaleString(),
            '#{마감일시}': formatKSTDate(tender.bid_clse_dt),
            '#{URL}': tender.bid_ntce_url ?? '',
          },
        })
        
        await supabase.from('notifications_log').insert({
          channel: 'kakao',
          recipient: user.kakao_phone,
          tender_ids: [tender.id],
          tender_count: 1,
          status: 'sent',
          sent_at: new Date().toISOString(),
        })
        successCount++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('알림톡 발송 실패:', msg)
        await supabase.from('notifications_log').insert({
          channel: 'kakao',
          recipient: user.kakao_phone,
          tender_ids: [tender.id],
          tender_count: 1,
          status: 'failed',
          error_msg: msg,
        })
      }
    }
  }
  
  return new Response(JSON.stringify({ sent: successCount }))
})

function isQuietHour(currentHour: number, start: number, end: number): boolean {
  if (start < end) return currentHour >= start && currentHour < end
  return currentHour >= start || currentHour < end  // 22→7 같이 자정 넘는 경우
}

function formatKSTDate(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000)
  return kst.toISOString().slice(0, 16).replace('T', ' ')
}
```

### 4-4. 기존 알림 함수에 카카오 발송 호출 추가

`send-tender-notification`, `check-deadlines`, `poll-change-history` 모두 이메일 발송 후 동일한 `tender_ids`로 `send-kakao-notification`도 호출하도록 수정.

---

## Step 5. 응찰 파이프라인 UI (칸반 보드)

### 5-1. `BidPipeline.tsx`

```tsx
import { useTenders } from '../hooks/useTenders'
import { TenderCard } from './TenderCard'
import type { TenderStatus } from '../types'

const COLUMNS: { status: TenderStatus; label: string; color: string }[] = [
  { status: 'new',      label: '신규',   color: 'border-blue-500' },
  { status: 'reviewed', label: '검토',   color: 'border-purple-500' },
  { status: 'applied',  label: '응찰',   color: 'border-orange-500' },
  { status: 'won',      label: '낙찰',   color: 'border-green-500' },
  { status: 'lost',     label: '미낙찰', color: 'border-gray-400' },
]

export function BidPipeline() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-5 gap-4 overflow-x-auto">
      {COLUMNS.map(col => (
        <PipelineColumn key={col.status} {...col} />
      ))}
    </div>
  )
}

function PipelineColumn({ status, label, color }: typeof COLUMNS[number]) {
  const { data: tenders = [] } = useTenders({ status, limit: 20 })
  
  return (
    <div className={`bg-gray-50 rounded-lg p-3 border-t-4 ${color}`}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">{label}</h3>
        <span className="text-sm text-gray-500">{tenders.length}</span>
      </div>
      <div className="space-y-2">
        {tenders.map(t => (
          <TenderCard key={t.id} tender={t} />
        ))}
      </div>
    </div>
  )
}
```

### 5-2. `ApplicationForm.tsx` — 공고 상세에서 응찰 검토 입력

```tsx
- 견적가, 예상 마진, 응찰 메모 입력
- "응찰 결정" 버튼 → status: 'applied', tender_applications 레코드 생성
- "응찰 안 함" 버튼 → status: 'skipped', skip_reason 입력
```

---

## Step 6. 설정 페이지

### 6-1. `SettingsPage.tsx`

```
[알림 채널]
  ☑ 이메일 알림    (수신: bangbong@njsafety.co.kr)
  ☑ 카카오톡 알림  (수신: 010-XXXX-XXXX)

[알림 종류]
  ☑ 신규 공고 일일 요약 (매일 오전 8:30)
  ☑ 마감 3일 전 알림 (D-3)
  ☑ 마감 1일 전 알림 (D-1)
  ☑ 공고 변경 알림 (정정/취소)

[조용 시간]
  알림 받지 않을 시간: [22] 시 ~ [07] 시

[필터링]
  최소 매칭 점수: [7] (낮출수록 알림 많아짐)
```

---

## Step 7. 라우팅

```tsx
<Route path="/tenders/pipeline" element={<PipelinePage />} />
<Route path="/tenders/settings" element={<SettingsPage />} />
```

---

## Phase 4 완료 체크리스트

### 시스템
- [ ] 모든 Phase 4 테이블 생성
- [ ] 마감 임박 함수(D-3, D-1) 배포 + Cron 등록 + 발송 확인
- [ ] 변경이력 감지 함수 배포 + Cron 등록 + 정정공고 시 알림 확인
- [ ] 우리 사업자번호 등록 (`our_company` 테이블)
- [ ] 낙찰/미낙찰 자동 트리거 동작 확인

### 카카오 알림톡
- [ ] 카카오 비즈니스 발신 프로필 승인 완료
- [ ] 알림톡 템플릿 4종(신규/D-3/D-1/변경) 심사 통과
- [ ] 솔라피 또는 직접 API 연동 완료
- [ ] Supabase Secrets에 카카오 관련 환경변수 등록
- [ ] 테스트 알림톡 수신 성공

### UI
- [ ] 응찰 파이프라인 칸반 보드 동작
- [ ] 공고 상세에서 응찰 검토 폼 입력/저장
- [ ] 설정 페이지에서 알림 채널/조용 시간 조정 가능
- [ ] 변경이력 패널이 공고 상세에 표시됨

---

## 향후 확장 아이디어 (Phase 5+ 후보)

| 아이디어 | 가치 |
|---------|------|
| AI 자동 견적가 추천 | 과거 낙찰 데이터 기반 ML로 우리 견적가 가이드 |
| 입찰 캘린더 뷰 | 월간 캘린더에 마감일 시각화 |
| 발주기관별 발주 패턴 분석 | "한전 충북본부는 매년 3월에 발주" 같은 패턴 자동 발견 |
| Slack/Discord 연동 | 팀 협업 시 채널 알림 |
| 모바일 PWA 알림 | 앱 설치 없이 푸시 알림 |
| FLAMOUR 발주 모니터링 | 패션/리테일 카테고리 별도 모니터링 (사전 시장 조사) |
| 입찰 보증서/계약 보증서 만료 알림 | 회계/법무 워크플로우 연계 |
| 경쟁사 신제품 출시 모니터링 | 낙찰업체의 제품 카탈로그 자동 수집 |

이제 NJ Safety 입찰 모니터링 시스템이 단순 알림 도구를 넘어 **B2G 영업 인텔리전스 플랫폼**으로 자리잡았습니다. 🎉
