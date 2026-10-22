(() => {
"use strict";
const $ = s => document.querySelector(s);
const PALETTE = ["#2f3fa0","#b4412c","#18794e","#8a4fb3","#b07a12","#1f7f93","#c2417c","#4d6178"];
const POLL_MS = 8000;
const LS = { pass: "contri.passcode", me: "contri.me" };

const state = { people: [], entries: [], log: [], trash: [], backups: [], meta: { name: "Our Spending", currency: "USD" }, version: null, filter: "all", q: "", loaded: false };
let pass = lsGet(LS.pass), me = lsGet(LS.me), seen = new Set(), firstLoad = true;

function lsGet(k){ try { return localStorage.getItem(k) || ""; } catch { return ""; } }
function lsSet(k, v){ try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} }

/* ---------- API ---------- */
class ApiError extends Error { constructor(status, msg){ super(msg); this.status = status; } }
async function api(method, body, query = "", path = "/api/data"){
  let res;
  try {
    res = await fetch(path + query, { method, cache: "no-store",
      headers: { "content-type": "application/json", "x-passcode": pass, "x-who": me || "" },
      body: body ? JSON.stringify(body) : undefined });
  } catch { throw new ApiError(0, "You're offline. Check your connection and try again."); }
  let data = {}; try { data = await res.json(); } catch {}
  if (!res.ok) throw new ApiError(res.status, data.error || "Something went wrong. Try again.");
  return data;
}
async function load(force){
  const data = await api("GET", null, !force && state.version !== null ? "?v=" + state.version : "");
  if (data.unchanged) return false;
  state.version = data.version;
  state.people = (data.people || []).sort((a,b) => (a.order||0) - (b.order||0));
  state.entries = data.entries || [];
  state.log = data.log || [];
  state.trash = data.trash || [];
  state.backups = data.backups || [];
  state.meta = data.meta || state.meta;
  state.loaded = true;
  fmtCache = {};
  return true;
}
async function change(body, okMsg){
  try { await api("POST", body); await load(true); route(); if (okMsg) toast(okMsg); return true; }
  catch (e){ handleErr(e); return false; }
}
function handleErr(e){
  if (e.status === 401){ lsSet(LS.pass, ""); pass = ""; showPass("The passcode changed or isn't right. Enter it again."); return; }
  toast(e.message);
}

/* ---------- money (integer cents) ---------- */
const toCents = v => Math.round(parseFloat(v || 0) * 100);
let fmtCache = {};
function fmt(c, signed){
  const cur = state.meta.currency || "USD";
  const f = fmtCache[cur] || (fmtCache[cur] = new Intl.NumberFormat(undefined, { style: "currency", currency: cur }));
  const s = f.format(Math.abs(c) / 100);
  return signed ? (c > 0 ? "+" : c < 0 ? "−" : "") + s : (c < 0 ? "−" + s : s);
}
function curSymbol(){ try { return (0).toLocaleString(undefined, { style: "currency", currency: state.meta.currency, minimumFractionDigits: 0 }).replace(/[\d\s.,]/g, "") || "$"; } catch { return "$"; } }
function splitEven(total, ids){
  const n = ids.length, base = Math.floor(total / n); let rem = total - base * n; const out = {};
  ids.forEach(id => { out[id] = base + (rem > 0 ? 1 : 0); if (rem > 0) rem--; });
  return out;
}
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const uid = () => (Math.random().toString(36).slice(2, 10) + Date.now().toString(36)).replace(/[^a-z0-9]/g, "").slice(0, 24);
const personById = id => state.people.find(p => p.id === id);
const pName = id => personById(id)?.name || "Someone";
const initials = n => (n || "?").trim().split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
const dot = p => `<span class="dot" style="background:${esc(p?.color || "#4d6178")}" aria-hidden="true">${esc(initials(p?.name))}</span>`;
function ago(t){
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " hr ago";
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* ---------- derived ---------- */
function balances(){
  const b = {}; const get = id => b[id] || (b[id] = { net: 0, paid: 0, share: 0 });
  state.people.forEach(p => get(p.id));
  for (const e of state.entries){
    get(e.paidBy).net += e.amount;
    if (e.type !== "payment") get(e.paidBy).paid += e.amount;
    for (const [id, c] of Object.entries(e.split || {})){ get(id).net -= c; if (e.type !== "payment") get(id).share += c; }
  }
  return b;
}
function settlePlan(b){
  const cred = [], debt = [];
  for (const [id, v] of Object.entries(b)){ if (v.net > 0) cred.push({ id, c: v.net }); else if (v.net < 0) debt.push({ id, c: -v.net }); }
  cred.sort((a, z) => z.c - a.c); debt.sort((a, z) => z.c - a.c);
  const out = []; let i = 0, j = 0;
  while (i < debt.length && j < cred.length){
    const x = Math.min(debt[i].c, cred[j].c);
    if (x > 0) out.push({ from: debt[i].id, to: cred[j].id, c: x });
    debt[i].c -= x; cred[j].c -= x;
    if (!debt[i].c) i++; if (!cred[j].c) j++;
  }
  return out;
}
const referenced = id => state.entries.some(e => e.paidBy === id || (e.split && id in e.split));

/* ---------- screens ---------- */
function show(which){ $("#gatePass").hidden = which !== "pass"; $("#gateWho").hidden = which !== "who"; $("#app").hidden = which !== "app"; }
function showPass(msg){ show("pass"); $("#passErr").textContent = msg || ""; $("#passIn").value = ""; setTimeout(() => $("#passIn").focus(), 50); }
function route(){
  if (!personById(me)){ renderWho(); show("who"); return; }
  show("app"); render();
}
function renderWho(){
  const empty = !state.people.length;
  $("#whoTitle").textContent = empty ? "Start your group" : "Who are you?";
  $("#whoSub").textContent = empty
    ? "Add your name first. You'll add everyone else next, and they can also join themselves when they open the link."
    : "Your name goes on every expense you log or change, so the group can see who did what.";
  $("#whoList").innerHTML = state.people.map(p => `<button type="button" class="who-btn" data-me="${esc(p.id)}">${dot(p)}${esc(p.name)}</button>`).join("");
  $("#whoList").querySelectorAll("[data-me]").forEach(b => b.onclick = () => { me = b.dataset.me; lsSet(LS.me, me); route(); });
  $("#whoNew").placeholder = empty ? "Your name" : "Not listed? Add your name";
}

/* ---------- render ---------- */
function render(){
  if (document.activeElement !== $("#groupName")) $("#groupName").value = state.meta.name;
  $("#currency").value = state.meta.currency;
  document.title = state.meta.name && state.meta.name !== "Our Spending" ? `${state.meta.name} · Contri` : "Contri";
  $("#meName").textContent = pName(me);
  const b = balances();
  const exp = state.entries.filter(e => e.type !== "payment");
  const total = exp.reduce((s, e) => s + e.amount, 0);
  $("#summary").textContent = exp.length ? `${exp.length} expense${exp.length > 1 ? "s" : ""} · ${fmt(total)} spent together` : "No expenses yet";
  const few = state.people.length < 2;
  $("#btnAdd").disabled = few; $("#btnSettle").disabled = few;
  $("#btnAdd").title = few ? "Add at least two people first" : "";
  renderBalances(b); renderSettles(b); renderPeople(); renderActivity(); renderFilter(); renderLedger(); renderSafety();
  firstLoad = false;
}
function renderBalances(b){
  const el = $("#balances");
  if (!state.people.length){ el.innerHTML = `<div class="sub">Balances show up once you add people.</div>`; return; }
  const max = Math.max(1, ...state.people.map(p => Math.abs(b[p.id]?.net || 0)));
  el.innerHTML = state.people.map(p => {
    const v = b[p.id] || { net: 0, paid: 0, share: 0 }; const w = Math.abs(v.net) / max * 50;
    const cls = v.net > 0 ? "amt-pos" : v.net < 0 ? "amt-neg" : "amt-zero";
    const word = v.net > 0 ? "gets back" : v.net < 0 ? "owes" : "is even";
    return `<div class="bal-row">
      <div class="who">${dot(p)}<span class="who-name" title="${esc(p.name)}">${esc(p.name)}</span></div>
      <div class="track" role="img" aria-label="${esc(p.name)} ${word} ${fmt(Math.abs(v.net))}"><div class="fill ${v.net >= 0 ? "pos" : "neg"}" style="width:${w}%"></div></div>
      <div class="num ${cls}">${fmt(v.net, true)}</div>
      <div class="bal-meta">Paid ${fmt(v.paid)} · share ${fmt(v.share)}</div>
    </div>`;
  }).join("");
}
function renderSettles(b){
  const el = $("#settles"); const plan = settlePlan(b);
  if (state.people.length < 2){ el.innerHTML = `<div class="sub">Add at least two people to start splitting.</div>`; return; }
  if (!plan.length){ el.innerHTML = `<div class="allsquare">✓ Everyone is square</div>`; return; }
  el.innerHTML = plan.map((s, i) => `<div class="settle">
      <div class="settle-txt"><b>${esc(pName(s.from))}</b> pays <b>${esc(pName(s.to))}</b><div class="num" style="font-size:17px;font-weight:600">${fmt(s.c)}</div></div>
      <button class="btn" type="button" data-settle="${i}">Mark paid</button>
    </div>`).join("");
  el.querySelectorAll("[data-settle]").forEach(btn => btn.onclick = () => openPay(null, plan[+btn.dataset.settle]));
}
function renderPeople(){
  $("#pcount").textContent = state.people.length || "";
  const el = $("#people");
  if (!state.people.length){ el.innerHTML = `<div class="sub">Add everyone who shares costs.</div>`; return; }
  el.innerHTML = state.people.map(p => {
    const locked = referenced(p.id) || p.id === me;
    const why = p.id === me ? "That's you" : referenced(p.id) ? "Has entries, so can't be removed" : "Remove " + p.name;
    return `<span class="chip">${dot(p)}${esc(p.name)}${p.id === me ? `<span class="you">you</span>` : ""}<button type="button" data-rm="${esc(p.id)}" ${locked ? "disabled" : ""} title="${esc(why)}" aria-label="${esc(why)}">×</button></span>`;
  }).join("");
  el.querySelectorAll("[data-rm]").forEach(x => x.onclick = () => removePerson(x.dataset.rm));
}
function setActOpen(open){
  $("#actToggle").setAttribute("aria-expanded", open); $("#activity").hidden = !open;
}
$("#actToggle").onclick = () => {
  const open = $("#actToggle").getAttribute("aria-expanded") !== "true";
  setActOpen(open); lsSet("contri.actOpen", open ? "1" : "");
};
setActOpen(lsGet("contri.actOpen") === "1");
function renderActivity(){
  const n = state.log.length;
  $("#actCount").textContent = n ? `${n >= 100 ? "100+" : n} change${n === 1 ? "" : "s"}` : "Every change";
  const el = $("#activity");
  if (!state.log.length){ el.innerHTML = `<li><span></span><span class="sub">Changes show up here as people add, edit and delete entries.</span></li>`; return; }
  el.innerHTML = state.log.slice(0, 20).map(a => {
    const who = personById(a.by); const name = who ? who.name : "Someone";
    let what = "";
    const thing = a.type === "payment" ? `a ${fmt(a.amount)} payment from ${esc(pName(a.from))} to ${esc(pName(a.to))}` : `<b>${esc(a.desc)}</b> (${fmt(a.amount)})`;
    switch (a.action){
      case "added": what = `added ${thing}`; break;
      case "edited": what = `edited ${thing}${a.before !== undefined ? `, was ${fmt(a.before)}` : ""}`; break;
      case "deleted": what = `<span class="del">deleted</span> ${thing}`; break;
      case "joined": what = `added <b>${esc(a.name)}</b> to the group`; break;
      case "self-joined": what = "joined the group"; break;
      case "renamed": what = `renamed someone to <b>${esc(a.name)}</b>`; break;
      case "removed person": what = `removed <b>${esc(a.name)}</b>`; break;
      case "settings": what = `changed the group settings`; break;
      case "restored": what = `restored ${thing}`; break;
      case "restored backup": what = `restored the backup from <b>${esc(a.name)}</b>`; break;
      default: what = "made a change";
    }
    return `<li>${who ? dot(who) : dot(null)}<div><div class="act-txt"><b>${esc(name)}</b> ${what}</div><div class="act-time">${esc(ago(a.t))}</div></div></li>`;
  }).join("");
}
function renderFilter(){
  const el = $("#personFilter");
  const opts = [{ id: "all", name: "Everyone" }, ...state.people];
  if (!opts.some(o => o.id === state.filter)) state.filter = "all";
  el.innerHTML = opts.map(o => `<button type="button" data-f="${esc(o.id)}" aria-pressed="${state.filter === o.id}">${esc(o.name)}</button>`).join("");
  el.hidden = state.people.length < 2;
  el.querySelectorAll("[data-f]").forEach(x => x.onclick = () => { state.filter = x.dataset.f; renderFilter(); renderLedger(); });
}
function renderLedger(){
  const el = $("#ledger");
  if (state.people.length < 2){
    el.innerHTML = `<div class="empty"><img class="empty-art" src="/assets/empty.webp" width="640" height="592" alt="A person checking a receipt on her phone"><h3>Start with who's sharing</h3><div>Add each person in the People panel, or send them the link so they can join. Then log expenses as they happen, and everyone sees the same balances.</div></div>`; return;
  }
  if (!state.entries.length){
    el.innerHTML = `<div class="empty"><img class="empty-art" src="/assets/empty.webp" width="640" height="592" alt="A person checking a receipt on her phone"><h3>No expenses yet</h3><div>Log the first one: who paid, how much, and who it was for.</div><button class="btn primary" type="button" id="firstAdd">Add expense</button></div>`;
    $("#firstAdd").onclick = () => openExpense(null); return;
  }
  const q = state.q.trim().toLowerCase();
  const list = state.entries
    .filter(e => state.filter === "all" || e.paidBy === state.filter || (e.split && state.filter in e.split))
    .filter(e => !q || [e.desc, e.note, e.category].some(x => (x || "").toLowerCase().includes(q)))
    .sort((a, z) => (z.date || "").localeCompare(a.date || "") || (z.createdAt || 0) - (a.createdAt || 0));
  if (!list.length){ el.innerHTML = `<div class="empty"><div>Nothing matches that search.</div></div>`; return; }
  const groups = new Map();
  for (const e of list){ const k = (e.date || "").slice(0, 7); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
  let html = "";
  for (const [k, es] of groups){
    const [y, m] = k.split("-").map(Number);
    const label = new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const tot = es.filter(e => e.type !== "payment").reduce((s, e) => s + e.amount, 0);
    html += `<section class="month"><div class="month-head"><h3>${esc(label)}</h3><span class="num sub">${fmt(tot)} spent</span></div>`;
    for (const e of es) html += entryHtml(e);
    html += `</section>`;
  }
  el.innerHTML = html;
  state.entries.forEach(e => seen.add(e.id + ":" + (e.editedAt || e.createdAt)));
  el.querySelectorAll("[data-rx]").forEach(x => x.onclick = () => openViewer(state.entries.find(z => z.id === x.dataset.rx)));
  el.querySelectorAll("[data-edit]").forEach(x => x.onclick = () => {
    const e = state.entries.find(z => z.id === x.dataset.edit); if (!e) return;
    e.type === "payment" ? openPay(e) : openExpense(e);
  });
}
function entryHtml(e){
  const d = new Date((e.date || today()) + "T12:00:00");
  const fresh = !firstLoad && !seen.has(e.id + ":" + (e.editedAt || e.createdAt));
  const fp = state.filter !== "all" ? state.filter : null;
  let mine = "";
  if (fp){
    const delta = (e.paidBy === fp ? e.amount : 0) - ((e.split || {})[fp] || 0);
    if (delta) mine = `<div class="e-you num ${delta > 0 ? "amt-pos" : "amt-neg"}">${esc(pName(fp))} ${fmt(delta, true)}</div>`;
  }
  const short = t => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const prov = `<div class="prov">Logged by ${esc(pName(e.addedBy))}${e.createdAt ? " on " + esc(short(e.createdAt)) : ""}${e.editedAt ? ` · edited by ${esc(pName(e.editedBy))} ${esc(short(e.editedAt))}` : ""}</div>`;
  const actions = `<div class="e-actions"><button class="btn ghost" type="button" data-edit="${esc(e.id)}">Edit</button></div>`;
  const dateCol = `<div class="date"><b>${d.getDate()}</b><span>${esc(d.toLocaleDateString(undefined, { weekday: "short" }))}</span></div>`;
  if (e.type === "payment"){
    const to = Object.keys(e.split || {})[0];
    return `<div class="entry${fresh ? " fresh" : ""}">${dateCol}
      <div class="e-main"><div class="e-title"><span class="tag pay">Payment</span>${esc(pName(e.paidBy))} paid ${esc(pName(to))}</div>
      ${e.note ? `<div class="e-line">${esc(e.note)}</div>` : ""}${rxChip(e)}${prov}</div>
      <div class="e-right"><div class="num e-amt">${fmt(e.amount)}</div>${mine}${actions}</div></div>`;
  }
  const modeTxt = e.mode === "exact" ? "exact amounts" : e.mode === "percent" ? "by percentage" : "equally";
  const splits = Object.entries(e.split || {}).map(([id, c]) => `<span>${esc(pName(id))} <span class="num">${fmt(c)}</span></span>`).join("");
  return `<div class="entry${fresh ? " fresh" : ""}">${dateCol}
    <div class="e-main"><div class="e-title"><span class="tag">${esc(e.category || "Other")}</span>${esc(e.desc || "Untitled")}</div>
    <div class="e-line">${esc(pName(e.paidBy))} paid · split ${modeTxt}${e.note ? " · " + esc(e.note) : ""}</div>
    <div class="splits">${splits}</div>${rxChip(e)}${prov}</div>
    <div class="e-right"><div class="num e-amt">${fmt(e.amount)}</div>${mine}${actions}</div></div>`;
}

/* ---------- people & settings ---------- */
function newPerson(name){
  const used = new Set(state.people.map(p => p.color));
  const color = PALETTE.find(c => !used.has(c)) || PALETTE[state.people.length % PALETTE.length];
  return { id: uid(), name, color, order: Date.now() };
}
$("#addPerson").addEventListener("submit", async ev => {
  ev.preventDefault();
  const name = $("#newPerson").value.trim(); if (!name) return;
  if (await change({ op: "putPerson", person: newPerson(name) }, `Added ${name}`)) $("#newPerson").value = "";
});
$("#fWhoNew").addEventListener("submit", async ev => {
  ev.preventDefault();
  const name = $("#whoNew").value.trim(); if (!name){ $("#whoErr").textContent = "Enter your name."; return; }
  const p = newPerson(name);
  try { await api("POST", { op: "putPerson", person: p }); }
  catch (e){ if (e.status === 401) return handleErr(e); $("#whoErr").textContent = e.message; return; }
  me = p.id; lsSet(LS.me, me); $("#whoNew").value = ""; $("#whoErr").textContent = "";
  await load(true); route(); toast(`Welcome, ${name}`);
});
async function removePerson(id){ if (!referenced(id) && id !== me) await change({ op: "delPerson", id }, "Removed"); }
$("#btnSwitch").onclick = () => { me = ""; lsSet(LS.me, ""); route(); };
let nameTimer, lastMeta = "";
$("#groupName").addEventListener("input", () => { clearTimeout(nameTimer); nameTimer = setTimeout(saveMeta, 900); });
$("#groupName").addEventListener("blur", () => { clearTimeout(nameTimer); saveMeta(); });
$("#currency").addEventListener("change", saveMeta);
async function saveMeta(){
  const m = { name: $("#groupName").value.trim() || "Our Spending", currency: $("#currency").value };
  const key = JSON.stringify(m);
  if (key === lastMeta || (m.name === state.meta.name && m.currency === state.meta.currency)) return;
  lastMeta = key;
  await change({ op: "putMeta", meta: m });
}

/* ---------- expense dialog ---------- */
const dx = $("#dlgExpense"); let editing = null, mode = "equal";
const peopleOpts = () => state.people.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
function openExpense(e){
  editing = e; $("#fxErr").textContent = "";
  $("#fxTitle").textContent = e ? "Edit expense" : "Add expense";
  $("#fxSave").textContent = e ? "Save changes" : "Save expense";
  $("#fxDelete").hidden = !e; $("#fxDelete").textContent = "Delete"; $("#fxDelete").dataset.arm = "";
  $("#fxCur").textContent = curSymbol();
  $("#fxDesc").value = e?.desc || ""; $("#fxAmt").value = e ? (e.amount / 100).toFixed(2) : "";
  $("#fxDate").value = e?.date || today(); $("#fxNote").value = e?.note || "";
  fillCategories(e?.category || "Groceries");
  rxItems = (e?.receipts || []).map(id => ({ id, existing: true })); renderRx();
  $("#fxPayer").innerHTML = peopleOpts();
  $("#fxPayer").value = e?.paidBy || (personById(me) ? me : state.people[0]?.id);
  buildParts(e); setMode(e?.mode || "equal");
  dx.showModal(); if (!e) $("#fxDesc").focus();
}
function buildParts(e){
  $("#fxParts").innerHTML = state.people.map(p => {
    const inc = e ? (e.split && p.id in e.split) : true;
    let v = "";
    if (e && inc){ v = e.mode === "exact" ? (e.split[p.id] / 100).toFixed(2) : e.mode === "percent" ? (e.pct?.[p.id] ?? (e.split[p.id] / e.amount * 100).toFixed(2)) : ""; }
    return `<div class="part" data-id="${esc(p.id)}">
      <label>${dot(p)}<input type="checkbox" ${inc ? "checked" : ""} aria-label="Include ${esc(p.name)}"><span>${esc(p.name)}</span></label>
      <div><span class="share num"></span><input type="number" step="0.01" min="0" inputmode="decimal" value="${esc(v)}" aria-label="${esc(p.name)} share" hidden></div>
    </div>`;
  }).join("");
  $("#fxParts").querySelectorAll("input").forEach(i => i.addEventListener("input", updateCheck));
}
function setMode(m){
  mode = m;
  $("#fxMode").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.m === m));
  $("#fxParts").querySelectorAll(".part").forEach(row => {
    const num = row.querySelector("input[type=number]"), share = row.querySelector(".share");
    num.hidden = m === "equal"; share.hidden = m !== "equal"; num.placeholder = m === "percent" ? "%" : "0.00";
  });
  updateCheck();
}
$("#fxMode").addEventListener("click", ev => { const b = ev.target.closest("button[data-m]"); if (b) setMode(b.dataset.m); });
$("#fxAmt").addEventListener("input", updateCheck);
function computeSplit(){
  const total = toCents($("#fxAmt").value);
  const rows = [...$("#fxParts").querySelectorAll(".part")].map(r => ({ id: r.dataset.id, on: r.querySelector("input[type=checkbox]").checked, v: r.querySelector("input[type=number]").value, row: r }));
  const on = rows.filter(r => r.on);
  if (mode === "equal"){
    const s = on.length && total ? splitEven(total, on.map(r => r.id)) : {};
    return { total, split: s, rows, ok: total > 0 && on.length > 0 && Object.values(s).every(c => c > 0),
      msg: on.length ? `About ${fmt(Math.floor(total / on.length))} each across ${on.length}` : "Pick at least one person" };
  }
  if (mode === "exact"){
    const s = {}; let sum = 0; on.forEach(r => { const c = toCents(r.v); if (c > 0){ s[r.id] = c; sum += c; } });
    const diff = total - sum;
    return { total, split: s, rows, ok: total > 0 && diff === 0 && Object.keys(s).length > 0,
      msg: diff === 0 ? "Adds up exactly" : diff > 0 ? `${fmt(diff)} left to assign` : `${fmt(-diff)} over the total` };
  }
  const pct = {}; let psum = 0; on.forEach(r => { const p = parseFloat(r.v) || 0; if (p > 0){ pct[r.id] = p; psum += p; } });
  const ids = Object.keys(pct); const s = {}; let acc = 0;
  ids.forEach((id, i) => { const c = i === ids.length - 1 ? total - acc : Math.round(total * pct[id] / 100); s[id] = c; acc += c; });
  const okp = Math.abs(psum - 100) < 0.001;
  return { total, split: s, pct, rows, ok: total > 0 && okp && ids.length > 0 && Object.values(s).every(c => c > 0),
    msg: okp ? "Totals 100%" : `Percentages total ${+psum.toFixed(2)}%, need 100%` };
}
function updateCheck(){
  const r = computeSplit();
  r.rows.forEach(x => { x.row.querySelector(".share").textContent = x.on ? fmt(r.split[x.id] || 0) : "–"; x.row.querySelector("input[type=number]").disabled = !x.on; });
  const c = $("#fxCheck"); c.textContent = r.total ? r.msg : "Enter an amount to see the split";
  c.className = "check " + (r.total ? (r.ok ? "ok" : "bad") : "");
}
$("#fExpense").addEventListener("submit", async ev => {
  ev.preventDefault();
  const desc = $("#fxDesc").value.trim(), r = computeSplit();
  if (!desc){ $("#fxErr").textContent = "Add a short description so everyone knows what this was."; $("#fxDesc").focus(); return; }
  if (!r.total){ $("#fxErr").textContent = "Enter an amount above zero."; $("#fxAmt").focus(); return; }
  if (!r.ok){ $("#fxErr").textContent = "The split doesn't match the total yet. " + r.msg + "."; return; }
  const isNewCat = $("#fxCat").value === NEW_CAT;
  const category = isNewCat ? $("#fxCatNew").value.trim().replace(/\s+/g, " ") : $("#fxCat").value;
  if (!category){ $("#fxErr").textContent = "Type a name for the new category."; $("#fxCatNew").focus(); return; }
  if (rxItems.some(x => x.busy)){ $("#fxErr").textContent = "Wait a moment, a photo is still being prepared."; return; }
  $("#fxSave").disabled = true;
  try { await uploadRx(); }
  catch (e){ $("#fxSave").disabled = false; if (e.status === 401){ dx.close(); return handleErr(e); } $("#fxErr").textContent = e.message; return; }
  $("#fxSave").disabled = false;
  const entry = { id: editing?.id || uid(), type: "expense", desc, amount: r.total, date: $("#fxDate").value || today(),
    category, receipts: rxItems.map(x => x.id), paidBy: $("#fxPayer").value, mode, split: r.split, note: $("#fxNote").value.trim() };
  if (mode === "percent") entry.pct = r.pct;
  await save(entry, dx, $("#fxErr"));
});
$("#fxDelete").addEventListener("click", () => armDelete($("#fxDelete"), dx, $("#fxErr")));

/* ---------- categories ---------- */
const BUILT_IN = ["Groceries","Dining","Rent","Utilities","Travel","Transport","Shopping","Fun","Health","Other"];
const NEW_CAT = "__new__";
function fillCategories(current){
  const used = state.entries.filter(e => e.type !== "payment" && e.category).map(e => e.category);
  const custom = [...new Set(used.filter(c => !BUILT_IN.some(b => b.toLowerCase() === c.toLowerCase())))].sort((a, z) => a.localeCompare(z));
  const all = [...BUILT_IN.filter(c => c !== "Other"), ...custom, "Other"];
  if (current && !all.includes(current)) all.splice(all.length - 1, 0, current);
  $("#fxCat").innerHTML = all.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("") + `<option value="${NEW_CAT}">+ New category…</option>`;
  $("#fxCat").value = current || "Groceries";
  $("#fxCatNew").value = ""; $("#fxCatNew").hidden = true;
}
$("#fxCat").addEventListener("change", () => {
  const isNew = $("#fxCat").value === NEW_CAT;
  $("#fxCatNew").hidden = !isNew; if (isNew) $("#fxCatNew").focus();
});

/* ---------- receipt photos ---------- */
const MAX_RX = 4;
let rxItems = [];            // {id, existing} or {id, dataUrl} or {id, busy}
const rxCache = new Map();   // id -> data URL
function rxChip(e){
  const n = (e.receipts || []).length;
  if (!n) return "";
  return `<button type="button" class="rx-chip" data-rx="${esc(e.id)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 01-7.8-7.8l8.6-8.6a3.7 3.7 0 015.2 5.2l-8.6 8.6a1.8 1.8 0 01-2.6-2.6l7.9-7.9"/></svg>${n === 1 ? "Receipt" : n + " photos"}</button>`;
}
async function getRx(id){
  if (rxCache.has(id)) return rxCache.get(id);
  const d = await api("GET", null, "?id=" + encodeURIComponent(id), "/api/receipt");
  rxCache.set(id, d.data); return d.data;
}
function renderRx(){
  const el = $("#fxRx");
  el.innerHTML = rxItems.map((x, i) => `<div class="rx">${x.busy ? `<span class="busy">Preparing…</span>` : `<img alt="Photo ${i + 1}" data-i="${i}">`}<button type="button" data-rm="${i}" aria-label="Remove photo ${i + 1}">×</button></div>`).join("");
  el.querySelectorAll("img[data-i]").forEach(img => {
    const x = rxItems[+img.dataset.i];
    if (x.dataUrl) img.src = x.dataUrl;
    else getRx(x.id).then(u => { img.src = u; }).catch(() => { img.alt = "Couldn't load"; });
  });
  el.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { rxItems.splice(+b.dataset.rm, 1); renderRx(); });
  $("#fxAddRx").hidden = rxItems.length >= MAX_RX;
  $("#fxRxHint").textContent = rxItems.length >= MAX_RX ? "That's the maximum of 4 photos." : "Up to 4. Photos are shrunk before uploading.";
}
$("#fxAddRx").onclick = () => $("#fxFiles").click();
$("#fxFiles").addEventListener("change", async ev => {
  const files = [...ev.target.files].slice(0, MAX_RX - rxItems.length);
  ev.target.value = "";
  for (const f of files){
    const item = { id: uid(), busy: true }; rxItems.push(item); renderRx();
    try { item.dataUrl = await shrink(f); delete item.busy; }
    catch { rxItems.splice(rxItems.indexOf(item), 1); toast("Couldn't read that photo. Try a JPEG or PNG."); }
    renderRx();
  }
});
async function shrink(file){
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    for (const [side, q] of [[1600, 0.72], [1200, 0.62], [900, 0.55]]){
      const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      const out = c.toDataURL("image/jpeg", q);
      if (out.length < 900_000) return out;
    }
    throw new Error("too big");
  } finally { URL.revokeObjectURL(url); }
}
async function uploadRx(){
  for (const x of rxItems){
    if (!x.dataUrl || x.uploaded) continue;
    await api("POST", { id: x.id, data: x.dataUrl }, "", "/api/receipt");
    x.uploaded = true; rxCache.set(x.id, x.dataUrl);
  }
}
const dv = $("#dlgView");
async function openViewer(e){
  if (!e) return;
  const ids = e.receipts || [];
  $("#vwTitle").textContent = `${e.desc || "Payment"} · ${ids.length === 1 ? "receipt" : ids.length + " photos"}`;
  $("#vwList").innerHTML = ids.map((id, i) => `<img alt="Photo ${i + 1} for ${esc(e.desc || "this entry")}" data-id="${esc(id)}" width="800" height="600">`).join("");
  dv.showModal();
  $("#vwList").querySelectorAll("img").forEach(img => getRx(img.dataset.id).then(u => { img.src = u; img.removeAttribute("width"); img.removeAttribute("height"); })
    .catch(err => { if (err.status === 401){ dv.close(); handleErr(err); } else img.replaceWith(Object.assign(document.createElement("p"), { className: "sub", textContent: err.message })); }));
}

