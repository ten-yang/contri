// GET  /api/group?g=ID[&v=N] -> the group (or an invite preview if you're not in it yet)
// POST /api/group {op, g, ...} -> create, join, verify, putEntry, delEntry, restoreEntry,
//                                  rename, setCurrency, changePasscode, leave, deleteGroup
import {
  handle, body, ipOf, K, Bad, need, rid, newGid, GID, LEGACY_GID, CURRENCIES, PHOTO_DAYS,
  hashSecret, secretOk, legacyPasscodeOk, requireUser, checkLock, addFail, memberGate, loadMeta, saveMeta,
  publicMeta, parseMap, parseJSON, record, cleanEntry, pickColor, listBackups, cleanEmoji, cleanColor,
} from "./_lib.js";
import { people as loadPeople, activeMembers, checkCanLeave, doLeave, deleteGroup } from "./_groups.js";

const cleanName = n => { const s = typeof n === "string" ? n.trim().replace(/\s+/g, " ").slice(0, 60) : ""; need(s, "Give the group a name."); return s; };
const cleanCurrency = c => (CURRENCIES.includes(c) ? c : "USD");
const cleanPasscode = p => { need(typeof p === "string" && p.trim().length >= 6, "Use at least 6 characters for the passcode."); need(p.length <= 100, "That passcode is too long."); return p.trim(); };

export default handle(async (req, res, db) => {
  const user = await requireUser(db, req);
  if (req.method === "GET") return res.status(200).json(await read(db, user, req.query || {}));
  if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Method not allowed." }); }
  return res.status(200).json(await write(db, user, body(req), ipOf(req)));
});

async function legacyPreview(db) {
  if (await db.get(K.legacyDone)) return null;   // already moved over (and maybe deleted since)
  const raw = await db.get(K.old.meta);
  const ppl = parseMap(await db.hgetall(K.old.people));
  if (!raw && !Object.keys(ppl).length) return null;
  const m = parseJSON(raw, {});
  return { name: m.name || "Our Spending", currency: cleanCurrency(m.currency), people: Object.keys(ppl).length };
}

async function read(db, user, q) {
  const gid = String(q.g || "");
  need(GID.test(gid), "That group link isn't right.", 404);
  const k = K.g(gid);
  const meta = await loadMeta(db, gid);
  const pid = meta ? await db.hget(k.members, user.id) : null;

  if (!meta || !pid) {
    if (!meta && gid === LEGACY_GID) {
      const lp = await legacyPreview(db);
      if (lp) return { invite: lp };
    }
    if (!meta) throw new Bad("This invite link doesn't lead to a group. It may have been deleted.", 404);
    const ppl = await loadPeople(db, gid);
    return { invite: { name: meta.name, currency: meta.currency, people: activeMembers(ppl).length + Object.values(ppl).filter(p => !p.uid && !p.leftAt).length } };
  }
  const okVer = await db.hget(k.ok, user.id);
  if (Number(okVer || 0) !== Number(meta.pcVer || 1)) return { needPasscode: true, invite: { name: meta.name } };

  const version = Number((await db.get(k.version)) || 0);
  if (q.v !== undefined && Number(q.v) === version) return { version, unchanged: true };
  const [ppl, entries, trash, log, backups] = await Promise.all([
    db.hgetall(k.people), db.hgetall(k.entries), db.hgetall(k.trash), db.lrange(k.log, 0, 149), listBackups(db, gid),
  ]);
  return {
    version,
    meta: publicMeta(meta),
    me: String(pid),
    isCreator: meta.creator === user.id,
    people: Object.values(parseMap(ppl)).sort((a, z) => (a.order || 0) - (z.order || 0)),
    entries: Object.values(parseMap(entries)),
    trash: Object.values(parseMap(trash)).sort((a, z) => (z.deletedAt || 0) - (a.deletedAt || 0)),
    log: (log || []).map(x => parseJSON(x, null)).filter(Boolean),
    backups,
  };
}

