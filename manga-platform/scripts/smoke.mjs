// API 冒烟测试：node scripts/smoke.mjs <baseURL>
import fs from "node:fs";
import path from "node:path";

const BASE = process.argv[2] || "http://127.0.0.1:8787";
let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

async function req(p, opts = {}, cookie = "") {
  const r = await fetch(BASE + p, {
    ...opts,
    headers: { ...(opts.headers || {}), ...(cookie ? { cookie } : {}) },
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  const sc = r.headers.getSetCookie?.() ?? [];
  const sid = sc.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
  return { status: r.status, data, sid };
}

const uname = `tester_${Date.now().toString(36)}`;

// 0. 前置断言：若目标端口上是旧构建（常见于残留的 wrangler dev 进程抢占端口），立即中止
{
  const probe = await req("/api/friends");
  if (probe.status === 404) {
    console.error(`\n${BASE} 上没有 /api/friends 路由 —— 该端口很可能被残留的 wrangler dev/workerd 进程占用，服务的是旧代码。
清理方法：Get-CimInstance Win32_Process | ? { $_.Name -eq 'workerd.exe' -or $_.CommandLine -match 'wrangler' }，按树杀掉根进程后重试。`);
    process.exit(2);
  }
}

// 1. 注册作者 + 登录态
let r = await req("/api/register", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: uname, password: "secret123" }),
});
check("注册", r.status === 201 && r.sid.startsWith("sid="), JSON.stringify(r.data));
const author = r.sid;
r = await req("/api/me", {}, author);
check("会话 /api/me", r.data.id !== null && r.data.username === uname);

// 2. 弱校验
r = await req("/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "a", password: "1" }) });
check("非法用户名被拒", r.status === 400);
r = await req("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: uname, password: "wrong" }) });
check("错误密码 401", r.status === 401);

// 3. 创建漫画(付费 5 元) + 章节 + 上传 6 页
r = await req("/api/comics", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "月光天台", description: "测试作品", price_cents: 500 }) }, author);
check("创建漫画", r.status === 201, JSON.stringify(r.data));
const comicId = r.data.id;
r = await req(`/api/comics/${comicId}/chapters`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "相遇" }) }, author);
check("创建章节", r.status === 201);
const chId = r.data.id;

const fd = new FormData();
for (let i = 1; i <= 6; i++) {
  const buf = fs.readFileSync(path.join("sample-assets", `page${i}.png`));
  fd.append("files", new Blob([buf], { type: "image/png" }), `page${i}.png`);
}
r = await req(`/api/chapters/${chId}/pages`, { method: "POST", body: fd }, author);
check("上传 6 页", r.status === 201 && r.data.added === 6, JSON.stringify(r.data));

// 4. 封面
const fd2 = new FormData();
fd2.append("file", new Blob([fs.readFileSync("sample-assets/page1.png")], { type: "image/png" }), "cover.png");
r = await req(`/api/comics/${comicId}/cover`, { method: "POST", body: fd2 }, author);
check("上传封面", r.status === 200 && r.data.cover_key);

// 5. 游客浏览
r = await req("/api/comics");
check("书城列表含新作且有封面", r.data.comics.some((c) => c.id === comicId && c.cover));
r = await req(`/api/chapters/${chId}/reader`);
const free = r.data.pages.filter((p) => p.url), locked = r.data.pages.filter((p) => p.locked);
check("游客试读 3 页锁 3 页", free.length === 3 && locked.length === 3, JSON.stringify(r.data.pages.map((p) => p.locked)));
const img = await fetch(BASE + free[0].url);
check("游客可取试读图", img.status === 200 && img.headers.get("content-type") === "image/png");

// 6. 弹幕：游客被拒，登录可发，读取可见
r = await req("/api/danmaku", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chapterId: chId, pageIdx: 0, tMs: 500, text: "前方高能！" }) });
check("游客发弹幕 401", r.status === 401);
r = await req("/api/danmaku", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chapterId: chId, pageIdx: 0, tMs: 500, text: "前方高能！<script>" }) }, author);
check("登录发弹幕 201", r.status === 201);
r = await req(`/api/danmaku?chapterId=${chId}&pageIdx=0`);
check("弹幕列表可读", r.data.danmaku.length === 1 && r.data.danmaku[0].text.includes("前方高能"));

