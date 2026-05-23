/**
 * 조달청 나라장터 OpenAPI 클라이언트.
 *
 * 작업지시서 `shared-reference.md` 1번 섹션 + `phase-1-data-collection.md` Step 2-2 기반.
 * Cloudflare Worker 환경에 맞춰 환경변수 모듈 레벨 검증 제거 (env는 함수 인자로 전달).
 *
 * 일일 호출한도:
 * - 개발계정: 1,000회/일
 * - 운영계정: 10,000회/일 (1주일 운영 후 신청 가능)
 */

const BASE_URL = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService';

/** 페이지당 조회 건수 (1~999, 권장 500) */
const NUM_OF_ROWS = 500;

/** 페이징 안전장치 — 최대 페이지 수 (전체 20*500 = 10,000건) */
const MAX_PAGES = 20;

/** 페이지 간 대기 시간 (조달청 rate limit 보호) */
const INTER_PAGE_DELAY_MS = 200;

/** 단일 요청 타임아웃 */
const REQUEST_TIMEOUT_MS = 15_000;

/** 재시도 횟수 (exponential backoff: 1s, 2s, 4s) */
const RETRY_COUNT = 3;

// ─── 응답 타입 ─────────────────────────────────────────────────

/** 조달청 입찰공고 응답 1건 (raw, camelCase 그대로) */
export interface G2BTenderItem {
  bidNtceNo: string;
  bidNtceOrd?: string;
  bidNtceNm: string;
  ntceInsttNm?: string;
  dminsttNm?: string;
  bsnsDivNm?: string;
  prdctClsfcNo?: string;
  prdctClsfcNoNm?: string;
  presmptPrce?: string;
  bidBeginDt?: string;
  bidClseDt?: string;
  opengDt?: string;
  bidNtceUrl?: string;
  ntceKindNm?: string;
  [key: string]: unknown;
}

/** 조달청 공통 응답 구조 */
export interface G2BResponse<T> {
  response: {
    header: { resultCode: string; resultMsg: string };
    body: {
      items: T[] | '' | undefined;  // 데이터 없을 때 빈 문자열 또는 undefined
      totalCount: number;
      pageNo: number;
      numOfRows: number;
    };
  };
}

// ─── 재시도 헬퍼 ───────────────────────────────────────────────

/**
 * 재시도 로직이 포함된 fetch — 일시 503/타임아웃 자동 복구.
 * exponential backoff (1s → 2s → 4s).
 *
 * 실패 케이스:
 * - HTTP non-2xx
 * - `resultCode !== "00"` (조달청 비즈니스 에러: 트래픽 초과, 인증키 오류 등)
 * - 네트워크 타임아웃
 */
