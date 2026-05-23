/**
 * NJ Safety 입찰 모니터링 — TypeScript 타입 정의
 *
 * 작업지시서 shared-reference.md 4-2 섹션 기반.
 * fr-workwear-app 기존 컨벤션에 맞춰 camelCase 유지 (Firebase RTDB는 NoSQL, snake_case 강제 없음).
 */

// ─── 도메인 상수 ───────────────────────────────────────────────

/** 입찰 공고 상태 — 사용자가 워크플로상 단계별로 분류 */
export type TenderStatus =
  | 'new'        // 신규 수집 (기본)
  | 'reviewed'   // 검토 완료
  | 'applied'    // 입찰 참여
  | 'won'        // 낙찰
  | 'lost'       // 유찰/패찰
  | 'skipped';   // 제외

/** 키워드 카테고리 — 매칭 가중치 부여 기준 */
export type KeywordCategory =
  | 'core'       // 제품명 직접 매칭 (가중치 8~10)
  | 'material'   // 소재 키워드 (가중치 5~7)
  | 'standard'   // 규격/인증 키워드 (가중치 7~8)
  | 'usage'      // 용도 키워드 (가중치 4~6)
  | 'exclude';   // 제외 키워드 (음수 가중치, 오탐 방지)

/** 수집 로그 상태 */
export type PollStatus = 'success' | 'partial' | 'failed';


// ─── 핵심 엔티티 ───────────────────────────────────────────────

/**
 * 조달청 API에서 수집된 입찰 공고 1건.
 * Firebase RTDB 경로: `tenders/notices/{bidNtceNo}_{bidNtceOrd}`
 */
export interface TenderNotice {
  // 식별자 (조달청 PK)
  bidNtceNo: string;            // 공고번호 (예: "20260523001")
  bidNtceOrd: string;           // 차수 (정정공고 시 증가, 기본 "00")

  // 공고 정보
  bidNtceNm: string;            // 공고명 (키워드 매칭 대상)
  ntceInsttNm: string | null;   // 공고기관 (조달청 등)
  dminsttNm: string | null;     // 수요기관 (한전, 소방서 등 실수요처)
  bsnsDivNm: string | null;     // 업무구분 (물품/용역/공사/외자)
  prdctClsfcNo: string | null;  // 세부품명번호 (분류코드)
  prdctClsfcNoNm: string | null; // 세부품명 (키워드 매칭 대상)

  // 금액
  presmptPrce: number | null;   // 추정가격 (원)

  // 일정 (ISO 8601 문자열 — Firebase RTDB는 Date 객체 직접 저장 불가)
  bidBeginDt: string | null;    // 입찰개시일시
  bidClseDt: string | null;     // 입찰마감일시 (알림 우선순위 산정 기준)
  opengmDt: string | null;      // 개찰일시

  // 메타
  bidNtceUrl: string | null;    // 공고상세 URL (조달청 페이지)
  ntceKindNm: string | null;    // 공고종류 (일반/정정/취소/긴급)

  // ─── 자동 계산 필드 (Worker가 설정) ───
  matchScore: number;           // 매칭 점수 (>= MATCH_THRESHOLD인 공고만 저장)
  matchedKeywords: string[];    // 매칭된 키워드 목록 (양수 가중치만)

  // ─── 사용자 상태 관리 (Phase 2+에서 UI로 변경) ───
  status: TenderStatus;         // 워크플로 상태
  notifiedAt: string | null;    // ISO 8601, 이메일 알림 전송 시각 (Phase 2)

  // ─── Phase 4C: 응찰 워크플로우 데이터 ───
  // status가 'applied'일 때 입력. status가 'skipped'면 skipReason만 사용.
  estimatedCost?: number | null;       // 우리 견적가 (원)
  estimatedMargin?: number | null;     // 예상 마진 (%)
  ourBidAmount?: number | null;        // 실제 투찰 금액 (원)
  applicationMemo?: string | null;     // 응찰 메모
  skipReason?: string | null;          // 응찰 안 함 사유
  reviewedAt?: string | null;          // ISO 8601, 응찰 결정 시각

  // ─── 메타 ───
  rawData: Record<string, unknown> | null;  // 디버깅용 조달청 원본 응답
  createdAt: string;            // ISO 8601, 최초 수집 시각
  updatedAt: string;            // ISO 8601, 마지막 갱신 시각
}

/**
 * Phase 4A — 마감 임박 알림 발송 이력 1건.
 * Firebase RTDB 경로: `tenders/deadlineReminders/{noticeKey}_{type}`
 * idempotent 키 사용: 동일 noticeKey + type 조합은 1회만 발송.
 */
