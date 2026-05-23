/**
 * Phase 2 — 이메일 알림 발송.
 *
 * 흐름:
 *  1. `tenders/notices`에서 `notifiedAt: null` + 최근 24시간 내 생성된 공고 조회
 *  2. matchScore 내림차순 + bidClseDt 오름차순 정렬
 *  3. Resend API로 이메일 발송
 *  4. 성공 시 모든 notices의 `notifiedAt` PATCH로 갱신
 *  5. `tenders/notificationsLog`에 결과 push (성공/실패)
 *
 * 작업지시서 `phase-2-notification-dashboard.md` Step 2-2 기반.
 * Supabase → Firebase RTDB 적응, Deno → Cloudflare Worker 적응.
 */

import { fbGet, fbPatch, fbPush } from './firebase';
import { renderTenderEmail, buildSubject } from './email-templates';
import type {
  NotificationLog,
  TenderEnv,
  TenderForEmail,
  TenderNotice,
} from './types';

/** 24시간 = 86,400,000 ms */
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Resend API endpoint */
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** Resend 호출 타임아웃 */
const RESEND_TIMEOUT_MS = 15_000;

// ─── 메인 함수 ──────────────────────────────────────────────────

export interface NotifyResult {
  sent: boolean;
  count: number;
  reason?: string;             // 발송 안 했을 때 사유
  messageId?: string | null;   // Resend 응답
  noticeKeys?: string[];       // 알림 대상 notice 키 목록
  durationMs: number;
}

/**
 * 이메일 알림 발송. cron(KST 08:30) 또는 수동 호출(`POST /api/tenders/send-notification`)에서 진입.
 *
 * @param env Worker 환경변수 (Resend 시크릿 + Firebase 시크릿)
 * @param appUrl 이메일 CTA에 들어갈 fr-workwear-app URL (선택, 미지정 시 CTA 버튼 생략)
 */
