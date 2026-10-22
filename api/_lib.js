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
};

export const CATEGORIES = ["Groceries","Dining","Rent","Utilities","Travel","Transport","Shopping","Fun","Health","Other"];
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
  for (const [k, v] of Object.entries(m || {})) {
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
    out.category = CATEGORIES.includes(e.category) ? e.category : "Other";
    out.mode = ["equal", "exact", "percent"].includes(e.mode) ? e.mode : "equal";
    if (out.mode === "percent" && e.pct && typeof e.pct === "object") {
      out.pct = {};
      for (const [id, p] of Object.entries(e.pct)) if (split[id] && Number.isFinite(p)) out.pct[id] = Math.round(p * 100) / 100;
    }
  }
  return out;
}

export function cleanMeta(m) {
  return {
    name: str(m && m.name, 60) || "Our Spending",
    currency: CURRENCIES.includes(m && m.currency) ? m.currency : "USD",
  };
}
