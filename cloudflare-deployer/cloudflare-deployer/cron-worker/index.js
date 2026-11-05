import { decryptAccountToken } from "../functions/_lib/shared.js";
import { checkWorkerHealth, deployWorker } from "../src/deployer-core.js";
import { acquireCronMonitorLock, releaseCronMonitorLock } from "../functions/_lib/cron-lock.js";

const CRON_LOCK_TTL_MS = 30 * 60 * 1000;
const COOLDOWN_MS = 60 * 60 * 1000;
const MAX_ACCOUNTS_PER_TICK = 50;

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function randomId() {
  return crypto.randomUUID();
}

async function ensureTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS account_deploy_settings (
    account_id TEXT PRIMARY KEY,
    settings_json TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS cron_monitor_locks (
    account_id TEXT PRIMARY KEY,
    lock_until INTEGER NOT NULL,
    lock_token TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
}

async function readSettings(db, accountId) {
  const row = await db.prepare("SELECT settings_json FROM account_deploy_settings WHERE account_id=? LIMIT 1")
    .bind(accountId).first();
  if (!row?.settings_json) return null;
  try { return JSON.parse(row.settings_json); }
  catch { return null; }
}

async function saveSettings(db, accountId, settings, now) {
  await db.prepare(`UPDATE account_deploy_settings
    SET settings_json=?, updated_at=? WHERE account_id=?`)
    .bind(JSON.stringify(settings), now, accountId).run();
}

function isDue(settings, now) {
  const interval = clampInteger(settings.monitorInterval, 10, 5, 1440);
  const last = Math.max(0, Number(settings.lastMonitorCheckAt || settings.lastCronCheckAt) || 0);
  return !last || now - last >= interval * 60 * 1000;
}

function deployPayload(row, settings, apiToken) {
  return {
    accountId: row.account_id,
    apiToken,
    workerName: settings.workerName,
    scriptUrl: settings.scriptUrl,
    enableObfuscation: settings.enableObfuscation === true,
    recreateWorker: true,
    customDomain: settings.customDomain || "",
    panelPath: settings.panelPath || "panel",
    d1Name: settings.enableD1 === false ? null : (settings.d1Name || null),
    bindingName: settings.enableD1 === false ? null : (settings.bindingName || "DB"),
    kvName: settings.enableKV === true ? (settings.kvName || null) : null,
    kvBindingName: settings.enableKV === true ? (settings.kvBindingName || "KV") : null,
    onStep: (message) => console.log(`[${row.label}] ${message}`),
  };
}

async function updateInconclusive(db, row, settings, now, message) {
  settings.lastCronCheckAt = now;
  settings.lastMonitorCheckAt = now;
  settings.lastMonitorSource = "cron";
  settings.lastCronCheckedAt = now;
  settings.lastCronStatus = "inconclusive";
  settings.lastCronMessage = String(message || "بررسی نامشخص بود.").slice(0, 500);
  settings.lastCronFailureType = "api_or_configuration_error";
  await saveSettings(db, row.id, settings, now);
  console.warn(`[Cron] ${row.label}: inconclusive: ${settings.lastCronMessage}`);
}

async function monitorAccount(db, env, row, initialSettings, now) {
  const lockToken = await acquireCronMonitorLock(db, row.id, CRON_LOCK_TTL_MS, now);
  if (!lockToken) {
    console.log(`[Cron] ${row.label}: skipped; another health check or rebuild holds the lock.`);
    return "locked";
  }

  try {
    const settings = await readSettings(db, row.id);
    if (!settings || !settings.lastDeployedAt || settings.healthCheckEnabled === false || !isDue(settings, now)) {
      return "not-due";
    }

    settings.lastCronCheckAt = now;
    settings.lastMonitorCheckAt = now;
    settings.lastMonitorSource = "cron";
    settings.lastCronStartedAt = now;

    let apiToken;
    try {
      apiToken = await decryptAccountToken(row, env);
    } catch (error) {
      await updateInconclusive(db, row, settings, Date.now(), error?.message || "رمزگشایی API Token ناموفق بود.");
      return "inconclusive";
    }

    let health;
    try {
      health = await checkWorkerHealth({
        accountId: row.account_id,
        apiToken,
        workerName: settings.workerName,
        customDomain: settings.customDomain || null,
        probePath: settings.probePath || `/${settings.panelPath || "panel"}`,
      });
    } catch (error) {
      await updateInconclusive(db, row, settings, Date.now(), error?.message || "خطای API در Health Check.");
      return "inconclusive";
    }

    const checkedAt = Date.now();
    settings.lastCronCheckAt = checkedAt;
    settings.lastMonitorCheckAt = checkedAt;
    settings.lastMonitorSource = "cron";
    settings.lastCronCheckedAt = checkedAt;
    settings.lastCronHttpStatus = Number(health.httpStatus) || null;
    settings.lastCronFailureType = health.failureType || null;
    settings.lastCronMessage = String(health.message || "نتیجه Health Check دریافت شد.").slice(0, 500);

    if (health.healthy === true) {
      settings.consecutiveFailures = 0;
      settings.lastCronStatus = "healthy";
      await saveSettings(db, row.id, settings, checkedAt);
      console.log(`[Cron] ${row.label}: healthy (${health.httpStatus || "OK"}).`);
      return "healthy";
    }

    settings.consecutiveFailures = Math.max(0, Number(settings.consecutiveFailures) || 0) + 1;
    settings.lastCronStatus = "unhealthy";
    const threshold = clampInteger(settings.failureThreshold, 3, 2, 10);
    const autoRebuild = settings.autoRebuildMonitor === true;

    if (autoRebuild && settings.consecutiveFailures >= threshold) {
      const creatorIsAdmin = row.creator_role === "admin";
      const hasRebuildPermission = Number(row.has_rebuild_permission) === 1;
      if (!creatorIsAdmin && !hasRebuildPermission) {
        settings.lastCronStatus = "rebuild_blocked_permission";
        settings.lastCronMessage = "Worker خراب تشخیص داده شد، اما هیچ مجوز Clean Rebuild برای این حساب ثبت نشده است.";
      } else {
        const lastRebuildAt = Math.max(0, Number(settings.lastRebuildAt) || 0);
        if (checkedAt - lastRebuildAt < COOLDOWN_MS) {
          settings.lastCronStatus = "cooldown";
          settings.lastCronMessage = "آستانه خرابی رسید، اما محدودیت یک‌ساعته بین بازسازی‌ها فعال است.";
        } else {
          // Record the attempt time before starting, so a failed deployment cannot loop every five minutes.
          settings.lastRebuildAt = checkedAt;
          settings.lastCronRebuildAttemptAt = checkedAt;
          try {
            const deployed = await deployWorker(deployPayload(row, settings, apiToken));
            settings.consecutiveFailures = 0;
            settings.lastDeployedAt = Date.now();
            settings.lastCronStatus = "rebuilt";
            settings.lastCronRebuiltAt = Date.now();
            settings.lastCronMessage = "Clean Rebuild خودکار با موفقیت انجام شد.";
            if (deployed.workerUrl) settings.lastWorkerUrl = deployed.workerUrl;
            if (deployed.panelUrl) settings.lastPanelUrl = deployed.panelUrl;
            if (deployed.customDomainPanelUrl || deployed.customDomainUrl) {
              settings.lastCustomDomainUrl = deployed.customDomainPanelUrl || deployed.customDomainUrl;
            }
            console.log(`[Cron] ${row.label}: automatic Clean Rebuild completed.`);
          } catch (error) {
            settings.lastCronStatus = "rebuild_failed";
            settings.lastCronMessage = `Clean Rebuild ناموفق بود: ${String(error?.message || error).slice(0, 420)}`;
            console.error(`[Cron] ${row.label}: rebuild failed`, error?.message || error);
          }
        }
      }
    }

    await saveSettings(db, row.id, settings, Date.now());
    console.warn(`[Cron] ${row.label}: ${settings.lastCronStatus}; failures=${settings.consecutiveFailures}.`);
    return settings.lastCronStatus;
  } finally {
    await releaseCronMonitorLock(db, row.id, lockToken);
  }
}

export async function runMonitor(env, scheduledTime = Date.now()) {
  const db = env.DB;
  if (!db) throw new Error("D1 binding DB is missing. Bind the existing dashboard D1 database as DB.");
  await ensureTables(db);

  const result = await db.prepare(`SELECT a.*, s.settings_json, u.role AS creator_role,
      EXISTS(SELECT 1 FROM account_permissions p WHERE p.account_id=a.id AND p.can_rebuild=1) AS has_rebuild_permission
    FROM accounts a
    JOIN account_deploy_settings s ON s.account_id=a.id
    LEFT JOIN users u ON u.id=a.created_by
    ORDER BY s.updated_at ASC LIMIT ?`)
    .bind(MAX_ACCOUNTS_PER_TICK).all();

  const now = Date.now();
  let checked = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of result.results || []) {
    let settings;
    try { settings = JSON.parse(row.settings_json || "{}"); }
    catch { skipped++; continue; }
    if (!settings.lastDeployedAt || settings.healthCheckEnabled === false || !isDue(settings, now)) {
      skipped++;
      continue;
    }
    try {
      const status = await monitorAccount(db, env, row, settings, now);
      if (status !== "locked" && status !== "not-due") checked++;
      else skipped++;
    } catch (error) {
      failed++;
      console.error(`[Cron] ${row.label}: monitor error`, error?.message || error);
    }
  }

  console.log(`[Cron] finished at ${new Date(scheduledTime).toISOString()}; checked=${checked}; skipped=${skipped}; errors=${failed}.`);
  return { checked, skipped, failed };
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runMonitor(env, controller.scheduledTime));
  },
  async fetch() {
    return new Response("Cron monitor is scheduled-only.", { status: 404, headers: { "Cache-Control": "no-store" } });
  },
};
