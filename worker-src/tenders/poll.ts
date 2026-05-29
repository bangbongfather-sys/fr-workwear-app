/**
 * 입찰 모니터링 — 메인 폴링 로직.
 *
 * 작업지시서 `phase-1-data-collection.md` Step 3-2 (`poll-tenders/index.ts`) 대응.
 * Supabase upsert → Firebase RTDB PATCH로 치환.
 *
 * 두 가지 진입점:
 * - {@link runPoll}: 지정 기간을 수동 폴링 (수동 테스트 + cron 모두 사용)
 * - {@link seedKeywords}: 키워드 시드 데이터 일괄 등록 (1회용)
 *
 * 자동 실행: worker.js의 `scheduled()` 핸들러가 `runDailyPoll`(어제 0~24시 KST) 호출.
 */

import { fbGet, fbPatch, fbPush } from './firebase';
import { fetchAllThngTenders } from './g2b-client';
import { calculateMatchScore, loadActiveKeywords } from './matcher';
import { getYesterdayRangeKST, parseG2BDate } from './date-utils';
import {
  DEFAULT_MATCH_THRESHOLD,
  noticeKey,
  SEED_KEYWORDS,
  type PollRunResult,
  type TenderEnv,
  type TenderKeyword,
  type TenderNotice,
  type TenderPollLog,
} from './types';

// ─── 메인 폴링 ──────────────────────────────────────────────────

/**
 * 지정 기간의 조달청 입찰공고를 수집하여 키워드 매칭 후 Firebase에 적재.
 *
 * 흐름:
 *  1. 활성 키워드 로드 (`tenders/keywords`)
 *  2. 조달청 API 호출 (페이징 자동, 재시도 3회)
 *  3. 각 공고에 매칭 점수 계산 → 임계값 이상만 통과
 *  4. 기존 노드 조회하여 `status`, `createdAt`, `notifiedAt` 보존 (사용자 수정 보호)
 *  5. `tenders/notices`에 일괄 PATCH (복합 키 = `{bidNtceNo}_{bidNtceOrd}`)
 *  6. `tenders/pollLogs`에 실행 로그 push
 *
 * @param bgn 조회 시작 (`YYYYMMDDHHMM` KST)
 * @param end 조회 종료 (`YYYYMMDDHHMM` KST)
 * @param env Worker 환경변수
 * @returns 수집/매칭/적재 통계 + 매칭된 공고 배열
 */
export async function runPoll(
  bgn: string,
  end: string,
  env: TenderEnv,
): Promise<PollRunResult> {
  validateEnv(env);
  const startTime = Date.now();
  const nowISO = new Date().toISOString();
  const threshold = parseThreshold(env.MATCH_THRESHOLD);

  console.log(`[poll] 시작: ${bgn} ~ ${end}, threshold=${threshold}`);

  // 1. 활성 키워드 로드
  const keywords = await loadActiveKeywords(env.FIREBASE_DB_SECRET);
  if (keywords.length === 0) {
    throw new Error(
      '활성 키워드가 0개임. 먼저 POST /api/tenders/seed-keywords 호출하여 시드 데이터를 등록하세요.',
    );
  }
  console.log(`[poll] 활성 키워드 ${keywords.length}개 로드`);

  // 2. 조달청 API 호출
  const items = await fetchAllThngTenders(bgn, end, env.G2B_SERVICE_KEY);
  console.log(`[poll] 수집 완료: ${items.length}건`);

  // 3-4. 매칭 + 기존 노드 조회 (사용자 수정 필드 보존)
  const existing = (await fbGet<Record<string, TenderNotice>>(
    '/tenders/notices',
    env.FIREBASE_DB_SECRET,
  )) ?? {};

  const matchedNotices: TenderNotice[] = [];
  const noticesPayload: Record<string, TenderNotice> = {};

  for (const item of items) {
    const text = `${item.bidNtceNm ?? ''} ${item.prdctClsfcNoNm ?? ''}`;
    const { score, matchedKeywords } = calculateMatchScore(text, keywords);
    if (score < threshold) continue;

    const ord = item.bidNtceOrd ?? '00';
    const key = noticeKey(item.bidNtceNo, ord);
    const prev = existing[key];

    const notice: TenderNotice = {
      bidNtceNo: item.bidNtceNo,
      bidNtceOrd: ord,
      bidNtceNm: item.bidNtceNm,
      ntceInsttNm: item.ntceInsttNm ?? null,
      dminsttNm: item.dminsttNm ?? null,
      bsnsDivNm: '물품',
      prdctClsfcNo: item.prdctClsfcNo ?? null,
      prdctClsfcNoNm: item.prdctClsfcNoNm ?? null,
      presmptPrce: item.presmptPrce ? Number(item.presmptPrce) : null,
      bidBeginDt: parseG2BDate(item.bidBeginDt),
      bidClseDt: parseG2BDate(item.bidClseDt),
      opengmDt: parseG2BDate(item.opengDt),
      bidNtceUrl: item.bidNtceUrl ?? null,
      ntceKindNm: item.ntceKindNm ?? null,
      matchScore: score,
      matchedKeywords,
      // 사용자 수정 가능 필드 — 기존 값 보존 (없으면 기본값)
      status: prev?.status ?? 'new',
      notifiedAt: prev?.notifiedAt ?? null,
      // 원본 응답 (디버깅용)
      rawData: item as Record<string, unknown>,
      // 타임스탬프 — 신규는 nowISO, 기존은 createdAt 보존
      createdAt: prev?.createdAt ?? nowISO,
      updatedAt: nowISO,
    };

    matchedNotices.push(notice);
    noticesPayload[key] = notice;
  }

  console.log(`[poll] 매칭 완료: ${matchedNotices.length}건 (임계값 ${threshold})`);

  // 5. 일괄 PATCH (shallow merge — 다른 공고는 보존)
  const inserted = Object.keys(noticesPayload).length;
  if (inserted > 0) {
    await fbPatch('/tenders/notices', noticesPayload, env.FIREBASE_DB_SECRET);
    console.log(`[poll] DB 적재 완료: ${inserted}건`);
  }

  const durationMs = Date.now() - startTime;

  // 6. 로그 push
  const log: TenderPollLog = {
    runAt: nowISO,
    inqryBgnDt: bgn,
    inqryEndDt: end,
    totalFetched: items.length,
    totalMatched: matchedNotices.length,
    totalInserted: inserted,
    durationMs,
    status: 'success',
    errorMsg: null,
  };
  await fbPush('/tenders/pollLogs', log, env.FIREBASE_DB_SECRET);

  return {
    fetched: items.length,
    matched: matchedNotices.length,
    inserted,
    durationMs,
    matchedTenders: matchedNotices,
  };
}

