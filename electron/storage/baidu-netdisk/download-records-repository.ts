import type Database from "better-sqlite3";
import { openAutomationDatabase } from "../database";
import {
  readBaiduNetdiskDownloadRecord,
  writeBaiduNetdiskDownloadRecordParams,
} from "./mapper";
import {
  migrateBaiduNetdiskDownloadRecords,
  selectBaiduNetdiskDownloadRecordColumns,
} from "./schema";
import type {
  BaiduNetdiskDownloadRecord,
  BaiduNetdiskDownloadRecordRow,
} from "./types";

export class BaiduNetdiskDownloadRecordsRepository {
  private readonly database: Database.Database;
  readonly databasePath: string;

  constructor() {
    const openedDatabase = openAutomationDatabase();
    this.database = openedDatabase.database;
    this.databasePath = openedDatabase.databasePath;
    migrateBaiduNetdiskDownloadRecords(this.database);
  }

  close(): void {
    this.database.close();
  }

  list(limit = 100): BaiduNetdiskDownloadRecord[] {
    const rows = this.database
      .prepare(
        `
        SELECT ${selectBaiduNetdiskDownloadRecordColumns}
        FROM baidu_netdisk_download_records
        ORDER BY updated_at DESC
        LIMIT @limit
      `,
      )
      .all({ limit }) as BaiduNetdiskDownloadRecordRow[];

    return rows.map(readBaiduNetdiskDownloadRecord);
  }

  findById(id: string): BaiduNetdiskDownloadRecord | null {
    const row = this.database
      .prepare(
        `
        SELECT ${selectBaiduNetdiskDownloadRecordColumns}
        FROM baidu_netdisk_download_records
        WHERE id=@id
      `,
      )
      .get({ id }) as BaiduNetdiskDownloadRecordRow | undefined;

    return row ? readBaiduNetdiskDownloadRecord(row) : null;
  }

  upsert(record: BaiduNetdiskDownloadRecord): BaiduNetdiskDownloadRecord {
    const nextRecord: BaiduNetdiskDownloadRecord = {
      ...record,
      updatedAt: new Date().toISOString(),
    };

    this.database
      .prepare(
        `
        INSERT INTO baidu_netdisk_download_records (
          id,
          share_key,
          share_text,
          resource_name,
          local_episode_video_root,
          episode_count,
          download_dir,
          local_path,
          progress_percent,
          transferred_bytes,
          total_bytes,
          speed_text,
          native_status,
          state,
          skipped_existing,
          error,
          created_at,
          updated_at,
          started_at,
          completed_at,
          remote_transfer_path,
          remote_transfer_fs_id,
          remote_transfer_owned,
          remote_cleanup_pending,
          remote_cleanup_error,
          remote_resource_path,
          remote_resource_fs_id,
          remote_resource_cleanup_completed_at,
          remote_resource_cleanup_error
        ) VALUES (
          @id,
          @shareKey,
          @shareText,
          @resourceName,
          @localEpisodeVideoRoot,
          @episodeCount,
          @downloadDir,
          @localPath,
          @progressPercent,
          @transferredBytes,
          @totalBytes,
          @speedText,
          @nativeStatus,
          @state,
          @skippedExisting,
          @error,
          @createdAt,
          @updatedAt,
          @startedAt,
          @completedAt,
          @remoteTransferPath,
          @remoteTransferFsId,
          @remoteTransferOwned,
          @remoteCleanupPending,
          @remoteCleanupError,
          @remoteResourcePath,
          @remoteResourceFsId,
          @remoteResourceCleanupCompletedAt,
          @remoteResourceCleanupError
        )
        ON CONFLICT(id) DO UPDATE SET
          share_key=excluded.share_key,
          share_text=excluded.share_text,
          resource_name=excluded.resource_name,
          local_episode_video_root=excluded.local_episode_video_root,
          episode_count=excluded.episode_count,
          download_dir=excluded.download_dir,
          local_path=excluded.local_path,
          progress_percent=excluded.progress_percent,
          transferred_bytes=excluded.transferred_bytes,
          total_bytes=excluded.total_bytes,
          speed_text=excluded.speed_text,
          native_status=excluded.native_status,
          state=excluded.state,
          skipped_existing=excluded.skipped_existing,
          error=excluded.error,
          created_at=excluded.created_at,
          updated_at=excluded.updated_at,
          started_at=excluded.started_at,
          completed_at=excluded.completed_at,
          remote_transfer_path=excluded.remote_transfer_path,
          remote_transfer_fs_id=excluded.remote_transfer_fs_id,
          remote_transfer_owned=excluded.remote_transfer_owned,
          remote_cleanup_pending=excluded.remote_cleanup_pending,
          remote_cleanup_error=excluded.remote_cleanup_error,
          remote_resource_path=excluded.remote_resource_path,
          remote_resource_fs_id=excluded.remote_resource_fs_id,
          remote_resource_cleanup_completed_at=excluded.remote_resource_cleanup_completed_at,
          remote_resource_cleanup_error=excluded.remote_resource_cleanup_error
      `,
      )
      .run(writeBaiduNetdiskDownloadRecordParams(nextRecord));

    return nextRecord;
  }

  clear(): void {
    this.database
      .prepare("DELETE FROM baidu_netdisk_download_records WHERE remote_cleanup_pending=0")
      .run();
  }
}
