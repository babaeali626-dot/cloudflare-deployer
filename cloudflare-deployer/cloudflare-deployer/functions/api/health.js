import { checkWorkerHealth } from "../../src/deployer-core.js";
import { json, readJson, requireDb, requireUser, getAuthorizedAccount, decryptAccountToken, enforceSameOrigin } from "../_lib/shared.js";

export async function onRequestOptions() { return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }); }

export async function onRequestPost({ request, env }) {
  try {
    enforceSameOrigin(request);
    const user = await requireUser(request, env);
    const db = requireDb(env);
    const body = await readJson(request, 12 * 1024);
    const account = await getAuthorizedAccount(db, user, String(body.accountRecordId || ""));
    const token = await decryptAccountToken(account, env);
    const result = await checkWorkerHealth({ ...body, accountId: account.account_id, apiToken: token });
    return json(result);
  } catch (error) {
    return json({ success: false, error: error.message || "خطای ناشناخته در بررسی سلامت Worker." }, error.status || 500);
  }
}
