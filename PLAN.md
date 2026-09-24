# 은행 입금내역 자동 수집 (팝빌 계좌조회) — 조사 결과와 구현 계획

> 상태: **계획 단계 (코드 변경 없음)**. 아래 「확인 질문」에 답을 받은 뒤 구현에 들어간다.
> 작성 기준일: 2026-09-24. 라인 번호는 이 시점 `index.html` / `worker.js` 기준.

표기: **[확인]** 코드나 SDK 소스를 직접 읽어 확인한 사실 · **[문서]** 팝빌 문서 검색 요약에서 가져온 내용 (원문 페이지는 이 환경에서 접속이 막혀 직접 열람하지 못함) · **[추정]** 검증 전 추론 — 테스트 환경에서 반드시 확인.

---

## 0. 한 줄 요약

Cloudflare Worker가 매일 정해진 시간에 팝빌 REST API(SDK 대신 `fetch` + WebCrypto로 직접 호출)로 KB 계좌 3개의 **입금**만 수집해서, 앱 데이터와 분리된 **수집함(`/frw_bank_inbox`)** 에 쌓는다. 앱이 열릴 때 수집함을 기존 `bankDeposits`에 **멱등(idempotent) 병합**하고, 기존 거래처 추천 로직을 강화해 자동 매칭한다. 엑셀 업로드는 그대로 두되 자동수집분과 겹치면 건너뛴다.

---

## 1. 조사 결과

### 1-1. bankDeposits 저장 구조 [확인]

| 항목 | 내용 |
|---|---|
| 상태 선언 | `index.html:19344` `useState(() => load("frw_bank_deposits", { items: [], nameMap: {} }))` |
| 로컬 저장 | localStorage `frw_bank_deposits` (200KB 넘으면 IndexedDB `frw_db`로 자동 전환, `1685-1723`) |
| 클라우드 | **Firebase Realtime DB** `/frw/bankDeposits` (Worker `/api/sync` 프록시 경유, `worker.js:368-428`). KV/D1/R2는 쓰지 않음 |
| 동기화 방식 | 섹션별 rev(`/frw/_revs/bankDeposits`) + 지문(`/frw/_sigs/bankDeposits`). 바뀐 섹션만 PATCH(600ms 디바운스). 8초마다 `_revs` 폴링 → 서버 rev가 앞서면 전체 다시 받기. 내 rev ≠ 서버 rev면 **충돌** 처리 |
| 형태 | `{ items: Deposit[], nameMap: { [payablesNameNorm(입금자명)]: 거래처명 } }` |

**Deposit 항목 (실제 코드에서 쓰는 필드 전부)**

```js
{
  id: Number,            // 가져올 때 Date.now() 기준 증가값 (파일 순서 유지용, 정렬에 사용)
  date: "YYYY-MM-DD",    // 시간 없음
  amount: Number,
  name: String,          // 입금자 텍스트 (없으면 "(입금자명 없음)")
  memo: String,
  biz: "nj" | "corp",    // 없으면 nj 취급 (depBizOf)
  status: "pending" | "done",
  client: String,        // 거래처 "이름" (id 아님 — 앱 전체가 이름으로 연결)
  link: null | {kind:"none"} | {kind:"ledger", ym, clientId: String(장부행 id)} | {kind:"ar", entryId},
  doneAt: Number,        // 처리 시각
}
```

`bank`·`account`·`time`·`balance`·`source`·외부 거래 ID 필드는 **없다**.

> ⚠️ **기존 문제 발견:** 대량 삭제를 막는 안전장치(`isBigShrink`, 「서버보다 많이 적습니다」 경고)는 `sectionSignature`로 개수를 비교한다. 그런데 `bankDeposits`는 `{items, nameMap}` 구조라 지문이 항상 `{n:2, m:0}`이다 (`index.html:1937-1947`). 그래서 **입금내역은 전부 날아가도 경고가 뜨지 않는다.** 자동 수집으로 데이터가 늘기 전에 먼저 고친다 (§3-4).

### 1-2. 현재 입력 방식 — 엑셀 업로드만 있음 [확인]

- 「거래내역 엑셀 가져오기」 버튼이나 드래그 앤 드롭 → `handleFile` (`index.html:9439-9501`). 붙여넣기나 수기 입력은 없다.
- 첫 시트만 읽고, 30행 안에서 헤더를 찾는다. 칸별 역할을 정하는 정규식은 이렇다:
  `date /거래일|이체일|입금일|날짜|일시|일자/`, `inAmt /입금|맡기신|받은\s*금액|credit/`, `name /입금자|보낸\s*분|의뢰인|거래자명|적요|내용|기재사항/`, `memo /적요|내용|비고|메모|거래점|취급점|송금메모/`.
  **왼쪽 칸부터** 처음 맞는 역할을 가져가고, 역할 하나에는 칸 하나만 배정된다.
