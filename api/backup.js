// GET /api/backup?g=..&key=.. -> one saved daily copy (for download as a spreadsheet)
import { handle, K, Bad, requireUser, memberGate, parseJSON } from "./_lib.js";

const KEY = /^[0-9A-Za-z:_-]{4,64}$/;

export default handle(async (req, res, db) => {
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed." }); }
  const user = await requireUser(db, req);
  const q = req.query || {};
  await memberGate(db, String(q.g || ""), user);
  const key = String(q.key || "");
  if (!KEY.test(key)) throw new Bad("Invalid backup.");
  const raw = await db.get(K.g(String(q.g)).backup(key));
  if (!raw) return res.status(404).json({ error: "That copy isn't available any more." });
  return res.status(200).json({ backup: parseJSON(raw, {}) });
});
