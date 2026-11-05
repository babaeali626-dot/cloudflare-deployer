import {
  json, readJson, requireDb, requireUser, getAuthorizedAccount,
  enforceSameOrigin, httpError,
} from "../_lib/shared.js";

const DEFAULT_SOURCE = "https://raw.githubusercontent.com/babaeali626-dot/clean-ips/refs/heads/main/worker%2Cjs";

async function ensureSettingsTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS account_deploy_settings (
    account_id TEXT PRIMARY KEY,
    settings_json TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  )`).run();
}

function randomHex(bytes = 5) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return [...value].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function defaultSettings() {
  const suffix = randomHex(5);
  return {
    workerName: `zeus-${suffix}`,
    d1Name: `zeus-db-${suffix}`,
    kvName: `zeus-kv-${suffix}`,
    enableD1: true,
    enableKV: false,
    bindingName: "DB",
    kvBindingName: "KV",
    scriptUrl: DEFAULT_SOURCE,
    customDomain: "",
    panelPath: "panel",
    enableObfuscation: false,
    recreateWorker: false,
    healthCheckEnabled: true,
    autoRebuildMonitor: true,
    monitorInterval: 10,
    failureThreshold: 1,
    rebuildPolicyVersion: 1,
    probePath: "/panel",
    consecutiveFailures: 0,
    lastRebuildAt: 0,
    lastDeployedAt: null,
    lastWorkerUrl: null,
    lastPanelUrl: null,
    lastCustomDomainUrl: null,
  };
}

function normalizePanelPath(value) {
  let path = String(value || "panel").trim().replace(/^\/+|\/+$/g, "");
  if (!path) path = "panel";
  if (path.length > 180 || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(path)) {
    throw httpError("مسیر پنل نامعتبر است؛ فقط حروف انگلیسی، عدد، خط تیره و زیرخط و / مجاز هستند.", 400);
  }
  if (!/(^|\/)panel$/i.test(path)) path += "/panel";
  return path;
}

function validateSettings(input, previous = {}) {
  const value = { ...previous };
  const workerName = String(input.workerName ?? value.workerName ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,63}$/.test(workerName)) throw httpError("نام Worker معتبر نیست؛ فقط حروف کوچک انگلیسی، عدد، - و _ مجاز است.", 400);
  value.workerName = workerName;

  const validateResourceName = (raw, label) => {
    const name = String(raw ?? "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) throw httpError(`${label} معتبر نیست.`, 400);
    return name;
  };
  value.d1Name = validateResourceName(input.d1Name ?? value.d1Name, "نام D1");
  value.kvName = validateResourceName(input.kvName ?? value.kvName, "نام KV");

  const validateBinding = (raw, fallback, label) => {
    const name = String(raw ?? fallback).trim();
    if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/.test(name)) throw httpError(`${label} معتبر نیست.`, 400);
    return name;
  };
  value.bindingName = validateBinding(input.bindingName, value.bindingName || "DB", "Binding دیتابیس");
  value.kvBindingName = validateBinding(input.kvBindingName, value.kvBindingName || "KV", "Binding مربوط به KV");

  const scriptUrl = String(input.scriptUrl ?? value.scriptUrl ?? DEFAULT_SOURCE).trim();
  let parsed;
  try { parsed = new URL(scriptUrl); } catch { throw httpError("آدرس سورس معتبر نیست.", 400); }
  if (parsed.protocol !== "https:" || !["raw.githubusercontent.com", "gist.githubusercontent.com", "raw.github.com"].includes(parsed.hostname.toLowerCase())) {
    throw httpError("سورس باید از HTTPS و میزبان معتبر GitHub Raw باشد.", 400);
  }
  value.scriptUrl = scriptUrl;

  const customDomain = String(input.customDomain ?? value.customDomain ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/$/, "").toLowerCase();
  if (customDomain && (/[/?#@:]/.test(customDomain) || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(customDomain))) {
    throw httpError("دامنه اختصاصی معتبر نیست.", 400);
  }
  value.customDomain = customDomain;
  value.panelPath = normalizePanelPath(input.panelPath ?? value.panelPath ?? "panel");

  for (const key of ["enableD1", "enableKV", "enableObfuscation", "recreateWorker", "healthCheckEnabled", "autoRebuildMonitor"]) {
    if (input[key] !== undefined) value[key] = input[key] === true;
  }
  const interval = Number(input.monitorInterval ?? value.monitorInterval ?? 10);
  if (!Number.isInteger(interval) || interval < 5 || interval > 1440) throw httpError("فاصله پایش باید بین ۵ تا ۱۴۴۰ دقیقه باشد.", 400);
  value.monitorInterval = interval;
  // Automatic recovery is intentionally triggered by the first real unhealthy result.
  // Ignore legacy per-account values (for example 3) so existing D1 rows adopt this behavior.
  value.failureThreshold = 1;
  if (Number(value.rebuildPolicyVersion) !== 1) {
    value.rebuildPolicyVersion = 1;
    value.lastRebuildAt = 0;
  }
  const probePath = String(input.probePath ?? value.probePath ?? `/${value.panelPath}`).trim();
  if (!probePath.startsWith("/") || probePath.length > 220 || /[\r\n?#]/.test(probePath)) throw httpError("مسیر بررسی سلامت معتبر نیست.", 400);
  value.probePath = probePath;
  if (input.consecutiveFailures !== undefined) value.consecutiveFailures = Math.max(0, Math.min(10, Number(input.consecutiveFailures) || 0));
  if (input.lastRebuildAt !== undefined) value.lastRebuildAt = Math.max(0, Number(input.lastRebuildAt) || 0);
  if (input.lastMonitorCheckAt !== undefined) value.lastMonitorCheckAt = Math.max(0, Number(input.lastMonitorCheckAt) || 0);
  if (input.lastMonitorSource === "browser" || input.lastMonitorSource === "cron") value.lastMonitorSource = input.lastMonitorSource;
  return value;
}

async function getOrCreateSettings(db, accountId, userId) {
  let row = await db.prepare("SELECT settings_json FROM account_deploy_settings WHERE account_id=?").bind(accountId).first();
  if (!row) {
    const initial = defaultSettings();
    const now = Date.now();
    await db.prepare("INSERT OR IGNORE INTO account_deploy_settings (account_id,settings_json,updated_by,updated_at) VALUES (?,?,?,?)")
      .bind(accountId, JSON.stringify(initial), userId, now).run();
    row = await db.prepare("SELECT settings_json FROM account_deploy_settings WHERE account_id=?").bind(accountId).first();
  }
  try { return JSON.parse(row?.settings_json || "{}"); }
  catch { throw httpError("تنظیمات ذخیره‌شده این حساب قابل خواندن نیستند.", 500); }
}

export async function onRequestGet({ request, env }) {
  try {
    const db = requireDb(env);
    const user = await requireUser(request, env);
    const accountId = new URL(request.url).searchParams.get("accountRecordId") || "";
    await getAuthorizedAccount(db, user, accountId);
    await ensureSettingsTable(db);
    const settings = await getOrCreateSettings(db, accountId, user.id);
    return json({ success: true, settings });
  } catch (error) {
    return json({ success: false, error: error.message || "دریافت تنظیمات حساب ناموفق بود." }, error.status || 500);
  }
}

export async function onRequestPut({ request, env }) {
  try {
    enforceSameOrigin(request);
    const db = requireDb(env);
    const user = await requireUser(request, env);
    const body = await readJson(request, 16 * 1024);
    const accountId = String(body.accountRecordId || "");
    await getAuthorizedAccount(db, user, accountId);
    await ensureSettingsTable(db);
    const previous = await getOrCreateSettings(db, accountId, user.id);
    const next = validateSettings(body.settings || {}, previous);
    if (next.workerName !== previous.workerName && body.markDeployed !== true) {
      next.lastDeployedAt = null;
      next.lastWorkerUrl = null;
      next.lastPanelUrl = null;
      next.lastCustomDomainUrl = null;
      next.consecutiveFailures = 0;
      next.lastRebuildAt = 0;
      next.lastMonitorCheckAt = 0;
      next.lastCronCheckAt = 0;
      next.lastCronStatus = null;
      next.lastCronMessage = null;
    }

    if (body.markDeployed === true) {
      next.lastDeployedAt = Date.now();
      next.consecutiveFailures = 0;
      next.lastRebuildAt = body.preserveRebuildCooldown === true ? Math.max(0, Number(next.lastRebuildAt) || 0) : 0;
      next.lastMonitorCheckAt = 0;
      next.lastCronCheckAt = 0;
      next.lastCronStatus = null;
      next.lastCronMessage = null;
      next.lastWorkerUrl = typeof body.lastWorkerUrl === "string" ? body.lastWorkerUrl.slice(0, 500) : null;
      next.lastPanelUrl = typeof body.lastPanelUrl === "string" ? body.lastPanelUrl.slice(0, 700) : null;
      next.lastCustomDomainUrl = typeof body.lastCustomDomainUrl === "string" ? body.lastCustomDomainUrl.slice(0, 700) : null;
    }
    if (body.clearDeployment === true) {
      next.lastDeployedAt = null;
      next.lastWorkerUrl = null;
      next.lastPanelUrl = null;
      next.lastCustomDomainUrl = null;
    }

    const now = Date.now();
    await db.prepare(`INSERT INTO account_deploy_settings (account_id,settings_json,updated_by,updated_at)
      VALUES (?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET
      settings_json=excluded.settings_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .bind(accountId, JSON.stringify(next), user.id, now).run();
    return json({ success: true, settings: next, updatedAt: now });
  } catch (error) {
    return json({ success: false, error: error.message || "ذخیره تنظیمات حساب ناموفق بود." }, error.status || 500);
  }
}
