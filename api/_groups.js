// Group membership logic shared by several endpoints.
import { K, Bad, need, parseMap, parseJSON, record, balances, loadMeta, saveMeta, wipeGroup } from "./_lib.js";

export async function people(db, gid) { return parseMap(await db.hgetall(K.g(gid).people)); }
export async function entries(db, gid) { return Object.values(parseMap(await db.hgetall(K.g(gid).entries))); }

export const activeMembers = ppl => Object.values(ppl).filter(p => p.uid && !p.leftAt);

// Can this person leave? Throws a friendly reason if not.
export async function checkCanLeave(db, gid, pid, meta, user, handTo) {
  const net = (balances(await entries(db, gid))[pid] || { net: 0 }).net;
  if (net !== 0) throw new Bad("Settle up first.", 409, { owed: net });
  if (meta.creator === user.id) {
    const ppl = await people(db, gid);
    const others = activeMembers(ppl).filter(p => p.uid !== user.id);
    if (!others.length) throw new Bad("You're the only one here. Delete the group instead.", 409, { alone: true });
    need(handTo, "Pick who takes over first.");
    const to = ppl[handTo];
    need(to && to.uid && !to.leftAt && to.uid !== user.id, "Pick someone who's still in the group.");
    return to;
  }
  return null;
}

export async function doLeave(db, gid, pid, meta, user, to) {
  const k = K.g(gid);
  if (to) {
    meta.creator = to.uid;
    await saveMeta(db, meta);
    await record(db, gid, { by: pid, action: "handed over", name: to.name, to: to.id });
  }
  const p = parseJSON(await db.hget(k.people, pid), null);
  if (p) { p.leftAt = Date.now(); await db.hset(k.people, { [pid]: JSON.stringify(p) }); }
  await db.hdel(k.members, user.id);
  await db.hdel(k.ok, user.id);
  await db.srem(K.userGroups(user.id), gid);
  return record(db, gid, { by: pid, action: "left" });
}

export async function deleteGroup(db, gid) {
  const ppl = await people(db, gid);
  for (const p of Object.values(ppl)) if (p.uid) await db.srem(K.userGroups(p.uid), gid);
  await wipeGroup(db, gid);
}

export { loadMeta };
