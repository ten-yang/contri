// Shared helpers for the API. Files starting with "_" are not deployed as endpoints.
import { Redis } from "@upstash/redis";
import crypto from "node:crypto";

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const client = url && token ? new Redis({ url, token, automaticDeserialization: false }) : null;

// Tests can swap in an in-memory store.
export const store = () => globalThis.__ledgerStore || client;

// Test links (Vercel previews) keep their own copy of everything, so trying things out never touches the real groups.
const P = process.env.VERCEL_ENV === "production" ? "c2:" : "c2test:";

export const K = {
  user: uid => `${P}u:${uid}`,                 // profile JSON
  names: `${P}un`,                             // lower-case username -> uid
  sess: h => `${P}s:${h}`,                     // hashed session token -> uid
  userSess: uid => `${P}us:${uid}`,            // set of that user's session hashes
  userGroups: uid => `${P}ug:${uid}`,          // set of group ids
  groups: `${P}groups`,                        // every group id (for the nightly job)
  fail: (scope, who) => `${P}f:${scope}:${who}`,
  legacyLock: `${P}legacy:lock`,
  legacyDone: `${P}legacy:done`,
  g: gid => ({
    meta: `${P}g:${gid}:m`,
    people: `${P}g:${gid}:p`,       // person id -> person
    members: `${P}g:${gid}:mem`,    // uid -> person id (active members only)
    ok: `${P}g:${gid}:ok`,          // uid -> passcode version they last entered
    entries: `${P}g:${gid}:e`,
    trash: `${P}g:${gid}:t`,
    log: `${P}g:${gid}:log`,
    version: `${P}g:${gid}:v`,
    backups: `${P}g:${gid}:bk`,
    backup: key => `${P}g:${gid}:b:${key}`,
    rx: id => `${P}g:${gid}:rx:${id}`,
  }),
  // The original single-group app (read only, for moving it over).
  old: { people: "ledger:people", entries: "ledger:entries", trash: "ledger:trash", meta: "ledger:meta", log: "ledger:log", receipt: id => "ledger:receipt:" + id },
};

// The invite link for the group that existed before profiles: contri-hazel.vercel.app/g/v4Cm9Lr2Qa
export const LEGACY_GID = "v4Cm9Lr2Qa";

export const TRASH_DAYS = 30;
export const PHOTO_DAYS = 30;
export const BACKUP_KEEP = 30;
export const MAX_RECEIPTS = 4;
export const CURRENCIES = ["USD", "INR", "EUR", "GBP", "CAD"];
export const SESSION_DAYS = 180;
const ID = /^[a-z0-9]{6,32}$/;
export const GID = /^[A-Za-z0-9]{10}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const USERNAME = /^[A-Za-z0-9_.]{3,20}$/;

export class Bad extends Error { constructor(msg, status = 400, extra) { super(msg); this.status = status; this.extra = extra; } }
export const need = (cond, msg, status) => { if (!cond) throw new Bad(msg, status); };

export const parseMap = m => {
  const out = {};
  // Upstash returns HGETALL as a flat [field, value, field, value] array when auto-parsing is off.
  const pairs = Array.isArray(m)
    ? Array.from({ length: Math.floor(m.length / 2) }, (_, i) => [m[2 * i], m[2 * i + 1]])
    : Object.entries(m || {});
  for (const [k, v] of pairs) {
    try { out[k] = typeof v === "string" ? JSON.parse(v) : v; } catch { out[k] = v; }
  }
  return out;
};
export const parseJSON = (raw, fallback) => { try { return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : fallback; } catch { return fallback; } };
const str = (v, max) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
const cents = v => Number.isInteger(v) && v > 0 && v <= 100_000_000;

export const rid = (n = 16) => {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(crypto.randomBytes(n), b => a[b % 36]).join("");
};
export const newGid = () => {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return Array.from(crypto.randomBytes(10), b => a[b % a.length]).join("");
};

/* ---------- request plumbing ---------- */
export function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch { throw new Bad("Request body isn't valid JSON."); }
}
export const ipOf = req => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";