export interface DeadlineReminderLog {
  noticeKey: string;            // notices의 키
  type: 'd-3' | 'd-1' | 'd-day';
  sentAt: string;               // ISO 8601
}

/**
 * Phase 4B — 공고 변경 이력 1건 (정정/취소).
 * Firebase RTDB 경로: `tenders/changeHistory/{auto-push-key}`
 */
export interface ChangeHistoryRecord {
  bidNtceNo: string;
  bidNtceOrdPrev: string;       // 변경 전 차수
  bidNtceOrdNew: string;        // 변경 후 차수
  changeType: string | null;    // 정정/취소/연기 등 (ntceKindNm)
  changeReason: string | null;  // rbidPermsnYn 등
  prevData: Record<string, unknown> | null;
  newData: Record<string, unknown> | null;
  detectedAt: string;           // ISO 8601
  notified: boolean;            // 이메일 알림 발송 여부
  notifiedAt?: string | null;
}

/**
 * 키워드 사전 1건.
 * Firebase RTDB 경로: `tenders/keywords/{auto-id}`
 */
export interface TenderKeyword {
  keyword: string;              // 매칭 대상 텍스트 (대소문자 무관)
  category: KeywordCategory;
  weight: number;               // 양수=매칭 시 점수 가산, 음수=감산 (오탐 방지)
  isActive: boolean;            // false면 매칭 로직에서 제외
  createdAt: string;            // ISO 8601
}

/**
 * 수집 로그 1건 (Phase 1 디버깅 + 운영 모니터링용).
 * Firebase RTDB 경로: `tenders/pollLogs/{auto-id}`
 */
export interface TenderPollLog {
  runAt: string;                // ISO 8601, 실행 시각
  inqryBgnDt: string | null;    // 조달청 API 호출 시 사용한 시작일시 (YYYYMMDDHHMM)
  inqryEndDt: string | null;    // 종료일시
  totalFetched: number;         // 조달청에서 받은 전체 공고 수
  totalMatched: number;         // 키워드 매칭 통과 공고 수
  totalInserted: number;        // 실제 DB upsert된 공고 수
  durationMs: number | null;    // 실행 소요 시간 (ms)
  status: PollStatus;
  errorMsg: string | null;      // 실패 시 에러 메시지
}

/**
 * 알림 발송 로그 1건 (Phase 2부터).
 * Firebase RTDB 경로: `tenders/notificationsLog/{auto-id}`
 *
 * 작업지시서 `notifications_log` PG 테이블 대체.
 */
export interface NotificationLog {
  channel: 'email' | 'kakao';   // Phase 2는 email만. Phase 4에서 kakao 추가.
  recipient: string;             // 콤마 구분된 이메일 주소 목록 (또는 카카오 알림톡 번호)
  subject: string | null;        // 이메일 제목
  noticeKeys: string[];          // 발송에 포함된 notice 노드 키 목록 ({bidNtceNo}_{ord})
  noticeCount: number;
  status: 'pending' | 'sent' | 'failed';
  providerMsgId: string | null;  // Resend 응답의 id (성공 시)
  errorMsg: string | null;       // 실패 시 에러 메시지
  sentAt: string | null;         // ISO 8601, 발송 성공 시점
  createdAt: string;             // ISO 8601, 로그 생성 시각
}

/**
 * 이메일 템플릿에 전달하는 경량 공고 객체.
 * TenderNotice의 디스플레이 필수 필드만 추출.
 */
export interface TenderForEmail {
  noticeKey: string;            // RTDB 노드 키 ({bidNtceNo}_{bidNtceOrd}) — 알림 로그 참조용
  bidNtceNo: string;
  bidNtceNm: string;
  ntceInsttNm: string | null;
  dminsttNm: string | null;
  presmptPrce: number | null;
  bidClseDt: string | null;
  bidNtceUrl: string | null;
  matchScore: number;
  matchedKeywords: string[];
}


// ─── 유틸 타입 ─────────────────────────────────────────────────

/** 키워드 매칭 결과 (matcher.ts 출력) */
export interface MatchResult {
  score: number;
  matchedKeywords: string[];    // 양수 가중치 키워드만 (음수 키워드는 매칭됐어도 표시 안 함)
}

/** 1회 폴링 실행 결과 (poll-tenders Edge Function 응답) */
export interface PollRunResult {
  fetched: number;
  matched: number;
  inserted: number;
  durationMs: number;
  matchedTenders: TenderNotice[];  // 응답 본문에 포함 (수동 테스트 시 검증용)
}


// ─── 키 생성 ────────────────────────────────────────────────────