async function fetchWithRetry<T>(url: string, retries: number = RETRY_COUNT): Promise<G2BResponse<T>> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const data = (await res.json()) as G2BResponse<T>;
      const code = data.response?.header?.resultCode;
      if (code !== '00') {
        const msg = data.response?.header?.resultMsg ?? 'unknown';
        throw new Error(`G2B 에러 [${code}]: ${msg}`);
      }
      return data;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[g2b-client] 시도 ${attempt}/${retries} 실패: ${lastError.message}`);
      if (attempt < retries) {
        // 1s, 2s, 4s 대기
        await sleep(1000 * Math.pow(2, attempt - 1));
      }
    }
  }
  throw lastError ?? new Error('G2B 요청 실패 (원인 불명)');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── 공개 API ──────────────────────────────────────────────────

/**
 * 입찰공고(물품) 페이징 전체 수집.
 *
 * 방염복은 거의 **물품(Thng)** 으로 발주됨. 용역/공사는 Phase 4에서 추가 검토.
 *
 * @param inqryBgnDt 조회 시작 시각 (`YYYYMMDDHHMM`, KST)
 * @param inqryEndDt 조회 종료 시각 (`YYYYMMDDHHMM`, KST)
 * @param serviceKey 공공데이터포털 Decoding 인증키 (wrangler secret `G2B_SERVICE_KEY`)
 * @returns 수집된 공고 배열 (페이징 자동 처리, 최대 10,000건)
 */
export async function fetchAllThngTenders(
  inqryBgnDt: string,
  inqryEndDt: string,
  serviceKey: string,
): Promise<G2BTenderItem[]> {
  if (!serviceKey) {
    throw new Error('G2B_SERVICE_KEY가 비어 있음 (wrangler secret 등록 확인 필요)');
  }

  const results: G2BTenderItem[] = [];
  let pageNo = 1;

  while (true) {
    const url = `${BASE_URL}/getBidPblancListInfoThngPPSSrch` +
      `?serviceKey=${encodeURIComponent(serviceKey)}` +
      `&pageNo=${pageNo}&numOfRows=${NUM_OF_ROWS}` +
      `&inqryDiv=1` +  // 1=공고게시일 기준
      `&inqryBgnDt=${inqryBgnDt}&inqryEndDt=${inqryEndDt}` +
      `&type=json`;

    const data = await fetchWithRetry<G2BTenderItem>(url);
    const items = data.response.body.items;

    // 데이터 없음 — 정상 종료 (빈 문자열, undefined, 빈 배열 모두 처리)
    if (!items || (Array.isArray(items) && items.length === 0)) {
      console.log(`[g2b-client] 페이지 ${pageNo}: 데이터 없음 (종료)`);
      break;
    }

    const itemList = items as G2BTenderItem[];
    results.push(...itemList);
    console.log(`[g2b-client] 페이지 ${pageNo}: ${itemList.length}건 수집 (누계 ${results.length})`);

    // 마지막 페이지 (받은 개수 < 요청 개수)
    if (itemList.length < NUM_OF_ROWS) break;

    pageNo++;

    // 안전장치
    if (pageNo > MAX_PAGES) {
      console.warn(`[g2b-client] 최대 페이지 도달 (${MAX_PAGES}) — 추가 페이지 무시`);
      break;
    }

    // rate limit 보호
    await sleep(INTER_PAGE_DELAY_MS);
  }

  return results;
}

/**
 * 특정 bidNtceNo 1건만 조회 (Phase 4B 변경이력 추적용).
 *
 * 정정공고가 발생하면 같은 bidNtceNo에 새 차수(bidNtceOrd)가 생기므로,
 * 우리 DB의 차수와 비교해서 변경 여부 감지.
 *
 * 응답 배열에서 첫 번째 (가장 최신 차수) 아이템을 반환.
 *
 * @param bidNtceNo 조회 대상 공고번호 (예: "20260523001")
 * @param serviceKey 공공데이터포털 Decoding 인증키
 * @returns 가장 최신 차수의 공고. 데이터 없으면 null.
 */
export async function fetchTenderByBidNtceNo(
  bidNtceNo: string,
  serviceKey: string,
): Promise<G2BTenderItem | null> {
  if (!serviceKey) {
    throw new Error('G2B_SERVICE_KEY가 비어 있음');
  }
  const url = `${BASE_URL}/getBidPblancListInfoThngPPSSrch` +
    `?serviceKey=${encodeURIComponent(serviceKey)}` +
    `&pageNo=1&numOfRows=10` +
    `&bidNtceNo=${encodeURIComponent(bidNtceNo)}` +
    `&type=json`;
  const data = await fetchWithRetry<G2BTenderItem>(url);
  const items = data.response.body.items;
  if (!items || (Array.isArray(items) && items.length === 0)) {
    return null;
  }
  const list = items as G2BTenderItem[];
  // 차수 내림차순 정렬 후 첫 번째 (최신)
  list.sort((a, b) => (b.bidNtceOrd ?? '0').localeCompare(a.bidNtceOrd ?? '0'));
  return list[0] ?? null;
}