- **KB 엑셀 주의 [확인+추정]:** KB 거래내역 열 순서가 `거래일시 | 적요 | 보낸분/받는분 | 송금메모 | 출금액 | 입금액 | 잔액 | 거래점`이라면, **「적요」가 입금자명(name)으로 잡히고 「보낸분/받는분」은 버려진다** (적요가 더 왼쪽이고 name 정규식에 걸리기 때문). 실제 저장된 KB 입금 건의 name이 "타행이체"·"전자금융" 같은 값인지 확인 필요 → 질문 Q7.
- 시간은 버리고 입금액 > 0인 행만 가져온다.
- 새 항목에는 **지금 보고 있는 사업자 탭**의 biz가 붙는다.
- **중복 방지 (현행, 그대로 유지):**
  ```js
  // 같은 (날짜·금액·입금자) 조합은 기존 개수를 초과하는 만큼만 추가 (개수 기반)
  const keyOf = (x) => `${x.date}|${Math.round(x.amount)}|${payablesNameNorm(x.name)}`;
  ```
  비교 대상은 **현재 탭(biz)의 항목만**이다. 같은 파일을 다른 사업자 탭에 올리면 전부 중복으로 들어간다.

### 1-3. 거래처와 입금 → 장부/미수금 연결 [확인]

- `clients` (`frw_clients`): `{ id, name, grade, note, createdAt }`에 `contact/phone/bizNo/email`이 선택으로 붙는다. **입금자명 별칭 필드는 없다.**
- 추천 후보 이름은 `clients[].name` + 모든 달 `ledgers[ym].clients[].name` + `Object.keys(clientAR)`의 합집합이다.
- 현재 추천 로직 (`index.html:9367`):
  ```js
  const suggestClient = (depName) => {
    const saved = nameMap[payablesNameNorm(depName)];      // ① 한 번 처리하며 배운 입금자명→거래처
    if (saved) return saved;
    return clientNames.find(n => payablesNameMatch(n, depName)) || "";  // ② 정규화 후 같거나, 3자 이상이면 포함
  };
  ```
  `payablesNameNorm`은 (주)/㈜/주식회사와 공백·괄호·구두점을 지우고 소문자로 만든다. 검색용 `searchBare`는 유한회사·합자회사·`합.` 표기까지 지운다.
- 처리할 때 (`completeDeposit`, `9519-9545`):
  - **장부 연결**: 장부 행 `status: "입금완료"` → `link {kind:"ledger", ym, clientId}`
  - **미수금 연결**: `clientAR[이름].entries`에 `{type:"입금", desc:"은행입금 (입금자)", amount, date}` 추가 → `link {kind:"ar", entryId}`
  - **연결 안 함**: `link {kind:"none"}`
  - 처리하면 `status:"done"`, `client`, `doneAt`이 기록되고 `nameMap`에 입금자명→거래처를 학습한다.
- 자동 연결 대상(`targetFor`): 미입금 장부 중 **금액이 정확히 같은 건**이 있으면 장부, 없으면 미수금.
- 일괄 처리(`completeBulk`/`completeRows`), 미수금 입금 합이 장부 월 청구와 맞으면 장부로 정산(`settleMonthFromAR`), 되돌리기(`undoDeposit`)가 이미 있다. **이 흐름들은 건드리지 않고, 자동수집 항목도 똑같은 모양으로 들어가게 한다.**

### 1-4. 팝빌 계좌조회 API

**흐름** [확인: SDK 소스 + 공식 예제]

1. **계좌 등록 (1회)**: 팝빌 사이트(계좌조회 › 관리 › 계좌관리) 또는 `RegistBankAccount`.
   - 사전 조건: 은행 **빠른조회(스피드조회) 신청이 끝난 계좌**만 등록된다 [문서].
   - KB는 `BankCode "0004"`, 계좌비밀번호, **인터넷뱅킹 ID(BankID, 국민은행 필수)**, `AccountType` "법인"/"개인", `IdentityNumber` (법인은 사업자번호 10자리, 개인은 생년월일 YYMMDD).
2. **정액제**: 계좌당 **월 5,000원** [문서, VAT 여부 미확인]. `GetFlatRateState`로 상태를 확인할 수 있다.
3. **수집 요청** `POST /EasyFin/Bank/BankAccount?BankCode=&AccountNumber=&SDate=yyyyMMdd&EDate=yyyyMMdd` → `{jobID}` (18자리).
   - **요청 1회 기간은 최대 1개월**, **조회일부터 최대 3개월 전까지**, JobID는 **1시간 유효**.
