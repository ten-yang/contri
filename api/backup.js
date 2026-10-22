// GET  /api/backup?key=...          -> one saved backup (for download)
// POST /api/backup {op:"restore", key} -> put the ledger back to that backup (current state is saved first)
// Same passcode as the rest of the app.
import { gate, K, Bad, parseMap, listBackups, saveBackup, restoreSnapshot, record } from "./_lib.js";

const KEY = /^[0-9A-Za-z:_-]{4,64}$/;

export default async function handler(req, res) {
  const db = await gate(req, res);
  if (!db) return;
  try {
    if (req.method === "GET") {
      const key = String((req.query && req.query.key) || "");
      if (!KEY.test(key)) throw new Bad("Invalid backup.");
      const raw = await db.get(K.backup(key));
      if (!raw) return res.status(404).json({ error: "That backup isn't available any more." });
      return res.status(200).json({ backup: JSON.parse(raw) });
    }
    if (req.method === "POST") {
      let b = req.body;
      if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
      if (!b || b.op !== "restore" || !KEY.test(String(b.key || ""))) throw new Bad("Unknown request.");
      const raw = await db.get(K.backup(b.key));
      if (!raw) return res.status(404).json({ error: "That backup isn't available any more." });
      const target = (await listBackups(db)).find(x => x.key === b.key);
      const people = parseMap(await db.hgetall(K.people));
      const who = people[String(req.headers["x-who"] || "")] ? String(req.headers["x-who"]) : null;
      // Save what's there now, so this restore can itself be undone.
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
      await saveBackup(db, "before-restore-" + stamp, "Before restoring " + (target ? target.label : "a backup"));
      await restoreSnapshot(db, JSON.parse(raw));
      const version = await record(db, { by: who, action: "restored backup", name: target ? target.label : b.key });
      return res.status(200).json({ ok: true, version });
    }
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  } catch (err) {
    if (err instanceof Bad) return res.status(400).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: "Something went wrong with that backup. Try again." });
  }
}