export async function sendTenderNotification(
  env: TenderEnv,
  appUrl?: string,
): Promise<NotifyResult> {
  validateNotifyEnv(env);
  const startTime = Date.now();
  const nowISO = new Date().toISOString();
  const nowMs = Date.now();

  // 1. 알림 안 보낸 + 최근 24시간 내 공고 조회
  const allNotices = (await fbGet<Record<string, TenderNotice>>(
    '/tenders/notices',
    env.FIREBASE_DB_SECRET,
  )) ?? {};

  const candidates: Array<{ key: string; notice: TenderNotice }> = [];
  for (const [key, notice] of Object.entries(allNotices)) {
    if (!notice) continue;
    if (notice.notifiedAt !== null && notice.notifiedAt !== undefined) continue;
    if (!notice.createdAt) continue;
    const createdMs = new Date(notice.createdAt).getTime();
    if (Number.isNaN(createdMs)) continue;
    if (nowMs - createdMs > RECENT_WINDOW_MS) continue;
    candidates.push({ key, notice });
  }

  // 2. 정렬: matchScore 내림차순 → bidClseDt 오름차순(임박 우선)
  candidates.sort((a, b) => {
    const scoreDiff = (b.notice.matchScore ?? 0) - (a.notice.matchScore ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    const aDt = a.notice.bidClseDt ? new Date(a.notice.bidClseDt).getTime() : Infinity;
    const bDt = b.notice.bidClseDt ? new Date(b.notice.bidClseDt).getTime() : Infinity;
    return aDt - bDt;
  });

  // 발송할 게 없으면 조기 종료 (빈 알림 보내지 않음)
  if (candidates.length === 0) {
    console.log('[notify] 발송 대상 공고 없음 — 알림 스킵');
    return {
      sent: false,
      count: 0,
      reason: 'no_new_tenders',
      durationMs: Date.now() - startTime,
    };
  }

  console.log(`[notify] 알림 대상 ${candidates.length}건`);

  // 3. 이메일 HTML 빌드
  const tendersForEmail: TenderForEmail[] = candidates.map(({ key, notice }) => ({
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
  }));

  const subject = buildSubject(tendersForEmail.length);
  const html = renderTenderEmail(tendersForEmail, appUrl);

  // 4. Resend API 호출
  const recipients = env.NOTIFICATION_EMAIL_TO!
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

  let sendResult: { id: string | null; error: string | null };
  try {
    sendResult = await callResend(subject, html, env.NOTIFICATION_EMAIL_FROM!, recipients, env.RESEND_API_KEY!);
  } catch (err) {
    sendResult = {
      id: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const noticeKeys = candidates.map((c) => c.key);
  const recipientsCsv = recipients.join(',');

  // 5. 알림 로그 push (성공이든 실패든)
  const log: NotificationLog = {
    channel: 'email',
    recipient: recipientsCsv,
    subject,
    noticeKeys,
    noticeCount: noticeKeys.length,
    status: sendResult.error ? 'failed' : 'sent',
    providerMsgId: sendResult.id,
    errorMsg: sendResult.error,
    sentAt: sendResult.error ? null : nowISO,
    createdAt: nowISO,
  };
  await fbPush('/tenders/notificationsLog', log, env.FIREBASE_DB_SECRET);

  // 발송 실패 시 throw — 호출자가 알 수 있게
  if (sendResult.error) {
    throw new Error(`Resend 발송 실패: ${sendResult.error}`);
  }

  // 6. 성공: notifiedAt 일괄 갱신 (notices/{key}/notifiedAt = nowISO)
  const notifyPayload: Record<string, string> = {};
  for (const key of noticeKeys) {
    notifyPayload[`${key}/notifiedAt`] = nowISO;
    notifyPayload[`${key}/updatedAt`] = nowISO;
  }
  await fbPatch('/tenders/notices', notifyPayload, env.FIREBASE_DB_SECRET);
  console.log(`[notify] notifiedAt 갱신 완료: ${noticeKeys.length}건`);

  return {
    sent: true,
    count: noticeKeys.length,
    messageId: sendResult.id,
    noticeKeys,
    durationMs: Date.now() - startTime,
  };
}

// ─── Resend 호출 ───────────────────────────────────────────────

async function callResend(
  subject: string,
  html: string,
  from: string,
  to: string[],
  apiKey: string,
): Promise<{ id: string | null; error: string | null }> {
  if (to.length === 0) {
    return { id: null, error: '수신자 이메일 주소 없음 (NOTIFICATION_EMAIL_TO 확인)' };
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
    return { id: null, error: `Resend 응답 파싱 실패 (HTTP ${res.status}): ${text.slice(0, 200)}` };
  }

  if (!res.ok) {
    return { id: null, error: data.message ?? data.name ?? `HTTP ${res.status}` };
  }
  if (!data.id) {
    return { id: null, error: 'Resend 응답에 id 필드 없음' };
  }
  return { id: data.id, error: null };
}

// ─── 테스트 발송 ───────────────────────────────────────────────

/**
 * 시스템 검증용 가짜 공고 1건으로 메일 발송. Firebase RTDB는 건드리지 않음.
 *
 * 라우트: `GET/POST /api/tenders/send-notification?test=true`
 * 용도:
 * - Phase 2 첫 배포 후 메일 도착 + HTML 디자인 확인
 * - DNS/Resend 설정 변경 후 발송 가능성 검증
 *
 * 안전성:
 * - notifiedAt 갱신 X
 * - notificationsLog 기록 X (디버깅이라 영구 기록 불필요)
 * - 실제 공고 데이터 영향 0
 */
export async function sendTestEmail(env: TenderEnv, appUrl?: string): Promise<NotifyResult> {
  validateNotifyEnv(env);
  const startTime = Date.now();

  // 샘플 공고 1건 — 다양한 필드 검증을 위해 의미 있는 값 채움
  const sampleTender: TenderForEmail = {
    noticeKey: 'TEST_SAMPLE_001',
    bidNtceNo: 'TEST-001',
    bidNtceNm: '[테스트] 방염복 100착 구매 (NJ Safety 입찰 시스템 검증용)',
    ntceInsttNm: '조달청 (테스트)',
    dminsttNm: '○○소방서 (테스트)',
    presmptPrce: 15_000_000,
    bidClseDt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(), // 5일 후 → D-5
    bidNtceUrl: 'https://www.g2b.go.kr',
    matchScore: 17,
    matchedKeywords: ['방염복', '아라미드'],
  };

  const subject = '[TEST] NJ Safety 입찰알리미 — 발송 검증';
  const html = renderTenderEmail([sampleTender], appUrl);

  const recipients = env.NOTIFICATION_EMAIL_TO!
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

  const sendResult = await callResend(
    subject,
    html,
    env.NOTIFICATION_EMAIL_FROM!,
    recipients,
    env.RESEND_API_KEY!,
  );

  if (sendResult.error) {
    throw new Error(`테스트 메일 발송 실패: ${sendResult.error}`);
  }

  return {
    sent: true,
    count: 1,
    messageId: sendResult.id,
    noticeKeys: ['TEST_SAMPLE_001'],
    durationMs: Date.now() - startTime,
  };
}

// ─── 환경변수 검증 ─────────────────────────────────────────────

function validateNotifyEnv(env: TenderEnv): void {
  const missing: string[] = [];
  if (!env.FIREBASE_DB_SECRET) missing.push('FIREBASE_DB_SECRET');
  if (!env.RESEND_API_KEY) missing.push('RESEND_API_KEY');
  if (!env.NOTIFICATION_EMAIL_FROM) missing.push('NOTIFICATION_EMAIL_FROM');
  if (!env.NOTIFICATION_EMAIL_TO) missing.push('NOTIFICATION_EMAIL_TO');
  if (missing.length > 0) {
    throw new Error(
      `이메일 알림 환경변수 누락: ${missing.join(', ')}\n` +
      `wrangler secret put / wrangler.jsonc vars로 등록 필요. ` +
      `자세한 설명은 docs/bid-system/phase-2-notification-dashboard.md 참조.`,
    );
  }
}
