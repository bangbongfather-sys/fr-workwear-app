/**
 * 입찰 모니터링 — HTTP 라우터.
 *
 * worker.js의 fetch handler에서 `/api/tenders/*` 경로를 이 모듈로 위임.
 *
 * 지원 라우트 (Phase 1):
 * - POST /api/tenders/seed-keywords      — 시드 키워드 27개 일괄 등록 (1회용)
 * - GET  /api/tenders/poll?bgn=&end=     — 지정 기간 수동 폴링 (테스트)
 * - GET  /api/tenders/poll               — 어제 0~24시(KST) 폴링 (cron과 동일)
 *
 * 지원 라우트 (Phase 2):
 * - POST /api/tenders/send-notification  — 신규 매칭 공고 이메일 발송 (cron과 동일)
 *
 * 향후 Phase 2 UI 통합 시 추가 예정:
 * - GET  /api/tenders/notices            — 클라이언트가 수집 결과 조회
 * - POST /api/tenders/notices/:key/status — 사용자 상태 변경
 */

import { runPoll, runDailyPoll, seedKeywords, runDiagnostic } from './poll';
import { sendTenderNotification, sendTestEmail } from './notify';
import { runDeadlineCheck } from './deadline-check';
import { runChangeHistoryPoll } from './change-history';
import { fbGet, fbPatch } from './firebase';
import type { ChangeHistoryRecord, KeywordCategory, TenderEnv, TenderKeyword, TenderNotice, TenderStatus } from './types';

/** 클라이언트에 노출 가능한 status 값 화이트리스트 */
const VALID_STATUSES: readonly TenderStatus[] = [
  'new', 'reviewed', 'applied', 'won', 'lost', 'skipped',
] as const;

/** 키워드 카테고리 화이트리스트 */
const VALID_CATEGORIES: readonly KeywordCategory[] = [
  'core', 'material', 'standard', 'usage', 'exclude',
] as const;

