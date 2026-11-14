/**
 * Firebase 前端登录封装（ES Module，从 gstatic CDN 按需加载官方 SDK）。
 *
 * 流程：浏览器拿到 Firebase ID token -> POST /api/auth/firebase -> 服务端验签并
 * 映射/建档本地用户 -> 同时下发 sid Cookie。因此普通页面即使不加载本模块，
 * 也能靠 Cookie 维持登录态；本模块只在登录页和首次恢复会话时介入。
 */

const CDN = "https://www.gstatic.com/firebasejs/" + (window.FIREBASE_SDK_VERSION || "12.6.0") + "/";

let _auth = null;
let _sdk = null;
let _attach = null;

const ERR_CN = {
  "auth/invalid-credential": "邮箱或密码不正确",
  "auth/user-not-found": "邮箱或密码不正确",
  "auth/wrong-password": "邮箱或密码不正确",
  "auth/email-already-in-use": "该邮箱已注册，请直接登录",
  "auth/weak-password": "密码至少需要 6 位",
  "auth/invalid-email": "邮箱格式不正确",
  "auth/too-many-requests": "尝试次数过多，请稍后再试",
  "auth/network-request-failed": "网络异常，无法连接 Firebase",
  "auth/popup-closed-by-user": "已取消 Google 登录",
  "auth/operation-not-allowed": "该登录方式未在 Firebase 控制台启用",
  "auth/configuration-not-found": "请在 Firebase 控制台启用 Google 登录并提供 authDomain",
  "auth/api-key-not-valid": "Firebase apiKey 无效，请核对 public/js/firebase-config.js",
  "auth/invalid-api-key": "Firebase apiKey 无效，请核对 public/js/firebase-config.js",
};

async function sdk() {
  if (!_auth) {
    const [appMod, authMod] = await Promise.all([
      import(CDN + "firebase-app.js"),
      import(CDN + "firebase-auth.js"),
    ]);
    const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(window.FIREBASE_CONFIG);
    _auth = authMod.getAuth(app);
    _sdk = authMod;
  }
  return { auth: _auth, A: _sdk };
}

// Firebase 错误码常带后缀（auth/api-key-not-valid.-please-pass-a-valid-api-key），故再按首段匹配一次
const rethrow = (e) => {
  const code = String(e?.code || "");
  throw new Error(ERR_CN[code] || ERR_CN[code.split(".")[0]] || e?.message || "登录失败");
};

/** 把当前 ID token 交给 Worker，换取本地账号 + Cookie */
async function bindToBackend() {
  const { auth } = await sdk();
  const user = auth.currentUser;
  if (!user) return null;
  const token = await user.getIdToken();
  window.setApiToken?.(token);
  const r = await fetch("/api/auth/firebase", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `绑定本地账号失败 (${r.status})`);
  sessionStorage.setItem("fb_bound_uid", user.uid);
  return data;
}

export const isConfigured = () => window.FIREBASE_CONFIGURED?.() === true;

export async function signInWithEmail(email, password) {
  const { auth, A } = await sdk();
  try { await A.signInWithEmailAndPassword(auth, email, password); } catch (e) { rethrow(e); }
  return bindToBackend();
}

export async function signUpWithEmail(email, password, displayName) {
  const { auth, A } = await sdk();
  try {
    const cred = await A.createUserWithEmailAndPassword(auth, email, password);
    if (displayName) await A.updateProfile(cred.user, { displayName });
  } catch (e) { rethrow(e); }
  return bindToBackend();
}

export async function signInWithGoogle() {
  const { auth, A } = await sdk();
  try { await A.signInWithPopup(auth, new A.GoogleAuthProvider()); } catch (e) { rethrow(e); }
  return bindToBackend();
}

/** 只读游客：服务端会拦截其发帖、传漫画、下单、加好友 */
export async function signInAnonymously() {
  const { auth, A } = await sdk();
  try { await A.signInAnonymously(auth); } catch (e) { rethrow(e); }
  return bindToBackend();
}

export async function signOut() {
  const { auth, A } = await sdk();
  sessionStorage.removeItem("fb_bound_uid");
  window.setApiToken?.(null);
  await A.signOut(auth);
}

/**
 * 恢复已有会话：拿到新 ID token，必要时重新绑定本地账号。
 * 首次 onAuthStateChanged 回调后即 resolve（无登录态也 resolve）。
 */
export function attach() {
  if (_attach) return _attach;
  _attach = (async () => {
    if (!isConfigured()) return null;
    const { auth, A } = await sdk();
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      A.onAuthStateChanged(auth, async (user) => {
        if (!user) { window.setApiToken?.(null); finish(null); return; }
        try {
          const token = await user.getIdToken();
          window.setApiToken?.(token);
          if (sessionStorage.getItem("fb_bound_uid") !== user.uid) await bindToBackend();
        } catch (e) {
          console.warn("[firebase] 会话恢复失败：", e.message);
        }
        finish(user);
      });
    });
  })();
  return _attach;
}