/**
 * cron 자동 실행용 — 어제 0~24시(KST) 범위로 폴링.
 *
 * 실패 시에도 로그 push 시도 후 에러 throw (Worker scheduled가 재시도 결정).
 */
export async function runDailyPoll(env: TenderEnv): Promise<PollRunResult> {
  const { bgn, end } = getYesterdayRangeKST();
  try {
    return await runPoll(bgn, end, env);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('[poll] 일일 폴링 실패:', errorMsg);
    // 실패 로그 시도 (성공 못 해도 throw)
    try {
      const failedLog: TenderPollLog = {
        runAt: new Date().toISOString(),
        inqryBgnDt: bgn,
        inqryEndDt: end,
        totalFetched: 0,
        totalMatched: 0,
        totalInserted: 0,
        durationMs: null,
        status: 'failed',
        errorMsg,
      };
      await fbPush('/tenders/pollLogs', failedLog, env.FIREBASE_DB_SECRET);
    } catch (logErr) {
      console.error('[poll] 실패 로그 기록 자체도 실패:', logErr);
    }
    throw err;
  }
}

// ─── 진단 (매칭 0건 원인 분석용, read-only) ─────────────────────

/**
 * 매칭 0건 원인 진단. Firebase에 아무것도 쓰지 않음 (조달청에서 읽기만).
 *
 * 목적: "데이터엔 방염복류가 있는데 키워드가 못 잡나" vs "물품 API에 아예 없나" 판별.
 *
 * 흐름:
 *  1. 지정 기간 조달청 물품공고 수집
 *  2. 넓은 진단 키워드(제품/소재/용도/유사어)로 공고명+세부품명 부분매칭
 *  3. 현재 활성 키워드 알고리즘 점수도 함께 계산
 *  4. 진단 키워드별 히트 수 + 매칭된 공고 샘플 반환
 *
 * @returns 진단 리포트 (fetched 총수, 진단키워드별 히트, 샘플 공고, 현재 알고리즘 매칭 수)
 */
