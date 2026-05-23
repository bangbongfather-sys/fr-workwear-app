# Phase 0: 사전 준비 작업 (수동)

> Claude Code 작업 시작 전, 나방봉님이 직접 진행해야 하는 작업입니다.

## 체크리스트

- [ ] 1. 공공데이터포털 인증키 발급
- [ ] 2. Supabase 프로젝트 확인 및 Edge Functions 활성화
- [ ] 3. Resend 계정 생성 및 API 키 발급
- [ ] 4. 도메인 준비 (이메일 발송용)
- [ ] 5. 환경변수 정리

---

## 1. 공공데이터포털 인증키 발급

### 1-1. 회원가입
- https://www.data.go.kr 접속
- 우측 상단 회원가입 (사업자번호 인증 필요)

### 1-2. API 활용신청 (3개 모두)

각 페이지에서 "활용신청" 버튼 → 자동승인 → 즉시 발급:

1. **나라장터 입찰공고정보서비스**
   - https://www.data.go.kr/data/15129394/openapi.do
   - 활용목적: "자사 방염복 제품 관련 공공조달 입찰 모니터링"

2. **나라장터 낙찰정보서비스**
   - https://www.data.go.kr/data/15129397/openapi.do

3. **나라장터 계약정보서비스**
   - https://www.data.go.kr/data/15129427/openapi.do

### 1-3. 인증키 확인
- 마이페이지 → 오픈API → 개발계정
- **일반 인증키(Encoding)** 와 **일반 인증키(Decoding)** 두 가지가 보이는데, **Decoding 키** 사용 (URL 인코딩 처리는 코드에서 함)

### 1-4. 트래픽 제한 확인
- 보통 일 1,000건 시작 → 운영계정 신청 시 10,000건으로 증액 가능
- 운영계정 전환은 1주일 정도 운영 후 신청 가능

---

## 2. Supabase 프로젝트 준비

### 2-1. 기존 프로젝트 확인
fr-workwear-app에 이미 연결된 Supabase 프로젝트가 있을 텐데, 그 프로젝트를 그대로 사용합니다.

### 2-2. 필요한 정보 수집
대시보드 → Settings → API에서:
- `Project URL`: `https://xxxxx.supabase.co`
- `anon public` 키 (프론트엔드용)
- `service_role` 키 (Edge Function용, **절대 클라이언트에 노출 금지**)

### 2-3. Edge Functions 활성화 확인
- 대시보드 → Edge Functions 메뉴 클릭
- 이미 활성화돼 있어야 정상 (기본 활성)

### 2-4. Cron Extension 활성화
- 대시보드 → Database → Extensions
- `pg_cron` 검색 → Enable
- `pg_net` 검색 → Enable (HTTP 호출용)

### 2-5. Supabase CLI 설치 (로컬 개발용)
```bash
# Windows (PowerShell)
scoop install supabase

# 또는 npm
npm install -g supabase

# 로그인
supabase login

# 프로젝트 연결 (fr-workwear-app 디렉토리에서)
supabase link --project-ref <YOUR_PROJECT_REF>
```

---

## 3. Resend 이메일 서비스

### 3-1. 가입
- https://resend.com 가입 (월 3,000건 무료)
- GitHub 계정으로 가입 가능

### 3-2. API 키 발급
- Dashboard → API Keys → Create API Key
- 권한: "Full access" 선택
- 키는 한 번만 표시되니 즉시 안전한 곳에 저장

### 3-3. 도메인 검증 (필수)
- Dashboard → Domains → Add Domain
- 사용할 도메인 입력 (예: njsafety.co.kr 또는 testing 용 본인 소유 도메인)
- 표시되는 DNS 레코드 3개(SPF, DKIM, MX-DMARC)를 도메인 관리 페이지(가비아/카페24 등)에 추가
- 검증 완료까지 보통 10분~1시간

> **도메인 없으면 임시 방법**: Resend의 `onboarding@resend.dev`로 본인 가입 이메일에만 발송 가능 (테스트용)

---

## 4. 이메일 수신 주소

알림을 받을 이메일 주소 1개 (또는 2~3개) 준비.
- 예: `bangbong@njsafety.co.kr` 또는 개인 Gmail
- Phase 2에서 환경변수로 설정

---

## 5. 환경변수 정리

fr-workwear-app 프로젝트 루트에 `.env.local` 파일 준비 (이미 있다면 추가):

```bash
# === 기존 fr-workwear-app 변수 (그대로 유지) ===
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJxxx...

# === 추가할 변수 ===
# (프론트엔드에서는 사용하지 않으나, 로컬 테스트용으로 보관)
```

Supabase Edge Function용 환경변수는 Supabase 대시보드에서 별도 설정합니다:

대시보드 → Edge Functions → Manage secrets:

```bash
G2B_SERVICE_KEY=발급받은_조달청_인증키_Decoding값
RESEND_API_KEY=re_xxxxx
NOTIFICATION_EMAIL_FROM=NJ Safety 입찰알리미 <bid@your-domain.com>
NOTIFICATION_EMAIL_TO=bangbong@njsafety.co.kr
```

또는 CLI로:
```bash
supabase secrets set G2B_SERVICE_KEY=xxx
supabase secrets set RESEND_API_KEY=re_xxx
supabase secrets set NOTIFICATION_EMAIL_FROM="NJ Safety <bid@your-domain.com>"
supabase secrets set NOTIFICATION_EMAIL_TO=bangbong@njsafety.co.kr
```

---

## 완료 확인

다음 모두가 준비되면 Phase 1로 진행:

- ✅ 조달청 인증키 3종 발급 완료 (1개 키로 3개 API 모두 사용 가능)
- ✅ Supabase 프로젝트 연결, pg_cron + pg_net 활성화
- ✅ Resend 도메인 검증 완료, API 키 보관
- ✅ Supabase Secrets에 환경변수 등록 완료
- ✅ `supabase` CLI 로컬에 설치되어 `supabase functions list` 명령 동작

이 5가지가 끝나면 **`phase-1-data-collection.md`** 로 진행하세요.
