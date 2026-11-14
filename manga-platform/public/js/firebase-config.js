/**
 * Firebase Web 应用配置。
 *
 * 这些值来自 Firebase 控制台 → 项目设置 → 你的应用 → "SDK 配置和服务账号"，
 * 属于公开信息（会出现在前端源码里），不是密钥；真正的安全边界在服务端验签。
 *
 * apiKey / projectId / appId 留空时，前端自动退回原有的“用户名 + 密码”自建登录，
 * 站点其余功能不受影响。
 */
window.FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
};

/** 与 src/worker.js 的 env.FIREBASE_PROJECT_ID 必须一致 */
window.FIREBASE_SDK_VERSION = "12.6.0";

window.FIREBASE_CONFIGURED = () => Boolean(window.FIREBASE_CONFIG?.apiKey && window.FIREBASE_CONFIG?.projectId);
