import type Database from "better-sqlite3";

function ensureColumn(database: Database.Database, name: string, definition: string): void {
  const columns = database.prepare("PRAGMA table_info(pinduoduo_approved_upload_records)").all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === name)) {
    database.exec(`ALTER TABLE pinduoduo_approved_upload_records ADD COLUMN ${definition}`);
  }
}

export function migratePinduoduoUploadRecords(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS pinduoduo_approved_upload_records (
      platform_apply_id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      episode_count INTEGER,
      gmt_create INTEGER,
      demo_url TEXT,
      status TEXT NOT NULL,
      stage TEXT,
      error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      raw_json TEXT,
      resource_source TEXT,
      resource_source_rows TEXT,
      account_profile_name TEXT,
      uploaded_batch_count INTEGER NOT NULL DEFAULT 0,
      total_batch_count INTEGER,
      uploaded_at TEXT,
      last_attempt_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pinduoduo_approved_upload_records_status_updated
      ON pinduoduo_approved_upload_records(status, updated_at);
  `);
  ensureColumn(database, "resource_source", "resource_source TEXT");
  ensureColumn(database, "gmt_create", "gmt_create INTEGER");
  ensureColumn(database, "resource_source_rows", "resource_source_rows TEXT");
  ensureColumn(database, "uploaded_batch_count", "uploaded_batch_count INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "total_batch_count", "total_batch_count INTEGER");
}