// Wraps a handler: storage check, no caching, friendly errors.
export function handle(fn) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const db = store();
    if (!db) return res.status(500).json({ error: "Storage isn't connected yet." });
    // Only accept writes from this site (blocks other websites posting on someone's behalf).
    if (req.method !== "GET" && !String(req.headers["content-type"] || "").includes("application/json"))
      return res.status(415).json({ error: "Unsupported request." });
    try {
      return await fn(req, res, db);
    } catch (err) {
      if (err instanceof Bad) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
      console.error(err);
      return res.status(500).json({ error: "Something went wrong. Try again." });
    }
  };
}

/* ---------- lockouts ---------- */
const LOCK_SECONDS = 15 * 60;
export async function checkLock(db, scope, who, max = 10) {
  const n = Number((await db.get(K.fail(scope, who))) || 0);
  if (n >= max) throw new Bad("Too many tries. Wait 15 minutes and try again.", 429);
}
export async function addFail(db, scope, who) {
  const n = Number(await db.incr(K.fail(scope, who)));
  if (n === 1) await db.expire(K.fail(scope, who), LOCK_SECONDS);
}

/* ---------- secrets ---------- */
export function hashSecret(secret, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(secret), salt, 32).toString("hex");
  return { salt, hash };
}
export function secretOk(secret, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const a = Buffer.from(crypto.scryptSync(String(secret || ""), rec.salt, 32).toString("hex"));
  const b = Buffer.from(rec.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
export function legacyPasscodeOk(given) {
  const want = process.env.GROUP_PASSCODE || "";
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(want).digest();
  return want.length > 0 && crypto.timingSafeEqual(a, b);
}
export function newRecoveryCode() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const c = Array.from(crypto.randomBytes(12), b => a[b % a.length]).join("");
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
}
export const normCode = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/* ---------- users & sessions ---------- */
export function cleanUsername(u) {
  const s = String(u || "").trim();
  need(USERNAME.test(s), "Usernames are 3 to 20 letters, numbers, dots or underscores.");
  return s;
}
export function cleanPassword(p) {
  need(typeof p === "string" && p.length >= 8, "Passwords need at least 8 characters.");
  need(p.length <= 200, "That password is too long.");
  return p;
}
export async function getUser(db, uid) { return parseJSON(await db.get(K.user(uid)), null); }
export async function putUser(db, u) { await db.set(K.user(u.id), JSON.stringify(u)); }

const COOKIE = "contri_s";
export function readCookie(req) {
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)contri_s=([A-Za-z0-9]+)/);
  return m ? m[1] : "";
}
export async function startSession(db, res, uid) {
  const tok = rid(40);
  const h = sha(tok);
  await db.set(K.sess(h), uid, { ex: SESSION_DAYS * 86400 });
  await db.sadd(K.userSess(uid), h);
  res.setHeader("Set-Cookie", `${COOKIE}=${tok}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
}
export function clearCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}
export async function endAllSessions(db, uid) {
  for (const h of (await db.smembers(K.userSess(uid))) || []) await db.del(K.sess(h));
  await db.del(K.userSess(uid));
}
// The signed-in user, or null.
export async function whoami(db, req) {
  const tok = readCookie(req);
  if (!tok) return null;
  const uid = await db.get(K.sess(sha(tok)));
  if (!uid) return null;
  return getUser(db, String(uid));
}
export async function requireUser(db, req) {
  const u = await whoami(db, req);
  if (!u) throw new Bad("Please log in again.", 401);
  return u;
}

/* ---------- groups ---------- */
export async function loadMeta(db, gid) { return fixLegacyLook(db, parseJSON(await db.get(K.g(gid).meta), null)); }
// The first group was made before groups had a look. Give it the 🏞️ it already carried in its name.
export async function fixLegacyLook(db, meta) {
  if (!meta || meta.id !== LEGACY_GID || meta.lookSet) return meta;
  meta.lookSet = true;
  if (!meta.emoji) meta.emoji = "🏞️";
  if (!meta.color) meta.color = "#1f7f93";
  const name = String(meta.name || "").replace(/\s*🏞\uFE0F?\s*/gu, " ").replace(/\s+/g, " ").trim();
  if (name) meta.name = name;
  await saveMeta(db, meta);
  return meta;
}
export async function saveMeta(db, m) { await db.set(K.g(m.id).meta, JSON.stringify(m)); }

// Checks the user belongs to the group and has entered the current passcode.
// Returns {meta, me (person id)}.
export async function memberGate(db, gid, user, { allowStale = false } = {}) {
  need(GID.test(String(gid || "")), "That group link isn't right.", 404);
  const k = K.g(gid);
  const [metaRaw, pid, okVer] = await Promise.all([db.get(k.meta), db.hget(k.members, user.id), db.hget(k.ok, user.id)]);
  const meta = parseJSON(metaRaw, null);
  if (!meta) throw new Bad("This group doesn't exist any more.", 404);
  if (!pid) throw new Bad("You're not in this group.", 403, { notMember: true });
  if (!allowStale && Number(okVer || 0) !== Number(meta.pcVer || 1)) throw new Bad("The group passcode changed. Enter the new one to continue.", 403, { needPasscode: true });
  return { meta, me: String(pid) };
}

export function publicMeta(m) {
  return { id: m.id, name: m.name, currency: m.currency, creator: m.creator, createdAt: m.createdAt, emoji: m.emoji || "", color: m.color || "" };
}

// A group's or category's look: one emoji (any, from the keyboard) and a color from a fixed set.
export const LOOK_COLORS = ["#1f7f93", "#4f6146", "#a8452a", "#b07a12", "#8a4fb3", "#2f5fa0"];
export function cleanEmoji(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  let first = s;
  try { first = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)][0].segment; } catch { first = [...s].slice(0, 2).join(""); }
  need(first.length <= 16 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(first), "Pick an emoji.");
  return first;
}
export function cleanColor(v) { return LOOK_COLORS.includes(v) ? v : ""; }

export const PALETTE = ["#4f6146", "#a8452a", "#8a4fb3", "#b07a12", "#1f7f93", "#2f5fa0", "#c2417c", "#6b5b3e", "#2e6f45", "#7a6f5c"];
export function pickColor(people) {
  const used = new Set(people.map(p => p.color));
  return PALETTE.find(c => !used.has(c)) || PALETTE[people.length % PALETTE.length];
}

export const LOG_KEEP = 300;
export async function record(db, gid, entry) {
  const k = K.g(gid);
  await db.lpush(k.log, JSON.stringify({ t: Date.now(), ...entry }));
  await db.ltrim(k.log, 0, LOG_KEEP - 1);
  return Number(await db.incr(k.version));
}

export const CATEGORY_MAX = 24;
export function cleanEntry(e, people) {
  need(e && ID.test(e.id), "Invalid entry id.");
  need(e.type === "expense" || e.type === "payment", "Unknown entry type.");
  need(cents(e.amount), "Amount must be above zero.");
  need(typeof e.date === "string" && DATE.test(e.date), "Pick a date.");
  need(people[e.paidBy], "The person who paid isn't in this group.");
  const split = {};
  let sum = 0;
  for (const [id, c] of Object.entries(e.split || {})) {
    need(people[id], "Someone in the split isn't in this group.");
    need(cents(c), "Each share must be above zero.");
    split[id] = c; sum += c;
  }
  need(Object.keys(split).length > 0, "Pick at least one person to split with.");
  need(sum === e.amount, "The shares don't add up to the total.");
  const out = { id: e.id, type: e.type, amount: e.amount, date: e.date, paidBy: e.paidBy, split, note: str(e.note, 140) };
  if (e.type === "payment") {
    const to = Object.keys(split);
    need(to.length === 1 && to[0] !== e.paidBy, "A payment goes from one person to a different person.");
    out.desc = "Payment";
  } else {
    out.desc = str(e.desc, 80);
    need(out.desc.length > 0, "Add a short description.");
    out.category = str(e.category, CATEGORY_MAX) || "Other";
    if (e.catEmoji) out.catEmoji = cleanEmoji(e.catEmoji);
    out.mode = ["equal", "exact", "percent"].includes(e.mode) ? e.mode : "equal";
    if (out.mode === "percent" && e.pct && typeof e.pct === "object") {
      out.pct = {};
      for (const [id, p] of Object.entries(e.pct)) if (split[id] && Number.isFinite(p)) out.pct[id] = Math.round(p * 100) / 100;
    }
  }
  const rx = Array.isArray(e.receipts) ? [...new Set(e.receipts)] : [];
  need(rx.length <= MAX_RECEIPTS, `Attach up to ${MAX_RECEIPTS} photos.`);
  need(rx.every(id => ID.test(id)), "Invalid photo id.");
  if (rx.length) out.receipts = rx;
  return out;
}

/* ---------- money ---------- */
export function balances(entries) {
  const b = {};
  const get = id => b[id] || (b[id] = { net: 0, paid: 0, share: 0 });
  for (const e of entries) {
    get(e.paidBy).net += e.amount;
    if (e.type !== "payment") get(e.paidBy).paid += e.amount;
    for (const [id, c] of Object.entries(e.split || {})) { get(id).net -= c; if (e.type !== "payment") get(id).share += c; }
  }
  return b;
}
export function settlePlan(b) {
  const cred = [], debt = [];
  for (const [id, v] of Object.entries(b)) { if (v.net > 0) cred.push({ id, c: v.net }); else if (v.net < 0) debt.push({ id, c: -v.net }); }
  cred.sort((a, z) => z.c - a.c || a.id.localeCompare(z.id)); debt.sort((a, z) => z.c - a.c || a.id.localeCompare(z.id));
  const out = []; let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const x = Math.min(debt[i].c, cred[j].c);
    if (x > 0) out.push({ from: debt[i].id, to: cred[j].id, c: x });
    debt[i].c -= x; cred[j].c -= x;
    if (!debt[i].c) i++;
    if (!cred[j].c) j++;
  }
  return out;
}

/* ---------- backups ---------- */
export async function snapshot(db, gid) {
  const k = K.g(gid);
  const [people, entries, trash, meta] = await Promise.all([db.hgetall(k.people), db.hgetall(k.entries), db.hgetall(k.trash), db.get(k.meta)]);
  const m = parseJSON(meta, {});
  return { t: Date.now(), meta: { name: m.name, currency: m.currency }, people: Object.values(parseMap(people)), entries: Object.values(parseMap(entries)), trash: Object.values(parseMap(trash)) };
}
export async function listBackups(db, gid) {
  return ((await db.lrange(K.g(gid).backups, 0, -1)) || []).map(x => parseJSON(x, null)).filter(Boolean);
}
export async function saveBackup(db, gid, key, label, { onlyIfNew = false } = {}) {
  const k = K.g(gid);
  if (onlyIfNew && (await db.exists(k.backup(key)))) return false;
  const snap = await snapshot(db, gid);
  await db.set(k.backup(key), JSON.stringify(snap));
  const list = (await listBackups(db, gid)).filter(b => b.key !== key);
  list.unshift({ key, label, t: snap.t, entries: snap.entries.length, people: snap.people.filter(p => !p.leftAt).length });
  list.sort((a, z) => z.t - a.t);
  for (const old of list.slice(BACKUP_KEEP)) await db.del(k.backup(old.key));
  await db.del(k.backups);
  const keep = list.slice(0, BACKUP_KEEP);
  if (keep.length) await db.rpush(k.backups, ...keep.map(b => JSON.stringify(b)));
  return true;
}
export async function purgeTrash(db, gid) {
  const k = K.g(gid);
  const cutoff = Date.now() - TRASH_DAYS * 86400000;
  let n = 0;
  for (const e of Object.values(parseMap(await db.hgetall(k.trash)))) {
    if ((e.deletedAt || 0) < cutoff) { await db.hdel(k.trash, e.id); n++; }
  }
  return n;
}

// Removes every key belonging to a group.
export async function wipeGroup(db, gid) {
  const k = K.g(gid);
  for (const b of await listBackups(db, gid)) await db.del(k.backup(b.key));
  const ents = [...Object.values(parseMap(await db.hgetall(k.entries))), ...Object.values(parseMap(await db.hgetall(k.trash)))];
  for (const e of ents) for (const id of e.receipts || []) await db.del(k.rx(id));
  for (const key of [k.meta, k.people, k.members, k.ok, k.entries, k.trash, k.log, k.version, k.backups]) await db.del(key);
  await db.srem(K.groups, gid);
}
