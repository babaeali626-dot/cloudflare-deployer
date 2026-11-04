import { json, readJson, requireDb, requireUser, requireAdmin, enforceSameOrigin, hashPassword, httpError } from "../_lib/shared.js";

export async function onRequestGet({ request, env }) {
  try {
    const db = requireDb(env);
    const user = await requireUser(request, env);
    requireAdmin(user);
    const users = await db.prepare("SELECT id,username,role,active,created_at FROM users ORDER BY created_at").all();
    const permissions = await db.prepare("SELECT user_id,account_id,can_rebuild FROM account_permissions").all();
    const map = new Map();
    const rebuildMap = new Map();
    for (const row of (permissions.results || [])) {
      if (!map.has(row.user_id)) map.set(row.user_id, []);
      if (!rebuildMap.has(row.user_id)) rebuildMap.set(row.user_id, []);
      map.get(row.user_id).push(row.account_id);
      if (row.can_rebuild === 1) rebuildMap.get(row.user_id).push(row.account_id);
    }
    return json({ success: true, users: (users.results || []).map(row => ({ ...row, accountIds: map.get(row.id) || [], rebuildIds: rebuildMap.get(row.id) || [] })) });
  } catch (error) { return json({ success: false, error: error.message }, error.status || 500); }
}

export async function onRequestPost({ request, env }) {
  try {
    enforceSameOrigin(request);
    const db = requireDb(env);
    const admin = await requireUser(request, env);
    requireAdmin(admin);
    const body = await readJson(request, 16 * 1024);
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    const accountIds = Array.isArray(body.accountIds) ? [...new Set(body.accountIds.map(String))].slice(0, 50) : [];
    const rebuildIds = Array.isArray(body.rebuildIds) ? [...new Set(body.rebuildIds.map(String))].filter(id => accountIds.includes(id)) : [];
    if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) throw httpError("نام کاربری باید ۳ تا ۴۰ نویسه و شامل حروف انگلیسی، عدد، نقطه، خط تیره یا زیرخط باشد.", 400);
    if (password.length < 12 || password.length > 256) throw httpError("رمز اولیه کاربر باید حداقل ۱۲ نویسه داشته باشد.", 400);
    const exists = await db.prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE").bind(username).first();
    if (exists) throw httpError("این نام کاربری قبلاً ثبت شده است.", 409);
    for (const id of accountIds) {
      const account = await db.prepare("SELECT id FROM accounts WHERE id=?").bind(id).first();
      if (!account) throw httpError("یکی از حساب‌های انتخاب‌شده وجود ندارد.", 400);
    }
    const hashed = await hashPassword(password);
    const id = crypto.randomUUID();
    const now = Date.now();
    await db.prepare("INSERT INTO users (id,username,password_salt,password_hash,role,active,created_at,updated_at) VALUES (?,?,?,?, 'member',1,?,?)")
      .bind(id, username, hashed.salt, hashed.hash, now, now).run();
    for (const accountId of accountIds) {
      await db.prepare("INSERT INTO account_permissions (user_id,account_id,can_deploy,can_rebuild,granted_by,granted_at) VALUES (?,?,1,?,?,?)")
        .bind(id, accountId, rebuildIds.includes(accountId) ? 1 : 0, admin.id, now).run();
    }
    return json({ success: true, user: { id, username, role: "member", active: 1, accountIds, rebuildIds } }, 201);
  } catch (error) { return json({ success: false, error: error.message }, error.status || 500); }
}
