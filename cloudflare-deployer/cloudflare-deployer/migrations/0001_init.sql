CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  active INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  account_id TEXT NOT NULL,
  token_cipher TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_account_id ON accounts(account_id);

CREATE TABLE IF NOT EXISTS account_permissions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  can_deploy INTEGER NOT NULL DEFAULT 1,
  can_rebuild INTEGER NOT NULL DEFAULT 0,
  granted_by TEXT NOT NULL REFERENCES users(id),
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_account_permissions_account ON account_permissions(account_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip_hash TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  updated_at INTEGER NOT NULL
);