/* ---------- payment dialog ---------- */
const dp = $("#dlgPay");
function openPay(e, sugg){
  editing = e; $("#fpErr").textContent = "";
  $("#fpTitle").textContent = e ? "Edit payment" : "Record a payment";
  $("#fpDelete").hidden = !e; $("#fpDelete").textContent = "Delete"; $("#fpDelete").dataset.arm = "";
  $("#fpCur").textContent = curSymbol();
  $("#fpFrom").innerHTML = peopleOpts(); $("#fpTo").innerHTML = peopleOpts();
  $("#fpFrom").value = e?.paidBy || sugg?.from || (personById(me) ? me : state.people[0]?.id);
  $("#fpTo").value = (e && Object.keys(e.split || {})[0]) || sugg?.to || state.people.find(p => p.id !== $("#fpFrom").value)?.id;
  $("#fpAmt").value = e ? (e.amount / 100).toFixed(2) : sugg ? (sugg.c / 100).toFixed(2) : "";
  $("#fpDate").value = e?.date || today(); $("#fpNote").value = e?.note || "";
  dp.showModal();
}
$("#fPay").addEventListener("submit", async ev => {
  ev.preventDefault();
  const from = $("#fpFrom").value, to = $("#fpTo").value, amt = toCents($("#fpAmt").value);
  if (from === to){ $("#fpErr").textContent = "Pick two different people."; return; }
  if (!amt){ $("#fpErr").textContent = "Enter an amount above zero."; return; }
  await save({ id: editing?.id || uid(), type: "payment", amount: amt, date: $("#fpDate").value || today(), paidBy: from, split: { [to]: amt }, note: $("#fpNote").value.trim() }, dp, $("#fpErr"));
});
$("#fpDelete").addEventListener("click", () => armDelete($("#fpDelete"), dp, $("#fpErr")));

