/**
 * Firebase ID Token 验签（无 Admin SDK，纯 Web Crypto）。
 *
 * ID token 是 RS256 JWT，由 Google 的 securetoken 密钥签发：
 *   iss = https://securetoken.google.com/<projectId>
 *   aud = <projectId>
 *   sub = Firebase uid（<=128 字符）
 * 官方文档：https://firebase.google.com/docs/auth/admin/verify-id-tokens
 * 公钥集：https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com
 * 该端点带 Cache-Control，且轮换密钥时会同时提供新旧两把，故按 kid 查找 + 定期刷新即可。
 */

const JWKS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const KEY_REFRESH_MS = 3600_000;
const CLOCK_SKEW_SEC = 300; // 容忍 5 分钟时钟偏移

let keyCache = null; // { keys: {kid: CryptoKey}, fetchedAt: number }

const b64urlToBuf = (s) => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
};

function decodeJwt(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  try {
    return {
      raw: parts,
      header: JSON.parse(new TextDecoder().decode(b64urlToBuf(parts[0]))),
      payload: JSON.parse(new TextDecoder().decode(b64urlToBuf(parts[1]))),
      signature: b64urlToBuf(parts[2]),
    };
  } catch {
    return null;
  }
}

/**
 * 极简 DER 读取：返回 { tag, valueStart, valueEnd, next }
 * next 为该元素结束后的偏移（含 tag+length 头），用于顺序遍历。
 */
function readDer(buf, i) {
  const tag = buf[i++];
  let len = buf[i++];
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let k = 0; k < n; k++) len = (len << 8) | buf[i++];
  }
  return { tag, valueStart: i, valueEnd: i + len, next: i + len };
}

/**
 * 从 X.509 证书 DER 中取出 subjectPublicKeyInfo（SPKI）。
 * Google 的 x509 端点返回的是完整证书 PEM，而 crypto.subtle 只接受 SPKI，
 * 直接把证书 DER 当 SPKI 会报 Invalid keyData。
 * 结构：Certificate ::= SEQUENCE { tbsCertificate, sigAlg, sigValue }
 *       TBSCertificate 第 7 个字段即 subjectPublicKeyInfo（tag 0x30；v3 证书带 version [0]，字段布局固定）。
 */
function derSpkiFromCert(certDer) {
  const cert = readDer(certDer, 0);
  const tbs = readDer(certDer, cert.valueStart);
  let p = tbs.valueStart;
  const skip = () => { p = readDer(certDer, p).next; };
  skip(); // version [0] EXPLICIT INTEGER（v3 起必有）
  skip(); // serialNumber
  skip(); // signature AlgorithmIdentifier
  skip(); // issuer Name
  skip(); // validity
  skip(); // subject Name
  const spkiAt = p;
  const spki = readDer(certDer, p);
  if (spki.tag !== 0x30) throw new Error("证书中找不到 subjectPublicKeyInfo");
  return certDer.slice(spkiAt, spki.next);
}

function pemToDer(pem) {
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
}

async function importX509(pem) {
  const der = pemToDer(pem);
  const spki = pem.includes("CERTIFICATE") ? derSpkiFromCert(der) : der;
  return crypto.subtle.importKey(
    "spki", spki,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["verify"]
  );
}

/** 拉取并缓存 Google 公钥；fetchKeys 便于离线单测注入 */
async function getKeys(fetchKeys) {
  const now = Date.now();
  if (keyCache && now - keyCache.fetchedAt < KEY_REFRESH_MS) return keyCache;
  const raw = fetchKeys
    ? await fetchKeys()
    : await (await fetch(JWKS_URL, { headers: { accept: "application/json" } })).json();
  const keys = {};
  for (const [kid, pem] of Object.entries(raw)) {
    // 单个条目解析失败不应中断：Google 轮换期会混入其它格式，但整体不可用要能被发现
    try { keys[kid] = await importX509(pem); } catch (e) { console.warn(`[auth] 公钥 ${kid} 解析失败: ${e.message}`); }
  }
  if (Object.keys(keys).length === 0) throw Object.assign(new Error("无法加载签名公钥"), { code: "keys_unavailable" });
  keyCache = { keys, fetchedAt: now };
  return keyCache;
}

/** 仅解码不验签，用于取 kid/sub 等信息 */
export function inspectToken(token) {
  const d = decodeJwt(token);
  return d ? { header: d.header, payload: d.payload } : null;
}

/**
 * 校验 Firebase ID token。成功返回 payload，失败抛 Error（带 code 便于映射 HTTP 状态）。
 */
export async function verifyFirebaseIdToken(token, projectId, opts = {}) {
  const fail = (code, msg) => Object.assign(new Error(msg), { code });
  if (!projectId) throw fail("not_configured", "未配置 Firebase 项目");
  const d = decodeJwt(token);
  if (!d) throw fail("malformed", "token 格式非法");
  if (d.header.alg !== "RS256") throw fail("bad_alg", "签名算法不受支持");

  const { keys } = await getKeys(opts.fetchKeys);
  const key = keys[d.header.kid];
  if (!key) throw fail("unknown_kid", "找不到对应的签名公钥");
  const signed = new TextEncoder().encode(`${d.raw[0]}.${d.raw[1]}`);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, d.signature, signed);
  if (!ok) throw fail("bad_signature", "签名校验失败");

  const p = d.payload;
  const now = Math.floor(Date.now() / 1000);
  if (p.iss !== `https://securetoken.google.com/${projectId}`) throw fail("bad_iss", "签发者不符");
  if (p.aud !== projectId) throw fail("bad_aud", "受众不符");
  if (typeof p.exp !== "number" || now - CLOCK_SKEW_SEC > p.exp) throw fail("expired", "token 已过期");
  if (typeof p.iat !== "number" || p.iat - CLOCK_SKEW_SEC > now) throw fail("not_yet", "token 签发时间在未来");
  if (typeof p.sub !== "string" || p.sub.length === 0 || p.sub.length > 128) throw fail("bad_sub", "uid 非法");
  if (p.user_id !== undefined && p.user_id !== p.sub) throw fail("bad_sub", "user_id 与 sub 不一致");
  return p;
}

/** 供单测重置缓存 */
export function __resetKeyCache() { keyCache = null; }