/**
 * Firebase RTDB의 notices 노드 키 생성.
 * Firebase 키에 `.` `$` `#` `[` `]` `/` 사용 금지 → 안전 문자로 치환.
 *
 * 예: noticeKey("20260523-00012", "00") → "20260523-00012_00"
 */
export function noticeKey(bidNtceNo: string, bidNtceOrd: string): string {
  const safe = (s: string) => s.replace(/[.$#\[\]\/]/g, '_');
  return `${safe(bidNtceNo)}_${safe(bidNtceOrd)}`;
}


// ─── 시드 키워드 (DB 초기화 시 사용) ─────────────────────────────
// 작업지시서 shared-reference.md 2번 섹션 그대로

export const SEED_KEYWORDS: Omit<TenderKeyword, 'createdAt' | 'isActive'>[] = [
  // 핵심 키워드 (제품명 직접 매칭)
  { keyword: '방염복',       category: 'core',     weight: 10 },
  { keyword: '난연복',       category: 'core',     weight: 10 },
  { keyword: '방화복',       category: 'core',     weight: 10 },
  { keyword: '내열복',       category: 'core',     weight: 8 },
  { keyword: '아라미드복',   category: 'core',     weight: 9 },
  { keyword: '내염복',       category: 'core',     weight: 8 },
  { keyword: '방염작업복',   category: 'core',     weight: 10 },

  // 소재 키워드
  { keyword: '아라미드',     category: 'material', weight: 7 },
  { keyword: '메타아라미드', category: 'material', weight: 7 },
  { keyword: '파라아라미드', category: 'material', weight: 7 },
  { keyword: 'Nomex',        category: 'material', weight: 7 },
  { keyword: 'Arawin',       category: 'material', weight: 7 },
  { keyword: 'Kevlar',       category: 'material', weight: 5 },

  // 규격/인증 키워드
  { keyword: '아크플래시',   category: 'standard', weight: 8 },
  { keyword: 'NFPA 70E',     category: 'standard', weight: 7 },
  { keyword: 'IEC 61482',    category: 'standard', weight: 7 },
  { keyword: 'EN ISO 11612', category: 'standard', weight: 7 },
  { keyword: 'KS K 0590',    category: 'standard', weight: 7 },

  // 용도 키워드 (낮은 가중치)
  { keyword: '전기작업복',   category: 'usage',    weight: 4 },
  { keyword: '용접복',       category: 'usage',    weight: 4 },
  { keyword: '소방활동복',   category: 'usage',    weight: 5 },
  { keyword: '산불진화복',   category: 'usage',    weight: 6 },

  // 제외 키워드 (음수 가중치, 오탐 방지)
  { keyword: '방염커튼',     category: 'exclude',  weight: -20 },
  { keyword: '방염도료',     category: 'exclude',  weight: -20 },
  { keyword: '방염시트',     category: 'exclude',  weight: -20 },
  { keyword: '방염페인트',   category: 'exclude',  weight: -20 },
  { keyword: '방염필름',     category: 'exclude',  weight: -20 },
];

/** 매칭 임계값 — 환경변수 MATCH_THRESHOLD로 override 가능 */
export const DEFAULT_MATCH_THRESHOLD = 7;


// ─── Worker 환경변수 타입 ───────────────────────────────────────

/**
 * 입찰 모니터링 모듈이 필요로 하는 환경변수.
 * worker.js의 `env` 객체에서 이 필드들이 채워져 있어야 함.
 *
 * wrangler secret으로 설정:
 *   wrangler secret put G2B_SERVICE_KEY      ← 공공데이터포털 Decoding 키
 *   wrangler secret put FIREBASE_DB_SECRET   ← 기존 등록됨 (Notion/Firebase proxy와 공유)
 *
 * wrangler.jsonc의 `vars`로 설정 (비밀 아닌 plain 값):
 *   MATCH_THRESHOLD : 매칭 임계값 (기본 7)
 */
export interface TenderEnv {
  G2B_SERVICE_KEY: string;
  FIREBASE_DB_SECRET: string;
  MATCH_THRESHOLD?: string;  // wrangler.jsonc vars에서 문자열로 옴 → Number() 변환 필요

  // ─── Phase 2 (이메일 알림) — Resend ───
  // Phase 1만 운영 시 미설정해도 OK (라우터에서 검증 후 실행).
  RESEND_API_KEY?: string;
  NOTIFICATION_EMAIL_FROM?: string;   // 예: "NJ Safety 입찰알리미 <bid@njsafety.co.kr>"
  NOTIFICATION_EMAIL_TO?: string;     // 예: "bangbong@njsafety.co.kr,backup@..." (콤마 구분)
}
