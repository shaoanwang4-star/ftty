// Firebase ID token 验签离线单测：node scripts/test-firebase-jwt.mjs
// 不需要真实 Firebase 项目：本地造 RSA 密钥 + 自签证书，模拟 Google 的 x509 公钥集。
import { createPrivateKey, createSign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyFirebaseIdToken, inspectToken, __resetKeyCache } from "../src/firebase.js";

const PROJECT = "demo-project-42";
let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};
const rejects = async (name, token, code, opts = {}) => {
  try {
    await verifyFirebaseIdToken(token, PROJECT, opts);
    check(name, false, "本应抛错却通过了");
  } catch (e) {
    check(name, e.code === code, `实际 code=${e.code} msg=${e.message}`);
  }
};

// Google 的 x509 端点返回证书 PEM，验签时取其中的 SPKI 公钥；这里用 openssl 造一张自签证书
const kid = "testkey1";
const tmp = mkdtempSync(join(tmpdir(), "mz-fbtest-"));
const keyPath = join(tmp, "key.pem"), certPath = join(tmp, "cert.pem");
try {
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=securetoken",
  ], { stdio: "ignore" });
} catch {
  console.log("  SKIP 本机 openssl 不可用，无法生成自签证书，跳过验签单测");
  process.exit(0);
}
const signingKey = createPrivateKey(readFileSync(keyPath));
const certOnly = readFileSync(certPath, "utf8").trim();
rmSync(tmp, { recursive: true, force: true });
const fetchKeys = async () => ({ [kid]: certOnly });

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const signRs256 = (data, key) => {
  const s = createSign("RSA-SHA256");
  s.write(data);
  return s.sign(key);
};
function makeToken(claims, signWith = signingKey, headerKid = kid) {
  const head = b64({ alg: "RS256", typ: "JWT", kid: headerKid });
  const body = b64(claims);
  return `${head}.${body}.${signRs256(`${head}.${body}`, signWith).toString("base64url")}`;
}

const now = () => Math.floor(Date.now() / 1000);
const goodClaims = () => ({
  iss: `https://securetoken.google.com/${PROJECT}`,
  aud: PROJECT,
  sub: "a".repeat(28),
  user_id: "a".repeat(28),
  iat: now(), exp: now() + 3600,
  email: "reader@example.com",
  firebase: { sign_in_provider: "password" },
});

console.log("Firebase ID token 验签：");
const t = makeToken(goodClaims());
check("inspectToken 能取 header/payload", inspectToken(t)?.payload?.sub === "a".repeat(28));

__resetKeyCache();
const p = await verifyFirebaseIdToken(t, PROJECT, { fetchKeys });
check("合法 token 通过并返回 claims", p.email === "reader@example.com" && p.firebase.sign_in_provider === "password");

// 公钥集只缓存一次：换 kid 前应命中缓存，故每个负例都重置
__resetKeyCache();
await rejects("签名被篡改被拒", t.slice(0, -6) + "AAAAAA", "bad_signature", { fetchKeys });
await rejects("载荷被篡改被拒", `${b64({ alg: "RS256", kid })}.${b64({ ...goodClaims(), sub: "attacker" })}.zzzz`, "bad_signature", { fetchKeys });
__resetKeyCache();
await rejects("过期 token 被拒", makeToken({ ...goodClaims(), exp: now() - 600 }), "expired", { fetchKeys });
__resetKeyCache();
await rejects("签发时间在未来被拒", makeToken({ ...goodClaims(), iat: now() + 600 }), "not_yet", { fetchKeys });
__resetKeyCache();
await rejects("iss 不符被拒", makeToken({ ...goodClaims(), iss: "https://securetoken.google.com/other" }), "bad_iss", { fetchKeys });
__resetKeyCache();
await rejects("aud 不符被拒", makeToken({ ...goodClaims(), aud: "other" }), "bad_aud", { fetchKeys });
__resetKeyCache();
await rejects("sub 超长被拒", makeToken({ ...goodClaims(), sub: "x".repeat(200), user_id: undefined }), "bad_sub", { fetchKeys });
__resetKeyCache();
await rejects("sub 与 user_id 不一致被拒", makeToken({ ...goodClaims(), user_id: "b".repeat(28) }), "bad_sub", { fetchKeys });
__resetKeyCache();
await rejects("未知 kid 被拒", makeToken(goodClaims(), signingKey, "nope"), "unknown_kid", { fetchKeys });
__resetKeyCache();
await rejects("非三段式被拒", "not.a.jwt.at.all", "malformed", { fetchKeys });
__resetKeyCache();
await rejects("alg 非 RS256 被拒", `${b64({ alg: "none", kid })}.${b64(goodClaims())}.`, "bad_alg", { fetchKeys });
__resetKeyCache();
try {
  await verifyFirebaseIdToken(t, "", { fetchKeys });
  check("projectId 为空时报错", false, "未抛错");
} catch { check("projectId 为空时报错", true); }

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
