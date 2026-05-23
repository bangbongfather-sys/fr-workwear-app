/**
 * KST 시간 처리 유틸리티.
 *
 * 조달청 API는 KST(UTC+9) 기준으로 동작하며, datetime 파라미터는 `YYYYMMDDHHMM` 형식.
 * 본 모듈은 UTC ↔ KST 변환과 조달청 API 포맷 변환을 담당.
 */

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;  // UTC+9

/**
 * UTC Date를 KST 시각으로 변환 (Date 객체의 UTC 메서드로 KST 값을 읽기 위한 wrapper).
 * 주의: 반환된 Date의 `.getUTCHours()` 등은 KST 시각을 가리킴.
 */
export function toKST(date: Date = new Date()): Date {
  return new Date(date.getTime() + KST_OFFSET_MS);
}

/**
 * 조달청 API용 datetime 포맷 (`YYYYMMDDHHMM`).
 * KST 기준으로 변환 후 포맷팅.
 *
 * @example formatG2BDatetime(new Date('2026-05-23T18:00:00Z')) → "202605240300"
 */
export function formatG2BDatetime(date: Date): string {
  const kst = toKST(date);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  const h = String(kst.getUTCHours()).padStart(2, '0');
  const min = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${y}${m}${d}${h}${min}`;
}

/**
 * "어제 00:00 ~ 23:59 (KST)" 범위를 조달청 API datetime 포맷으로 반환.
 * 매일 새벽 3시 cron 실행 시 전날 하루치를 통째로 쿼리하는 용도.
 *
 * @example 오늘이 2026-05-24 KST 03:00이면 → { bgn: "202605230000", end: "202605232359" }
 */
export function getYesterdayRangeKST(): { bgn: string; end: string } {
  const now = new Date();
  const kst = toKST(now);
  kst.setUTCDate(kst.getUTCDate() - 1);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  const ymd = `${y}${m}${d}`;
  return { bgn: `${ymd}0000`, end: `${ymd}2359` };
}

/**
 * 임의 기간을 KST 범위로 반환. 수동 호출/백필 테스트용.
 *
 * @param daysAgo "오늘로부터 N일 전부터 오늘까지" (예: 7 → 최근 7일)
 */
export function getRecentRangeKST(daysAgo: number): { bgn: string; end: string } {
  const now = new Date();
  const kstEnd = toKST(now);
  const kstBgn = toKST(now);
  kstBgn.setUTCDate(kstBgn.getUTCDate() - daysAgo);
  const fmt = (k: Date) => {
    const y = k.getUTCFullYear();
    const m = String(k.getUTCMonth() + 1).padStart(2, '0');
    const d = String(k.getUTCDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  };
  return { bgn: `${fmt(kstBgn)}0000`, end: `${fmt(kstEnd)}2359` };
}

/**
 * 조달청 API 응답의 날짜 문자열을 ISO 8601(KST 오프셋 포함)으로 변환.
 *
 * 조달청 응답 포맷 예:
 * - `"2026-05-22 10:00:00"` (공백 구분)
 * - `"20260522100000"` (14자리)
 * - `"2026-05-22T10:00:00"` (T 구분)
 *
 * 모두 KST 시각으로 가정하고 `+09:00` 오프셋 부착.
 *
 * @returns ISO 8601 문자열 또는 null (입력이 null/공백/파싱 실패 시)
 */
export function parseG2BDate(s: string | null | undefined): string | null {
  if (!s) return null;
  let normalized = String(s).trim();
  if (!normalized) return null;

  // 14자리 숫자 → 공백 구분 형식으로
  if (/^\d{14}$/.test(normalized)) {
    normalized = `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)} ` +
                 `${normalized.slice(8, 10)}:${normalized.slice(10, 12)}:${normalized.slice(12, 14)}`;
  }

  // "T" 또는 공백 구분 → KST 오프셋 부착해 ISO 8601 생성
  const isoCandidate = normalized.replace(' ', 'T') + '+09:00';
  const parsed = new Date(isoCandidate);
  if (Number.isNaN(parsed.getTime())) return null;

  return parsed.toISOString();
}