4. **상태 확인** `GET /EasyFin/Bank/{JobID}/State` → `jobState`.
   - `jobState=3`(완료) **이고** `errorCode=1`(수집 성공)일 때만 조회한다. 3인데 errorCode≠1이면 `errorReason`을 기록한다.
   - 1과 2의 정확한 의미(대기/진행 중)는 [추정].
5. **거래 조회** `GET /EasyFin/Bank/{JobID}?TradeType=I&Page=&PerPage=1000&Order=A`
   - 응답: `total, pageCount, lastScrapDT, balance, list[]`
   - `list[]` 항목: `tid, trdate, trserial, trdt(거래일시), accIn(입금액·문자열), accOut, balance(거래 후 잔액), remark1~4, regDT, memo`.
   - `TradeType=I`는 입금만, PerPage는 최대 1000.

**아직 모르는 것 → 테스트 환경에서 반드시 확인** [추정]

- **KB 입금자명이 remark1~4 중 어디에 오는지** 문서에 없다 ("은행이 주는 값을 가공 없이 제공").
- **`tid`가 작업(Job)이 바뀌어도 같은지**: SDK 테스트의 예시 tid가 `JobID(18) + 거래일자(8) + 일련번호(6)` 모양이라 **작업마다 바뀔 가능성이 높다**. 그래서 중복 방지 키로 쓰지 않는다 (§2-3).
- 하루 수집 횟수 한도와 권장 폴링 간격은 문서를 찾지 못했다.

**테스트 환경** [확인+문서]

- `IsTest` → 인증 서비스 ID `POPBILL_TEST`, API 호스트 `popbill-test.linkhub.co.kr` (운영은 `POPBILL`, `popbill.linkhub.co.kr`). 인증 호스트는 둘 다 `auth.linkhub.co.kr`.
- 팝빌 테스트 환경은 **더미가 아니라 실제 은행 거래를 수집**하고, 계좌조회 테스트는 1개월 무료다 [문서]. 테스트와 운영은 별개라 **계좌를 양쪽에 따로 등록**해야 한다.
- 연동 신청을 하면 LinkID/SecretKey가 발급된다(테스트·운영 공용). 공식 예제의 `TESTER` 키는 공용 샘플이라 실데이터에는 쓰지 않는다.

**인증 (토큰)** [확인: `linkhub@1.8.2/lib/TokenBuilder.js`]

```
POST https://auth.linkhub.co.kr/{POPBILL|POPBILL_TEST}/Token
body = {"access_id":"<사업자번호>","scope":["member","180"]}      // 180 = 계좌조회
서명 대상 = "POST\n" + base64(sha256(body)) + "\n" + xDate + "\n" + ("*\n" if IP검증 끔) + "2.0\n" + "/POPBILL/Token"
서명 = base64(HMAC-SHA256(base64decode(SecretKey), 서명 대상))
헤더: x-lh-date, x-lh-version: 2.0, [x-lh-forwarded: *], Authorization: "LINKHUB {LinkID} {서명}"
→ session_token (30분 유효 [문서]), 이후 API는 Authorization: Bearer {session_token}
```

WebCrypto로 같은 서명을 만들어 SDK(`node:crypto`) 결과와 **바이트 단위로 같은지 확인했다** [확인].

**IP 옵션** [확인: SDK 소스]

| 옵션 | 의미 | 이 프로젝트 |
|---|---|---|
| `IPRestrictOnOff` (기본 true) | 등록 IP 목록이 아니라 **「토큰을 받은 IP = API를 부른 IP」인지 검사**한다. false로 하면 `x-lh-forwarded: *`를 서명에 넣어 검사를 끈다 | **false로 사용.** Cloudflare Workers는 나가는 IP가 요청마다 바뀔 수 있어서 켜 두면 가끔 인증이 실패한다. 공식 Postman 예제도 기본이 false다 |
| `UseStaticIP` | 팝빌 쪽 고정 IP 호스트(`static-auth` / `static-popbill`)로 보낸다. **우리 방화벽에서 팝빌 IP만 허용할 때** 쓰는 옵션이라 우리 출발 IP와는 관계없다 | 필요 없음 |
| `UseGAIP` | `ga-*` 호스트 | 필요 없음 |
| 출발 IP 화이트리스트 | 팝빌이 신청을 받는 **별도 선택 서비스** [문서] | 신청하지 않음. 팝빌이 강제한다고 하면 §5 대안 |

**Node SDK를 Workers에서 쓸 수 있나** [확인+추정]

