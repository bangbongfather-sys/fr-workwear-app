/**
 * Phase 4A — 마감 임박 알림 (D-3, D-1).
 *
 * 흐름:
 *  1. `tenders/notices`에서 status ∈ {new, reviewed, applied} + bidClseDt 임박 공고 조회
 *  2. D-3 대상: 1d ≤ Δ ≤ 3d, D-1 대상: 0 < Δ ≤ 1d
 *  3. `tenders/deadlineReminders/{noticeKey}_{type}` 존재 여부로 중복 발송 차단 (idempotent)
 *  4. 이메일 발송 (D-3와 D-1을 한 메일에 묶음)
 *  5. 성공 시 deadlineReminders에 발송 이력 기록
 *
 * Cron: KST 09:00 (UTC 00:00), KST 14:00 (UTC 05:00) — `0 0,5 * * *`
 *
 * 기존 daily 알림(notify.ts)과 차이:
 * - notify.ts: 24h 내 신규 매칭 공고 모음
 * - deadline-check.ts: 마감 임박 공고 별도 알림 (이미 검토했어도 다시 환기)
 */

import { fbGet, fbPatch, fbPush } from './firebase';
import { renderDeadlineEmail, buildDeadlineSubject } from './email-templates';
import type {
  DeadlineReminderLog,
  NotificationLog,
  TenderEnv,
  TenderForEmail,
  TenderNotice,
} from './types';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 15_000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DeadlineCheckResult {
  d3Count: number;
  d1Count: number;
  sent: boolean;
  messageId?: string | null;
  reason?: string;
  durationMs: number;
}

/**
 * 마감 임박 공고 점검 + 알림 발송.
 * cron(KST 09:00, 14:00) 또는 수동 호출(`POST /api/tenders/check-deadlines`)에서 진입.
 */
