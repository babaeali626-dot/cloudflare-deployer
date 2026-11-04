import { json, readJson, requireDb, requireUser, enforceSameOrigin, verifyPassword, hashPassword } from "../../_lib/shared.js";
export async function onRequestPost({ request, env }) {
  try {
    enforceSameOrigin(request);
    const db = requireDb(env);
    const user = await requireUser(request, env);
    const body = await readJson(request, 8 * 1024);
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    if (newPassword.length < 12 || newPassword.length > 256) return json({ success: false, error: "رمز جدید باید حداقل ۱۲ نویسه داشته باشد." }, 400);
    const record = await db.prepare("SELECT password_salt,password_hash FROM users WHERE id=?").bind(user.id).first();
    if (!record || !(await verifyPassword(currentPassword, record.password_salt, record.password_hash))) return json({ success: false, error: "رمز فعلی صحیح نیست." }, 401);
    const hashed = await hashPassword(newPassword);
    const now = Date.now();
    await db.prepare("UPDATE users SET password_salt=?,password_hash=?,failed_attempts=0,locked_until=NULL,updated_at=? WHERE id=?")
      .bind(hashed.salt, hashed.hash, now, user.id).run();
    await db.prepare("DELETE FROM sessions WHERE user_id=? AND id<>?").bind(user.id, user.sessionId).run();
    return json({ success: true, message: "رمز عبور تغییر کرد. نشست فعلی حفظ شد و نشست‌های دیگر بسته شدند." });
  } catch (error) { return json({ success: false, error: error.message }, error.status || 500); }
}