// Moves the original single-group app into a group with this fixed id. Runs once.
async function importLegacy(db, user) {
  const got = await db.set(K.legacyLock, "1", { nx: true, ex: 120 });
  if (!got) throw new Bad("Setting up the group, try again in a moment.", 409);
  try {
    if (await loadMeta(db, LEGACY_GID)) return;
    const k = K.g(LEGACY_GID);
    const old = parseJSON(await db.get(K.old.meta), {});
    const ppl = parseMap(await db.hgetall(K.old.people));
    const entries = parseMap(await db.hgetall(K.old.entries));
    const trash = parseMap(await db.hgetall(K.old.trash));
    const log = ((await db.lrange(K.old.log, 0, 299)) || []).map(x => parseJSON(x, null)).filter(Boolean);
    const now = Date.now();
    // Photos follow the 30-day rule, counted from when the expense was logged.
    const movePhotos = async e => {
      const keep = [], exp = {};
      for (const id of e.receipts || []) {
        const until = (e.createdAt || now) + PHOTO_DAYS * 86400000;
        if (until <= now + 60000) continue;
        const data = await db.get(K.old.receipt(id));
        if (!data) continue;
        await db.set(k.rx(id), data, { ex: Math.ceil((until - now) / 1000) });
        keep.push(id); exp[id] = until;
      }
      if (keep.length) { e.receipts = keep; e.rxExp = exp; } else { delete e.receipts; delete e.rxExp; }
      return e;
    };
    const outP = {}, outE = {}, outT = {};
    for (const p of Object.values(ppl)) outP[p.id] = JSON.stringify({ id: p.id, name: p.name, color: p.color, order: p.order || now, uid: null });
    for (const e of Object.values(entries)) outE[e.id] = JSON.stringify(await movePhotos(e));
    for (const e of Object.values(trash)) outT[e.id] = JSON.stringify(await movePhotos(e));
    if (Object.keys(outP).length) await db.hset(k.people, outP);
    if (Object.keys(outE).length) await db.hset(k.entries, outE);
    if (Object.keys(outT).length) await db.hset(k.trash, outT);
    const keepLog = log.filter(a => a.action !== "restored backup").slice(0, 299).reverse();
    for (const a of keepLog) await db.lpush(k.log, JSON.stringify(a));
    await db.set(k.version, String(log.length));
    await saveMeta(db, { id: LEGACY_GID, name: old.name || "Our Spending", currency: cleanCurrency(old.currency), creator: user.id, pc: null, pcVer: 1, createdAt: now, legacy: true });
    await db.sadd(K.groups, LEGACY_GID);
    await db.set(K.legacyDone, "1");
  } finally {
    await db.del(K.legacyLock);
  }
}

async function addMember(db, gid, meta, user, pid, how) {
  const k = K.g(gid);
  await db.hset(k.members, { [user.id]: pid });
  await db.hset(k.ok, { [user.id]: String(meta.pcVer || 1) });
  await db.sadd(K.userGroups(user.id), gid);
  return record(db, gid, { by: pid, action: how.action, ...(how.name ? { name: how.name } : {}) });
}

