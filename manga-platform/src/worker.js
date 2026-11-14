/**
 * 漫画平台 Worker API
 * 路由前缀 /api/*，其余路径由静态资源(assets)处理。
 *
 * 登录态两种来源，任选其一：
 *   1) Authorization: Bearer <Firebase ID token> —— 新方式，见 src/firebase.js
 *   2) Cookie: sid=<token>                      —— 旧自建会话，仍保留兼容
 */

import { verifyFirebaseIdToken, inspectToken } from "./firebase.js";

const PREVIEW_PAGES = 3; // 付费漫画每章可免费试读的页数
const SESSION_DAYS = 30;
const MAX_DANMAKU_LEN = 100;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/avif",
]);

// ---------- 小工具 ----------

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

const err = (msg, status = 400) => json({ error: msg }, status);

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = hexToBuf(saltHex);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 150_000, hash: "SHA-256" },
    key, 256
  );
  return bufToHex(bits);
}

const hexToBuf = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const bufToHex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

function sessionCookie(token, maxAgeDays = SESSION_DAYS) {
  const maxAge = maxAgeDays > 0 ? maxAgeDays * 86400 : 0;
  return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

async function parseBody(request) {
  try { return await request.json(); } catch { return null; }
}

// ---------- 会话 / 鉴权 ----------

/** Bearer Firebase ID token -> 本地 users 行；无 token 或校验失败返回 null */
async function userFromBearer(request, env) {
  const authz = request.headers.get("authorization") || "";
  if (!/^Bearer /i.test(authz)) return null;
  const token = authz.replace(/^Bearer /i, "").trim();
  if (!token || !env.FIREBASE_PROJECT_ID) return null;
  let claims;
  try {
    claims = await verifyFirebaseIdToken(token, env.FIREBASE_PROJECT_ID);
  } catch (e) {
    console.warn(`[auth] bearer 校验失败: ${e.code || e.message}`);
    return null;
  }
  const row = await env.DB.prepare(
    "SELECT id, username, provider FROM users WHERE firebase_uid = ?"
  ).bind(claims.sub).first();
  if (!row) return null; // 已验签但未建档：需先调用 POST /api/auth/firebase
  return { ...row, token: null, firebase: claims };
}

async function currentUser(request, env) {
  const viaBearer = await userFromBearer(request, env);
  if (viaBearer) return viaBearer;
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)sid=([0-9a-f]{64})/);
  if (!m) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.provider, s.token, s.expires_at FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.token = ?`
  ).bind(m[1]).first();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(m[1]).run();
    return null;
  }
  return row;
}

/** 匿名 Firebase 账号只允许浏览，不得产生内容或社交关系 */
const ANON_FORBIDDEN = () => err("匿名账号仅可浏览，请用邮箱或 Google 注册后再操作", 403);
function requireRealUser(user) {
  return user && user.provider === "anonymous" ? ANON_FORBIDDEN() : null;
}

async function createSession(env, userId) {
  const token = randomHex(32);
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(token, userId, Date.now() + SESSION_DAYS * 86400_000).run();
  return token;
}

// ---------- 权限检查 ----------

async function getComicWithAccess(env, comicId, user) {
  const comic = await env.DB.prepare("SELECT * FROM comics WHERE id = ?").bind(comicId).first();
  if (!comic) return null;
  let unlocked = comic.price_cents <= 0;
  if (!unlocked && user && user.id === comic.owner_id) unlocked = true;
  if (!unlocked && user) {
    const u = await env.DB.prepare("SELECT 1 FROM unlocks WHERE user_id = ? AND comic_id = ?")
      .bind(user.id, comicId).first();
    unlocked = !!u;
  }
  const isOwner = !!(user && user.id === comic.owner_id);
  return { comic, unlocked, isOwner };
}

async function requireOwnerOfComic(env, user, comicId) {
  if (!user) return { e: err("需要登录", 401) };
  const comic = await env.DB.prepare("SELECT * FROM comics WHERE id = ?").bind(comicId).first();
  if (!comic) return { e: err("漫画不存在", 404) };
  if (comic.owner_id !== user.id) return { e: err("只有作者可以操作自己的漫画", 403) };
  return { comic };
}

async function requireOwnerOfChapter(env, user, chapterId) {
  if (!user) return { e: err("需要登录", 401) };
  const ch = await env.DB.prepare(
    "SELECT ch.*, c.owner_id FROM chapters ch JOIN comics c ON c.id = ch.comic_id WHERE ch.id = ?"
  ).bind(chapterId).first();
  if (!ch) return { e: err("章节不存在", 404) };
  if (ch.owner_id !== user.id) return { e: err("只有作者可以操作", 403) };
  return { chapter: ch };
}

/**
 * 关系批量查询：返回 { [userId]: 'friends' | 'outgoing' | 'incoming' | 'rejected' | 'none' }
 * friends  = 任一方向已 accepted（单向申请被同意即成为好友）
 * outgoing = 我发出的待处理申请
 * incoming = 对方发出的待处理申请
 */
async function relationshipsFor(env, meId, otherIds) {
  const out = {};
  const ids = [...new Set(otherIds.filter((x) => x && x !== meId))];
  if (!meId || ids.length === 0) return out;
  const ph = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT requester_id, addressee_id, status FROM friend_requests
     WHERE (requester_id IN (${ph}) AND addressee_id = ?)
        OR (requester_id = ? AND addressee_id IN (${ph}))`
  ).bind(...ids, meId, meId, ...ids).all();
  // 以“我”为原点标注方向：out = 我发出的，in = 对方发出的
  const seen = new Map();
  for (const r of results) {
    const other = r.requester_id === meId ? r.addressee_id : r.requester_id;
    const dir = r.requester_id === meId ? "out" : "in";
    const cur = seen.get(other) || [];
    cur.push(`${dir}:${r.status}`);
    seen.set(other, cur);
  }
  for (const id of ids) {
    const s = seen.get(id);
    if (!s) continue;
    if (s.includes("out:accepted") || s.includes("in:accepted")) out[id] = "friends";
    else if (s.includes("in:pending")) out[id] = "incoming";
    else if (s.includes("out:pending")) out[id] = "outgoing";
    else if (s.includes("out:rejected") || s.includes("in:rejected")) out[id] = "rejected";
  }
  return out;
}

