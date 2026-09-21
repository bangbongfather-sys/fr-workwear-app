// ── 웹 푸시 발송 (RFC 8291 aes128gcm + RFC 8292 VAPID) ──────────────
// 카카오톡 '나와의 채팅'은 카카오가 푸시를 주지 않는다(메모 취급). 폰으로 진짜 알림을
// 받으려면 우리 앱이 직접 보내야 해서, 표준 웹 푸시를 워커 안에서 구현한다.
// 외부 라이브러리 없이 Web Crypto 만 쓴다.

const enc = new TextEncoder();

const b64uToBytes = (s) => {
  const t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const bytesToB64u = (buf) => {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const concat = (...arrs) => {
  const n = arrs.reduce((a, x) => a + x.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

async function hmac(keyBytes, dataBytes) {
  const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, dataBytes));
}
// HKDF 한 블록(32바이트 이하)만 필요하므로 expand 를 1회만 돈다
async function hkdf(salt, ikm, info, len) {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concat(info, new Uint8Array([1])));
  return okm.slice(0, len);
}

// VAPID JWT (ES256). aud 는 푸시 엔드포인트의 origin.
async function vapidAuth(endpoint, publicKeyB64u, privateKeyB64u, subject) {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = bytesToB64u(enc.encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject,
  })));
  const signingInput = enc.encode(`${header}.${payload}`);
  const pub = b64uToBytes(publicKeyB64u); // 65바이트 비압축 점
  const key = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", d: privateKeyB64u,
    x: bytesToB64u(pub.slice(1, 33)), y: bytesToB64u(pub.slice(33, 65)),
    ext: true,
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, signingInput));
  return `vapid t=${header}.${payload}.${bytesToB64u(sig)}, k=${publicKeyB64u}`;
}

// 본문 암호화 (aes128gcm). 결과: salt|rs|idlen|서버공개키|암호문
async function encryptPayload(text, p256dhB64u, authB64u) {
  const uaPublic = b64uToBytes(p256dhB64u);   // 65
  const authSecret = b64uToBytes(authB64u);   // 16
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const asKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey)); // 65
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));

  // IKM: auth_secret 을 salt 로, 공유비밀을 IKM 으로 (RFC 8291 §3.3)
  const keyInfo = concat(enc.encode("WebPush: info"), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);

  const cek = await hkdf(salt, ikm, concat(enc.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, concat(enc.encode("Content-Encoding: nonce"), new Uint8Array([0])), 12);

  const plain = concat(enc.encode(text), new Uint8Array([2])); // 0x02 = 마지막 레코드 구분자
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plain));

  const rs = new Uint8Array([0, 0, 0x10, 0]); // 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

// 구독 하나에 발송. 410/404 면 만료된 구독이라 지우라고 알린다.
export async function sendWebPush(sub, text, env) {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return { ok: false, error: "VAPID 미설정" };
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return { ok: false, error: "구독 정보 불완전" };
  try {
    const body = await encryptPayload(text, sub.keys.p256dh, sub.keys.auth);
    const auth = await vapidAuth(sub.endpoint, env.VAPID_PUBLIC, env.VAPID_PRIVATE, env.VAPID_SUBJECT || "mailto:njsafety91@gmail.com");
    const r = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        "Authorization": auth,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": "86400",
        "Urgency": "normal",
      },
      body,
    });
    if (r.status === 404 || r.status === 410) return { ok: false, gone: true, status: r.status };
    if (!r.ok) return { ok: false, status: r.status, error: (await r.text().catch(() => "")).slice(0, 200) };
    return { ok: true, status: r.status };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