/** 사용자 추가 키워드의 deterministic 키 생성 (시드의 `seed_X`와 구분) */
function userKeywordKey(keyword: string): string {
  const safe = keyword.replace(/[.$#\[\]\/\s]/g, '_');
  return `user_${safe}`;
}

/** 키워드 입력값 정규화 + 검증 */
function validateKeywordInput(input: Partial<TenderKeyword>): string | null {
  if (input.keyword !== undefined) {
    if (typeof input.keyword !== 'string') return 'keyword는 문자열이어야 합니다';
    if (!input.keyword.trim()) return 'keyword는 비어있을 수 없습니다';
    if (input.keyword.length > 100) return 'keyword는 100자 이하여야 합니다';
  }
  if (input.category !== undefined && !VALID_CATEGORIES.includes(input.category)) {
    return `category는 다음 중 하나여야 합니다: ${VALID_CATEGORIES.join(', ')}`;
  }
  if (input.weight !== undefined) {
    if (typeof input.weight !== 'number' || !Number.isFinite(input.weight)) {
      return 'weight는 숫자여야 합니다';
    }
    if (input.weight < -100 || input.weight > 100) {
      return 'weight는 -100 ~ 100 범위여야 합니다';
    }
  }
  if (input.isActive !== undefined && typeof input.isActive !== 'boolean') {
    return 'isActive는 boolean이어야 합니다';
  }
  return null;
}

const JSON_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json; charset=utf-8',
} as const;

/** 공통 응답 헬퍼 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: JSON_HEADERS,
  });
}

function errorResponse(err: unknown, status = 500): Response {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[tenders router] 에러 (${status}):`, message);
  return jsonResponse({ error: message }, status);
}

/**
 * `/api/tenders/*` 라우트 처리.
 * worker.js에서 호출되며, 매칭 안 되는 경로는 404 반환.
 */
export async function handleTendersApi(
  request: Request,
  env: TenderEnv,
  url: URL,
): Promise<Response> {
  const path = url.pathname.replace(/^\/api\/tenders\/?/, '');  // "seed-keywords", "poll" 등

  try {
    // ─── POST /api/tenders/seed-keywords ───
    if (path === 'seed-keywords') {
      if (request.method !== 'POST') {
        return errorResponse('이 엔드포인트는 POST 메서드만 허용합니다', 405);
      }
      const result = await seedKeywords(env);
      return jsonResponse({
        ok: true,
        message: `시드 키워드 등록 완료 — 신규 ${result.inserted}건, 업데이트 ${result.updated}건 (총 ${result.total}건)`,
        ...result,
      });
    }

    // ─── GET /api/tenders/poll[?bgn=&end=] ───
    if (path === 'poll') {
      if (request.method !== 'GET' && request.method !== 'POST') {
        return errorResponse('이 엔드포인트는 GET 또는 POST 메서드만 허용합니다', 405);
      }
      const bgn = url.searchParams.get('bgn');
      const end = url.searchParams.get('end');

      // 둘 다 지정 시 그 범위 / 둘 다 미지정 시 어제 / 한쪽만 지정 시 에러
      if (bgn && end) {
        if (!isValidG2BDatetime(bgn) || !isValidG2BDatetime(end)) {
          return errorResponse('bgn/end는 YYYYMMDDHHMM 형식이어야 합니다', 400);
        }
        const result = await runPoll(bgn, end, env);
        return jsonResponse({ ok: true, mode: 'custom-range', ...result });
      }
      if (bgn || end) {
        return errorResponse('bgn과 end는 함께 지정하거나 둘 다 생략해야 합니다', 400);
      }
      // 기본: 어제 0~24시 (KST)
      const result = await runDailyPoll(env);
      return jsonResponse({ ok: true, mode: 'yesterday-kst', ...result });
    }

    // ─── POST /api/tenders/send-notification[?test=true] ───
    if (path === 'send-notification') {
      if (request.method !== 'POST' && request.method !== 'GET') {
        return errorResponse('이 엔드포인트는 GET 또는 POST 메서드만 허용합니다', 405);
      }
      // appUrl은 클라이언트 호스트로 자동 추론 (e.g. https://fr-workwear-app.njsafety91.workers.dev)
      const appUrl = `${url.protocol}//${url.host}`;
      // ?test=true → 가짜 공고 1건으로 발송 (Firebase RTDB 건드리지 않음, 디버깅용)
      const isTest = url.searchParams.get('test') === 'true';
      const result = isTest
        ? await sendTestEmail(env, appUrl)
        : await sendTenderNotification(env, appUrl);
      return jsonResponse({ ok: true, mode: isTest ? 'test' : 'production', ...result });
    }

    // ─── GET /api/tenders/diag?bgn=&end= (진단 — 매칭 0건 원인 분석) ───
    // read-only. Firebase에 안 씀. 넓은 키워드로 수집 데이터를 훑어 표기 변형/부재 판별.
    if (path === 'diag') {
      const bgn = url.searchParams.get('bgn');
      const end = url.searchParams.get('end');
      if (!bgn || !end || !isValidG2BDatetime(bgn) || !isValidG2BDatetime(end)) {
        return errorResponse('bgn/end는 YYYYMMDDHHMM 형식 필수 (예: ?bgn=202605230000&end=202605300000)', 400);
      }
      const result = await runDiagnostic(bgn, end, env);
      return jsonResponse({ ok: true, ...result });
    }

    // ─── POST /api/tenders/check-deadlines ───
    // Phase 4A: 마감 임박(D-3, D-1) 알림 수동 트리거.
    // cron이 자동으로 KST 09:00, 14:00에 호출. 디버깅·즉시 점검 용.
    if (path === 'check-deadlines') {
      if (request.method !== 'POST' && request.method !== 'GET') {
        return errorResponse('이 엔드포인트는 GET 또는 POST 메서드만 허용합니다', 405);
      }
      const appUrl = `${url.protocol}//${url.host}`;
      const result = await runDeadlineCheck(env, appUrl);
      return jsonResponse({ ok: true, ...result });
    }

    // ─── POST /api/tenders/check-changes ───
    // Phase 4B: 공고 변경(정정/취소) 추적 수동 트리거.
    // cron이 자동으로 KST 11:00, 16:00에 호출.
    if (path === 'check-changes') {
      if (request.method !== 'POST' && request.method !== 'GET') {
        return errorResponse('이 엔드포인트는 GET 또는 POST 메서드만 허용합니다', 405);
      }
      const appUrl = `${url.protocol}//${url.host}`;
      const result = await runChangeHistoryPoll(env, appUrl);
      return jsonResponse({ ok: true, ...result });
    }

    // ─── GET /api/tenders/change-history ───
    // 변경이력 목록 (최신순). UI에서 공고 상세에 표시.
    if (path === 'change-history') {
      if (request.method !== 'GET') {
        return errorResponse('이 엔드포인트는 GET 메서드만 허용합니다', 405);
      }
      const data = await fbGet<Record<string, ChangeHistoryRecord>>(
        '/tenders/changeHistory',
        env.FIREBASE_DB_SECRET,
      );
      const list: Array<ChangeHistoryRecord & { key: string }> = [];
      if (data) {
        for (const [key, rec] of Object.entries(data)) {
          if (!rec) continue;
          // 페이로드 크기 ↓ — prevData/newData는 별도 요청 시에만 반환 (?detail=true)
          if (url.searchParams.get('detail') === 'true') {
            list.push({ key, ...rec });
          } else {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { prevData: _p, newData: _n, ...rest } = rec;
            list.push({ key, ...rest, prevData: null, newData: null });
          }
        }
      }
      // 감지 시각 내림차순
      list.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
      return jsonResponse({ ok: true, count: list.length, changes: list });
    }

    // ─── GET /api/tenders/notices ───
    // 클라이언트(BidsTab)가 수집된 공고를 표시하기 위해 호출.
    // 응답에서 rawData(원본 조달청 응답)는 제외 → 페이로드 크기 ↓.
    if (path === 'notices') {
      if (request.method !== 'GET') {
        return errorResponse('이 엔드포인트는 GET 메서드만 허용합니다', 405);
      }
      const data = await fbGet<Record<string, TenderNotice>>(
        '/tenders/notices',
        env.FIREBASE_DB_SECRET,
      );
      // rawData 제외 + key를 객체에 포함해 클라이언트가 쉽게 참조
      const notices: Array<Omit<TenderNotice, 'rawData'> & { key: string }> = [];
      if (data) {
        for (const [key, n] of Object.entries(data)) {
          if (!n) continue;
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { rawData: _rawData, ...rest } = n;
          notices.push({ key, ...rest });
        }
      }
      return jsonResponse({ ok: true, count: notices.length, notices });
    }

    // ─── PATCH /api/tenders/notices/{key} ───
    // 사용자 상태 변경 (신규 → 검토 → 응찰 → 낙찰/미낙찰/제외) + Phase 4C 응찰 필드.
    // body 예시:
    //   { "status": "applied", "estimatedCost": 12000000, "estimatedMargin": 18, "applicationMemo": "..." }
    //   { "status": "skipped", "skipReason": "원가 미달" }
    //   { "status": "reviewed" }
    const noticeMatch = path.match(/^notices\/(.+)$/);
    if (noticeMatch) {
      const key = decodeURIComponent(noticeMatch[1]!);

      // DELETE — 공고 1건 영구 삭제 (실수 방지 위해 ?confirm=true 필수)
      if (request.method === 'DELETE') {
        if (url.searchParams.get('confirm') !== 'true') {
          return errorResponse('공고 삭제는 ?confirm=true 필수입니다', 400);
        }
        await fbPatch('/tenders/notices', { [key]: null }, env.FIREBASE_DB_SECRET);
        return jsonResponse({ ok: true, key, deleted: true });
      }

      if (request.method !== 'PATCH' && request.method !== 'POST') {
        return errorResponse('이 엔드포인트는 PATCH, POST, DELETE 메서드만 허용합니다', 405);
      }
      let body: Partial<TenderNotice>;
      try {
        body = (await request.json()) as Partial<TenderNotice>;
      } catch {
        return errorResponse('요청 본문이 유효한 JSON이 아닙니다', 400);
      }

      const nowISO = new Date().toISOString();
      const patch: Record<string, unknown> = { updatedAt: nowISO };

      if (body.status !== undefined) {
        if (!VALID_STATUSES.includes(body.status as TenderStatus)) {
          return errorResponse(
            `status는 다음 중 하나여야 합니다: ${VALID_STATUSES.join(', ')}`,
            400,
          );
        }
        patch['status'] = body.status;
        // applied/skipped 결정 시 reviewedAt 자동 기록
        if (body.status === 'applied' || body.status === 'skipped') {
          patch['reviewedAt'] = nowISO;
        }
      }

      // Phase 4C 응찰 필드 — 옵셔널 검증
      const numCheck = (v: unknown, name: string): string | null => {
        if (v === null) return null;  // null은 명시적 해제로 허용
        if (typeof v !== 'number' || !Number.isFinite(v)) return `${name}는 숫자여야 합니다`;
        if (v < 0) return `${name}는 0 이상이어야 합니다`;
        return null;
      };
      if (body.estimatedCost !== undefined) {
        const err = numCheck(body.estimatedCost, 'estimatedCost');
        if (err) return errorResponse(err, 400);
        patch['estimatedCost'] = body.estimatedCost;
      }
      if (body.estimatedMargin !== undefined) {
        const err = numCheck(body.estimatedMargin, 'estimatedMargin');
        if (err) return errorResponse(err, 400);
        patch['estimatedMargin'] = body.estimatedMargin;
      }
      if (body.ourBidAmount !== undefined) {
        const err = numCheck(body.ourBidAmount, 'ourBidAmount');
        if (err) return errorResponse(err, 400);
        patch['ourBidAmount'] = body.ourBidAmount;
      }
      if (body.applicationMemo !== undefined) {
        if (body.applicationMemo !== null && typeof body.applicationMemo !== 'string') {
          return errorResponse('applicationMemo는 문자열이어야 합니다', 400);
        }
        if (typeof body.applicationMemo === 'string' && body.applicationMemo.length > 2000) {
          return errorResponse('applicationMemo는 2000자 이하여야 합니다', 400);
        }
        patch['applicationMemo'] = body.applicationMemo;
      }
      if (body.skipReason !== undefined) {
        if (body.skipReason !== null && typeof body.skipReason !== 'string') {
          return errorResponse('skipReason는 문자열이어야 합니다', 400);
        }
        if (typeof body.skipReason === 'string' && body.skipReason.length > 500) {
          return errorResponse('skipReason는 500자 이하여야 합니다', 400);
        }
        patch['skipReason'] = body.skipReason;
      }

      // updatedAt + status/reviewedAt 외에 아무 필드도 없으면 거부
      const realFields = Object.keys(patch).filter((k) => k !== 'updatedAt');
      if (realFields.length === 0) {
        return errorResponse('갱신할 필드가 없습니다', 400);
      }

      await fbPatch(`/tenders/notices/${key}`, patch, env.FIREBASE_DB_SECRET);
      return jsonResponse({ ok: true, key, patch });
    }

    // ─── GET /api/tenders/keywords ───
    // 전체 키워드 목록 (시드 + 사용자 추가) 반환. KeywordManager UI가 호출.
    if (path === 'keywords') {
      if (request.method === 'GET') {
        const data = await fbGet<Record<string, TenderKeyword>>(
          '/tenders/keywords',
          env.FIREBASE_DB_SECRET,
        );
        const list: Array<TenderKeyword & { key: string; isSeed: boolean }> = [];
        if (data) {
          for (const [key, kw] of Object.entries(data)) {
            if (!kw) continue;
            list.push({ key, isSeed: key.startsWith('seed_'), ...kw });
          }
        }
        // 카테고리·가중치 순 정렬
        list.sort((a, b) => {
          const catOrder = VALID_CATEGORIES.indexOf(a.category) - VALID_CATEGORIES.indexOf(b.category);
          if (catOrder !== 0) return catOrder;
          return b.weight - a.weight;
        });
        return jsonResponse({ ok: true, count: list.length, keywords: list });
      }

      // ─── POST /api/tenders/keywords ───
      // 신규 사용자 키워드 추가. body: { keyword, category, weight }
      if (request.method === 'POST') {
        let body: Partial<TenderKeyword>;
        try { body = (await request.json()) as Partial<TenderKeyword>; }
        catch { return errorResponse('요청 본문이 유효한 JSON이 아닙니다', 400); }

        const required: Array<keyof TenderKeyword> = ['keyword', 'category', 'weight'];
        for (const f of required) {
          if (body[f] === undefined || body[f] === null) {
            return errorResponse(`${f} 필드가 필요합니다`, 400);
          }
        }
        const errMsg = validateKeywordInput(body);
        if (errMsg) return errorResponse(errMsg, 400);

        const keyword = (body.keyword as string).trim();
        const key = userKeywordKey(keyword);

        // 중복 검사 (seed_X 또는 user_X에 같은 키워드 존재 시 거부)
        const existing = await fbGet<Record<string, TenderKeyword>>(
          '/tenders/keywords',
          env.FIREBASE_DB_SECRET,
        );
        if (existing) {
          for (const kw of Object.values(existing)) {
            if (kw && kw.keyword === keyword) {
              return errorResponse(`이미 등록된 키워드입니다: "${keyword}"`, 409);
            }
          }
        }

        const nowISO = new Date().toISOString();
        const newKw: TenderKeyword = {
          keyword,
          category: body.category as KeywordCategory,
          weight: body.weight as number,
          isActive: body.isActive ?? true,
          createdAt: nowISO,
        };
        await fbPatch(`/tenders/keywords`, { [key]: newKw }, env.FIREBASE_DB_SECRET);
        return jsonResponse({ ok: true, key, keyword: newKw });
      }

      return errorResponse('이 엔드포인트는 GET 또는 POST 메서드만 허용합니다', 405);
    }

    // ─── PATCH /api/tenders/keywords/{key} ───
    // 부분 갱신 (category, weight, isActive). keyword 필드는 변경 불가 (키 충돌 방지).
    // ─── DELETE /api/tenders/keywords/{key} ───
    // user_* 키워드만 삭제 허용. seed_* 는 차단 (재시드 시 복원되므로 의미 없음).
    const keywordMatch = path.match(/^keywords\/(.+)$/);
    if (keywordMatch) {
      const key = decodeURIComponent(keywordMatch[1]!);

      if (request.method === 'PATCH' || request.method === 'POST') {
        let body: Partial<TenderKeyword>;
        try { body = (await request.json()) as Partial<TenderKeyword>; }
        catch { return errorResponse('요청 본문이 유효한 JSON이 아닙니다', 400); }

        // keyword 필드 변경 금지 (키와 일치해야 매칭됨)
        if (body.keyword !== undefined) {
          return errorResponse('keyword 필드는 변경 불가 (삭제 후 재등록 필요)', 400);
        }
        const errMsg = validateKeywordInput(body);
        if (errMsg) return errorResponse(errMsg, 400);

        const patch: Partial<TenderKeyword> = {};
        if (body.category !== undefined) patch.category = body.category;
        if (body.weight !== undefined) patch.weight = body.weight;
        if (body.isActive !== undefined) patch.isActive = body.isActive;
        if (Object.keys(patch).length === 0) {
          return errorResponse('갱신할 필드가 없습니다 (category/weight/isActive 중 하나 필요)', 400);
        }

        await fbPatch(`/tenders/keywords/${key}`, patch, env.FIREBASE_DB_SECRET);
        return jsonResponse({ ok: true, key, patch });
      }

      if (request.method === 'DELETE') {
        if (key.startsWith('seed_')) {
          return errorResponse(
            `시드 키워드는 삭제할 수 없습니다 (재시드 시 복원됨). 비활성화 원하면 isActive: false PATCH 사용.`,
            403,
          );
        }
        // Firebase RTDB는 DELETE로 노드 제거
        await fbPatch(`/tenders/keywords`, { [key]: null }, env.FIREBASE_DB_SECRET);
        return jsonResponse({ ok: true, key, deleted: true });
      }

      return errorResponse('이 엔드포인트는 PATCH, POST, DELETE 메서드만 허용합니다', 405);
    }

    // ─── 매칭 실패 ───
    return errorResponse(`알 수 없는 경로: /api/tenders/${path}`, 404);
  } catch (err) {
    return errorResponse(err, 500);
  }
}

/** YYYYMMDDHHMM 형식 검증 */
function isValidG2BDatetime(s: string): boolean {
  if (!/^\d{12}$/.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const h = Number(s.slice(8, 10));
  const min = Number(s.slice(10, 12));
  if (y < 2000 || y > 2100) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  if (h < 0 || h > 23) return false;
  if (min < 0 || min > 59) return false;
  return true;
}
