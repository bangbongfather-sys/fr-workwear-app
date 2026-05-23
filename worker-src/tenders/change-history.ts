/**
 * Phase 4B — 공고 변경(정정/취소/연기) 이력 추적.
 *
 * 흐름:
 *  1. `tenders/notices`에서 활성 공고(마감 전 + status ∈ new/reviewed/applied) 조회
 *  2. 각 공고를 조달청 API에 재조회 → bidNtceOrd 비교
 *  3. 차수 변경 감지 시:
 *     - `tenders/changeHistory/{pushKey}` 기록
 *     - 마스터 `tenders/notices/{key}` rawData/bidNtceOrd 업데이트
 *  4. 변경 1건 이상이면 이메일 알림
 *
 * Cron: KST 11:00 (UTC 02:00), KST 16:00 (UTC 07:00) — `0 2,7 * * *`
 *
 * Rate limit 보호:
 * - 각 공고 조회 사이 300ms 대기
 * - 활성 공고 수가 많아지면 분할 처리 필요 (Phase 5+)
 */

import { fbGet, fbPatch, fbPush } from './firebase';
import { fetchTenderByBidNtceNo } from './g2b-client';
import { renderChangeEmail, buildChangeSubject } from './email-templates';
import type {
  ChangeHistoryRecord,
  NotificationLog,
  TenderEnv,
  TenderNotice,
} from './types';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 15_000;
const INTER_NOTICE_DELAY_MS = 300;

export interface ChangeHistoryResult {
  checked: number;
  detected: number;
  sent: boolean;
  messageId?: string | null;
  reason?: string;
  durationMs: number;
  changes: Array<{
    noticeKey: string;
    bidNtceNo: string;
    prevOrd: string;
    newOrd: string;
    changeType: string | null;
  }>;
}

/**
 * 활성 공고의 차수를 조달청 API와 비교해 변경 감지.
 */
