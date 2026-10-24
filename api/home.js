// GET /api/home -> every group you're in, with where you stand in each
import { handle, K, requireUser, parseMap, parseJSON, balances, settlePlan, fixLegacyLook } from "./_lib.js";

export default handle(async (req, res, db) => {
  const user = await requireUser(db, req);
  const gids = (await db.smembers(K.userGroups(user.id))) || [];
  const groups = [];
  for (const gid of gids) {
    const k = K.g(gid);
    const [metaRaw, pid, okVer] = await Promise.all([db.get(k.meta), db.hget(k.members, user.id), db.hget(k.ok, user.id)]);
    const meta = await fixLegacyLook(db, parseJSON(metaRaw, null));
    if (!meta || !pid) { await db.srem(K.userGroups(user.id), gid); continue; }
    const base = { id: gid, name: meta.name, currency: meta.currency, emoji: meta.emoji || "", color: meta.color || "" };
    if (Number(okVer || 0) !== Number(meta.pcVer || 1)) { groups.push({ ...base, needPasscode: true }); continue; }
    const [pplRaw, entRaw, last] = await Promise.all([db.hgetall(k.people), db.hgetall(k.entries), db.lrange(k.log, 0, 0)]);
    const ppl = parseMap(pplRaw);
    const entries = Object.values(parseMap(entRaw));
    const bal = balances(entries);
    const me = String(pid);
    const name = id => (ppl[id] ? ppl[id].name : "Someone");
    const settles = settlePlan(bal).filter(s => s.from === me || s.to === me)
      .map(s => ({ from: s.from, to: s.to, c: s.c, fromName: name(s.from), toName: name(s.to), mine: s.from === me ? "pay" : "get" }));
    const lastLog = parseJSON((last || [])[0], null);
    groups.push({ ...base, me, net: (bal[me] || { net: 0 }).net,
      people: Object.values(ppl).filter(p => !p.leftAt).length,
      faces: Object.values(ppl).filter(p => !p.leftAt && p.id !== me).sort((a, z) => (a.order || 0) - (z.order || 0)).slice(0, 4).map(p => ({ name: p.name, color: p.color })), updated: lastLog ? lastLog.t : meta.createdAt, settles });
  }
  groups.sort((a, z) => (z.updated || 0) - (a.updated || 0));
  return res.status(200).json({ user: { id: user.id, username: user.username }, groups });
});