// 7. 读者注册 + mock 支付解锁
r = await req("/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: `reader_${Date.now().toString(36)}`, password: "secret123" }) });
const reader = r.sid;
r = await req("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ comicId }) }, reader);
check("创建订单 5 元", r.status === 201 && r.data.amount_cents === 500);
const orderId = r.data.orderId;
r = await req(`/api/orders/${orderId}/pay`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, reader);
check("mock 支付成功", r.data.ok && r.data.unlocked);
r = await req(`/api/chapters/${chId}/reader`, {}, reader);
check("支付后可见 6 页", r.data.pages.every((p) => p.url));
const paidImg = await fetch(BASE + r.data.pages[5].url, { headers: { cookie: reader } });
check("付费页图片可取", paidImg.status === 200);

// 8. 匿名取付费页被拒（携带已购读者 URL）
const anonImg = await fetch(BASE + r.data.pages[5].url);
check("匿名取付费页 403", anonImg.status === 403);

// 9. 作者编辑 + 越权检查
r = await req(`/api/comics/${comicId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "月光天台（改）", published: true }) }, author);
check("编辑漫画", r.data.ok);
r = await req(`/api/comics/${comicId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) }, reader);
check("非作者编辑被拒 403", r.status === 403);

// 10. 好友：申请 -> 收件箱 -> 接受 -> 好友列表 -> 再次申请即好友
const authorId = (await req("/api/me", {}, author)).data.id;
const readerId = (await req("/api/me", {}, reader)).data.id;

r = await req("/api/friends/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: readerId }) }, author);
check("发好友申请 201", r.status === 201 && r.data.sent, JSON.stringify(r.data));
r = await req("/api/friends/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: authorId }) }, author);
check("不能加自己为好友 400", r.status === 400);
r = await req("/api/friends/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: 999999 }) }, author);
check("目标不存在 404", r.status === 404);
r = await req("/api/friends", {}, author);
check("单向通过前还不是好友", r.data.friends.length === 0, JSON.stringify(r.data));

r = await req("/api/friends/incoming/count", {}, reader);
check("对方收到 1 条待处理", r.data.count === 1, JSON.stringify(r.data));
r = await req("/api/friends/requests?dir=incoming", {}, reader);
check("收件箱可见申请人", r.data.requests.length === 1 && r.data.requests[0].username === uname);
const frId = r.data.requests[0].id;
r = await req(`/api/friends/requests/${frId}/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, author);
check("非受请方不能处理 403", r.status === 403);
r = await req(`/api/friends/requests/${frId}/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, reader);
check("接受申请", r.data.ok && r.data.friend);
r = await req("/api/friends", {}, reader);
check("好友列表含申请人", r.data.friends.length === 1 && r.data.friends[0].id === authorId, JSON.stringify(r.data));
r = await req("/api/friends/incoming/count", {}, reader);
check("处理后红点归零", r.data.count === 0);

// 好友是对称关系：作者侧同样可见；反向再申请应被判为“已是好友”
r = await req("/api/friends", {}, author);
check("发起方好友列表也含对方", r.data.friends.some((f) => f.id === readerId), JSON.stringify(r.data));
r = await req("/api/friends/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: readerId }) }, author);
check("对向已成立时仍算好友 409", r.status === 409, JSON.stringify(r.data));

// 关系视图：详情页 / 用户主页 / 搜索
r = await req(`/api/comics/${comicId}`, {}, reader);
check("详情页返回作者与关系", r.data.owner?.id === authorId && r.data.ownerRelationship === "friends", JSON.stringify(r.data.ownerRelationship));
r = await req(`/api/users/${authorId}`, {}, reader);
check("用户主页含作品与关系", r.data.user.username === uname && r.data.comics.length >= 1 && r.data.relationship === "friends");
// 作者主页不泄露未公开作品
await req(`/api/comics/${comicId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ published: false }) }, author);
r = await req(`/api/users/${authorId}`, {}, reader);
check("主页不泄露下架作品", !r.data.comics.some((x) => x.id === comicId), JSON.stringify(r.data.comics));
await req(`/api/comics/${comicId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ published: true }) }, author);
r = await req(`/api/users/search?q=${encodeURIComponent(uname.slice(3, 10))}`, {}, reader);
check("模糊搜索命中且带关系", r.data.users.some((u) => u.id === authorId && u.relationship === "friends"), JSON.stringify(r.data.users));
r = await req(`/api/users/search?q=${encodeURIComponent("_no_such_user_zz")}`, {}, reader);
check("搜索无结果为空数组", r.data.users.length === 0);

// 拒绝 / 删除
r = await req("/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: `intruder_${Date.now().toString(36)}`, password: "secret123" }) });
const third = r.sid;
const thirdId = r.data.id;
await req("/api/friends/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: authorId }) }, third);
r = await req("/api/friends/requests?dir=incoming", {}, author);
const badId = r.data.requests.find((x) => x.user_id === thirdId).id;
r = await req(`/api/friends/requests/${badId}/reject`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, author);
check("拒绝申请", r.data.ok);
r = await req("/api/friends/requests?dir=incoming", {}, author);
check("拒绝后移出收件箱", !r.data.requests.some((x) => x.user_id === thirdId));
r = await req("/api/friends/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: authorId }) }, author);
check("重复申请自己仍被拒 400", r.status === 400);

r = await req(`/api/friends/${readerId}`, { method: "DELETE" }, author);
check("删除好友（仅一行 accepted）", r.data.ok && r.data.removed === 1, JSON.stringify(r.data));
r = await req("/api/friends", {}, author);
check("删除后双方好友列表为空", r.data.friends.length === 0);
r = await req(`/api/friends/${readerId}`, { method: "DELETE" }, author);
check("重复删除 404", r.status === 404);
// 重建双向 accepted，验证一次删除清掉两行
await req("/api/friends/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: readerId }) }, author);
r = await req("/api/friends/requests?dir=incoming", {}, reader);
await req(`/api/friends/requests/${r.data.requests.find((x) => x.user_id === authorId).id}/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, reader);
await req("/api/friends/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: authorId }) }, reader);
r = await req(`/api/friends/${readerId}`, { method: "DELETE" }, author);
check("双向 accepted 一次删除清两行", r.data.removed === 2, JSON.stringify(r.data));
r = await req("/api/friends/requests?dir=incoming", {}, author);
check("删除好友不影响历史 rejected 记录", !r.data.requests.some((x) => x.user_id === readerId));
r = await req("/api/friends", {}, reader);
check("对方侧也不再是好友", r.data.friends.length === 0);
r = await req("/api/friends", {});
check("游客看好友 401", r.status === 401);

// 10. Firebase 登录（服务端需配置 FIREBASE_PROJECT_ID）
// 端到端建档需要真实 ID token：从浏览器 Firebase SDK 拿到后
//   FB_ID_TOKEN=<idToken> node scripts/smoke.mjs
// 可选 FB_ANON_TOKEN=<匿名idToken> 验证只读游客被拦截
r = await req("/api/auth/firebase/config");
check("Firebase 配置接口可读", r.status === 200 && typeof r.data.enabled === "boolean");
if (!r.data.enabled) {
  console.log("  SKIP Firebase：服务端未配置 FIREBASE_PROJECT_ID");
} else {
  r = await req("/api/auth/firebase", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "not.a.real.token" }),
  });
  check("非法 token 被拒 401", r.status === 401);
  const tok = (process.env.FB_ID_TOKEN || "").trim();
  if (!tok) {
    console.log("  SKIP Firebase 建档：未设置 FB_ID_TOKEN");
  } else {
    r = await req("/api/auth/firebase", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: tok }),
    });
    check("Firebase token 换取本地账号", r.status === 200 && !!r.data.id, JSON.stringify(r.data));
    const fbName = r.data.username;
    r = await req("/api/me", {}, r.sid);
    check("Firebase 登录后的 Cookie 会话可用", r.data.username === fbName);
    const rb = await fetch(BASE + "/api/me", { headers: { authorization: `Bearer ${tok}` } });
    const jb = await rb.json();
    check("Bearer ID token 直连可用", jb.id === r.data.id && jb.username === fbName, JSON.stringify(jb));
    r = await req("/api/danmaku", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chapterId: chId, pageIdx: 0, tMs: 800, text: "Firebase 弹幕" }),
    }, r.sid);
    check("Firebase 账号可发弹幕", r.status === 201, JSON.stringify(r.data));
  }
  const anonTok = (process.env.FB_ANON_TOKEN || "").trim();
  if (anonTok) {
    r = await req("/api/auth/firebase", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: anonTok }),
    });
    check("匿名账号建档 provider=anonymous", r.data.anonymous === true, JSON.stringify(r.data));
    const anon = r.sid;
    r = await req("/api/danmaku", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chapterId: chId, pageIdx: 0, tMs: 100, text: "游客发言" }),
    }, anon);
    check("匿名发弹幕被拒 403", r.status === 403);
    r = await req("/api/comics", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "匿名试探" }),
    }, anon);
    check("匿名建漫画被拒 403", r.status === 403);
    r = await req(`/api/chapters/${chId}/reader`, {}, anon);
    check("匿名仍可阅读", r.status === 200 && r.data.pages.length > 0);
  } else {
    console.log("  SKIP 匿名游客拦截：未设置 FB_ANON_TOKEN");
  }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败  (comic=${comicId} chapter=${chId})`);
process.exit(fail ? 1 : 0);
