// End-to-end API checks against the in-memory store. Run: node test/api.test.js
import assert from "node:assert/strict";
process.env.GROUP_PASSCODE = "oldpass1";
const { start, mem } = await import("./server.js");
const server = await start(5191);
const base = "http://localhost:5191";

function client() {
  let cookie = "";
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const j = await r.json().catch(() => ({}));
    return { s: r.status, ...j };
  };
}
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// seed legacy
const P = { a: "aaaaaaaa1", b: "bbbbbbbb1", c: "cccccccc1" };
await mem.hset("ledger:people", {
  [P.a]: JSON.stringify({ id: P.a, name: "Nitin", color: "#2f3fa0", order: 1 }),
  [P.b]: JSON.stringify({ id: P.b, name: "Sonal", color: "#b4412c", order: 2 }),
  [P.c]: JSON.stringify({ id: P.c, name: "Rajat", color: "#18794e", order: 3 }),
});
await mem.set("ledger:meta", JSON.stringify({ name: "Vacay Mode On", currency: "USD" }));
await mem.hset("ledger:entries", { e1aaaaaaa: JSON.stringify({ id: "e1aaaaaaa", type: "expense", amount: 30000, date: "2026-10-22", paidBy: P.a, split: { [P.a]: 10000, [P.b]: 10000, [P.c]: 10000 }, desc: "Lodge", category: "Travel", mode: "equal", note: "", addedBy: P.a, createdAt: Date.now() - 86400000, receipts: ["rx1aaaaaa"] }) });
await mem.set("ledger:receipt:rx1aaaaaa", "data:image/png;base64,AAAA");

const n = client(), s = client(), r = client(), x = client();

// sign up
let res = await n("POST", "/api/auth", { op: "signup", username: "nitin", password: "short" });
ok(res.s === 400, "short password rejected");
res = await n("POST", "/api/auth", { op: "signup", username: "nitin", password: "password123" });
ok(res.s === 200 && /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(res.recoveryCode), "signup gives code");
const nCode = res.recoveryCode;
ok((await s("POST", "/api/auth", { op: "signup", username: "NITIN", password: "password123" })).s === 409, "username unique case-insensitive");
ok((await s("POST", "/api/auth", { op: "signup", username: "sonal", password: "password123" })).s === 200, "sonal signs up");
ok((await r("POST", "/api/auth", { op: "signup", username: "rajat", password: "password123" })).s === 200, "rajat signs up");
ok((await x("GET", "/api/auth")).user === null, "signed out sees null");
ok((await x("GET", "/api/home")).user === null, "home without login says logged out");

// legacy join
const L = "v4Cm9Lr2Qa";
res = await n("GET", "/api/group?g=" + L);
ok(res.invite && res.invite.name === "Vacay Mode On" && res.invite.people === 3, "legacy invite preview");
ok((await n("POST", "/api/group", { op: "join", g: L, passcode: "nope" })).s === 400, "wrong legacy passcode");
res = await n("POST", "/api/group", { op: "join", g: L, passcode: "oldpass1" });
ok(res.choose && res.choose.length === 3, "asked which one is you: " + JSON.stringify(res));
res = await n("POST", "/api/group", { op: "join", g: L, passcode: "oldpass1", claim: P.a });
ok(res.ok, "nitin claimed");
res = await n("GET", "/api/group?g=" + L);
ok(res.isCreator && res.me === P.a && res.entries.length === 1 && res.entries[0].rxExp, "nitin is creator, data moved over");
ok((await n("GET", `/api/receipt?g=${L}&id=rx1aaaaaa`)).data, "photo moved over");
ok(Number(await mem.ttl("c2test:g:" + L + ":rx:rx1aaaaaa")) > 0, "photo has expiry");
res = await s("POST", "/api/group", { op: "join", g: L, passcode: "oldpass1" });
ok(res.choose && res.choose.length === 2, "sonal sees 2 names left");
ok((await s("POST", "/api/group", { op: "join", g: L, passcode: "oldpass1", claim: P.a })).s === 400, "can't take nitin's name");
ok((await s("POST", "/api/group", { op: "join", g: L, passcode: "oldpass1", claim: P.b })).ok, "sonal claimed");
ok((await r("GET", "/api/group?g=" + L)).invite, "rajat not in yet");

// home
res = await s("GET", "/api/home");
ok(res.groups.length === 1 && res.groups[0].net === -10000 && res.groups[0].settles[0].mine === "pay", "sonal owes 100 on home");