- `popbill` SDK는 `https.request` 콜백 방식, `zlib` 수동 gunzip, `new Buffer`를 쓴다. `linkhub`는 `UseLocalTimeYN=false`일 때 `xmlhttprequest`(내부에서 `child_process.spawn`)를 쓴다. `nodejs_compat`이 켜져 있으면(`wrangler.jsonc`에 이미 켜져 있음) 대부분 로드는 되겠지만, gzip 이중 해제와 전역 상태 문제가 걱정되고 실제 workerd에서 돌려 보지는 않았다.
- **결론: SDK를 쓰지 않고 REST를 직접 호출한다.** 필요한 호출이 5개(토큰, 수집 요청, 상태, 조회, 계좌 목록/정액제 상태)뿐이고 서명 방식도 검증이 끝났다. 의존성도 0개라 기존 `worker-src/webpush.js`처럼 WebCrypto만으로 짜는 이 저장소 스타일과 맞다.

### 1-5. Worker 현황 [확인]

- 진입점 `worker.js`, 설정 `wrangler.jsonc` (`nodejs_compat`, 바인딩은 `ASSETS`만). 외부 저장소는 Firebase(`FIREBASE_DB_SECRET`).
- Cron 4개가 사용 중이다: `0 18`(03:00 입찰 폴링), `30 23`(08:30 브리핑), `0 0,5`(09:00·14:00 마감 확인), `0 2,7`(11:00·16:00 변경 이력). 설정 주석에 5개 제한이 적혀 있어 **남은 자리는 1개**다.
- 인증: 앱 로그인 토큰(HMAC, 30일)을 `/api/*`마다 Bearer로 검사한다. 앱의 전역 `fetch` 패치가 자동으로 붙인다.
- 알림 수단이 이미 있다: 카카오 나에게 보내기(`kakaoSendMemo`), 웹 푸시(`pushBroadcast`).
- `.assetsignore`에 `worker-src/`와 `*.md`가 있어서 이 문서와 워커 소스는 공개 배포되지 않는다.

---

## 2. 구현 설계

### 2-1. 데이터 흐름

```
[Cron 매일 09:00·14:00 KST]  또는  [앱의 「지금 수집」 버튼 → POST /api/bank/collect]
        │
        ▼
Worker: runBankCollect(env)
  ├─ 토큰 발급 (사업자번호별, 30분 캐시)
  ├─ 계좌 3개 각각:
  │    RequestJob(SDate = 마지막 성공일 − 3일, EDate = 오늘 KST)   ← 겹치게 수집해 늦게 반영된 거래도 잡음
  │    → GetJobState 3초 간격 폴링 (최대 2분)
  │    → Search(TradeType=I, PerPage=1000, 모든 페이지)
  │    → 정규화 + 중복 키 생성
  │    → Firebase PATCH /frw_bank_inbox/{키해시}   (이미 있으면 덮어써도 같은 값 → 멱등)
  ├─ /frw_bank_status 갱신 (계좌별 마지막 성공 시각·건수·오류)
  └─ 새 건이 있거나 실패하면 알림 (푸시/카카오, 선택)
        │
        ▼
앱: 시작할 때 / 입금내역 탭을 열 때 / 10분마다  GET /api/bank/inbox?since=…
  └─ mergeBankInbox(): ext 키로 이미 있는지 확인
       ├─ 새 건 → bankDeposits.items에 pending으로 추가 (src:"api")
       ├─ 같은 거래의 엑셀 건이 이미 있으면 → 새로 넣지 않고 기존 건에 ext·시간·계좌만 덧붙임
       └─ 애매하면 → 추가하되 dupSuspect 표시 (사용자가 합치기/유지 선택)
     → 기존 동기화(rev/sig)로 /frw/bankDeposits에 올라감
```

**왜 Worker가 `/frw/bankDeposits`에 직접 쓰지 않나:** 앱의 동기화는 「내가 아는 rev = 서버 rev」일 때만 올린다. Worker가 매일 rev를 올리면, 그 순간 입금내역을 고치고 있던 기기는 **충돌**이 나고 편집 중인 내용과 부딪힌다. 수집함은 앱 섹션(`CLOUD_SECTIONS`) 밖에 두고, 병합은 앱이 기존 동기화 규칙 안에서 한다. 병합은 ext 키 기준으로 멱등이라 기기 두 대가 동시에 병합해도 충돌 → 서버본 다시 받기 → 재병합으로 **중복 없이** 수렴한다.

### 2-2. 저장 형태

**Firebase `/frw_bank_inbox/{sha1(ext)}`** — Worker만 쓴다. 키에 Firebase 금지 문자가 들어가지 않게 해시를 쓴다.