export async function runDiagnostic(
  bgn: string,
  end: string,
  env: TenderEnv,
): Promise<{
  fetched: number;
  currentAlgoMatched: number;
  threshold: number;
  diagHits: Record<string, number>;
  samples: Array<{ bidNtceNm: string; prdctClsfcNoNm: string | null; hitWords: string[]; currentScore: number }>;
  durationMs: number;
}> {
  validateEnv(env);
  const startTime = Date.now();
  const threshold = parseThreshold(env.MATCH_THRESHOLD);

  // 넓은 진단 키워드 — 제품 직접 + 소재 + 용도 + 표기 변형 가능성
  const DIAG_WORDS = [
    // 제품 직접
    '방염', '방화', '난연', '내열', '내염', '아라미드', 'nomex', '노멕스', 'kevlar', '케블라',
    // 용도/유사 (조달청 표기 변형 가능성)
    '소방', '화학보호', '보호복', '방호복', '작업복', '피복', '근무복', '제복', '기동복',
    '특수복', '안전복', '방한복', '의류', '유니폼', '워크웨어',
  ];

  const keywords = await loadActiveKeywords(env.FIREBASE_DB_SECRET);
  const items = await fetchAllThngTenders(bgn, end, env.G2B_SERVICE_KEY);

  const diagHits: Record<string, number> = {};
  for (const w of DIAG_WORDS) diagHits[w] = 0;

  const samples: Array<{ bidNtceNm: string; prdctClsfcNoNm: string | null; hitWords: string[]; currentScore: number }> = [];
  let currentAlgoMatched = 0;

  for (const item of items) {
    const text = `${item.bidNtceNm ?? ''} ${item.prdctClsfcNoNm ?? ''}`;
    const lower = text.toLowerCase();

    // 진단 키워드 부분매칭
    const hitWords: string[] = [];
    for (const w of DIAG_WORDS) {
      if (lower.includes(w.toLowerCase())) {
        diagHits[w] = (diagHits[w] ?? 0) + 1;
        hitWords.push(w);
      }
    }

    // 현재 알고리즘 점수
    const { score } = calculateMatchScore(text, keywords);
    if (score >= threshold) currentAlgoMatched++;

    // 진단 키워드에 하나라도 걸리면 샘플로 (최대 60건)
    if (hitWords.length > 0 && samples.length < 60) {
      samples.push({
        bidNtceNm: item.bidNtceNm ?? '(제목없음)',
        prdctClsfcNoNm: item.prdctClsfcNoNm ?? null,
        hitWords,
        currentScore: score,
      });
    }
  }

  // 히트 0인 키워드는 리포트에서 제거 (가독성)
  const filteredHits: Record<string, number> = {};
  for (const [w, c] of Object.entries(diagHits)) {
    if (c > 0) filteredHits[w] = c;
  }

  return {
    fetched: items.length,
    currentAlgoMatched,
    threshold,
    diagHits: filteredHits,
    samples,
    durationMs: Date.now() - startTime,
  };
}

// ─── 키워드 시드 ────────────────────────────────────────────────

/**
 * `SEED_KEYWORDS` 상수를 기반으로 키워드를 일괄 등록.
 *
 * 키 전략: deterministic key `seed_{keyword}` 사용 → 재실행 시 중복 무시(자동 update).
 * 사용자가 추가한 키워드(`tenders/keywords/{auto-id}` 또는 다른 prefix)는 영향 없음.
 *
 * @returns inserted/updated 카운트
 */
export async function seedKeywords(env: TenderEnv): Promise<{
  inserted: number;
  updated: number;
  total: number;
}> {
  validateEnv(env);
  const existing = (await fbGet<Record<string, TenderKeyword>>(
    '/tenders/keywords',
    env.FIREBASE_DB_SECRET,
  )) ?? {};

  const nowISO = new Date().toISOString();
  const payload: Record<string, TenderKeyword> = {};
  let inserted = 0;
  let updated = 0;

  for (const seed of SEED_KEYWORDS) {
    const key = seedKeywordKey(seed.keyword);
    const prev = existing[key];
    payload[key] = {
      ...seed,
      isActive: prev?.isActive ?? true,         // 사용자가 비활성화한 키워드 보존
      createdAt: prev?.createdAt ?? nowISO,     // 최초 생성 시각 보존
    };
    if (prev) updated++;
    else inserted++;
  }

  await fbPatch('/tenders/keywords', payload, env.FIREBASE_DB_SECRET);

  return { inserted, updated, total: SEED_KEYWORDS.length };
}

/**
 * 시드 키워드의 deterministic 키 — Firebase 안전 문자만 사용.
 * 한글/영문은 Firebase RTDB 키로 유효.
 */
function seedKeywordKey(keyword: string): string {
  const safe = keyword.replace(/[.$#\[\]\/\s]/g, '_');
  return `seed_${safe}`;
}

// ─── 유틸 ──────────────────────────────────────────────────────

function validateEnv(env: TenderEnv): void {
  if (!env.G2B_SERVICE_KEY) {
    throw new Error('G2B_SERVICE_KEY 미설정 — wrangler secret put G2B_SERVICE_KEY 필요');
  }
  if (!env.FIREBASE_DB_SECRET) {
    throw new Error('FIREBASE_DB_SECRET 미설정 — wrangler secret 확인 필요');
  }
}

function parseThreshold(raw: string | undefined): number {
  if (raw == null || raw === '') return DEFAULT_MATCH_THRESHOLD;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[poll] MATCH_THRESHOLD 파싱 실패 ("${raw}") — 기본값 ${DEFAULT_MATCH_THRESHOLD} 사용`);
    return DEFAULT_MATCH_THRESHOLD;
  }
  return n;
}