async function save(entry, dlg, errEl){
  const wasEdit = !!editing;
  try { await api("POST", { op: "putEntry", entry }); }
  catch (e){ if (e.status === 401){ dlg.close(); return handleErr(e); } errEl.textContent = e.message; return; }
  dlg.close(); await load(true).catch(() => {}); route();
  toast(wasEdit ? "Saved changes" : entry.type === "payment" ? "Payment recorded" : "Expense added");
}
async function armDelete(btn, dlg, errEl){
  if (!btn.dataset.arm){ btn.dataset.arm = "1"; btn.textContent = "Tap again to delete"; return; }
  try { await api("POST", { op: "delEntry", id: editing.id }); }
  catch (e){ if (e.status === 401){ dlg.close(); return handleErr(e); } errEl.textContent = e.message; return; }
  dlg.close(); await load(true).catch(() => {}); route(); toast("Moved to Recently deleted");
}
/* ---------- backup, bin and export ---------- */
const dt = $("#dlgTrash"), db2 = $("#dlgBackups");
function renderSafety(){
  $("#trashN").textContent = state.trash.length ? `(${state.trash.length})` : "";
  $("#backupN").textContent = state.backups.length ? `(${state.backups.length})` : "";
  if (dt.open) renderTrash();
  if (db2.open) renderBackups();
}
const shortDate = t => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
function renderTrash(){
  const el = $("#trList");
  if (!state.trash.length){ el.innerHTML = `<li class="bk-empty">Nothing here. Deleted items show up here for 30 days.</li>`; return; }
  el.innerHTML = state.trash.map(e => {
    const title = e.type === "payment" ? `${pName(e.paidBy)} paid ${pName(Object.keys(e.split || {})[0])}` : (e.desc || "Untitled");
    const left = Math.max(0, 30 - Math.floor((Date.now() - (e.deletedAt || 0)) / 86400000));
    return `<li><div class="bk-main"><span class="bk-title">${esc(title)} · <span class="num">${fmt(e.amount)}</span></span>
      <span class="bk-sub">Deleted by ${esc(pName(e.deletedBy))} on ${esc(shortDate(e.deletedAt))} · ${left} day${left === 1 ? "" : "s"} left</span></div>
      <div class="bk-btns"><button class="btn" type="button" data-restore="${esc(e.id)}">Restore</button></div></li>`;
  }).join("");
  el.querySelectorAll("[data-restore]").forEach(b => b.onclick = async () => {
    b.disabled = true; $("#trErr").textContent = "";
    try { await api("POST", { op: "restoreEntry", id: b.dataset.restore }); await load(true); route(); renderTrash(); toast("Restored"); }
    catch (e){ b.disabled = false; if (e.status === 401){ dt.close(); return handleErr(e); } $("#trErr").textContent = e.message; }
  });
}
function renderBackups(){
  const el = $("#bkList");
  if (!state.backups.length){ el.innerHTML = `<li class="bk-empty">The first backup is saved tonight. After that, one is added every day.</li>`; return; }
  el.innerHTML = state.backups.map(b => `<li><div class="bk-main"><span class="bk-title">${esc(b.label)}</span>
      <span class="bk-sub">${b.entries} entr${b.entries === 1 ? "y" : "ies"} · ${b.people} people · saved ${esc(new Date(b.t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</span></div>
      <div class="bk-btns"><button class="btn" type="button" data-dl="${esc(b.key)}">Download</button><button class="btn danger" type="button" data-rs="${esc(b.key)}">Restore</button></div></li>`).join("");
  el.querySelectorAll("[data-dl]").forEach(btn => btn.onclick = async () => {
    btn.disabled = true; $("#bkErr").textContent = "";
    try { const d = await api("GET", null, "?key=" + encodeURIComponent(btn.dataset.dl), "/api/backup");
      const b = state.backups.find(x => x.key === btn.dataset.dl);
      downloadCSV(d.backup.entries, d.backup.people, d.backup.meta, "backup-" + (b ? b.key : "copy")); }
    catch (e){ if (e.status === 401){ db2.close(); return handleErr(e); } $("#bkErr").textContent = e.message; }
    finally { btn.disabled = false; }
  });
  el.querySelectorAll("[data-rs]").forEach(btn => btn.onclick = async () => {
    const b = state.backups.find(x => x.key === btn.dataset.rs);
    if (!btn.dataset.arm){ btn.dataset.arm = "1"; btn.textContent = "Tap again to restore"; $("#bkErr").textContent = `This replaces everything with the copy from ${b ? b.label : "that day"} for everyone.`; return; }
    btn.disabled = true;
    try { await api("POST", { op: "restore", key: btn.dataset.rs }, "", "/api/backup"); await load(true); route(); renderBackups(); toast("Restored backup"); $("#bkErr").textContent = ""; }
    catch (e){ btn.disabled = false; if (e.status === 401){ db2.close(); return handleErr(e); } $("#bkErr").textContent = e.message; }
  });
}
$("#btnTrash").onclick = () => { $("#trErr").textContent = ""; renderTrash(); dt.showModal(); };
$("#btnBackups").onclick = () => { $("#bkErr").textContent = ""; renderBackups(); db2.showModal(); };
$("#btnExport").onclick = () => downloadCSV(state.entries, state.people, state.meta, "ledger");

