// POST /api/receipt {g, id, data} -> stores one compressed photo (gone in a day unless an expense uses it, then 30 days)
// GET  /api/receipt?g=..&id=..    -> {data}
import { handle, body, K, requireUser, memberGate } from "./_lib.js";

const ID = /^[a-z0-9]{6,32}$/;
const DATA = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_CHARS = 1_400_000; // about 1 MB of image after base64
const UNCLAIMED_SECONDS = 24 * 60 * 60;

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

export default handle(async (req, res, db) => {
  const user = await requireUser(db, req);
  if (req.method === "GET") {
    const q = req.query || {};
    await memberGate(db, String(q.g || ""), user);
    const id = String(q.id || "");
    if (!ID.test(id)) return res.status(400).json({ error: "Invalid photo id." });
    const data = await db.get(K.g(String(q.g)).rx(id));
    if (!data) return res.status(404).json({ error: "This photo was deleted after 30 days." });
    res.setHeader("Cache-Control", "private, max-age=3600");
    return res.status(200).json({ data });
  }
  if (req.method === "POST") {
    const b = body(req);
    await memberGate(db, String(b.g || ""), user);
    if (!ID.test(String(b.id || ""))) return res.status(400).json({ error: "Invalid photo id." });
    const data = String(b.data || "");
    if (data.length > MAX_CHARS) return res.status(400).json({ error: "That photo is too large. Try a smaller one." });
    if (!DATA.test(data)) return res.status(400).json({ error: "Only JPEG, PNG or WebP photos can be added." });
    await db.set(K.g(String(b.g)).rx(b.id), data, { ex: UNCLAIMED_SECONDS });
    return res.status(200).json({ ok: true, id: b.id });
  }
  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed." });
});
