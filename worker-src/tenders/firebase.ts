/**
 * Firebase Realtime Database — Worker 측 admin 접근 헬퍼.
 *
 * 기존 fr-workwear-app은 RTDB의 `frw.json` 노드만 사용. 본 모듈은 입찰 모니터링
 * 전용 노드 `tenders/`에 admin secret으로 직접 접근. (클라이언트는 별도 라우트 통해
 * 접근 — Worker는 `auth != null` 규칙을 시크릿으로 우회)
 *
 * 보안: `FIREBASE_DB_SECRET`는 wrangler secret으로만 저장되며 클라이언트/Git 노출 0.
 */

/** RTDB 호스트 (Asia Southeast 1, 기존 fr-workwear-app과 동일 DB) */
const FB_HOST = 'njsafety-2ee24-default-rtdb.asia-southeast1.firebasedatabase.app';

/** Firebase URL 빌드 — `auth=` 쿼리에 admin secret 부착 */
function buildUrl(path: string, secret: string): string {
  if (!path.startsWith('/')) {
    throw new Error(`firebase path는 "/"로 시작해야 함: ${path}`);
  }
  // `.json` 자동 부착 (Firebase REST 규칙)
  const withSuffix = path.endsWith('.json') ? path : `${path}.json`;
  return `https://${FB_HOST}${withSuffix}?auth=${encodeURIComponent(secret)}`;
}

/**
 * RTDB 노드 GET. 응답이 null이면 노드 없음.
 */
export async function fbGet<T>(path: string, secret: string): Promise<T | null> {
  const res = await fetch(buildUrl(path, secret), {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Firebase GET ${path} 실패: HTTP ${res.status} ${body}`);
  }
  return (await res.json()) as T | null;
}

/**
 * RTDB 노드 PATCH — shallow merge.
 *
 * `cloudSave`와 동일한 안전한 부분 갱신 (PUT 사용 금지 — top-level key 삭제 위험).
 * 예: `fbPatch('/tenders/notices', { 'key1': {...}, 'key2': {...} }, secret)`
 *     → notices 노드 아래에 key1, key2 추가/갱신. 나머지 형제 키는 보존.
 */
export async function fbPatch(path: string, data: unknown, secret: string): Promise<void> {
  const res = await fetch(buildUrl(path, secret), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Firebase PATCH ${path} 실패: HTTP ${res.status} ${body}`);
  }
}

/**
 * RTDB POST — auto-id 생성하여 push.
 *
 * 사용 사례: `tenders/keywords/{auto-id}`, `tenders/pollLogs/{auto-id}` 처럼
 * 순서 무관한 컬렉션에 새 항목 추가.
 *
 * @returns 생성된 auto-id (`name` 필드)
 */
export async function fbPush(path: string, data: unknown, secret: string): Promise<string> {
  const res = await fetch(buildUrl(path, secret), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Firebase POST ${path} 실패: HTTP ${res.status} ${body}`);
  }
  const result = (await res.json()) as { name?: string };
  if (!result.name) {
    throw new Error(`Firebase POST ${path}: 응답에 name 필드 없음`);
  }
  return result.name;
}

/**
 * RTDB 노드 PUT — 전체 교체.
 *
 * ⚠️ 매우 위험: 노드 전체를 통째로 덮어씀. 형제 키 모두 삭제됨.
 * 시드 데이터 초기화 같은 한정된 용도로만 사용. 일반적으로는 `fbPatch` 또는 `fbPush` 사용.
 */
export async function fbPut(path: string, data: unknown, secret: string): Promise<void> {
  const res = await fetch(buildUrl(path, secret), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Firebase PUT ${path} 실패: HTTP ${res.status} ${body}`);
  }
}
