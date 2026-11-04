import { json, readJson, requireDb, requireUser, requireAdmin, enforceSameOrigin, hashPassword, httpError } from "../../_lib/shared.js";

export async function onRequestPatch({ request, env, params }) {
  try {
    enforceSameOrigin(request);
    const db = requireDb(env);
    const admin = await requireUser(request, env);
    requireAdmin(admin);
    const id = String(params.id || "");
    if (id === admin.id) throw httpError("برای تغییر رمز مدیر از بخش تغییر رمز استفاده کنید.", 400);
    const user = await db.prepare("SELECT id,role FROM users WHERE id=?").bind(id).first();
    if (!user || user.role === "admin") throw httpError("کاربر مجاز پیدا نشد.", 404);
    const body = await readJson(request, 16 * 1024);
    if (body.password !== undefined && body.password !== "") {
      const password = String(body.password);
      if (password.length < 12 || password.length > 256) throw httpError("رمز جدید باید حداقل ۱۲ نویسه داشته باشد.", 400);
      const hashed = await hashPassword(password);
      await db.prepare("UPDATE users SET password_salt=?,password_hash=?,updated_at=? WHERE id=?")
        .bind(hashed.salt, hashed.hash, Date.now(), id).run();
      await db.prepare("DELETE FROM sessions WHERE user_id=?").bind(id).run();
    }
    if (body.active !== undefined) {
      await db.prepare("UPDATE users SET active=?,updated_at=? WHERE id=?").bind(body.active ? 1 : 0, Date.now(), id).run();
      if (!body.active) await db.prepare("DELETE FROM sessions WHERE user_id=?").bind(id).run();
    }
    if (Array.isArray(body.accountIds)) {
      const accountIds = [...new Set(body.accountIds.map(String))].slice(0, 50);
      const rebuildIds = Array.isArray(body.rebuildIds) ? [...new Set(body.rebuildIds.map(String))].filter(accountId => accountIds.includes(accountId)) : [];
      for (const accountId of accountIds) {
        const account = await db.prepare("SELECT id FROM accounts WHERE id=?").bind(accountId).first();
        if (!account) throw httpError("یکی از حساب‌های انتخاب‌شده وجود ندارد.", 400);
      }
      await db.prepare("DELETE FROM account_permissions WHERE user_id=?").bind(id).run();
      const now = Date.now();
      for (const accountId of accountIds) {
        await db.prepare("INSERT INTO account_permissions (user_id,account_id,can_deploy,can_rebuild,granted_by,granted_at) VALUES (?,?,1,?,?,?)")
          .bind(id, accountId, rebuildIds.includes(accountId) ? 1 : 0, admin.id, now).run();
      }
    }
    return json({ success: true });
  } catch (error) { return json({ success: false, error: error.message }, error.status || 500); }
}

export async function onRequestDelete({ request, env, params }) {
  try {
    enforceSameOrigin(request);
    const db = requireDb(env);
    const admin = await requireUser(request, env);
    requireAdmin(admin);
    const id = String(params.id || "");
    if (id === admin.id) throw httpError("نمی‌توانید حساب مدیر خودتان را حذف کنید.", 400);
    const target = await db.prepare("SELECT role FROM users WHERE id=?").bind(id).first();
    if (!target || target.role === "admin") throw httpError("کاربر مجاز پیدا نشد.", 404);
    await db.prepare("DELETE FROM sessions WHERE user_id=?").bind(id).run();
    await db.prepare("DELETE FROM account_permissions WHERE user_id=?").bind(id).run();
    await db.prepare("DELETE FROM users WHERE id=?").bind(id).run();
    return json({ success: true });
  } catch (error) { return json({ success: false, error: error.message }, error.status || 500); }
}