```js
{ ext: "4521|20260924103512|550000|12345678",  // 계좌끝4자리|거래일시|입금액|거래후잔액
  acct: "kb-1", biz: "nj",
  date: "2026-09-24", time: "10:35:12",
  amount: 550000, bal: 12345678,
  name: "<입금자명: 테스트 후 확정한 remark 칸>", remarks: ["…","…","…","…"],
  tid: "…", collectedAt: 1790000000000 }
```

- 90일이 지난 수집함 항목은 Worker가 정리한다. 앱에 병합된 원본은 `bankDeposits`에 남는다.

**Firebase `/frw_bank_status`**: `{ lastRunAt, accounts: { "kb-1": { lastOkAt, lastOkDate, count, lastError, errorAt } } }`

**Deposit 항목에 추가하는 필드 (전부 선택, 기존 데이터·코드 호환):**

| 필드 | 뜻 |
|---|---|
| `src` | `"api"` 또는 없음(=엑셀) |
| `ext` | 위 중복 키. 엑셀 건과 합쳐진 경우에도 붙는다 |
| `acct` | 계좌 별칭 id (`kb-1` 등) |
| `time` | `"HH:MM:SS"` |
| `bal` | 거래 후 잔액 |
| `dupSuspect` | 엑셀 건과 중복 의심일 때 그 건의 id |

**계좌 설정** — 계좌번호는 저장소에 올리지 않는다. Worker secret `POPBILL_ACCOUNTS`(JSON)에 둔다:

```json
[{ "id":"kb-1", "corpNum":"사업자번호", "bankCode":"0004", "accountNumber":"…", "biz":"nj",   "alias":"국민 주거래" },
 { "id":"kb-2", "corpNum":"…",           "bankCode":"0004", "accountNumber":"…", "biz":"nj",   "alias":"…" },
 { "id":"kb-3", "corpNum":"법인사업자번호", "bankCode":"0004", "accountNumber":"…", "biz":"corp", "alias":"…" }]
```

→ **계좌마다 biz(나정/법인)가 정해져서, 자동수집 건은 사업자 탭이 자동으로 정해진다.**

- **은행 비밀번호·인터넷뱅킹 ID는 우리 쪽에 저장하지 않는다.** 계좌 등록은 사용자가 팝빌 사이트에서 직접 한다. 현재 코드 주석에 있는 원칙 「은행 인증정보는 어디에도 저장하지 않음」을 유지한다.

### 2-3. 중복 방지 기준

**① 자동수집끼리 (같은 거래를 다음 날 다시 수집한 경우)**

- 키 `ext = 계좌 | 거래일시(초까지) | 입금액 | 거래 후 잔액`.
- 거래 후 잔액이 들어가서, 같은 초에 같은 금액이 두 번 들어와도 서로 다른 키가 된다.
- `tid`는 작업마다 바뀔 가능성이 높아서 키로 쓰지 않는다. 테스트에서 안정적이라고 확인되면 보조 키로만 쓴다.
- 수집함 → 앱 병합은 `items.some(x => x.ext === ext)`면 건너뛴다(멱등).

**② 자동수집분이 들어올 때, 이미 엑셀로 올린 같은 거래가 있는 경우 (API → 엑셀 건 확인)**

엑셀 건에는 시간·잔액·계좌가 없어서 다음 순서로 판단한다. 같은 사업자(biz)에서 `ext`가 아직 없는 엑셀 건만 대상이다.

1. 날짜와 금액이 같고 **입금자명도 맞으면**(`payablesNameMatch`) → **같은 거래로 보고 합친다.** 새로 넣지 않고 기존 엑셀 건에 `ext/src/acct/time/bal`만 덧붙인다. **처리 상태(status/client/link)는 그대로 둔다.**
2. 날짜와 금액이 같은 엑셀 건이 **딱 1건**인데 이름만 다르면 → KB 엑셀의 name이 「적요」로 잡힌 경우를 감안해 추가는 하되 `dupSuspect`로 표시한다. UI에서 「같은 거래로 합치기 / 별개 입금으로 유지」를 고르게 한다.
3. 그 밖의 경우 → 새 건으로 추가.

(날짜+금액 조합이 같은 건이 여러 개면 개수 기반으로 1:1 대응 — 현행 엑셀 중복 로직과 같은 원칙.)

**③ 엑셀을 나중에 올리는데, 그 기간이 이미 자동수집된 경우 (엑셀 → API 건 확인)**

- 현행 키(`날짜|금액|입금자명`)의 개수 기반 중복 제거를 **그대로 먼저 적용**한다.
- 추가로, 그 사업자 계좌의 **수집 완료 기간**(`/frw_bank_status`의 계좌별 기간)에 포함된 날짜라면 `날짜|금액`만으로 자동수집 건과 개수 기반 대조를 한다. 매칭되는 행은 건너뛰고 결과 알림에 「N건은 자동수집분과 같아 건너뜀 — [목록 보기] [그래도 추가]」를 보여준다.
- 이 사업자에 **팝빌에 연결하지 않은 다른 은행 계좌**가 있으면, 같은 날 같은 금액의 다른 입금이 잘못 걸러질 수 있다. 그래서 건너뛴 행을 반드시 보여주고 되살릴 수 있게 한다 (질문 Q8).

