import { deployWorker } from "../../src/deployer-core.js";
import { acquireCronMonitorLock, releaseCronMonitorLock } from "../_lib/cron-lock.js";
import {
  json, readJson, requireDb, requireUser, getAuthorizedAccount,
  decryptAccountToken, enforceSameOrigin,
} from "../_lib/shared.js";

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

export async function onRequestPost({ request, env }) {
  let heldLock = null;
  let lockDb = null;
  let lockAccountId = null;
  try {
    enforceSameOrigin(request);
    const user = await requireUser(request, env);
    const db = requireDb(env);
    const body = await readJson(request, 48 * 1024);
    const workerName = String(body?.workerName || "").trim();
    if (!/^[a-z0-9_-]{1,63}$/.test(workerName)) {
      return json({
        success: false,
        error: "نام Worker نامعتبر است. فقط حروف کوچک انگلیسی، اعداد، خط تیره (-) و زیرخط (_) مجاز هستند؛ طول نام ۱ تا ۶۳ نویسه است.",
      }, 400);
    }
    const account = await getAuthorizedAccount(db, user, String(body.accountRecordId || ""));
    if (body.recreateWorker === true && user.role !== "admin" && Number(account.can_rebuild) !== 1) {
      return json({ success: false, error: "مدیر اجازه Clean Rebuild را برای این حساب به شما نداده است." }, 403);
    }
    {
      lockDb = db;
      lockAccountId = account.id;
      heldLock = await acquireCronMonitorLock(db, account.id, 30 * 60 * 1000);
      if (!heldLock) {
        return json({ success: false, error: "برای این حساب، استقرار، بررسی سلامت یا بازسازی دیگری در حال اجراست. چند دقیقه بعد دوباره تلاش کنید." }, 409);
      }
    }
    const token = await decryptAccountToken(account, env);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event) => {
          try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); }
          catch { /* Client may have navigated away; do not expose secrets or throw. */ }
        };
        try {
          send({ type: "log", message: "درخواست دریافت شد؛ مجوز حساب و تنظیمات بررسی شد." });
          const result = await deployWorker({
            ...body,
            workerName,
            accountId: account.account_id,
            apiToken: token,
            onStep: async (message) => send({ type: "log", message }),
          });
          send({ type: "result", data: { ...result, accountLabel: account.label } });
        } catch (error) {
          send({
            type: "error",
            error: error?.message || "خطای ناشناخته در فرایند استقرار.",
            status: Number(error?.status) || 500,
          });
        } finally {
          if (heldLock) await releaseCronMonitorLock(lockDb, lockAccountId, heldLock);
          heldLock = null;
          try { controller.close(); } catch {}
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "X-Content-Type-Options": "nosniff",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (heldLock) await releaseCronMonitorLock(lockDb, lockAccountId, heldLock);
    return json({ success: false, error: error.message || "خطای ناشناخته در فرایند استقرار." }, error.status || 500);
  }
}
