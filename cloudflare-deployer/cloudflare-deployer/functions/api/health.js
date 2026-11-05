import { checkWorkerHealth } from "../../src/deployer-core.js";
import { acquireCronMonitorLock, releaseCronMonitorLock } from "../_lib/cron-lock.js";
import { json, readJson, requireDb, requireUser, getAuthorizedAccount, decryptAccountToken, enforceSameOrigin } from "../_lib/shared.js";

export async function onRequestOptions() { return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }); }

export async function onRequestPost({ request, env }) {
  let heldLock = null;
  let lockDb = null;
  let lockAccountId = null;
  try {
    enforceSameOrigin(request);
    const user = await requireUser(request, env);
    const db = requireDb(env);
    const body = await readJson(request, 12 * 1024);
    const account = await getAuthorizedAccount(db, user, String(body.accountRecordId || ""));
    lockDb = db;
    lockAccountId = account.id;
    heldLock = await acquireCronMonitorLock(db, account.id, 5 * 60 * 1000);
    if (!heldLock) {
      return json({ success: false, error: "برای این حساب، پایش یا بازسازی دیگری در حال اجراست. کمی بعد دوباره تلاش کنید." }, 409);
    }
    const token = await decryptAccountToken(account, env);
    const result = await checkWorkerHealth({ ...body, accountId: account.account_id, apiToken: token });
    return json(result);
  } catch (error) {
    return json({ success: false, error: error.message || "خطای ناشناخته در بررسی سلامت Worker." }, error.status || 500);
  } finally {
    if (heldLock) await releaseCronMonitorLock(lockDb, lockAccountId, heldLock);
  }
}