const FRIEND_ERR = {
  self: () => err("不能添加自己为好友", 400),
  exists: () => err("好友关系已存在", 409),
  pending: () => err("申请已发出，等待对方处理", 409),
  notFound: () => err("用户不存在", 404),
  noRow: () => err("申请不存在或已处理", 404),
  forbidden: () => err("无权处理这条申请", 403),
};

// ---------- 上传处理 ----------

async function readImages(form, env, field = "files") {
  const entries = form.getAll(field).filter((f) => f instanceof File && f.size > 0);
  if (entries.length === 0) return { e: err("没有收到文件") };
  if (entries.length > 100) return { e: err("单次最多上传 100 张") };
  const maxBytes = Number(env.MAX_UPLOAD_MB || 10) * 1024 * 1024;
  for (const f of entries) {
    if (!ALLOWED_IMAGE_TYPES.has(f.type)) return { e: err(`不支持的文件类型: ${f.type || f.name}`) };
    if (f.size > maxBytes) return { e: err(`文件 ${f.name} 超过 ${env.MAX_UPLOAD_MB || 10}MB 限制`) };
  }
  return { files: entries };
}

async function putImage(env, key, file) {
  await env.BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type, cacheControl: "private, no-store" },
  });
  return key;
}

// ---------- API 路由 ----------