**④ 사업자 간 중복 (기존 문제)**

- 현행 엑셀 중복 검사는 현재 탭 안에서만 한다. 자동수집 도입과 함께 **양쪽 탭을 다 보고, 다른 탭에 같은 건이 있으면 경고**하도록 보강한다.

### 2-4. 거래처 자동 매칭 규칙 (초안)

아래 위에서부터 순서대로 적용하고, **처음 걸린 규칙**으로 추천한다. 결과는 `sugMap`(현재 추천 칸)에 들어간다. 1단계에서는 **추천만 하고 처리(done)는 사람이 확인**한다 (자동 처리 여부는 Q6).

| 순위 | 규칙 | 신뢰도 |
|---|---|---|
| 0 | **제외 규칙:** 입금자명이 우리 회사명(나정엔터프라이즈·엔제이세이프티·대표자명)이거나 내 계좌 간 이체, 이자·결산이자, 국세·지방세 환급 → 「연결 안 함」 추천 + 사유 표시 | 높음 |
| 1 | **학습된 이름** `nameMap[정규화 입금자명]` (현행) | 높음 |
| 2 | **정규화 일치**: `searchBare`(법인 표기·기호 제거) 기준으로 입금자명 = 거래처명 | 높음 |
| 3 | **은행 글자 수 잘림 대응**: 입금자명(3자 이상)이 거래처명의 **앞부분**과 같고 후보가 **1곳뿐** (예: 은행이 「에스케이에어플러」로 잘라 보낸 입금 → 「에스케이에어플러스(주)」) | 중간 |
| 4 | **포함 일치 (현행 `payablesNameMatch`)**: 3자 이상이면서 서로 포함 → 후보가 1곳일 때만 | 중간 |
| 5 | **금액 보조**: 이름 후보가 여러 곳이거나 없을 때, 최근 3개월 **미입금 장부 중 금액이 정확히 같은 곳이 1곳뿐**이면 그 거래처를 추천 (「금액 기준 추천」으로 표시) | 낮음 |
| 6 | 없음 → 비워 둠. 사용자가 한 번 처리하면 ①로 학습 | — |

- **거래처별 별칭**: 대표자 개인명이나 담당자명으로 입금하는 거래처 대응. `nameMap`이 이미 이 역할을 하므로, 입금내역 화면에서 「이 입금자명 = 이 거래처」 학습 목록을 보고 지울 수 있는 관리 화면만 추가한다. 현재는 학습 내용을 볼 곳이 없다.
- 연결 대상(장부/미수금)은 현행 `targetFor`를 그대로 쓴다 (금액이 정확히 같은 미입금 장부 → 장부, 아니면 미수금).
- 자동수집분의 입금자명은 테스트 후 확정한 remark 칸을 쓴다. 이름 칸이 비었으면 다른 remark를 이어 붙여 메모에 넣는다.

### 2-5. 파일 변경 목록

| 파일 | 변경 |
|---|---|
| `worker-src/popbill.js` (신규) | 토큰(WebCrypto HMAC, `x-lh-forwarded:*`, 30분 캐시), `requestJob`, `getJobState`, `search`(페이지 전부), `listBankAccount`, `getFlatRateState`. gzip은 Workers fetch가 알아서 풀어 줌 |
| `worker-src/bank-collect.js` (신규) | `runBankCollect(env, {accounts?, days?})`: 계좌별 수집 → 정규화 → 수집함 PATCH → 상태 기록 → 알림. KST 날짜 계산, 90일 지난 수집함 정리 |
| `worker.js` | `scheduled()`에 수집 분기 추가. 라우트 `GET /api/bank/inbox?since=`, `GET /api/bank/status`, `POST /api/bank/collect`(수동, 10분에 1회로 제한). 모두 기존 Bearer 인증 뒤에 둔다 |
| `wrangler.jsonc` | cron 추가 또는 기존 슬롯 공유(§2-6), vars `POPBILL_IS_TEST`. secret 이름을 주석에 적는다: `POPBILL_LINK_ID`, `POPBILL_SECRET_KEY`, `POPBILL_ACCOUNTS` |
| `index.html` — BankDepositsView | `mergeBankInbox`(§2-3 ②), 엑셀 업로드 중복 보강(§2-3 ③④), 자동/엑셀 뱃지, 계좌·시간 표시, 「지금 수집」 버튼 + 마지막 수집 시각·오류 표시, 중복 의심 해결 UI, 매칭 규칙 0·3·5 추가, 학습 목록(nameMap) 관리 |
| `index.html` — 동기화 | `sectionSignature`가 `{items:[…]}` 형태도 세도록 수정 (§1-1 문제). 예전 지문과 섞여도 오탐이 없는 방향 (서버 m=0 → 줄어든 것으로 보지 않음) |
| `worker-src/mcp.js` | 변경 없음 (`bankDeposits` 읽기 그대로) |
| `README.md` / `WORKLOG.md` | 팝빌 설정 절차(연동 신청 → 계좌 등록 → secret 등록 → 테스트 → 운영 전환) |