// entries
const e2 = { id: "e2bbbbbbb", type: "expense", amount: 9000, date: "2026-10-23", paidBy: P.b, split: { [P.a]: 4500, [P.b]: 4500 }, desc: "Dinner", category: "Dining", mode: "equal" };
ok((await s("POST", "/api/group", { op: "putEntry", g: L, entry: e2 })).ok, "sonal adds expense");
ok((await x("POST", "/api/group", { op: "putEntry", g: L, entry: e2 })).s === 401, "logged out can't add");
res = await n("GET", "/api/group?g=" + L);
ok(res.entries.length === 2 && res.log[0].action === "added", "nitin sees it");

// passcode change
ok((await s("POST", "/api/group", { op: "changePasscode", g: L, passcode: "newpass99" })).s === 403, "only creator changes passcode");
ok((await n("POST", "/api/group", { op: "changePasscode", g: L, passcode: "newpass99" })).ok, "creator changes passcode");
ok((await n("GET", "/api/group?g=" + L)).entries, "creator still in");
res = await s("GET", "/api/group?g=" + L);
ok(res.needPasscode, "sonal asked for new passcode");
ok((await s("POST", "/api/group", { op: "putEntry", g: L, entry: { ...e2, id: "e3ccccccc" } })).s === 403, "sonal blocked until re-entry");
ok((await s("GET", "/api/home")).groups[0].needPasscode, "home shows needs passcode");
ok((await s("POST", "/api/group", { op: "verify", g: L, passcode: "oldpass1" })).s === 400, "old passcode no longer works");
ok((await s("POST", "/api/group", { op: "verify", g: L, passcode: "newpass99" })).ok, "sonal re-enters");
ok((await r("POST", "/api/group", { op: "join", g: L, passcode: "oldpass1" })).s === 400, "rajat needs the new passcode");
res = await r("POST", "/api/group", { op: "join", g: L, passcode: "newpass99", claim: "new" });
ok(res.ok, "rajat joins as new");
res = await r("GET", "/api/group?g=" + L);
ok(res.people.filter(p => p.name.toLowerCase().startsWith("rajat")).length === 2 && res.people.some(p => p.name === "rajat 2"), "name clash gets a number");

// leaving
res = await s("POST", "/api/group", { op: "leave", g: L });
ok(res.s === 409 && res.owed !== undefined, "sonal can't leave while owing");
const pay = { id: "p1ddddddd", type: "payment", amount: 5500, date: "2026-10-23", paidBy: P.b, split: { [P.a]: 5500 } };
ok((await s("POST", "/api/group", { op: "putEntry", g: L, entry: pay })).ok, "sonal pays nitin");
res = await s("GET", "/api/group?g=" + L);
ok(res.s === 200, "ok");
ok((await s("POST", "/api/group", { op: "leave", g: L })).left, "settled sonal leaves");
res = await n("GET", "/api/group?g=" + L);
ok(res.people.find(p => p.id === P.b).leftAt && res.log[0].action === "left", "recorded as left");
ok((await s("GET", "/api/home")).groups.length === 0, "sonal's home empty");
ok((await n("POST", "/api/group", { op: "putEntry", g: L, entry: { ...e2, id: "e4ddddddd", paidBy: P.a } })).s === 400, "can't add former member to new expense");
ok((await n("POST", "/api/group", { op: "putEntry", g: L, entry: { ...e2, note: "edited" } })).ok, "old expense with former member still editable");

// creator leave needs handover; owes? nitin net: +100+? compute
res = await n("GET", "/api/group?g=" + L);
res = await n("POST", "/api/group", { op: "leave", g: L });
ok(res.s === 409, "nitin blocked (owed or needs handover): " + res.error);

// rejoin
res = await s("POST", "/api/group", { op: "join", g: L, passcode: "newpass99" });
ok(res.ok, "sonal rejoins as the same person");
res = await s("GET", "/api/group?g=" + L);
ok(res.me === P.b && !res.people.find(p => p.id === P.b).leftAt, "same person, active again");

// new group create/join, delete
res = await r("POST", "/api/group", { op: "create", name: "Flat 4B", passcode: "mango-rooftop", currency: "INR" });
ok(res.ok && /^[A-Za-z0-9]{10}$/.test(res.g), "create group");
const F = res.g;
res = await s("POST", "/api/group", { op: "join", g: F, passcode: "mango-rooftop" });
ok(res.ok, "sonal joins flat directly (no names to claim)");
ok((await s("POST", "/api/group", { op: "deleteGroup", g: F })).s === 403, "only creator deletes");
ok((await s("POST", "/api/group", { op: "setCurrency", g: F, currency: "USD" })).s === 403, "only creator sets currency");
ok((await s("POST", "/api/group", { op: "rename", g: F, name: "Flat 4C" })).ok, "anyone renames");
ok((await r("POST", "/api/group", { op: "leave", g: F })).s === 400, "creator must pick who takes over");
res = await r("GET", "/api/group?g=" + F);
const sp = res.people.find(p => p.name === "sonal").id;
ok((await r("POST", "/api/group", { op: "leave", g: F, handTo: sp })).left, "creator hands over and leaves");
res = await s("GET", "/api/group?g=" + F);
ok(res.isCreator && res.log[1].action === "handed over", "sonal now creator");
ok((await s("POST", "/api/group", { op: "deleteGroup", g: F })).deleted, "new creator deletes");
ok((await s("GET", "/api/group?g=" + F)).s === 404, "deleted group gone");

