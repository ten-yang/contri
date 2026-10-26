// Local test server: serves public/ and the api/ functions against an in-memory Redis.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

class Mem {
  constructor() { this.m = new Map(); this.exp = new Map(); }
  _alive(k) { const e = this.exp.get(k); if (e && e <= Date.now()) { this.m.delete(k); this.exp.delete(k); } return this.m.has(k); }
  _get(k, type, make) { this._alive(k); let v = this.m.get(k); if (v === undefined && make) { v = make(); this.m.set(k, v); } return v; }
  async get(k) { const v = this._get(k); return v === undefined ? null : v; }
  async set(k, v, o = {}) { if (o.nx && this._alive(k)) return null; this.m.set(k, String(v)); this.exp.delete(k); if (o.ex) this.exp.set(k, Date.now() + o.ex * 1000); return "OK"; }
  async del(...ks) { let n = 0; for (const k of ks) { if (this._alive(k)) n++; this.m.delete(k); this.exp.delete(k); } return n; }
  async exists(k) { return this._alive(k) ? 1 : 0; }
  async incr(k) { const v = Number(this._get(k) || 0) + 1; this.m.set(k, String(v)); return v; }
  async expire(k, s) { if (!this._alive(k)) return 0; this.exp.set(k, Date.now() + s * 1000); return 1; }
  async ttl(k) { if (!this._alive(k)) return -2; const e = this.exp.get(k); return e ? Math.ceil((e - Date.now()) / 1000) : -1; }
  async persist(k) { return this.exp.delete(k) ? 1 : 0; }
  async hgetall(k) { const h = this._get(k); if (!h) return null; return [...h.entries()].flat(); }
  async hget(k, f) { const h = this._get(k); return h && h.has(f) ? h.get(f) : null; }
  async hset(k, obj) { const h = this._get(k, "h", () => new Map()); let n = 0; for (const [f, v] of Object.entries(obj)) { if (!h.has(f)) n++; h.set(f, String(v)); } return n; }
  async hsetnx(k, f, v) { const h = this._get(k, "h", () => new Map()); if (h.has(f)) return 0; h.set(f, String(v)); return 1; }
  async hexists(k, f) { const h = this._get(k); return h && h.has(f) ? 1 : 0; }
  async hdel(k, ...fs) { const h = this._get(k); if (!h) return 0; let n = 0; for (const f of fs) if (h.delete(f)) n++; if (!h.size) this.m.delete(k); return n; }
  async lpush(k, ...vs) { const l = this._get(k, "l", () => []); for (const v of vs) l.unshift(String(v)); return l.length; }
  async rpush(k, ...vs) { const l = this._get(k, "l", () => []); for (const v of vs) l.push(String(v)); return l.length; }
  async ltrim(k, a, b) { const l = this._get(k); if (!l) return "OK"; const r = l.slice(a, b === -1 ? undefined : b + 1); this.m.set(k, r); return "OK"; }
  async lrange(k, a, b) { const l = this._get(k) || []; return l.slice(a, b === -1 ? undefined : b + 1); }
  async sadd(k, ...vs) { const s = this._get(k, "s", () => new Set()); let n = 0; for (const v of vs) if (!s.has(String(v))) { s.add(String(v)); n++; } return n; }
  async srem(k, ...vs) { const s = this._get(k); if (!s) return 0; let n = 0; for (const v of vs) if (s.delete(String(v))) n++; if (!s.size) this.m.delete(k); return n; }
  async smembers(k) { return [...(this._get(k) || [])]; }
  async scard(k) { return (this._get(k) || new Set()).size; }
}
globalThis.__ledgerStore = new Mem();
export const mem = globalThis.__ledgerStore;

const handlers = {};
for (const f of ["auth", "group", "home", "receipt", "backup", "cron"]) handlers[f] = (await import(path.join(root, "api", f + ".js"))).default;

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml" };

export function start(port = 5180) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const m = u.pathname.match(/^\/api\/([a-z]+)$/);
    if (m && handlers[m[1]]) {
      let raw = "";
      for await (const c of req) raw += c;
      req.query = Object.fromEntries(u.searchParams);
      try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = raw; }
      res.status = c => { res.statusCode = c; return res; };
      res.json = o => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); return res; };
      // Local test server is plain http, so drop "Secure" from cookies.
      const sh = res.setHeader.bind(res);
      res.setHeader = (k, v) => sh(k, k.toLowerCase() === "set-cookie" ? String(v).replace("; Secure", "") : v);
      return handlers[m[1]](req, res);
    }
    let p = u.pathname.startsWith("/g/") || u.pathname === "/" ? "/index.html" : u.pathname;
    const file = path.join(root, "public", path.normalize(p));
    if (!file.startsWith(path.join(root, "public")) || !fs.existsSync(file)) { res.statusCode = 404; return res.end("not found"); }
    res.setHeader("content-type", types[path.extname(file)] || "application/octet-stream");
    for (const h of (JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8")).headers || [])[0]?.headers || []) res.setHeader(h.key, h.value);
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(ok => server.listen(port, () => ok(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Seed the old single-group data so moving it over can be tried.
  if (process.env.SEED_LEGACY) {
    const P = { a: "aaaaaaaa1", b: "bbbbbbbb1", c: "cccccccc1" };
    await mem.hset("ledger:people", {
      [P.a]: JSON.stringify({ id: P.a, name: "Nitin", color: "#2f3fa0", order: 1 }),
      [P.b]: JSON.stringify({ id: P.b, name: "Sonal", color: "#b4412c", order: 2 }),
      [P.c]: JSON.stringify({ id: P.c, name: "Rajat", color: "#18794e", order: 3 }),
    });
    await mem.set("ledger:meta", JSON.stringify({ name: "Vacay Mode On", currency: "USD" }));
    await mem.hset("ledger:entries", {
      e1aaaaaaa: JSON.stringify({ id: "e1aaaaaaa", type: "expense", amount: 30000, date: "2026-10-22", paidBy: P.a, split: { [P.a]: 10000, [P.b]: 10000, [P.c]: 10000 }, desc: "Lodge", category: "Travel", mode: "equal", note: "", addedBy: P.a, createdAt: Date.now() - 86400000, receipts: ["rx1aaaaaa"] }),
    });
    await mem.set("ledger:receipt:rx1aaaaaa", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
    await mem.lpush("ledger:log", JSON.stringify({ t: Date.now() - 86400000, by: P.a, action: "added", type: "expense", desc: "Lodge", amount: 30000, from: P.a }));
    process.env.GROUP_PASSCODE = "oldpass1";
  }
  await start(Number(process.env.PORT || 5180));
  console.log("listening");
}