엑셀 업로드 흐름(`handleFile`)은 **구조를 그대로 두고** 중복 검사에 자동수집분 대조만 더한다.

### 2-6. Cron 스케줄

- **추천: 기존 `0 0,5 * * *` (09:00·14:00 KST, 입찰 마감 확인) 슬롯을 같이 쓴다.**
  - `scheduled()`에서 `ctx.waitUntil`로 마감 확인과 입금 수집을 **서로 독립적으로** 실행한다. 한쪽이 실패해도 다른 쪽은 돈다.
  - cron 마지막 한 자리를 아낄 수 있고, 하루 2번이라 오후 입금도 당일에 들어온다.
- 대안: 남은 5번째 자리에 `0 23 * * *` (08:00 KST) 전용 cron을 두면, 08:30 브리핑에 「어제 입금 N건 · 합계」를 넣을 수 있다.
- 수집 기간은 `마지막 성공일 − 3일 ~ 오늘`이다. 며칠 실패해도 다음 성공 때 메워지고, 1회 최대 1개월 제한 안에 들어온다.
- 첫 실행(백필)은 최대 3개월 전까지를 한 달씩 나눠 요청한다 (Q5).
- 실행 시간: 상태 폴링 대기는 CPU 시간이 아니라 벽시계 시간이라 cron 제한(15분) 안에 충분히 들어온다. **CPU 시간은 Free 플랜이면 호출당 10ms**라 페이지가 많은 백필에서 모자랄 수 있다 → Q10.

---

## 3. 완료 기준

1. KB 계좌 3개의 입금이 **사람 손 없이 매일** `bankDeposits`에 들어오고, 계좌마다 사업자 탭(나정/법인)으로 자동 분류된다.
2. 입금내역 화면에서 계좌별 **마지막 수집 시각과 오류**가 보이고, 「지금 수집」으로 바로 수집할 수 있다. 수집이 실패하면 알림을 받는다.
3. **중복 0건:** 엑셀과 자동수집을 **1주일 병행**하는 동안 날짜별 입금 합계가 은행 거래내역과 일치하고, 같은 기간 엑셀을 다시 올려도 늘어나지 않는다.
4. 기존 엑셀 업로드·처리·일괄 처리·되돌리기·미수금 정산·수금 패턴 화면이 전부 그대로 동작한다.
5. 자동수집 건의 거래처 추천이 기존 엑셀 건과 같은 수준 이상이다. 1주일 운영 후 추천 적중률을 측정해 기록한다.
6. 은행 비밀번호·계좌번호·팝빌 키가 저장소와 앱 데이터에 없다 (Worker secret에만 있음).
7. 입금내역 데이터가 크게 줄면 「서버보다 많이 적습니다」 경고가 실제로 뜬다 (§1-1 문제 해결).

## 4. 테스트 계획

**단위 (node, 저장소 밖 스크래치)**

- 토큰 서명: WebCrypto 구현 ↔ `linkhub` SDK 결과가 같은지 (고정 입력으로, 이미 1회 확인함).
- 정규화: 팝빌 응답 샘플 → Deposit 형태, KST 날짜·시간, 금액 문자열 → 숫자.
- `ext` 키 생성, `mergeBankInbox` (같은 수집함을 2번 병합 → 변화 없음, 엑셀 건과 합치기 ①②③ 경우 각각), 엑셀 재업로드 대조, 매칭 규칙 0~6 사례표.
- `sectionSignature` 새 버전: 예전 지문과 섞였을 때 경고 오탐 없음, 실제로 크게 줄면 경고.

**팝빌 테스트 환경 (`POPBILL_TEST`, 실제 은행 데이터)**

- 계좌 3개를 테스트 환경에 등록 → `wrangler dev` + `/__scheduled` 트리거로 수집.
- 확인할 것:
  1. KB 입금자명이 들어 있는 **remark 칸**
  2. **같은 기간을 두 번 수집했을 때 `tid`가 같은지**
  3. 오류 코드 (비밀번호 틀림, 정액제 없음)가 어떻게 오는지
  4. 한 페이지를 넘는 건수 처리
  5. 개인사업자 계좌 `AccountType`

