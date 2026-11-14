/* 共享工具：API、顶栏、消息提示、购买弹窗 */

let apiToken = null; // Firebase ID token，由 firebase-auth.js 注入
window.setApiToken = (t) => { apiToken = t || null; };

async function req(path, opts = {}) {
  const r = await fetch(path, {
    credentials: "same-origin",
    ...opts,
    headers: { ...(opts.headers || {}), ...(apiToken ? { authorization: "Bearer " + apiToken } : {}) },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `请求失败 (${r.status})`);
  return data;
}
const apiPost = (p, b) => req(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) });
const apiPut = (p, b) => req(p, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) });
const apiDel = (p) => req(p, { method: "DELETE" });

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

const fmtPrice = (cents) => cents > 0 ? `¥${(cents / 100).toFixed(2)}` : "免费";

let ME = null; // {id, username} | null

/** Firebase 已配置时恢复浏览器端会话（拿到 Bearer + Cookie），未配置则零开销跳过 */
async function restoreFirebaseSession() {
  if (!window.FIREBASE_CONFIGURED?.()) return;
  try {
    const m = await import("/js/firebase-auth.js");
    await m.attach();
  } catch (e) {
    console.warn("[firebase] 初始化失败，已回退到 Cookie 登录：", e.message);
  }
}

async function initHeader(active) {
  await restoreFirebaseSession();
  ME = await req("/api/me");
  if (!ME.id) ME = null;
  const el = document.getElementById("topbar");
  el.innerHTML = `
    <a class="logo" href="/">漫<b>域</b> MangaZone</a>
    <nav>
      <a href="/" class="${active === "store" ? "active" : ""}">书城</a>
      <a href="/dashboard" class="${active === "dashboard" ? "active" : ""}">创作后台</a>
      ${ME ? `<a href="/friends" class="${active === "friends" ? "active" : ""}">好友<span id="nav-badge" class="nav-badge"></span></a>` : ""}
    </nav>
    <div class="spacer"></div>
    ${ME
      ? `<a class="who" href="/user?id=${ME.id}" title="我的主页">${esc(ME.username)}</a><button class="btn small" id="btn-logout">退出</button>`
      : `<a class="btn small" href="/login">登录 / 注册</a>`}`;
  const btn = document.getElementById("btn-logout");
  if (btn) btn.onclick = async () => {
    try { if (window.FIREBASE_CONFIGURED?.()) await (await import("/js/firebase-auth.js")).signOut(); } catch {}
    await req("/api/logout", { method: "POST" });
    location.href = "/";
  };
  if (ME) refreshIncomingBadge();
}

/** 顶栏“好友”红点：待处理申请数 */
async function refreshIncomingBadge() {
  const el = document.getElementById("nav-badge");
  if (!el || !ME) return;
  try {
    const { count } = await req("/api/friends/incoming/count");
    el.textContent = count > 0 ? (count > 99 ? "99+" : String(count)) : "";
  } catch { el.textContent = ""; }
}

/**
 * 好友操作按钮的 HTML（详情页/主页/搜索结果复用）。
 * rel: none | outgoing | incoming | friends | rejected | self
 */
function friendButtonHtml(userId, rel) {
  if (rel === "self") return "";
  const label = {
    none: "＋ 加好友",
    outgoing: "已发申请 · 等待通过",
    incoming: "接受好友申请",
    friends: "✓ 已是好友",
    rejected: "＋ 重新申请",
  }[rel] ?? "＋ 加好友";
  const cls = rel === "friends" ? "btn small" : (rel === "incoming" ? "btn small primary" : "btn small");
  return `<button class="${cls}" data-friend="${userId}" data-rel="${rel}">${label}</button>`;
}

/** 绑定 friendButtonHtml 生成的按钮行为；onChange 在操作成功后回调新关系 */
function bindFriendButtons(root = document, onChange) {
  root.querySelectorAll("[data-friend]").forEach((btn) => {
    btn.onclick = async () => {
      if (!ME) { needLogin(); return; }
      const uid = Number(btn.dataset.friend);
      const rel = btn.dataset.rel;
      btn.disabled = true;
      try {
        if (rel === "incoming") {
          const list = await req("/api/friends/requests");
          const row = list.requests.find((r) => r.user_id === uid);
          if (!row) throw new Error("申请已被处理，请刷新页面");
          await apiPost(`/api/friends/requests/${row.id}/accept`, {});
          toast("已接受，你们成为好友 🎉");
          onChange?.("friends");
        } else if (rel === "friends") {
          if (!confirm("确定删除这个好友吗？")) { btn.disabled = false; return; }
          await apiDel(`/api/friends/${uid}`);
          toast("已删除好友");
          onChange?.("none");
        } else {
          await apiPost("/api/friends/request", { userId: uid });
          toast("好友申请已发送，等待对方通过");
          onChange?.("outgoing");
        }
      } catch (e) {
        toast(e.message); btn.disabled = false;
      }
    };
  });
}

let toastTimer = null;
function toast(text, ms = 2500) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = "none"; }, ms);
}

/**
 * 弹出 mock 支付窗口，购买指定漫画。成功后返回 true。
 * 生产环境：此处应替换为支付宝收银台（下单 -> 跳转/唤起 -> 异步通知验签 -> 解锁）。
 */
async function purchaseDialog(comicId, comicTitle, amountCents) {
  const order = await apiPost("/api/orders", { comicId });
  return await new Promise((resolve) => {
    const bg = document.createElement("div");
    bg.className = "modal-bg";
    bg.innerHTML = `
      <div class="modal">
        <h3>确认支付（模拟）</h3>
        <p class="muted">${esc(comicTitle)}</p>
        <p style="font-size:26px;color:var(--warn);margin:6px 0">${fmtPrice(order.amount_cents)}</p>
        <p class="muted" style="font-size:12px">原型演示：本按钮模拟支付宝收款成功，未接入真实支付。</p>
        <div class="row" style="margin-top:16px">
          <button class="btn primary grow" id="do-pay">模拟支付成功</button>
          <button class="btn grow" id="do-cancel">取消</button>
        </div>
      </div>`;
    document.body.appendChild(bg);
    const close = (v) => { bg.remove(); resolve(v); };
    bg.querySelector("#do-cancel").onclick = () => close(false);
    bg.querySelector("#do-pay").onclick = async () => {
      const btn = bg.querySelector("#do-pay");
      btn.disabled = true; btn.textContent = "支付中…";
      try {
        await apiPost(`/api/orders/${order.orderId}/pay`, {});
        toast("支付成功，已解锁全部章节 🎉");
        close(true);
      } catch (e) { toast(e.message); close(false); }
    };
  });
}

/** 未登录则跳登录页，登录后回到当前页 */
function needLogin() {
  if (ME && ME.id) return true;
  location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search);
  return false;
}
