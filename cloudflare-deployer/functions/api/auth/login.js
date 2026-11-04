import { json, readJson, httpError, requireDb, enforceSameOrigin, hashPassword, verifyPassword, createSession } from "../../_lib/shared.js";

async function noteFailure(db, ipHash, now) {
  const prior = await db.prepare("SELECT failed_count FROM login_attempts WHERE ip_hash=?").bind(ipHash).first();
  const count = Number(prior?.failed_count || 0) + 1;
  const lockedUntil = count >= 7 ? now + 15 * 60 * 1000 : null;
  await db.prepare(
    `INSERT INTO login_attempts (ip_hash,failed_count,locked_until,updated_at) VALUES (?,?,?,?)
     ON CONFLICT(ip_hash) DO UPDATE SET failed_count=excluded.failed_count,locked_until=excluded.locked_until,updated_at=excluded.updated_at`
  ).bind(ipHash, count, lockedUntil, now).run();
  return count;
}

async function sha(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, "0")).join("");
}

export async function onRequestPost({ request, env }) {
  try {
    enforceSameOrigin(request);
    const db = requireDb(env);
    const body = await readJson(request, 8 * 1024);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username) || password.length < 1 || password.length > 256) {
      return json({ success: false, error: "نام کاربری یا رمز عبور نادرست است." }, 400);
    }
    const ip = request.headers.get("CF-Connecting-IP") || "unknown-client";
    const ipHash = await sha(ip);
    const now = Date.now();
    await db.prepare("DELETE FROM sessions WHERE expires_at<=?").bind(now).run();
    const attempt = await db.prepare("SELECT failed_count,locked_until FROM login_attempts WHERE ip_hash=?").bind(ipHash).first();
    if (attempt?.locked_until && Number(attempt.locked_until) > now) {
      return json({ success: false, error: "تلاش‌های ورود بیش از حد بوده است. ۱۵ دقیقه دیگر دوباره امتحان کنید." }, 429);
    }

    let user = await db.prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE LIMIT 1").bind(username).first();
    if (!user) {
      const count = await db.prepare("SELECT COUNT(*) AS total FROM users").first();
      const bootstrapUser = String(env.BOOTSTRAP_ADMIN_USERNAME || "");
      const bootstrapPassword = String(env.BOOTSTRAP_ADMIN_PASSWORD || "");
      if (Number(count?.total || 0) === 0 && bootstrapUser && bootstrapPassword && username === bootstrapUser && password === bootstrapPassword) {
        const hashed = await hashPassword(password);
        const id = crypto.randomUUID();
        await db.prepare(
          `INSERT OR IGNORE INTO users (id,username,password_salt,password_hash,role,active,failed_attempts,created_at,updated_at)
           SELECT ?,?,?,?,'admin',1,0,?,? WHERE NOT EXISTS (SELECT 1 FROM users)`
        ).bind(id, bootstrapUser, hashed.salt, hashed.hash, now, now).run();
        user = await db.prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE LIMIT 1").bind(bootstrapUser).first();
      }
    }

    if (!user || user.active !== 1) {
      await noteFailure(db, ipHash, now);
      return json({ success: false, error: "نام کاربری یا رمز عبور نادرست است." }, 401);
    }
    if (user.locked_until && Number(user.locked_until) > now) {
      return json({ success: false, error: "این حساب موقتاً قفل شده است. ۱۵ دقیقه دیگر دوباره تلاش کنید." }, 429);
    }
    const valid = await verifyPassword(password, user.password_salt, user.password_hash);
    if (!valid) {
      const failed = Number(user.failed_attempts || 0) + 1;
      const lock = failed >= 7 ? now + 15 * 60 * 1000 : null;
      await db.prepare("UPDATE users SET failed_attempts=?,locked_until=?,updated_at=? WHERE id=?").bind(failed, lock, now, user.id).run();
      await noteFailure(db, ipHash, now);
      return json({ success: false, error: "نام کاربری یا رمز عبور نادرست است." }, 401);
    }

    await db.prepare("UPDATE users SET failed_attempts=0,locked_until=NULL,updated_at=? WHERE id=?").bind(now, user.id).run();
    await db.prepare("DELETE FROM login_attempts WHERE ip_hash=?").bind(ipHash).run();
    const cookie = await createSession(db, user.id);
    return json({ success: true, user: { id: user.id, username: user.username, role: user.role } }, 200, { "Set-Cookie": cookie });
  } catch (error) {
    return json({ success: false, error: error.message || "خطای ورود." }, error.status || 500);
  }
}