async function write(db, user, b, ip) {
  if (b.op === "create") {
    const name = cleanName(b.name), passcode = cleanPasscode(b.passcode), currency = cleanCurrency(b.currency);
    const n = Number((await db.scard(K.userGroups(user.id))) || 0);
    need(n < 50, "You're in a lot of groups already. Leave one first.");
    const gid = newGid();
    const pid = rid(12);
    const now = Date.now();
    const meta = { id: gid, name, currency, creator: user.id, pc: hashSecret(passcode), pcVer: 1, createdAt: now, emoji: cleanEmoji(b.emoji), color: cleanColor(b.color) };
    await saveMeta(db, meta);
    await db.hset(K.g(gid).people, { [pid]: JSON.stringify({ id: pid, name: user.username, color: pickColor([]), order: now, uid: user.id }) });
    await db.sadd(K.groups, gid);
    await addMember(db, gid, meta, user, pid, { action: "created" });
    return { ok: true, g: gid };
  }

  const gid = String(b.g || "");
  need(GID.test(gid), "That group link isn't right.", 404);
  const k = K.g(gid);

  if (b.op === "join" || b.op === "verify") {
    await checkLock(db, "join", `${ip}:${gid}`, 10);
    await checkLock(db, "joinu", `${user.id}:${gid}`, 10);
    let meta = await loadMeta(db, gid);
    if (!meta && gid === LEGACY_GID && (await legacyPreview(db))) {
      if (!legacyPasscodeOk(b.passcode)) { await addFail(db, "join", `${ip}:${gid}`); await addFail(db, "joinu", `${user.id}:${gid}`); throw new Bad("That passcode isn't right.", 400, { badPasscode: true }); }
      await importLegacy(db, user);
      meta = await loadMeta(db, gid);
      if (!meta.pc) { meta.pc = hashSecret(String(b.passcode).trim()); await saveMeta(db, meta); }
    }
    need(meta, "This invite link doesn't lead to a group. It may have been deleted.", 404);
    const okPc = meta.pc ? secretOk(String(b.passcode || "").trim(), meta.pc) : false;
    if (!okPc) { await addFail(db, "join", `${ip}:${gid}`); await addFail(db, "joinu", `${user.id}:${gid}`); throw new Bad("That passcode isn't right.", 400, { badPasscode: true }); }

    const ppl = await loadPeople(db, gid);
    const current = await db.hget(k.members, user.id);
    if (current) { await db.hset(k.ok, { [user.id]: String(meta.pcVer || 1) }); return { ok: true, g: gid }; }
    if (b.op === "verify") throw new Bad("You're not in this group.", 403, { notMember: true });

    // Coming back after leaving: same person as before.
    const former = Object.values(ppl).find(p => p.uid === user.id);
    if (former) {
      delete former.leftAt;
      await db.hset(k.people, { [former.id]: JSON.stringify(former) });
      await addMember(db, gid, meta, user, former.id, { action: "rejoined" });
      return { ok: true, g: gid };
    }
    need(activeMembers(ppl).length < 50, "This group is full.");
    const unclaimed = Object.values(ppl).filter(p => !p.uid && !p.leftAt).sort((a, z) => (a.order || 0) - (z.order || 0));
    if (b.claim === undefined && unclaimed.length) {
      return { choose: unclaimed.map(p => ({ id: p.id, name: p.name, color: p.color })), name: meta.name };
    }
    if (b.claim && b.claim !== "new") {
      const p = ppl[b.claim];
      need(p && !p.uid && !p.leftAt, "Someone already picked that name. Pick another, or join as new.");
      p.uid = user.id;
      await db.hset(k.people, { [p.id]: JSON.stringify(p) });
      // The very first person into the moved-over group becomes its creator.
      await addMember(db, gid, meta, user, p.id, { action: "claimed", name: p.name });
      return { ok: true, g: gid };
    }
    let name = user.username, i = 2;
    const taken = n => Object.values(ppl).some(p => p.name.toLowerCase() === n.toLowerCase());
    while (taken(name)) name = `${user.username} ${i++}`;
    const pid = rid(12);
    await db.hset(k.people, { [pid]: JSON.stringify({ id: pid, name, color: pickColor(Object.values(ppl)), order: Date.now(), uid: user.id }) });
    await addMember(db, gid, meta, user, pid, { action: "self-joined" });
    return { ok: true, g: gid };
  }

  const { meta, me } = await memberGate(db, gid, user);
  const isCreator = meta.creator === user.id;
  const ppl = await loadPeople(db, gid);
  const now = Date.now();
  let log;

  switch (b.op) {
    case "putEntry": {
      const e = cleanEntry(b.entry, ppl);
      const prev = parseJSON(await db.hget(k.entries, e.id), null);
      if (!prev) need(!(await db.hexists(k.trash, e.id)), "That entry was deleted. Restore it from Backup & export.");
      // New people can only be added to an expense if they're still in the group.
      const before = new Set(prev ? [prev.paidBy, ...Object.keys(prev.split || {})] : []);
      for (const id of [e.paidBy, ...Object.keys(e.split)]) {
        if (!before.has(id)) need(!ppl[id].leftAt, `${ppl[id].name} has left the group, so they can't be added to new expenses.`);
      }
      // Photos are uploaded first with a 1-day expiry. Once saved, each lasts 30 days from now.
      const exp = {};
      for (const id of e.receipts || []) {
        if (prev && prev.rxExp && prev.rxExp[id]) { exp[id] = prev.rxExp[id]; continue; }
        if (!(await db.exists(k.rx(id)))) throw new Bad("A photo didn't finish uploading. Remove it and add it again.");
        await db.expire(k.rx(id), PHOTO_DAYS * 86400);
        exp[id] = now + PHOTO_DAYS * 86400000;
      }
      if (e.receipts) e.rxExp = exp;
      for (const id of (prev && prev.receipts) || []) if (!exp[id]) await db.del(k.rx(id));
      if (prev) Object.assign(e, { addedBy: prev.addedBy ?? null, createdAt: prev.createdAt || now, editedBy: me, editedAt: now });
      else Object.assign(e, { addedBy: me, createdAt: now });
      await db.hset(k.entries, { [e.id]: JSON.stringify(e) });
      log = { action: prev ? "edited" : "added", type: e.type, desc: e.desc, amount: e.amount, from: e.paidBy, to: e.type === "payment" ? Object.keys(e.split)[0] : null,
              before: prev && prev.amount !== e.amount ? prev.amount : undefined };
      break;
    }
    case "delEntry": {
      const e = parseJSON(await db.hget(k.entries, String(b.id || "")), null);
      need(e, "That entry was already deleted.");
      await db.hset(k.trash, { [e.id]: JSON.stringify({ ...e, deletedAt: now, deletedBy: me }) });
      await db.hdel(k.entries, e.id);
      log = { action: "deleted", type: e.type, desc: e.desc, amount: e.amount, from: e.paidBy, to: e.type === "payment" ? Object.keys(e.split || {})[0] : null };
      break;
    }
    case "restoreEntry": {
      const e = parseJSON(await db.hget(k.trash, String(b.id || "")), null);
      need(e, "That item isn't in Recently deleted any more.");
      delete e.deletedAt; delete e.deletedBy;
      await db.hset(k.entries, { [e.id]: JSON.stringify(e) });
      await db.hdel(k.trash, e.id);
      log = { action: "restored", type: e.type, desc: e.desc, amount: e.amount, from: e.paidBy, to: e.type === "payment" ? Object.keys(e.split || {})[0] : null };
      break;
    }
    case "rename": {
      const name = cleanName(b.name);
      if (name === meta.name) return { ok: true };
      meta.name = name; await saveMeta(db, meta);
      log = { action: "renamed group", name };
      break;
    }
    case "setCurrency": {
      need(isCreator, "Only the person who created the group can change this.", 403);
      const c = cleanCurrency(b.currency);
      if (c === meta.currency) return { ok: true };
      meta.currency = c; await saveMeta(db, meta);
      log = { action: "currency", name: c };
      break;
    }
    case "changePasscode": {
      need(isCreator, "Only the person who created the group can change the passcode.", 403);
      meta.pc = hashSecret(cleanPasscode(b.passcode));
      meta.pcVer = Number(meta.pcVer || 1) + 1;
      await saveMeta(db, meta);
      await db.del(k.ok);
      await db.hset(k.ok, { [user.id]: String(meta.pcVer) });
      log = { action: "passcode" };
      break;
    }
    case "leave": {
      const to = await checkCanLeave(db, gid, me, meta, user, b.handTo);
      const version = await doLeave(db, gid, me, meta, user, to);
      return { ok: true, version, left: true };
    }
    case "deleteGroup": {
      need(isCreator, "Only the person who created the group can delete it.", 403);
      await deleteGroup(db, gid);
      return { ok: true, deleted: true };
    }
    default:
      need(false, "Unknown change.");
  }

  const version = await record(db, gid, { by: me, ...log });
  return { ok: true, version };
}