const routes = [
  // ===== 账号 =====
  ["POST", /^\/api\/register$/, async (c, env) => {
    const body = await parseBody(c.req);
    if (!body) return err("需要 JSON body");
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!/^[\w\p{Script=Han}.\-]{2,30}$/u.test(username)) return err("用户名需 2-30 个字符（文字/数字/_-.）");
    if (password.length < 6) return err("密码至少 6 位");
    const exists = await env.DB.prepare("SELECT 1 FROM users WHERE username = ?").bind(username).first();
    if (exists) return err("用户名已被占用", 409);
    const salt = randomHex(16);
    const hash = await hashPassword(password, salt);
    const { meta } = await env.DB.prepare("INSERT INTO users (username, pass_hash, pass_salt) VALUES (?, ?, ?)")
      .bind(username, hash, salt).run();
    const token = await createSession(env, meta.last_row_id);
    return json({ id: meta.last_row_id, username }, 201, { "set-cookie": sessionCookie(token) });
  }],

  ["POST", /^\/api\/login$/, async (c, env) => {
    const body = await parseBody(c.req);
    if (!body) return err("需要 JSON body");
    const user = await env.DB.prepare("SELECT * FROM users WHERE username = ?")
      .bind(String(body.username || "").trim()).first();
    if (!user) return err("用户名或密码错误", 401);
    const hash = await hashPassword(String(body.password || ""), user.pass_salt);
    if (hash !== user.pass_hash) return err("用户名或密码错误", 401);
    const token = await createSession(env, user.id);
    return json({ id: user.id, username: user.username }, 200, { "set-cookie": sessionCookie(token) });
  }],

  ["POST", /^\/api\/logout$/, async (c, env, user) => {
    if (user?.token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(user.token).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }],

  ["GET", /^\/api\/me$/, async (c, env, user) =>
    json(user
      ? { id: user.id, username: user.username, provider: user.provider || "password", anonymous: user.provider === "anonymous" }
      : { id: null })],

  // ===== Firebase 登录：验签 + 本地账号建档 =====
  ["POST", /^\/api\/auth\/firebase$/, async (c, env) => {
    const projectId = env.FIREBASE_PROJECT_ID;
    if (!projectId) return err("服务端未配置 FIREBASE_PROJECT_ID", 501);
    const body = await parseBody(c.req) || {};
    const token = String(body.token || "");
    let claims;
    try {
      claims = await verifyFirebaseIdToken(token, projectId);
    } catch (e) {
      return err(`登录凭证校验失败：${e.message}`, 401);
    }
    const provider = claims.firebase?.sign_in_provider || "password";
    let row = await env.DB.prepare("SELECT * FROM users WHERE firebase_uid = ?").bind(claims.sub).first();
    let created = false;
    if (!row) {
      created = true;
      const email = typeof claims.email === "string" ? claims.email : null;
      const base = (email ? email.split("@")[0] : (claims.name || `漫友${claims.sub.slice(0, 6)}`))
        .replace(/[^\w\p{Script=Han}.\-]/gu, "").slice(0, 24) || `漫友${claims.sub.slice(0, 6)}`;
      const salt = randomHex(16); // 占位：Firebase 账号不走本地口令校验
      let username = base;
      for (let i = 0; i < 50; i++) {
        const taken = await env.DB.prepare("SELECT 1 FROM users WHERE username = ?").bind(username).first();
        if (!taken) break;
        username = `${base}-${randomHex(2)}`;
      }
      const { meta } = await env.DB.prepare(
        `INSERT INTO users (username, pass_hash, pass_salt, firebase_uid, email, display_name, provider)
         VALUES (?, '', ?, ?, ?, ?, ?)`)
        .bind(username, salt, claims.sub, email, claims.name || null, provider).run();
      row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(meta.last_row_id).first();
    } else if (row.provider !== provider || row.email !== (claims.email ?? null)) {
      await env.DB.prepare("UPDATE users SET provider = ?, email = COALESCE(?, email) WHERE id = ?")
        .bind(provider, claims.email ?? null, row.id).run();
    }
    const sid = await createSession(env, row.id);
    return json(
      { id: row.id, username: row.username, provider, anonymous: provider === "anonymous", created },
      200, { "set-cookie": sessionCookie(sid) }
    );
  }],

  // 前端据此判断服务端是否已启用 Firebase（未启用时可回退到自建登录）
  ["GET", /^\/api\/auth\/firebase\/config$/, async (c, env) =>
    json({ enabled: !!env.FIREBASE_PROJECT_ID, projectId: env.FIREBASE_PROJECT_ID || null })],

  // ===== 漫画浏览 =====
  ["GET", /^\/api\/comics$/, async (c, env, user) => {
    const mine = new URL(c.req.url).searchParams.get("mine");
    const sql = `
      SELECT c.*, u.username AS owner_name,
        (SELECT COUNT(*) FROM chapters ch WHERE ch.comic_id = c.id) AS chapter_count,
        COALESCE(c.cover_key,
          (SELECT p.r2_key FROM pages p JOIN chapters ch ON ch.id = p.chapter_id
           WHERE ch.comic_id = c.id ORDER BY ch.num, p.idx LIMIT 1)) AS cover
      FROM comics c JOIN users u ON u.id = c.owner_id
      ${mine && user ? "WHERE c.owner_id = ?" : "WHERE c.published = 1"}
      ORDER BY c.created_at DESC, c.id DESC`;
    const stmt = env.DB.prepare(sql);
    const { results } = await (mine && user ? stmt.bind(user.id) : stmt).all();
    return json({ comics: results });
  }],

  ["GET", /^\/api\/comics\/(\d+)$/, async (c, env, user, m) => {
    const acc = await getComicWithAccess(env, Number(m[1]), user);
    if (!acc) return err("漫画不存在", 404);
    if (!acc.comic.published && !acc.isOwner) return err("漫画不存在", 404);
    const { results: chapters } = await env.DB.prepare(
      "SELECT id, num, title, (SELECT COUNT(*) FROM pages p WHERE p.chapter_id = ch.id) AS page_count FROM chapters ch WHERE comic_id = ? ORDER BY num")
      .bind(acc.comic.id).all();
    const owner = await env.DB.prepare("SELECT id, username FROM users WHERE id = ?")
      .bind(acc.comic.owner_id).first();
    const rel = await relationshipsFor(env, user?.id, [owner?.id]);
    return json({
      comic: acc.comic, owner, chapters,
      ownerRelationship: rel[owner?.id] ?? "none",
      unlocked: acc.unlocked, isOwner: acc.isOwner, previewPages: PREVIEW_PAGES,
    });
  }],

  // ===== 作者：漫画 CRUD =====
  ["POST", /^\/api\/comics$/, async (c, env, user) => {
    if (!user) return err("需要登录", 401);
      { const g = requireRealUser(user); if (g) return g; }
    const body = await parseBody(c.req) || {};
    const title = String(body.title || "").trim();
    if (!title || title.length > 80) return err("标题需 1-80 字符");
    const price = Math.max(0, Math.floor(Number(body.price_cents) || 0));
    const published = body.published === false ? 0 : 1;
    const { meta } = await env.DB.prepare(
      "INSERT INTO comics (owner_id, title, description, price_cents, published) VALUES (?, ?, ?, ?, ?)")
      .bind(user.id, title, String(body.description || "").slice(0, 2000), price, published).run();
    return json({ id: meta.last_row_id }, 201);
  }],

  ["PUT", /^\/api\/comics\/(\d+)$/, async (c, env, user, m) => {
    const r = await requireOwnerOfComic(env, user, Number(m[1]));
    if (r.e) return r.e;
    const body = await parseBody(c.req) || {};
    const title = body.title !== undefined ? String(body.title).trim() : r.comic.title;
    if (!title || title.length > 80) return err("标题需 1-80 字符");
    const desc = body.description !== undefined ? String(body.description).slice(0, 2000) : r.comic.description;
    const price = body.price_cents !== undefined ? Math.max(0, Math.floor(Number(body.price_cents) || 0)) : r.comic.price_cents;
    const published = body.published !== undefined ? (body.published ? 1 : 0) : r.comic.published;
    await env.DB.prepare("UPDATE comics SET title=?, description=?, price_cents=?, published=? WHERE id=?")
      .bind(title, desc, price, published, r.comic.id).run();
    return json({ ok: true });
  }],

  ["DELETE", /^\/api\/comics\/(\d+)$/, async (c, env, user, m) => {
    const r = await requireOwnerOfComic(env, user, Number(m[1]));
    if (r.e) return r.e;
    await deleteComicCascade(env, r.comic.id);
    return json({ ok: true });
  }],

  ["POST", /^\/api\/comics\/(\d+)\/cover$/, async (c, env, user, m) => {
    const r = await requireOwnerOfComic(env, user, Number(m[1]));
    if (r.e) return r.e;
    const form = await c.req.formData();
    const files = form.getAll("file").filter((f) => f instanceof File && f.size > 0);
    if (files.length !== 1) return err("需要 1 个封面文件");
    const one = await readImages({ getAll: () => files }, env);
    if (one.e) return one.e;
    if (r.comic.cover_key) await env.BUCKET.delete(r.comic.cover_key);
    const key = `c${r.comic.id}/cover/${Date.now()}-${randomHex(4)}`;
    await putImage(env, key, one.files[0]);
    await env.DB.prepare("UPDATE comics SET cover_key=? WHERE id=?").bind(key, r.comic.id).run();
    return json({ cover_key: key });
  }],

  // ===== 作者：章节 =====
  ["POST", /^\/api\/comics\/(\d+)\/chapters$/, async (c, env, user, m) => {
    const r = await requireOwnerOfComic(env, user, Number(m[1]));
    if (r.e) return r.e;
    const body = await parseBody(c.req) || {};
    const { meta } = await env.DB.prepare(
      "INSERT INTO chapters (comic_id, num, title) VALUES (?, (SELECT COALESCE(MAX(num),0)+1 FROM chapters WHERE comic_id = ?), ?)")
      .bind(r.comic.id, r.comic.id, String(body.title || "").slice(0, 80)).run();
    return json({ id: meta.last_row_id }, 201);
  }],

  ["DELETE", /^\/api\/chapters\/(\d+)$/, async (c, env, user, m) => {
    const r = await requireOwnerOfChapter(env, user, Number(m[1]));
    if (r.e) return r.e;
    await deleteChapterCascade(env, r.chapter.id);
    return json({ ok: true });
  }],

  // ===== 作者：页面上传 =====
  ["POST", /^\/api\/chapters\/(\d+)\/pages$/, async (c, env, user, m) => {
    const r = await requireOwnerOfChapter(env, user, Number(m[1]));
    if (r.e) return r.e;
    let form;
    try { form = await c.req.formData(); } catch { return err("multipart 解析失败"); }
    const files = await readImages(form, env);
    if (files.e) return files.e;
    const max = await env.DB.prepare("SELECT COALESCE(MAX(idx), -1) AS mx FROM pages WHERE chapter_id = ?")
      .bind(r.chapter.id).first();
    let idx = max.mx + 1;
    const added = [];
    for (const f of files.files) {
      const ext = (f.name.split(".").pop() || "img").toLowerCase().slice(0, 8);
      const key = `c${r.chapter.comic_id}/ch${r.chapter.id}/p${idx}-${Date.now()}-${randomHex(4)}.${ext}`;
      await putImage(env, key, f);
      await env.DB.prepare("INSERT INTO pages (chapter_id, idx, r2_key) VALUES (?, ?, ?)")
        .bind(r.chapter.id, idx, key).run();
      added.push({ idx, r2_key: key });
      idx++;
    }
    return json({ added: added.length, pages: added }, 201);
  }],

  ["DELETE", /^\/api\/pages\/(\d+)$/, async (c, env, user, m) => {
    const page = await env.DB.prepare(
      "SELECT p.*, c.owner_id FROM pages p JOIN chapters ch ON ch.id = p.chapter_id JOIN comics c ON c.id = ch.comic_id WHERE p.id = ?")
      .bind(Number(m[1])).first();
    if (!user) return err("需要登录", 401);
    if (!page) return err("页面不存在", 404);
    if (page.owner_id !== user.id) return err("只有作者可以操作", 403);
    await env.BUCKET.delete(page.r2_key);
    await env.DB.prepare("DELETE FROM pages WHERE id = ?").bind(page.id).run();
    return json({ ok: true });
  }],

  // ===== 阅读器 =====
  ["GET", /^\/api\/chapters\/(\d+)\/reader$/, async (c, env, user, m) => {
    const ch = await env.DB.prepare(
      "SELECT ch.*, c.title AS comic_title, c.price_cents, c.owner_id FROM chapters ch JOIN comics c ON c.id = ch.comic_id WHERE ch.id = ?")
      .bind(Number(m[1])).first();
    if (!ch) return err("章节不存在", 404);
    const acc = await getComicWithAccess(env, ch.comic_id, user);
    const { results: pages } = await env.DB.prepare("SELECT id, idx, r2_key FROM pages WHERE chapter_id = ? ORDER BY idx").bind(ch.id).all();
    const canSee = (p) => acc.unlocked || acc.isOwner || p.idx < PREVIEW_PAGES;
    return json({
      chapter: { id: ch.id, num: ch.num, title: ch.title, comic_id: ch.comic_id, comic_title: ch.comic_title },
      unlocked: acc.unlocked, isOwner: acc.isOwner, price_cents: ch.price_cents,
      pages: pages.map((p) => ({
        id: p.id, idx: p.idx,
        url: canSee(p) ? `/api/img/${p.r2_key}` : null,
        locked: !canSee(p),
      })),
    });
  }],

  // ===== 图片（鉴权 + 防缓存）=====
  ["GET", /^\/api\/img\/(.+)$/, async (c, env, user, m) => {
    const key = decodeURIComponent(m[1]);
    const page = await env.DB.prepare(
      `SELECT p.idx, ch.id AS chapter_id, c.id AS comic_id, c.owner_id, c.price_cents
       FROM pages p JOIN chapters ch ON ch.id = p.chapter_id JOIN comics c ON c.id = ch.comic_id
       WHERE p.r2_key = ?`).bind(key).first();
    if (page) {
      const acc = await getComicWithAccess(env, page.comic_id, user);
      if (!(acc.unlocked || acc.isOwner || page.idx < PREVIEW_PAGES)) return err("需要购买后查看", 403);
    } else {
      const cover = await env.DB.prepare("SELECT id FROM comics WHERE cover_key = ?").bind(key).first();
      if (!cover) return err("图片不存在", 404); // 封面公开可看
    }
    const obj = await env.BUCKET.get(key);
    if (!obj) return err("图片不存在", 404);
    return new Response(obj.body, {
      headers: {
        "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }],

  // ===== 弹幕 =====
  ["GET", /^\/api\/danmaku$/, async (c, env, user) => {
    const u = new URL(c.req.url).searchParams;
    const chId = Number(u.get("chapterId"));
    const pageIdx = Number(u.get("pageIdx"));
    if (!chId || Number.isNaN(pageIdx)) return err("需要 chapterId 和 pageIdx");
    const { results } = await env.DB.prepare(
      `SELECT d.id, d.t_ms, d.text, w.username FROM danmaku d
       LEFT JOIN users w ON w.id = d.user_id
       WHERE d.chapter_id = ? AND d.page_idx = ? ORDER BY d.t_ms LIMIT 500`)
      .bind(chId, pageIdx).all();
    return json({ danmaku: results });
  }],

  ["POST", /^\/api\/danmaku$/, async (c, env, user) => {
    if (!user) return err("需要登录后发送弹幕", 401);
      { const g = requireRealUser(user); if (g) return g; }
    const body = await parseBody(c.req) || {};
    const text = String(body.text || "").trim().slice(0, MAX_DANMAKU_LEN);
    if (!text) return err("弹幕内容不能为空");
    const chId = Number(body.chapterId);
    const pageIdx = Number(body.pageIdx);
    const tMs = Math.max(0, Math.floor(Number(body.tMs) || 0));
    const ch = await env.DB.prepare("SELECT 1 FROM chapters WHERE id = ?").bind(chId).first();
    if (!ch) return err("章节不存在", 404);
    const { meta } = await env.DB.prepare(
      "INSERT INTO danmaku (chapter_id, page_idx, t_ms, user_id, text) VALUES (?, ?, ?, ?, ?)")
      .bind(chId, pageIdx, tMs, user.id, text).run();
    return json({ id: meta.last_row_id, text }, 201);
  }],

  // ===== 好友 =====
  ["POST", /^\/api\/friends\/request$/, async (c, env, user) => {
    if (!user) return err("需要登录", 401);
      { const g = requireRealUser(user); if (g) return g; }
    const body = await parseBody(c.req) || {};
    const to = Math.floor(Number(body.userId));
    if (!to) return err("缺少 userId");
    if (to === user.id) return FRIEND_ERR.self();
    const target = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(to).first();
    if (!target) return FRIEND_ERR.notFound();
    const mine = await env.DB.prepare("SELECT * FROM friend_requests WHERE requester_id = ? AND addressee_id = ?")
      .bind(user.id, to).first();
    if (mine?.status === "accepted") return FRIEND_ERR.exists();
    if (mine) {
      await env.DB.prepare("UPDATE friend_requests SET status='pending', updated_at=datetime('now') WHERE id = ?")
        .bind(mine.id).run();
    } else {
      await env.DB.prepare("INSERT INTO friend_requests (requester_id, addressee_id) VALUES (?, ?)")
        .bind(user.id, to).run();
    }
    return json({ ok: true, sent: true }, 201);
  }],

  ["GET", /^\/api\/friends$/, async (c, env, user) => {
    if (!user) return err("需要登录", 401);
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.username, MIN(f.updated_at) AS since
       FROM friend_requests f JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
       WHERE (f.requester_id = ? OR f.addressee_id = ?) AND f.status = 'accepted'
       GROUP BY u.id ORDER BY since DESC LIMIT 500`)
      .bind(user.id, user.id, user.id).all();
    return json({ friends: results });
  }],

  ["GET", /^\/api\/friends\/requests$/, async (c, env, user) => {
    if (!user) return err("需要登录", 401);
    const dir = new URL(c.req.url).searchParams.get("dir") === "outgoing" ? "outgoing" : "incoming";
    const col = dir === "incoming" ? "addressee_id" : "requester_id";
    const other = dir === "incoming" ? "requester_id" : "addressee_id";
    const { results } = await env.DB.prepare(
      `SELECT f.id, f.status, f.created_at, u.id AS user_id, u.username
       FROM friend_requests f JOIN users u ON u.id = f.${other}
       WHERE f.${col} = ? AND f.status = 'pending' ORDER BY f.id DESC LIMIT 200`)
      .bind(user.id).all();
    return json({ dir, requests: results });
  }],

  ["GET", /^\/api\/friends\/incoming\/count$/, async (c, env, user) => {
    if (!user) return json({ count: 0 });
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM friend_requests WHERE addressee_id = ? AND status = 'pending'")
      .bind(user.id).first();
    return json({ count: row.n });
  }],

  ["POST", /^\/api\/friends\/requests\/(\d+)\/accept$/, async (c, env, user, m) => {
    if (!user) return err("需要登录", 401);
    const req_ = await env.DB.prepare("SELECT * FROM friend_requests WHERE id = ?").bind(Number(m[1])).first();
    if (!req_) return FRIEND_ERR.noRow();
    if (req_.addressee_id !== user.id) return FRIEND_ERR.forbidden();
    if (req_.status === "accepted") return json({ ok: true, already: true });
    await env.DB.batch([
      env.DB.prepare("UPDATE friend_requests SET status='accepted', updated_at=datetime('now') WHERE id = ?").bind(req_.id),
      // 我此前发给对方的申请自动一并通过 -> 立即成为好友
      env.DB.prepare("UPDATE friend_requests SET status='accepted', updated_at=datetime('now') WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'")
        .bind(user.id, req_.requester_id),
    ]);
    return json({ ok: true, friend: true });
  }],

  ["POST", /^\/api\/friends\/requests\/(\d+)\/reject$/, async (c, env, user, m) => {
    if (!user) return err("需要登录", 401);
    const req_ = await env.DB.prepare("SELECT * FROM friend_requests WHERE id = ?").bind(Number(m[1])).first();
    if (!req_) return FRIEND_ERR.noRow();
    if (req_.addressee_id !== user.id) return FRIEND_ERR.forbidden();
    await env.DB.prepare("UPDATE friend_requests SET status='rejected', updated_at=datetime('now') WHERE id = ?")
      .bind(req_.id).run();
    return json({ ok: true });
  }],

  ["DELETE", /^\/api\/friends\/(\d+)$/, async (c, env, user, m) => {
    if (!user) return err("需要登录", 401);
    const other = Number(m[1]);
    // 只清掉已成立与进行中的关系；rejected 行保留（否则抹掉“被拒绝”这一事实）
    const isFriend = await env.DB.prepare(
      `SELECT 1 AS x FROM friend_requests WHERE status = 'accepted'
         AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`)
      .bind(user.id, other, other, user.id).first();
    if (!isFriend) return err("你们还不是好友", 404);
    const { meta } = await env.DB.prepare(
      `DELETE FROM friend_requests
       WHERE status IN ('accepted', 'pending')
         AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`)
      .bind(user.id, other, other, user.id).run();
    return json({ ok: true, removed: meta.changes });
  }],

  ["GET", /^\/api\/users\/search$/, async (c, env, user) => {
    const q = String(new URL(c.req.url).searchParams.get("q") || "").trim();
    if (q.length < 1) return err("请输入搜索关键词");
    if (q.length > 30) return err("关键词过长");
    const like = `%${q.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`;
    const { results } = await env.DB.prepare(
      `SELECT id, username,
         (SELECT COUNT(*) FROM comics c WHERE c.owner_id = u.id AND c.published = 1) AS comic_count
       FROM users u WHERE username LIKE ? ESCAPE '\\' ORDER BY username LIMIT 20`)
      .bind(like).all();
    const rel = await relationshipsFor(env, user?.id, results.map((u) => u.id));
    return json({ users: results.map((u) => ({ ...u, relationship: u.id === user?.id ? "self" : (rel[u.id] ?? "none") })) });
  }],

  ["GET", /^\/api\/users\/(\d+)$/, async (c, env, user, m) => {
    const id = Number(m[1]);
    const profile = await env.DB.prepare("SELECT id, username, created_at FROM users WHERE id = ?").bind(id).first();
    if (!profile) return err("用户不存在", 404);
    const { results: comics } = await env.DB.prepare(
      `SELECT c.id, c.title, c.price_cents, c.cover_key,
         (SELECT COUNT(*) FROM chapters ch WHERE ch.comic_id = c.id) AS chapter_count,
         COALESCE(c.cover_key,
           (SELECT p.r2_key FROM pages p JOIN chapters ch ON ch.id = p.chapter_id
            WHERE ch.comic_id = c.id ORDER BY ch.num, p.idx LIMIT 1)) AS cover
       FROM comics c WHERE c.owner_id = ? AND c.published = 1 ORDER BY c.created_at DESC, c.id DESC`)
      .bind(id).all();
    const rel = await relationshipsFor(env, user?.id, [id]);
    return json({ user: profile, comics, relationship: id === user?.id ? "self" : (rel[id] ?? "none") });
  }],

  // ===== Mock 支付 =====
  ["POST", /^\/api\/orders$/, async (c, env, user) => {
    if (!user) return err("需要登录", 401);
      { const g = requireRealUser(user); if (g) return g; }
    const body = await parseBody(c.req) || {};
    const acc = await getComicWithAccess(env, Number(body.comicId), user);
    if (!acc) return err("漫画不存在", 404);
    if (acc.comic.price_cents <= 0) return err("该漫画免费");
    if (acc.unlocked) return err("已购买");
    const { meta } = await env.DB.prepare(
      "INSERT INTO orders (user_id, comic_id, amount_cents) VALUES (?, ?, ?)")
      .bind(user.id, acc.comic.id, acc.comic.price_cents).run();
    return json({ orderId: meta.last_row_id, amount_cents: acc.comic.price_cents, comicTitle: acc.comic.title }, 201);
  }],

  ["POST", /^\/api\/orders\/(\d+)\/pay$/, async (c, env, user, m) => {
    if (!user) return err("需要登录", 401);
    const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?")
      .bind(Number(m[1]), user.id).first();
    if (!order) return err("订单不存在", 404);
    if (order.status === "paid") return json({ ok: true, alreadyPaid: true });
    // Mock：直接标记支付成功并解锁（生产环境应替换为支付宝异步通知验签后解锁）
    await env.DB.batch([
      env.DB.prepare("UPDATE orders SET status='paid', paid_at=datetime('now') WHERE id=?").bind(order.id),
      env.DB.prepare("INSERT OR IGNORE INTO unlocks (user_id, comic_id) VALUES (?, ?)").bind(user.id, order.comic_id),
    ]);
    return json({ ok: true, unlocked: true });
  }],

  ["GET", /^\/api\/orders$/, async (c, env, user) => {
    if (!user) return err("需要登录", 401);
    const { results } = await env.DB.prepare(
      `SELECT o.id, o.amount_cents, o.status, o.created_at, c.title AS comic_title
       FROM orders o JOIN comics c ON c.id = o.comic_id WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 100`)
      .bind(user.id).all();
    return json({ orders: results });
  }],
];

// ---------- 级联删除 ----------

async function deleteChapterCascade(env, chapterId) {
  const { results: pages } = await env.DB.prepare("SELECT r2_key FROM pages WHERE chapter_id = ?").bind(chapterId).all();
  for (const p of pages) await env.BUCKET.delete(p.r2_key);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pages WHERE chapter_id = ?").bind(chapterId),
    env.DB.prepare("DELETE FROM danmaku WHERE chapter_id = ?").bind(chapterId),
    env.DB.prepare("DELETE FROM chapters WHERE id = ?").bind(chapterId),
  ]);
}

async function deleteComicCascade(env, comicId) {
  const { results: chs } = await env.DB.prepare("SELECT id FROM chapters WHERE comic_id = ?").bind(comicId).all();
  for (const ch of chs) await deleteChapterCascade(env, ch.id);
  const comic = await env.DB.prepare("SELECT cover_key FROM comics WHERE id = ?").bind(comicId).first();
  if (comic?.cover_key) await env.BUCKET.delete(comic.cover_key);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM orders WHERE comic_id = ?").bind(comicId),
    env.DB.prepare("DELETE FROM unlocks WHERE comic_id = ?").bind(comicId),
    env.DB.prepare("DELETE FROM comics WHERE id = ?").bind(comicId),
  ]);
}

// ---------- fetch 入口 ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith("/api/")) {
      // 交给静态资源（正常情况下 assets 层已处理，这里兜底 404）
      return env.ASSETS.fetch(request);
    }
    const user = await currentUser(request, env);
    for (const [method, pattern, handler] of routes) {
      if (request.method !== method) continue;
      const m = path.match(pattern);
      if (!m) continue;
      try {
        return await handler({ req: request }, env, user, m);
      } catch (e) {
        console.error(`[api] ${method} ${path}`, e);
        return err("服务器内部错误", 500);
      }
    }
    return err("接口不存在", 404);
  },
};
