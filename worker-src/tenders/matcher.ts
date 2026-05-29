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
 * 조합 매칭 규칙 — "기관 그룹 AND 의류 그룹"이 동시에 출현해야 점수 부여.
 *
 * 단일 키워드로는 오탐이 폭증하는 케이스를 해결:
 * - "소방" 단독 → 소화기·펌프차·시설공사 (오탐). 그래서 단일 키워드에 안 넣음.
 * - "유니폼" 단독 → 축구부 유니폼 (오탐).
 * - 하지만 "소방"+"피복" 동시 출현 → 소방공무원 피복 (진짜 연관) ✓
 *
 * groupA(대상/기관) 중 하나 AND groupB(의류) 중 하나가 모두 매칭되면 bonus 가산.
 */
interface ComboRule {
  name: string;
  groupA: string[];
  groupB: string[];
  bonus: number;
}

const COMBO_RULES: ComboRule[] = [
  {
    name: '공공기관 피복',
    // 기관/대상 — 단독으론 안 쓰임(조합 전용). "군"은 지명 오탐(군산/군청) 때문에 제외, 구체적 군 명칭만.
    groupA: [
      '소방', '경찰', '의무경찰', '의경', '교정', '해양경찰', '해경',
      '국군', '육군', '해군', '공군', '군부대', '공무원', '자치경찰', '소방본부', '소방서',
    ],
    // 의류/피복
    groupB: [
      '피복', '제복', '정복', '근무복', '기동복', '활동복', '방화복', '방한복',
      '점퍼', '유니폼', '작업복', '의류', '워크웨어', '근무화', '하계복', '동계복',
    ],
    bonus: 6,
  },
];

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

  // 1. 단일 키워드 매칭
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

  // 2. 조합 규칙 매칭 (기관 AND 의류 동시 출현 시 부스트)
  for (const rule of COMBO_RULES) {
    const a = rule.groupA.find((w) => lower.includes(w.toLowerCase()));
    const b = rule.groupB.find((w) => lower.includes(w.toLowerCase()));
    if (a && b) {
      score += rule.bonus;
      matched.push(`${a}+${b}`);
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