function downloadCSV(entries, people, meta, tag){
  const names = Object.fromEntries((people || []).map(p => [p.id, p.name]));
  const nm = id => names[id] || "Removed person";
  const ids = (people || []).map(p => p.id);
  for (const e of entries || []) for (const id of [e.paidBy, ...Object.keys(e.split || {})]) if (!ids.includes(id)) ids.push(id);
  const money = c => (c / 100).toFixed(2);
  const cell = v => { const s = String(v ?? ""); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : "") + s.replace(/"/g, '""')}"` : s; };
  const head = ["Date", "Type", "Description", "Category", "Amount", "Currency", "Paid by", ...ids.map(id => `${nm(id)} share`), "Note", "Photos", "Logged by", "Logged on", "Last edited by", "Last edited on"];
  const rows = [...(entries || [])].sort((a, z) => (a.date || "").localeCompare(z.date || "")).map(e => [
    e.date, e.type === "payment" ? "Payment" : "Expense",
    e.type === "payment" ? `${nm(e.paidBy)} paid ${nm(Object.keys(e.split || {})[0])}` : e.desc,
    e.type === "payment" ? "" : (e.category || ""), money(e.amount), (meta && meta.currency) || "USD", nm(e.paidBy),
    ...ids.map(id => (e.split && id in e.split) ? money(e.split[id]) : ""),
    e.note || "", (e.receipts || []).length || "", e.addedBy ? nm(e.addedBy) : "",
    e.createdAt ? new Date(e.createdAt).toISOString().slice(0, 10) : "", e.editedBy ? nm(e.editedBy) : "", e.editedAt ? new Date(e.editedAt).toISOString().slice(0, 10) : ""]);
  const csv = "\ufeff" + [head, ...rows].map(r => r.map(cell).join(",")).join("\r\n");
  const slug = ((meta && meta.name) || "contri").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "contri";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = tag.startsWith("backup-") ? `${slug}-${tag}.csv` : `${slug}-${tag}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(entries && entries.length ? "Spreadsheet downloaded" : "Downloaded (no entries yet)");
}

document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => b.closest("dialog").close());
$("#btnAdd").onclick = () => openExpense(null);
$("#btnSettle").onclick = () => openPay(null);
$("#search").addEventListener("input", ev => { state.q = ev.target.value; renderLedger(); });

