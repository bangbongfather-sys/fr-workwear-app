/**
 * 입찰 알림 이메일 HTML 템플릿.
 *
 * 작업지시서 `phase-2-notification-dashboard.md` Step 2-1 기반.
 * 컬러는 NJ Safety navy(#1e3a5f) → fr-workwear-app NJ Orange(#EC6608) + charcoal(#14171D)로 변환.
 * 한국어 텍스트 / Pretendard 폰트 / 모바일 친화 인라인 스타일 (Gmail/네이버 메일 등 대응).
 */

import type { TenderForEmail } from './types';

// ─── 브랜드 컬러 (fr-workwear-app 톤) ───
const BRAND_ORANGE = '#EC6608';
const BRAND_ORANGE_LIGHT = '#FFE9D6';
const INK = '#14171D';
const TEXT_2 = '#5A6270';
const TEXT_3 = '#828A98';
const BORDER = '#E5E8ED';
const BG = '#F7F5F0';

// ─── 마감 임박 색상 ───
const DANGER = '#F04452';      // D-1 이내 / 마감
const WARNING = '#FF9500';     // D-3 이내
const CAUTION = '#D69E2E';     // D-7 이내
const NORMAL = BRAND_ORANGE;   // D-7 이후

// ─── 헬퍼 ───

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return c;
    }
  });
}

