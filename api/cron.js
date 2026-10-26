// Runs once a day (see vercel.json). For every group: saves that day's copy if there isn't one yet,
// and permanently removes deleted items older than 30 days. Photos expire on their own after 30 days.
// Safe to call more than once: a day's first copy is never overwritten.
import { store, K, saveBackup, purgeTrash } from "./_lib.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  // Only Vercel's scheduler may run this. Vercel sends "Bearer <CRON_SECRET>" when that setting exists.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: "Not allowed." });
  const db = store();
  if (!db) return res.status(500).json({ error: "Storage isn't connected." });
  const day = new Date().toISOString().slice(0, 10);
  const label = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const out = { ok: true, day, groups: 0, saved: 0, purged: 0 };
  for (const gid of (await db.smembers(K.groups)) || []) {
    try {
      if (!(await db.exists(K.g(gid).meta))) { await db.srem(K.groups, gid); continue; }
      out.groups++;
      if (await saveBackup(db, gid, day, label, { onlyIfNew: true })) { out.saved++; await db.incr(K.g(gid).version); }
      out.purged += await purgeTrash(db, gid);
    } catch (err) { console.error(gid, err); out.ok = false; }
  }
  return res.status(out.ok ? 200 : 500).json(out);
}