let tt;
function toast(t){
  let el = $(".toast");
  if (!el){ el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.textContent = t; el.hidden = false; clearTimeout(tt); tt = setTimeout(() => el.hidden = true, 2600);
}

/* ---------- passcode & boot ---------- */
$("#fPass").addEventListener("submit", async ev => {
  ev.preventDefault();
  const v = $("#passIn").value; if (!v){ $("#passErr").textContent = "Enter the passcode."; return; }
  pass = v; $("#passBtn").disabled = true; $("#passErr").textContent = "";
  try { await load(true); lsSet(LS.pass, pass); route(); startPolling(); }
  catch (e){ pass = ""; $("#passErr").textContent = e.message; }
  finally { $("#passBtn").disabled = false; }
});

let pollTimer = null, polling = false;
function startPolling(){
  if (pollTimer) return;
  pollTimer = setInterval(poll, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") poll(); });
}
async function poll(){
  if (polling || document.visibilityState !== "visible" || !pass || dx.open || dp.open || dv.open || db2.open) return;
  polling = true;
  try {
    if (await load(false)){
      if ($("#app").hidden && !$("#gateWho").hidden){ renderWho(); }
      else if (!$("#app").hidden){ if (!personById(me)) route(); else render(); }
    }
    $("#banner").hidden = true;
  } catch (e){
    if (e.status === 401) handleErr(e);
    else if (e.status === 0){ $("#banner").textContent = "You're offline. Changes from others will show up when you reconnect."; $("#banner").hidden = false; }
  } finally { polling = false; }
}

(async () => {
  if (!pass){ showPass(); return; }
  try { await load(true); route(); startPolling(); }
  catch (e){ if (e.status === 401){ lsSet(LS.pass, ""); pass = ""; showPass(); } else { showPass(e.message); } }
})();
})();
