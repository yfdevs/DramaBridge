import type Database from "better-sqlite3";

export const selectBaiduNetdiskDownloadRecordColumns = `
  id,
  share_key AS shareKey,
  share_text AS shareText,
  resource_name AS resourceName,
  local_episode_video_root AS localEpisodeVideoRoot,
  episode_count AS episodeCount,
  download_dir AS downloadDir,
  local_path AS localPath,
  progress_percent AS progressPercent,
  transferred_bytes AS transferredBytes,
  total_bytes AS totalBytes,
  speed_text AS speedText,
  native_status AS nativeStatus,
  state,
  skipped_existing AS skippedExisting,
  error,
  created_at AS createdAt,
  updated_at AS updatedAt,
  started_at AS startedAt,
  completed_at AS completedAt,
  remote_transfer_path AS remoteTransferPath,
  remote_transfer_fs_id AS remoteTransferFsId,
  remote_transfer_owned AS remoteTransferOwned,
  remote_cleanup_pending AS remoteCleanupPending,
  remote_cleanup_error AS remoteCleanupError,
  remote_resource_path AS remoteResourcePath,
  remote_resource_fs_id AS remoteResourceFsId,
  remote_resource_cleanup_completed_at AS remoteResourceCleanupCompletedAt,
  remote_resource_cleanup_error AS remoteResourceCleanupError
`;

export function migrateBaiduNetdiskDownloadRecords(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS baidu_netdisk_download_records (
      id TEXT PRIMARY KEY,
      share_key TEXT NOT NULL,
      share_text TEXT NOT NULL,
      resource_name TEXT NOT NULL,
      local_episode_video_root TEXT,
      episode_count INTEGER,
      download_dir TEXT NOT NULL,
      local_path TEXT,
      progress_percent REAL,
      transferred_bytes INTEGER,
      total_bytes INTEGER,
      speed_text TEXT,
      native_status TEXT,
      state TEXT NOT NULL,
      skipped_existing INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      remote_transfer_path TEXT,
      remote_transfer_fs_id TEXT,
      remote_transfer_owned INTEGER NOT NULL DEFAULT 0,
      remote_cleanup_pending INTEGER NOT NULL DEFAULT 0,
      remote_cleanup_error TEXT,
      remote_resource_path TEXT,
      remote_resource_fs_id TEXT,
      remote_resource_cleanup_completed_at TEXT,
      remote_resource_cleanup_error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_baidu_download_records_updated_at
      ON baidu_netdisk_download_records(updated_at);

    CREATE INDEX IF NOT EXISTS idx_baidu_download_records_state
      ON baidu_netdisk_download_records(state, updated_at);
  `);

  const columns = new Set(
    (database.prepare("PRAGMA table_info(baidu_netdisk_download_records)").all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  const additions = [
    ["remote_transfer_path", "TEXT"],
    ["remote_transfer_fs_id", "TEXT"],
    ["remote_transfer_owned", "INTEGER NOT NULL DEFAULT 0"],
    ["remote_cleanup_pending", "INTEGER NOT NULL DEFAULT 0"],
    ["remote_cleanup_error", "TEXT"],
    ["remote_resource_path", "TEXT"],
    ["remote_resource_fs_id", "TEXT"],
    ["remote_resource_cleanup_completed_at", "TEXT"],
    ["remote_resource_cleanup_error", "TEXT"],
  ] as const;
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      database.exec(`ALTER TABLE baidu_netdisk_download_records ADD COLUMN ${name} ${definition}`);
    }
  }
}
