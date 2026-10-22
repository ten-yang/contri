// GET  /api/data?v=N  -> whole ledger, or {unchanged:true} if version N is current
// POST /api/data      -> one change: {op, ...}
// Every request needs the group passcode in the "x-passcode" header.
import { store, K, passcodeOk, parseMap, cleanPerson, cleanEntry, cleanMeta, Bad } from "./_lib.js";

const MAX_FAILS = 10;          // wrong passcodes allowed per IP...
const LOCK_SECONDS = 15 * 60;  // ...within this window
const LOG_KEEP = 300;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const db = store();
  if (!db) return res.status(500).json({ error: "Storage isn't connected yet. Add an Upstash Redis store to this Vercel project, then redeploy." });
  if (!process.env.GROUP_PASSCODE) return res.status(500).json({ error: "No group passcode is set. Add GROUP_PASSCODE in the Vercel project settings, then redeploy." });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const fails = Number((await db.get(K.lock(ip))) || 0);
  if (fails >= MAX_FAILS) return res.status(429).json({ error: "Too many wrong passcodes. Try again in 15 minutes." });
  if (!passcodeOk(req.headers["x-passcode"])) {
    await db.incr(K.lock(ip));
    if (fails === 0) await db.expire(K.lock(ip), LOCK_SECONDS);
    return res.status(401).json({ error: "That passcode isn't right." });
  }

  try {
    if (req.method === "GET") return res.status(200).json(await read(db, req.query && req.query.v));
    if (req.method === "POST") return res.status(200).json(await write(db, body(req), String(req.headers["x-who"] || "")));
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  } catch (err) {
    if (err instanceof Bad) return res.status(400).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: "Something went wrong saving that. Try again." });
  }
}

function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch { throw new Bad("Request body isn't valid JSON."); }
}

async function read(db, since) {
  const version = Number((await db.get(K.version)) || 0);
  if (since !== undefined && Number(since) === version) return { version, unchanged: true };
  const [people, entries, meta, log] = await Promise.all([
    db.hgetall(K.people), db.hgetall(K.entries), db.get(K.meta), db.lrange(K.log, 0, 99),
  ]);
  let m = {};
  try { m = meta ? JSON.parse(meta) : {}; } catch {}
  return {
    version,
    people: Object.values(parseMap(people)),
    entries: Object.values(parseMap(entries)),
    meta: cleanMeta(m),
    log: (log || []).map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean),
  };
}

async function write(db, b, whoRaw) {
  const people = parseMap(await db.hgetall(K.people));
  const who = people[whoRaw] ? whoRaw : null;
  const now = Date.now();
  let log;

  switch (b.op) {
    case "putPerson": {
      const p = cleanPerson(b.person);
      const clash = Object.values(people).find(x => x.id !== p.id && x.name.toLowerCase() === p.name.toLowerCase());
      if (clash) throw new Bad(`${clash.name} is already in the group.`);
      const isNew = !people[p.id];
      await db.hset(K.people, { [p.id]: JSON.stringify(p) });
      log = { action: isNew ? (who ? "joined" : "self-joined") : "renamed", name: p.name, ...(isNew && !who ? { by: p.id } : {}) };
      break;
    }
    case "delPerson": {
      const p = people[b.id];
      if (!p) throw new Bad("That person isn't in the group.");
      const entries = Object.values(parseMap(await db.hgetall(K.entries)));
      if (entries.some(e => e.paidBy === b.id || (e.split && b.id in e.split))) throw new Bad(`${p.name} has entries, so they can't be removed.`);
      await db.hdel(K.people, b.id);
      log = { action: "removed person", name: p.name };
      break;
    }
    case "putEntry": {
      const e = cleanEntry(b.entry, people);
      const prevRaw = await db.hget(K.entries, e.id);
      let prev = null;
      try { prev = prevRaw ? JSON.parse(prevRaw) : null; } catch {}
      if (prev) Object.assign(e, { addedBy: prev.addedBy ?? null, createdAt: prev.createdAt || now, editedBy: who, editedAt: now });
      else Object.assign(e, { addedBy: who, createdAt: now });
      await db.hset(K.entries, { [e.id]: JSON.stringify(e) });
      log = { action: prev ? "edited" : "added", type: e.type, desc: e.desc, amount: e.amount, from: e.paidBy, to: e.type === "payment" ? Object.keys(e.split)[0] : null,
              before: prev && prev.amount !== e.amount ? prev.amount : undefined };
      break;
    }
    case "delEntry": {
      const raw = await db.hget(K.entries, String(b.id || ""));
      if (!raw) throw new Bad("That entry was already deleted.");
      let e = {}; try { e = JSON.parse(raw); } catch {}
      await db.hdel(K.entries, b.id);
      log = { action: "deleted", type: e.type, desc: e.desc, amount: e.amount, from: e.paidBy, to: e.type === "payment" ? Object.keys(e.split || {})[0] : null };
      break;
    }
    case "putMeta": {
      const m = cleanMeta(b.meta);
      await db.set(K.meta, JSON.stringify(m));
      log = { action: "settings", name: m.name, currency: m.currency };
      break;
    }
    default:
      throw new Bad("Unknown change.");
  }

  await db.lpush(K.log, JSON.stringify({ t: now, by: who, ...log }));
  await db.ltrim(K.log, 0, LOG_KEEP - 1);
  const version = await db.incr(K.version);
  return { ok: true, version: Number(version) };
}
