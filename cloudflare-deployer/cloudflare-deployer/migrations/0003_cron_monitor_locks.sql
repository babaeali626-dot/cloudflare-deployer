-- Shared lock prevents Cron and dashboard Clean Rebuild/Health Check from
-- running destructive or duplicate operations for the same account at once.
CREATE TABLE IF NOT EXISTS cron_monitor_locks (
  account_id TEXT PRIMARY KEY,
  lock_until INTEGER NOT NULL,
  lock_token TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
