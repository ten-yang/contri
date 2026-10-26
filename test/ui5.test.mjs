// Round 5: new picture, Storyset credit, red "You owe", faster live updates, show/hide passcode, security headers
import { createRequire } from "node:module";
const require = createRequire("/opt/npm-tools/node_modules/");
const { chromium } = require("playwright");
const { start } = await import("./server.js");
await start(5196); const base = "http://localhost:5196";
const out = "/tmp/claude-0/-home-claude/f4860964-739b-511c-bf6c-ccc114cc755d/scratchpad/shots5";
(await import("node:fs")).mkdirSync(out, { recursive: true });
const browser = await chromium.launch(); const errors = [];
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("ok:", m); };
async function phone(){ const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }); const p = await c.newPage();
  p.on("pageerror", e => errors.push(e.message)); p.on("console", m => { if (m.type() === "error") errors.push(m.text()); }); return p; }
const shot = (p, n) => p.screenshot({ path: `${out}/${n}.png`, fullPage: true });
const bg = (p, sel) => p.$eval(sel, e => getComputedStyle(e).backgroundColor);

const a = await phone(), b = await phone();
const r = await a.goto(base + "/");
ok(/frame-ancestors 'none'/.test(r.headers()["content-security-policy"] || ""), "security headers are sent");
ok(await a.locator(".credit a[href='https://storyset.com']").count() === 1, "Storyset credit on welcome screen");
// eye toggle on sign-up password
await a.fill("#ap", "password123");
ok(await a.getAttribute("#ap", "type") === "password", "password hidden by default");
await a.click("#ap + .eye"); ok(await a.getAttribute("#ap", "type") === "text", "eye shows password");
await shot(a, "welcome-eye");
await a.click("#ap + .eye"); ok(await a.getAttribute("#ap", "type") === "password", "eye hides it again");
await a.fill("#au", "tenyang"); await a.click("button[type=submit]"); await a.check("#rcOk"); await a.click("#rcDone"); await a.waitForSelector("text=No groups yet");
await b.goto(base + "/"); await b.fill("#au", "nitin"); await b.fill("#ap", "password123"); await b.click("button[type=submit]"); await b.check("#rcOk"); await b.click("#rcDone"); await b.waitForSelector("text=No groups yet");

await a.click("text=Create a group"); await a.fill("#gn", "Trip"); await a.fill("#gp", "beach-2026");
ok(await a.getAttribute("#gp", "type") === "text", "new group passcode visible while creating");
await a.click("#gp + .eye"); ok(await a.getAttribute("#gp", "type") === "password", "and can be hidden");
await a.click("button[type=submit]");
const link = (await a.textContent(".mono-box .num")).trim(); await a.click("text=Open Trip");
await b.goto(link); await b.fill("#jp", "beach-2026");
await b.click("#jp + .eye"); ok(await b.getAttribute("#jp", "type") === "text", "join passcode can be shown");
await b.click("button[type=submit]"); await b.waitForSelector("h1:has-text('Trip')");

// empty expenses picture
await a.reload(); await a.waitForSelector(".hero");
await a.click("text=Expenses"); await a.waitForSelector("text=No expenses yet");
ok((await a.getAttribute(".illus", "src")).includes("empty.webp?v=2"), "new no-expenses picture");
ok(await a.$eval(".illus", i => i.complete && i.naturalWidth === 640), "picture loads");
await shot(a, "no-expenses");

// b adds an expense paid by b -> a owes. a sits on the group page (with Search focused) and should see it without reloading
await a.goto(link); await a.waitForSelector(".hero");
const greenBg = await bg(a, ".hero");
async function add(p, desc, amt){ await p.click("button:has-text('Add expense')"); await p.waitForSelector("#fxCats"); await p.click("#fxCats [data-cat='Dining']");
  await p.fill("#fxDesc", desc); await p.fill("#fxAmt", amt); await p.click("#fxSave"); await p.waitForSelector("h1:has-text('Expenses')"); }
await b.reload(); await b.waitForSelector(".hero"); await add(b, "Pizza", "40");
await a.waitForFunction(() => document.querySelector(".hero .lbl")?.textContent.includes("You owe"), null, { timeout: 15000 });
ok(true, "group page updates within ~10 seconds");
ok(await bg(a, ".hero") !== greenBg && (await bg(a, ".hero")).includes("168, 69, 42"), "You owe ticket is red");
await shot(a, "owe-red");

// Expenses page with Search focused still refreshes, and focus stays
await a.click("text=Expenses"); await a.waitForSelector("#exQ"); await a.click("#exQ"); await a.type("#exQ", "z");
await a.fill("#exQ", "");
await add(b, "Coffee", "10").catch(()=>{});
await a.waitForFunction(() => document.querySelector("#exList")?.textContent.includes("Coffee"), null, { timeout: 15000 });
ok(await a.evaluate(() => document.activeElement && document.activeElement.id === "exQ"), "search stays focused after a refresh");

// Home updates on its own
await a.goto(base + "/"); await a.waitForSelector("text=Overall, by currency");
const before = await a.textContent(".gcard");
await b.goto(link.replace(/\/?$/, "")); await b.waitForSelector(".hero"); await add(b, "Tickets", "100");
await a.waitForFunction(t => document.querySelector(".gcard")?.textContent !== t, before, { timeout: 15000 });
ok(true, "Home updates within ~10 seconds");
ok(await a.locator(".hero .cline.owe").count() === 1, "Home You owe line is red");
await shot(a, "home-owe");
// b is owed -> stays green
await b.goto(base + "/"); await b.waitForSelector("text=Overall, by currency");
ok(await b.locator(".hero .cline.owe").count() === 0 && !(await b.getAttribute(".hero", "class")).includes("owe"), "You're owed stays green");
await b.click(".gcard"); await b.waitForSelector(".hero"); ok(!(await b.getAttribute(".hero", "class")).includes("owe"), "group ticket green when owed");

console.log("errors", errors); if (errors.length) process.exitCode = 1;
await browser.close(); process.exit();
