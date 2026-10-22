// GET  /api/data?v=N  -> whole ledger, or {unchanged:true} if version N is current
// POST /api/data      -> one change: {op, ...}
// Every request needs the group passcode in the "x-passcode" header.
import { gate, K, parseMap, cleanPerson, cleanEntry, cleanMeta, Bad, record, listBackups } from "./_lib.js";

export default async function handler(req, res) {
  const db = await gate(req, res);
  if (!db) return;

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
  const [people, entries, trash, meta, log, backups] = await Promise.all([
    db.hgetall(K.people), db.hgetall(K.entries), db.hgetall(K.trash), db.get(K.meta), db.lrange(K.log, 0, 99), listBackups(db),
  ]);
  let m = {};
  try { m = meta ? JSON.parse(meta) : {}; } catch {}
  return {
    version,
    people: Object.values(parseMap(people)),
    entries: Object.values(parseMap(entries)),
    trash: Object.values(parseMap(trash)).sort((a, z) => (z.deletedAt || 0) - (a.deletedAt || 0)),
    backups,
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
      const uses = e => e.paidBy === b.id || (e.split && b.id in e.split);
      if (Object.values(parseMap(await db.hgetall(K.entries))).some(uses)) throw new Bad(`${p.name} has entries, so they can't be removed.`);
      if (Object.values(parseMap(await db.hgetall(K.trash))).some(uses)) throw new Bad(`${p.name} has entries in Recently deleted, so they can't be removed yet.`);
      await db.hdel(K.people, b.id);
      log = { action: "removed person", name: p.name };
      break;
    }
    case "putEntry": {
      const e = cleanEntry(b.entry, people);
      const prevRaw = await db.hget(K.entries, e.id);
      let prev = null;
      try { prev = prevRaw ? JSON.parse(prevRaw) : null; } catch {}
      // Photos are uploaded first with a 1-day expiry; keep the ones this entry uses, drop the ones it no longer uses.
      for (const id of e.receipts || []) {
        if (!(await db.exists(K.receipt(id)))) throw new Bad("A photo didn't finish uploading. Remove it and add it again.");
        await db.persist(K.receipt(id));
      }
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
      // Deleted items go to the bin for 30 days instead of disappearing.
      await db.hset(K.trash, { [b.id]: JSON.stringify({ ...e, deletedAt: now, deletedBy: who }) });
      await db.hdel(K.entries, b.id);
      log = { action: "deleted", type: e.type, desc: e.desc, amount: e.amount, from: e.paidBy, to: e.type === "payment" ? Object.keys(e.split || {})[0] : null };
      break;
    }
    case "restoreEntry": {
      const raw = await db.hget(K.trash, String(b.id || ""));
      if (!raw) throw new Bad("That item isn't in Recently deleted any more.");
      let e = {}; try { e = JSON.parse(raw); } catch {}
      const missing = [e.paidBy, ...Object.keys(e.split || {})].filter(id => !people[id]);
      if (missing.length) throw new Bad("Someone in this entry was removed from the group. Add them back, then restore it.");
      delete e.deletedAt; delete e.deletedBy;
      await db.hset(K.entries, { [e.id]: JSON.stringify(e) });
      await db.hdel(K.trash, e.id);
      log = { action: "restored", type: e.type, desc: e.desc, amount: e.amount, from: e.paidBy, to: e.type === "payment" ? Object.keys(e.split || {})[0] : null };
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

  const version = await record(db, { by: who, ...log });
  return { ok: true, version };
}