export async function runChangeHistoryPoll(
  env: TenderEnv,
  appUrl?: string,
): Promise<ChangeHistoryResult> {
  validateChangeEnv(env);
  const startTime = Date.now();
  const nowMs = Date.now();
  const nowISO = new Date().toISOString();

  const allNotices = (await fbGet<Record<string, TenderNotice>>(
    '/tenders/notices',
    env.FIREBASE_DB_SECRET,
  )) ?? {};

  // 1. 활성 공고만 추출 — 마감 안 지났고 status가 결정 안 난 것
  const active: Array<{ key: string; notice: TenderNotice }> = [];
  for (const [key, notice] of Object.entries(allNotices)) {
    if (!notice) continue;
    if (notice.status !== 'new' && notice.status !== 'reviewed' && notice.status !== 'applied') continue;
    if (!notice.bidClseDt) continue;
    const clseMs = new Date(notice.bidClseDt).getTime();
    if (Number.isNaN(clseMs) || clseMs < nowMs) continue;
    active.push({ key, notice });
  }

  console.log(`[change-history] 활성 공고 ${active.length}건 점검 시작`);

  // Cloudflare Workers cron timeout 30s — 공고 1건당 ~300ms(sleep) + API 호출 ~1~2s
  // 80건 이상이면 timeout 위험. Phase 5에서 분할 처리 검토.
  if (active.length > 80) {
    console.warn(
      `[change-history] ⚠️ 활성 공고 ${active.length}건 — 30s timeout 위험. ` +
      `Phase 5에서 batched 처리 필요.`,
    );
  }

  if (active.length === 0) {
    return {
      checked: 0,
      detected: 0,
      sent: false,
      reason: 'no_active_tenders',
      durationMs: Date.now() - startTime,
      changes: [],
    };
  }

  // 2. 각 공고 재조회 + 비교
  const detected: ChangeHistoryResult['changes'] = [];
  const masterUpdates: Record<string, Partial<TenderNotice>> = {};

  for (const { key, notice } of active) {
    try {
      const latest = await fetchTenderByBidNtceNo(notice.bidNtceNo, env.G2B_SERVICE_KEY);
      if (!latest) {
        // API에서 사라진 경우 — 취소된 공고일 수 있음. 일단 패스 (Phase 5에서 별도 처리)
        continue;
      }
      const latestOrd = latest.bidNtceOrd ?? '00';
      if (latestOrd === notice.bidNtceOrd) continue;  // 변경 없음

      // 변경 감지 — changeHistory에 기록
      const record: ChangeHistoryRecord = {
        bidNtceNo: notice.bidNtceNo,
        bidNtceOrdPrev: notice.bidNtceOrd,
        bidNtceOrdNew: latestOrd,
        changeType: (latest.ntceKindNm as string | undefined) ?? '정정',
        changeReason: (latest['rbidPermsnYn'] as string | undefined) ?? null,
        prevData: notice.rawData,
        newData: latest as Record<string, unknown>,
        detectedAt: nowISO,
        notified: false,
      };
      await fbPush('/tenders/changeHistory', record, env.FIREBASE_DB_SECRET);

      // 마스터 노드 부분 갱신
      masterUpdates[`${key}/bidNtceOrd`] = latestOrd as unknown as Partial<TenderNotice>;
      masterUpdates[`${key}/rawData`] = latest as unknown as Partial<TenderNotice>;
      masterUpdates[`${key}/updatedAt`] = nowISO as unknown as Partial<TenderNotice>;

      detected.push({
        noticeKey: key,
        bidNtceNo: notice.bidNtceNo,
        prevOrd: notice.bidNtceOrd,
        newOrd: latestOrd,
        changeType: record.changeType,
      });
      console.log(`[change-history] 변경 감지: ${notice.bidNtceNo} (${notice.bidNtceOrd} → ${latestOrd})`);
    } catch (err) {
      console.error(`[change-history] ${notice.bidNtceNo} 조회 실패:`, err instanceof Error ? err.message : err);
    }

    // rate limit 보호
    await sleep(INTER_NOTICE_DELAY_MS);
  }

  // 3. 마스터 일괄 업데이트
  if (Object.keys(masterUpdates).length > 0) {
    await fbPatch('/tenders/notices', masterUpdates, env.FIREBASE_DB_SECRET);
  }

  if (detected.length === 0) {
    return {
      checked: active.length,
      detected: 0,
      sent: false,
      reason: 'no_changes',
      durationMs: Date.now() - startTime,
      changes: [],
    };
  }

  // 4. 변경 알림 발송
  const changesForEmail = detected.map((d) => {
    const notice = allNotices[d.noticeKey];
    return {
      noticeKey: d.noticeKey,
      bidNtceNo: d.bidNtceNo,
      bidNtceNm: notice?.bidNtceNm ?? '(제목 없음)',
      dminsttNm: notice?.dminsttNm ?? notice?.ntceInsttNm ?? null,
      bidNtceUrl: notice?.bidNtceUrl ?? null,
      bidClseDt: notice?.bidClseDt ?? null,
      prevOrd: d.prevOrd,
      newOrd: d.newOrd,
      changeType: d.changeType,
    };
  });

  const recipients = env.NOTIFICATION_EMAIL_TO!
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

  const subject = buildChangeSubject(detected.length);
  const html = renderChangeEmail(changesForEmail, appUrl);

  let sendResult: { id: string | null; error: string | null };
  try {
    sendResult = await callResend(
      subject,
      html,
      env.NOTIFICATION_EMAIL_FROM!,
      recipients,
      env.RESEND_API_KEY!,
    );
  } catch (err) {
    sendResult = { id: null, error: err instanceof Error ? err.message : String(err) };
  }

  const log: NotificationLog = {
    channel: 'email',
    recipient: recipients.join(','),
    subject,
    noticeKeys: detected.map((d) => d.noticeKey),
    noticeCount: detected.length,
    status: sendResult.error ? 'failed' : 'sent',
    providerMsgId: sendResult.id,
    errorMsg: sendResult.error,
    sentAt: sendResult.error ? null : nowISO,
    createdAt: nowISO,
  };
  await fbPush('/tenders/notificationsLog', log, env.FIREBASE_DB_SECRET);

  if (sendResult.error) {
    throw new Error(`변경 알림 발송 실패: ${sendResult.error}`);
  }

  return {
    checked: active.length,
    detected: detected.length,
    sent: true,
    messageId: sendResult.id,
    durationMs: Date.now() - startTime,
    changes: detected,
  };
}

async function callResend(
  subject: string,
  html: string,
  from: string,
  to: string[],
  apiKey: string,
): Promise<{ id: string | null; error: string | null }> {
  if (to.length === 0) {
    return { id: null, error: '수신자 이메일 주소 없음' };
  }
  let res: Response;
  try {
    res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
  } catch (err) {
    return { id: null, error: `Resend 네트워크 오류: ${err instanceof Error ? err.message : String(err)}` };
  }
  const text = await res.text();
  let data: { id?: string; message?: string; name?: string };
  try { data = JSON.parse(text) as typeof data; }
  catch { return { id: null, error: `Resend 응답 파싱 실패 (HTTP ${res.status})` }; }
  if (!res.ok) return { id: null, error: data.message ?? data.name ?? `HTTP ${res.status}` };
  if (!data.id) return { id: null, error: 'Resend 응답에 id 없음' };
  return { id: data.id, error: null };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function validateChangeEnv(env: TenderEnv): void {
  const missing: string[] = [];
  if (!env.FIREBASE_DB_SECRET) missing.push('FIREBASE_DB_SECRET');
  if (!env.G2B_SERVICE_KEY) missing.push('G2B_SERVICE_KEY');
  if (!env.RESEND_API_KEY) missing.push('RESEND_API_KEY');
  if (!env.NOTIFICATION_EMAIL_FROM) missing.push('NOTIFICATION_EMAIL_FROM');
  if (!env.NOTIFICATION_EMAIL_TO) missing.push('NOTIFICATION_EMAIL_TO');
  if (missing.length > 0) {
    throw new Error(`change-history 환경변수 누락: ${missing.join(', ')}`);
  }
}
