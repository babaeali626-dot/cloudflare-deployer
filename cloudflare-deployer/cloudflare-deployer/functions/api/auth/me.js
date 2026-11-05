import { json, requireDb, requireUser } from "../../_lib/shared.js";
export async function onRequestGet({ request, env }) {
  try {
    const user = await requireUser(request, env);
    const db = requireDb(env);
    const count = user.role === "admin"
      ? await db.prepare("SELECT COUNT(*) AS total FROM accounts").first()
      : await db.prepare("SELECT COUNT(*) AS total FROM account_permissions WHERE user_id=? AND can_deploy=1").bind(user.id).first();
    return json({ success: true, user: { id: user.id, username: user.username, role: user.role }, accountCount: Number(count?.total || 0) });
  } catch (error) { return json({ success: false, error: error.message }, error.status || 500); }
}
