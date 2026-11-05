import {
  json, readJson, requireDb, requireUser, requireAdmin, getAuthorizedAccount,
  decryptAccountToken, enforceSameOrigin, validateAccountId, normalizeCloudflareToken, httpError,
} from "../../_lib/shared.js";

const CF_API = "https://api.cloudflare.com/client/v4";

async function cloudflareGet(path, token, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${CF_API}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      throw httpError("پاسخ Cloudflare در زمان مجاز نرسید؛ دوباره امتحان کنید.", 504);
    }
    throw httpError(`ارتباط با Cloudflare برقرار نشد: ${String(error?.message || error).slice(0, 150)}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

function apiMessage(data, fallback, status = 0) {
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  const messages = errors.map(x => x?.message).filter(Boolean);
  const codes = errors.map(x => x?.code).filter(x => x !== undefined);
  if (status === 403 || codes.includes(100)) {
    return `${fallback}: Cloudflare درخواست را با 403 / code 100 رد کرده است. این معمولاً به معنی محدودیت مجوز یا Scope حساب است، نه اثبات اشتباه بودن خود Token. ${messages.join(" | ")} مسیر دسترسی و مجوزهای Token را بررسی کنید.`;
  }
  if (status === 401 || codes.includes(10000)) {
    return `${fallback}: Cloudflare احراز هویت را نپذیرفت. Token را بدون Global API Key و بدون نقل‌قول وارد کنید و انقضا/فعال بودن آن را بررسی کنید. ${messages.join(" | ")}`;
  }
  return messages.length ? `${fallback}: ${messages.join(" | ")}${codes.length ? ` (کد ${codes.join(", ")})` : ""}` : fallback;
}

async function verifyToken(token, accountId) {
  // Cloudflare's standard self-verification endpoint is user-scoped.
  const userCheck = await cloudflareGet("/user/tokens/verify", token);
  if (userCheck.response.ok && userCheck.data?.success !== false &&
      String(userCheck.data?.result?.status || "").toLowerCase() === "active") {
    return userCheck.data;
  }

  // Compatibility fallback for account-owned API tokens.
  const accountCheck = await cloudflareGet(`/accounts/${accountId}/tokens/verify`, token);
  if (accountCheck.response.ok && accountCheck.data?.success !== false &&
      String(accountCheck.data?.result?.status || "").toLowerCase() === "active") {
    return accountCheck.data;
  }

  const isAuthenticationFailure = (check) => check.response.status === 401 ||
    (Array.isArray(check.data?.errors) && check.data.errors.some(item => Number(item?.code) === 10000));
  const last = isAuthenticationFailure(userCheck) ? userCheck :
    (isAuthenticationFailure(accountCheck) ? accountCheck :
      (accountCheck.response.status >= 400 ? accountCheck : userCheck));
  throw httpError(apiMessage(last.data, "Cloudflare نتوانست Token را تأیید کند", last.response.status),
    last.response.status || 401);
}

async function probe(path, token) {
  const { response, data } = await cloudflareGet(path, token);
  if (!response.ok || data?.success === false) {
    const status = response.status || 502;
    return { ok: false, status, message: apiMessage(data, status === 403 ? "مجوز دسترسی کافی نیست" : "بررسی دسترسی ناموفق بود", status) };
  }
  return { ok: true, status: response.status, message: "دسترسی API قابل مشاهده است" };
}

export async function onRequestPost({ request, env }) {
  try {
    enforceSameOrigin(request);
    const user = await requireUser(request, env);
    const body = await readJson(request, 8 * 1024);
    let accountId;
    let token;

    if (body.accountRecordId) {
      const account = await getAuthorizedAccount(requireDb(env), user, String(body.accountRecordId));
      accountId = account.account_id;
      token = await decryptAccountToken(account, env);
    } else {
      requireAdmin(user);
      accountId = validateAccountId(body.accountId);
      token = normalizeCloudflareToken(body.token);
    }

    const verifyData = await verifyToken(token, accountId);
    const tokenStatus = String(verifyData?.result?.status || "unknown").toLowerCase();
    if (tokenStatus !== "active") throw httpError(`Token فعال نیست؛ وضعیت فعلی: ${tokenStatus}.`, 401);

    const workers = await probe(`/accounts/${accountId}/workers/scripts?page=1&per_page=1`, token);
    const d1 = await probe(`/accounts/${accountId}/d1/database?page=1&per_page=1`, token);

    return json({
      success: true,
      token: { status: tokenStatus, expiresOn: verifyData?.result?.expires_on || null },
      access: {
        workers: { available: workers.ok, status: workers.status, message: workers.message },
        d1: { available: d1.ok, status: d1.status, message: d1.message },
      },
      note: "Verify وضعیت فعال بودن Token را تأیید می‌کند و Probeها دسترسی API به سرویس‌ها را می‌سنجند. Cloudflare در پاسخ Verify سطح دقیق Edit را نمایش نمی‌دهد؛ مجوز نوشتن هنگام Deploy یا اجرای Migration با خود عملیات تأیید می‌شود.",
      tokenMasked: `${token.slice(0, 7)}...****`,
    });
  } catch (error) {
    return json({ success: false, error: error.message || "تست Token ناموفق بود." }, error.status || 500);
  }
}
