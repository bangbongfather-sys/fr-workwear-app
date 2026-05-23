/**
 * 키워드 매칭 점수 산출.
 *
 * 작업지시서 `phase-1-data-collection.md` Step 2-3 기반.
 * Supabase client 대신 Firebase RTDB(`tenders/keywords` 노드)에서 키워드 로드.
 *
 * 알고리즘:
 * - 입력 텍스트(공고명 + 세부품명)를 lowercase로 정규화
 * - 활성 키워드 각각에 대해 `includes()` 매칭
 * - 매칭 시 `weight` 누적 (음수 키워드는 감산)
 * - 출력: 누적 점수 + 양수 가중치로 매칭된 키워드 목록만 (음수 제외 키워드는 표시 안 함)
 */

import { fbGet } from './firebase';
import type { KeywordCategory, MatchResult, TenderKeyword } from './types';

/** 매칭 계산에 필요한 최소 필드만 가진 경량 타입 */
export interface KeywordRow {
  keyword: string;
  category: KeywordCategory;
  weight: number;
}

/**
 * 텍스트에 대해 키워드 매칭 + 점수 산출 (순수 함수).
 *
 * @param text 공고명 + 세부품명 등 매칭 대상 텍스트
 * @param keywords 활성 키워드 배열
 * @returns score(누적 점수, 음수 가능) + matchedKeywords(양수 가중치 매칭만)
 *
 * @example
 *   calculateMatchScore("방염복 50착 구매 (아라미드)", [
 *     { keyword: "방염복", category: "core", weight: 10 },
 *     { keyword: "아라미드", category: "material", weight: 7 },
 *     { keyword: "방염커튼", category: "exclude", weight: -20 },
 *   ])
 *   → { score: 17, matchedKeywords: ["방염복", "아라미드"] }
 */
export function calculateMatchScore(text: string, keywords: KeywordRow[]): MatchResult {
  const lower = (text ?? '').toLowerCase();
  let score = 0;
  const matched: string[] = [];

  for (const kw of keywords) {
    if (!kw.keyword) continue;
    if (lower.includes(kw.keyword.toLowerCase())) {
      score += kw.weight;
      // 양수 가중치 키워드만 사용자에게 표시 (제외 키워드는 노출 안 함)
      if (kw.weight > 0) {
        matched.push(kw.keyword);
      }
    }
  }

  return { score, matchedKeywords: matched };
}

/**
 * Firebase RTDB의 `tenders/keywords` 노드에서 활성 키워드 로드.
 *
 * 노드 구조 (auto-id 키 아래에 TenderKeyword 객체):
 *   {
 *     "-OabcXYZ": { keyword: "방염복", category: "core", weight: 10, isActive: true, createdAt: "..." },
 *     "-OdefABC": { keyword: "난연복", ... }
 *   }
 *
 * @param firebaseSecret wrangler secret `FIREBASE_DB_SECRET`
 * @returns isActive: true 인 키워드만 반환 (매칭 계산에 필요한 최소 필드만)
 */
export async function loadActiveKeywords(firebaseSecret: string): Promise<KeywordRow[]> {
  const data = await fbGet<Record<string, TenderKeyword>>('/tenders/keywords', firebaseSecret);
  if (!data) {
    console.warn('[matcher] tenders/keywords 노드가 비어 있음 — 시드 데이터 미등록일 수 있음');
    return [];
  }
  return Object.values(data)
    .filter(k => k && k.isActive)
    .map(k => ({ keyword: k.keyword, category: k.category, weight: k.weight }));
}