function formatPrice(amount: number | null): string {
  if (amount === null || amount === undefined) return '-';
  return amount.toLocaleString('ko-KR') + '원';
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  // KST로 변환 후 "YYYY-MM-DD HH:mm" 포맷
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const mo = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const da = String(kst.getUTCDate()).padStart(2, '0');
  const h = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${da} ${h}:${mi}`;
}

function calculateDaysLeft(clseDt: string | null): number | null {
  if (!clseDt) return null;
  const d = new Date(clseDt);
  if (Number.isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

function deadlineBadge(clseDt: string | null): string {
  const days = calculateDaysLeft(clseDt);
  if (days === null) return '';
  const baseStyle = 'display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;';
  if (days < 0) {
    return `<span style="${baseStyle}background:#FFE0E3;color:${DANGER};">마감</span>`;
  }
  if (days <= 1) {
    return `<span style="${baseStyle}background:#FFE0E3;color:${DANGER};">D-${days}</span>`;
  }
  if (days <= 3) {
    return `<span style="${baseStyle}background:#FFE9D6;color:${WARNING};">D-${days}</span>`;
  }
  if (days <= 7) {
    return `<span style="${baseStyle}background:#FEF5DC;color:${CAUTION};">D-${days}</span>`;
  }
  return `<span style="${baseStyle}background:${BRAND_ORANGE_LIGHT};color:${NORMAL};">D-${days}</span>`;
}

// ─── 본 템플릿 ───

/**
 * 이메일 본문 렌더링.
 *
 * @param tenders 알림에 포함될 공고 목록 (보통 매칭 score 내림차순 + 마감일 오름차순으로 미리 정렬해서 전달)
 * @param appUrl  공고 상세 페이지 링크용 fr-workwear-app URL (예: https://fr-workwear-app.njsafety91.workers.dev)
 *                Phase 2에서 BidTab 통합 시 활용. 미설정 시 조달청 직링크만 사용.
 */
export function renderTenderEmail(tenders: TenderForEmail[], appUrl?: string): string {
  // KST 오늘 날짜
  const todayKST = new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const rows = tenders.map((t) => `
    <tr style="border-bottom:1px solid ${BORDER};">
      <td style="padding:14px 10px;vertical-align:top;">
        <a href="${escapeHtml(t.bidNtceUrl ?? '#')}" target="_blank"
           style="color:${INK};text-decoration:none;font-weight:700;font-size:14px;line-height:1.4;">
          ${escapeHtml(t.bidNtceNm)}
        </a>
        <div style="margin-top:6px;">${deadlineBadge(t.bidClseDt)}</div>
        <div style="margin-top:8px;font-size:11px;color:${TEXT_3};">
          매칭 키워드: <span style="color:${BRAND_ORANGE};font-weight:600;">${escapeHtml(t.matchedKeywords.join(', '))}</span>
          <span style="color:${TEXT_3};margin-left:6px;">· 점수 ${t.matchScore}</span>
        </div>
      </td>
      <td style="padding:14px 10px;vertical-align:top;font-size:13px;color:${TEXT_2};">
        ${escapeHtml(t.dminsttNm ?? t.ntceInsttNm ?? '-')}
      </td>
      <td style="padding:14px 10px;vertical-align:top;text-align:right;font-variant-numeric:tabular-nums;font-weight:700;font-size:14px;color:${INK};">
        ${escapeHtml(formatPrice(t.presmptPrce))}
      </td>
      <td style="padding:14px 10px;vertical-align:top;font-size:11px;color:${TEXT_3};white-space:nowrap;">
        ${escapeHtml(formatDateTime(t.bidClseDt))}
      </td>
    </tr>
  `).join('');

  const headerSubtitle = `${todayKST} · 신규 매칭 공고 <strong>${tenders.length}건</strong>`;

  const ctaButton = appUrl
    ? `<a href="${escapeHtml(appUrl)}" target="_blank"
          style="display:inline-block;padding:10px 24px;background:${BRAND_ORANGE};color:#ffffff;text-decoration:none;border-radius:8px;font-weight:700;font-size:13px;">
         웹앱에서 자세히 보기 →
       </a>`
    : '';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>NJ Safety 입찰 알리미</title>
</head>
<body style="margin:0;padding:0;background:${BG};font-family:'Pretendard',-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Noto Sans KR',sans-serif;color:${INK};">
  <div style="max-width:720px;margin:0 auto;padding:24px 16px;">

    <!-- 헤더 -->
    <div style="background:linear-gradient(135deg, ${INK} 0%, #2A2F38 100%);color:#ffffff;padding:24px 28px;border-radius:14px 14px 0 0;">
      <div style="display:inline-block;padding:3px 9px;background:${BRAND_ORANGE};border-radius:6px;font-size:11px;font-weight:700;letter-spacing:0.3px;text-transform:uppercase;margin-bottom:8px;">NJ Safety · 입찰 알리미</div>
      <h1 style="margin:0;font-size:22px;font-weight:800;letter-spacing:-0.5px;">신규 매칭 공고 ${tenders.length}건</h1>
      <div style="margin-top:6px;font-size:13px;opacity:0.78;">${headerSubtitle}</div>
    </div>

    <!-- 본문 테이블 -->
    <div style="background:#ffffff;padding:0;border-radius:0 0 14px 14px;border:1px solid ${BORDER};border-top:none;overflow:hidden;">
      ${tenders.length > 0 ? `
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="background:${BG};text-align:left;font-size:11px;color:${TEXT_3};text-transform:uppercase;letter-spacing:0.4px;">
              <th style="padding:10px 10px;font-weight:700;">공고명 / 매칭</th>
              <th style="padding:10px 10px;font-weight:700;">발주기관</th>
              <th style="padding:10px 10px;font-weight:700;text-align:right;">추정가</th>
              <th style="padding:10px 10px;font-weight:700;">마감</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      ` : `
        <div style="padding:48px 24px;text-align:center;color:${TEXT_3};font-size:13px;">
          오늘 발송할 신규 매칭 공고가 없습니다.
        </div>
      `}
    </div>

    ${ctaButton ? `<div style="text-align:center;margin-top:20px;">${ctaButton}</div>` : ''}

    <!-- 푸터 -->
    <div style="margin-top:20px;padding:14px 16px;background:#ffffff;border-radius:10px;border:1px solid ${BORDER};font-size:11px;color:${TEXT_3};text-align:center;line-height:1.6;">
      이 메일은 NJ Safety 입찰 모니터링 시스템에서 자동 발송되었습니다.<br>
      매일 KST 03:00 폴링 · KST 08:30 알림. 임계값 / 키워드는 fr-workwear-app에서 조정 가능.
    </div>
  </div>
</body>
</html>`;
}

/** 알림 이메일 제목 생성 */
export function buildSubject(count: number): string {
  const todayKST = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return `[NJ Safety 입찰알리미] 신규 ${count}건 · ${todayKST}`;
}
