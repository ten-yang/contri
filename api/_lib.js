// Shared helpers for the API. Files starting with "_" are not deployed as endpoints.
import { Redis } from "@upstash/redis";
import crypto from "node:crypto";

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const client = url && token ? new Redis({ url, token, automaticDeserialization: false }) : null;

// Tests can swap in an in-memory store.
export const store = () => globalThis.__ledgerStore || client;

export const K = {
  people: "ledger:people",
  entries: "ledger:entries",
  meta: "ledger:meta",
  version: "ledger:version",
  log: "ledger:log",
  lock: ip => "ledger:fail:" + ip,
  receipt: id => "ledger:receipt:" + id,
  trash: "ledger:trash",
  photos: "ledger:photos",
  backups: "ledger:backups",
  backup: key => "ledger:backup:" + key,
};

export const TRASH_DAYS = 30;
export const BACKUP_KEEP = 30;

export const CATEGORIES = ["Groceries","Dining","Rent","Utilities","Travel","Transport","Shopping","Fun","Health","Other"];
export const MAX_RECEIPTS = 4;
export const CURRENCIES = ["USD","INR","EUR","GBP","CAD"];
const ID = /^[a-z0-9]{6,32}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

export function passcodeOk(given) {
  const want = process.env.GROUP_PASSCODE || "";
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(want).digest();
  return want.length > 0 && crypto.timingSafeEqual(a, b);
}

export const parseMap = m => {
  const out = {};
  // Upstash returns HGETALL as a flat [field, value, field, value] array when auto-parsing is off.
  const pairs = Array.isArray(m)
    ? Array.from({ length: Math.floor(m.length / 2) }, (_, i) => [m[2 * i], m[2 * i + 1]])
    : Object.entries(m || {});
  for (const [k, v] of pairs) {
    try { out[k] = typeof v === "string" ? JSON.parse(v) : v; } catch { /* skip bad row */ }
  }
  return out;
};

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const cents = v => Number.isInteger(v) && v > 0 && v <= 100_000_000;

export class Bad extends Error {}
const need = (cond, msg) => { if (!cond) throw new Bad(msg); };

export function cleanPerson(p) {
  need(p && ID.test(p.id), "Invalid person id.");
  const name = str(p.name, 30);
  need(name.length > 0, "Enter a name.");
  return { id: p.id, name, color: COLOR.test(p.color) ? p.color : "#4d6178", order: Number.isFinite(p.order) ? p.order : Date.now() };
}

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
    out.category = str(e.category, 24).replace(/\s+/g, " ") || "Other";
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

export function cleanMeta(m) {
  return {
    name: str(m && m.name, 60) || "Our Spending",
    currency: CURRENCIES.includes(m && m.currency) ? m.currency : "USD",
  };
}

// Passcode check with a per-IP lockout, shared by every endpoint.
const MAX_FAILS = 10;          // wrong passcodes allowed per IP...
const LOCK_SECONDS = 15 * 60;  // ...within this window
export async function gate(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const db = store();
  if (!db) { res.status(500).json({ error: "Storage isn't connected yet. Add an Upstash Redis store to this Vercel project, then redeploy." }); return null; }
  if (!process.env.GROUP_PASSCODE) { res.status(500).json({ error: "No group passcode is set. Add GROUP_PASSCODE in the Vercel project settings, then redeploy." }); return null; }
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const fails = Number((await db.get(K.lock(ip))) || 0);
  if (fails >= MAX_FAILS) { res.status(429).json({ error: "Too many wrong passcodes. Try again in 15 minutes." }); return null; }
  if (!passcodeOk(req.headers["x-passcode"])) {
    await db.incr(K.lock(ip));
    if (fails === 0) await db.expire(K.lock(ip), LOCK_SECONDS);
    res.status(401).json({ error: "That passcode isn't right." });
    return null;
  }
  return db;
}

const LOG_KEEP = 300;
// Append to the activity log and bump the version so open phones refresh.
export async function record(db, entry) {
  await db.lpush(K.log, JSON.stringify({ t: Date.now(), ...entry }));
  await db.ltrim(K.log, 0, LOG_KEEP - 1);
  return Number(await db.incr(K.version));
}

