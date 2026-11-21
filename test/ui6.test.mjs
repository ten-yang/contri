// Round 6: who owes whom, All payments screen, settle-up setting, saved Home, one startup call, service worker
import { createRequire } from "node:module";
const require = createRequire("/opt/npm-tools/node_modules/");
const { chromium } = require("playwright");
const { start } = await import("./server.js");
await start(5197); const base = "http://localhost:5197";
const out = "/tmp/claude-0/-home-claude/f4860964-739b-511c-bf6c-ccc114cc755d/scratchpad/shots6";
(await import("node:fs")).mkdirSync(out, { recursive: true });
const browser = await chromium.launch(); const errors = [];
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("ok:", m); };
const calls = {};
async function phone(n){ const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }); const p = await c.newPage();
  p.on("pageerror", e => errors.push(e.message)); p.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  calls[n] = []; p.on("request", r => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/")) calls[n].push(u.pathname); }); return p; }
const shot = (p, n) => p.screenshot({ path: `${out}/${n}.png`, fullPage: true });
const txt = (p, s) => p.textContent(s);

const a = await phone("a"), b = await phone("b"), c = await phone("c");
await a.goto(base + "/");
ok(calls.a.filter(x => x === "/api/auth").length === 0 && calls.a.includes("/api/home"), "first open makes one call (/api/home), not /api/auth");
async function signup(p, u){ await p.goto(base + "/"); await p.fill("#au", u); await p.fill("#ap", "password123"); await p.click("button[type=submit]"); await p.check("#rcOk"); await p.click("#rcDone"); await p.waitForSelector("text=No groups yet"); }
await signup(a, "anna"); await signup(b, "ben"); await signup(c, "cara");
await a.click("text=Create a group"); await a.fill("#gn", "Trip"); await a.fill("#gp", "beach-2026"); await a.click("button[type=submit]");
const link = (await txt(a, ".mono-box .num")).trim(); await a.click("text=Open Trip");
for (const p of [b, c]){ await p.goto(link); await p.fill("#jp", "beach-2026"); await p.click("button[type=submit]"); await p.waitForSelector("h1:has-text('Trip')"); }
async function add(p, desc, amt){ await p.goto(link); await p.waitForSelector(".hero"); await p.click("button:has-text('Add expense')"); await p.waitForSelector("#fxCats"); await p.click("#fxCats [data-cat='Dining']");
  await p.fill("#fxDesc", desc); await p.fill("#fxAmt", amt); await p.click("#fxSave"); await p.waitForSelector("h1:has-text('Expenses')"); }
await add(a, "Hotel", "90");   // split 3 ways: 30 each
await add(b, "Dinner", "30");  // 10 each
// Who owes whom: ben->anna 20, cara->anna 30, cara->ben 10. Fewest: cara->anna 40, ben->anna 20.

await c.goto(link); await c.waitForSelector(".hero");
const card = await txt(c, "section:has(h2:text('Settle up'))");
ok(card.includes("Who owes whom"), "group page says Who owes whom by default");
ok(/You pay\s*anna/.test(card) && card.includes("$30.00") && /You pay\s*ben/.test(card) && card.includes("$10.00"), "cara sees both people she owes");
ok(card.includes("See all 3 payments"), "See all 3 payments button");
await shot(c, "group-cara");
await c.click("text=See all 3 payments"); await c.waitForSelector("h1:has-text('All payments')");
ok((await txt(c, "main, body")).includes("Your share of 1 thing anna paid for"), "subline counts the expenses");
ok(/Total\s*\$40\.00/.test(await txt(c, "section:has(h2:text('You pay'))")), "You pay total is $40");
ok(/ben\s*pays\s*anna/.test(await txt(c, "section:has(h2:text('Everyone else'))")), "Everyone else lists ben pays anna");
await shot(c, "payments-cara");
await c.click("[data-act=flipView][data-m=fewest]");
ok(/You pay\s*anna/.test(await txt(c, "section:has(h2:text('You pay'))")) && (await txt(c, "section:has(h2:text('You pay'))")).includes("$40.00"), "flip to Fewest payments: one $40 payment to anna");
ok(await c.locator("section:has(h2:text('You pay')) [data-act=settle]").count() === 1, "fewest view shows one row for cara");

// ben both owes and is owed
await b.goto(link + "/payments"); await b.waitForSelector("h1:has-text('All payments')");
const sums = await txt(b, ".sumtiles");
ok(sums.includes("$20.00") && sums.includes("$10.00"), "ben sees You pay $20 and You get $10 tiles");
ok((await txt(b, "body")).includes("Overall you owe $10.00"), "overall line");
await shot(b, "payments-ben");
await b.click("section:has(h2:text('You get')) button:has-text('Got it')");
await b.waitForSelector(".undo");
ok(await b.locator("section:has(h2:text('You get'))").count() === 0, "Got it records cara's payment to ben");
await c.goto(link); await c.waitForSelector(".hero");
ok(!(await txt(c, "section:has(h2:text('Settle up'))")).includes("ben"), "cara no longer owes ben");
ok((await txt(c, ".hero")).includes("30.00"), "cara's total now $30");

// Setting: only the creator can change it
await b.goto(link + "/settings"); await b.waitForSelector("text=How to settle up");
ok(await b.locator("input[name=settleMode]:disabled").count() === 2, "non-creator sees the setting but can't change it");
await a.goto(link + "/settings"); await a.waitForSelector("text=How to settle up");
await shot(a, "settings-anna");
await a.check("input[name=settleMode][value=fewest]"); await a.waitForSelector("text=Settle up updated");
await a.goto(link); await a.waitForSelector(".hero");
ok((await txt(a, "section:has(h2:text('Settle up'))")).includes("Fewest payments"), "group switches to Fewest payments");
await a.goto(link + "/activity"); await a.waitForSelector("h1");
ok((await txt(a, "body")).includes("changed how to settle up to Fewest payments"), "Activity records the change");
await a.goto(link + "/settings"); await a.check("input[name=settleMode][value=direct]"); await a.waitForSelector("text=Settle up updated");

// Home: settle card uses pairwise rows; saved Home shows instantly; logout clears it
await b.goto(base + "/"); await b.waitForSelector("text=Overall, by currency");
ok(/You pay\s*anna/.test(await txt(b, "body")), "ben's Home settle card shows pay anna");
ok(await b.evaluate(() => !!localStorage.getItem("contri.home.v1")), "Home is saved on the phone");
calls.b = [];
await b.reload(); await b.waitForSelector("text=Overall, by currency");
await b.waitForTimeout(800);
ok(!calls.b.includes("/api/auth") && calls.b.filter(x => x === "/api/home").length >= 1, "reopen shows saved Home, then refreshes with one call");
ok(await b.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())), "service worker registered");
ok(await b.evaluate(async () => { const ks = await caches.keys(); for (const k of ks){ const c = await caches.open(k); const r = await c.keys(); if (r.some(q => new URL(q.url).pathname.startsWith("/api/"))) return false; } return ks.length > 0; }), "service worker saved app files and no money data");
await b.click("[data-act=profile]");
await b.waitForSelector("[data-act=logout]"); await b.click("[data-act=logout]"); await b.waitForSelector("#au");
ok(await b.evaluate(() => !localStorage.getItem("contri.home.v1")), "logout clears the saved Home");

console.log("errors", errors); if (errors.length) process.exitCode = 1;
await browser.close(); process.exit();
