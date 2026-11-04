// Generic, idempotent bootstrap schema for a newly-created Worker D1 database.
// This is deliberately separate from migrations/0001_init.sql, which belongs to
// the private deployer dashboard itself and must never be copied into customer DBs.
export const WORKER_D1_BOOTSTRAP_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS zeus_app_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS zeus_schema_migrations (
    migration_id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `INSERT OR IGNORE INTO zeus_schema_migrations (migration_id)
   VALUES ('0001_zeus_bootstrap')`,
];