export async function runDeadlineCheck(
  env: TenderEnv,
  appUrl?: string,
): Promise<DeadlineCheckResult> {
  validateDeadlineEnv(env);
  const startTime = Date.now();
  const nowMs = Date.now();
  const nowISO = new Date().toISOString();

  // 1. 모든 공고 + 발송 이력을 동시 로드
  const [allNotices, allReminders] = await Promise.all([
    fbGet<Record<string, TenderNotice>>('/tenders/notices', env.FIREBASE_DB_SECRET),
    fbGet<Record<string, DeadlineReminderLog>>('/tenders/deadlineReminders', env.FIREBASE_DB_SECRET),
  ]);

  const reminderSet = new Set(Object.keys(allReminders ?? {}));

  // 2. 마감 임박 분류
  const d3: Array<{ key: string; notice: TenderNotice }> = [];
  const d1: Array<{ key: string; notice: TenderNotice }> = [];

  for (const [key, notice] of Object.entries(allNotices ?? {})) {
    if (!notice || !notice.bidClseDt) continue;
    // 응찰 결정 끝난 (won/lost/skipped) 공고는 알림 제외
    if (notice.status !== 'new' && notice.status !== 'reviewed' && notice.status !== 'applied') continue;

    const clseMs = new Date(notice.bidClseDt).getTime();
    if (Number.isNaN(clseMs)) continue;
    const delta = clseMs - nowMs;

    // D-1: 0 < delta ≤ 24h
    if (delta > 0 && delta <= DAY_MS) {
      if (!reminderSet.has(`${key}_d-1`)) {
        d1.push({ key, notice });
      }
      continue;
    }
    // D-3: 24h < delta ≤ 72h
    if (delta > DAY_MS && delta <= 3 * DAY_MS) {
      if (!reminderSet.has(`${key}_d-3`)) {
        d3.push({ key, notice });
      }
    }
  }

  if (d3.length === 0 && d1.length === 0) {
    console.log('[deadline-check] 발송 대상 없음 — 스킵');
    return {
      d3Count: 0,
      d1Count: 0,
      sent: false,
      reason: 'no_deadlines_due',
      durationMs: Date.now() - startTime,
    };
  }

  console.log(`[deadline-check] D-3 ${d3.length}건, D-1 ${d1.length}건 발송 준비`);

  // 3. 이메일 페이로드
  const toTenderForEmail = ({ key, notice }: { key: string; notice: TenderNotice }): TenderForEmail => ({
    noticeKey: key,
    bidNtceNo: notice.bidNtceNo,
    bidNtceNm: notice.bidNtceNm,
    ntceInsttNm: notice.ntceInsttNm,
    dminsttNm: notice.dminsttNm,
    presmptPrce: notice.presmptPrce,
    bidClseDt: notice.bidClseDt,
    bidNtceUrl: notice.bidNtceUrl,
    matchScore: notice.matchScore,
    matchedKeywords: notice.matchedKeywords ?? [],
  });

  const d3Emails = d3.map(toTenderForEmail);
  const d1Emails = d1.map(toTenderForEmail);

  const subject = buildDeadlineSubject(d3Emails.length, d1Emails.length);
  const html = renderDeadlineEmail(d3Emails, d1Emails, appUrl);

  // 4. 발송
  const recipients = env.NOTIFICATION_EMAIL_TO!
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

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
    sendResult = {
      id: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 5. 알림 로그 (성공/실패 모두)
  const allKeys = [
    ...d3.map((c) => `${c.key} (D-3)`),
    ...d1.map((c) => `${c.key} (D-1)`),
  ];
  const log: NotificationLog = {
    channel: 'email',
    recipient: recipients.join(','),
    subject,
    noticeKeys: allKeys,
    noticeCount: allKeys.length,
    status: sendResult.error ? 'failed' : 'sent',
    providerMsgId: sendResult.id,
    errorMsg: sendResult.error,
    sentAt: sendResult.error ? null : nowISO,
    createdAt: nowISO,
  };
  // 로그는 auto-id로 push (동일 밀리초 충돌 방지)
  await fbPush('/tenders/notificationsLog', log, env.FIREBASE_DB_SECRET);

  if (sendResult.error) {
    throw new Error(`마감 임박 알림 발송 실패: ${sendResult.error}`);
  }

  // 6. deadlineReminders 일괄 기록 (idempotent)
  const reminderPayload: Record<string, DeadlineReminderLog> = {};
  for (const { key } of d3) {
    reminderPayload[`${key}_d-3`] = { noticeKey: key, type: 'd-3', sentAt: nowISO };
  }
  for (const { key } of d1) {
    reminderPayload[`${key}_d-1`] = { noticeKey: key, type: 'd-1', sentAt: nowISO };
  }
  await fbPatch('/tenders/deadlineReminders', reminderPayload, env.FIREBASE_DB_SECRET);
  console.log(`[deadline-check] 발송 이력 기록 완료: ${Object.keys(reminderPayload).length}건`);

  return {
    d3Count: d3.length,
    d1Count: d1.length,
    sent: true,
    messageId: sendResult.id,
    durationMs: Date.now() - startTime,
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
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, html }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
  } catch (err) {
    return { id: null, error: `Resend 네트워크 오류: ${err instanceof Error ? err.message : String(err)}` };
  }

  const text = await res.text();
  let data: { id?: string; message?: string; name?: string };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    return { id: null, error: `Resend 응답 파싱 실패 (HTTP ${res.status})` };
  }
  if (!res.ok) return { id: null, error: data.message ?? data.name ?? `HTTP ${res.status}` };
  if (!data.id) return { id: null, error: 'Resend 응답에 id 없음' };
  return { id: data.id, error: null };
}

function validateDeadlineEnv(env: TenderEnv): void {
  const missing: string[] = [];
  if (!env.FIREBASE_DB_SECRET) missing.push('FIREBASE_DB_SECRET');
  if (!env.RESEND_API_KEY) missing.push('RESEND_API_KEY');
  if (!env.NOTIFICATION_EMAIL_FROM) missing.push('NOTIFICATION_EMAIL_FROM');
  if (!env.NOTIFICATION_EMAIL_TO) missing.push('NOTIFICATION_EMAIL_TO');
  if (missing.length > 0) {
    throw new Error(`deadline-check 환경변수 누락: ${missing.join(', ')}`);
  }
}
