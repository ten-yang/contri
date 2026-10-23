(() => {
"use strict";
const V = document.getElementById("view");
const DLG = document.getElementById("dlg");
const POLL_MS = 20000;
const BUILT_IN = ["Groceries","Dining","Lodging","Rent","Utilities","Travel","Transport","Shopping","Fun","Health","Other"];
const CURRENCIES = [["USD","USD $"],["INR","INR ₹"],["EUR","EUR €"],["GBP","GBP £"],["CAD","CAD $"]];
const MAX_RX = 4;

// The old app kept the passcode on the device. Profiles replace that.
try { localStorage.removeItem("contri.passcode"); localStorage.removeItem("contri.me"); } catch {}

const S = { user: undefined, home: null, g: {}, showCode: null, ui: {} };

/* ---------- helpers ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const uid = () => (Math.random().toString(36).slice(2, 10) + Date.now().toString(36)).replace(/[^a-z0-9]/g, "").slice(0, 24);
const initial = n => (String(n || "?").trim()[0] || "?").toUpperCase();
const toCents = v => Math.round(parseFloat(v || 0) * 100);
const fmtCache = {};
function fmt(c, cur = "USD", signed = false){
  const f = fmtCache[cur] || (fmtCache[cur] = new Intl.NumberFormat(undefined, { style: "currency", currency: cur }));
  const s = f.format(Math.abs(c) / 100);
  return signed ? (c > 0 ? "+" : c < 0 ? "−" : "") + s : (c < 0 ? "−" + s : s);
}
function curSymbol(cur){ try { return (0).toLocaleString(undefined, { style: "currency", currency: cur, minimumFractionDigits: 0 }).replace(/[\d\s.,]/g, "") || "$"; } catch { return "$"; } }
function ago(t){
  if (!t) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " hr ago";
  if (s < 2 * 86400) return "yesterday";
  if (s < 7 * 86400) return Math.floor(s / 86400) + " days ago";
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const shortDate = t => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const dot = (p, cls = "") => `<span class="dot ${cls}" style="background:${esc((p && p.color) || "#7a6f5c")}" aria-hidden="true">${esc(initial(p && p.name))}</span>`;
const ICON = {
  back: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>`,
  chev: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5f6b5c" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`,
  alert: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a8452a" stroke-width="2.4" stroke-linecap="round" aria-hidden="true" style="flex:none;margin-top:1px"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>`,
  info: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4f6146" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" style="flex:none;margin-top:2px"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.01"/></svg>`,
  key: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#4f6146" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3"/><path d="M17 6l3 3"/><path d="M15 8l2 2"/></svg>`,
  check: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>`,
  camera: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="15" rx="2"/><circle cx="12" cy="12.5" r="3.5"/><path d="M8 5l1.5-2h5L16 5"/></svg>`,
};
const backLink = (label, act = "back", extra = "") => `<button type="button" class="back" data-act="${act}" ${extra}>${ICON.back}${esc(label)}</button>`;

/* ---------- API ---------- */
class ApiError extends Error { constructor(status, msg, data){ super(msg); this.status = status; this.data = data || {}; } }
async function api(method, path, body){
  let res;
  try {
    res = await fetch(path, { method, cache: "no-store", credentials: "same-origin",
      headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new ApiError(0, "You're offline. Check your connection and try again."); }
  let data = {}; try { data = await res.json(); } catch {}
  if (!res.ok) throw new ApiError(res.status, data.error || "Something went wrong. Try again.", data);
  return data;
}
function handleErr(e, el){
  if (e.status === 401 && !(e.data && e.data.badLogin)){ S.user = null; S.home = null; S.g = {}; render(); toast("Please log in again."); return; }
  if (e.status === 403 && e.data && (e.data.needPasscode || e.data.notMember)){ const gid = route().gid; if (gid) delete S.g[gid]; render(); return; }
  if (el) el.textContent = e.message; else toast(e.message);
}

/* ---------- routing ---------- */
const SECTIONS = ["standing","activity","backup","settings","leave","expense","pay"];
function route(){
  const m = location.pathname.match(/^\/g\/([A-Za-z0-9]{10})(?:\/([a-z]+))?(?:\/([a-z0-9]+))?\/?$/);
  const st = history.state || {};
  if (m) return { gid: m[1], sec: SECTIONS.includes(m[2]) ? m[2] : "", id: m[3] || "", v: st.v || "", st };
  return { gid: "", sec: "", v: st.v || "", st };
}
function go(path, state = {}){
  history.pushState(state, "", path);
  S.ui = {};
  window.scrollTo(0, 0);
  render();
}
window.addEventListener("popstate", () => { S.ui = {}; render(); });

/* ---------- group data ---------- */
async function loadGroup(gid, quiet){
  const cur = S.g[gid];
  const q = quiet && cur && cur.version !== undefined ? `&v=${cur.version}` : "";
  const d = await api("GET", `/api/group?g=${encodeURIComponent(gid)}${q}`);
  if (d.unchanged) return false;
  if (d.people){
    d.byId = Object.fromEntries(d.people.map(p => [p.id, p]));
  }
  S.g[gid] = d;
  return true;
}
const G = () => S.g[route().gid];
const pOf = (g, id) => g.byId[id];
function pName(g, id, { former = false } = {}){
  const p = g.byId[id];
  if (!p) return "Someone";
  return p.name + (former && p.leftAt ? " (former member)" : "");
}
const isActive = p => p && !p.leftAt;               // in the group (joined or not yet)
const joined = p => p && p.uid && !p.leftAt;
function balances(g){
  const b = {}; const get = id => b[id] || (b[id] = { net: 0, paid: 0, share: 0 });
  g.people.forEach(p => { if (isActive(p)) get(p.id); });
  for (const e of g.entries){
    get(e.paidBy).net += e.amount;
    if (e.type !== "payment") get(e.paidBy).paid += e.amount;
    for (const [id, c] of Object.entries(e.split || {})){ get(id).net -= c; if (e.type !== "payment") get(id).share += c; }
  }
  return b;
}
function settlePlan(b){
  const cred = [], debt = [];
  for (const [id, v] of Object.entries(b)){ if (v.net > 0) cred.push({ id, c: v.net }); else if (v.net < 0) debt.push({ id, c: -v.net }); }
  cred.sort((a, z) => z.c - a.c || a.id.localeCompare(z.id)); debt.sort((a, z) => z.c - a.c || a.id.localeCompare(z.id));
  const out = []; let i = 0, j = 0;
  while (i < debt.length && j < cred.length){
    const x = Math.min(debt[i].c, cred[j].c);
    if (x > 0) out.push({ from: debt[i].id, to: cred[j].id, c: x });
    debt[i].c -= x; cred[j].c -= x;
    if (!debt[i].c) i++; if (!cred[j].c) j++;
  }
  return out;
}
const totalSpent = g => g.entries.filter(e => e.type !== "payment").reduce((s, e) => s + e.amount, 0);

/* ---------- render ---------- */
let rendering = 0;
async function render(){
  const my = ++rendering;
  const r = route();
  DLG.open && DLG.close();
  try {
    if (S.user === undefined){
      const d = await api("GET", "/api/auth");
      S.user = d.user;
    }
    if (my !== rendering) return;
    if (S.showCode) return paint(viewRecovery(), "roomy");
    if (!S.user){
      if (r.v === "reset") return paint(viewReset());
      return paint(viewAuth(r), "roomy");
    }
    if (r.gid) return await renderGroup(r, my);
    switch (r.v){
      case "profile": return paint(viewProfile());
      case "create": return paint(viewCreate());
      case "joinlink": return paint(viewJoinLink());
    }
    if (!S.home || r.st.refresh !== false){
      S.home = await api("GET", "/api/home");
      if (my !== rendering) return;
    }
    paint(S.home.groups.length ? viewHome() : viewEmptyHome(), "", true);
  } catch (e){
    if (my !== rendering) return;
    if (e.status === 401){ S.user = null; return render(); }
    paint(viewError(e.message));
  }
}
async function renderGroup(r, my){
  if (!S.g[r.gid] || S.g[r.gid].invite || S.g[r.gid].needPasscode || r.st.fresh){
    try { await loadGroup(r.gid); }
    catch (e){ if (e.status === 404) return paint(viewError(e.message, true)); throw e; }
    if (my !== rendering) return;
  }
  const g = S.g[r.gid];
  if (g.needPasscode) return paint(viewPasscode(r.gid, g));
  if (g.invite) return paint(viewJoin(r.gid, g));
  document.title = `${g.meta.name} · Contri`;
  switch (r.sec){
    case "standing": return paint(viewStanding(g), "", true);
    case "activity": return paint(viewActivity(g), "", true);
    case "backup": return paint(viewBackup(g));
    case "settings": return paint(viewSettings(g));
    case "leave": return paint(viewLeave(g));
    case "expense": return paint(viewExpense(g, r.id), "", false, () => bindExpense(g, r.id));
    case "pay": return paint(viewPay(g, r.id, r.st), "", false, () => bindPay(g, r.id));
  }
  paint(viewGroup(g), "", true);
}
function paint(html, cls = "", wave = false, after){
  V.innerHTML = `<div class="page ${cls}">${html}</div>`;
  document.getElementById("wave").hidden = !wave;
  if (!route().gid) document.title = "Contri";
  if (after) after();
  const f = V.querySelector("[autofocus]"); if (f && matchMedia("(hover:hover)").matches) f.focus();
}
function viewError(msg, home){
  return `<div class="brand"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">Contri</span></div>
    <div class="card pad stack"><h2>Something's not right</h2><p class="muted">${esc(msg)}</p>
    <div class="row"><button class="btn" type="button" data-act="retry">Try again</button>${S.user ? `<button class="btn" type="button" data-act="home">Go to your groups</button>` : ""}</div></div>`;
}

/* ---------- auth screens ---------- */
function viewAuth(r){
  const tab = S.ui.tab || (r.st.tab) || "create";
  const invited = !!route().gid;
  const create = tab === "create";
  return `<div class="brand"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">Contri</span></div>
  <div class="stack tight">
    <h1 style="font-size:30px">${invited ? "You're invited" : create ? "Split shared costs, fairly" : "Welcome back"}</h1>
    <p class="muted">${invited ? "Create a profile or log in, and you'll go straight to the group." : create ? "Create a profile to keep all your groups in one place." : "Log in to see all your groups."}</p>
  </div>
  <div class="tabs" role="tablist">
    <button type="button" role="tab" aria-selected="${create}" data-act="tab" data-tab="create">Create profile</button>
    <button type="button" role="tab" aria-selected="${!create}" data-act="tab" data-tab="login">Log in</button>
  </div>
  <form class="stack" data-form="${create ? "signup" : "login"}" novalidate style="gap:16px">
    <div class="field"><label class="eyebrow" for="au">Username</label>
      <input id="au" name="username" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="20" required>
      ${create ? `<span class="hint" id="auHint">This is the name your groups will see.</span>` : ""}</div>
    <div class="field"><label class="eyebrow" for="ap">Password</label>
      <input id="ap" name="password" type="password" autocomplete="${create ? "new-password" : "current-password"}" minlength="8" required>
      ${create ? `<span class="hint">At least 8 characters.</span>` : ""}</div>
    ${create ? "" : `<button type="button" class="linkbtn" data-act="toReset" style="align-self:flex-start">Forgot password?</button>`}
    <div class="err" id="aErr" role="alert"></div>
    <button class="btn primary full" type="submit">${create ? "Create profile" : "Log in"}</button>
  </form>`;
}
function viewReset(){
  return `${backLink("Log in", "toLogin")}
  <h1>Reset your password</h1>
  <p class="muted" style="margin-top:-6px">Use the recovery code you saved when you made your profile.</p>
  <form class="stack" data-form="reset" novalidate style="gap:16px">
    <div class="field"><label class="eyebrow" for="ru">Username</label><input id="ru" name="username" type="text" autocomplete="username" autocapitalize="off" spellcheck="false"></div>
    <div class="field"><label class="eyebrow" for="rc">Recovery code</label><input id="rc" name="code" type="text" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX" style="font-family:var(--mono)"></div>
    <div class="field"><label class="eyebrow" for="rn">New password</label><input id="rn" name="password" type="password" autocomplete="new-password"><span class="hint">At least 8 characters.</span></div>
    <div class="card pad note">${ICON.info}<span>After this, you'll get a new recovery code. Your old one stops working.</span></div>
    <div class="err" id="rErr" role="alert"></div>
    <button class="btn primary full" type="submit">Set new password</button>
    <p class="hint">Lost both your password and recovery code? Make a new profile and rejoin your groups with their link and passcode.</p>
  </form>`;
}
function viewRecovery(){
  const c = S.showCode;
  return `<div style="width:56px;height:56px;border-radius:16px;background:var(--tint);display:grid;place-items:center">${ICON.key}</div>
  <div class="stack tight">
    <h1>${c.fresh ? "Save your recovery code" : "Your new recovery code"}</h1>
    <p class="muted">It's your spare key. If you ever forget your password, this code lets you set a new one. You'll only see it once.</p>
  </div>
  <div class="code"><span class="val" id="rcVal">${esc(c.code)}</span>
    <div class="row" style="width:100%"><button type="button" class="btn" style="flex:1" data-act="copyCode">Copy</button><button type="button" class="btn" style="flex:1" data-act="saveCode">Save as file</button></div>
  </div>
  ${c.fresh ? `<p class="small" style="color:var(--body2)">Lost both your password and this code? Make a new profile and rejoin your groups with their link and passcode.</p>` : ""}
  <label class="check" style="margin-top:auto"><input type="checkbox" id="rcOk"><span>I've saved my recovery code somewhere safe</span></label>
  <button type="button" class="btn primary full" data-act="codeDone" id="rcDone" disabled>Continue</button>`;
}

/* ---------- home ---------- */
function viewHome(){
  const u = S.user, gs = S.home.groups;
  const owed = {}, owe = {};
  for (const g of gs){ if (g.needPasscode || !g.net) continue; const t = g.net > 0 ? owed : owe; t[g.currency] = (t[g.currency] || 0) + Math.abs(g.net); }
  const lines = (t, cls) => Object.keys(t).length ? Object.entries(t).map(([c, v]) => `<span class="big">${fmt(v, c)}</span>`).join("") : `<span class="none">${fmt(0, gs[0] ? gs[0].currency : "USD")}</span>`;
  const multi = new Set(gs.filter(g => g.net).map(g => g.currency)).size > 1;
  const settles = gs.flatMap(g => (g.settles || []).map(s => ({ ...s, g })));
  return `<div class="topbar">
    <div class="row" style="gap:8px"><span class="brand-mark" style="width:28px;height:28px;border-radius:8px" aria-hidden="true"></span><span style="font-family:var(--display);font-weight:700;font-size:22px">Hi, ${esc(u.username)}</span></div>
    <button type="button" class="avatar" data-act="profile" aria-label="Your profile">${esc(initial(u.username))}</button>
  </div>
  <section class="card pad stack">
    <span class="eyebrow dash">Where you stand · all groups</span>
    <div class="grid2">
      <div class="ticket owed"><span class="small">You're owed</span>${lines(owed)}</div>
      <div class="ticket owe"><span class="small">You owe</span>${lines(owe)}</div>
    </div>
    ${multi ? `<span class="tiny muted">Each currency is totaled on its own, since amounts aren't converted.</span>` : ""}
  </section>
  ${settles.length ? `<section class="card pad stack" style="gap:10px">
    <div class="between"><h2>Settle up</h2><span class="tiny muted">${settles.length} payment${settles.length === 1 ? "" : "s"}</span></div>
    ${settles.map((s, i) => `<div class="sunkrow"><div class="grow"><span style="font-size:14px">${s.mine === "get" ? `<b>${esc(s.fromName)}</b> pays you` : `You pay <b>${esc(s.toName)}</b>`} <b class="num">${fmt(s.c, s.g.currency)}</b></span><span class="tiny muted">${esc(s.g.name)}</span></div>
      <button type="button" class="btn sm" data-act="homeSettle" data-i="${i}">Mark paid</button></div>`).join("")}
  </section>` : ""}
  <section class="stack tight" style="border-top:2px dashed var(--border);padding-top:12px">
    <h2 style="margin:0 2px">Your groups</h2>
    ${gs.map(g => `<a class="tile" href="/g/${esc(g.id)}" data-nav="/g/${esc(g.id)}">
      <span class="ini ${g.net < 0 ? "neg" : ""}">${esc(initial(g.name))}</span>
      <span class="grow"><b>${esc(g.name)}</b><span class="tiny muted">${g.needPasscode ? "Passcode changed: tap to enter the new one" : `${g.people} ${g.people === 1 ? "person" : "people"} · updated ${esc(ago(g.updated))}`}</span></span>
      ${g.needPasscode ? ICON.chev : `<span class="num ${g.net > 0 ? "pos" : g.net < 0 ? "neg" : "muted"}" style="font-weight:600;font-size:14px">${g.net ? fmt(g.net, g.currency, true) : "Settled"}</span>`}
    </a>`).join("")}
  </section>
  <div class="grid2" style="margin-top:auto">
    <button type="button" class="btn lg" data-act="joinlink">Join a group</button>
    <button type="button" class="btn primary lg" data-act="create">Create a group</button>
  </div>`;
}
function viewEmptyHome(){
  const u = S.user;
  return `<div class="topbar">
    <div class="row" style="gap:8px"><span class="brand-mark" style="width:28px;height:28px;border-radius:8px" aria-hidden="true"></span><span style="font-family:var(--display);font-weight:700;font-size:22px">Hi, ${esc(u.username)}</span></div>
    <button type="button" class="avatar" data-act="profile" aria-label="Your profile">${esc(initial(u.username))}</button>
  </div>
  <div class="stack center" style="margin-top:24px;align-items:center">
    <img class="illus" src="/assets/empty-groups.webp" alt="" width="600" height="500">
    <h1>No groups yet</h1>
    <p class="muted" style="max-width:320px">Start one for a trip, your flat, or a dinner out. Or open an invite link a friend sent you.</p>
  </div>
  <div class="stack tight" style="margin-top:auto">
    <button type="button" class="btn primary full" data-act="create">Create a group</button>
    <button type="button" class="btn lg full" data-act="joinlink">Join with a link</button>
  </div>`;
}
function viewJoinLink(){
  return `${backLink("Home", "home")}
  <h1>Join a group</h1>
  <p class="muted" style="margin-top:-6px">Paste the invite link a friend sent you. You'll need the group's passcode too.</p>
  <form class="stack" data-form="joinlink" novalidate>
    <div class="field"><label class="eyebrow" for="jl">Invite link</label><input id="jl" name="link" type="text" autocapitalize="off" spellcheck="false" placeholder="contri-hazel.vercel.app/g/…" autofocus></div>
    <div class="err" id="jlErr" role="alert"></div>
    <button class="btn primary full" type="submit">Continue</button>
  </form>`;
}

/* ---------- profile ---------- */
function viewProfile(){
  const u = S.user;
  const since = new Date(u.createdAt).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  const n = S.home ? S.home.groups.length : u.groups || 0;
  return `${backLink("Home", "home")}
  <div class="row" style="gap:14px">
    <span class="avatar big" aria-hidden="true">${esc(initial(u.username))}</span>
    <div class="stack" style="gap:2px"><span style="font-family:var(--display);font-size:26px;font-weight:700;overflow-wrap:anywhere">${esc(u.username)}</span>
      <span class="small muted">Member since ${esc(since)} · ${n} group${n === 1 ? "" : "s"}</span></div>
  </div>
  <section class="card menu">
    <button type="button" data-act="dlgUsername">Change username${ICON.chev}</button>
    <button type="button" data-act="dlgPassword">Change password${ICON.chev}</button>
    <button type="button" data-act="dlgRecovery"><span class="stack" style="gap:2px"><span>New recovery code</span><span class="tiny muted" style="font-weight:500">Replaces your old one</span></span>${ICON.chev}</button>
  </section>
  <section class="card menu">
    <button type="button" data-act="logout">Log out</button>
    <button type="button" data-act="dlgDelete" class="danger" style="min-height:64px"><span class="stack" style="gap:2px"><span>Delete profile</span><span class="tiny muted" style="font-weight:500">Your past expenses stay in groups as "Former member"</span></span></button>
  </section>`;
}
function openDialog(html, onSubmit){
  DLG.innerHTML = html;
  DLG.showModal();
  const form = DLG.querySelector("form");
  DLG.querySelectorAll("[data-close]").forEach(b => b.onclick = () => DLG.close());
  if (form && onSubmit) form.addEventListener("submit", async ev => {
    ev.preventDefault();
    const btn = form.querySelector("[type=submit]"); const err = form.querySelector(".err");
    err.textContent = ""; btn.disabled = true;
    try { await onSubmit(Object.fromEntries(new FormData(form)), err); }
    catch (e){ handleErr(e, err); }
    finally { btn.disabled = false; }
  });
  const f = DLG.querySelector("input"); if (f) f.focus();
}
const dlgShell = (title, body, submit, danger) => `<form novalidate><h2>${esc(title)}</h2>${body}<div class="err" role="alert"></div>
  <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn ${danger ? "danger" : "primary lg"}">${esc(submit)}</button></div></form>`;

/* ---------- create / join ---------- */
function viewCreate(){
  const done = S.ui.created;
  if (done) return `${backLink("Home", "home")}<h1>${esc(done.name)}</h1>
    <section class="card pad stack">
      <div class="row pos" style="gap:8px;font-weight:600;font-size:14px">${ICON.check}Group created. Invite your friends</div>
      <div class="mono-box"><span class="tiny muted">Private link</span><span class="num">${esc(inviteLink(done.g))}</span></div>
      <div class="mono-box"><span class="tiny muted">Passcode</span><span class="num" style="font-size:14px">${esc(done.passcode)}</span></div>
      <button type="button" class="btn lg" data-act="copyNewInvite">Copy invite message</button>
      <span class="hint">Friends need both the link and the passcode to join.</span>
    </section>
    <button type="button" class="btn primary full" style="margin-top:auto" data-nav="/g/${esc(done.g)}">Open ${esc(done.name)}</button>`;
  return `${backLink("Home", "home")}
  <h1>Create a group</h1>
  <form class="stack" data-form="create" novalidate style="gap:14px">
    <div class="field"><label class="eyebrow" for="gn">Group name</label><input id="gn" name="name" type="text" maxlength="60" placeholder="Flat 4B, Goa trip, Friday dinners" autofocus></div>
    <div class="field"><label class="eyebrow" for="gp">Group passcode</label><input id="gp" name="passcode" type="text" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="mango-rooftop-17">
      <span class="hint">Friends need this and the link to join. At least 6 characters.</span></div>
    <div class="field"><label class="eyebrow" for="gc">Money</label>
      <select id="gc" name="currency">${CURRENCIES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select>
      <span class="hint">One currency per group. Traveling somewhere new? Start a new group.</span></div>
    <div class="err" id="cErr" role="alert"></div>
    <button class="btn primary full" type="submit">Create group</button>
  </form>`;
}
const inviteLink = gid => `${location.origin}/g/${gid}`;
function viewJoin(gid, g){
  const inv = g.invite, ch = S.ui.choose;
  return `${backLink("Home", "home")}
  <div class="stack tight">
    <span class="eyebrow">You're invited to</span>
    <h1 style="font-size:30px">${esc(inv.name)}</h1>
    <span class="small muted">${inv.people} ${inv.people === 1 ? "person" : "people"} · signed in as <b style="color:var(--ink)">${esc(S.user.username)}</b></span>
  </div>
  <form class="stack" data-form="join" novalidate>
    <div class="field"><label class="eyebrow" for="jp">Group passcode</label>
      <input id="jp" name="passcode" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" ${ch ? "readonly" : "autofocus"} value="${esc(S.ui.pc || "")}"></div>
    ${ch ? `<section class="card pad stack" style="gap:10px">
      <h2>Which one is you?</h2>
      <p class="small muted">This group has names that aren't linked to a profile yet. Pick yours to keep your past expenses.</p>
      <div class="grid2" style="gap:8px">${ch.map(p => `<button type="button" class="choice" data-act="pick" data-id="${esc(p.id)}" aria-pressed="${S.ui.claim === p.id}">${dot(p, "sm")}<span style="overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</span></button>`).join("")}</div>
      <button type="button" class="choice" data-act="pick" data-id="new" aria-pressed="${S.ui.claim === "new"}" style="justify-content:center">I'm not on this list, join as new</button>
    </section>` : ""}
    <div class="err" id="jErr" role="alert"></div>
    <button class="btn primary full" type="submit" ${ch && !S.ui.claim ? "disabled" : ""}>${ch ? "Join group" : "Continue"}</button>
  </form>`;
}
function viewPasscode(gid, g){
  return `${backLink("All groups", "home")}
  <div class="stack tight"><span class="eyebrow">Passcode changed</span><h1>${esc(g.invite.name)}</h1>
  <p class="muted">The person who created this group changed its passcode. Enter the new one to keep going. Ask them if you don't have it.</p></div>
  <form class="stack" data-form="verify" novalidate>
    <div class="field"><label class="eyebrow" for="vp">New passcode</label><input id="vp" name="passcode" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" autofocus></div>
    <div class="err" id="vErr" role="alert"></div>
    <button class="btn primary full" type="submit">Open group</button>
  </form>`;
}

/* ---------- group ---------- */
function headerLine(g){
  const b = balances(g), mine = (b[g.me] || { net: 0 }).net;
  const n = g.people.filter(isActive).length;
  const st = mine > 0 ? `You're owed <b class="num pos">${fmt(mine, g.meta.currency)}</b>` : mine < 0 ? `You owe <b class="num neg">${fmt(-mine, g.meta.currency)}</b>` : "You're settled up";
  return `${n} ${n === 1 ? "person" : "people"} · ${st}`;
}
function rxChip(e){
  const ids = e.receipts || [];
  if (!ids.length) return "";
  const until = Math.min(...ids.map(id => (e.rxExp && e.rxExp[id]) || Date.now()));
  const days = Math.ceil((until - Date.now()) / 86400000);
  const label = ids.length === 1 ? "Receipt" : `${ids.length} photos`;
  if (days <= 0) return `<span class="chip gone">${label} deleted after 30 days</span>`;
  return `<span class="chip" role="button" tabindex="0" data-act="viewRx" data-id="${esc(e.id)}">${label} · deletes in ${days} day${days === 1 ? "" : "s"}</span>`;
}
function entryRow(g, e){
  const d = new Date((e.date || today()) + "T12:00:00");
  const cur = g.meta.currency;
  const sub = e.type === "payment"
    ? (e.note ? esc(e.note) : "Paid back")
    : `${esc(pName(g, e.paidBy))} paid · split ${e.mode === "exact" ? "by amounts" : e.mode === "percent" ? "by percent" : "equally"} · ${esc(e.category || "Other")}`;
  const title = e.type === "payment"
    ? `<span class="tag">Payment</span>${esc(pName(g, e.paidBy))} paid ${esc(pName(g, Object.keys(e.split || {})[0]))}`
    : esc(e.desc || "Untitled");
  const fresh = S.fresh && S.fresh.has(e.id) ? " fresh" : "";
  return `<div class="entry${fresh}" role="button" tabindex="0" data-act="openEntry" data-id="${esc(e.id)}">
    <div class="day"><b>${d.getDate()}</b><br><span>${esc(d.toLocaleDateString(undefined, { weekday: "short" }))}</span></div>
    <div class="grow"><span class="title">${title}</span><span class="tiny muted">${sub}</span>${e.note && e.type !== "payment" ? `<span class="tiny muted">${esc(e.note)}</span>` : ""}${rxChip(e)}</div>
    <span class="amt">${fmt(e.amount, cur)}</span></div>`;
}
function ledgerHtml(g){
  if (!g.entries.length) return `<section class="card pad stack center" style="align-items:center">
    <img class="illus" style="max-width:220px" src="/assets/empty.webp" width="640" height="592" alt="">
    <h2>No expenses yet</h2><p class="small muted">Log the first one: who paid, how much, and who it was for.</p></section>`;
  const list = [...g.entries].sort((a, z) => (z.date || "").localeCompare(a.date || "") || (z.createdAt || 0) - (a.createdAt || 0));
  const months = new Map();
  for (const e of list){ const k = (e.date || "").slice(0, 7); if (!months.has(k)) months.set(k, []); months.get(k).push(e); }
  let html = "";
  for (const [k, es] of months){
    const [y, m] = k.split("-").map(Number);
    const label = new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const tot = es.filter(e => e.type !== "payment").reduce((s, e) => s + e.amount, 0);
    html += `<section class="card ledger"><div class="month-head"><b style="font-size:15px">${esc(label)}</b><span class="num small muted">${fmt(tot, g.meta.currency)}</span></div>${es.map(e => entryRow(g, e)).join("")}</section>`;
  }
  return html;
}
function viewGroup(g){
  const few = g.people.filter(isActive).length < 2;
  const n = g.people.filter(isActive).length;
  return `<div class="topbar">${backLink("All groups", "home")}<button type="button" class="btn" data-act="invite">Invite</button></div>
  <div class="stack" style="gap:4px"><h1 style="font-size:30px;overflow-wrap:anywhere">${esc(g.meta.name)}</h1><span class="small muted">${headerLine(g)}</span></div>
  ${few ? `<div class="banner">You're the only one here so far. Tap Invite to send your friends the link.</div>` : ""}
  <div class="grid2">
    <button type="button" class="btn lg" data-nav="/g/${g.meta.id}/pay" ${few ? "disabled" : ""}>Record a payment</button>
    <button type="button" class="btn primary lg" data-nav="/g/${g.meta.id}/expense">Add expense</button>
  </div>
  <div class="banner" id="offline" hidden></div>
  ${ledgerHtml(g)}
  <section class="card menu">
    <a href="/g/${g.meta.id}/standing" data-nav="/g/${g.meta.id}/standing">Where we stand &amp; settle up<span class="side">${n} ${n === 1 ? "person" : "people"}</span></a>
    <a href="/g/${g.meta.id}/activity" data-nav="/g/${g.meta.id}/activity">Activity<span class="side">${g.log.length >= 150 ? "150+" : g.log.length} change${g.log.length === 1 ? "" : "s"}</span></a>
    <a href="/g/${g.meta.id}/backup" data-nav="/g/${g.meta.id}/backup">Backup &amp; export<span class="side">${g.backups.length ? "Last saved " + esc(ago(g.backups[0].t)) : "Saved nightly"}</span></a>
    <a href="/g/${g.meta.id}/settings" data-nav="/g/${g.meta.id}/settings">Group settings<span class="side">${g.isCreator ? "Name, passcode, delete" : "Name, members, leave"}</span></a>
  </section>`;
}
const groupBack = g => backLink(g.meta.name, "nav", `data-to="/g/${g.meta.id}"`);

function viewStanding(g){
  const b = balances(g), plan = settlePlan(b), cur = g.meta.currency;
  const total = totalSpent(g);
  const rows = Object.entries(b).filter(([id, v]) => isActive(pOf(g, id)) || v.net).sort((a, z) => z[1].net - a[1].net);
  if (g.entries.length && !plan.length){
    const n = g.people.filter(isActive).length || 1;
    return `${groupBack(g)}
    <div class="stack center" style="align-items:center;gap:14px;margin-top:8px">
      <img class="illus" src="/assets/settled.webp" alt="" width="600" height="500">
      <h1>Everyone's square</h1>
      <p class="muted">All ${n} ${n === 1 ? "person is" : "people are"} settled up. Nobody owes anything.</p>
    </div>
    <section class="card pad grid2" style="text-align:center">
      <div class="stack" style="gap:2px"><span class="eyebrow">Spent together</span><span class="num" style="font-weight:600;font-size:20px">${fmt(total, cur)}</span></div>
      <div class="stack" style="gap:2px"><span class="eyebrow">Per person</span><span class="num" style="font-weight:600;font-size:20px">${fmt(Math.round(total / n), cur)}</span></div>
    </section>
    <button type="button" class="btn lg full" data-act="csv">Download spreadsheet</button>
    <button type="button" class="btn primary full" data-nav="/g/${g.meta.id}">Back to the group</button>`;
  }
  return `${groupBack(g)}
  <h1>Where we stand</h1>
  <section class="card pad" style="padding-top:8px;padding-bottom:6px">
    <div class="between dash" style="padding-top:8px"><span class="num" style="font-size:22px;font-weight:600">${fmt(total, cur)}</span><span class="small muted">spent together</span></div>
    ${rows.length ? rows.map(([id, v]) => { const p = pOf(g, id);
      return `<div class="bal-row">${dot(p)}<div class="grow"><b style="font-size:14px">${esc(pName(g, id, { former: true }))}${id === g.me ? " (you)" : ""}</b><span class="tiny muted">Paid ${fmt(v.paid, cur)} · share ${fmt(v.share, cur)}</span></div>
        <span class="num ${v.net > 0 ? "pos" : v.net < 0 ? "neg" : "muted"}" style="font-weight:600">${fmt(v.net, cur, true)}</span></div>`; }).join("")
      : `<p class="empty-note">Balances show up once there are expenses.</p>`}
  </section>
  <section class="card pad stack" style="gap:10px">
    <div class="between"><h2>Settle up</h2><span class="tiny muted">Fewest payments</span></div>
    ${plan.length ? plan.map((s, i) => `<div class="sunkrow"><div class="grow"><span style="font-size:14px"><b>${esc(pName(g, s.from))}</b> pays <b>${esc(pName(g, s.to))}</b></span><span class="num" style="font-weight:600">${fmt(s.c, cur)}</span></div>
      <button type="button" class="btn sm" data-act="settle" data-i="${i}">Mark paid</button></div>`).join("")
      + `<p class="tiny muted">"Mark paid" records the payment in the group, so everyone's balance updates.</p>`
      : `<p class="empty-note">Nothing to settle yet.</p>`}
  </section>
  <button type="button" class="btn lg full" data-nav="/g/${g.meta.id}/pay" ${g.people.filter(isActive).length < 2 ? "disabled" : ""}>Record a payment</button>`;
}

function actText(g, a){
  const cur = g.meta.currency;
  const nm = id => `<b>${esc(pName(g, id, { former: true }))}</b>`;
  const thing = a.type === "payment" ? `a ${fmt(a.amount, cur)} payment from ${esc(pName(g, a.from))} to ${esc(pName(g, a.to))}` : `<b>${esc(a.desc)}</b> (${fmt(a.amount, cur)})`;
  switch (a.action){
    case "added": return a.type === "payment" ? `paid ${esc(pName(g, a.to))} <span class="num">${fmt(a.amount, cur)}</span>` : `added ${thing}`;
    case "edited": return `edited ${thing}${a.before !== undefined ? `, was ${fmt(a.before, cur)}` : ""}`;
    case "deleted": return `<span class="neg">deleted</span> ${thing}`;
    case "restored": return `restored ${thing}`;
    case "created": return "created the group";
    case "self-joined": return "joined the group";
    case "joined": return `added <b>${esc(a.name)}</b> to the group`;
    case "claimed": return "joined the group";
    case "rejoined": return "rejoined the group";
    case "left": return "left the group";
    case "handed over": return `handed the group over to ${a.to ? nm(a.to) : `<b>${esc(a.name)}</b>`}`;
    case "renamed": return a.from ? `changed their name from <b>${esc(a.from)}</b>` : `renamed someone to <b>${esc(a.name)}</b>`;
    case "renamed group": return `renamed the group to <b>${esc(a.name)}</b>`;
    case "currency": return `changed the money to <b>${esc(a.name)}</b>`;
    case "passcode": return "changed the group passcode";
    case "settings": return "changed the group settings";
    case "removed person": return `removed <b>${esc(a.name)}</b>`;
    default: return "made a change";
  }
}
function viewActivity(g){
  const f = S.ui.actFilter || "all";
  const list = g.log.filter(a => f === "all" || (f === "edits" ? ["edited","deleted","restored"].includes(a.action) : a.type === "payment"));
  return `${groupBack(g)}
  <div class="stack tight"><h1>Activity</h1><p class="small muted">Every add, edit, delete and payment, by whom. Nothing can be changed quietly.</p></div>
  <div class="seg" role="group" aria-label="Show">
    <button type="button" data-act="actF" data-f="all" aria-pressed="${f === "all"}">Everything</button>
    <button type="button" data-act="actF" data-f="edits" aria-pressed="${f === "edits"}">Edits &amp; deletes</button>
    <button type="button" data-act="actF" data-f="pay" aria-pressed="${f === "pay"}">Payments</button>
  </div>
  <section class="card" style="padding:2px 14px">
    ${list.length ? `<ul class="list feed">${list.map(a => { const p = pOf(g, a.by);
      return `<li>${dot(p)}<div class="grow"><span class="txt"><b>${esc(p ? pName(g, a.by, { former: true }) : "Someone")}</b> ${actText(g, a)}</span><span class="tiny muted">${esc(ago(a.t))}</span></div></li>`; }).join("")}</ul>`
      : `<p class="empty-note" style="padding:14px 0">Nothing here yet.</p>`}
  </section>`;
}
function viewBackup(g){
  const cur = g.meta.currency;
  const left = e => Math.max(0, 30 - Math.floor((Date.now() - (e.deletedAt || 0)) / 86400000));
  const title = e => e.type === "payment" ? `${pName(g, e.paidBy)} paid ${pName(g, Object.keys(e.split || {})[0])}` : (e.desc || "Untitled");
  return `${groupBack(g)}
  <h1>Backup &amp; export</h1>
  <button type="button" class="btn primary full" data-act="csv">Download spreadsheet</button>
  <span class="small muted" style="margin-top:-8px">Every expense, payment and split as a CSV file for Excel, Numbers or Google Sheets.</span>
  <div class="err" id="bkErr" role="alert"></div>
  <section class="card" style="padding:14px 16px 4px">
    <div class="between dash"><h2>Recently deleted</h2><span class="tiny muted">Kept 30 days</span></div>
    <ul class="list">${g.trash.length ? g.trash.map(e => `<li><div class="grow"><span style="font-weight:600;font-size:14px">${esc(title(e))} · <span class="num">${fmt(e.amount, cur)}</span></span><span class="tiny muted">Deleted by ${esc(pName(g, e.deletedBy))} · ${left(e)} day${left(e) === 1 ? "" : "s"} left</span></div>
      <button type="button" class="btn sm" data-act="restore" data-id="${esc(e.id)}">Restore</button></li>`).join("") : `<li class="empty-note">Nothing here. Deleted items stay here for 30 days.</li>`}</ul>
  </section>
  <section class="card" style="padding:14px 16px 4px">
    <div class="between dash"><h2>Daily copies</h2><span class="tiny muted">Saved nightly · last 30 kept</span></div>
    <ul class="list">${g.backups.length ? g.backups.map(b => `<li><div class="grow"><span style="font-weight:600;font-size:14px">${esc(b.label)}</span><span class="tiny muted">${b.entries} entr${b.entries === 1 ? "y" : "ies"} · ${b.people} ${b.people === 1 ? "person" : "people"}</span></div>
      <button type="button" class="btn sm" data-act="dlBackup" data-key="${esc(b.key)}">Download</button></li>`).join("") : `<li class="empty-note">The first copy is saved tonight. After that, one is added every day.</li>`}</ul>
  </section>`;
}
function viewSettings(g){
  const cur = g.meta.currency;
  const creator = g.people.find(p => p.uid === g.meta.creator);
  const active = g.people.filter(p => joined(p));
  const pending = g.people.filter(p => !p.uid && !p.leftAt);
  const former = g.people.filter(p => p.leftAt);
  const memberLi = (p, sub, dim) => `<li style="${dim ? "opacity:.7" : ""}">${dot(p)}<div class="grow"><b style="font-size:14px">${esc(p.name)}${p.id === g.me ? " (you)" : ""}</b><span class="tiny muted">${sub}</span></div>${p.uid && p.uid === g.meta.creator && !p.leftAt ? `<span class="badge">Creator</span>` : ""}</li>`;
  const creatorName = creator ? creator.name : "the creator";
  const mine = (balances(g)[g.me] || { net: 0 }).net;
  return `${groupBack(g)}
  <h1>Group settings</h1>
  <form class="field" data-form="rename" novalidate>
    <label class="eyebrow" for="sn">Group name</label>
    <input id="sn" name="name" type="text" maxlength="60" value="${esc(g.meta.name)}" enterkeyhint="done">
  </form>
  <div class="field">
    <div class="tip-wrap"><label class="eyebrow" for="scur">Money</label><button type="button" class="ibtn" data-act="tip" aria-expanded="${!!S.ui.tip}" aria-controls="curTip" aria-label="About the money setting">i</button>
      <div class="tip" id="curTip" role="tooltip" ${S.ui.tip ? "" : "hidden"}>This only changes the currency symbol. Amounts aren't converted, so $50 becomes ₹50.</div></div>
    <select id="scur" ${g.isCreator ? "" : "disabled"}>${CURRENCIES.map(([v, l]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
    ${g.isCreator ? "" : `<span class="hint">Only ${esc(creatorName)} can change this.</span>`}
  </div>
  <section class="card pad stack" style="gap:10px">
    <h2>Invite</h2>
    <div class="mono-box"><span class="tiny muted">Private link</span><span class="num">${esc(inviteLink(g.meta.id))}</span></div>
    <button type="button" class="btn" data-act="invite">Copy invite</button>
    <span class="hint">Send the passcode separately. Friends need both to join.</span>
  </section>
  <section class="card pad stack" style="gap:10px">
    <div class="between" style="align-items:center"><h2>Passcode</h2><span class="badge">Creator only</span></div>
    ${g.isCreator ? `<button type="button" class="btn" data-act="dlgPasscode">Change passcode</button>
      <span class="tiny muted" style="line-height:1.5">Everyone, including current members, will be asked for the new passcode the next time they open this group.</span>`
      : `<span class="small muted">Only ${esc(creatorName)} can change the passcode.</span>`}
  </section>
  <section class="card" style="padding:2px 16px">
    <ul class="list">
      ${active.map(p => memberLi(p, p.uid === g.meta.creator ? "Created the group" : "Member")).join("")}
      ${pending.map(p => memberLi(p, "Hasn't joined yet", false)).join("")}
      ${former.map(p => memberLi(p, `Former member · left ${esc(shortDate(p.leftAt))}`, true)).join("")}
    </ul>
  </section>
  <section class="danger-zone">
    ${S.ui.leaveBlock ? `<div class="alert" role="alert">${ICON.alert}<span>${S.ui.leaveBlock === "alone" ? "You're the only one here, so there's no one to hand the group to. Delete the group instead." : `Just one thing before you go: you still have <b class="num neg">${fmt(Math.abs(mine), cur)}</b> to settle. Once that's sorted, you're free to leave.`}</span></div>` : ""}
    <button type="button" class="btn danger lg" data-act="leave" ${S.ui.armLeave ? 'data-armed="1"' : ""}>${S.ui.armLeave ? "Tap again to leave" : "Leave group"}</button>
    <span class="tiny muted" style="line-height:1.5">Anyone can leave once they're settled up. Their past expenses stay, shown as "former member", and Activity records that they left. If you created the group, you'll pick who takes over first.</span>
    ${g.isCreator ? `<button type="button" class="btn danger lg" data-act="delGroup" style="margin-top:6px">${S.ui.armDel ? "Tap again to delete for everyone" : "Delete group"}</button>
    <span class="tiny muted" style="line-height:1.5">Creator only. Download the spreadsheet first: deleting can't be undone.</span>` : ""}
  </section>`;
}
function viewLeave(g){
  const others = g.people.filter(p => joined(p) && p.id !== g.me);
  const pick = S.ui.handTo || (others[0] && others[0].id);
  const to = others.find(p => p.id === pick);
  return `${backLink("Group settings", "nav", `data-to="/g/${g.meta.id}/settings"`)}
  <h1>Before you leave</h1>
  <p class="muted" style="margin-top:-6px">You created this group, so pick who takes over. They'll be able to change the passcode and delete the group.</p>
  <div class="stack tight" role="radiogroup" aria-label="Who takes over">
    ${others.map(p => `<label class="radio"><input type="radio" name="ho" value="${esc(p.id)}" ${p.id === pick ? "checked" : ""} data-act="handTo">${dot(p)}<b style="font-size:15px">${esc(p.name)}</b></label>`).join("")}
  </div>
  <div class="err" id="lvErr" role="alert"></div>
  <div class="stack tight" style="margin-top:auto">
    <button type="button" class="btn primary full" data-act="handover" ${to ? "" : "disabled"}>Hand over to ${esc(to ? to.name : "…")} and leave</button>
    <button type="button" class="btn lg full" data-nav="/g/${g.meta.id}/settings">Stay in the group</button>
  </div>`;
}

/* ---------- expense form ---------- */
let ED = null;
function choosable(g, e){
  const inEntry = new Set(e ? [e.paidBy, ...Object.keys(e.split || {})] : []);
  return g.people.filter(p => isActive(p) || inEntry.has(p.id));
}
function viewExpense(g, id){
  const e = id ? g.entries.find(x => x.id === id && x.type !== "payment") : null;
  if (id && !e) return `${groupBack(g)}<div class="card pad">That expense isn't here any more. It may have been deleted.</div>`;
  const ppl = choosable(g, e);
  const used = g.entries.filter(x => x.type !== "payment" && x.category).map(x => x.category);
  const custom = [...new Set(used.filter(c => !BUILT_IN.some(b => b.toLowerCase() === c.toLowerCase())))].sort((a, z) => a.localeCompare(z));
  const cats = [...BUILT_IN.filter(c => c !== "Other"), ...custom, "Other"];
  const cat = e ? e.category || "Other" : "Dining";
  if (e && !cats.includes(cat)) cats.splice(cats.length - 1, 0, cat);
  const payer = e ? e.paidBy : g.me;
  return `${groupBack(g)}
  <h1>${e ? "Edit expense" : "Add expense"}</h1>
  <form class="stack" id="fx" novalidate style="gap:14px">
    <div class="field"><label class="eyebrow" for="fxDesc">What was it for</label><input id="fxDesc" type="text" maxlength="80" value="${esc(e ? e.desc : "")}" placeholder="Dinner, groceries, gas" ${e ? "" : "autofocus"}></div>
    <div class="grid2">
      <div class="field"><label class="eyebrow" for="fxAmt">Amount</label><div class="amt-in"><span class="cur">${esc(curSymbol(g.meta.currency))}</span><input id="fxAmt" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00" value="${e ? (e.amount / 100).toFixed(2) : ""}"></div></div>
      <div class="field"><label class="eyebrow" for="fxDate">Date</label><input id="fxDate" type="date" value="${esc(e ? e.date : today())}"></div>
    </div>
    <div class="grid2">
      <div class="field"><label class="eyebrow" for="fxPayer">Paid by</label><select id="fxPayer">${ppl.map(p => `<option value="${esc(p.id)}" ${p.id === payer ? "selected" : ""}>${esc(p.name)}${p.id === g.me ? " (you)" : ""}${p.leftAt ? " (former)" : ""}</option>`).join("")}</select></div>
      <div class="field"><label class="eyebrow" for="fxCat">Category</label><select id="fxCat">${cats.map(c => `<option ${c === cat ? "selected" : ""}>${esc(c)}</option>`).join("")}<option value="__new__">+ New category…</option></select>
        <input id="fxCatNew" type="text" maxlength="24" placeholder="Name it, e.g. Gas" aria-label="New category name" hidden></div>
    </div>
    <div class="field"><span class="eyebrow">Split</span>
      <div class="seg" id="fxMode" role="group" aria-label="Split method">
        <button type="button" data-m="equal">Equally</button><button type="button" data-m="exact">Exact</button><button type="button" data-m="percent">Percent</button>
      </div>
      <div class="parts" id="fxParts">${ppl.map(p => {
        const inc = e ? (p.id in (e.split || {})) : isActive(p);
        let v = "";
        if (e && inc) v = e.mode === "exact" ? (e.split[p.id] / 100).toFixed(2) : e.mode === "percent" ? (e.pct && e.pct[p.id] !== undefined ? e.pct[p.id] : +(e.split[p.id] / e.amount * 100).toFixed(2)) : "";
        return `<div class="part" data-id="${esc(p.id)}"><label>${dot(p, "sm")}<input type="checkbox" ${inc ? "checked" : ""} ${p.leftAt && !inc ? "disabled" : ""} aria-label="Include ${esc(p.name)}"><span class="n">${esc(p.name)}</span></label>
          <span class="share"></span><input type="number" step="0.01" min="0" inputmode="decimal" value="${esc(v)}" aria-label="${esc(p.name)}'s share" hidden></div>`; }).join("")}</div>
      <div class="splitcheck" id="fxCheck"></div>
    </div>
    <div class="field"><label class="eyebrow" for="fxNote">Note (optional)</label><input id="fxNote" type="text" maxlength="140" value="${esc(e ? e.note : "")}" placeholder="Anything the group should know"></div>
    <div class="field"><span class="eyebrow">Receipt photo (optional)</span>
      <div class="rx-row" id="fxRx"></div>
      <input type="file" id="fxFiles" accept="image/*" multiple hidden>
      <button type="button" class="btn" id="fxAddRx" style="align-self:flex-start">${ICON.camera}Add receipt or photo</button>
      <span class="tiny muted" id="fxRxHint">Photos delete themselves after 30 days.</span></div>
    ${e ? `<p class="tiny muted">Logged by ${esc(pName(g, e.addedBy))}${e.createdAt ? " on " + esc(shortDate(e.createdAt)) : ""}${e.editedAt ? ` · last edited by ${esc(pName(g, e.editedBy))} ${esc(shortDate(e.editedAt))}` : ""}</p>` : ""}
    <div class="err" id="fxErr" role="alert"></div>
    <button type="submit" class="btn primary full" id="fxSave">${e ? "Save changes" : "Save expense"}</button>
    ${e ? `<button type="button" class="btn danger lg full" id="fxDel">Delete</button>` : ""}
  </form>`;
}
function bindExpense(g, id){
  const e = id ? g.entries.find(x => x.id === id && x.type !== "payment") : null;
  if (id && !e) return;
  const $ = s => V.querySelector(s);
  ED = { gid: g.meta.id, e, mode: e ? e.mode || "equal" : "equal", rx: (e && e.receipts || []).map(x => ({ id: x, existing: true })) };
  const cur = g.meta.currency;
  const setMode = m => {
    ED.mode = m;
    $("#fxMode").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.m === m));
    $("#fxParts").querySelectorAll(".part").forEach(row => {
      const num = row.querySelector("input[type=number]"), sh = row.querySelector(".share");
      num.hidden = m === "equal"; sh.hidden = m !== "equal"; num.placeholder = m === "percent" ? "%" : "0.00";
    });
    update();
  };
  const compute = () => {
    const total = toCents($("#fxAmt").value);
    const rows = [...$("#fxParts").querySelectorAll(".part")].map(r => ({ id: r.dataset.id, on: r.querySelector("input[type=checkbox]").checked, v: r.querySelector("input[type=number]").value, row: r }));
    const on = rows.filter(r => r.on);
    if (ED.mode === "equal"){
      const s = {}; const n = on.length;
      if (n && total){ const base = Math.floor(total / n); let rem = total - base * n; on.forEach(r => { s[r.id] = base + (rem > 0 ? 1 : 0); if (rem > 0) rem--; }); }
      return { total, split: s, rows, ok: total > 0 && n > 0 && Object.values(s).every(c => c > 0), msg: n ? `${fmt(Math.floor(total / n), cur)} each across ${n} ${n === 1 ? "person" : "people"}` : "Pick at least one person" };
    }
    if (ED.mode === "exact"){
      const s = {}; let sum = 0; on.forEach(r => { const c = toCents(r.v); if (c > 0){ s[r.id] = c; sum += c; } });
      const diff = total - sum;
      return { total, split: s, rows, ok: total > 0 && diff === 0 && Object.keys(s).length > 0, msg: diff === 0 ? "Adds up exactly" : diff > 0 ? `${fmt(diff, cur)} left to assign` : `${fmt(-diff, cur)} over the total` };
    }
    const pct = {}; let psum = 0; on.forEach(r => { const p = parseFloat(r.v) || 0; if (p > 0){ pct[r.id] = p; psum += p; } });
    const ids = Object.keys(pct); const s = {}; let acc = 0;
    ids.forEach((pid, i) => { const c = i === ids.length - 1 ? total - acc : Math.round(total * pct[pid] / 100); s[pid] = c; acc += c; });
    const okp = Math.abs(psum - 100) < 0.001;
    return { total, split: s, pct, rows, ok: total > 0 && okp && ids.length > 0 && Object.values(s).every(c => c > 0), msg: okp ? "Adds up to 100%" : `Adds up to ${+psum.toFixed(2)}%, needs 100%` };
  };
  const update = () => {
    const r = compute();
    r.rows.forEach(x => { x.row.querySelector(".share").textContent = x.on ? fmt(r.split[x.id] || 0, cur) : "–"; x.row.querySelector("input[type=number]").disabled = !x.on; });
    const c = $("#fxCheck"); c.textContent = r.total ? r.msg : "Enter an amount to see the split"; c.className = "splitcheck " + (r.total ? (r.ok ? "ok" : "bad") : "");
    return r;
  };
  ED.compute = compute;
  $("#fxMode").addEventListener("click", ev => { const b = ev.target.closest("button[data-m]"); if (b) setMode(b.dataset.m); });
  $("#fxAmt").addEventListener("input", update);
  $("#fxParts").addEventListener("input", update);
  $("#fxCat").addEventListener("change", () => { const n = $("#fxCat").value === "__new__"; $("#fxCatNew").hidden = !n; if (n) $("#fxCatNew").focus(); });
  $("#fxAddRx").onclick = () => $("#fxFiles").click();
  $("#fxFiles").addEventListener("change", async ev => {
    const files = [...ev.target.files].slice(0, MAX_RX - ED.rx.length); ev.target.value = "";
    for (const f of files){
      const item = { id: uid(), busy: true }; ED.rx.push(item); renderRx();
      try { item.data = await shrink(f); delete item.busy; } catch { ED.rx.splice(ED.rx.indexOf(item), 1); toast("Couldn't read that photo. Try a JPEG or PNG."); }
      renderRx();
    }
  });
  $("#fx").addEventListener("submit", ev => { ev.preventDefault(); saveExpense(g); });
  const del = $("#fxDel");
  if (del) del.onclick = async () => {
    if (!del.dataset.arm){ del.dataset.arm = "1"; del.textContent = "Tap again to delete"; return; }
    del.disabled = true;
    try { await api("POST", "/api/group", { op: "delEntry", g: g.meta.id, id: e.id }); await loadGroup(g.meta.id); toast("Moved to Recently deleted"); history.back(); }
    catch (err){ del.disabled = false; handleErr(err, $("#fxErr")); }
  };
  renderRx(); setMode(ED.mode);
}
const rxCache = new Map();
async function getRx(gid, id){
  if (rxCache.has(id)) return rxCache.get(id);
  const d = await api("GET", `/api/receipt?g=${gid}&id=${encodeURIComponent(id)}`);
  rxCache.set(id, d.data); return d.data;
}
function renderRx(){
  const el = V.querySelector("#fxRx"); if (!el || !ED) return;
  el.innerHTML = ED.rx.map((x, i) => `<div class="rx">${x.busy ? `<span class="busy">Preparing…</span>` : `<img alt="Photo ${i + 1}" data-i="${i}">`}<button type="button" data-rm="${i}" aria-label="Remove photo ${i + 1}">×</button></div>`).join("");
  el.querySelectorAll("img[data-i]").forEach(img => {
    const x = ED.rx[+img.dataset.i];
    if (x.data) img.src = x.data; else getRx(ED.gid, x.id).then(u => { img.src = u; }).catch(() => { img.alt = "Deleted"; });
  });
  el.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { ED.rx.splice(+b.dataset.rm, 1); renderRx(); });
  V.querySelector("#fxAddRx").hidden = ED.rx.length >= MAX_RX;
  V.querySelector("#fxRxHint").textContent = ED.rx.length >= MAX_RX ? "That's the most: 4 photos. Photos delete themselves after 30 days." : "Up to 4. Photos delete themselves after 30 days.";
}
async function shrink(file){
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    for (const [side, q] of [[1600, 0.72], [1200, 0.62], [900, 0.55]]){
      const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      const gx = c.getContext("2d"); gx.fillStyle = "#fff"; gx.fillRect(0, 0, c.width, c.height); gx.drawImage(img, 0, 0, c.width, c.height);
      const out = c.toDataURL("image/jpeg", q);
      if (out.length < 900_000) return out;
    }
    throw new Error("too big");
  } finally { URL.revokeObjectURL(url); }
}
async function saveExpense(g){
  const $ = s => V.querySelector(s), err = $("#fxErr");
  err.textContent = "";
  const desc = $("#fxDesc").value.trim(), r = ED.compute();
  if (!desc){ err.textContent = "Add a short description so everyone knows what this was."; $("#fxDesc").focus(); return; }
  if (!r.total){ err.textContent = "Enter an amount above zero."; $("#fxAmt").focus(); return; }
  if (!r.ok){ err.textContent = "The split doesn't match the total yet. " + r.msg + "."; return; }
  const isNew = $("#fxCat").value === "__new__";
  const category = isNew ? $("#fxCatNew").value.trim().replace(/\s+/g, " ") : $("#fxCat").value;
  if (!category){ err.textContent = "Type a name for the new category."; $("#fxCatNew").focus(); return; }
  if (ED.rx.some(x => x.busy)){ err.textContent = "Wait a moment, a photo is still being prepared."; return; }
  const btn = $("#fxSave"); btn.disabled = true;
  try {
    for (const x of ED.rx){ if (x.data && !x.up){ await api("POST", "/api/receipt", { g: g.meta.id, id: x.id, data: x.data }); x.up = true; rxCache.set(x.id, x.data); } }
    const entry = { id: ED.e ? ED.e.id : uid(), type: "expense", desc, amount: r.total, date: $("#fxDate").value || today(), category,
      receipts: ED.rx.map(x => x.id), paidBy: $("#fxPayer").value, mode: ED.mode, split: r.split, note: $("#fxNote").value.trim() };
    if (ED.mode === "percent") entry.pct = r.pct;
    await api("POST", "/api/group", { op: "putEntry", g: g.meta.id, entry });
    await loadGroup(g.meta.id);
    S.fresh = new Set([entry.id]);
    toast(ED.e ? "Saved changes" : "Expense added");
    go(`/g/${g.meta.id}`);
  } catch (e){ handleErr(e, err); }
  finally { btn.disabled = false; }
}

/* ---------- payment form ---------- */
function viewPay(g, id, st){
  const e = id ? g.entries.find(x => x.id === id && x.type === "payment") : null;
  if (id && !e) return `${groupBack(g)}<div class="card pad">That payment isn't here any more. It may have been deleted.</div>`;
  const ppl = choosable(g, e);
  const from = e ? e.paidBy : st.from || g.me;
  const to = e ? Object.keys(e.split || {})[0] : st.to || (ppl.find(p => p.id !== from) || {}).id;
  const amt = e ? e.amount : st.c;
  const opts = sel => ppl.map(p => `<option value="${esc(p.id)}" ${p.id === sel ? "selected" : ""}>${esc(p.name)}${p.id === g.me ? " (you)" : ""}</option>`).join("");
  return `${groupBack(g)}
  <h1>${e ? "Edit payment" : "Record a payment"}</h1>
  <p class="muted" style="margin-top:-6px">For when someone pays another person back, by Venmo, Zelle, cash or anything else.</p>
  <form class="stack" id="fp" novalidate style="gap:14px">
    <div class="grid2">
      <div class="field"><label class="eyebrow" for="fpFrom">Who paid</label><select id="fpFrom">${opts(from)}</select></div>
      <div class="field"><label class="eyebrow" for="fpTo">Paid to</label><select id="fpTo">${opts(to)}</select></div>
    </div>
    <div class="grid2">
      <div class="field"><label class="eyebrow" for="fpAmt">Amount</label><div class="amt-in"><span class="cur">${esc(curSymbol(g.meta.currency))}</span><input id="fpAmt" type="number" min="0" step="0.01" inputmode="decimal" value="${amt ? (amt / 100).toFixed(2) : ""}"></div></div>
      <div class="field"><label class="eyebrow" for="fpDate">Date</label><input id="fpDate" type="date" value="${esc(e ? e.date : today())}"></div>
    </div>
    <div class="field"><label class="eyebrow" for="fpNote">Note (optional)</label><input id="fpNote" type="text" maxlength="140" value="${esc(e ? e.note : "")}" placeholder="Zelle, cash"></div>
    <div class="err" id="fpErr" role="alert"></div>
    <button type="submit" class="btn primary full" id="fpSave">Save payment</button>
    ${e ? `<button type="button" class="btn danger lg full" id="fpDel">Delete</button>` : ""}
  </form>`;
}
function bindPay(g, id){
  const e = id ? g.entries.find(x => x.id === id && x.type === "payment") : null;
  const $ = s => V.querySelector(s);
  const form = $("#fp"); if (!form) return;
  form.addEventListener("submit", async ev => {
    ev.preventDefault();
    const err = $("#fpErr"); err.textContent = "";
    const from = $("#fpFrom").value, to = $("#fpTo").value, amt = toCents($("#fpAmt").value);
    if (from === to){ err.textContent = "Pick two different people."; return; }
    if (!amt){ err.textContent = "Enter an amount above zero."; return; }
    const btn = $("#fpSave"); btn.disabled = true;
    try {
      const entry = { id: e ? e.id : uid(), type: "payment", amount: amt, date: $("#fpDate").value || today(), paidBy: from, split: { [to]: amt }, note: $("#fpNote").value.trim() };
      await api("POST", "/api/group", { op: "putEntry", g: g.meta.id, entry });
      await loadGroup(g.meta.id);
      S.fresh = new Set([entry.id]);
      toast(e ? "Saved changes" : "Payment recorded");
      go(`/g/${g.meta.id}`);
    } catch (x){ handleErr(x, err); }
    finally { btn.disabled = false; }
  });
  const del = $("#fpDel");
  if (del) del.onclick = async () => {
    if (!del.dataset.arm){ del.dataset.arm = "1"; del.textContent = "Tap again to delete"; return; }
    del.disabled = true;
    try { await api("POST", "/api/group", { op: "delEntry", g: g.meta.id, id: e.id }); await loadGroup(g.meta.id); toast("Moved to Recently deleted"); history.back(); }
    catch (x){ del.disabled = false; handleErr(x, $("#fpErr")); }
  };
}

/* ---------- spreadsheet ---------- */
function downloadCSV(entries, people, meta, tag){
  const names = Object.fromEntries((people || []).map(p => [p.id, p.name]));
  const nm = id => names[id] || "Someone";
  const ids = (people || []).map(p => p.id).filter(id => (entries || []).some(e => e.paidBy === id || id in (e.split || {})) || !(people.find(p => p.id === id) || {}).leftAt);
  for (const e of entries || []) for (const id of [e.paidBy, ...Object.keys(e.split || {})]) if (!ids.includes(id)) ids.push(id);
  const money = c => (c / 100).toFixed(2);
  const cell = v => { const s = String(v ?? ""); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : "") + s.replace(/"/g, '""')}"` : s; };
  const head = ["Date","Type","Description","Category","Amount","Currency","Paid by", ...ids.map(id => `${nm(id)} share`), "Note","Photos","Logged by","Logged on","Last edited by","Last edited on"];
  const rows = [...(entries || [])].sort((a, z) => (a.date || "").localeCompare(z.date || "")).map(e => [
    e.date, e.type === "payment" ? "Payment" : "Expense",
    e.type === "payment" ? `${nm(e.paidBy)} paid ${nm(Object.keys(e.split || {})[0])}` : e.desc,
    e.type === "payment" ? "" : (e.category || ""), money(e.amount), (meta && meta.currency) || "USD", nm(e.paidBy),
    ...ids.map(id => (e.split && id in e.split) ? money(e.split[id]) : ""),
    e.note || "", (e.receipts || []).length || "", e.addedBy ? nm(e.addedBy) : "",
    e.createdAt ? new Date(e.createdAt).toISOString().slice(0, 10) : "", e.editedBy ? nm(e.editedBy) : "", e.editedAt ? new Date(e.editedAt).toISOString().slice(0, 10) : ""]);
  const csv = "﻿" + [head, ...rows].map(r => r.map(cell).join(",")).join("\r\n");
  const slug = ((meta && meta.name) || "contri").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "contri";
  saveFile(new Blob([csv], { type: "text/csv;charset=utf-8" }), tag.startsWith("copy-") ? `${slug}-${tag}.csv` : `${slug}-${new Date().toISOString().slice(0, 10)}.csv`);
  toast(entries && entries.length ? "Spreadsheet downloaded" : "Downloaded (no entries yet)");
}
function saveFile(blob, name){
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function copyText(t, okMsg){
  try {
    if (navigator.share && matchMedia("(pointer:coarse)").matches){ await navigator.share({ text: t }); return; }
  } catch (e){ if (e && e.name === "AbortError") return; }
  try { await navigator.clipboard.writeText(t); toast(okMsg); }
  catch { openDialog(`<div class="sheet"><h2>Copy this</h2><textarea readonly style="height:140px;padding:10px">${esc(t)}</textarea><div class="sheet-actions"><button type="button" class="btn" data-close>Done</button></div></div>`); DLG.querySelector("textarea").select(); }
}

/* ---------- clicks ---------- */
const ACT = {
  retry: () => render(),
  home: () => go("/", {}),
  back: () => history.length > 1 ? history.back() : go("/"),
  nav: el => go(el.dataset.to),
  tab: el => { S.ui.tab = el.dataset.tab; render(); },
  toReset: () => go(location.pathname, { v: "reset" }),
  toLogin: () => go(location.pathname, { tab: "login" }),
  profile: () => go("/", { v: "profile", refresh: false }),
  create: () => go("/", { v: "create" }),
  joinlink: () => go("/", { v: "joinlink" }),
  copyCode: () => copyText(S.showCode.code, "Recovery code copied"),
  saveCode: () => saveFile(new Blob([`Contri recovery code for ${S.user ? S.user.username : "your profile"}\n\n${S.showCode.code}\n\nUse it on the log in screen (Forgot password?) to set a new password. Keep it somewhere safe.\n`], { type: "text/plain" }), "contri-recovery-code.txt"),
  codeDone: () => { S.showCode = null; render(); },
  homeSettle: el => {
    const all = S.home.groups.flatMap(g => (g.settles || []).map(s => ({ ...s, g })));
    const s = all[+el.dataset.i]; if (!s) return;
    go(`/g/${s.g.id}/pay`, { from: s.from, to: s.to, c: s.c, fresh: true });
  },
  logout: async () => { try { await api("POST", "/api/auth", { op: "logout" }); } catch {} S.user = null; S.home = null; S.g = {}; go("/", {}); },
  dlgUsername: () => openDialog(dlgShell("Change username", `<div class="field"><label class="eyebrow" for="du">New username</label><input id="du" name="username" type="text" autocapitalize="off" spellcheck="false" maxlength="20" value="${esc(S.user.username)}"><span class="hint">3 to 20 letters, numbers, dots or underscores. Groups will see the new name.</span></div>`, "Save"),
    async f => { const d = await api("POST", "/api/auth", { op: "changeUsername", username: f.username }); S.user = { ...S.user, ...d.user }; S.home = null; S.g = {}; DLG.close(); toast("Username changed"); render(); }),
  dlgPassword: () => openDialog(dlgShell("Change password", `<div class="field"><label class="eyebrow" for="dc">Current password</label><input id="dc" name="current" type="password" autocomplete="current-password"></div>
    <div class="field"><label class="eyebrow" for="dn">New password</label><input id="dn" name="password" type="password" autocomplete="new-password"><span class="hint">At least 8 characters. Other devices will be logged out.</span></div>`, "Save"),
    async f => { await api("POST", "/api/auth", { op: "changePassword", current: f.current, password: f.password }); DLG.close(); toast("Password changed"); }),
  dlgRecovery: () => openDialog(dlgShell("New recovery code", `<p class="small muted">Your old code will stop working. Enter your password to continue.</p><div class="field"><label class="eyebrow" for="dr">Password</label><input id="dr" name="password" type="password" autocomplete="current-password"></div>`, "Get new code"),
    async f => { const d = await api("POST", "/api/auth", { op: "newRecovery", password: f.password }); DLG.close(); S.showCode = { code: d.recoveryCode }; render(); }),
  dlgDelete: () => openDialog(dlgShell("Delete your profile?", `<p class="small" style="color:var(--body2)">You'll leave every group. Your past expenses stay in them, shown as "former member". You need to be settled up everywhere first. If you're the only one left in a group you created, that group is deleted too. This can't be undone.</p>
    <div class="field"><label class="eyebrow" for="dd">Password</label><input id="dd" name="password" type="password" autocomplete="current-password"></div>`, "Delete profile", true),
    async f => { await api("POST", "/api/auth", { op: "deleteProfile", password: f.password }); DLG.close(); S.user = null; S.home = null; S.g = {}; toast("Profile deleted"); go("/", {}); }),
  pick: el => { S.ui.claim = el.dataset.id; S.ui.pc = V.querySelector("#jp").value; render(); },
  invite: () => { const g = G(); copyText(`Join "${g.meta.name}" on Contri so we can split costs: ${inviteLink(g.meta.id)}\nI'll send you the passcode separately.`, "Invite copied"); },
  copyNewInvite: () => { const d = S.ui.created; copyText(`Join "${d.name}" on Contri so we can split costs: ${inviteLink(d.g)}\nPasscode: ${d.passcode}`, "Invite copied"); },
  openEntry: el => { const g = G(); const e = g.entries.find(x => x.id === el.dataset.id); if (e) go(`/g/${g.meta.id}/${e.type === "payment" ? "pay" : "expense"}/${e.id}`); },
  viewRx: async el => {
    const g = G(); const e = g.entries.find(x => x.id === el.dataset.id); if (!e) return;
    openDialog(`<div class="sheet viewer"><div class="between" style="align-items:center"><h2>${esc(e.desc)}</h2><button type="button" class="btn sm" data-close>Close</button></div>
      <p class="tiny muted">Photos delete themselves 30 days after they're added.</p>${(e.receipts || []).map((id, i) => `<img data-id="${esc(id)}" alt="Photo ${i + 1} for ${esc(e.desc)}" width="800" height="600">`).join("")}</div>`);
    DLG.querySelectorAll("img").forEach(img => getRx(g.meta.id, img.dataset.id).then(u => { img.src = u; img.removeAttribute("width"); img.removeAttribute("height"); })
      .catch(err => img.replaceWith(Object.assign(document.createElement("p"), { className: "small muted", textContent: err.message }))));
  },
  settle: el => { const g = G(); const s = settlePlan(balances(g))[+el.dataset.i]; if (s) go(`/g/${g.meta.id}/pay`, { from: s.from, to: s.to, c: s.c }); },
  actF: el => { S.ui.actFilter = el.dataset.f; render(); },
  csv: () => { const g = G(); downloadCSV(g.entries, g.people, g.meta, "now"); },
  dlBackup: async el => {
    const g = G(); el.disabled = true;
    try { const d = await api("GET", `/api/backup?g=${g.meta.id}&key=${encodeURIComponent(el.dataset.key)}`); downloadCSV(d.backup.entries, d.backup.people, { ...g.meta, ...d.backup.meta }, "copy-" + el.dataset.key); }
    catch (e){ handleErr(e, V.querySelector("#bkErr")); }
    finally { el.disabled = false; }
  },
  restore: async el => {
    const g = G(); el.disabled = true;
    try { await api("POST", "/api/group", { op: "restoreEntry", g: g.meta.id, id: el.dataset.id }); await loadGroup(g.meta.id); toast("Restored"); render(); }
    catch (e){ el.disabled = false; handleErr(e, V.querySelector("#bkErr")); }
  },
  tip: () => { S.ui.tip = !S.ui.tip; const t = V.querySelector("#curTip"); t.hidden = !S.ui.tip; V.querySelector("[data-act=tip]").setAttribute("aria-expanded", S.ui.tip); },
  dlgPasscode: () => openDialog(dlgShell("Change passcode", `<div class="field"><label class="eyebrow" for="dp">New passcode</label><input id="dp" name="passcode" type="text" autocapitalize="off" autocomplete="off" spellcheck="false"><span class="hint">At least 6 characters. Everyone else will be asked for it the next time they open the group.</span></div>`, "Change passcode"),
    async f => { const g = G(); await api("POST", "/api/group", { op: "changePasscode", g: g.meta.id, passcode: f.passcode }); await loadGroup(g.meta.id); DLG.close(); toast("Passcode changed. Send it to the group."); render(); }),
  leave: async el => {
    const g = G();
    const mine = (balances(g)[g.me] || { net: 0 }).net;
    if (mine !== 0){ S.ui.leaveBlock = "owe"; return render(); }
    if (g.isCreator){
      if (!g.people.some(p => joined(p) && p.id !== g.me)){ S.ui.leaveBlock = "alone"; return render(); }
      return go(`/g/${g.meta.id}/leave`);
    }
    if (!S.ui.armLeave){ S.ui.armLeave = true; S.ui.leaveBlock = null; return render(); }
    el.disabled = true;
    try { await api("POST", "/api/group", { op: "leave", g: g.meta.id }); delete S.g[g.meta.id]; S.home = null; toast(`You left ${g.meta.name}`); go("/", {}); }
    catch (e){ el.disabled = false; if (e.status === 409 && e.data.owed !== undefined){ await loadGroup(g.meta.id); S.ui.leaveBlock = "owe"; render(); } else handleErr(e); }
  },
  handTo: el => { S.ui.handTo = el.value; const g = G(); const p = g.byId[el.value]; const b = V.querySelector("[data-act=handover]"); if (b && p){ b.textContent = `Hand over to ${p.name} and leave`; b.disabled = false; } },
  handover: async el => {
    const g = G(); const others = g.people.filter(p => joined(p) && p.id !== g.me);
    const to = S.ui.handTo || (others[0] && others[0].id); if (!to) return;
    el.disabled = true;
    try { await api("POST", "/api/group", { op: "leave", g: g.meta.id, handTo: to }); delete S.g[g.meta.id]; S.home = null; toast(`You left ${g.meta.name}`); go("/", {}); }
    catch (e){ el.disabled = false; handleErr(e, V.querySelector("#lvErr")); }
  },
  delGroup: async el => {
    const g = G();
    if (!S.ui.armDel){ S.ui.armDel = true; return render(); }
    el.disabled = true;
    try { await api("POST", "/api/group", { op: "deleteGroup", g: g.meta.id }); delete S.g[g.meta.id]; S.home = null; toast("Group deleted"); go("/", {}); }
    catch (e){ el.disabled = false; handleErr(e); }
  },
};
V.addEventListener("click", ev => {
  const nav = ev.target.closest("[data-nav]");
  if (nav && !nav.disabled){ ev.preventDefault(); go(nav.dataset.nav); return; }
  const el = ev.target.closest("[data-act]");
  if (el && ACT[el.dataset.act] && !el.disabled){ if (el.tagName !== "INPUT") ev.preventDefault(); ACT[el.dataset.act](el, ev); }
});
V.addEventListener("keydown", ev => {
  if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches("[role=button][data-act]")){ ev.preventDefault(); ev.target.click(); }
});
V.addEventListener("change", ev => {
  if (ev.target.id === "rcOk"){ V.querySelector("#rcDone").disabled = !ev.target.checked; }
  if (ev.target.id === "scur") setCurrency(ev.target);
  if (ev.target.id === "sn") renameGroup(ev.target);
  if (ev.target.id === "au" && V.querySelector("#auHint")) V.querySelector("#auHint").className = "hint";
});
async function setCurrency(sel){
  const g = G();
  try { await api("POST", "/api/group", { op: "setCurrency", g: g.meta.id, currency: sel.value }); await loadGroup(g.meta.id); toast("Money updated"); }
  catch (e){ sel.value = g.meta.currency; handleErr(e); }
}
async function renameGroup(inp){
  const g = G(); const name = inp.value.trim();
  if (!name){ inp.value = g.meta.name; return; }
  if (name === g.meta.name) return;
  try { await api("POST", "/api/group", { op: "rename", g: g.meta.id, name }); await loadGroup(g.meta.id); S.home = null; toast("Group renamed"); }
  catch (e){ inp.value = g.meta.name; handleErr(e); }
}

/* ---------- forms ---------- */
const FORMS = {
  async signup(f, err){
    const d = await api("POST", "/api/auth", { op: "signup", username: f.username.trim(), password: f.password });
    S.user = d.user; S.home = null; S.showCode = { code: d.recoveryCode, fresh: true }; render();
  },
  async login(f, err){
    if (!f.username.trim() || !f.password){ err.textContent = "Enter your username and password."; return; }
    const d = await api("POST", "/api/auth", { op: "login", username: f.username.trim(), password: f.password });
    S.user = d.user; S.home = null; S.ui = {}; render();
  },
  async reset(f, err){
    const d = await api("POST", "/api/auth", { op: "reset", username: f.username.trim(), code: f.code, password: f.password });
    S.user = d.user; S.home = null; S.showCode = { code: d.recoveryCode };
    history.replaceState({}, "", location.pathname); render();
  },
  async joinlink(f, err){
    const m = String(f.link || "").match(/\/g\/([A-Za-z0-9]{10})/) || String(f.link || "").trim().match(/^([A-Za-z0-9]{10})$/);
    if (!m){ err.textContent = "That doesn't look like a Contri invite link. It ends in /g/ and 10 letters and numbers."; return; }
    go(`/g/${m[1]}`, { fresh: true });
  },
  async create(f, err){
    const d = await api("POST", "/api/group", { op: "create", name: f.name, passcode: f.passcode, currency: f.currency });
    S.home = null;
    S.ui.created = { g: d.g, name: f.name.trim().replace(/\s+/g, " "), passcode: f.passcode.trim() };
    render();
  },
  async join(f, err){
    const gid = route().gid;
    const pc = S.ui.pc || f.passcode;
    if (!pc){ err.textContent = "Enter the group passcode."; return; }
    const d = await api("POST", "/api/group", { op: "join", g: gid, passcode: pc, ...(S.ui.claim ? { claim: S.ui.claim } : {}) });
    if (d.choose){ S.ui.choose = d.choose; S.ui.pc = pc; return render(); }
    S.home = null; S.ui = {}; await loadGroup(gid);
    toast(`Welcome to ${S.g[gid].meta.name}`); render();
  },
  async verify(f, err){
    const gid = route().gid;
    await api("POST", "/api/group", { op: "verify", g: gid, passcode: f.passcode });
    S.home = null; await loadGroup(gid); render();
  },
  async rename(f){ const inp = V.querySelector("#sn"); inp.blur(); },
};
V.addEventListener("submit", async ev => {
  const form = ev.target.closest("form[data-form]");
  if (!form || !FORMS[form.dataset.form]) return;
  ev.preventDefault();
  const err = form.querySelector(".err");
  const btn = form.querySelector("[type=submit]");
  if (err) err.textContent = "";
  if (btn) btn.disabled = true;
  try { await FORMS[form.dataset.form](Object.fromEntries(new FormData(form)), err || { set textContent(v){ toast(v); } }); }
  catch (e){
    handleErr(e, err);
    if (e.data && e.data.badPasscode){ S.ui.choose = null; S.ui.pc = ""; S.ui.claim = null; }
  }
  finally { if (btn && document.contains(btn)) btn.disabled = false; }
});

/* ---------- live updates ---------- */
let polling = false;
async function poll(){
  const r = route();
  if (polling || document.visibilityState !== "visible" || DLG.open || !S.user) return;
  if (!r.gid || r.sec === "expense" || r.sec === "pay" || r.sec === "leave") return;
  const g = S.g[r.gid];
  if (!g || !g.meta) return;
  const a = document.activeElement;
  if (a && a !== document.body && a.matches("input,select,textarea")) return;
  polling = true;
  try {
    const before = new Set(g.entries.map(e => e.id + ":" + (e.editedAt || e.createdAt)));
    if (await loadGroup(r.gid, true)){
      const ng = S.g[r.gid];
      if (ng.meta) S.fresh = new Set(ng.entries.filter(e => !before.has(e.id + ":" + (e.editedAt || e.createdAt))).map(e => e.id));
      const y = window.scrollY; await render(); window.scrollTo(0, y);
    }
    const off = V.querySelector("#offline"); if (off) off.hidden = true;
  } catch (e){
    if (e.status === 0){ const off = V.querySelector("#offline"); if (off){ off.textContent = "You're offline. Changes from others will show up when you reconnect."; off.hidden = false; } }
    else if (e.status === 401 || e.status === 403 || e.status === 404){ delete S.g[r.gid]; render(); }
  } finally { polling = false; }
}
setInterval(poll, POLL_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !S.user) return;
  const r = route();
  if (r.gid) poll();
  else if (!r.v){ S.home = null; render(); }
});

let tt;
function toast(t){
  let el = document.querySelector(".toast");
  if (!el){ el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.textContent = t; el.hidden = false; clearTimeout(tt); tt = setTimeout(() => el.hidden = true, 2800);
}

render();
})();