**앱 (Playwright, 기존 테스트 하네스)**

- `/api/bank/inbox`를 목(mock)으로 두고:
  - 병합 → 뱃지·사업자 탭 확인
  - 같은 기간 KB 엑셀 업로드 → 중복 0 확인
  - 중복 의심 UI에서 합치기/유지
  - 두 탭(기기 두 대 흉내)이 동시에 병합 → 중복 없이 수렴하는지
  - 처리·되돌리기가 자동수집 건에서도 동작하는지
  - 모바일·다크 모드

**운영 전환**

1. 운영 키로 전환해 1주일 **병행** (엑셀도 계속 올림) → 날짜별 합계 대조.
2. 이상이 없으면 엑셀 업로드는 선택 사항으로.

---

## 5. 위험과 대안

| 위험 | 대응 |
|---|---|
| 팝빌이 IP 고정이나 출발 IP 화이트리스트를 요구함 | 팝빌 호출만 고정 IP 중계 서버(소형 VPS 또는 고정 출구 IP가 있는 Cloud Run)로 옮긴다. 수집함 구조는 그대로 둔다 |
| KB 빠른조회 비밀번호가 바뀌어 수집 실패 | `errorReason`을 상태에 기록하고 알림. 계좌 정보 수정은 팝빌 사이트에서 |
| 정액제 만료·포인트 부족 | 주 1회 `GetFlatRateState` 확인, 만료 7일 전 알림 |
| Free 플랜 CPU 10ms 초과 | 백필은 계좌·월 단위로 나눠 여러 번 실행하거나 Workers Paid로 전환 |
| 입금자명 칸이 은행 정책으로 바뀜 | remark 1~4를 모두 수집함에 보관해 두어, 규칙만 바꿔 다시 병합할 수 있게 한다 |

---

## 6. 확인이 필요한 질문

1. **계좌 3개가 각각 어느 사업자 것인가요?** (나정엔터프라이즈 = 개인사업자 / 엔제이세이프티 = 법인) 팝빌은 **사업자번호마다 회원을 따로** 둡니다. 두 사업자 모두 쓰면 연동회원이 2개 필요합니다.
2. **팝빌 연동 신청(LinkID/SecretKey 발급)은 되어 있나요?** 정액제 **계좌당 월 5,000원 × 3 = 월 15,000원** (VAT 별도 여부 미확인) 괜찮으신가요?
3. **KB 스피드조회(빠른조회)를 3개 계좌 모두 신청하셨나요?** 계좌 등록(계좌비밀번호·인터넷뱅킹 ID 입력)은 **팝빌 사이트에서 직접** 하시는 방식으로 할까요? 이렇게 하면 우리 앱과 서버에는 은행 정보가 남지 않습니다. (추천)
4. **수집 시각:** 09:00·14:00 하루 2번(기존 cron 공유, 추천)과 08:00 하루 1번(08:30 카톡 브리핑에 어제 입금 요약 포함) 중 어느 쪽이 좋으세요?
5. **첫 수집 때 과거 내역을 어디까지** 가져올까요? (최대 3개월. 이미 엑셀로 올린 기간은 중복 대조로 걸러집니다)
6. **자동 처리 수준:** 처음에는 「추천만 채우고 처리는 사람이 확인」(추천)으로 갈까요, 아니면 「학습된 이름 + 금액이 정확히 같은 미입금 장부」는 **바로 입금완료 처리**까지 할까요?
7. **KB 엑셀로 올린 기존 입금의 입금자명이 「타행이체」·「전자금융」 같은 적요 값으로 들어가 있나요?** 그렇다면 엑셀 파서가 「보낸분/받는분」 칸을 우선하도록 고치는 것도 이번 작업에 넣을까요? (자동수집분과 이름 대조 정확도에 직접 영향)
8. **팝빌에 연결하지 않는 다른 은행 계좌**(기업은행 등)로도 입금을 받아 엑셀로 계속 올리시나요? 날짜+금액 대조 규칙을 어디까지 적용할지가 달라집니다.
9. **알림:** 새 입금이 들어왔을 때나 수집이 실패했을 때 폰 푸시·카카오톡 알림을 받으실까요?
10. **Cloudflare 요금제가 Free인가요, Workers Paid($5/월)인가요?** (백필 CPU 한도 관련)
11. **출금은 필요 없나요?** 이번 범위는 입금만(`TradeType=I`)입니다. 자금운용의 통장 잔액 자동 반영은 잔액을 직접 입력하는 현재 방식을 유지하고 건드리지 않습니다.
