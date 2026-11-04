import { json, readJson, requireDb, requireUser, requireAdmin, enforceSameOrigin, encryptAccountToken, validateAccountId, httpError } from "../../_lib/shared.js";

export async function onRequestPatch({ request, env, params }) {
  try {
    enforceSameOrigin(request);
    const db = requireDb(env);
    const user = await requireUser(request, env);
    requireAdmin(user);
    const id = String(params.id || "");
    const body = await readJson(request, 12 * 1024);
    const record = await db.prepare("SELECT id FROM accounts WHERE id=?").bind(id).first();
    if (!record) throw httpError("حساب پیدا نشد.", 404);
    const label = String(body.label || "").trim();
    if (!label || label.length > 60) throw httpError("نام حساب باید بین ۱ تا ۶۰ نویسه باشد.", 400);
    const accountId = validateAccountId(body.accountId);
    if (body.token) {
      const token = String(body.token).trim();
      if (token.length < 20 || token.length > 512) throw httpError("API Token نامعتبر است.", 400);
      const encrypted = await encryptAccountToken(token, env);
      await db.prepare("UPDATE accounts SET label=?,account_id=?,token_cipher=?,token_iv=?,updated_at=? WHERE id=?")
        .bind(label, accountId, encrypted.tokenCipher, encrypted.tokenIv, Date.now(), id).run();
    } else {
      await db.prepare("UPDATE accounts SET label=?,account_id=?,updated_at=? WHERE id=?")
        .bind(label, accountId, Date.now(), id).run();
    }
    return json({ success: true });
  } catch (error) { return json({ success: false, error: error.message }, error.status || 500); }
}

export async function onRequestDelete({ request, env, params }) {
  try {
    enforceSameOrigin(request);
    const db = requireDb(env);
    const user = await requireUser(request, env);
    requireAdmin(user);
    const id = String(params.id || "");
    const record = await db.prepare("SELECT id FROM accounts WHERE id=?").bind(id).first();
    if (!record) throw httpError("حساب پیدا نشد.", 404);
    await db.prepare(`CREATE TABLE IF NOT EXISTS account_deploy_settings (
      account_id TEXT PRIMARY KEY,
      settings_json TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    )`).run();
    await db.prepare("DELETE FROM account_permissions WHERE account_id=?").bind(id).run();
    await db.prepare("DELETE FROM account_deploy_settings WHERE account_id=?").bind(id).run();
    await db.prepare("DELETE FROM accounts WHERE id=?").bind(id).run();
    return json({ success: true });
  } catch (error) { return json({ success: false, error: error.message }, error.status || 500); }
}
