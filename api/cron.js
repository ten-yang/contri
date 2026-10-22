// Runs once a day (see vercel.json). Saves that day's backup if there isn't one yet,
// empties the bin of items older than 30 days, and removes photos nothing uses.
// Safe to call more than once: a day's first backup is never overwritten.
import { store, K, saveBackup, purgeTrash, sweepPhotos } from "./_lib.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const db = store();
  if (!db) return res.status(500).json({ error: "Storage isn't connected." });
  try {
    const day = new Date().toISOString().slice(0, 10);
    const label = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    const saved = await saveBackup(db, day, label, { onlyIfNew: true });
    if (saved) await db.incr(K.version);   // so open phones show the new backup
    const purged = await purgeTrash(db);
    const photos = await sweepPhotos(db);
    return res.status(200).json({ ok: true, day, saved, purged, photosRemoved: photos });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Backup failed." });
  }
}