const parseJSON = (raw, fallback) => { try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } };

// Everything needed to rebuild the ledger (photos stay where they are).
export async function snapshot(db) {
  const [people, entries, trash, meta] = await Promise.all([db.hgetall(K.people), db.hgetall(K.entries), db.hgetall(K.trash), db.get(K.meta)]);
  return { t: Date.now(), meta: cleanMeta(parseJSON(meta, {})), people: Object.values(parseMap(people)), entries: Object.values(parseMap(entries)), trash: Object.values(parseMap(trash)) };
}

export async function listBackups(db) {
  return ((await db.lrange(K.backups, 0, -1)) || []).map(x => parseJSON(x, null)).filter(Boolean);
}

// Save a backup under `key`. With onlyIfNew, an existing backup for that key is kept as-is.
export async function saveBackup(db, key, label, { onlyIfNew = false } = {}) {
  if (onlyIfNew && (await db.exists(K.backup(key)))) return false;
  const snap = await snapshot(db);
  await db.set(K.backup(key), JSON.stringify(snap));
  const list = (await listBackups(db)).filter(b => b.key !== key);
  list.unshift({ key, label, t: snap.t, entries: snap.entries.length, people: snap.people.length });
  list.sort((a, z) => z.t - a.t);
  for (const old of list.slice(BACKUP_KEEP)) await db.del(K.backup(old.key));
  await db.del(K.backups);
  const keep = list.slice(0, BACKUP_KEEP);
  if (keep.length) await db.rpush(K.backups, ...keep.map(b => JSON.stringify(b)));
  return true;
}

// Replace people, entries, deleted items and settings with a snapshot.
export async function restoreSnapshot(db, snap) {
  const toMap = arr => Object.fromEntries((arr || []).filter(x => x && x.id).map(x => [x.id, JSON.stringify(x)]));
  for (const key of [K.people, K.entries, K.trash]) await db.del(key);
  const people = toMap(snap.people), entries = toMap(snap.entries), trash = toMap(snap.trash);
  if (Object.keys(people).length) await db.hset(K.people, people);
  if (Object.keys(entries).length) await db.hset(K.entries, entries);
  if (Object.keys(trash).length) await db.hset(K.trash, trash);
  await db.set(K.meta, JSON.stringify(cleanMeta(snap.meta || {})));
  // Photos referenced by the restored data must not expire.
  for (const e of [...(snap.entries || []), ...(snap.trash || [])]) for (const id of e.receipts || []) await db.persist(K.receipt(id));
}

// Permanently remove deleted items older than TRASH_DAYS. Their photos are cleaned up by sweepPhotos.
export async function purgeTrash(db) {
  const cutoff = Date.now() - TRASH_DAYS * 86400000;
  let n = 0;
  for (const e of Object.values(parseMap(await db.hgetall(K.trash)))) {
    if ((e.deletedAt || 0) < cutoff) { await db.hdel(K.trash, e.id); n++; }
  }
  return n;
}

// Delete photos that nothing uses any more: not current entries, not the bin, not any kept backup.
export async function sweepPhotos(db) {
  const used = new Set();
  const add = list => { for (const x of list || []) for (const id of x.receipts || []) used.add(id); };
  const snap = await snapshot(db);
  add(snap.entries); add(snap.trash);
  for (const b of await listBackups(db)) { const s = parseJSON(await db.get(K.backup(b.key)), {}); add(s.entries); add(s.trash); }
  let n = 0;
  for (const id of (await db.smembers(K.photos)) || []) {
    if (used.has(id)) continue;
    if (!(await db.exists(K.receipt(id)))) { await db.srem(K.photos, id); continue; }   // unclaimed upload already expired
    if (Number(await db.ttl(K.receipt(id))) > 0) continue;                              // fresh upload, still waiting to be saved
    await db.del(K.receipt(id)); await db.srem(K.photos, id); n++;
  }
  return n;
}
