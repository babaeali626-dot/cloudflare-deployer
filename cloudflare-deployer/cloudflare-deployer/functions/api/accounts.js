import { json, readJson, requireDb, requireUser, requireAdmin, enforceSameOrigin, encryptAccountToken, validateAccountId, httpError } from "../_lib/shared.js";

export async function onRequestGet({ request, env }) {
  try {
    const db = requireDb(env);
    const user = await requireUser(request, env);
    let result;
    if (user.role === "admin") {
      result = await db.prepare("SELECT id,label,account_id,created_at,updated_at FROM accounts ORDER BY label COLLATE NOCASE").all();
    } else {
      result = await db.prepare(
        `SELECT a.id,a.label,a.account_id,a.created_at,a.updated_at
         FROM accounts a JOIN account_permissions p ON p.account_id=a.id
         WHERE p.user_id=? AND p.can_deploy=1 ORDER BY a.label COLLATE NOCASE`
      ).bind(user.id).all();
    }
    const safeAccounts = (result.results || []).map(row => ({
      ...row,
      // The clear Token is never returned by any account-list endpoint.
      tokenMasked: "cf_tok_••••••••****",
      hasToken: true,
    }));
    return json({ success: true, accounts: safeAccounts });
  } catch (error) { return json({ success: false, error: error.message }, error.status || 500); }
}

export async function onRequestPost({ request, env }) {
  try {
    enforceSameOrigin(request);
    const db = requireDb(env);
    const user = await requireUser(request, env);
    requireAdmin(user);
    const body = await readJson(request, 12 * 1024);
    const label = String(body.label || "").trim();
    const accountId = validateAccountId(body.accountId);
    const token = String(body.token || "").trim();
    if (!label || label.length > 60) throw httpError("نام حساب باید بین ۱ تا ۶۰ نویسه باشد.", 400);
    if (token.length < 20 || token.length > 512) throw httpError("API Token خالی یا نامعتبر است.", 400);
    const currentCount = await db.prepare("SELECT COUNT(*) AS total FROM accounts").first();
    if (Number(currentCount?.total || 0) >= 10) throw httpError("حداکثر ۱۰ حساب Cloudflare قابل ذخیره است. ابتدا یک حساب را حذف کنید.", 409);
    const encrypted = await encryptAccountToken(token, env);
    const id = crypto.randomUUID();
    const now = Date.now();
    await db.prepare(
      "INSERT INTO accounts (id,label,account_id,token_cipher,token_iv,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)"
    ).bind(id, label, accountId, encrypted.tokenCipher, encrypted.tokenIv, user.id, now, now).run();
    return json({ success: true, account: { id, label, account_id: accountId } }, 201);
  } catch (error) { return json({ success: false, error: error.message }, error.status || 500); }
}
