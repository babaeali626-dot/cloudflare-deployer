-- Optional explicit migration for per-account deployment preferences.
-- The /api/account-settings endpoint also creates this table automatically,
-- so existing installs do not need to run this file manually.
CREATE TABLE IF NOT EXISTS account_deploy_settings (
  account_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
