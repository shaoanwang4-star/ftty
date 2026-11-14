// 造演示数据：node scripts/seed-demo.mjs [baseURL]
// 两个作者 + 一个读者，含公开/下架作品、章节页面、弹幕与一条待处理好友申请。
import fs from "node:fs";
import path from "node:path";

const BASE = process.argv[2] || "http://127.0.0.1:8787";

async function api(p, opts = {}, cookie = "") {
  const isForm = opts.body instanceof FormData;
  const r = await fetch(BASE + p, {
    ...opts,
    headers: { ...(isForm ? {} : (opts.headers || {})), ...(cookie ? { cookie } : {}) },
    body: isForm ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  const sid = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${text}`);
  return { data, sid };
}

async function ensureAccount(username, password) {
  try {
    return await api("/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: { username, password } });
  } catch {
    return await api("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: { username, password } });
  }
}

async function makeComic(cookie, { title, description, price, pages, danmaku }) {
  const { data: comic } = await api("/api/comics", { method: "POST", headers: { "content-type": "application/json" }, body: { title, description, price_cents: price } }, cookie);
  const { data: ch } = await api(`/api/comics/${comic.id}/chapters`, { method: "POST", headers: { "content-type": "application/json" }, body: { title: "第 1 话" } }, cookie);
  const fd = new FormData();
  for (let i = 1; i <= pages; i++) {
    const buf = fs.readFileSync(path.join("sample-assets", `page${((i - 1) % 6) + 1}.png`));
    fd.append("files", new Blob([buf], { type: "image/png" }), `p${i}.png`);
  }
  await api(`/api/chapters/${ch.id}/pages`, { method: "POST", body: fd }, cookie);
  const cover = new FormData();
  cover.append("file", new Blob([fs.readFileSync(path.join("sample-assets", "page1.png"))], { type: "image/png" }), "cover.png");
  await api(`/api/comics/${comic.id}/cover`, { method: "POST", body: cover }, cookie);
  for (const text of danmaku || []) {
    await api("/api/danmaku", { method: "POST", headers: { "content-type": "application/json" }, body: { chapterId: ch.id, pageIdx: 0, tMs: 300, text } }, cookie);
  }
  return { comicId: comic.id, chapterId: ch.id };
}

const author1 = await ensureAccount("作者阿墨", "secret123");
const author2 = await ensureAccount("拾光酱", "secret123");
const reader = await ensureAccount("读者小夏", "secret123");

const a = await makeComic(author1.sid, {
  title: "霓虹夜行录", description: "雨夜的赛博城市，外卖员阿澄意外捡到一台能预知未来的终端。",
  price: 0, pages: 6, danmaku: ["这画风爱了", "分镜好舒服", "前面别剧透！"],
});
const b = await makeComic(author2.sid, {
  title: "月光天台（付费）", description: "毕业前的最后一个夏天，两个在天台相遇的人。",
  price: 500, pages: 6, danmaku: ["名场面", "这段看了三遍"],
});
const draft = await makeComic(author1.sid, { title: "未公开草稿", description: "作者自己可见", price: 0, pages: 2 });
await api(`/api/comics/${draft.comicId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: { published: false } }, author1.sid);

// 读者 -> 阿墨：待处理好友申请（用 UI 登录阿墨时可在收件箱看到）
await api("/api/friends/request", { method: "POST", headers: { "content-type": "application/json" }, body: { userId: author1.data.id } }, reader.sid);
// 拾光酱 -> 阿墨：已是好友
await api("/api/friends/request", { method: "POST", headers: { "content-type": "application/json" }, body: { userId: author1.data.id } }, author2.sid);
await api("/api/friends/request", { method: "POST", headers: { "content-type": "application/json" }, body: { userId: author2.data.id } }, author1.sid);
const inbox = await api("/api/friends/requests?dir=incoming", {}, author1.sid);
const fr = inbox.data.requests.find((x) => x.user_id === author2.data.id);
if (fr) await api(`/api/friends/requests/${fr.id}/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: {} }, author1.sid);

console.log(JSON.stringify({
  users: { 阿墨: author1.data.id, 拾光酱: author2.data.id, 小夏: reader.data.id },
  free: a, paid: b, draft: draft.comicId,
  accounts: ["作者阿墨 / secret123", "拾光酱 / secret123", "读者小夏 / secret123"],
}, null, 2));
