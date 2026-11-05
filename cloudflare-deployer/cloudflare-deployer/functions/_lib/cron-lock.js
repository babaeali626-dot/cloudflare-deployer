export async function ensureCronMonitorLockTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS cron_monitor_locks (
    account_id TEXT PRIMARY KEY,
    lock_until INTEGER NOT NULL,
    lock_token TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
}

export async function acquireCronMonitorLock(db, accountId, ttlMs = 5 * 60 * 1000, now = Date.now()) {
  await ensureCronMonitorLockTable(db);
  const token = crypto.randomUUID();
  const result = await db.prepare(`INSERT INTO cron_monitor_locks (account_id,lock_until,lock_token,updated_at)
    VALUES (?,?,?,?)
    ON CONFLICT(account_id) DO UPDATE SET
      lock_until=excluded.lock_until,
      lock_token=excluded.lock_token,
      updated_at=excluded.updated_at
    WHERE cron_monitor_locks.lock_until < ?`)
    .bind(accountId, now + ttlMs, token, now, now).run();
  return Number(result?.meta?.changes || 0) > 0 ? token : null;
}

export async function releaseCronMonitorLock(db, accountId, token) {
  if (!token) return;
  try {
    await db.prepare("DELETE FROM cron_monitor_locks WHERE account_id=? AND lock_token=?")
      .bind(accountId, token).run();
  } catch (error) {
    console.error("Could not release Cron monitor lock", accountId, error?.message || error);
  }
}
