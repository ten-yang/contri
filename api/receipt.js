// POST /api/receipt {id, data}  -> stores one compressed photo (expires in a day unless an entry claims it)
// GET  /api/receipt?id=...      -> {data}
// Same passcode as the rest of the app.
import { gate, K } from "./_lib.js";

const ID = /^[a-z0-9]{6,32}$/;
const DATA = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_CHARS = 1_400_000; // about 1 MB of image after base64
const UNCLAIMED_SECONDS = 24 * 60 * 60;

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

export default async function handler(req, res) {
  const db = await gate(req, res);
  if (!db) return;
  try {
    if (req.method === "GET") {
      const id = String((req.query && req.query.id) || "");
      if (!ID.test(id)) return res.status(400).json({ error: "Invalid photo id." });
      const data = await db.get(K.receipt(id));
      if (!data) return res.status(404).json({ error: "That photo isn't available any more." });
      res.setHeader("Cache-Control", "private, max-age=86400");
      return res.status(200).json({ data });
    }
    if (req.method === "POST") {
      let b = req.body;
      if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = null; } }
      if (!b || !ID.test(String(b.id || ""))) return res.status(400).json({ error: "Invalid photo id." });
      const data = String(b.data || "");
      if (data.length > MAX_CHARS) return res.status(400).json({ error: "That photo is too large. Try a smaller one." });
      if (!DATA.test(data)) return res.status(400).json({ error: "Only JPEG, PNG or WebP photos can be added." });
      await db.set(K.receipt(b.id), data, { ex: UNCLAIMED_SECONDS });
      await db.sadd(K.photos, b.id);
      return res.status(200).json({ ok: true, id: b.id });
    }
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Couldn't save that photo. Try again." });
  }
}
