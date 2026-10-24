// GET  /api/auth           -> {user} (null when signed out)
// POST /api/auth {op, ...}  -> signup, login, logout, reset, changeUsername, changePassword, newRecovery, deleteProfile
import {
  handle, body, ipOf, K, Bad, need, rid, hashSecret, secretOk, sha, newRecoveryCode, normCode,
  cleanUsername, cleanPassword, getUser, putUser, startSession, clearCookie, endAllSessions, whoami, requireUser,
  checkLock, addFail, readCookie, loadMeta, parseJSON, record,
} from "./_lib.js";
import { checkCanLeave, doLeave, deleteGroup, people, activeMembers } from "./_groups.js";

const pub = u => u && { id: u.id, username: u.username, createdAt: u.createdAt };

export default handle(async (req, res, db) => {
  if (req.method === "GET") {
    const u = await whoami(db, req);
    if (!u) return res.status(200).json({ user: null });
    const groups = Number(await db.scard(K.userGroups(u.id))) || 0;
    return res.status(200).json({ user: { ...pub(u), groups } });
  }
  if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Method not allowed." }); }
  const b = body(req);
  const ip = ipOf(req);

  switch (b.op) {
    case "signup": {
      await checkLock(db, "signup", ip, 20);
      const username = cleanUsername(b.username);
      const password = cleanPassword(b.password);
      const uid = rid(16);
      const taken = !(Number(await db.hsetnx(K.names, username.toLowerCase(), uid)));
      if (taken) throw new Bad("That username is taken. Try another.", 409);
      await addFail(db, "signup", ip); // counts sign-ups per device, to slow down mass sign-ups
      const code = newRecoveryCode();
      const u = { id: uid, username, pw: hashSecret(password), rc: { h: sha(normCode(code)) }, createdAt: Date.now() };
      await putUser(db, u);
      await startSession(db, res, uid);
      return res.status(200).json({ user: { ...pub(u), groups: 0 }, recoveryCode: code });
    }

    case "login": {
      const name = String(b.username || "").trim().toLowerCase();
      await checkLock(db, "login", ip, 20);
      await checkLock(db, "loginu", name, 10);
      const uid = name ? await db.hget(K.names, name) : null;
      const u = uid ? await getUser(db, String(uid)) : null;
      if (!u || !secretOk(b.password, u.pw)) {
        await addFail(db, "login", ip); if (name) await addFail(db, "loginu", name);
        throw new Bad("That username and password don't match.", 401, { badLogin: true });
      }
      await startSession(db, res, u.id);
      const groups = Number(await db.scard(K.userGroups(u.id))) || 0;
      return res.status(200).json({ user: { ...pub(u), groups } });
    }

    case "logout": {
      const tok = readCookie(req);
      if (tok) {
        const h = sha(tok);
        const uid = await db.get(K.sess(h));
        await db.del(K.sess(h));
        if (uid) await db.srem(K.userSess(String(uid)), h);
      }
      clearCookie(res);
      return res.status(200).json({ ok: true });
    }

    case "reset": {
      const name = String(b.username || "").trim().toLowerCase();
      await checkLock(db, "reset", ip, 10);
      await checkLock(db, "resetu", name, 5);
      const uid = name ? await db.hget(K.names, name) : null;
      const u = uid ? await getUser(db, String(uid)) : null;
      if (!u || sha(normCode(b.code)) !== u.rc.h) {
        await addFail(db, "reset", ip); if (name) await addFail(db, "resetu", name);
        throw new Bad("That username and recovery code don't match.", 401, { badLogin: true });
      }
      const password = cleanPassword(b.password);
      const code = newRecoveryCode();
      u.pw = hashSecret(password); u.rc = { h: sha(normCode(code)) };
      await putUser(db, u);
      await endAllSessions(db, u.id);
      await startSession(db, res, u.id);
      return res.status(200).json({ user: pub(u), recoveryCode: code });
    }

    case "changeUsername": {
      const u = await requireUser(db, req);
      const username = cleanUsername(b.username);
      const oldLower = u.username.toLowerCase(), newLower = username.toLowerCase();
      if (newLower !== oldLower) {
        const taken = !(Number(await db.hsetnx(K.names, newLower, u.id)));
        if (taken) throw new Bad("That username is taken. Try another.", 409);
        await db.hdel(K.names, oldLower);
      }
      const old = u.username;
      u.username = username;
      await putUser(db, u);
      // Groups show the username; update it where the group name still matches the old one.
      for (const gid of (await db.smembers(K.userGroups(u.id))) || []) {
        const k = K.g(gid);
        const pid = await db.hget(k.members, u.id);
        const p = pid ? parseJSON(await db.hget(k.people, String(pid)), null) : null;
        if (p && p.name.toLowerCase() === old.toLowerCase()) {
          const clash = Object.values(await people(db, gid)).some(x => x.id !== p.id && x.name.toLowerCase() === newLower);
          if (clash) continue;
          p.name = username;
          await db.hset(k.people, { [p.id]: JSON.stringify(p) });
          await record(db, gid, { by: p.id, action: "renamed", name: username, from: old });
        }
      }
      return res.status(200).json({ user: pub(u) });
    }

    case "changePassword": {
      const u = await requireUser(db, req);
      await checkLock(db, "pw", u.id, 10);
      if (!secretOk(b.current, u.pw)) { await addFail(db, "pw", u.id); throw new Bad("Your current password isn't right.", 400); }
      u.pw = hashSecret(cleanPassword(b.password));
      await putUser(db, u);
      await endAllSessions(db, u.id);       // log out other devices
      await startSession(db, res, u.id);
      return res.status(200).json({ ok: true });
    }

    case "newRecovery": {
      const u = await requireUser(db, req);
      await checkLock(db, "pw", u.id, 10);
      if (!secretOk(b.password, u.pw)) { await addFail(db, "pw", u.id); throw new Bad("That password isn't right.", 400); }
      const code = newRecoveryCode();
      u.rc = { h: sha(normCode(code)) };
      await putUser(db, u);
      return res.status(200).json({ recoveryCode: code });
    }

    case "deleteProfile": {
      const u = await requireUser(db, req);
      await checkLock(db, "pw", u.id, 10);
      if (!secretOk(b.password, u.pw)) { await addFail(db, "pw", u.id); throw new Bad("That password isn't right.", 400); }
      const gids = (await db.smembers(K.userGroups(u.id))) || [];
      const plan = [];
      // Check every group first, so nothing changes unless the whole thing can go through.
      for (const gid of gids) {
        const meta = await loadMeta(db, gid);
        const pid = await db.hget(K.g(gid).members, u.id);
        if (!meta || !pid) continue;
        const ppl = await people(db, gid);
        const alone = meta.creator === u.id && activeMembers(ppl).filter(p => p.uid !== u.id).length === 0;
        if (alone) { plan.push({ gid, del: true }); continue; }
        try { await checkCanLeave(db, gid, String(pid), meta, u, null); }
        catch (e) {
          if (e.extra && e.extra.owed !== undefined) throw new Bad(`Settle up in ${meta.name} first.`, 409);
          throw new Bad(`You created ${meta.name}. Hand it over to someone in its settings first.`, 409);
        }
        plan.push({ gid, pid: String(pid), meta });
      }
      for (const s of plan) {
        if (s.del) await deleteGroup(db, s.gid);
        else await doLeave(db, s.gid, s.pid, s.meta, u, null);
      }
      await endAllSessions(db, u.id);
      await db.hdel(K.names, u.username.toLowerCase());
      await db.del(K.user(u.id));
      await db.del(K.userGroups(u.id));
      clearCookie(res);
      return res.status(200).json({ ok: true });
    }

    default:
      need(false, "Unknown request.");
  }
});