// photos
const pic = "data:image/jpeg;base64," + "A".repeat(100);
ok((await n("POST", "/api/receipt", { g: L, id: "rx2bbbbbb", data: pic })).ok, "upload photo");
ok(Number(await mem.ttl("c2test:g:" + L + ":rx:rx2bbbbbb")) <= 86400, "unclaimed photo expires in a day");
ok((await n("POST", "/api/group", { op: "putEntry", g: L, entry: { ...e2, id: "e5eeeeeee", paidBy: P.a, split: { [P.a]: 9000 }, receipts: ["rx2bbbbbb"] } })).ok, "save with photo");
ok(Number(await mem.ttl("c2test:g:" + L + ":rx:rx2bbbbbb")) > 86400 * 29, "saved photo lasts 30 days");
ok((await x("GET", `/api/receipt?g=${L}&id=rx2bbbbbb`)).s === 401, "logged out can't see photo");

// trash
ok((await n("POST", "/api/group", { op: "delEntry", g: L, id: "e5eeeeeee" })).ok, "delete");
ok((await n("POST", "/api/group", { op: "restoreEntry", g: L, id: "e5eeeeeee" })).ok, "restore");

// password reset
ok((await n("POST", "/api/auth", { op: "reset", username: "nitin", code: "AAAA-BBBB-CCCC", password: "newpassword1" })).s === 401, "bad code");
res = await x("POST", "/api/auth", { op: "reset", username: "Nitin", code: nCode.toLowerCase().replace(/-/g, " "), password: "newpassword1" });
ok(res.recoveryCode && res.recoveryCode !== nCode, "reset with code (any case/spaces), new code given");
ok((await n("GET", "/api/home")).user === null, "old sessions logged out after reset");
ok((await n("POST", "/api/auth", { op: "login", username: "nitin", password: "password123" })).s === 401, "old password gone");
ok((await n("POST", "/api/auth", { op: "login", username: "NITIN", password: "newpassword1" })).user, "login with new");
ok((await n("POST", "/api/auth", { op: "reset", username: "nitin", code: nCode, password: "another12" })).s === 401, "old code no longer works");

// username change
ok((await n("POST", "/api/auth", { op: "changeUsername", username: "sonal" })).s === 409, "taken");
ok((await r("POST", "/api/auth", { op: "changeUsername", username: "RajatK" })).user.username === "RajatK", "rajat renamed");
res = await r("GET", "/api/group?g=" + L);
ok(res.people.some(p => p.name === "rajat 2"), "group name only follows when it matched the username");

// delete profile
ok((await n("POST", "/api/group", { op: "putEntry", g: L, entry: { ...e2, id: "e6fffffff", paidBy: P.a, split: { [P.a]: 4500, [P.b]: 4500 } } })).ok, "nitin adds one sonal owes on");
ok((await s("POST", "/api/auth", { op: "deleteProfile", password: "password123" })).s === 409, "sonal must settle first");
res = await r("POST", "/api/auth", { op: "deleteProfile", password: "password123" });
ok(res.ok, "rajat (settled) deletes profile: " + res.error);
ok((await r("GET", "/api/home")).user === null, "deleted user logged out");
res = await n("GET", "/api/group?g=" + L);
ok(res.people.find(p => p.name === "rajat 2").leftAt, "rajat shows as former member");
ok((await x("POST", "/api/auth", { op: "signup", username: "rajatk", password: "password123" })).user, "freed username reusable");

// lockouts
for (let i = 0; i < 10; i++) await x("POST", "/api/auth", { op: "login", username: "nitin", password: "wrongwrong" });
ok((await n("POST", "/api/auth", { op: "login", username: "nitin", password: "newpassword1" })).s === 429, "username locked after 10 wrong tries");

// csrf-ish: non-json post rejected
const raw = await fetch(base + "/api/auth", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
ok(raw.status === 415, "non-JSON POST rejected");

// cron
const c = await fetch(base + "/api/cron").then(r => r.json());
ok(c.ok && c.saved >= 1, "nightly copy saved " + JSON.stringify(c));
res = await s("GET", "/api/group?g=" + L);
ok(res.backups.length === 1, "backup listed");
ok((await s("GET", `/api/backup?g=${L}&key=${res.backups[0].key}`)).backup.entries.length >= 2, "backup downloadable");

// legacy can't be re-imported after deletion
console.log("all passed:", pass);
server.close();
process.exit(0);
